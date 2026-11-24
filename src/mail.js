'use strict';
// Envoi d'e-mails (codes de vérification des devis). Sans SMTP configuré, le message est
// seulement écrit dans le journal du serveur : utile en mode test.
const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === '1',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}
const configured = () => !!transport;

async function send({ to, subject, text }) {
  if (!transport) {
    console.log(`[e-mail non envoyé : SMTP absent] À ${to} · ${subject}\n${text}\n`);
    return { logged: true };
  }
  await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
  return { sent: true };
}

module.exports = { send, configured };
