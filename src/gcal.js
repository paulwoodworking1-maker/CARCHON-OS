'use strict';
// Google Agenda, dans les deux sens, sans compte développeur Google :
//  · Google → Carchon OS : on lit l'« adresse secrète au format iCal » de l'agenda toutes les 10 minutes
//    et ses rendez-vous s'affichent dans le planning (ligne « Google Agenda »).
//  · Carchon OS → Google : un flux iCal privé (barres du planning, poses, livraisons fournisseur)
//    auquel Google Agenda s'abonne (« Ajouter un agenda › À partir de l'URL »).
const crypto = require('node:crypto');
const { db, q, setting, setSetting } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS gcal_events (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  time TEXT DEFAULT '', title TEXT NOT NULL, location TEXT DEFAULT ''
)`);

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return isoOf(d); };

// ---------- Lecture d'un fichier iCal ----------
function unfold(text) { return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); }
function unescape(v) { return String(v || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim(); }
function prop(line) {
  const i = line.indexOf(':'); if (i < 0) return null;
  const [name, ...params] = line.slice(0, i).split(';');
  return { name: name.toUpperCase(), params: Object.fromEntries(params.map((p) => p.split('=')).map(([k, v]) => [k.toUpperCase(), v])), value: line.slice(i + 1) };
}
// Valeur de date iCal → { date: 'AAAA-MM-JJ', time: 'HH:MM' | '' } en heure locale (Europe/Paris sur le serveur).
function parseDT(p) {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: '' };
  const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return { date: isoOf(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// Dates de début d'un événement répété, entre from et to (règles courantes de Google Agenda).
function expand(start, rule, from, to) {
  const r = Object.fromEntries(rule.split(';').map((x) => x.split('=')));
  const freq = r.FREQ, every = Math.max(1, Number(r.INTERVAL) || 1), count = Number(r.COUNT) || 0;
  const until = r.UNTIL ? (parseDT({ value: r.UNTIL }) || {}).date : null;
  const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => DAYS.indexOf(x.slice(-2))).filter((x) => x >= 0) : null;
  const out = []; let n = 0;
  const keep = (d) => { if (d < start || (until && d > until)) return true; n++; if (count && n > count) return false; if (d >= from && d <= to) out.push(d); return true; };
  if (freq === 'DAILY') {
    for (let d = start; d <= to && (!until || d <= until); d = addD(d, every)) if (!keep(d)) break;
  } else if (freq === 'WEEKLY') {
    const s = new Date(`${start}T12:00:00`); const wk0 = addD(start, -((s.getDay() + 6) % 7));
    const days = byday && byday.length ? byday : [s.getDay()];
    outer: for (let w = wk0; w <= to && (!until || w <= until); w = addD(w, 7 * every)) {
      for (let k = 0; k < 7; k++) { const d = addD(w, k); if (days.includes(new Date(`${d}T12:00:00`).getDay()) && !keep(d)) break outer; }
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const s = new Date(`${start}T12:00:00`);
    for (let i = 0; i < 2000; i++) {
      const d = new Date(s); if (freq === 'MONTHLY') d.setMonth(s.getMonth() + i * every); else d.setFullYear(s.getFullYear() + i * every);
      if (d.getDate() !== s.getDate()) continue; // 31 du mois, 29 février : mois sautés
      const x = isoOf(d); if (x > to || (until && x > until)) break; if (!keep(x)) break;
    }
  } else if (start >= from && start <= to) out.push(start);
  return out;
}

// Rendez-vous de l'agenda entre from et to : [{ uid, start_date, end_date, time, title, location }]
function parseICS(text, from, to) {
  const lines = unfold(text); const evs = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = prop(line); if (!p) continue;
    if (p.name === 'UID') cur.uid = p.value.trim();
    else if (p.name === 'SUMMARY') cur.title = unescape(p.value);
    else if (p.name === 'LOCATION') cur.location = unescape(p.value);
    else if (p.name === 'STATUS') cur.status = p.value.trim().toUpperCase();
    else if (p.name === 'DTSTART') cur.start = parseDT(p);
    else if (p.name === 'DTEND') cur.end = parseDT(p);
    else if (p.name === 'RRULE') cur.rrule = p.value.trim();
    else if (p.name === 'RECURRENCE-ID') cur.recurrence = parseDT(p);
    else if (p.name === 'EXDATE') p.value.split(',').forEach((v) => { const d = parseDT({ value: v }); if (d) cur.exdates.push(d.date); });
  }
  // Les occurrences modifiées à la main remplacent celles de la règle.
  const moved = new Set(evs.filter((e) => e.recurrence && e.uid).map((e) => `${e.uid}|${e.recurrence.date}`));
  const out = [];
  for (const e of evs) {
    if (!e.start || e.status === 'CANCELLED' || !e.uid || /@carchon-os$/.test(e.uid)) continue;
    // Durée en jours : DTEND est exclusif pour un événement « toute la journée ».
    let len = 0;
    if (e.end) { const a = new Date(`${e.start.date}T12:00:00`), b = new Date(`${e.end.date}T12:00:00`); len = Math.round((b - a) / 864e5); if (!e.start.time) len -= 1; }
    len = Math.max(0, Math.min(len, 60));
    const starts = e.rrule && !e.recurrence ? expand(e.start.date, e.rrule, addD(from, -len), to) : [e.start.date];
    for (const s of starts) {
      if (e.rrule && !e.recurrence && (e.exdates.includes(s) || moved.has(`${e.uid}|${s}`))) continue;
      const end = addD(s, len);
      if (end < from || s > to) continue;
      out.push({ uid: e.uid, start_date: s, end_date: end, time: e.start.time, title: e.title || '(Sans titre)', location: e.location || '' });
    }
  }
  return out.sort((a, b) => (a.start_date + a.time).localeCompare(b.start_date + b.time));
}

// ---------- Synchronisation Google → Carchon OS ----------
const importUrl = () => String(setting('gcal_ical_url') || '').trim().replace(/^webcal:/i, 'https:');
async function sync() {
  const url = importUrl(); if (!url) return { skipped: true };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Carchon-OS' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'adresse introuvable (404) : recopie l’adresse secrète' : `Google a répondu ${res.status}`);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('ce lien ne renvoie pas un agenda iCal');
    const t = isoOf(new Date());
    const list = parseICS(text, addD(t, -90), addD(t, 400));
    db.exec('BEGIN');
    try {
      q.run('DELETE FROM gcal_events');
      for (const e of list) q.run('INSERT INTO gcal_events (uid, start_date, end_date, time, title, location) VALUES (?, ?, ?, ?, ?, ?)', e.uid, e.start_date, e.end_date, e.time, e.title, e.location);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    setSetting('gcal_last_sync', new Date().toISOString()); setSetting('gcal_error', '');
    return { n: list.length };
  } catch (e) {
    setSetting('gcal_error', e.message); console.error('[google agenda]', e.message);
    return { error: e.message };
  }
}
const between = (start, end) => q.all('SELECT * FROM gcal_events WHERE start_date <= ? AND end_date >= ? ORDER BY start_date, time', end, start);

let timer = null;
function start() { if (timer) return; setTimeout(sync, 8000); timer = setInterval(sync, 10 * 60 * 1000); timer.unref(); }

// ---------- Flux Carchon OS → Google ----------
function feedToken() {
  let t = setting('ics_token');
  if (!t) { t = crypto.randomBytes(18).toString('base64url'); setSetting('ics_token', t); }
  return t;
}
function checkToken(t) {
  const s = setting('ics_token'); if (!s || !t) return false;
  const a = Buffer.from(String(t)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const ymd = (s) => s.replace(/-/g, '');
// Ligne iCal repliée à 75 octets comme le demande la norme.
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) { if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' '; } cur += ch; }
  out.push(cur); return out.join('\r\n');
}
function feed() {
  const from = addD(isoOf(new Date()), -60);
  const company = setting('company_name') || 'Carchon OS';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ev = [];
  const add = (uid, s, e, title, detail = '', place = '') => ev.push(['BEGIN:VEVENT', `UID:${uid}@carchon-os`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(s)}`, `DTEND;VALUE=DATE:${ymd(addD(e || s, 1))}`, `SUMMARY:${esc(title)}`,
    detail ? `DESCRIPTION:${esc(detail)}` : '', place ? `LOCATION:${esc(place)}` : '', 'TRANSP:TRANSPARENT', 'END:VEVENT'].filter(Boolean));
  for (const b of q.all('SELECT bars.*, people.name who, people.role, projects.name pname FROM bars LEFT JOIN people ON people.id = bars.person_id LEFT JOIN projects ON projects.id = bars.project_id WHERE end_date >= ?', from)) {
    const kind = { blocked: 'Bloqué · ', free: 'Libre · ' }[b.kind] || '';
    const who = b.who ? `${b.who} · ` : '';
    add(`bar-${b.id}`, b.start_date, b.end_date, `${who}${kind}${b.label || b.pname || 'Atelier'}`, [b.pname && b.pname !== b.label ? b.pname : '', b.detail].filter(Boolean).join(' · '));
  }
  for (const t of q.all('SELECT trips.*, projects.name pname FROM trips JOIN projects ON projects.id = trips.project_id WHERE date >= ?', from)) {
    add(`pose-${t.id}`, t.date, t.date, `Pose · ${t.pname}`, [t.what, t.team ? `Équipe : ${t.team}` : '', t.contact ? `Contact : ${t.contact}` : '', t.access ? `Accès : ${t.access}` : ''].filter(Boolean).join('\n'), t.place);
  }
  for (const o of q.all('SELECT orders.*, suppliers.name sname FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE expected_at >= ? AND arrived_at IS NULL', from)) {
    add(`cmd-${o.id}`, o.expected_at, o.expected_at, `Livraison ${o.sname || 'fournisseur'}`, o.what);
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Carchon OS//Planning//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${company} · Atelier`)}`, 'X-WR-TIMEZONE:Europe/Paris', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...ev.flat(), 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}

module.exports = { parseICS, expand, sync, start, between, importUrl, feed, feedToken, checkToken };
