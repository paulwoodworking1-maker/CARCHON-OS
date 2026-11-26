'use strict';
// Parc machines : usage estimé depuis les fiches terminées (aucun pointage), échéances d'entretien.
const { q } = require('./db');

const daysBetween = (a, b) => Math.floor((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 864e5);
const todayIso = () => new Date().toISOString().slice(0, 10);

// Heures d'usage depuis une date : heures déclarées des fiches finies dont le geste utilise la machine.
function usageSince(machine, since) {
  const gestes = String(machine.gestes || '').split('|').map((g) => g.trim()).filter(Boolean);
  if (!gestes.length) return 0;
  const r = q.get(`SELECT COALESCE(SUM(declared_hours), 0) h FROM steps WHERE status = 'done' AND geste IN (${gestes.map(() => '?').join(',')}) AND done_at > ?`,
    ...gestes, since || '1970-01-01');
  return Math.round(r.h * 10) / 10;
}

// État d'un entretien : reste (heures ou jours), part consommée, libellé.
function taskState(task, machine) {
  const last = task.last_done || machine.since || '2020-01-01';
  const opts = [];
  if (task.every_hours) {
    const used = usageSince(machine, last);
    opts.push({ unit: 'h', left: Math.round((task.every_hours - used) * 10) / 10, ratio: used / task.every_hours, used });
  }
  if (task.every_days) {
    const d = daysBetween(last, todayIso());
    opts.push({ unit: 'j', left: task.every_days - d, ratio: d / task.every_days, used: d });
  }
  const s = opts.sort((a, b) => b.ratio - a.ratio)[0] || { unit: 'j', left: 999, ratio: 0, used: 0 };
  const late = s.left < 0;
  const soon = !late && ((s.unit === 'j' && s.left <= 30) || (s.unit === 'h' && s.left <= 20));
  const label = late ? `dépassé de ${fmt(-s.left, s.unit)}` : `dans ${fmt(s.left, s.unit)}`;
  return { ...s, late, soon, label, pct: Math.max(0, Math.min(100, Math.round(s.ratio * 100))) };
}
const fmt = (n, u) => (u === 'h' ? `${String(Math.round(n * 10) / 10).replace('.', ',')} h` : `${n} j`);
const freqLabel = (t) => [t.every_hours ? `toutes les ${t.every_hours} h d'usage` : '', t.every_days ? (t.every_days % 365 === 0 ? `tous les ${t.every_days / 365 > 1 ? t.every_days / 365 + ' ans' : 'ans'}` : t.every_days % 30 === 0 ? `tous les ${t.every_days / 30 === 1 ? '' : t.every_days / 30 + ' '}mois` : `tous les ${t.every_days} jours`) : ''].filter(Boolean).join(' ou ').replace('tous les  mois', 'tous les mois').replace('tous les ans', 'tous les ans');

function all() {
  return q.all('SELECT * FROM machines ORDER BY ord, name').map((m) => {
    const tasks = q.all('SELECT * FROM machine_tasks WHERE machine_id = ? ORDER BY id', m.id).map((t) => ({ ...t, st: taskState(t, m), freq: freqLabel(t) }));
    const next = tasks.slice().sort((a, b) => b.st.ratio - a.st.ratio)[0] || null;
    const state = m.down_since ? 'panne' : tasks.some((t) => t.st.late) ? 'du' : 'ok';
    return { ...m, tasks, next, state };
  });
}

function dueCount() {
  return all().reduce((n, m) => n + (m.down_since ? 1 : 0) + m.tasks.filter((t) => t.st.late).length, 0);
}

// Alertes pour « À décider ».
function alerts() {
  const out = [];
  for (const m of all()) {
    if (m.down_since) out.push({ kind: 'ko', tag: 'Panne', title: `${m.name} en panne`, text: m.down_note || 'Signalée sans précision', href: `/machines?m=${m.id}`, cta: 'Voir la machine' });
    for (const t of m.tasks.filter((x) => x.st.late)) out.push({ kind: 'wa', tag: 'Entretien', title: `${m.name} : ${t.title}`, text: t.st.label, href: `/machines?m=${m.id}`, cta: 'Voir' });
  }
  return out;
}

module.exports = { usageSince, taskState, freqLabel, all, dueCount, alerts, todayIso };
