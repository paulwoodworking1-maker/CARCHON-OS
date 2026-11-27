'use strict';
// Qonto : facture d'acompte créée et envoyée toute seule quand un client accepte son devis,
// puis acompte marqué « reçu » quand Qonto voit la facture payée.
// API Business de Qonto, authentification par clé API : en-tête « Authorization: identifiant:clé-secrète ».
//   GET  /v2/organization                  IBAN du compte principal
//   GET  /v2/clients?filter[email]=…       client déjà connu
//   POST /v2/clients                       nouveau client (adresse, devise et langue obligatoires pour facturer)
//   GET  /v2/quotes                        devis Qonto du même numéro (lien facultatif)
//   POST /v2/client_invoices               facture (statut « unpaid » = finalisée, numéro automatique)
//   POST /v2/client_invoices/{id}/send     envoi par e-mail depuis Qonto
//   GET  /v2/client_invoices/{id}          statut (paid…) et lien du PDF
const { q, setting, logActivity, company } = require('./db');
const { today, addDays, ddmmyyyy } = require('./html');

const base = () => process.env.QONTO_BASE_URL || 'https://thirdparty.qonto.com';
const login = () => process.env.QONTO_LOGIN || '';
const secret = () => process.env.QONTO_SECRET_KEY || '';
const configured = () => !!(login() && secret());
const on = () => configured() && setting('qonto_auto_deposit', '1') === '1';

const opts = () => ({
  percent: Number(String(setting('deposit_percent', '40')).replace(',', '.')) || 40,
  vat: Number(String(setting('deposit_vat', '20')).replace(',', '.')),
  dueDays: Number(setting('deposit_due_days', '7')) || 7,
  iban: setting('qonto_iban', '') || process.env.QONTO_IBAN || '',
  title: require('./messages').raw('mail_facture_objet'),
  body: require('./messages').raw('mail_facture_texte'),
});

class QontoError extends Error {}

async function api(method, path, body) {
  if (!configured()) throw new QontoError('Qonto n’est pas relié (identifiant et clé secrète manquants chez l’hébergeur).');
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: `${login()}:${secret()}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const e = data?.errors?.map((x) => [x.detail || x.message || x.code, x.source?.pointer].filter(Boolean).join(' · ')).join(' ; ') || text.slice(0, 200);
    throw new QontoError(res.status === 401 ? 'Qonto refuse la clé (identifiant ou clé secrète incorrects).' : `Qonto ${res.status} : ${e}`);
  }
  return data;
}

const money = (x) => (Math.round(x * 100) / 100).toFixed(2);
const eur = (x) => `${(Math.round(x * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const fill = (tpl, v) => require('./messages').fill(tpl, v);

async function iban() {
  const o = opts();
  if (o.iban) return o.iban.replace(/\s/g, '');
  const org = await api('GET', '/v2/organization');
  const accts = org?.organization?.bank_accounts || [];
  const a = accts.find((x) => x.main) || accts.find((x) => x.status === 'active') || accts[0];
  if (!a?.iban) throw new QontoError('Aucun IBAN trouvé sur le compte Qonto : indique-le dans Portails clients › Réglages.');
  return a.iban;
}

// « Jean Dupont » -> prénom / nom.
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { first_name: parts[0] || 'Client', last_name: parts[0] || 'Client' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

async function ensureClient(b) {
  // b : { name, email, company, street, zip, city, country }
  const found = await api('GET', `/v2/clients?filter[email]=${encodeURIComponent(b.email)}`);
  const ex = (found?.clients || [])[0];
  const address = { street_address: b.street, zip_code: b.zip, city: b.city, country_code: b.country || 'FR' };
  if (ex) {
    // Client connu : on complète ce qui manque pour pouvoir facturer.
    if (!ex.currency || !ex.locale || !(ex.billing_address?.city || ex.city)) await api('PATCH', `/v2/clients/${ex.id}`, { currency: 'EUR', locale: 'fr', billing_address: address });
    return ex.id;
  }
  const payload = b.company
    ? { kind: 'company', name: b.company, email: b.email, currency: 'EUR', locale: 'fr', billing_address: address }
    : { kind: 'individual', ...splitName(b.name), email: b.email, currency: 'EUR', locale: 'fr', billing_address: address };
  const c = await api('POST', '/v2/clients', payload);
  return c.client.id;
}

// Devis Qonto du même numéro, pour relier la facture (facultatif : on continue sans).
async function qontoQuoteId(number) {
  try {
    for (let page = 1; page <= 3; page++) {
      const r = await api('GET', `/v2/quotes?per_page=100&page=${page}`);
      const hit = (r?.quotes || []).find((x) => String(x.number).trim() === String(number).trim());
      if (hit) return hit.id;
      if (!r?.meta?.next_page) break;
    }
  } catch { /* lien facultatif */ }
  return null;
}

// Montants de l'acompte à partir du montant HT du devis.
function depositAmounts(amountHt) {
  const o = opts();
  const ht = Math.round(amountHt * o.percent) / 100;
  const ttc = Math.round(ht * (1 + o.vat / 100) * 100) / 100;
  return { ht, ttc, percent: o.percent, vat: o.vat };
}

// Crée la facture d'acompte dans Qonto et l'envoie au client. Idempotent : une seule facture par projet.
async function createDeposit(projectId) {
  const p = q.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) throw new QontoError('Projet introuvable');
  if (p.deposit_invoice_id) return { already: true };
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", projectId);
  if (!quote) throw new QontoError('Aucun devis accepté sur ce projet.');
  if (quote.test) throw new QontoError('Devis de test : aucune facture réelle n’est émise.');
  const amount = quote.amount_ht || p.amount_ht;
  if (!(amount > 0)) throw new QontoError('Montant HT du devis inconnu : indique-le sur le projet, puis réessaie.');
  const bill = JSON.parse(quote.billing_json || '{}');
  if (!bill.city || !bill.zip || !bill.street) throw new QontoError('Adresse de facturation du client manquante.');
  // Verrou : évite deux factures si deux demandes arrivent en même temps.
  const lock = q.run("UPDATE projects SET deposit_invoice_status = 'creating', deposit_invoice_error = '' WHERE id = ? AND COALESCE(deposit_invoice_status, '') NOT IN ('creating', 'sent', 'created')", projectId);
  if (!lock.changes) return { busy: true };
  try {
    const o = opts();
    const a = depositAmounts(amount);
    const clientId = await ensureClient({ name: quote.accept_name || quote.signer_name, email: quote.signer_email, company: bill.company, street: bill.street, zip: bill.zip, city: bill.city, country: bill.country });
    const quoteId = await qontoQuoteId(quote.number);
    const due = addDays(today(), o.dueDays);
    const title = `Acompte ${a.percent} % · devis ${quote.number}`.slice(0, 40);
    const inv = await api('POST', '/v2/client_invoices', {
      client_id: clientId, issue_date: today(), due_date: due, currency: 'EUR', status: 'unpaid',
      payment_methods: { iban: await iban() },
      ...(quoteId ? { quote_id: quoteId } : {}),
      purchase_order: String(p.ref || '').slice(0, 40),
      header: `Facture d’acompte de ${a.percent} % sur le devis n° ${quote.number} accepté le ${ddmmyyyy(quote.accepted_at)}.`,
      items: [{ title, description: `${quote.project_name || p.name}\nMontant du devis : ${eur(amount)} HT · acompte de ${a.percent} %.`, quantity: '1', unit: 'unit',
        unit_price: { value: money(a.ht), currency: 'EUR' }, vat_rate: String(a.vat / 100) }],
    });
    const ci = inv.client_invoice;
    q.run("UPDATE projects SET deposit_invoice_id = ?, deposit_invoice_number = ?, deposit_invoice_url = ?, deposit_invoice_status = 'created', deposit_invoice_ttc = ?, deposit_invoice_due = ?, deposit_asked_at = datetime('now') WHERE id = ?",
      ci.id, ci.number || '', ci.invoice_url || '', a.ttc, due, projectId);
    logActivity(projectId, null, `Facture d’acompte ${ci.number || ''} créée dans Qonto : ${eur(a.ttc)} TTC (${a.percent} %)`, 'Qonto');
    const v = { prenom: splitName(quote.accept_name || quote.signer_name).first_name, projet: quote.project_name || p.name, devis: quote.number, pourcent: a.percent, montant: eur(a.ttc), echeance: ddmmyyyy(due), entreprise: company().name };
    await api('POST', `/v2/client_invoices/${ci.id}/send`, { send_to: [quote.signer_email], copy_to_self: true, email_title: fill(o.title, v), email_body: fill(o.body, v) });
    q.run("UPDATE projects SET deposit_invoice_status = 'sent', deposit_invoice_sent_at = datetime('now') WHERE id = ?", projectId);
    logActivity(projectId, null, `Facture d’acompte envoyée par Qonto à ${quote.signer_email}`, 'Qonto');
    try { require('./sms').notify('maj', { projectId, quoi: 'facture d’acompte' }); } catch { /* SMS facultatif */ }
    return { id: ci.id, number: ci.number, ttc: a.ttc };
  } catch (e) {
    const created = q.get('SELECT deposit_invoice_id FROM projects WHERE id = ?', projectId).deposit_invoice_id;
    q.run('UPDATE projects SET deposit_invoice_status = ?, deposit_invoice_error = ? WHERE id = ?', created ? 'created' : 'error', String(e.message).slice(0, 400), projectId);
    logActivity(projectId, null, `Facture d’acompte : ${created ? 'créée mais pas envoyée' : 'échec'} (${String(e.message).slice(0, 160)})`, 'Qonto');
    throw e;
  }
}

// Facture de solde : montant HT du devis moins l'acompte HT déjà facturé, à la signature du PV.
async function createBalance(projectId) {
  const p = q.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) throw new QontoError('Projet introuvable');
  if (p.balance_invoice_id) return { already: true };
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", projectId);
  if (quote?.test) throw new QontoError('Devis de test : aucune facture réelle n’est émise.');
  const amount = quote?.amount_ht || p.amount_ht;
  if (!(amount > 0)) throw new QontoError('Montant HT du projet inconnu : indique-le sur le projet, puis réessaie.');
  const o = opts();
  const depositHt = p.deposit_invoice_ttc ? Math.round(p.deposit_invoice_ttc / (1 + o.vat / 100) * 100) / 100 : p.deposit_at ? Math.round(amount * o.percent) / 100 : 0;
  const ht = Math.round((amount - depositHt) * 100) / 100;
  if (ht <= 0) throw new QontoError('Rien à facturer : l’acompte couvre déjà le montant.');
  const ttc = Math.round(ht * (1 + o.vat / 100) * 100) / 100;
  const bill = JSON.parse(quote?.billing_json || '{}');
  const client = p.client_id ? q.get('SELECT * FROM clients WHERE id = ?', p.client_id) : null;
  const email = quote?.signer_email || client?.email;
  if (!email) throw new QontoError('E-mail du client manquant.');
  if (!bill.city && !client?.address) throw new QontoError('Adresse de facturation du client manquante.');
  const lock = q.run("UPDATE projects SET balance_invoice_status = 'creating', balance_invoice_error = '' WHERE id = ? AND COALESCE(balance_invoice_status, '') NOT IN ('creating', 'sent', 'created')", projectId);
  if (!lock.changes) return { busy: true };
  try {
    const addr = bill.city ? bill : (() => { const m = /^(.*?),?\s*(\d{5})\s+(.+)$/.exec(client.address || ''); return m ? { street: m[1], zip: m[2], city: m[3] } : { street: client.address, zip: '00000', city: '-' }; })();
    const clientId = await ensureClient({ name: quote?.accept_name || client?.name, email, company: bill.company, street: addr.street, zip: addr.zip, city: addr.city, country: 'FR' });
    const due = addDays(today(), o.dueDays);
    const number = quote?.number || p.ref;
    const inv = await api('POST', '/v2/client_invoices', {
      client_id: clientId, issue_date: today(), due_date: due, currency: 'EUR', status: 'unpaid', payment_methods: { iban: await iban() },
      purchase_order: String(p.ref || '').slice(0, 40),
      header: `Facture de solde du devis n° ${number}${p.deposit_invoice_number ? `, après la facture d’acompte n° ${p.deposit_invoice_number}` : ''}.`,
      items: [{ title: `Solde · devis ${number}`.slice(0, 40), description: `${quote?.project_name || p.name}\nMontant du devis : ${eur(amount)} HT${depositHt ? ` · acompte déjà facturé : ${eur(depositHt)} HT` : ''}.`, quantity: '1', unit: 'unit',
        unit_price: { value: money(ht), currency: 'EUR' }, vat_rate: String(o.vat / 100) }],
    });
    const ci = inv.client_invoice;
    q.run("UPDATE projects SET balance_invoice_id = ?, balance_invoice_number = ?, balance_invoice_url = ?, balance_invoice_status = 'created', balance_invoice_ttc = ?, balance_invoice_due = ? WHERE id = ?", ci.id, ci.number || '', ci.invoice_url || '', ttc, due, projectId);
    logActivity(projectId, null, `Facture de solde ${ci.number || ''} créée dans Qonto : ${eur(ttc)} TTC`, 'Qonto');
    const M = require('./messages');
    const v = { prenom: splitName(quote?.accept_name || client?.name).first_name, projet: quote?.project_name || p.name, devis: number, montant: eur(ttc), echeance: ddmmyyyy(due) };
    await api('POST', `/v2/client_invoices/${ci.id}/send`, { send_to: [email], copy_to_self: true, email_title: M.t('mail_solde_objet', v), email_body: M.t('mail_solde_texte', v) });
    q.run("UPDATE projects SET balance_invoice_status = 'sent', balance_invoice_sent_at = datetime('now') WHERE id = ?", projectId);
    logActivity(projectId, null, `Facture de solde envoyée par Qonto à ${email}`, 'Qonto');
    try { require('./sms').notify('maj', { projectId, quoi: 'facture de solde' }); } catch { /* facultatif */ }
    return { id: ci.id, number: ci.number, ttc };
  } catch (e) {
    const created = q.get('SELECT balance_invoice_id FROM projects WHERE id = ?', projectId).balance_invoice_id;
    q.run('UPDATE projects SET balance_invoice_status = ?, balance_invoice_error = ? WHERE id = ?', created ? 'created' : 'error', String(e.message).slice(0, 400), projectId);
    logActivity(projectId, null, `Facture de solde : ${created ? 'créée mais pas envoyée' : 'échec'} (${String(e.message).slice(0, 160)})`, 'Qonto');
    throw e;
  }
}
// PV signé : facture de solde sans attendre (si Qonto est relié et l'automatisme activé).
function afterPv(projectId) {
  if (!configured() || setting('qonto_auto_balance', '1') !== '1') return;
  setImmediate(() => createBalance(projectId).catch((e) => console.error('[qonto] facture de solde', e.message)));
}

// Facture créée mais l'envoi a échoué : on renvoie seulement l'e-mail.
async function resend(projectId) {
  const p = q.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!p?.deposit_invoice_id) return createDeposit(projectId);
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", projectId);
  const o = opts();
  const v = { prenom: splitName(quote?.accept_name || quote?.signer_name).first_name, projet: quote?.project_name || p.name, devis: quote?.number || '', pourcent: o.percent, montant: eur(p.deposit_invoice_ttc || 0), echeance: ddmmyyyy(p.deposit_invoice_due), entreprise: company().name };
  try {
    await api('POST', `/v2/client_invoices/${p.deposit_invoice_id}/send`, { send_to: [quote?.signer_email].filter(Boolean), copy_to_self: true, email_title: fill(o.title, v), email_body: fill(o.body, v) });
  } catch (e) {
    q.run('UPDATE projects SET deposit_invoice_error = ? WHERE id = ?', String(e.message).slice(0, 400), projectId);
    throw e;
  }
  q.run("UPDATE projects SET deposit_invoice_status = 'sent', deposit_invoice_sent_at = datetime('now'), deposit_invoice_error = '' WHERE id = ?", projectId);
  logActivity(projectId, null, 'Facture d’acompte renvoyée par Qonto', 'Qonto');
  return { ok: true };
}

// Après l'acceptation d'un devis : on lance la facture sans faire attendre le client.
function afterAccept(projectId) {
  if (!on()) return;
  setImmediate(() => createDeposit(projectId).catch((e) => console.error('[qonto] facture d’acompte', e.message)));
}

// Toutes les 10 minutes : factures payées dans Qonto -> acompte reçu (achats débloqués), lien du PDF à jour.
async function syncPaid() {
  if (!configured()) return 0;
  let n = 0;
  for (const p of q.all("SELECT * FROM projects WHERE deposit_invoice_id IS NOT NULL AND deposit_at IS NULL AND status = 'en_cours'")) {
    try {
      const r = await api('GET', `/v2/client_invoices/${p.deposit_invoice_id}`);
      const ci = r?.client_invoice;
      if (!ci) continue;
      if (ci.invoice_url && ci.invoice_url !== p.deposit_invoice_url) q.run('UPDATE projects SET deposit_invoice_url = ? WHERE id = ?', ci.invoice_url, p.id);
      if (ci.status === 'paid') {
        q.run("UPDATE projects SET deposit_at = date('now'), deposit_invoice_status = 'paid' WHERE id = ?", p.id);
        q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
        logActivity(p.id, null, `Acompte payé (facture ${ci.number || ''} réglée dans Qonto) : achats débloqués`, 'Qonto');
        try { require('./sms').notify('acompte', { projectId: p.id }); } catch { /* facultatif */ }
        n++;
      }
    } catch (e) { console.error('[qonto] suivi', e.message); }
  }
  for (const p of q.all("SELECT * FROM projects WHERE balance_invoice_id IS NOT NULL AND COALESCE(balance_invoice_status, '') != 'paid'")) {
    try {
      const ci = (await api('GET', `/v2/client_invoices/${p.balance_invoice_id}`))?.client_invoice;
      if (!ci) continue;
      if (ci.invoice_url && ci.invoice_url !== p.balance_invoice_url) q.run('UPDATE projects SET balance_invoice_url = ? WHERE id = ?', ci.invoice_url, p.id);
      if (ci.status === 'paid') {
        q.run("UPDATE projects SET balance_invoice_status = 'paid' WHERE id = ?", p.id);
        q.run("UPDATE trips SET balance_paid_at = COALESCE(balance_paid_at, datetime('now')) WHERE id = (SELECT id FROM trips WHERE project_id = ? AND pv_signed_at IS NOT NULL ORDER BY pv_signed_at DESC LIMIT 1)", p.id);
        logActivity(p.id, null, `Solde payé (facture ${ci.number || ''} réglée dans Qonto)`, 'Qonto');
        n++;
      }
    } catch (e) { console.error('[qonto] suivi solde', e.message); }
  }
  return n;
}

async function test() {
  const org = await api('GET', '/v2/organization');
  const o = org?.organization || {};
  return { name: o.legal_name || o.name || o.slug || '', iban: (o.bank_accounts || []).find((x) => x.main)?.iban || (o.bank_accounts || [])[0]?.iban || '' };
}

module.exports = { createBalance, afterPv, configured, on, opts, depositAmounts, createDeposit, resend, afterAccept, syncPaid, test, QontoError, eur, api };
