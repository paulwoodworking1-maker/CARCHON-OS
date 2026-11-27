'use strict';
// Suivi client automatique : ce qu'on oublie quand on a 50 chantiers.
//   - devis sans réponse : relance à J+7 et J+21, avec le même lien ;
//   - facture d'acompte ou de solde impayée : rappel le lendemain de l'échéance, avec le lien de paiement ;
//   - après la pose : merci et demande d'avis à J+3, puis « un an déjà » à J+365.
// Ne concerne que ce qui arrive après la mise en route (pas de rafale sur l'historique).
// Textes : Messages aux clients. Interrupteurs : Pilotage › Automatisations.
const { q, setting, setSetting, logActivity } = require('./db');
const { today, addDays, ddmmyyyy } = require('./html');
const mail = require('./mail');
const M = require('./messages');

const on = (k) => setting(k, '1') === '1';
const since = () => { let s = setting('client_auto_since'); if (!s) { s = new Date().toISOString().slice(0, 19).replace('T', ' '); setSetting('client_auto_since', s); } return s; };
const hello = (name) => require('./civilite').emailHello(null, name);

async function send(to, key, vars, projectId, what) {
  if (!to) return false;
  await mail.send({ to, subject: M.t(`${key}_objet`, vars), text: M.t(`${key}_texte`, vars) });
  if (projectId) logActivity(projectId, null, `${what} envoyé automatiquement à ${to}`, 'Automatique');
  return true;
}

async function relancesDevis() {
  if (!on('auto_relance_devis')) return 0;
  const S = require('./sms');
  const t = today(); let n = 0;
  for (const x of q.all("SELECT * FROM quotes WHERE status = 'sent' AND test = 0 AND COALESCE(link_at, created_at) >= ? AND valid_until >= ?", since(), t)) {
    const start = String(x.link_at || x.created_at).slice(0, 10);
    const step = !x.relance1_at && addDays(start, 7) <= t ? 1 : x.relance1_at && !x.relance2_at && addDays(start, 21) <= t ? 2 : 0;
    if (!step) continue;
    const tok = S.open(x.token_enc);
    if (!tok) continue;
    const base = (process.env.PUBLIC_URL || setting('public_url') || '').replace(/\/$/, '');
    if (!base) continue;
    const v = { bonjour: hello(x.signer_name), numero: x.number, projet: x.project_name || '', lien: `${base}/p/devis/${tok}`, date_limite: ddmmyyyy(x.valid_until) };
    await send(x.signer_email, step === 1 ? 'mail_relance_auto' : 'mail_relance_auto2', v, x.project_id, `Relance du devis ${x.number} (J+${step === 1 ? 7 : 21})`);
    q.run(`UPDATE quotes SET relance${step}_at = datetime('now') WHERE id = ?`, x.id);
    n++;
  }
  return n;
}

async function relancesFactures() {
  if (!on('auto_relance_facture')) return 0;
  const t = today(); let n = 0;
  const rows = q.all(`SELECT p.*, c.email cemail, c.name cname FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.status != 'annule'`);
  for (const p of rows) {
    for (const [k, label] of [['deposit', 'Rappel de la facture d’acompte'], ['balance', 'Rappel de la facture de solde']]) {
      const sent = p[`${k}_invoice_sent_at`], due = p[`${k}_invoice_due`], url = p[`${k}_invoice_url`];
      const paid = k === 'deposit' ? !!p.deposit_at : p.balance_invoice_status === 'paid';
      if (!sent || sent < since() || paid || p[`${k}_reminded_at`] || !due || due >= t) continue;
      const to = q.get("SELECT signer_email e FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id)?.e || p.cemail;
      const v = { bonjour: hello(p.cname), projet: p.name, numero: p[`${k}_invoice_number`] || '', montant: require('./qonto').eur(p[`${k}_invoice_ttc`] || 0), echeance: ddmmyyyy(due), lien: url || '', facture: k === 'deposit' ? 'd’acompte' : 'de solde' };
      if (await send(to, 'mail_rappel_facture', v, p.id, label)) { q.run(`UPDATE projects SET ${k}_reminded_at = datetime('now') WHERE id = ?`, p.id); n++; }
    }
  }
  return n;
}

async function apresPose() {
  let n = 0;
  const rows = q.all(`SELECT t.*, p.name pname, p.id pid, c.email cemail, c.name cname FROM trips t JOIN projects p ON p.id = t.project_id LEFT JOIN clients c ON c.id = p.client_id
    WHERE t.pv_signed_at IS NOT NULL AND t.pv_signed_at >= ?`, since());
  for (const r of rows) {
    const signed = String(r.pv_signed_at).slice(0, 10);
    const v = { bonjour: hello(r.cname), projet: r.pname, avis: setting('google_review_url', '') };
    if (on('auto_avis') && !r.review_sent_at && addDays(signed, 3) <= today() && !r.pv_reserves) {
      if (await send(r.cemail, 'mail_avis', v, r.pid, 'Remerciement et demande d’avis')) { q.run("UPDATE trips SET review_sent_at = datetime('now') WHERE id = ?", r.id); n++; }
    }
    if (on('auto_anniversaire') && !r.anniversary_sent_at && addDays(signed, 365) <= today()) {
      if (await send(r.cemail, 'mail_anniversaire', v, r.pid, 'Message « un an déjà »')) { q.run("UPDATE trips SET anniversary_sent_at = datetime('now') WHERE id = ?", r.id); n++; }
    }
  }
  return n;
}

// Une fois par jour (après 9 h), depuis la boucle des automatisations.
async function daily() {
  if (!mail.configured()) return 0;
  since();
  const t = today();
  if (setting('client_auto_day') === t || new Date().getHours() < 9) return 0;
  setSetting('client_auto_day', t);
  return (await relancesDevis()) + (await relancesFactures()) + (await apresPose());
}

module.exports = { daily, relancesDevis, relancesFactures, apresPose, since };
