'use strict';
// Liaison avec Cockpit (vente et finance), dans les deux sens.
// 1. Base clientèle partagée. Cockpit est la référence :
//    - Cockpit peut pousser ses clients : POST /api/v1/clients (un client ou une liste) ;
//    - Carchon OS va les chercher : GET {adresse de Cockpit}/api/v1/clients, toutes les heures et sur demande.
// 2. Liaison sortante : Carchon OS prévient Cockpit quand un devis est signé,
//    pour que Cockpit édite la facture d'acompte et la renvoie (POST /api/v1/affaires/:ref/factures).
const crypto = require('node:crypto');
const { q, tx, setting, setSetting, logActivity } = require('./db');

const str = (v) => String(v ?? '').trim();
const baseUrl = () => str(setting('cockpit_url') || process.env.COCKPIT_URL).replace(/\/+$/, '');
const key = () => str(setting('cockpit_key'));
const syncConfigured = () => !!baseUrl();

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
  if (!syncConfigured()) throw new Error('Adresse de Cockpit non renseignée');
  const r = await fetch(`${baseUrl()}/api/v1/clients`, { headers: { accept: 'application/json', ...(key() ? { authorization: `Bearer ${key()}` } : {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Cockpit a répondu ${r.status}`);
  const d = await r.json();
  const list = Array.isArray(d) ? d : d.clients || d.data || [];
  const n = upsertMany(list);
  setSetting('cockpit_synced_at', new Date().toISOString());
  setSetting('cockpit_error', '');
  return n;
}
async function pullQuiet() { if (!syncConfigured()) return; try { await pull(); } catch (e) { setSetting('cockpit_error', e.message); } }
function start() { setTimeout(pullQuiet, 20 * 1000).unref?.(); setInterval(pullQuiet, 60 * 60 * 1000).unref?.(); }

// --- Liaison sortante (webhook) ---
const url = () => setting('cockpit_webhook_url') || process.env.COCKPIT_WEBHOOK_URL || '';
const configured = () => !!url();
const publicBase = () => process.env.PUBLIC_URL || setting('public_url') || '';

function quotePayload(x) {
  const p = x.project_id ? q.get('SELECT * FROM projects WHERE id = ?', x.project_id) : null;
  const c = p?.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  return {
    of: p ? { ref: p.ref, nom: p.name, livraison: p.due_date || null } : null,
    devis: { numero: x.number, version: x.version, accepte_le: x.accepted_at, reference_acceptation: x.accept_ref, signataire: x.accept_name, qualite: x.accept_quality,
      lignes: (() => { try { return JSON.parse(x.lines || '[]').map((l) => ({ designation: l.d, quantite: l.q })); } catch { return []; } })() },
    client: { nom: c?.name || x.signer_name, email: c?.email || x.signer_email, telephone: c?.phone || x.signer_phone || '' },
    acompte_attendu: !!(p && p.deposit_needed && !p.deposit_at),
    retour_facture: p && publicBase() ? `${publicBase()}/api/v1/affaires/${encodeURIComponent(p.ref)}/factures` : null,
  };
}

// Envoi signé (HMAC SHA-256 avec la clé de liaison), 3 essais espacés.
async function send(event, data, attempt = 1) {
  if (!configured()) return { skipped: true };
  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  const sig = crypto.createHmac('sha256', setting('api_token') || '').update(body).digest('hex');
  try {
    const r = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json', 'x-carchon-event': event, 'x-carchon-signature': `sha256=${sig}` }, body, signal: AbortSignal.timeout(15000) });
    setSetting('cockpit_last', JSON.stringify({ event, at: new Date().toISOString(), status: r.status }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true };
  } catch (e) {
    setSetting('cockpit_last', JSON.stringify({ event, at: new Date().toISOString(), error: e.message }));
    if (attempt < 3) { setTimeout(() => send(event, data, attempt + 1), attempt * 60000).unref?.(); return { retry: true }; }
    if (data?.of?.ref) { const p = q.get('SELECT id FROM projects WHERE ref = ?', data.of.ref); if (p) logActivity(p.id, null, `Cockpit n’a pas pu être prévenu (${event}) : ${e.message}`, 'Système'); }
    return { error: e.message };
  }
}
const notify = (event, data) => { send(event, data).catch(() => {}); };

// Facture reçue (Cockpit, ou déposée à la main) : rangée dans l'OF et publiée sur le portail du client.
function addInvoice(projectId, { file, type = 'acompte', number = '', amount = '', due = '', source = 'Cockpit' }) {
  const kind = type === 'acompte' ? 'facture_acompte' : type === 'solde' ? 'facture_solde' : 'facture';
  const label = { facture_acompte: 'Facture d’acompte', facture_solde: 'Facture de solde', facture: 'Facture' }[kind];
  const title = `${label}${number ? ` n° ${number}` : ''}${amount ? ` · ${amount}` : ''}`;
  const id = Number(q.run('INSERT INTO documents (project_id, title, file, visible_client, kind, number, amount) VALUES (?, ?, ?, 1, ?, ?, ?)', projectId, title, file, kind, number, amount).lastInsertRowid);
  logActivity(projectId, null, `${title} publiée sur le portail client (${source})${due ? `, échéance ${due}` : ''}`, source);
  require('./sms').notify('maj', { projectId, quoi: label.toLowerCase().replace('’', "'") });
  return id;
}

module.exports = { upsert, upsertMany, pull, pullQuiet, start, syncConfigured, baseUrl, configured, notify, send, quotePayload, addInvoice, url };
