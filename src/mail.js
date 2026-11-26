'use strict';
// Envoi d'e-mails (codes de vérification des devis). Sans SMTP configuré, le message est
// seulement écrit dans le journal du serveur : utile en mode test.
const nodemailer = require('nodemailer');

let transport = null;
// Le plus simple : un compte Gmail + un « mot de passe d'application » Google.
if (!process.env.SMTP_HOST && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
  process.env.SMTP_HOST = 'smtp.gmail.com'; process.env.SMTP_PORT = '465'; process.env.SMTP_SECURE = '1';
  process.env.SMTP_USER = process.env.GMAIL_USER; process.env.SMTP_PASS = process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, '');
}
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
const configured = () => !!transport;

async function send({ to, subject, text, html, replyTo }) {
  if (!transport) {
    console.log(`[e-mail non envoyé : SMTP absent] À ${to} · ${subject}\n${text}\n`);
    return { logged: true };
  }
  const name = require('./db').company().name;
  const co = require('./db').company();
  await transport.sendMail({ from: process.env.MAIL_FROM || `"${name}" <${process.env.SMTP_USER}>`, to, subject, text, html,
    replyTo: replyTo || (co.email && co.email !== process.env.SMTP_USER ? co.email : undefined) });
  return { sent: true };
}

module.exports = { send, configured };
