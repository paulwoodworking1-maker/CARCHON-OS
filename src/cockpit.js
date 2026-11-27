'use strict';
// Base clientèle partagée avec Cockpit (vente et finance). Cockpit est la référence :
// - Cockpit peut pousser ses clients : POST /api/v1/clients (un client ou une liste) ;
// - Carchon OS va les chercher : GET {adresse de Cockpit}/api/v1/clients, toutes les heures et sur demande.
const { q, tx, setting, setSetting } = require('./db');

const str = (v) => String(v ?? '').trim();
const url = () => str(setting('cockpit_url')).replace(/\/+$/, '');
const key = () => str(setting('cockpit_key'));
const configured = () => !!url();
// Cockpit qui tourne sur l'ordinateur du patron (localhost) : seul son navigateur peut le joindre.
const local = () => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(url());

// Ajoute ou met à jour un client venu de Cockpit (par identifiant Cockpit, sinon par e-mail).
function upsert(c) {
  const cid = str(c.id ?? c.cockpit_id ?? c.ref);
  const name = str(c.name || c.nom || c.raison_sociale || [c.prenom, c.nom_famille].filter(Boolean).join(' '));
  if (!name) return null;
  const email = str(c.email), phone = str(c.phone ?? c.telephone ?? c.mobile);
  const address = str(c.address ?? c.adresse ?? [c.rue, c.code_postal, c.ville].filter(Boolean).join(' '));
  const kind = str(c.kind ?? c.type) || 'Particulier';
  const ex = (cid && q.get('SELECT id FROM clients WHERE cockpit_id = ?', cid)) || (email && q.get('SELECT id FROM clients WHERE lower(email) = lower(?)', email)) || null;
  if (ex) {
    q.run("UPDATE clients SET name = ?, email = COALESCE(NULLIF(?, ''), email), phone = COALESCE(NULLIF(?, ''), phone), address = COALESCE(NULLIF(?, ''), address), kind = ?, cockpit_id = COALESCE(NULLIF(?, ''), cockpit_id), synced_at = datetime('now') WHERE id = ?",
      name, email, phone, address, kind, cid, ex.id);
    return ex.id;
  }
  return Number(q.run("INSERT INTO clients (name, kind, email, phone, address, cockpit_id, synced_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))", name, kind, email, phone, address, cid || null).lastInsertRowid);
}
function upsertMany(list) {
  let n = 0;
  tx(() => { for (const c of list) if (upsert(c)) n++; });
  // Les titres des projets suivent le nom du client.
  for (const p of q.all('SELECT id FROM projects WHERE client_id IS NOT NULL')) require('./logic').syncProjectName(p.id);
  return n;
}

async function pull() {
  if (!configured()) throw new Error('Adresse de Cockpit non renseignée');
  if (local()) throw new Error('Cockpit tourne sur ton ordinateur : la synchronisation se fait depuis ton navigateur (bouton « Synchroniser depuis cet ordinateur »)');
  const r = await fetch(`${url()}/api/v1/clients`, { headers: { accept: 'application/json', ...(key() ? { authorization: `Bearer ${key()}` } : {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Cockpit a répondu ${r.status}`);
  const d = await r.json();
  const list = Array.isArray(d) ? d : d.clients || d.data || [];
  const n = upsertMany(list);
  setSetting('cockpit_synced_at', new Date().toISOString());
  setSetting('cockpit_error', '');
  return n;
}
async function pullQuiet() { if (!configured() || local()) return; try { await pull(); } catch (e) { setSetting('cockpit_error', e.message); } }
function start() { setTimeout(pullQuiet, 20 * 1000).unref?.(); setInterval(pullQuiet, 60 * 60 * 1000).unref?.(); }

module.exports = { local, upsert, upsertMany, pull, pullQuiet, start, configured, url };
