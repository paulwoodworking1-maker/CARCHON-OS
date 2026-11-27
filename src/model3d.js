'use strict';
// Lecture des fichiers 3D (STEP / IGES de TopSolid, Rhino, Fusion… et .3dm de Rhino) :
// chaque pièce est mesurée (longueur × largeur × épaisseur, volume) pour la nomenclature,
// et une version allégée est enregistrée pour la visionneuse 3D du logiciel.
const fs = require('node:fs');
const path = require('node:path');

const EXT_OCCT = /\.(step|stp|iges|igs|brep)$/i;
const EXT_3DM = /\.3dm$/i;
const is3D = (name) => EXT_OCCT.test(name) || EXT_3DM.test(name);
const MAX_VERTS = 400000;

let occtP = null, rhinoP = null;
const occt = () => (occtP = occtP || require('occt-import-js')());
const rhino = () => (rhinoP = rhinoP || require('rhino3dm')());

// --- Boîte orientée d'une pièce (analyse en composantes principales des sommets) ---
function jacobi(a) {
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const m = a.map((r) => r.slice());
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += m[i][j] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(m[p][q]) < 1e-30) continue;
      const th = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const mkp = m[k][p], mkq = m[k][q]; m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq; }
      for (let k = 0; k < 3; k++) { const mpk = m[p][k], mqk = m[q][k]; m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk; }
      for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  return [0, 1, 2].map((i) => [v[0][i], v[1][i], v[2][i]]);
}
function obb(pos) {
  const n = pos.length / 3;
  if (!n) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < pos.length; i += 3) {
    const d = [pos[i] - cx, pos[i + 1] - cy, pos[i + 2] - cz];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b];
  }
  let axes = jacobi(C);
  // Pièces de menuiserie souvent alignées sur les axes du dessin : on garde ces axes si la boîte n'est pas plus grande.
  const extents = (ax) => ax.map((u) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.length; i += 3) { const p = pos[i] * u[0] + pos[i + 1] * u[1] + pos[i + 2] * u[2]; if (p < lo) lo = p; if (p > hi) hi = p; }
    return [lo, hi];
  });
  let ex = extents(axes);
  const world = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const exw = extents(world);
  const vol = (e) => e.reduce((a, [lo, hi]) => a * (hi - lo), 1);
  if (vol(exw) <= vol(ex) * 1.02) { axes = world; ex = exw; }
  const size = ex.map(([lo, hi]) => hi - lo);
  const mid = ex.map(([lo, hi]) => (lo + hi) / 2);
  const center = [0, 1, 2].map((k) => axes.reduce((a, u, i) => a + u[k] * mid[i], 0));
  return { center, axes, size };
}
function meshVolume(pos, idx) {
  if (!idx || !idx.length) return null;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return Math.abs(v / 6);
}
// Boîte (8 sommets, 12 triangles) quand la pièce n'a pas de maillage enregistré.
function boxMesh(o) {
  const pos = [], idx = [];
  for (let k = 0; k < 8; k++) {
    const s = [(k & 1 ? 0.5 : -0.5) * o.size[0], (k & 2 ? 0.5 : -0.5) * o.size[1], (k & 4 ? 0.5 : -0.5) * o.size[2]];
    for (let d = 0; d < 3; d++) pos.push(o.center[d] + o.axes[0][d] * s[0] + o.axes[1][d] * s[1] + o.axes[2][d] * s[2]);
  }
  for (const f of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) idx.push(f[0], f[1], f[2], f[0], f[2], f[3]);
  return { pos, idx };
}

// --- Lecture STEP / IGES / BREP ---
async function readOcct(file) {
  const o = await occt();
  const buf = new Uint8Array(fs.readFileSync(file));
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.002, angularDeflection: 0.5 };
  const ext = path.extname(file).toLowerCase();
  const res = ext === '.brep' ? o.ReadBrepFile(buf, params) : /\.(iges|igs)$/.test(ext) ? o.ReadIgesFile(buf, params) : o.ReadStepFile(buf, params);
  if (!res.success) throw new Error('fichier 3D illisible');
  // Chemin dans l'arborescence (ensemble › sous-ensemble) de chaque maillage.
  const where = {};
  (function walk(node, trail) {
    const t = node.name ? [...trail, node.name] : trail;
    for (const m of node.meshes || []) where[m] = t;
    for (const c of node.children || []) walk(c, t);
  })(res.root, []);
  return res.meshes.map((m, i) => {
    const trail = where[i] || [];
    const t = trail.filter(Boolean);
    const named = !!m.name;
    return { name: m.name || t[t.length - 1] || `Pièce ${i + 1}`, group: (named ? t : t.slice(0, -1)).slice(-2).join(' › '),
      color: m.color || null, pos: Array.from(m.attributes.position.array), idx: m.index ? Array.from(m.index.array) : [] };
  });
}

// --- Lecture Rhino .3dm ---
const UNIT_MM = { Millimeters: 1, Centimeters: 10, Meters: 1000, Inches: 25.4, Feet: 304.8, Microns: 0.001 };
async function read3dm(file) {
  const rh = await rhino();
  const doc = rh.File3dm.fromByteArray(new Uint8Array(fs.readFileSync(file)));
  if (!doc) throw new Error('fichier Rhino illisible');
  const unitName = String(doc.settings().modelUnitSystem?.constructor?.name || '').replace('UnitSystem_', '');
  const k = UNIT_MM[unitName] || 1;
  const layers = doc.layers();
  const out = [], warn = [];
  for (let i = 0; i < doc.objects().count; i++) {
    const ob = doc.objects().get(i);
    let g = ob.geometry();
    const at = ob.attributes();
    const type = g.constructor.name;
    if (type === 'InstanceReference') { warn.push('blocs Rhino : explose-les (ou exporte en STEP) pour qu’ils soient comptés'); continue; }
    if (type === 'Extrusion' && g.toBrep) g = g.toBrep(true);
    const pos = [], idx = [];
    const addMesh = (mesh) => {
      if (!mesh) return;
      const base = pos.length / 3;
      const vs = mesh.vertices(), fs2 = mesh.faces();
      for (let v = 0; v < vs.count; v++) { const p = vs.get(v); pos.push(p[0] * k, p[1] * k, p[2] * k); }
      for (let f = 0; f < fs2.count; f++) { const q = fs2.get(f); idx.push(base + q[0], base + q[1], base + q[2]); if (q[2] !== q[3]) idx.push(base + q[0], base + q[2], base + q[3]); }
    };
    if (g.constructor.name === 'Brep') {
      const faces = g.faces();
      for (let f = 0; f < faces.count; f++) { try { addMesh(faces.get(f).getMesh(rh.MeshType.Any)); } catch {} }
      if (!pos.length && g.vertices) { const vs = g.vertices(); for (let v = 0; v < vs.count; v++) { const p = vs.get(v).location; pos.push(p[0] * k, p[1] * k, p[2] * k); } }
    } else if (g.constructor.name === 'Mesh') addMesh(g);
    else continue; // courbes, cotes, textes…
    if (!pos.length) { const bb = g.getBoundingBox(); for (const p of [bb.min, bb.max]) pos.push(p[0] * k, p[1] * k, p[2] * k); }
    let layer = '';
    try { layer = layers.get(at.layerIndex)?.name || ''; } catch {}
    out.push({ name: at.name || layer || `Pièce ${i + 1}`, group: layer, color: null, pos, idx });
  }
  return { meshes: out, warn };
}

// --- Analyse complète : pièces, nomenclature groupée, fichier de la visionneuse ---
async function analyze(file) {
  let meshes, warn = [];
  if (EXT_OCCT.test(file)) meshes = await readOcct(file);
  else if (EXT_3DM.test(file)) ({ meshes, warn } = await read3dm(file));
  else throw new Error('format 3D non pris en charge');
  const parts = [];
  let verts = 0;
  for (const m of meshes) {
    const o = obb(m.pos);
    if (!o || Math.max(...o.size) < 1) continue;
    const sorted = [...o.size].sort((a, b) => b - a);
    let { pos, idx } = m;
    if (!idx.length || verts + pos.length / 3 > MAX_VERTS) ({ pos, idx } = boxMesh(o));
    verts += pos.length / 3;
    parts.push({ name: m.name, group: m.group, color: m.color, dims: sorted.map((x) => Math.round(x * 10) / 10), volume: meshVolume(m.pos, m.idx) ?? sorted[0] * sorted[1] * sorted[2], pos, idx, boxOnly: !m.idx.length });
  }
  if (!parts.length) throw new Error('aucune pièce solide trouvée dans le fichier 3D');
  // Pièces identiques (même nom, même ensemble, mêmes cotes au millimètre) regroupées.
  const groups = new Map();
  for (const p of parts) {
    const key = [p.name.replace(/[\s_-]*\d+$/, ''), p.group, ...p.dims.map((d) => Math.round(d))].join('|');
    const g = groups.get(key) || { name: p.name.replace(/[\s_-]*\d+$/, '') || p.name, group: p.group, dims: p.dims, volume: p.volume, qty: 0 };
    g.qty++; groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => (a.group || '').localeCompare(b.group || '') || b.dims[0] - a.dims[0]);
  const boxOnly = parts.filter((p) => p.boxOnly).length;
  if (boxOnly && EXT_3DM.test(file)) warn.push(`${boxOnly} pièce(s) sans maillage dans le fichier Rhino : affichées en boîtes (enregistre avec les maillages de rendu, ou exporte en STEP)`);
  // Fichier allégé pour la visionneuse (positions arrondies au dixième de mm).
  const view = { unit: 'mm', parts: parts.map((p) => ({ n: p.name, g: p.group, c: p.color, d: p.dims, p: p.pos.map((x) => Math.round(x * 10) / 10), i: p.idx })) };
  fs.writeFileSync(file + '.view.json', JSON.stringify(view));
  return { parts: parts.length, list, warn, totalVolume: parts.reduce((a, p) => a + p.volume, 0) };
}

// Texte transmis à l'assistant : la nomenclature mesurée dans la 3D.
function asText(name, a) {
  const f = (x) => String(Math.round(x)).replace('.', ',');
  return `Nomenclature mesurée dans le modèle 3D « ${name} » (cotes finies en mm, mesurées sur chaque solide : longueur × largeur × épaisseur ; volume net) :
${a.list.map((g) => `- ${g.group ? `[${g.group}] ` : ''}${g.name} · qté ${g.qty} · ${g.dims.map(f).join(' × ')} mm · ${(g.volume / 1e9).toFixed(5).replace('.', ',')} m³ pièce`).join('\n')}
Total : ${a.parts} solides, ${(a.totalVolume / 1e9).toFixed(3).replace('.', ',')} m³ net.${a.warn.length ? `\nAttention : ${[...new Set(a.warn)].join(' ; ')}.` : ''}`;
}

module.exports = { is3D, analyze, asText, obb };
