'use strict';
// Envoi d'e-mails. Tout part directement depuis la boîte Gmail de l'atelier (mot de passe d'application
// Google, saisi dans Portails clients › Réglages et e-mails, ou GMAIL_APP_PASSWORD chez l'hébergeur).
// Sans Gmail : SMTP_* ou Brevo ; sinon le message est seulement écrit dans le journal du serveur.
const path = require('node:path');
const nodemailer = require('nodemailer');

const DEFAULT_GMAIL = 'paulwoodworking1@gmail.com';
const LOGO = path.join(__dirname, '..', 'public', 'logo.png');
const db = () => require('./db');

const gmailUser = () => process.env.GMAIL_USER || db().setting('gmail_user') || DEFAULT_GMAIL;
const gmailPass = () => String(process.env.GMAIL_APP_PASSWORD || db().setting('gmail_app_password') || '').replace(/\s+/g, '');

let cache = { key: '', t: null };
function transport() {
  if (process.env.SMTP_HOST) {
    const key = 'smtp';
    if (cache.key !== key) cache = { key, t: nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined }) };
    return cache.t;
  }
  const pass = gmailPass();
  if (!pass) return null;
  const key = `gmail:${gmailUser()}:${pass}`;
  if (cache.key !== key) cache = { key, t: nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: gmailUser(), pass } }) };
  return cache.t;
}
const brevo = () => !transport() && !!process.env.BREVO_API_KEY;
const sender = () => process.env.MAIL_FROM || db().setting('mail_from') || (process.env.SMTP_HOST ? process.env.SMTP_USER : gmailUser()) || db().company().email || '';
const configured = () => !!transport() || (brevo() && !!sender());
const via = () => (transport() ? (process.env.SMTP_HOST ? 'smtp' : 'gmail') : brevo() && sender() ? 'brevo' : '');
const fromAddress = () => (process.env.SMTP_HOST ? process.env.SMTP_USER : transport() ? gmailUser() : sender());

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1A1714">$1</a>');

// Gabarit commun : le logo Carchon en tête, le texte, les coordonnées en pied.
function brand(innerHtml, { logoSrc = 'cid:logo-carchon' } = {}) {
  const c = db().company();
  return `<!doctype html><html lang="fr"><body style="margin:0;padding:0;background:#F2EFEA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EFEA;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1A1714">
<tr><td style="padding:30px 32px 18px;border-bottom:1px solid #D9D4CC"><img src="${logoSrc}" alt="${escHtml(c.name)}" width="150" style="display:block;width:150px;height:auto;border:0"></td></tr>
<tr><td style="padding:24px 32px 8px;font-size:15px;line-height:1.65">${innerHtml}</td></tr>
<tr><td style="padding:22px 32px 28px;font-size:12px;line-height:1.6;color:#6B635A;border-top:1px solid #D9D4CC">${[c.name, c.address, c.phone, c.email, c.site].filter(Boolean).map(escHtml).join('<br>')}</td></tr>
</table></td></tr></table></body></html>`;
}
// Texte brut → paragraphes HTML dans le gabarit.
const textToHtml = (text) => brand(String(text).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${linkify(escHtml(p)).replace(/\n/g, '<br>')}</p>`).join(''));

async function viaBrevo({ to, subject, text, html, replyTo }) {
  const co = db().company();
  const base = process.env.PUBLIC_URL || '';
  const body = { sender: { name: co.name, email: sender() }, to: [{ email: to }], subject, textContent: text,
    ...(html ? { htmlContent: html.replace(/cid:logo-carchon/g, `${base}/static/logo.png`) } : {}),
    ...(replyTo || (co.email && co.email !== sender()) ? { replyTo: { email: replyTo || co.email } } : {}) };
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Brevo ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return { sent: true };
}

// html facultatif : sans lui, le texte est mis en page avec le logo.
async function send({ to, subject, text, html, replyTo, attachments = [] }) {
  html = html || textToHtml(text);
  const t = transport();
  if (!t && brevo() && sender()) return viaBrevo({ to, subject, text, html, replyTo });
  if (!t) {
    console.log(`[e-mail non envoyé : Gmail pas encore branché] À ${to} · ${subject}\n${text}\n`);
    return { logged: true };
  }
  const co = db().company();
  const from = fromAddress();
  await t.sendMail({ from: process.env.MAIL_FROM || `"${co.name}" <${from}>`, to, subject, text, html,
    replyTo: replyTo || (co.email && co.email !== from ? co.email : undefined),
    attachments: [...(html.includes('cid:logo-carchon') ? [{ filename: 'carchon.png', path: LOGO, cid: 'logo-carchon' }] : []), ...attachments] });
  return { sent: true };
}

module.exports = { send, configured, via, fromAddress, sender, brand, textToHtml, gmailUser, DEFAULT_GMAIL };
