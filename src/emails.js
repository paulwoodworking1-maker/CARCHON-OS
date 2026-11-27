'use strict';
// Textes des e-mails aux clients : code de validation (envoyé par le serveur) et
// messages préparés dans Gmail (devis, relance, espace de suivi).
const { company, setting } = require('./db');
const { ddmmyyyy, esc } = require('./html');

const sign = (c = company()) => [c.name, c.address, c.phone, c.email, c.site].filter(Boolean).join('\n');
const hello = (name) => (name ? `Bonjour ${name},` : 'Bonjour,');

const M = require('./messages');
const para = (t) => esc(t).split(/\n{2,}/).map((x) => x.replace(/\n/g, '<br>')).join('<br><br>');

// --- Code à 6 chiffres (part tout seul quand le client clique « Recevoir un code ») ---
function otp(x, code) {
  const c = company();
  const v = { bonjour: hello(x.signer_name), numero: x.number, code };
  const subject = M.t('mail_code_objet', v);
  const intro = M.t('mail_code_texte', v);
  const text = `${intro}\n\n    ${code}\n\nBien cordialement,\n${sign(c)}`;
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:0;background:#F2EFEA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EFEA;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1A1714">
<tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:3px;text-transform:uppercase;font-weight:bold">${esc(c.name)}</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6">${para(intro)}</td></tr>
<tr><td style="padding:22px 32px"><div style="font-size:34px;letter-spacing:10px;font-weight:bold;background:#F2EFEA;padding:18px 0;text-align:center">${code}</div></td></tr>
<tr><td style="padding:26px 32px 30px;font-size:13px;line-height:1.6;color:#6B635A;border-top:1px solid #D9D4CC">${[c.name, c.address, c.phone, c.email, c.site].filter(Boolean).map(esc).join('<br>')}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

const vars = ({ name, number, project, url, until }) => ({ bonjour: hello(name), numero: number, projet: project || '', lien: url, date_limite: until ? ddmmyyyy(until) : '', signature: sign() });
// --- Devis à accepter (préparé dans Gmail) ---
const quote = (a) => ({ subject: M.t('mail_devis_objet', vars(a)), body: M.t('mail_devis_texte', vars(a)) });
// --- Relance d'un devis (nouveau lien) ---
const relance = (a) => ({ subject: M.t('mail_relance_objet', vars(a)), body: M.t('mail_relance_texte', vars(a)) });
// --- Espace de suivi du projet ---
const space = (a) => ({ subject: M.t('mail_espace_objet', vars(a)), body: M.t('mail_espace_texte', vars(a)) });

// Brouillon Gmail : ouvre une nouvelle fenêtre de rédaction déjà remplie, enregistrée dans « Brouillons ».
function gmailUrl(to, { subject, body }) {
  const acct = setting('gmail_account') || setting('patron_email') || '';
  const p = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject, body });
  if (acct) p.set('authuser', acct);
  return `https://mail.google.com/mail/?${p.toString()}`;
}
const mailto = (to, { subject, body }) => `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

module.exports = { otp, quote, relance, space, gmailUrl, mailto };
