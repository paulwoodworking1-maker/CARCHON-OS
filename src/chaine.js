'use strict';
// Chaîne de production d'un projet : une seule saisie (les cotes et les choix du client), tout le reste
// en découle et se recalcule : nomenclature, débit, calepinage, quincaillerie, heures par poste,
// prix de revient, devis, commandes et planning.
const { db, q, setting, setSetting } = require('./db');
const { addDays, parseDate, iso, today } = require('./html');

db.exec(`
CREATE TABLE IF NOT EXISTS chains (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, params TEXT NOT NULL DEFAULT '{}', done TEXT NOT NULL DEFAULT '{}',
  indice TEXT DEFAULT '', frozen_at TEXT, consumed_at TEXT, steps_at TEXT, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS panel_refs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'Panneau', thickness REAL NOT NULL DEFAULT 19,
  length INTEGER NOT NULL DEFAULT 2500, width INTEGER NOT NULL DEFAULT 1220, stock_m2 REAL NOT NULL DEFAULT 0, price_m2 REAL NOT NULL DEFAULT 0,
  min_m2 REAL NOT NULL DEFAULT 0, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, active INTEGER NOT NULL DEFAULT 1, ord INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS offcuts (
  id INTEGER PRIMARY KEY, ref_id INTEGER NOT NULL REFERENCES panel_refs(id) ON DELETE CASCADE, length INTEGER NOT NULL, width INTEGER NOT NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
  used_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS panel_moves (
  id INTEGER PRIMARY KEY, ref_id INTEGER NOT NULL REFERENCES panel_refs(id) ON DELETE CASCADE, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  m2 REAL NOT NULL, kind TEXT NOT NULL DEFAULT 'correction', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wood_orders (
  id INTEGER PRIMARY KEY, supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'brouillon', lines TEXT NOT NULL DEFAULT '[]', note TEXT DEFAULT '', expected_at TEXT,
  created_at TEXT DEFAULT (datetime('now')), sent_at TEXT, received_at TEXT
);
`);
for (const [t, c, d] of [['chains', 'ai', 'TEXT'], ['chains', 'brief', "TEXT DEFAULT ''"], ['panel_refs', 'price_m3', 'REAL NOT NULL DEFAULT 0'], ['chains', 'ai_status', 'TEXT'], ['chains', 'ai_error', 'TEXT'], ['chains', 'ai_at', 'TEXT']]) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
}
// Références de départ (stock à 0, à compléter dans Matière et stock › Panneaux et bois).
if (setting('panel_refs_seeded') !== '1') {
  if (!q.get('SELECT id FROM panel_refs LIMIT 1')) {
    [['MDF plaqué chêne', 19, 2500, 1220, 38], ['Contreplaqué plaqué chêne', 5, 2500, 1220, 14], ['Mélaminé blanc', 19, 2800, 2070, 9],
      ['MDF hydrofuge', 19, 2800, 2070, 11], ['Chant chêne encollé 23 mm', 0.6, 0, 0, 0]]
      .forEach(([n, t, l, w, p], i) => q.run('INSERT INTO panel_refs (name, kind, thickness, length, width, price_m2, ord) VALUES (?, ?, ?, ?, ?, ?, ?)', n, l ? 'Panneau' : 'Chant', t, l, w, p, i));
  }
  setSetting('panel_refs_seeded', '1');
}

const FINITIONS = ['Vernis mat incolore', 'Vernis satiné incolore', 'Huile-cire', 'Laque (teinte au choix)', 'Aucune (mélaminé ou brut)'];
const MURS = ['Plaque de plâtre', 'Béton', 'Brique creuse', 'Bois / ossature'];
const CHEVILLES = { 'Plaque de plâtre': ['Chevilles métalliques à expansion 6 × 52', 0.55], 'Béton': ['Chevilles nylon 8 mm + vis 5 × 60', 0.25],
  'Brique creuse': ['Chevilles pour brique creuse 8 mm', 0.45], 'Bois / ossature': ['Vis à bois 5 × 60', 0.12] };

// Barème de l'atelier (à recaler sur les projets passés).
const BAREME_DEF = {
  taux: 45, cnc_machine: 15, chant_m: 1.2, finition_m2: 5.5, km: 0.6, kerf: 4, marge: 10,
  prep_h: 2.9, cnc_h_piece: 0.12, chant_h_m: 0.07, ponc_h_m2: 0.15, fin_h_m2_couche: 0.105,
  ass_h_caisson: 2.5, ass_h_etagere: 0.17, ctrl_h_colis: 0.2, pose_h_caisson: 1.5, pose_h_etage: 0.5, jour_h: 7,
};
const BAREME_LABELS = {
  taux: 'Taux horaire atelier (€ / h)', cnc_machine: 'Machine CNC (€ / h en plus)', chant_m: 'Chant (€ / m)', finition_m2: 'Produits de finition (€ / m²)',
  km: 'Déplacement (€ / km)', kerf: 'Trait de scie (mm)', marge: 'Marge de rive des panneaux (mm)', prep_h: 'Préparation et plans (h)', cnc_h_piece: 'CNC (h / pièce)',
  chant_h_m: 'Placage des chants (h / m)', ponc_h_m2: 'Ponçage (h / m²)', fin_h_m2_couche: 'Finition (h / m² / couche)', ass_h_caisson: 'Assemblage (h / caisson)',
  ass_h_etagere: 'Assemblage (h / étagère)', ctrl_h_colis: 'Contrôle et emballage (h / colis)', pose_h_caisson: 'Pose (h / caisson / personne)',
  pose_h_etage: 'Pose (h / étage sans ascenseur)', jour_h: 'Heures par jour d’atelier',
};
function bareme() {
  let saved = {};
  try { saved = JSON.parse(setting('chaine_bareme') || '{}'); } catch {}
  const b = { ...BAREME_DEF, ...saved };
  if (!saved.taux && Number(String(setting('hourly_rate', '')).replace(',', '.'))) b.taux = Number(String(setting('hourly_rate')).replace(',', '.'));
  return b;
}

const refs = () => q.all("SELECT * FROM panel_refs WHERE active = 1 ORDER BY kind, ord, name");
const ref = (id) => (id ? q.get('SELECT * FROM panel_refs WHERE id = ?', id) : null);
const firstRef = (thick) => q.get("SELECT id FROM panel_refs WHERE active = 1 AND kind = 'Panneau' ORDER BY abs(thickness - ?), ord LIMIT 1", thick)?.id || null;

function defaults() {
  return { width: 800, height: 2200, depth: 350, caissons: 3, shelves: 5, ref_id: firstRef(19), back_id: firstRef(5), finition: FINITIONS[0], couches: 3,
    mur: MURS[0], km: 28, etage: 2, coef: 1.6, accord: addDays(today(), 4), start: addDays(today(), 4) };
}
const N = (v, d) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : d; };
function cleanParams(b, base = defaults()) {
  const o = { ...base };
  for (const k of ['width', 'height', 'depth', 'caissons', 'shelves', 'couches', 'km', 'etage', 'coef', 'ref_id', 'back_id']) if (b[k] !== undefined) o[k] = N(b[k], o[k]);
  for (const k of ['finition', 'mur', 'accord', 'start']) if (b[k] !== undefined) o[k] = String(b[k]);
  o.caissons = Math.max(1, Math.min(20, Math.round(o.caissons)));
  o.shelves = Math.max(0, Math.min(20, Math.round(o.shelves)));
  o.couches = Math.max(0, Math.min(6, Math.round(o.couches)));
  o.coef = Math.max(1, Math.min(4, o.coef));
  if (!FINITIONS.includes(o.finition)) o.finition = FINITIONS[0];
  if (!MURS.includes(o.mur)) o.mur = MURS[0];
  return o;
}

function get(projectId) {
  const row = q.get('SELECT * FROM chains WHERE project_id = ?', projectId);
  if (!row) return null;
  let params = {}, done = {};
  try { params = JSON.parse(row.params); } catch {}
  try { done = JSON.parse(row.done); } catch {}
  let study = null;
  try { study = row.ai ? JSON.parse(row.ai) : null; } catch {}
  return { ...row, params: cleanParams(params, defaults()), done, study };
}
// Étude par l'IA, en tâche de fond (une à quelques minutes) : la page se recharge toute seule.
function startStudy(project, { brief, instruction }) {
  const ai = require('./ai');
  const c = get(project.id) || (save(project.id, defaults()), get(project.id));
  if (c.ai_status === 'running') return false;
  const previous = instruction && c.study ? c.study : null;
  q.run("UPDATE chains SET ai_status = 'running', ai_error = NULL, brief = ? WHERE project_id = ?", brief, project.id);
  const auto = require('./automations');
  const { PHASES, GESTES } = require('./db');
  ai.chainStudy({ project, brief, previous, instruction, refs: refs(), stock: q.all('SELECT name FROM stock_items ORDER BY category, ord').map((x) => x.name),
    bareme: bareme(), averages: auto.averages ? auto.averages() : {}, params: c.params, phases: PHASES, gestes: GESTES })
    .then((study) => {
      q.run("UPDATE chains SET ai = ?, ai_status = 'done', ai_at = datetime('now'), updated_at = datetime('now') WHERE project_id = ?", JSON.stringify(study), project.id);
      require('./db').logActivity(project.id, null, instruction ? `Étude ajustée par l’IA : ${instruction.slice(0, 120)}` : 'Étude de fabrication faite par l’IA', 'Assistant');
    })
    .catch((e) => { console.error(e); q.run("UPDATE chains SET ai_status = 'error', ai_error = ? WHERE project_id = ?", e.message || String(e), project.id); });
  return true;
}
function saveStudy(projectId, study, brief) {
  if (!q.get('SELECT project_id FROM chains WHERE project_id = ?', projectId)) save(projectId, defaults());
  q.run("UPDATE chains SET ai = ?, brief = ?, updated_at = datetime('now') WHERE project_id = ?", study ? JSON.stringify(study) : null, brief ?? '', projectId);
}
function save(projectId, params) {
  q.run("INSERT INTO chains (project_id, params) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET params = excluded.params, updated_at = datetime('now')", projectId, JSON.stringify(params));
}

// --- Nomenclature ---
function nomenclature(p) {
  const r = ref(p.ref_id) || { thickness: 19, name: 'Panneau', length: 2500, width: 1220 };
  const back = ref(p.back_id) || { thickness: 5, name: 'Fond', length: 2500, width: 1220 };
  const e = r.thickness, n = p.caissons, W = p.width, H = p.height, D = p.depth;
  const inner = W - 2 * e;
  const L = [
    { rep: 'C', name: 'Côté', len: H, wid: D, ep: e, qty: 2 * n, edges: 1, cnc: `${Math.max(0, Math.round((H - 500) / 100)) * 2 * n} trous Ø5, ${4 * n} tourillons Ø8, rainure de fond`, ref: r, refId: p.ref_id },
    { rep: 'D', name: 'Dessus / dessous', len: inner, wid: D, ep: e, qty: 2 * n, edges: 1, cnc: 'rainure de fond', ref: r, refId: p.ref_id },
    { rep: 'E', name: 'Étagère', len: inner - 2, wid: D - 25, ep: e, qty: p.shelves * n, edges: 1, cnc: 'découpe', ref: r, refId: p.ref_id },
    { rep: 'PL', name: 'Plinthe', len: inner, wid: 80, ep: e, qty: n, edges: 0, cnc: 'découpe', ref: r, refId: p.ref_id },
    { rep: 'F', name: 'Fond', len: H - 105, wid: W - 25, ep: back.thickness, qty: n, edges: 0, cnc: 'découpe', ref: back, refId: p.back_id },
  ].filter((x) => x.qty > 0 && x.len > 0 && x.wid > 0);
  L.forEach((x) => { x.label = x.qty > 1 ? `${x.rep}1–${x.qty}` : `${x.rep}1`; x.edgesLabel = x.edges ? '1 chant avant' : '—'; x.edgeM = x.edges ? x.len / 1000 : 0; x.vue = x.rep !== 'F'; x.ensemble = 'Caissons'; });
  return L;
}

// Nomenclature tirée de l'étude de l'IA : n'importe quel ouvrage (cuisine, dressing, bureau, massif… ou tout à la fois).
function studyLines(study) {
  const used = new Set();
  return (study?.pieces || []).filter((x) => x.quantite > 0 && x.longueur > 0 && x.largeur > 0).map((x) => {
    let rep = String(x.rep || 'P').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+$/, '').slice(0, 4) || 'P';
    while (used.has(rep)) rep += 'X';
    used.add(rep);
    const r0 = ref(x.matiere_id);
    const r = r0 || { name: x.matiere_libre || 'Matière à définir', thickness: x.epaisseur, length: 2500, width: 1220, price_m2: 0, price_m3: 0, kind: /massif/i.test(x.matiere_libre || '') ? 'Bois massif' : 'Panneau' };
    const qty = Math.round(x.quantite);
    return { rep, name: x.designation, len: Math.round(x.longueur), wid: Math.round(x.largeur), ep: x.epaisseur || r.thickness, qty, ensemble: x.ensemble || '',
      edgeM: Math.max(0, x.chants_ml_par_piece || 0), edgesLabel: x.chants_ml_par_piece ? `${String(Math.round(x.chants_ml_par_piece * 100) / 100).replace('.', ',')} m` : '—',
      cnc: x.usinage || '', vue: !!x.face_vue, ref: r, refId: r0 ? r0.id : null, massif: r.kind === 'Bois massif', missing: !r0,
      label: qty > 1 ? `${rep}1–${qty}` : `${rep}1` };
  });
}
const linesOf = (c) => (c?.study ? studyLines(c.study) : nomenclature(c.params));

// --- Calepinage : bandes guillotine, fil dans la longueur, sans rotation des pièces plaquées ---
function calepinage(lines, b = bareme()) {
  const byRef = {};
  for (const l of lines) {
    if (l.massif) continue;
    const k = l.refId || `x:${l.ref.name}:${l.ep}`;
    byRef[k] = byRef[k] || { ref: l.ref, refId: l.refId, pieces: [] };
    for (let i = 1; i <= l.qty; i++) byRef[k].pieces.push({ rep: `${l.rep}${i}`, name: l.name, len: l.len, wid: l.wid });
  }
  const out = [];
  for (const g of Object.values(byRef)) {
    const PL = (g.ref.length || 2500) - 2 * b.marge, PW = (g.ref.width || 1220) - 2 * b.marge;
    const panels = [];
    const tooBig = [];
    g.pieces.sort((a, c) => c.wid - a.wid || c.len - a.len);
    for (const pc of g.pieces) {
      if (pc.len > PL || pc.wid > PW) { tooBig.push(pc); continue; }
      let placed = false;
      for (const pn of panels) {
        for (const st of pn.strips) if (pc.wid <= st.h && st.used + pc.len <= PL) { st.items.push({ ...pc, x: st.used, y: st.y }); st.used += pc.len + b.kerf; placed = true; break; }
        if (placed) break;
        if (pn.usedH + pc.wid <= PW) { pn.strips.push({ y: pn.usedH, h: pc.wid, used: pc.len + b.kerf, items: [{ ...pc, x: 0, y: pn.usedH }] }); pn.usedH += pc.wid + b.kerf; placed = true; break; }
      }
      if (!placed) panels.push({ usedH: pc.wid + b.kerf, strips: [{ y: 0, h: pc.wid, used: pc.len + b.kerf, items: [{ ...pc, x: 0, y: 0 }] }] });
    }
    const area = (g.ref.length || 2500) * (g.ref.width || 1220);
    const pieceArea = g.pieces.filter((x) => !tooBig.includes(x)).reduce((a, x) => a + x.len * x.wid, 0);
    // Chutes réutilisables : bout de bande et bande restante en bout de panneau.
    panels.forEach((pn) => {
      pn.offcuts = [];
      for (const st of pn.strips) if (PL - st.used >= 300 && st.h >= 100) pn.offcuts.push({ len: Math.round(PL - st.used), wid: st.h });
      if (PW - pn.usedH >= 100) pn.offcuts.push({ len: PL, wid: Math.round(PW - pn.usedH) });
      pn.items = pn.strips.flatMap((s) => s.items);
    });
    out.push({ ref: g.ref, refId: g.refId, panels, tooBig, m2: (panels.length * area) / 1e6, usage: panels.length ? pieceArea / (panels.length * area) : 0, PL, PW });
  }
  return out;
}

// --- Quincaillerie et finitions ---
function hardware(p) {
  const n = p.caissons, et = p.shelves * n, j = Math.max(0, n - 1);
  const [chev, chevPU] = CHEVILLES[p.mur] || CHEVILLES['Plaque de plâtre'];
  return [
    ['Taquets laiton Ø5', 4 * et, 0.38], ['Tourillons hêtre Ø8 × 35', 12 * n, 0.04], ['Ferrures Minifix 15 (démontage pour livraison)', 4 * n, 1.15],
    ['Connecteurs de jonction de caissons', 4 * j, 0.85], ['Équerres de fixation murale réglables', 2 * n, 3.4], [chev, 4 * n, chevPU],
    ['Cales de réglage plastique (sachet)', Math.ceil(n / 2), 4.5], ['Colle vinylique D3 (flacon 750 g)', 1, 11],
  ].filter((x) => x[1] > 0).map(([name, qty, pu]) => ({ name, qty, pu, total: qty * pu }));
}
function finitions(p, m2) {
  if (p.finition.startsWith('Aucune') || !p.couches) return [];
  const litres = (m2 * p.couches) / 10;
  const bidons = Math.max(1, Math.ceil(litres / 2.5));
  const produit = p.finition.startsWith('Huile') ? ['Huile-cire', 'bidon 2,5 L', 42] : p.finition.startsWith('Laque') ? ['Laque', 'bidon 2,5 L', 48] : [p.finition.replace(' incolore', ' incolore'), 'bidon 2,5 L', 34.49];
  return [{ name: produit[0], qty: bidons, unit: produit[1], pu: produit[2], total: bidons * produit[2] }, { name: 'Abrasifs grain 240 (boîte)', qty: 1, unit: 'boîte', pu: 18, total: 18 }];
}

// --- Tout le calcul ---
const round10 = (x) => Math.round(x / 10) * 10;
const GROUPES = ['Conception', 'Fabrication', 'Finition', 'Pose'];
const WHO = { Conception: 'Bureau', Débit: 'Établi', Assemblage: 'Établi', Finition: 'Finition', Contrôle: 'Établi', Livraison: 'Pose', Bois: 'Établi', Accord: 'Bureau', Réception: 'Pose' };

// Mode sans IA : caissons calculés par le barème.
function caissonModel(p, lines, b) {
  const pieces = lines.reduce((a, l) => a + l.qty, 0);
  const edgeM = lines.reduce((a, l) => a + l.edgeM * l.qty, 0);
  const faces = lines.filter((l) => l.vue).reduce((a, l) => a + (l.len * l.wid * l.qty * (l.rep === 'E' ? 2 : 1)) / 1e6, 0);
  const noFin = p.finition.startsWith('Aucune') || !p.couches;
  const colis = p.caissons + Math.ceil((p.shelves * p.caissons) / 8) + 1;
  const heaviest = Math.round(((2 * p.height * p.depth + 2 * p.width * p.depth) / 1e6) * ((ref(p.ref_id)?.thickness || 19) / 1000) * 750 + 8);
  const r0 = ref(p.ref_id);
  return {
    title: `${p.caissons} caisson${p.caissons > 1 ? 's' : ''}`, dims: `${p.width * p.caissons} × ${p.height} × ${p.depth} mm`, finition: p.finition, couches: p.couches, faces,
    hw: hardware(p), delai: 3,
    postes: [
      { name: 'Préparation et plans', qty: 'relevé, plans, fichiers', h: b.prep_h, phase: 'Conception', geste: 'Autre', groupe: 'Conception' },
      { name: 'Usinage CNC', qty: `${pieces} pièces`, h: pieces * b.cnc_h_piece, phase: 'Débit', geste: 'Débit, corroyage', machine: true, groupe: 'Fabrication', who: 'CNC' },
      { name: 'Placage des chants', qty: `${Math.round(edgeM)} m`, h: edgeM * b.chant_h_m, phase: 'Débit', geste: 'Débit, corroyage', groupe: 'Fabrication' },
      { name: 'Ponçage', qty: `${faces.toFixed(1).replace('.', ',')} m² de faces vues`, h: noFin ? 0 : faces * b.ponc_h_m2, phase: 'Finition', geste: 'Ponçage', groupe: 'Finition' },
      { name: 'Finition', qty: noFin ? 'sans objet' : `${faces.toFixed(1).replace('.', ',')} m² × ${p.couches} couches`, h: noFin ? 0 : faces * p.couches * b.fin_h_m2_couche, phase: 'Finition', geste: p.finition.startsWith('Huile') ? 'Huile-cire' : 'Vernis', groupe: 'Finition', couches: p.couches, sechage: 0.5 },
      { name: 'Assemblage', qty: `${p.caissons} caissons · ${p.shelves * p.caissons} étagères`, h: p.caissons * b.ass_h_caisson + p.shelves * p.caissons * b.ass_h_etagere, phase: 'Assemblage', geste: 'Assemblage', groupe: 'Fabrication' },
      { name: 'Contrôle et emballage', qty: `${colis} colis`, h: colis * b.ctrl_h_colis, phase: 'Contrôle', geste: 'Contrôle', groupe: 'Fabrication' },
      { name: 'Livraison et pose', qty: `2 pers. · ${heaviest} kg au plus lourd · ${Math.round(p.km * 2)} km`, h: 2 * (p.caissons * b.pose_h_caisson + p.etage * b.pose_h_etage + (p.km * 2) / 60), phase: 'Livraison', geste: 'Pose', groupe: 'Pose', personnes: 2 },
    ],
    texts: {
      Conception: ['Conception et plans', 'Relevé de cotes, plans cotés et rendu, une version de modification comprise.'],
      Fabrication: [`Fabrication de ${p.caissons} caisson${p.caissons > 1 ? 's' : ''} ${p.width} × ${p.height} × ${p.depth} mm`, `${r0?.name || 'Panneau'} ${r0?.thickness || ''} mm, chants plaqués, fond rainuré, ${p.shelves * p.caissons} étagères réglables. Usinage numérique, assemblage tourillonné, démontable pour la livraison.`],
      Finition: ['Finition', `${p.finition}, ${p.couches} couches, égrenage 240.`],
      Pose: ['Livraison et pose', `Livraison, montage, fixation murale adaptée (${p.mur.toLowerCase()}), réglage d’aplomb.`],
    },
  };
}
// Mode IA : l'étude dit tout (postes, quincaillerie, textes du devis).
function studyModel(study, lines) {
  const faces = lines.filter((l) => l.vue).reduce((a, l) => a + (l.len * l.wid * l.qty) / 1e6, 0);
  const texts = {};
  for (const d of study.devis || []) if (GROUPES.includes(d.groupe) && !texts[d.groupe]) texts[d.groupe] = [d.titre, d.descriptif];
  return {
    title: study.titre, dims: (study.ensembles || []).map((e) => `${e.nom} ${e.largeur} × ${e.hauteur} × ${e.profondeur}`).join(' · '),
    finition: study.finition || 'Aucune', couches: Math.max(0, Math.round(study.couches || 0)), faces, delai: study.delai_fournisseur_jours || 3,
    hw: (study.quincaillerie || []).filter((x) => x.quantite > 0).map((x) => ({ name: x.designation, qty: Math.round(x.quantite * 100) / 100, pu: x.prix_unitaire || 0, total: x.quantite * (x.prix_unitaire || 0), unit: x.unite || '' })),
    postes: (study.postes || []).filter((x) => x.heures > 0).map((x) => ({ name: x.nom, qty: x.detail || '', h: x.heures, phase: x.etape_frise, geste: x.geste, groupe: GROUPES.includes(x.groupe) ? x.groupe : 'Fabrication',
      machine: !!x.machine, sechage: x.sechage_jours || 0, personnes: Math.max(1, x.personnes || 1), couches: 1 })),
    texts,
  };
}

function compute(projectId, params, study) {
  const b = bareme();
  const p = params;
  const lines = study ? studyLines(study) : nomenclature(p);
  const M = study ? studyModel(study, lines) : caissonModel(p, lines, b);
  const cal = calepinage(lines, b);
  const massif = lines.filter((l) => l.massif).map((l) => { const vol = (l.len * l.wid * l.ep * l.qty) / 1e9; return { ...l, vol, volBrut: vol * 1.35, ml: (l.len * l.qty) / 1000 }; });
  const main = cal.find((c) => c.refId === p.ref_id) || cal[0] || { panels: [], m2: 0, ref: {} };
  const pieces = lines.reduce((a, l) => a + l.qty, 0);
  const edgeM = lines.reduce((a, l) => a + l.edgeM * l.qty, 0);
  const noFin = !M.couches || /^aucune/i.test(M.finition);
  const fin = noFin ? [] : finitions({ finition: M.finition, couches: M.couches }, M.faces);
  const postes = M.postes.map((x, i) => ({ ...x, k: `p${i}`, who: x.who || WHO[x.phase] || 'Établi' }));
  const hours = postes.reduce((a, x) => a + x.h, 0);
  const panelCost = (c) => c.panels.length * ((c.ref.length || 2500) * (c.ref.width || 1220) / 1e6) * (c.ref.price_m2 || 0);
  const hwTotal = M.hw.reduce((a, x) => a + x.total, 0), finTotal = fin.reduce((a, x) => a + x.total, 0);
  const firstPose = postes.find((x) => x.groupe === 'Pose');
  const cost = [
    ...cal.map((c, i) => ({ k: `mat${i}`, g: 'Fabrication', name: `Panneaux · ${c.ref.name} ${c.ref.thickness} mm`, base: `${c.panels.length} × ${c.ref.length || 2500} × ${c.ref.width || 1220}${c.refId ? '' : ' · matière hors stock, prix à saisir'}`, v: panelCost(c) })),
    ...massif.map((m, i) => ({ k: `mas${i}`, g: 'Fabrication', name: `Bois massif · ${m.ref.name}`, base: `${m.vol.toFixed(3).replace('.', ',')} m³ net, ${m.volBrut.toFixed(3).replace('.', ',')} m³ brut (+35 %)`, v: m.volBrut * (m.ref.price_m3 || 0) })),
    { k: 'chants', g: 'Fabrication', name: 'Chants', base: `${edgeM.toFixed(1).replace('.', ',')} m de chant`, v: edgeM * b.chant_m },
    { k: 'quinc', g: 'Fabrication', name: 'Quincaillerie', base: `${M.hw.length} références, détail aux commandes`, v: hwTotal },
    { k: 'finp', g: 'Finition', name: 'Produits de finition', base: noFin ? 'sans objet' : `${M.faces.toFixed(1).replace('.', ',')} m² × ${String(b.finition_m2).replace('.', ',')} €`, v: noFin ? 0 : Math.max(finTotal, M.faces * b.finition_m2) },
    ...postes.map((x) => ({ k: `h_${x.k}`, g: x.groupe, name: x.name, base: `${hh(x.h)}${x.machine ? ', opérateur + machine' : ''}${x === firstPose ? ` · ${Math.round(p.km * 2)} km` : ''}`, v: x.h * b.taux + (x.machine ? x.h * b.cnc_machine : 0) + (x === firstPose ? p.km * 2 * b.km : 0) })),
  ].filter((x) => x.v || !x.k.startsWith('h_'));
  const revient = cost.reduce((a, x) => a + x.v, 0);
  const DEF = { Conception: ['Conception et plans', 'Relevé de cotes, plans cotés, une version de modification comprise.'], Fabrication: ['Fabrication', ''], Finition: ['Finition', ''], Pose: ['Livraison et pose', ''] };
  const quote = GROUPES.map((g) => { const v = cost.filter((x) => x.g === g).reduce((a, x) => a + x.v, 0); const [name, text] = M.texts[g] || DEF[g]; return { g, name, text, v: round10(v * p.coef) }; }).filter((x) => x.v > 0);
  const ht = quote.reduce((a, x) => a + x.v, 0);
  const plan = planning(p, postes, b, getDone(projectId), M.delai);
  const missing = lines.filter((l) => l.missing);
  return { p, b, study, lines, cal, main, massif, pieces, edgeM, faces: M.faces, hw: M.hw, fin, postes, hours, cost, revient, quote, ht, ttc: ht * 1.2, title: M.title, dims: M.dims,
    finition: M.finition, couches: M.couches, missing, marge: ht ? (ht - revient) / ht : 0, plan, panelsCount: cal.reduce((a, c) => a + c.panels.length, 0),
    poseHours: firstPose ? firstPose.h / (firstPose.personnes || 1) : 0 };
}
const getDone = (projectId) => { try { return JSON.parse(q.get('SELECT done FROM chains WHERE project_id = ?', projectId)?.done || '{}'); } catch { return {}; } };
function hh(h) { const m = Math.round(h * 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; }

// --- Planning de fabrication : jours ouvrés, en demi-journées ---
const isWork = (d) => { const x = parseDate(d).getDay(); return x !== 0 && x !== 6; };
const nextWork = (d) => { let x = d; while (!isWork(x)) x = addDays(x, 1); return x; };
function planning(p, postes, b, done, delai = 3) {
  const half = (h) => Math.max(0.5, Math.ceil((h / b.jour_h) * 2) / 2);
  const rows = [
    { k: 'cmd', name: 'Commande matière', who: 'Bureau', d: 0.5, phase: 'Bois' },
    { k: 'livf', name: 'Livraison matière et quincaillerie', who: 'Fournisseurs', d: Math.max(0.5, delai), wait: true, phase: 'Bois' },
  ];
  for (const x of postes) {
    if (x.groupe === 'Conception') continue; // fait avant l'accord
    const per = x.h / (x.personnes || 1);
    const coats = x.couches > 1 ? x.couches : 1;
    for (let c = 1; c <= coats; c++) {
      rows.push({ k: coats > 1 ? `${x.k}c${c}` : x.k, name: coats > 1 ? `${x.name}, couche ${c}` : x.name, who: x.who, d: half(per / coats), phase: x.phase, groupe: x.groupe });
      if (x.sechage) rows.push({ k: `${x.k}s${c}`, name: c === coats && coats > 1 ? 'Séchage complet' : 'Séchage', who: x.who, d: c === coats && coats > 1 ? Math.max(1, x.sechage) : x.sechage, dry: true, phase: x.phase });
    }
  }
  let cur = nextWork(p.start || today()), halfIdx = 0, late = 0, nDone = 0;
  for (const r of rows) {
    const real = done[r.k];
    if (real !== undefined && real !== '') { late += Number(real) - r.d; r.real = Number(real); nDone++; }
    const dur = r.real ?? r.d;
    r.start = cur; r.startHalf = halfIdx;
    let left = Math.round(dur * 2), end = cur, endHalf = halfIdx;
    while (left > 0) { endHalf = halfIdx; end = cur; left--; halfIdx++; if (halfIdx === 2) { halfIdx = 0; cur = nextWork(addDays(cur, 1)); } }
    r.end = end; r.endHalf = endHalf;
  }
  const pose = rows.find((r) => r.groupe === 'Pose') || rows[rows.length - 1];
  return { rows, poseDate: pose.start, late, nDone, start: nextWork(p.start || today()), byPhase: (ph) => rows.find((r) => r.phase === ph) };
}

// Besoins en panneaux des projets en cours (chaînes figées, pas encore débitées), par référence.
function reservations() {
  const out = {};
  for (const c of q.all("SELECT chains.*, projects.ref pref, projects.name pname FROM chains JOIN projects ON projects.id = chains.project_id WHERE projects.status = 'en_cours' AND chains.consumed_at IS NULL")) {
    let lines; try { lines = c.ai ? studyLines(JSON.parse(c.ai)) : nomenclature(cleanParams(JSON.parse(c.params))); } catch { continue; }
    for (const g of calepinage(lines)) {
      if (!g.refId) continue;
      const o = (out[g.refId] = out[g.refId] || { m2: 0, frozen: 0, projects: [] });
      o.m2 += g.m2; if (c.frozen_at) o.frozen += g.m2;
      o.projects.push({ id: c.project_id, ref: c.pref, name: c.pname, m2: g.m2, panels: g.panels.length, frozen: !!c.frozen_at });
    }
  }
  return out;
}

// Débit fait : les panneaux sortent du stock, les chutes utiles entrent dans le stock de chutes.
function consume(projectId) {
  const c = get(projectId);
  if (!c || c.consumed_at) return null;
  const cal = calepinage(linesOf(c));
  let n = 0;
  for (const g of cal) {
    if (!g.refId) continue;
    q.run('UPDATE panel_refs SET stock_m2 = max(0, stock_m2 - ?) WHERE id = ?', g.m2, g.refId);
    q.run("INSERT INTO panel_moves (ref_id, project_id, m2, kind, note) VALUES (?, ?, ?, 'consommation', ?)", g.refId, projectId, -g.m2, `${g.panels.length} panneau(x) débité(s)`);
    for (const pn of g.panels) for (const o of pn.offcuts) { q.run('INSERT INTO offcuts (ref_id, length, width, project_id, note) VALUES (?, ?, ?, ?, ?)', g.refId, o.len, o.wid, projectId, 'chute de débit'); n++; }
  }
  q.run("UPDATE chains SET consumed_at = datetime('now') WHERE project_id = ?", projectId);
  return n;
}

module.exports = { startStudy, saveStudy, studyLines, linesOf, GROUPES, FINITIONS, MURS, BAREME_DEF, BAREME_LABELS, bareme, refs, ref, defaults, cleanParams, get, save, nomenclature, calepinage, hardware, compute, planning,
  reservations, consume, hh, nextWork, isWork, iso };
// Une étude interrompue par un redémarrage du serveur est signalée, pas laissée « en cours ».
q.run("UPDATE chains SET ai_status = 'error', ai_error = 'Étude interrompue (redémarrage du serveur) : relance-la.' WHERE ai_status = 'running'");
