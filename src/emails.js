'use strict';
// Textes des e-mails aux clients : code de validation (envoyé par le serveur) et
// messages préparés dans Gmail (devis, relance, espace de suivi).
const { company, setting } = require('./db');
const { ddmmyyyy, esc } = require('./html');

const sign = (c = company()) => [c.name, c.address, c.phone, c.email, c.site].filter(Boolean).join('\n');
const hello = (name) => (name ? `Bonjour ${name},` : 'Bonjour,');

// --- Code à 6 chiffres (part tout seul quand le client clique « Recevoir un code ») ---
function otp(x, code) {
  const c = company();
  const subject = `${code} est votre code de validation · devis n° ${x.number}`;
  const text = `${hello(x.signer_name)}

Voici votre code de validation pour accepter le devis n° ${x.number} :

    ${code}

Recopiez ces 6 chiffres sur la page du devis, dans la case « Code reçu », puis cliquez sur « Valider le code ».
Le code est valable 15 minutes. S'il a expiré, cliquez de nouveau sur « Recevoir un code ».

Vous n'avez pas demandé ce code ? Ignorez simplement cet e-mail : rien ne sera validé sans lui.

Bien cordialement,
${sign(c)}`;
  const html = require('./mail').brand(`${esc(hello(x.signer_name))}<br><br>Voici votre code de validation pour accepter le devis n°&nbsp;<b>${esc(x.number)}</b>&nbsp;:
<div style="font-size:34px;letter-spacing:10px;font-weight:bold;background:#F2EFEA;padding:18px 0;text-align:center;margin:22px 0">${code}</div>
<span style="font-size:14px;color:#4A443E">Recopiez ces 6 chiffres sur la page du devis, dans la case «&nbsp;Code reçu&nbsp;», puis cliquez sur «&nbsp;Valider le code&nbsp;».<br>Le code est valable 15&nbsp;minutes.</span>
<p style="font-size:13px;color:#6B635A;margin:18px 0 0">Vous n'avez pas demandé ce code&nbsp;? Ignorez simplement cet e-mail&nbsp;: rien ne sera validé sans lui.</p>`);
  return { subject, text, html };
}

// --- Devis à accepter (préparé dans Gmail) ---
function quote({ name, number, project, url, until }) {
  const c = company();
  return {
    subject: `Votre devis n° ${number}${project ? ` · ${project}` : ''} · ${c.name}`,
    body: `${hello(name)}

Suite à nos échanges, j'ai le plaisir de vous transmettre notre devis n° ${number}${project ? ` pour ${project}` : ''}.

Vous pouvez le consulter et l'accepter en ligne, sur votre espace personnel :
${url}

COMMENT ÇA MARCHE (2 minutes, sans compte ni mot de passe)

1. Cliquez sur le lien ci-dessus : votre devis s'ouvre dans votre navigateur.
2. Lisez le devis et nos conditions générales de vente (boutons « Ouvrir le devis »).
3. Cliquez sur « Recevoir un code » : un code à 6 chiffres vous est envoyé par e-mail à cette adresse, dans la minute (pensez à regarder dans les indésirables).
4. Recopiez ce code, cochez la case d'acceptation et cliquez sur « J'accepte le devis ». C'est fait : nous lançons la commande et vous recevez la confirmation à l'écran.

Une question, un ajustement ? En bas de la même page, « Refuser ou demander une modification » vous permet de nous écrire. Vous pouvez aussi simplement répondre à cet e-mail${c.phone ? ` ou m'appeler au ${c.phone}` : ''}.

Ce lien vous est personnel et reste valable jusqu'au ${ddmmyyyy(until)}.

Je reste à votre disposition.

Bien cordialement,

${sign(c)}`,
  };
}

// --- Relance d'un devis (nouveau lien) ---
function relance({ name, number, project, url, until }) {
  const c = company();
  return {
    subject: `Votre devis n° ${number}${project ? ` · ${project}` : ''} · ${c.name}`,
    body: `${hello(name)}

Je reviens vers vous au sujet de notre devis n° ${number}${project ? ` pour ${project}` : ''}.

Le voici de nouveau, à consulter et accepter en ligne :
${url}

Il suffit d'ouvrir le lien, de lire le devis, de demander le code à 6 chiffres envoyé par e-mail, puis de cliquer sur « J'accepte le devis ». Si vous souhaitez un ajustement, vous pouvez nous l'écrire en bas de la même page ou répondre à cet e-mail.

Ce lien est valable jusqu'au ${ddmmyyyy(until)}.

Bien cordialement,

${sign(c)}`,
  };
}

// --- Espace de suivi du projet ---
function space({ name, project, url }) {
  const c = company();
  return {
    subject: `Le suivi de votre projet${project ? ` · ${project}` : ''} · ${c.name}`,
    body: `${hello(name)}

Votre projet${project ? ` « ${project} »` : ''} est lancé à l'atelier. Vous pouvez suivre son avancement sur votre espace personnel :
${url}

Vous y trouverez les grandes étapes de fabrication, la date de livraison ou de pose prévue, les photos que nous partageons au fil du travail, ainsi que votre devis accepté.

Pas de compte à créer : gardez simplement ce lien (par exemple dans vos favoris). Il vous est personnel, merci de ne pas le transférer.

Bien cordialement,

${sign(c)}`,
  };
}

// Plus de brouillon dans une messagerie externe : le message s'ouvre dans Carchon OS, prêt à partir
// directement depuis la boîte Gmail de l'atelier.
const composeUrl = (to, { subject, body }, back = '') => `/mail/nouveau?${new URLSearchParams({ to: to || '', subject, body, ...(back ? { back } : {}) }).toString()}`;
const gmailUrl = composeUrl;
const mailto = composeUrl;

module.exports = { otp, quote, relance, space, gmailUrl, mailto, composeUrl };
