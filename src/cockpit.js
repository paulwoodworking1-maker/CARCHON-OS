'use strict';
// Liaison sortante vers Cockpit : Carchon OS prévient Cockpit quand un devis est signé,
// pour que Cockpit édite la facture d'acompte et la renvoie (POST /api/v1/affaires/:ref/factures).
const crypto = require('node:crypto');
const { q, setting, setSetting, logActivity } = require('./db');

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

module.exports = { configured, notify, send, quotePayload, addInvoice, url };
