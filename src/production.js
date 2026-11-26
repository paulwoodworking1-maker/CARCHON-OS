'use strict';
// Production : lancer un OF depuis un modèle du catalogue, numéroter les pièces, réserver le bois,
// proposer les achats manquants.
const { q, tx, setting, logActivity } = require('./db');
const auto = require('./automations');

const CANALS = ['Sur-mesure', 'Boutique', 'Revendeur', 'Salon', 'Stock', 'SAV'];
const UNIT_STATES = { a_faire: 'À faire', en_stock: 'En stock', expediee: 'Expédiée', livree: 'Livrée' };
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const num = (x) => String(round(x)).replace('.', ',');

// Prochain numéro de pièce pour un code de modèle : S1-001, S1-002…
function nextSerials(code, n) {
  const rows = q.all('SELECT serial FROM units WHERE serial LIKE ?', `${code}-%`);
  let max = 0;
  for (const r of rows) { const m = /-(\d+)$/.exec(r.serial); if (m) max = Math.max(max, Number(m[1])); }
  return Array.from({ length: n }, (_, i) => `${code}-${String(max + i + 1).padStart(3, '0')}`);
}

// Ce qu'un lot demande en matière, et ce qui manque.
function needsFor(modelId, qty) {
  const lines = q.all('SELECT model_bom.*, stock_items.state sstate, stock_items.name sname FROM model_bom LEFT JOIN stock_items ON stock_items.id = model_bom.stock_item_id WHERE model_id = ? ORDER BY ord, id', modelId);
  return lines.map((l) => {
    const need = round(l.qty * qty);
    if (l.essence) {
      const lots = q.all('SELECT * FROM wood_lots WHERE project_id IS NULL AND lower(essence) = lower(?) AND (? = \'\' OR thickness = ?) AND volume > 0 ORDER BY volume', l.essence, l.thickness || '', l.thickness || '');
      const lot = lots.find((x) => x.volume >= need) || null;
      const total = lots.reduce((a, x) => a + x.volume, 0);
      return { ...l, need, kind: 'bois', lot, ok: !!lot, status: lot ? `Lot ${lot.code} (${num(lot.volume)} ${l.unit || 'm³'})` : total ? `Lots trop petits (${num(total)} ${l.unit || 'm³'} au total)` : 'Aucun lot libre' };
    }
    if (l.stock_item_id) {
      const ok = l.sstate === 0;
      return { ...l, need, kind: 'stock', ok, status: ['En stock', 'Bientôt vide', 'Vide'][l.sstate] || 'En stock' };
    }
    return { ...l, need, kind: 'achat', ok: false, status: 'À acheter (non suivi en stock)' };
  });
}

function launchFromModel(modelId, { qty = 1, canal = 'Boutique', forWhom = '', dueDate = null, personId = null } = {}) {
  const m = q.get('SELECT * FROM models WHERE id = ?', modelId);
  if (!m) throw new Error('Modèle introuvable');
  qty = Math.max(1, Math.min(200, Math.round(Number(qty) || 1)));
  const avg = auto.averages();
  let projectId;
  tx(() => {
    const name = qty > 1 ? `${m.name} · lot de ${qty}` : m.name;
    projectId = Number(q.run(`INSERT INTO projects (name, kind, canal, model_id, qty, for_whom, due_date, deposit_needed, lead_id, next_action)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'Envoyer le carnet à l’atelier')`, name, canal, canal, m.id, qty, forWhom, dueDate || null, personId).lastInsertRowid);
    // Carnet repris du modèle : les fiches « par pièce » sont multipliées par la quantité.
    const PH = { 'Débit, corroyage': 'Débit', Assemblage: 'Assemblage', "Queues d'aronde": 'Assemblage', Collage: 'Assemblage', Ponçage: 'Finition', Vernis: 'Finition', 'Huile-cire': 'Finition', Contrôle: 'Contrôle', Pose: 'Livraison' };
    q.all('SELECT * FROM model_steps WHERE model_id = ? ORDER BY ord, id', m.id).forEach((s, i) => {
      s.phase = s.phase || PH[s.geste] || 'Assemblage';
      const est = (s.est_hours || avg[s.geste] || 0) * (s.per_unit ? qty : 1);
      q.run('INSERT INTO steps (project_id, ord, title, piece, phase, geste, est_hours, note, checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        projectId, i + 1, s.per_unit && qty > 1 ? `${s.title} (× ${qty})` : s.title, s.piece, s.phase, s.geste, round(est, 2), s.note, s.checks);
    });
    // Pièces numérotées dès le lancement.
    for (const serial of nextSerials(m.code, qty)) q.run('INSERT INTO units (project_id, model_id, serial, reserved_for) VALUES (?, ?, ?, ?)', projectId, m.id, serial, canal === 'Stock' ? '' : forWhom);
    // Matière : le bois est réservé, le reste manquant part en suggestion d'achat.
    for (const n of needsFor(m.id, qty)) {
      if (n.kind === 'bois' && n.lot) {
        q.run('UPDATE wood_lots SET project_id = ? WHERE id = ?', projectId, n.lot.id);
        q.run('UPDATE units SET wood_lot_id = ? WHERE project_id = ?', n.lot.id, projectId);
        continue;
      }
      if (n.ok) continue;
      const text = n.kind === 'bois' ? `${n.essence}${n.thickness ? ' ' + n.thickness : ''} · ${num(n.need)} ${n.unit || 'm³'}` : `${n.article} · ${num(n.need)}${n.unit ? ' ' + n.unit : ''}`;
      q.run("INSERT INTO needs (text, category, supplier_id, project_id, stock_item_id, person_id, source, acknowledged) VALUES (?, ?, ?, ?, ?, ?, 'note', 1)",
        text, n.kind === 'bois' ? 'Matériaux' : '', n.supplier_id, projectId, n.stock_item_id, personId);
    }
    logActivity(projectId, personId, `OF lancé depuis le catalogue : ${m.name} × ${qty} (${canal}${forWhom ? ' · ' + forWhom : ''})`, 'Patron');
  });
  return projectId;
}

// Une pièce sur-mesure reçoit son numéro au contrôle final (réf. du dossier).
function ensureUnitForProject(project) {
  const u = q.get('SELECT * FROM units WHERE project_id = ? ORDER BY id LIMIT 1', project.id);
  if (u) return u;
  const id = q.run('INSERT INTO units (project_id, serial, reserved_for) VALUES (?, ?, ?)', project.id, project.ref, project.for_whom || '').lastInsertRowid;
  return q.get('SELECT * FROM units WHERE id = ?', id);
}

const warrantyMonths = () => Number(setting('warranty_months', '24')) || 24;
function warrantyUntil(unit) {
  const s = q.get('SELECT delivered_at, shipped_at FROM shipments WHERE id = ?', unit.shipment_id);
  const base = s?.delivered_at || s?.shipped_at || unit.controlled_at;
  if (!base) return null;
  const d = new Date(String(base).slice(0, 10) + 'T12:00:00'); d.setMonth(d.getMonth() + warrantyMonths());
  return d.toISOString().slice(0, 10);
}

module.exports = { CANALS, UNIT_STATES, nextSerials, needsFor, launchFromModel, ensureUnitForProject, warrantyUntil, warrantyMonths, num };
