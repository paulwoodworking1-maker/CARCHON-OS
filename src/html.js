'use strict';
// Rendu HTML côté serveur : gabarit `h` qui échappe tout sauf ce qui est marqué `raw`.

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Safe(String(s ?? ''));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(val).join('');
  return esc(v);
}
function h(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += val(v) + strings[i + 1]; });
  return new Safe(out);
}

// --- dates (stockées en AAAA-MM-JJ ou datetime SQLite, UTC) ---
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MOIS_C = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOURS_C = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(str + 'T12:00:00');
  return new Date(str.replace(' ', 'T') + (str.includes('Z') || str.includes('+') ? '' : 'Z'));
}
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); }
function ddmm(s) { const d = parseDate(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : ''; }
function ddmmyyyy(s) { const d = parseDate(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : ''; }
function longDate(s) { const d = parseDate(s); return d ? `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}` : ''; }
function dayMonth(s) { const d = parseDate(s); return d ? `${d.getDate()} ${MOIS[d.getMonth()]}` : ''; }
function hhmm(s) { const d = parseDate(s); return d ? `${d.getHours()} h ${pad(d.getMinutes())}` : ''; }
function rel(s) {
  const d = parseDate(s); if (!d) return '';
  const days = Math.round((parseDate(today()) - parseDate(iso(d))) / 86400000);
  if (days === 0) return `aujourd’hui ${hhmm(s)}`;
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} jours`;
  return `le ${ddmm(s)}`;
}
function hoursLabel(hr) {
  if (!hr) return '—';
  const days = hr / 8;
  if (days < 1) return hr === 4 ? '½ journée' : `${String(hr).replace('.', ',')} h`;
  const whole = Math.floor(days), half = days - whole >= 0.5;
  if (whole === 1 && !half) return '1 journée';
  return `${whole} jour${whole > 1 ? 's' : ''}${half ? ' ½' : ''}`;
}

// --- composants ---
const pill = (cls, text) => h`<span class="pill ${cls}">${text}</span>`;
const avatar = (p, size) => p ? h`<span class="av" style="background:${p.color}${size ? `;width:${size}px;height:${size}px;font-size:${Math.round(size / 3)}px` : ''}" title="${p.name}" aria-label="${p.name}">${p.ini}</span>` : '';
const hidden = (fields) => Object.entries(fields).map(([k, v]) => h`<input type="hidden" name="${k}" value="${v}">`);
// Petit formulaire POST avec un seul bouton.
const postBtn = (action, label, cls = 'btn alt sm', fields = {}, confirm = '') =>
  h`<form method="post" action="${action}" class="inline"${confirm ? raw(` data-confirm="${esc(confirm)}"`) : ''}>${hidden(fields)}<button type="submit" class="${cls}">${label}</button></form>`;
const options = (list, selected) => list.map((o) => {
  const [v, l] = Array.isArray(o) ? o : [o, o];
  return h`<option value="${v}"${String(v) === String(selected ?? '') ? raw(' selected') : ''}>${l}</option>`;
});

const NAV = [
  ['aujourdhui', '/', "Aujourd'hui"], ['projets', '/projets', 'Projets'], ['planning', '/planning', 'Planning'],
  ['stock', '/stock', 'Stock'], ['achats', '/achats', 'Achats'], ['pilotage', '/pilotage', 'Pilotage'],
];
const SUBNAV = {
  projets: [['/projets', 'Projets en cours'], ['/carnets', 'Carnets de fabrication'], ['/portails', 'Portails clients'], ['/projets?vue=termines', 'Terminés']],
  planning: [['/planning', 'Par personne'], ['/poses', 'Livraisons et poses']],
  achats: [['/achats', 'À commander'], ['/commandes', 'Commandes en cours'], ['/fournisseurs', 'Fournisseurs']],
  pilotage: [['/pilotage', 'Heures et chiffrage'], ['/equipe', 'Réglages équipe']],
};

function flashBox(flash) {
  if (!flash) return '';
  return h`<div class="flash ${flash.kind || 'ok'}" role="status">${flash.html ? raw(flash.html) : flash.text}</div>`;
}

// Mise en page « patron » (ordinateur).
function layout({ title, tab, sub, body, flash, counts = {} }) {
  const subs = SUBNAV[tab];
  return page(title, h`
<nav class="top" aria-label="Navigation principale">
  <a href="/" class="brand" aria-label="Carchon OS, accueil"><img src="/static/logo.png" alt="Carchon Les Ateliers"><span>OS</span></a>
  ${NAV.map(([k, href, label]) => h`<a class="tab${k === tab ? ' on' : ''}" href="${href}">${label}</a>`)}
  <div class="right">
    <div class="seg"><a class="on" href="/">Patron</a><a href="/atelier">Atelier</a></div>
    <form action="/recherche" method="get" class="search" role="search"><label class="sr" for="qsearch">Rechercher</label><input id="qsearch" name="q" placeholder="Rechercher" accesskey="k"></form>
    <details class="menu"><summary class="btn sm">+ Créer</summary><div class="menu-list">
      <a href="/portails?nouveau=1">Envoyer un devis</a><a href="/projets/nouveau">Projet d'atelier</a><a href="/achats#noter">Noter à recommander</a><a href="/planning#ajouter">Barre de planning</a>
    </div></details>
    <details class="menu"><summary class="av" style="background:#1C1917" aria-label="Compte patron">PA</summary><div class="menu-list right-al">
      <a href="/equipe">Réglages équipe</a><form method="post" action="/deconnexion"><button type="submit" class="linkbtn">Se déconnecter</button></form>
    </div></details>
  </div>
</nav>
${subs ? h`<nav class="sub" aria-label="Sous-menu">${subs.map(([href, label]) => h`<a href="${href}"${href === sub ? raw(' class="on"') : ''}>${label}${counts[href] ? ` · ${counts[href]}` : ''}</a>`)}</nav>` : ''}
<main class="wrap">${flashBox(flash)}${body}</main>`);
}

function page(title, body, { bodyClass = '', head = '' } = {}) {
  return h`<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Carchon OS</title>
<link rel="icon" href="/static/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">${head}
</head><body class="${bodyClass}">${body}<script src="/static/app.js" defer></script></body></html>`.toString();
}

module.exports = {
  h, raw, esc, pill, avatar, hidden, postBtn, options, layout, page, flashBox,
  parseDate, iso, today, addDays, ddmm, ddmmyyyy, longDate, dayMonth, hhmm, rel, hoursLabel, JOURS_C, MOIS_C, MOIS,
};
