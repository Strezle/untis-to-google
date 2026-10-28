process.env.TZ = "Europe/Berlin";

// ====== KONFIGURATION ======
const DAYS_AHEAD = 14;
const HOMEWORK_LOOKBACK_DAYS = 14;
const TZ = "Europe/Berlin";
const MAX_TRIES = 4; // Verbindungsversuche pro Anfrage

// Symbole am Titelanfang (reine Unicode-Zeichen, keine Emojis)
const SYM_EXAM = "◆";     // Arbeit / Prüfung
const SYM_HOMEWORK = "✎"; // Hausaufgaben
const SYM_NOTE = "☰";     // Notizen

// Google-Kalender-Farben: 11 = Tomate (rot), 10 = Basilikum (grün), 5 = Banane (gelb)
const COLOR_RED = "11";
const COLOR_GREEN = "10";
const COLOR_YELLOW = "5";

const cfg = {
  server: process.env.UNTIS_SERVER,
  school: process.env.UNTIS_SCHOOL,
  user: process.env.UNTIS_USER,
  password: process.env.UNTIS_PASSWORD,
  url: process.env.APPS_SCRIPT_URL,
  token: process.env.SYNC_TOKEN
};

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Datums-Helfer (immer Berlin-Zeit) ----------
const ymdDash = (d) => new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
}).format(d);
const ymdNum = (d) => Number(ymdDash(d).replace(/-/g, ""));

function berlinLocal(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(iso));
  const g = (t) => parts.find(p => p.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}

// ---------- Netzwerk ----------
async function httpFetch(url, options = {}) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      const code = (e.cause && e.cause.code) || e.name || "Fehler";
      log(`Verbindungsfehler (Versuch ${attempt}/${MAX_TRIES}): ${code}`);
      if (attempt < MAX_TRIES) await sleep(attempt * 5000);
    }
  }
  return null;
}

const rpcUrl = () => `https://${cfg.server}/WebUntis/jsonrpc.do?school=${encodeURIComponent(cfg.school)}`;

async function rpc(method, params, sessionId) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers.Cookie = `JSESSIONID=${sessionId}`;
  const res = await httpFetch(rpcUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "gcal", method, params: params || {}, jsonrpc: "2.0" })
  });
  if (!res) return null;
  try {
    const json = JSON.parse(await res.text());
    if (json.error) {
      log(`API-Fehler bei ${method}: ${json.error.code} ${json.error.message}`);
      return null;
    }
    return json.result;
  } catch (e) {
    log(`Antwortfehler bei ${method}: ${e.message}`);
    return null;
  }
}

// ---------- Hauptprogramm ----------
async function main() {
    for (const k of ["server", "school", "user", "password", "url", "token"]) {
    if (!cfg[k]) {
      log(`Fehler: Secret für "${k}" fehlt.`);
      process.exit(1);
    }
  }
  // 1. Zeitraum
  const rangeStart = new Date();
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeEnd.getDate() + DAYS_AHEAD);
  rangeEnd.setHours(23, 59, 59, 999);
  const startNum = ymdNum(rangeStart);
  const endNum = ymdNum(rangeEnd);

  // 2. Login
  const login = await rpc("authenticate", { user: cfg.user, password: cfg.password, client: "GCalSync" });
  if (!login || !login.sessionId) {
    log("Login fehlgeschlagen. Kalender bleibt unverändert, nächster Lauf versucht es erneut.");
    return;
  }
  const sessionId = login.sessionId;

  try {
    // 3. Eigener Stundenplan (Kurs-Filter Reli/Ethik)
    const own = (await rpc("getTimetable",
      timetableParams(login.personId, login.personType, startNum, endNum), sessionId)) || [];
    const ownIds = {};
    own.forEach(l => { if (l.id) ownIds[l.id] = true; });

    // 4. Klassenstundenplan
    let timetable = [];
    if (login.klasseId) {
      timetable = (await rpc("getTimetable",
        timetableParams(login.klasseId, 1, startNum, endNum), sessionId)) || [];
    }
    if (timetable.length === 0) timetable = own;
    if (timetable.length === 0) {
      log("Keine Stundenplan-Einträge gefunden. Kalender bleibt unverändert.");
      return;
    }

    timetable.sort((a, b) => (a.date - b.date) || (a.startTime - b.startTime));

    const filterActive = Object.keys(ownIds).length > 0;
    if (!filterActive) log("Warnung: Eigener Stundenplan leer, Kurs-Filter inaktiv.");

    // 5. Namen als Fallback
    const names = { su: {}, ro: {}, te: {} };
    for (const [key, method] of [["su", "getSubjects"], ["ro", "getRooms"]]) {
      ((await rpc(method, {}, sessionId)) || []).forEach(e => { if (e.name) names[key][e.id] = e.name; });
    }
    await fillNamesFromHtml(sessionId, names);

    // 6. Hausaufgaben + Stundendetails (Best Effort)
    const hwStart = new Date(rangeStart);
    hwStart.setDate(hwStart.getDate() - HOMEWORK_LOOKBACK_DAYS);
    const homework = await fetchHomework(sessionId, ymdNum(hwStart), endNum);
    const details = await fetchLessonDetails(sessionId, login.personId, rangeStart, rangeEnd);

    // 7. Soll-Events bauen
    const desired = {};
    const sep = " ➔ ";
    const usedHomework = {};
    let hwAttached = 0, detailsAttached = 0;

    timetable.forEach(lesson => {
      if (filterActive && !ownIds[lesson.id]) return;

      const ds = lesson.date.toString();
      const st = lesson.startTime.toString().padStart(4, "0");
      const en = lesson.endTime.toString().padStart(4, "0");
      const day = `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
      const start = `${day}T${st.slice(0, 2)}:${st.slice(2, 4)}:00`;
      const end = `${day}T${en.slice(0, 2)}:${en.slice(2, 4)}:00`;

      const su = resolveElements(lesson.su, names.su);
      const ro = resolveElements(lesson.ro, names.ro);
      const te = resolveElements(lesson.te, names.te);

      let title = su.now.join(", ") || "Unterricht";
      let location = ro.now.join(", ");
      if (ro.old.length && ro.old.join(", ") !== location) {
        location = `${ro.old.join(", ")}${sep}${boldUnicode(location || "keine Angabe")}`;
      }

      let desc = "";
      const teacher = te.now.join(", ") || "Keine Angabe";
      if (te.old.length && te.old.join(", ") !== te.now.join(", ")) {
        desc += `Lehrer: ${te.old.join(", ")}${sep}${boldUnicode(teacher)}\n`;
      } else {
        desc += `Lehrer: ${teacher}\n`;
      }

      // Status (Titel bleibt sauber, der Status zeigt sich über die Farbe)
      const isCancelled = lesson.code === "cancelled";
      const isExam = lesson.activityType === "EXAM" || lesson.type === "ex";
      const isChanged = lesson.code === "irregular" || !!lesson.substText ||
        su.old.length > 0 || ro.old.length > 0 || te.old.length > 0;

      // Farbe (Priorität: Ausfall > Prüfung > Änderung)
      let color = "";
      if (isCancelled) color = COLOR_RED;
      else if (isExam) color = COLOR_YELLOW;
      else if (isChanged) color = COLOR_GREEN;

      if (lesson.substText) desc += `Vertretung: ${lesson.substText}\n`;

      const subjectName = su.now[0] || "";

      // Notiztexte sammeln (Hinweis, Info, Stundendetails), ohne Duplikate
      const detail = details[`${lesson.date}_${st}_${subjectName}`] || [];
      const noteTexts = [];
      [lesson.lstext, lesson.info].concat(detail).forEach(t => {
        const s = t ? String(t).trim() : "";
        if (s && s !== lesson.substText && noteTexts.indexOf(s) === -1) noteTexts.push(s);
      });
      if (noteTexts.length) detailsAttached++;

      if (isExam) {
        desc += `Arbeit: ${noteTexts.length ? noteTexts.join(" | ") : "geplant"}\n`;
      } else if (noteTexts.length) {
        desc += noteTexts.map(t => `Notiz: ${t}`).join("\n") + "\n";
      }

      // Hausaufgaben: an der ersten Stunde des Fachs am Fälligkeitstag
      let hasHomework = false;
      const hwKey = `${lesson.date}_${subjectName}`;
      if (homework[hwKey] && !usedHomework[hwKey]) {
        usedHomework[hwKey] = true;
        hasHomework = true;
        desc += `\nHausaufgaben:\n${homework[hwKey].join("\n")}\n`;
        hwAttached += homework[hwKey].length;
      }

      // Symbole am Titelanfang
      let prefix = "";
      if (isExam) prefix += SYM_EXAM;
      if (hasHomework) prefix += SYM_HOMEWORK;
      if (!isExam && noteTexts.length) prefix += SYM_NOTE;
      if (prefix) title = `${prefix} ${title}`;

      desc = desc.trim();
      const key = [title, start, end, location, desc, color].join("|");
      desired[key] = { title, start, end, location, desc, color };
    });

    // 8. An Apps Script schicken
    const res = await httpFetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ token: cfg.token, events: Object.values(desired) })
    });
    const answer = res ? (await res.text()).slice(0, 200) : "keine Verbindung";
    log(`Gesendet: ${Object.keys(desired).length} Stunden. Antwort: ${answer}`);
      `${hwAttached} Hausaufgaben und ${detailsAttached} Notizen zugeordnet.`);
  } finally {
    await rpc("logout", {}, sessionId);
  }
}

// ---------- Hilfsfunktionen ----------

function timetableParams(id, type, startNum, endNum) {
  return {
    options: {
      element: { id, type },
      startDate: startNum,
      endDate: endNum,
      showSubstText: true,
      showInfo: true,
      showLsText: true,
      klasseFields: ["id", "name"],
      roomFields: ["id", "name"],
      subjectFields: ["id", "name"],
      teacherFields: ["id", "name", "longname"]
    }
  };
}

function resolveElements(arr, map) {
  const now = [], old = [];
  (arr || []).forEach(e => {
    if (e.id && e.id !== 0) now.push(e.name || map[e.id] || "?");
    if (e.orgid && e.orgid !== e.id) {
      const oldName = e.orgname || map[e.orgid];
      if (oldName) old.push(oldName);
    }
  });
  return { now, old };
}

async function fillNamesFromHtml(sessionId, names) {
  const missing = ["su", "ro"].some(k => Object.keys(names[k]).length === 0);
  if (!missing) return;
  try {
    const res = await httpFetch(`https://${cfg.server}/WebUntis/index.do`, {
      headers: { Cookie: `JSESSIONID=${sessionId}` }
    });
    if (!res) return;
    const html = await res.text();

    [[3, "su"], [4, "ro"], [2, "te"]].forEach(([typeNum, key]) => {
      if (Object.keys(names[key]).length > 0) return;
      const regex = new RegExp(`\\{.*?id\\s*:\\s*(\\d+).*?name\\s*:\\s*["'](.*?)["'].*?type\\s*:\\s*${typeNum}.*?\\}`, "g");
      let m;
      while ((m = regex.exec(html)) !== null) names[key][m[1]] = m[2];
    });

    const m = /"elements"\s*:\s*(\[.*?\])/.exec(html);
    if (m) {
      JSON.parse(m[1]).forEach(el => {
        const n = el.name || el.displayName;
        const key = { 3: "su", 4: "ro", 2: "te" }[el.type];
        if (key && n && !names[key][el.id]) names[key][el.id] = n;
      });
    }
  } catch (e) {
    log("HTML-Fallback fehlgeschlagen: " + e.message);
  }
}

const schoolCookie = () => '"_' + Buffer.from(cfg.school).toString("base64") + '"';

async function fetchHomework(sessionId, startNum, endNum) {
  const result = {};
  try {
    const url = `https://${cfg.server}/WebUntis/api/homeworks/lessons?startDate=${startNum}&endDate=${endNum}`;
    const res = await httpFetch(url, {
      headers: { Cookie: `JSESSIONID=${sessionId}; schoolname=${schoolCookie()}` }
    });
    if (!res || res.status !== 200) {
      log("Hausaufgaben nicht abrufbar" + (res ? ` (HTTP ${res.status})` : "") + ".");
      return result;
    }
    const data = (JSON.parse(await res.text()).data) || {};
    const homeworks = data.homeworks || [];

    const subjectByLesson = {};
    (data.lessons || []).forEach(l => {
      let s = l.subject;
      if (s && typeof s === "object") s = s.name || s.shortName || s.longName;
      if (l.id && s) subjectByLesson[l.id] = String(s);
    });

    let matched = 0;
    homeworks.forEach(hw => {
      const subject = subjectByLesson[hw.lessonId];
      if (!subject || !hw.dueDate) return;
      const key = `${hw.dueDate}_${subject}`;
      const given = hw.date ? String(hw.date) : "";
      const givenTxt = given ? ` (aufgegeben ${given.slice(6, 8)}.${given.slice(4, 6)}.)` : "";
      const text = [hw.text, hw.remark].filter(Boolean).join(" – ");
      (result[key] = result[key] || []).push(`• ${text || "(kein Text)"}${givenTxt}`);
      matched++;
    });
    log(`Hausaufgaben: ${homeworks.length} geladen, ${matched} mit Fach und Fälligkeitsdatum.`);
  } catch (e) {
    log("Hausaufgaben-Fehler: " + e.message);
  }
  return result;
}

async function fetchLessonDetails(sessionId, personId, rangeStart, rangeEnd) {
  const result = {};
  try {
    const base = `https://${cfg.server}/WebUntis`;
    const cookie = `JSESSIONID=${sessionId}; schoolname=${schoolCookie()}`;

    const tr = await httpFetch(`${base}/api/token/new`, { headers: { Cookie: cookie } });
    if (!tr || tr.status !== 200) {
      log("Token nicht abrufbar, Notizen werden übersprungen.");
      return result;
    }
    const token = (await tr.text()).trim();

    const url = `${base}/api/rest/view/v1/timetable/entries?start=${ymdDash(rangeStart)}&end=${ymdDash(rangeEnd)}` +
      `&format=1&resourceType=STUDENT&resources=${personId}`;
    const res = await httpFetch(url, { headers: { Cookie: cookie, Authorization: "Bearer " + token } });
    if (!res || res.status !== 200) {
      log("Stundendetails nicht abrufbar" + (res ? ` (HTTP ${res.status})` : "") + ".");
      return result;
    }

    const json = JSON.parse(await res.text());
    (json.days || []).forEach(day => {
      (day.gridEntries || []).forEach(entry => {
        if (!entry.duration || !entry.duration.start) return;
        const dateKey = entry.duration.start.slice(0, 10).replace(/-/g, "");
        const timeKey = entry.duration.start.slice(11, 16).replace(":", "");

        let subject = "";
        for (let i = 1; i <= 7; i++) {
          (entry["position" + i] || []).forEach(p => {
            if (p && p.current && p.current.type === "SUBJECT") subject = p.current.shortName || subject;
          });
        }

        const texts = [];
        [entry.notesAll, entry.lessonText, entry.substitutionText, entry.lessonInfo].forEach(t => {
          if (t && String(t).trim() && texts.indexOf(String(t).trim()) === -1) texts.push(String(t).trim());
        });
        if (texts.length) result[`${dateKey}_${timeKey}_${subject}`] = texts;
      });
    });
  } catch (e) {
    log("Stundendetails-Fehler: " + e.message);
  }
  return result;
}

function boldUnicode(text) {
  return Array.from(String(text || "")).map(c => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1D5EE + (code - 97));
    if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
    return c;
  }).join("");
}

main().catch(e => {
  log("Unerwarteter Fehler: " + e.message);
  process.exit(1);
});
