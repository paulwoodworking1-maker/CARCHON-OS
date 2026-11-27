'use strict';
// Comment s'adresser au client : « Bonjour Mme Schifano Stéphanie ».
// Prénom, nom et civilité viennent de la fiche client quand ils sont renseignés ; sinon on les
// devine depuis le nom saisi (prénom reconnu dans une liste, civilité d'après ce prénom).
// Un prénom inconnu ne reçoit pas de civilité : mieux vaut rien qu'une erreur.

const F = `agathe agnes alice aline alexandra alexia amandine amelie anais angelique anna anne annie annick anouk apolline ariane armelle audrey aurelie aurore axelle beatrice berenice bernadette brigitte capucine carole caroline catherine cecile celia celine chantal charlotte chloe christelle christiane christine claire clara clarisse claudine clemence clementine colette coline constance corinne cyrielle danielle delphine denise diane dorothee edith elena eleonore elisa elisabeth elise ella elodie eloise elsa emilie emma emmanuelle estelle eugenie eva eve evelyne fabienne fanny florence francoise frederique gabrielle genevieve geraldine ghislaine gisele helene heloise hortense ines ingrid irene isabelle jacqueline jade jeanne jessica joelle josephine josiane judith julia julie juliette justine karine laetitia laure laurence lea lea leila lena leonie liliane lina lisa lou louise lucie lucile lydie madeleine maelle manon marguerite margaux margot maria marianne marie marine marion marthe martine mathilde maud melanie melissa michele micheline mireille monique morgane muriel myriam nadia nadine nathalie nicole ninon noemie oceane odile olivia ophelie pascale patricia pauline penelope perrine rachel raphaelle rebecca regine roseline rose sabine sandra sandrine sarah segolene severine simone solange solene sophie stephanie suzanne sylvie tatiana therese valentine valerie vanessa veronique victoire victoria violette virginie yvette yvonne zoe`;
const H = `adam adrien alain alban alexandre alexis alfred alphonse andre antoine antonin armand arnaud arthur aurelien baptiste basile benjamin benoit bernard bertrand bruno cedric charles christian christophe clement corentin cyril cyrille damien daniel david denis didier dimitri dylan edouard emile emmanuel eric etienne fabien fabrice felix fernand florent florian francis francois franck frederic gabriel gael gaetan gaspard gauthier geoffroy georges gerald gerard gilbert gilles gregoire guillaume gustave guy henri herve hugo hugues jacques jean jeremie jerome joel jonathan jordan joseph jules julien kevin laurent leo leon leonard lionel loic louis luc lucas lucien ludovic marc marcel martin mathias mathieu matthieu maxime maximilien michel mickael nathan nicolas noel noah olivier pascal patrice patrick paul philippe pierre quentin raphael raymond regis remi renaud rene richard robert robin rodolphe roger romain samuel sebastien serge simon stephane sylvain theo thibault thibaut thierry thomas timothee tristan valentin victor vincent xavier yann yannick yves`;
const FEM = new Set(F.split(/\s+/)), MASC = new Set(H.split(/\s+/));
// Prénoms tapés en majuscules : on remet leurs accents (STEPHANIE -> Stéphanie).
const ACCENTS = Object.fromEntries(`Agnès Amélie Anaïs Angélique Aurélie Béatrice Bérénice Cécile Célia Céline Chloé Clémence Clémentine Dorothée Édith Éléonore Élisa Élisabeth Élise Élodie Éloïse Emmanuelle Eugénie Ève Évelyne Françoise Frédérique Geneviève Géraldine Gisèle Hélène Héloïse Inès Joëlle Joséphine Léa Léna Léonie Lucie Maëlle Mélanie Mélissa Michèle Noémie Océane Ophélie Pénélope Raphaëlle Régine Ségolène Séverine Solène Stéphanie Thérèse Valérie Véronique Zoé André Aurélien Benoît Cédric Clément Édouard Émile Éric Étienne Félix François Frédéric Gaël Gaëtan Gérald Gérard Grégoire Hervé Jérémie Jérôme Joël Léo Léon Léonard Loïc Mickaël Noël Raphaël Régis Rémi René Sébastien Stéphane Théo Timothée`.split(/\s+/).map((n) => [n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(), n]));
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const known = (tok) => { const k = plain(tok).split('-')[0]; return FEM.has(k) ? 'Mme' : MASC.has(k) ? 'M.' : ''; };

// « STEPHANIE SCHIFANO » ou « stéphanie de la tour » -> « Stéphanie », « de la Tour ».
const PARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'van', 'von', 'der', 'di', 'da', "d'"]);
function cap(word) {
  const acc = ACCENTS[String(word).toLowerCase()];
  if (acc) return acc;
  return String(word).toLowerCase().split(/([-'’ ])/).map((p, i) => (PARTICLES.has(p) && i ? p : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}
function tidy(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  // On ne touche à la casse que si tout est en majuscules ou en minuscules.
  return t === t.toUpperCase() || t === t.toLowerCase() ? t.split(' ').map((w, i) => (i && PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : cap(w))).join(' ') : t;
}

// Devine prénom / nom à partir d'un nom complet.
function split(full) {
  const words = tidy(full).replace(/^(m\.|mme|mr|monsieur|madame|mlle)\s+/i, '').split(' ').filter(Boolean);
  if (words.length < 2) return { first: '', last: words[0] || '' };
  const firstIdx = known(words[0]) ? 0 : known(words[words.length - 1]) ? words.length - 1 : 0;
  const first = words[firstIdx];
  const last = words.filter((_, i) => i !== firstIdx).join(' ');
  return { first, last };
}

// Civilité, nom, prénom : fiche client d'abord, puis devinés.
function identity(client, fallbackName = '') {
  const c = client || {};
  const guess = split(c.name || fallbackName);
  const first = tidy(c.first_name) || guess.first;
  const last = tidy(c.last_name) || guess.last;
  const civ = c.civility === 'none' ? '' : c.civility || known(first);
  return { civ, first, last, full: [last, first].filter(Boolean).join(' '), formal: [civ, last, first].filter(Boolean).join(' ') };
}

// Bonjour jusqu'à 18 h (heure de Paris), bonsoir ensuite.
function salutation(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Paris' }).formatToParts(now).find((x) => x.type === 'hour').value);
  return h >= 18 || h < 4 ? 'Bonsoir' : 'Bonjour';
}

// Formule pour les e-mails : « Bonjour Madame Schifano, ».
function emailHello(client, fallbackName = '') {
  const id = identity(client, fallbackName);
  if (id.civ && id.last) return `Bonjour ${id.civ === 'Mme' ? 'Madame' : 'Monsieur'} ${id.last},`;
  return id.full ? `Bonjour ${[id.first, id.last].filter(Boolean).join(' ')},` : 'Bonjour,';
}

module.exports = { identity, salutation, emailHello, split, tidy, known };
