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
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:0;background:#F2EFEA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EFEA;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1A1714">
<tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:3px;text-transform:uppercase;font-weight:bold">${esc(c.name)}</td></tr>
<tr><td style="padding:8px 32px 0;font-size:15px;line-height:1.6">${esc(hello(x.signer_name))}<br><br>Voici votre code de validation pour accepter le devis n°&nbsp;<b>${esc(x.number)}</b>&nbsp;:</td></tr>
<tr><td style="padding:22px 32px"><div style="font-size:34px;letter-spacing:10px;font-weight:bold;background:#F2EFEA;padding:18px 0;text-align:center">${code}</div></td></tr>
<tr><td style="padding:0 32px;font-size:14px;line-height:1.6;color:#4A443E">Recopiez ces 6 chiffres sur la page du devis, dans la case «&nbsp;Code reçu&nbsp;», puis cliquez sur «&nbsp;Valider le code&nbsp;».<br>Le code est valable 15&nbsp;minutes.</td></tr>
<tr><td style="padding:18px 32px 0;font-size:13px;line-height:1.6;color:#6B635A">Vous n'avez pas demandé ce code&nbsp;? Ignorez simplement cet e-mail&nbsp;: rien ne sera validé sans lui.</td></tr>
<tr><td style="padding:26px 32px 30px;font-size:13px;line-height:1.6;color:#6B635A;border-top:1px solid #D9D4CC">${[c.name, c.address, c.phone, c.email, c.site].filter(Boolean).map(esc).join('<br>')}</td></tr>
</table></td></tr></table></body></html>`;
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

// Brouillon Gmail : ouvre une nouvelle fenêtre de rédaction déjà remplie, enregistrée dans « Brouillons ».
function gmailUrl(to, { subject, body }) {
  const acct = setting('gmail_account') || setting('patron_email') || '';
  const p = new URLSearchParams({ view: 'cm', fs: '1', to: to || '', su: subject, body });
  if (acct) p.set('authuser', acct);
  return `https://mail.google.com/mail/?${p.toString()}`;
}
const mailto = (to, { subject, body }) => `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

module.exports = { otp, quote, relance, space, gmailUrl, mailto };
