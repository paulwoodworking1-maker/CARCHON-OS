'use strict';
// Liaison avec Cockpit (ou tout autre logiciel) : API JSON protégée par une clé (Pilotage › Équipe et réglages › Entreprise).
//   POST /api/v1/affaires            une affaire signée devient un OF (sur-mesure, ou lot depuis un modèle du catalogue)
//   POST /api/v1/affaires/:ref/acompte   l'acompte est encaissé : les achats bloqués se débloquent
//   GET  /api/v1/ofs                 avancement, dates, heures et coût réel de chaque OF
const express = require('express');
const crypto = require('node:crypto');
const { q, tx, setting, logActivity } = require('../db');
const P = require('../production');
const L = require('../logic');

const r = express.Router();
r.use(express.json({ limit: '200kb' }));
const str = (v) => String(v ?? '').trim();

r.use((req, res, next) => {
  const key = setting('api_token');
  const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || got.length !== key.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key))) return res.status(401).json({ error: 'Clé API absente ou invalide' });
  next();
});

const rate = () => Number(String(setting('hourly_rate', '0')).replace(',', '.')) || 0;

r.post('/affaires', (req, res) => {
  const b = req.body || {};
  const c = b.client || {};
  if (!str(b.name) && !str(b.model_code)) return res.status(400).json({ error: 'name ou model_code requis' });
  let projectId;
  try {
    tx(() => {
      let clientId = null;
      if (str(c.name)) {
        const ex = str(c.email) ? q.get('SELECT id FROM clients WHERE lower(email) = lower(?)', str(c.email)) : null;
        clientId = ex ? ex.id : Number(q.run('INSERT INTO clients (name, kind, email, phone, address) VALUES (?, ?, ?, ?, ?)', str(c.name), str(c.kind) || 'Particulier', str(c.email), str(c.phone), str(c.address)).lastInsertRowid);
      }
      const canal = P.CANALS.includes(b.canal) ? b.canal : (str(b.model_code) ? 'Revendeur' : 'Sur-mesure');
      if (str(b.model_code)) {
        const m = q.get('SELECT id FROM models WHERE code = ? AND active = 1', str(b.model_code).toUpperCase());
        if (!m) throw Object.assign(new Error('Modèle inconnu au catalogue'), { status: 400 });
        projectId = P.launchFromModel(m.id, { qty: b.qty, canal, forWhom: str(c.name), dueDate: str(b.due_date) || null, personId: L.patron().id });
        q.run('UPDATE projects SET client_id = ? WHERE id = ?', clientId, projectId);
      } else {
        projectId = Number(q.run(`INSERT INTO projects (name, kind, canal, client_id, due_date, lead_id, for_whom, deposit_needed, deposit_asked_at, deposit_at, next_action)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'Préparer le carnet')`, str(b.name), str(c.kind) || canal, canal, clientId, str(b.due_date) || null, L.patron().id, str(c.name),
          b.deposit_needed === false ? 0 : 1, b.deposit_received ? new Date().toISOString().slice(0, 10) : null).lastInsertRowid);
      }
      logActivity(projectId, null, `Affaire signée reçue de Cockpit${str(b.reference) ? ` (réf. ${str(b.reference)})` : ''}${str(b.amount) ? ` · ${str(b.amount)}` : ''}`, 'Cockpit');
    });
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  const p = q.get('SELECT id, ref FROM projects WHERE id = ?', projectId);
  res.status(201).json({ id: p.id, ref: p.ref });
});

r.post('/affaires/:ref/acompte', (req, res) => {
  const p = q.get('SELECT * FROM projects WHERE ref = ?', req.params.ref);
  if (!p) return res.status(404).json({ error: 'OF introuvable' });
  tx(() => {
    q.run('UPDATE projects SET deposit_at = COALESCE(deposit_at, date(\'now\')) WHERE id = ?', p.id);
    q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
    logActivity(p.id, null, 'Acompte encaissé (Cockpit) : achats débloqués', 'Cockpit');
  });
  res.json({ ok: true });
});

r.get('/ofs', (req, res) => {
  const rows = q.all("SELECT * FROM projects WHERE status = 'en_cours' OR finished_at >= datetime('now', '-60 days') ORDER BY id DESC").map((p) => {
    const s = L.projectSummary(p);
    const hrs = q.get("SELECT COALESCE(SUM(declared_hours), 0) d, COALESCE(SUM(est_hours), 0) e FROM steps WHERE project_id = ?", p.id);
    const units = q.all('SELECT serial, status FROM units WHERE project_id = ?', p.id);
    const trip = q.get('SELECT date, pv_signed_at FROM trips WHERE project_id = ? ORDER BY date LIMIT 1', p.id);
    return { ref: p.ref, name: p.name, canal: p.canal, status: p.status, step: s.cur.phase, due_date: p.due_date, ready_date: p.ready_date,
      hours_planned: hrs.e, hours_done: hrs.d, labour_cost: Math.round(hrs.d * rate() * 100) / 100, units,
      delivered: !!(trip?.pv_signed_at) || (units.length > 0 && units.every((u) => u.status === 'livree')), pv_signed_at: trip?.pv_signed_at || null };
  });
  res.json({ ofs: rows, hourly_rate: rate() });
});

module.exports = r;
