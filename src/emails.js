'use strict';
// Textes des e-mails aux clients : code de validation (envoyé par le serveur) et
// messages préparés dans Gmail (devis, relance, espace de suivi).
const { company, setting } = require('./db');
const { ddmmyyyy, esc } = require('./html');

const sign = (c = company()) => [c.name, c.address, c.phone, c.email, c.site].filter(Boolean).join('\n');
// « Bonjour Madame Schifano, » quand le prénom permet de choisir la civilité.
const hello = (name) => require('./civilite').emailHello(null, name);

const M = require('./messages');
const para = (t) => esc(t).split(/\n{2,}/).map((x) => x.replace(/\n/g, '<br>')).join('<br><br>');

// --- Code à 6 chiffres (part tout seul quand le client clique « Recevoir un code ») ---
function otp(x, code) {
  const c = company();
  const v = { bonjour: hello(x.signer_name), numero: x.number, code };
  const subject = M.t('mail_code_objet', v);
  const intro = M.t('mail_code_texte', v);
  const text = `${intro}\n\n    ${code}\n\nBien cordialement,\n${sign(c)}`;
  const html = require('./mail').brand(`${para(intro)}
<div style="font-size:34px;letter-spacing:10px;font-weight:bold;background:#F2EFEA;padding:18px 0;text-align:center;margin:22px 0">${code}</div>`);
  return { subject, text, html };
}

const vars = ({ name, number, project, url, until }) => ({ bonjour: hello(name), numero: number, projet: project || '', lien: url, date_limite: until ? ddmmyyyy(until) : '', signature: sign() });
// --- Devis à accepter (préparé dans Gmail) ---
const quote = (a) => ({ subject: M.t('mail_devis_objet', vars(a)), body: M.t('mail_devis_texte', vars(a)) });
// --- Relance d'un devis (nouveau lien) ---
const relance = (a) => ({ subject: M.t('mail_relance_objet', vars(a)), body: M.t('mail_relance_texte', vars(a)) });
// --- Espace de suivi du projet ---
const space = (a) => ({ subject: M.t('mail_espace_objet', vars(a)), body: M.t('mail_espace_texte', vars(a)) });

// Plus de brouillon dans une messagerie externe : le message s'ouvre dans Carchon OS, prêt à partir
// directement depuis la boîte Gmail de l'atelier.
const composeUrl = (to, { subject, body }, back = '') => `/mail/nouveau?${new URLSearchParams({ to: to || '', subject, body, ...(back ? { back } : {}) }).toString()}`;
const gmailUrl = composeUrl;
const mailto = composeUrl;

module.exports = { otp, quote, relance, space, gmailUrl, mailto, composeUrl };
