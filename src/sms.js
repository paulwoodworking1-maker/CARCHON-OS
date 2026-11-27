'use strict';
// SMS au client à chaque nouveauté sur son portail (prestataire : Brevo).
// Les messages attendent 15 minutes avant de partir : plusieurs actions d'affilée = un seul SMS.
// Pas d'envoi la nuit ni le dimanche : le message part le matin suivant, à 8 h.
const crypto = require('node:crypto');
const { q, setting, setSetting, company } = require('./db');

const EVENTS = {
  devis: ['Devis envoyé ou relancé', '{atelier} : votre devis n°{numero} vous attend. Consultez-le et acceptez-le en 2 minutes : {lien}'],
  espace: ['Espace de suivi ouvert', '{atelier} : votre espace de suivi pour "{projet}" est ouvert. Etapes, photos et documents : {lien}'],
  maj: ['Nouveauté sur le portail (photo, document, compte rendu, fabrication, pose)', '{atelier} : du nouveau sur votre projet "{projet}" ({quoi}). A voir ici : {lien}'],
  rdv: ['Rendez-vous à venir', '{atelier} : rendez-vous le {date} - {titre}. Les détails sur votre espace : {lien}'],
  acompte: ['Acompte reçu', '{atelier} : nous avons bien reçu votre acompte, merci. La suite de votre projet : {lien}'],
};
const DELAY_MIN = 15;

const configured = () => !!process.env.BREVO_API_KEY;
const enabled = () => setting('sms_enabled', '1') === '1';
const eventOn = (k) => setting(`sms_on_${k}`, '1') === '1';
const template = (k) => setting(`sms_tpl_${k}`) || EVENTS[k][1];

// Numéro français → format international sans « + » (06 12 34 56 78 → 33612345678).
function normalize(phone) {
  let d = String(phone || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^0[67]\d{8}$/.test(d)) d = '33' + d.slice(1);
  return /^\d{10,15}$/.test(d) ? d : '';
}
const isMobile = (p) => /^33[67]\d{8}$/.test(p) || (!p.startsWith('33') && p.length >= 10);

// Les liens des portails sont gardés chiffrés pour pouvoir les remettre dans un SMS.
function key() { return crypto.createHash('sha256').update('liens-portail:' + require('./auth').secret()).digest(); }
function seal(token) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function open(sealed) {
  try {
    const [iv, tag, enc] = String(sealed || '').split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}
const baseUrl = () => process.env.PUBLIC_URL || setting('public_url') || '';

// Le meilleur lien pour ce client : son espace de suivi, sinon le lien de son devis.
function linkFor({ projectId, quoteId }) {
  const p = projectId ? q.get('SELECT portal_state, portal_token_enc FROM projects WHERE id = ?', projectId) : null;
  if (p && p.portal_state === 'open' && open(p.portal_token_enc)) return `${baseUrl()}/p/espace/${open(p.portal_token_enc)}`;
  const qt = quoteId ? q.get('SELECT token_enc, status FROM quotes WHERE id = ?', quoteId)
    : projectId ? q.get("SELECT token_enc, status FROM quotes WHERE project_id = ? AND token_enc IS NOT NULL ORDER BY id DESC LIMIT 1", projectId) : null;
  if (qt && qt.status !== 'revoked' && open(qt.token_enc)) return `${baseUrl()}/p/devis/${open(qt.token_enc)}`;
  return '';
}
function recipient({ projectId, quoteId }) {
  if (quoteId) {
    const x = q.get('SELECT quotes.signer_phone, quotes.project_id, clients.phone, clients.sms_off FROM quotes LEFT JOIN clients ON clients.id = quotes.client_id WHERE quotes.id = ?', quoteId);
    if (x?.sms_off) return null;
    if (x?.signer_phone || x?.phone) return { phone: x.signer_phone || x.phone };
    if (x?.project_id) projectId = x.project_id;
  }
  if (projectId) {
    const x = q.get('SELECT clients.phone, clients.sms_off, clients.name FROM projects JOIN clients ON clients.id = projects.client_id WHERE projects.id = ?', projectId);
    if (x && !x.sms_off && x.phone) return { phone: x.phone };
  }
  return null;
}

// À appeler après chaque action du patron qui se voit sur le portail.
function notify(event, { projectId = null, quoteId = null, quoi = '', date = '', titre = '' } = {}) {
  try {
    if (!enabled() || !EVENTS[event] || !eventOn(event)) return;
    const to = recipient({ projectId, quoteId });
    const phone = to && normalize(to.phone);
    if (!phone) return;
    const k = projectId ? `p${projectId}` : `q${quoteId}`;
    const pending = q.get("SELECT * FROM sms_queue WHERE target = ? AND status = 'attente'", k);
    if (pending) {
      // Plusieurs nouveautés d'affilée : un seul SMS qui les résume.
      const v = JSON.parse(pending.vars || '{}');
      const list = [...new Set([...(v.quoi ? v.quoi.split(', ') : []), ...(quoi ? [quoi] : []), ...(pending.event !== event && !quoi ? [EVENTS[event][0].toLowerCase()] : [])])];
      const ev = pending.event === event ? event : (event === 'devis' || pending.event === 'devis') ? 'devis' : 'maj';
      q.run('UPDATE sms_queue SET event = ?, vars = ?, phone = ? WHERE id = ?', ev, JSON.stringify({ ...v, quoi: list.slice(0, 3).join(', '), date: date || v.date, titre: titre || v.titre }), phone, pending.id);
      return;
    }
    q.run("INSERT INTO sms_queue (target, project_id, quote_id, phone, event, vars, send_after) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))",
      k, projectId, quoteId, phone, event, JSON.stringify({ quoi, date, titre }), `+${DELAY_MIN} minutes`);
  } catch (e) { console.error('[sms] mise en file', e.message); }
}

// Texte final : modèle + valeurs, en caractères simples (1 SMS = 160 caractères).
function compose(row) {
  const v = JSON.parse(row.vars || '{}');
  const p = row.project_id ? q.get('SELECT name FROM projects WHERE id = ?', row.project_id) : null;
  const qt = row.quote_id ? q.get('SELECT number, project_name FROM quotes WHERE id = ?', row.quote_id) : null;
  const lien = linkFor({ projectId: row.project_id, quoteId: row.quote_id }) || 'le lien reçu par e-mail';
  const vals = { atelier: setting('sms_signature') || company().name, projet: p?.name || qt?.project_name || 'votre projet', numero: qt?.number || v.numero || '', quoi: v.quoi || 'nouvelle étape', date: v.date || '', titre: v.titre || '', lien };
  return template(row.event).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m))
    .replace(/[’‘]/g, "'").replace(/[«»“”]/g, '"').replace(/[–—]/g, '-').replace(/ | /g, ' ').replace(/ {2,}/g, ' ').trim();
}

// Heures calmes : lundi-samedi, 8 h - 20 h (heure de Paris).
function quietNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const h = Number(parts.hour);
  return parts.weekday.startsWith('dim') || h < 8 || h >= 20;
}

const testMode = () => setting('portal_test_mode') === '1';
const testPhones = () => (setting('sms_test_phones') || '').split(/[\s,;]+/).map(normalize).filter(Boolean);

async function sendNow(phone, content) {
  if (!configured()) throw new Error('SMS non branché (clé Brevo absente)');
  const body = { sender: (setting('sms_sender') || 'CARCHON').replace(/[^A-Za-z0-9]/g, '').slice(0, 11) || 'CARCHON', recipient: phone, content, type: 'transactional' };
  const call = (path) => fetch(`https://api.brevo.com/v3/transactionalSMS/${path}`, { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  let r = await call('send');
  if (r.status === 404) r = await call('sms'); // ancienne adresse de l'API
  const txt = await r.text();
  if (!r.ok) throw new Error(`Brevo ${r.status} : ${txt.slice(0, 200)}`);
  return txt;
}

let running = false;
async function flush() {
  if (running) return; running = true;
  try {
    if (quietNow()) return;
    for (const row of q.all("SELECT * FROM sms_queue WHERE status = 'attente' AND send_after <= datetime('now') ORDER BY id LIMIT 20")) {
      const text = compose(row);
      if (testMode() && !testPhones().includes(row.phone)) { q.run("UPDATE sms_queue SET status = 'test', text = ?, sent_at = datetime('now') WHERE id = ?", text, row.id); continue; }
      if (!configured()) { q.run("UPDATE sms_queue SET status = 'non_branche', text = ?, sent_at = datetime('now') WHERE id = ?", text, row.id); continue; }
      try { await sendNow(row.phone, text); q.run("UPDATE sms_queue SET status = 'envoye', text = ?, sent_at = datetime('now') WHERE id = ?", text, row.id); }
      catch (e) { q.run("UPDATE sms_queue SET status = 'echec', text = ?, error = ?, sent_at = datetime('now') WHERE id = ?", text, String(e.message).slice(0, 300), row.id); }
    }
  } catch (e) { console.error('[sms]', e.message); } finally { running = false; }
}
let timer = null;
function start() { if (timer) return; timer = setInterval(flush, 60 * 1000); timer.unref(); }

const lastFor = (...targets) => q.get(`SELECT * FROM sms_queue WHERE target IN (${targets.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, ...targets);

module.exports = { EVENTS, DELAY_MIN, configured, enabled, eventOn, template, normalize, isMobile, seal, open, linkFor, notify, compose, quietNow, sendNow, flush, start, lastFor, testPhones };
void setSetting;
