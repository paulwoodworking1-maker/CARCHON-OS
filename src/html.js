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

// Durée exacte : 7,5 h · 45 min · 1 h 15.
function hoursExact(hr) {
  if (hr === null || hr === undefined || hr === '' || Number.isNaN(Number(hr))) return '—';
  const mins = Math.round(Number(hr) * 60);
  if (mins === 0) return '0 h';
  const sign = mins < 0 ? '−' : '', m = Math.abs(mins), hh = Math.floor(m / 60), mm = m % 60;
  if (!hh) return `${sign}${mm} min`;
  return `${sign}${hh} h${mm ? ` ${String(mm).padStart(2, '0')}` : ''}`;
}
const pct = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(Math.round(x * 100))} %`;

// Document imprimable avec l'en-tête de l'entreprise.
function printPage(title, body, { ref = '', date = '' } = {}) {
  const c = require('./db').company();
  return page(title, h`<div class="doc">
<div class="noprint doc-bar"><a href="javascript:history.back()" class="btn alt sm">‹ Retour</a><button type="button" class="btn sm" data-print>Imprimer / PDF</button></div>
<header class="doc-head"><div><img src="/static/logo.png" alt="${c.name}" class="doc-logo"><div class="doc-co"><b>${c.name}</b>${c.address ? h`<br>${c.address}` : ''}${c.siret ? h`<br>SIRET ${c.siret}` : ''}<br>${[c.phone, c.email, c.site].filter(Boolean).join(' · ')}</div></div>
<div class="doc-meta"><div class="doc-title">${title}</div>${ref ? h`<div>Réf. <b>${ref}</b></div>` : ''}<div>${date || ddmmyyyy(today())}</div></div></header>
${body}
<footer class="doc-foot">${c.name}${c.siret ? ` · SIRET ${c.siret}` : ''} · ${c.site}</footer></div>`, { bodyClass: 'printdoc' });
}

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

// Icônes de la colonne (trait fin, comme Cockpit).
const ICONS = {
  dash: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  of: '<path d="M14 4l6 6-3 3-6-6zM11 7L3 15v6h6l8-8"/>',
  book: '<path d="M4 5h7v15H4zM13 5h7v15h-7z"/>',
  list: '<rect x="5" y="4" width="14" height="17"/><path d="M9 4V2h6v2M9 10h6M9 14h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  load: '<path d="M3 20h18M6 16v-5M11 16V7M16 16v-3M21 16V5"/>',
  cal: '<rect x="3" y="5" width="18" height="16"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  truck: '<path d="M2 6h12v11H2zM14 10h4l4 4v3h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  box: '<path d="M3 8l9-4 9 4-9 4zM3 8v8l9 4 9-4V8M12 12v8"/>',
  cart: '<path d="M3 4h3l2 11h11l2-8H7"/><circle cx="9" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/>',
  send: '<path d="M3 12l18-8-7 18-3-7z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  gauge: '<circle cx="12" cy="13" r="8"/><path d="M12 13l4-4M12 3v2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5a3 3 0 010 6M21 20c0-2.6-1.6-4.8-4-5.6"/>',
  home: '<path d="M3 11l9-7 9 7v9H3z"/>',
  spark: '<path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z"/>',
  ipad: '<rect x="5" y="2" width="14" height="20"/><path d="M11 18h2"/>',
};
const icon = (k, size = 18) => raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${ICONS[k] || ''}</svg>`);

// Colonne de navigation : [groupe, [[clé, libellé, lien, icône, chemins qui l'activent]]]
const SIDE = [
  ['', [['dash', 'Tableau de bord', '/', 'dash', ['/']], ['decider', 'À décider', '/decider', 'check', ['/decider']], ['assistant', 'Assistant', '/assistant', 'spark', ['/assistant']]]],
  ['Fabriquer', [['of', 'Fabrication', '/projets', 'of', ['/projets', '/carnets']], ['catalogue', 'Catalogue', '/catalogue', 'book', ['/catalogue']], ['portails', 'Portails clients', '/portails', 'globe', ['/portails']]]],
  ['Planifier', [['charge', 'Charge', '/charge', 'load', ['/charge']], ['planning', 'Planning', '/planning', 'cal', ['/planning']], ['poses', 'Livraisons et poses', '/poses', 'truck', ['/poses']]]],
  ['Approvisionner', [['stock', 'Matière et stock', '/stock', 'box', ['/stock', '/bois', '/pieces']], ['achats', 'Achats', '/achats', 'cart', ['/achats', '/commandes', '/fournisseurs']]]],
  ['Livrer et garantir', [['exp', 'Expéditions', '/expeditions', 'send', ['/expeditions']], ['sav', 'Qualité et SAV', '/sav', 'shield', ['/sav', '/unites']]]],
  ['Piloter', [['pilot', 'Heures et coûts', '/pilotage', 'gauge', ['/pilotage']], ['machines', 'Machines', '/machines', 'gear', ['/machines']], ['auto', 'Automatisations', '/automatisations', 'bolt', ['/automatisations']], ['equipe', 'Équipe et réglages', '/equipe', 'users', ['/equipe', '/entreprise']]]],
];
const TABHOME = { aujourdhui: '/', projets: '/projets', planning: '/planning', stock: '/stock', achats: '/achats', pilotage: '/pilotage' };
const SUBNAV = {
  projets: [['/projets', 'En cours'], ['/carnets', 'Carnets de fabrication'], ['/projets?vue=termines', 'Terminés']],
  achats: [['/achats', 'À commander'], ['/commandes', 'Commandes en cours'], ['/fournisseurs', 'Fournisseurs']],
  stock: [['/stock', 'Consommables'], ['/bois', 'Bois noble'], ['/pieces', 'Pièces finies']],
  pilotage: [['/pilotage', 'Heures et chiffrage'], ['/pilotage/couts', 'Coût par OF']],
  reglages: [['/equipe', 'Équipe'], ['/entreprise', 'Entreprise']],
  sav: [['/sav', 'Demandes SAV'], ['/unites', 'Registre des pièces']],
};

// Compteurs de la colonne (calculés à chaque page, requêtes légères).
function sideCounts() {
  try {
    const { q } = require('./db');
    const n = (sql) => q.get(sql).n;
    return {
      decider: require('./logic').toDecide().length,
      of: n("SELECT COUNT(*) n FROM projects WHERE status = 'en_cours'"),
      catalogue: n('SELECT COUNT(*) n FROM models WHERE active = 1'),
      achats: n("SELECT COUNT(*) n FROM needs WHERE status = 'todo'"),
      exp: n("SELECT COUNT(*) n FROM shipments WHERE shipped_at IS NULL"),
      sav: n("SELECT COUNT(*) n FROM sav WHERE status != 'close'"),
      machines: require('./machines').dueCount(),
    };
  } catch (e) { return {}; }
}

function flashBox(flash) {
  if (!flash) return '';
  return h`<div class="flash ${flash.kind || 'ok'}" role="status">${flash.html ? raw(flash.html) : flash.text}</div>`;
}

// Mise en page « patron » (ordinateur) : colonne à gauche façon Cockpit.
function layout({ title, tab, sub, body, flash, counts = {}, heading }) {
  const here = sub || TABHOME[tab] || '';
  const path = here.split('?')[0].split('#')[0];
  const c = sideCounts();
  const isOn = (paths) => paths.some((p) => (p === '/' ? path === '/' : path === p || path.startsWith(p + '/')));
  const subsKey = Object.keys(SUBNAV).find((k) => SUBNAV[k].some(([href]) => href.split('?')[0] === path)) || '';
  const subs = SUBNAV[subsKey] || (tab && SUBNAV[tab]);
  const co = require('./db').company();
  return page(title, h`
<div class="shell">
<nav class="side" aria-label="Navigation principale">
  <a href="/" class="side-h"><span class="side-name">Carchon <span>OS</span></span><span class="side-sub">${co.name}</span></a>
  ${SIDE.map(([g, items]) => h`<div class="side-g">${g ? h`<div class="side-gh">${g}</div>` : ''}
    ${items.map(([k, label, href, ic, paths]) => h`<a class="side-a${isOn(paths) ? ' on' : ''}" href="${href}">${icon(ic)}<span>${label}</span>${c[k] ? h`<span class="side-n">${c[k]}</span>` : ''}</a>`)}</div>`)}
  <div class="side-f">
    <a class="side-a" href="/atelier">${icon('ipad')}<span>Mode atelier (iPad)</span></a>
    <form method="post" action="/deconnexion"><button type="submit" class="side-a linkish">${icon('home')}<span>Se déconnecter</span></button></form>
    <div class="side-cta"><a class="btn sm" href="/catalogue">+ Lancer un OF</a></div>
  </div>
</nav>
<div class="main">
<header class="topbar">
  <h1 class="topbar-t">${heading || title}</h1>
  <div class="tools">
    <form action="/recherche" method="get" role="search" class="search"><label class="sr" for="qsearch">Rechercher</label><input id="qsearch" name="q" placeholder="Rechercher un OF, une pièce, un lot" accesskey="k"></form>
    <details class="menu"><summary class="btn sm">+ Créer</summary><div class="menu-list right-al">
      <a href="/catalogue">Lancer un OF depuis le catalogue</a><a href="/projets/nouveau">OF sur-mesure ou d'atelier</a><a href="/portails?nouveau=1">Envoyer un devis</a><a href="/sav?nouveau=1">Demande SAV</a><a href="/achats#noter">Noter à recommander</a>
    </div></details>
  </div>
</header>
${subs ? h`<nav class="sub" aria-label="Sous-menu">${subs.map(([href, label]) => h`<a href="${href}"${href === here ? raw(' class="on"') : ''}>${label}${counts[href] ? ` · ${counts[href]}` : ''}</a>`)}</nav>` : ''}
<main class="wrap">${flashBox(flash)}${body}</main>
</div></div>`);
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
  icon, h, raw, esc, pill, avatar, hidden, postBtn, options, layout, page, flashBox,
  hoursExact, pct, printPage,
  parseDate, iso, today, addDays, ddmm, ddmmyyyy, longDate, dayMonth, hhmm, rel, hoursLabel, JOURS_C, MOIS_C, MOIS,
};
