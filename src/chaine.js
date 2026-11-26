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
  return { ...row, params: cleanParams(params, defaults()), done };
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
  L.forEach((x) => { x.label = x.qty > 1 ? `${x.rep}1–${x.qty}` : `${x.rep}1`; });
  return L;
}

// --- Calepinage : bandes guillotine, fil dans la longueur, sans rotation des pièces plaquées ---
function calepinage(lines, b = bareme()) {
  const byRef = {};
  for (const l of lines) {
    const k = l.refId || 0;
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
function compute(projectId, params) {
  const b = bareme();
  const p = params;
  const lines = nomenclature(p);
  const cal = calepinage(lines, b);
  const main = cal.find((c) => c.refId === p.ref_id) || cal[0] || { panels: [], m2: 0 };
  const back = cal.find((c) => c.refId === p.back_id && p.back_id !== p.ref_id) || { panels: [], m2: 0 };
  const pieces = lines.reduce((a, l) => a + l.qty, 0);
  const edgeM = lines.reduce((a, l) => a + (l.edges ? (l.len * l.qty) / 1000 : 0), 0);
  const faces = lines.filter((l) => l.rep !== 'F').reduce((a, l) => a + (l.len * l.wid * l.qty * (l.rep === 'E' ? 2 : 1)) / 1e6, 0);
  const noFin = p.finition.startsWith('Aucune') || !p.couches;
  const colis = p.caissons + Math.ceil((p.shelves * p.caissons) / 8) + 1;
  // Caisson le plus lourd : côtés + dessus/dessous (densité 750 kg/m³) + fond.
  const heaviest = Math.round(((2 * p.height * p.depth + 2 * p.width * p.depth) / 1e6) * ((ref(p.ref_id)?.thickness || 19) / 1000) * 750 + 8);
  const poseH = 2 * (p.caissons * b.pose_h_caisson + p.etage * b.pose_h_etage + (p.km * 2) / 60);
  const hw = hardware(p);
  const fin = finitions(p, faces);
  const postes = [
    { k: 'prep', name: 'Préparation et plans', qty: 'relevé, plans, fichiers', h: b.prep_h, phase: 'Conception', geste: 'Autre' },
    { k: 'cnc', name: 'Usinage CNC', qty: `${pieces} pièces · ${main.panels.length + back.panels.length} panneaux`, h: pieces * b.cnc_h_piece, phase: 'Débit', geste: 'Débit, corroyage', machine: true },
    { k: 'chants', name: 'Placage des chants', qty: `${Math.round(edgeM)} m`, h: edgeM * b.chant_h_m, phase: 'Débit', geste: 'Débit, corroyage' },
    { k: 'ponc', name: 'Ponçage', qty: `${faces.toFixed(1).replace('.', ',')} m² de faces vues`, h: noFin ? 0 : faces * b.ponc_h_m2, phase: 'Finition', geste: 'Ponçage' },
    { k: 'fin', name: 'Finition', qty: noFin ? 'sans objet' : `${faces.toFixed(1).replace('.', ',')} m² × ${p.couches} couches`, h: noFin ? 0 : faces * p.couches * b.fin_h_m2_couche, phase: 'Finition', geste: p.finition.startsWith('Huile') ? 'Huile-cire' : 'Vernis' },
    { k: 'ass', name: 'Assemblage', qty: `${p.caissons} caissons · ${p.shelves * p.caissons} étagères · ${Math.max(0, p.caissons - 1)} jonctions`, h: p.caissons * b.ass_h_caisson + p.shelves * p.caissons * b.ass_h_etagere, phase: 'Assemblage', geste: 'Assemblage' },
    { k: 'ctrl', name: 'Contrôle et emballage', qty: `${colis} colis`, h: colis * b.ctrl_h_colis, phase: 'Contrôle', geste: 'Contrôle' },
    { k: 'pose', name: 'Livraison et pose', qty: `2 pers. · ${heaviest} kg au plus lourd · ${Math.round(p.km * 2)} km`, h: poseH, phase: 'Livraison', geste: 'Pose' },
  ];
  const hours = postes.reduce((a, x) => a + x.h, 0);
  const panelCost = (c) => c.panels.length * ((c.ref.length || 2500) * (c.ref.width || 1220) / 1e6) * (c.ref.price_m2 || 0);
  const hwTotal = hw.reduce((a, x) => a + x.total, 0), finTotal = fin.reduce((a, x) => a + x.total, 0);
  const cost = [
    { k: 'panneaux', name: 'Panneaux', base: `${main.panels.length} × ${main.ref?.name || ''} ${main.ref?.length || ''} × ${main.ref?.width || ''}`, v: panelCost(main) },
    ...(back.panels.length ? [{ k: 'fonds', name: 'Fonds', base: `${back.panels.length} × ${back.ref.name} ${back.ref.thickness} mm`, v: panelCost(back) }] : []),
    { k: 'chants', name: 'Chants', base: `${edgeM.toFixed(1).replace('.', ',')} m de chant`, v: edgeM * b.chant_m },
    { k: 'quinc', name: 'Quincaillerie', base: `${hw.length} références, détail aux commandes`, v: hwTotal },
    { k: 'finp', name: 'Produits de finition', base: noFin ? 'sans objet' : `${faces.toFixed(1).replace('.', ',')} m² × ${String(b.finition_m2).replace('.', ',')} €`, v: noFin ? 0 : Math.max(finTotal, faces * b.finition_m2) },
    ...postes.map((x) => ({ k: `h_${x.k}`, name: x.name, base: `${hh(x.h)}${x.machine ? ', opérateur + machine' : ''}${x.k === 'pose' ? ` · ${Math.round(p.km * 2)} km` : ''}`, v: x.h * b.taux + (x.machine ? x.h * b.cnc_machine : 0) + (x.k === 'pose' ? p.km * 2 * b.km : 0) })),
  ];
  const revient = cost.reduce((a, x) => a + x.v, 0);
  const sum = (ks) => cost.filter((x) => ks.includes(x.k)).reduce((a, x) => a + x.v, 0);
  const quote = [
    { name: 'Conception et plans', text: 'Relevé de cotes, plans cotés et rendu, une version de modification comprise.', v: round10(sum(['h_prep']) * p.coef) },
    { name: `Fabrication de ${p.caissons} caisson${p.caissons > 1 ? 's' : ''} ${p.width} × ${p.height} × ${p.depth} mm`, text: `${main.ref?.name || 'Panneau'} ${main.ref?.thickness || ''} mm, chants plaqués, fond rainuré, ${p.shelves * p.caissons} étagères réglables. Usinage numérique, assemblage tourillonné, démontable pour la livraison.`, v: round10(sum(['panneaux', 'fonds', 'chants', 'quinc', 'h_cnc', 'h_chants', 'h_ass', 'h_ctrl']) * p.coef) },
    ...(noFin ? [] : [{ name: 'Finition', text: `${p.finition}, ${p.couches} couches, égrenage 240.`, v: round10(sum(['finp', 'h_ponc', 'h_fin']) * p.coef) }]),
    { name: 'Livraison et pose', text: `Livraison, montage, jonction des caissons, fixation murale adaptée (${p.mur.toLowerCase()}), réglage d’aplomb.`, v: round10(sum(['h_pose']) * p.coef) },
  ];
  const ht = quote.reduce((a, x) => a + x.v, 0);
  const plan = planning(p, postes, b, getDone(projectId));
  return { p, b, lines, cal, main, back, pieces, edgeM, faces, hw, fin, postes, hours, cost, revient, quote, ht, ttc: ht * 1.2,
    marge: ht ? (ht - revient) / ht : 0, plan, panelsCount: cal.reduce((a, c) => a + c.panels.length, 0) };
}
const getDone = (projectId) => { try { return JSON.parse(q.get('SELECT done FROM chains WHERE project_id = ?', projectId)?.done || '{}'); } catch { return {}; } };
function hh(h) { const m = Math.round(h * 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; }

// --- Planning de fabrication : jours ouvrés, en demi-journées ---
const isWork = (d) => { const x = parseDate(d).getDay(); return x !== 0 && x !== 6; };
const nextWork = (d) => { let x = d; while (!isWork(x)) x = addDays(x, 1); return x; };
function planning(p, postes, b, done) {
  const half = (h) => Math.max(0.5, Math.ceil((h / b.jour_h) * 2) / 2);
  const P = Object.fromEntries(postes.map((x) => [x.k, x]));
  const rows = [
    { k: 'cmd', name: 'Commande matière', who: 'Bureau', d: 0.5 },
    { k: 'livf', name: 'Livraison panneaux et quincaillerie', who: 'Fournisseurs', d: 3, wait: true },
    { k: 'cnc', name: 'Usinage CNC', who: 'CNC', d: half(P.cnc.h) },
    { k: 'chants', name: 'Placage des chants', who: 'Établi', d: half(P.chants.h) },
  ];
  if (P.ponc.h) rows.push({ k: 'ponc', name: 'Ponçage', who: 'Établi', d: half(P.ponc.h) });
  for (let c = 1; c <= (P.fin.h ? p.couches : 0); c++) {
    rows.push({ k: `fin${c}`, name: `Finition, couche ${c}`, who: 'Finition', d: half(P.fin.h / p.couches) });
    rows.push({ k: `sech${c}`, name: c === p.couches ? 'Séchage complet' : 'Séchage, égrenage', who: 'Finition', d: c === p.couches ? 1 : 0.5, dry: true });
  }
  rows.push({ k: 'ass', name: 'Assemblage à blanc et montage', who: 'Établi', d: half(P.ass.h) });
  rows.push({ k: 'ctrl', name: 'Contrôle et emballage', who: 'Établi', d: half(P.ctrl.h) });
  rows.push({ k: 'pose', name: 'Livraison et pose', who: 'Pose', d: half(P.pose.h / 2) });
  // Placement en demi-journées à partir de la date de départ ; un poste fait prend sa durée réelle.
  let cur = nextWork(p.start || today()), halfIdx = 0, late = 0, nDone = 0;
  for (const r of rows) {
    const real = done[r.k];
    if (real !== undefined && real !== '') { late += Number(real) - r.d; r.real = Number(real); nDone++; }
    const dur = r.real ?? r.d;
    r.start = cur; r.startHalf = halfIdx;
    let left = dur * 2;
    let end = cur, endHalf = halfIdx;
    while (left > 0) { endHalf = halfIdx; end = cur; left--; halfIdx++; if (halfIdx === 2) { halfIdx = 0; cur = nextWork(addDays(cur, 1)); } }
    r.end = end; r.endHalf = endHalf;
  }
  const pose = rows[rows.length - 1];
  return { rows, poseDate: pose.start, late, nDone, start: nextWork(p.start || today()) };
}

// Besoins en panneaux des projets en cours (chaînes figées, pas encore débitées), par référence.
function reservations() {
  const out = {};
  for (const c of q.all("SELECT chains.*, projects.ref pref, projects.name pname FROM chains JOIN projects ON projects.id = chains.project_id WHERE projects.status = 'en_cours' AND chains.consumed_at IS NULL")) {
    let params; try { params = cleanParams(JSON.parse(c.params)); } catch { continue; }
    for (const g of calepinage(nomenclature(params))) {
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
  const cal = calepinage(nomenclature(c.params));
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

module.exports = { FINITIONS, MURS, BAREME_DEF, BAREME_LABELS, bareme, refs, ref, defaults, cleanParams, get, save, nomenclature, calepinage, hardware, compute, planning,
  reservations, consume, hh, nextWork, isWork, iso };
