'use strict';
// Livraisons et poses d'un projet : elles se décident dans la fiche projet (plusieurs dates possibles),
// les infos pratiques viennent toutes seules de la fiche client, et chaque date entre dans le planning.
const { q, logActivity } = require('./db');
const { ddmm } = require('./html');

const KINDS = ['Livraison et pose', 'Livraison', 'Pose', 'Livraison partielle', 'Reprise / finitions sur place', 'Enlèvement à l’atelier'];
const str = (v) => String(v ?? '').trim();

// Ce qu'on sait déjà : adresse, contact, téléphone du client ; équipe = responsable du projet.
function autoInfo(p) {
  const c = p.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  const lead = p.lead_id ? q.get('SELECT * FROM people WHERE id = ?', p.lead_id) : null;
  const chain = q.get('SELECT params FROM chains WHERE project_id = ?', p.id);
  let etage = null;
  try { etage = chain ? JSON.parse(chain.params).etage : null; } catch {}
  return {
    place: c?.address || '',
    contact: c ? [c.name, c.phone].filter(Boolean).join(' · ') : str(p.for_whom),
    access: etage !== null && etage !== undefined && etage !== '' ? (Number(etage) ? `${etage}e étage sans ascenseur` : 'Rez-de-chaussée') : '',
    team: lead ? (lead.role === 'patron' ? 'Toi' : lead.name) : '',
  };
}
function checklist(projectId) {
  const pose = q.get("SELECT checks FROM steps WHERE project_id = ? AND (phase = 'Livraison' OR geste = 'Pose' OR title LIKE '%pose%') ORDER BY ord DESC LIMIT 1", projectId);
  let items = [];
  try { items = pose ? JSON.parse(pose.checks).map((c) => c.t || c).filter(Boolean) : []; } catch {}
  return [...items, 'iPad chargé pour le PV'].map((t) => ({ t, done: false }));
}

function addTrip(p, b) {
  const auto = autoInfo(p);
  const date = str(b.date);
  if (!date) return null;
  const kind = KINDS.includes(b.kind) ? b.kind : KINDS[0];
  const hours = Number(String(b.hours ?? '').replace(',', '.')) || 0;
  const team = str(b.team) || auto.team;
  const id = Number(q.run('INSERT INTO trips (project_id, date, kind, hours, what, place, access, contact, team, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    p.id, date, kind, hours, str(b.what) || kind, str(b.place) || auto.place, str(b.access) || auto.access, str(b.contact) || auto.contact,
    `${team}${hours ? ` · ${String(hours).replace('.', ',')} h` : ''}`, JSON.stringify(checklist(p.id))).lastInsertRowid);
  // L'échéance du projet suit la dernière date de livraison.
  const last = q.get('SELECT MAX(date) d FROM trips WHERE project_id = ?', p.id).d;
  if (last) q.run('UPDATE projects SET due_date = ? WHERE id = ?', last, p.id);
  logActivity(p.id, null, `${kind} prévue le ${ddmm(date)}`, 'Patron');
  try { require('./sms').notify('rdv', { projectId: p.id, date: ddmm(date), titre: kind.toLowerCase() }); } catch {}
  return id;
}

module.exports = { KINDS, autoInfo, addTrip };
