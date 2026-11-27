'use strict';
// Tous les textes que voit ou reçoit un client, au même endroit, modifiables dans « Messages aux clients ».
// {mot} est remplacé par l'information du dossier. Un passage [entre crochets] disparaît si une
// information qu'il contient manque. Un texte vidé masque le message (pour les encadrés du portail).
const { setting, setSetting, company } = require('./db');

const G = {
  next: 'Portail · encadré « Prochaine étape »',
  steps: 'Portail · étapes du projet',
  portal: 'Portail · autres textes',
  auto: 'E-mails envoyés automatiquement',
  prep: 'E-mails préparés (tu les relis avant d’envoyer)',
  sms: 'SMS',
};

// [clé, groupe, quand, texte par défaut, { title: true (une ligne), vars, skey (réglage existant), hideable }]
const CATALOG = [
  // --- Portail : prochaine étape ---
  ['next_devis_titre', G.next, 'Devis envoyé, pas encore accepté (titre)', 'Lire et accepter votre devis', { title: true, vars: ['version'] }],
  ['next_devis_texte', G.next, 'Devis envoyé, pas encore accepté', 'À faire avant le {date_limite}.', { vars: ['date_limite', 'date_envoi'] }],
  ['next_modif_titre', G.next, 'Le client a demandé une modification (titre)', 'Nous préparons la nouvelle version de votre devis', { title: true }],
  ['next_modif_texte', G.next, 'Le client a demandé une modification', 'Suite à votre demande du {date}. Vous la recevrez par e-mail, en général sous 48 h ouvrées.', { vars: ['date'] }],
  ['next_refus_titre', G.next, 'Le client a décliné (titre)', 'Vous avez décliné ce devis', { title: true }],
  ['next_refus_texte', G.next, 'Le client a décliné', 'Merci de votre réponse. Si votre projet évolue, nous serons heureux d’en reparler.', {}],
  ['next_acompte_facture_titre', G.next, 'Devis accepté, facture d’acompte envoyée (titre)', 'Régler l’acompte[ : {montant} TTC]', { title: true, vars: ['montant'] }],
  ['next_acompte_facture_texte', G.next, 'Devis accepté, facture d’acompte envoyée', 'Votre facture d’acompte[ n° {numero}] vous a été envoyée par e-mail[, à régler avant le {echeance}]. Dès réception, nous réservons le bois et planifions la fabrication.', { vars: ['numero', 'echeance', 'montant'] }],
  ['next_acompte_attente_titre', G.next, 'Devis accepté, facture pas encore partie (titre)', 'Régler l’acompte prévu au devis', { title: true }],
  ['next_acompte_attente_texte', G.next, 'Devis accepté, facture pas encore partie', 'Votre facture d’acompte arrive très bientôt par e-mail. Dès réception du règlement, nous réservons le bois et planifions la fabrication.', {}],
  ['next_preparation_titre', G.next, 'Acompte reçu, fabrication pas commencée (titre) · vide = encadré masqué', '', { title: true, hideable: true }],
  ['next_preparation_texte', G.next, 'Acompte reçu, fabrication pas commencée', '', { hideable: true, vars: ['date_prete'] }],
  ['next_fabrication_titre', G.next, 'Fabrication en cours (titre)', 'Votre pièce est en fabrication', { title: true }],
  ['next_fabrication_texte', G.next, 'Fabrication en cours', '[Elle sera prête à poser vers le {date_prete}.]', { vars: ['date_prete'] }],
  ['next_prete_titre', G.next, 'Fabrication terminée (titre)', 'Votre pièce est prête', { title: true }],
  ['next_prete_texte', G.next, 'Fabrication terminée', '[Pose prévue le {date_pose}.]', { vars: ['date_pose'] }],
  ['next_prete_sans_date', G.next, 'Fabrication terminée, pose pas encore datée', 'Nous vous appelons pour convenir de la date de pose.', {}],
  ['next_recu_titre', G.next, 'Réponse reçue, sans projet ouvert (titre)', 'Nous revenons vers vous', { title: true }],
  ['next_recu_texte', G.next, 'Réponse reçue, sans projet ouvert', 'L’atelier a bien reçu votre réponse.', {}],
  // --- Portail : étapes ---
  ['etape_1', G.steps, 'Étape 1', 'Rencontre et prise de cotes', { title: true }],
  ['etape_2', G.steps, 'Étape 2', 'Devis', { title: true }],
  ['etape_3', G.steps, 'Étape 3', 'Acompte', { title: true }],
  ['etape_4', G.steps, 'Étape 4', 'Fabrication', { title: true }],
  ['etape_5', G.steps, 'Étape 5', 'Prête à poser', { title: true }],
  ['etape_6', G.steps, 'Étape 6', 'Pose', { title: true }],
  ['etape_7', G.steps, 'Étape 7', 'Réception', { title: true }],
  // --- Portail : autres textes ---
  ['portail_titre', G.portal, 'Titre en haut de chaque page (Bonjour avant 18 h, Bonsoir après)', '{salutation}[ {civilite}] {nom} {prenom}', { title: true, vars: ['salutation', 'civilite', 'nom', 'prenom'] }],
  ['portail_email', G.portal, 'Adresse e-mail affichée au client (pied de page, bloc « Une question ? »)', 'contact@carchon.com', { title: true }],
  ['portail_question', G.portal, 'Bloc « Une question ? » en bas de l’accueil', 'Écrivez-nous à {email}, ou répondez simplement à notre dernier e-mail. Gardez ce lien dans vos favoris : il vous ramène toujours ici.', { vars: ['email'] }],
  ['portail_pied', G.portal, 'Pied de chaque page', 'Ce lien est personnel : ne le transférez pas. Vos données servent uniquement au suivi de votre projet.', {}],
  ['portail_accepte', G.portal, 'Bandeau juste après l’acceptation du devis', 'Merci ! Votre devis est accepté (référence {reference}). Voici l’accueil de votre projet : gardez ce lien pour suivre la suite.', { vars: ['reference'] }],
  ['portail_modif_envoyee', G.portal, 'Bandeau après une demande de modification', 'Votre demande est transmise à l’atelier. Vous recevrez la nouvelle version du devis par e-mail.', {}],
  ['portail_refus_envoye', G.portal, 'Bandeau après un refus', 'Votre réponse est transmise. Merci de nous avoir tenus informés.', {}],
  ['portail_photos_vide', G.portal, 'Onglet Photos, aucune photo partagée', 'Les photos de votre pièce apparaîtront ici au fil de la fabrication.', {}],
  // --- E-mails automatiques ---
  ['mail_code_objet', G.auto, 'Code de validation du devis (objet)', '{code} est votre code de validation · devis n° {numero}', { title: true, vars: ['code', 'numero'] }],
  ['mail_code_texte', G.auto, 'Code de validation du devis (le code s’affiche en grand sous ce texte)', '{bonjour}\n\nVoici votre code pour accepter le devis n° {numero}. Recopiez-le sur la page du devis, dans la case « Code reçu ». Il est valable 15 minutes.\n\nVous n’avez pas demandé ce code ? Ignorez simplement cet e-mail : rien ne sera validé sans lui.', { vars: ['bonjour', 'numero'] }],
  ['mail_pose_objet', G.auto, 'Rappel 2 jours avant la livraison ou la pose (objet)', 'Votre livraison du {date}', { title: true, vars: ['date'] }],
  ['mail_pose_texte', G.auto, 'Rappel 2 jours avant la livraison ou la pose', '{bonjour}\n\nNous vous rappelons notre venue le {date} pour {quoi} (« {projet} »).\nMerci de prévoir un accès dégagé. En cas d’empêchement, répondez simplement à ce message.\n\nÀ bientôt,\n{entreprise}', { vars: ['bonjour', 'date', 'quoi', 'projet', 'entreprise'] }],
  ['mail_facture_objet', G.auto, 'Facture d’acompte, envoyée par Qonto à l’acceptation (objet)', 'Votre facture d’acompte · {projet}', { title: true, vars: ['projet'], skey: 'deposit_mail_title' }],
  ['mail_facture_texte', G.auto, 'Facture d’acompte, envoyée par Qonto à l’acceptation', 'Bonjour {prenom},\n\nMerci pour votre confiance. Vous trouverez ci-jointe la facture d’acompte de {pourcent} % pour « {projet} » (devis n° {devis}), soit {montant} TTC, à régler avant le {echeance}.\n\nDès réception, nous réservons le bois et planifions la fabrication.\n\nBien cordialement,\n{entreprise}', { vars: ['prenom', 'pourcent', 'projet', 'devis', 'montant', 'echeance', 'entreprise'], skey: 'deposit_mail_body' }],
  // --- E-mails préparés ---
  ['mail_devis_objet', G.prep, 'Envoi du devis (objet)', 'Votre devis n° {numero}[ · {projet}] · {entreprise}', { title: true, vars: ['numero', 'projet', 'entreprise'] }],
  ['mail_devis_texte', G.prep, 'Envoi du devis', '{bonjour}\n\nSuite à nos échanges, j’ai le plaisir de vous transmettre notre devis n° {numero}[ pour {projet}].\n\nVous pouvez le consulter et l’accepter en ligne :\n{lien}\n\nEn 2 minutes, sans compte : ouvrez le lien, lisez le devis, recevez un code par e-mail, puis cliquez sur « J’accepte le devis ». Pour un ajustement, utilisez « Demander une modification » en bas de la page, ou répondez à cet e-mail[ ou appelez-moi au {telephone}].\n\nCe lien vous est personnel et reste valable jusqu’au {date_limite}.\n\nBien cordialement,\n\n{signature}', { vars: ['bonjour', 'numero', 'projet', 'lien', 'telephone', 'date_limite', 'signature'] }],
  ['mail_relance_objet', G.prep, 'Relance d’un devis avec nouveau lien (objet)', 'Votre devis n° {numero}[ · {projet}] · {entreprise}', { title: true, vars: ['numero', 'projet', 'entreprise'] }],
  ['mail_relance_texte', G.prep, 'Relance d’un devis avec nouveau lien', '{bonjour}\n\nJe reviens vers vous au sujet de notre devis n° {numero}[ pour {projet}].\n\nLe voici de nouveau, à consulter et accepter en ligne :\n{lien}\n\nSi vous souhaitez un ajustement, écrivez-le en bas de la même page ou répondez à cet e-mail.\n\nCe lien est valable jusqu’au {date_limite}.\n\nBien cordialement,\n\n{signature}', { vars: ['bonjour', 'numero', 'projet', 'lien', 'date_limite', 'signature'] }],
  ['mail_espace_objet', G.prep, 'Ouverture de l’espace de suivi (objet)', 'Le suivi de votre projet[ · {projet}] · {entreprise}', { title: true, vars: ['projet', 'entreprise'] }],
  ['mail_espace_texte', G.prep, 'Ouverture de l’espace de suivi', '{bonjour}\n\nVotre projet[ « {projet} »] est lancé à l’atelier. Vous pouvez suivre son avancement sur votre espace personnel :\n{lien}\n\nVous y trouverez les grandes étapes, la date de livraison ou de pose prévue et les photos que nous partageons au fil du travail.\n\nPas de compte à créer : gardez simplement ce lien. Il vous est personnel, merci de ne pas le transférer.\n\nBien cordialement,\n\n{signature}', { vars: ['bonjour', 'projet', 'lien', 'signature'] }],
  ['mail_rappel_devis_objet', G.prep, 'Devis sans réponse qui expire dans 3 jours (objet)', 'Votre devis {numero}', { title: true, vars: ['numero'] }],
  ['mail_rappel_devis_texte', G.prep, 'Devis sans réponse qui expire dans 3 jours', 'Bonjour,\n\nJe me permets de revenir vers vous au sujet du devis {numero}, dont le lien de validation expire le {date_limite}. Avez-vous des questions ou souhaitez-vous des ajustements ?\n\nBien cordialement,\n{entreprise}', { vars: ['numero', 'date_limite', 'entreprise'] }],
  ['mail_rappel_acompte_objet', G.prep, 'Acompte attendu depuis plus d’une semaine (objet)', 'Acompte · {projet}', { title: true, vars: ['projet'] }],
  ['mail_rappel_acompte_texte', G.prep, 'Acompte attendu depuis plus d’une semaine', 'Bonjour,\n\nPour lancer la fabrication de votre projet « {projet} », nous attendons le règlement de l’acompte prévu au devis.\nSi c’est déjà fait, merci de ne pas tenir compte de ce message.\n\nBien cordialement,\n{entreprise}', { vars: ['projet', 'entreprise'] }],
  ['mail_nouvelles_texte', G.prep, '« Donner des nouvelles » quand l’assistant n’est pas actif (sinon il rédige à partir de l’avancement réel)', 'Bonjour,\n\nVoici où en est votre projet « {projet} » :\n{faits}\n\nN’hésitez pas à nous écrire si vous avez une question.\n\nBien cordialement,\n{entreprise}', { vars: ['projet', 'faits', 'entreprise'] }],
];

// SMS : mêmes réglages qu'avant (Portails clients › Réglages), présentés ici avec le reste.
function smsEntries() {
  const S = require('./sms');
  return Object.entries(S.EVENTS).map(([k, [label, def]]) => [`sms_${k}`, G.sms, label, def, { skey: `sms_tpl_${k}`, vars: ['atelier', 'projet', 'numero', 'quoi', 'date', 'titre', 'lien'], sms: true }]);
}
const all = () => [...CATALOG, ...smsEntries()];
const find = (key) => all().find((e) => e[0] === key);
const skey = (e) => e[4].skey || `msg_${e[0]}`;

function raw(key) {
  const e = find(key);
  if (!e) throw new Error(`Message inconnu : ${key}`);
  const v = setting(skey(e), null);
  return v === null ? e[3] : v;
}

// Remplit {mots} ; un [passage] disparaît si l'une de ses informations est vide.
function fill(tpl, vars = {}) {
  const c = company();
  const v = { entreprise: c.name, telephone: c.phone || '', email: setting('msg_portail_email', null) ?? 'contact@carchon.com', ...vars };
  const val = (k) => (v[k] === undefined || v[k] === null ? '' : String(v[k]));
  let out = String(tpl).replace(/\[([^\[\]]*)\]/g, (m, inner) => {
    const keys = [...inner.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    return keys.some((k) => !val(k)) ? '' : inner;
  });
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in v ? val(k) : m));
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,])/g, '$1').trim();
}
const t = (key, vars) => fill(raw(key), vars);
const isDefault = (key) => setting(skey(find(key)), null) === null;
function save(key, value) {
  const e = find(key);
  if (!e) return;
  const v = String(value ?? '').replace(/\r\n/g, '\n');
  setSetting(skey(e), v.trim() === String(e[3]).trim() ? e[3] : v);
}
function reset(key) { const e = find(key); if (e) require('./db').q.run('DELETE FROM settings WHERE key = ?', skey(e)); }

// Exemples pour l'aperçu.
const SAMPLE = { version: '2', date_limite: '24 décembre', date_envoi: '26 novembre', date: '12 décembre', montant: '5 952,00 €', numero: 'D-2026-0412', echeance: '3 décembre',
  date_prete: '18 décembre', date_pose: '20 décembre', reference: 'ACC-412-3F9A', code: '483 912', bonjour: 'Bonjour Madame Schifano,', quoi: 'la livraison et la pose',
  projet: 'Bibliothèque courbe · chêne', prenom: 'Stéphanie', pourcent: '40', devis: 'D-2026-0412', lien: 'https://…/p/devis/…', signature: 'Carchon Les Ateliers\ncontact@carchon.com · www.carchon.com', salutation: 'Bonsoir', civilite: 'Mme', nom: 'Schifano', email: 'contact@carchon.com',
  faits: '- Étape actuelle : assemblage\n- Prêt à poser vers le 18 décembre', atelier: 'Carchon', titre: 'prise de cotes' };

module.exports = { G, CATALOG, all, find, raw, t, fill, save, reset, isDefault, SAMPLE };
