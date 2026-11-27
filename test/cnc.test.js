'use strict';
// Moteur CNC : imbrication, parcours, contrôles et G-code, sans base de données.
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../src/cnc/engine');
const POST = require('../src/cnc/post');

const tools = [
  { id: 1, num: 1, name: 'Compression', kind: 'fraise', diameter: 8, max_depth: 32, rpm: 18000, feed: 6000, plunge: 1500, pass_depth: 10, feeds: [{ material: 'Mélaminé', rpm: 18000, feed: 7000, plunge: 1800, pass_depth: 10 }] },
  { id: 2, num: 3, name: 'Foret', kind: 'foret', diameter: 5, max_depth: 30, rpm: 6000, feed: 3000, plunge: 2000, pass_depth: 15, feeds: [] },
  { id: 3, num: 2, name: 'Fraise 6', kind: 'fraise', diameter: 6, max_depth: 22, rpm: 18000, feed: 4000, plunge: 1200, pass_depth: 6, feeds: [] },
];
const cfg = { ...E.DEFAULT_CFG, contour_tool_id: 1 };
const P = (t) => E.parseOps(t).ops;
const job = (parts, extra = {}) => ({ name: 'Test', material: 'Mélaminé', thickness: 19, sheet_l: 2800, sheet_w: 2070, parts, ...extra });

test('les usinages se lisent et se réécrivent', () => {
  const { ops, errors } = E.parseOps('trou x=37 y=32 d=5 p=13\nrainure x1=0 y1=10 x2=720 y2=10 l=8 p=T\n# commentaire\npoche x=1 y=2 lo=3 la=4 p=5');
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(ops.length, 3);
  assert.strictEqual(ops[1].p, 'T');
  assert.deepStrictEqual(E.parseOps(E.formatOps(ops)).ops, ops);
  assert.ok(E.parseOps('trou x=1 y=2').errors.length);
  assert.ok(E.parseOps('vis x=1').errors.length);
});

test('imbrication : aucune pièce ne se chevauche, écart respecté, fil respecté', () => {
  const parts = [{ name: 'A', l: 720, w: 560, qty: 7, grain: true }, { name: 'B', l: 400, w: 300, qty: 9, grain: false }, { name: 'C', l: 1900, w: 120, qty: 3, grain: true }];
  const gap = 10, margin = 10;
  const n = E.nest(parts, { sheet_l: 2800, sheet_w: 2070, margin, gap });
  assert.strictEqual(n.sheets.flat().length, 19);
  for (const sh of n.sheets) {
    for (const a of sh) {
      assert.ok(a.x >= margin - 1e-6 && a.y >= margin - 1e-6 && a.x + a.lx <= 2800 - margin + 1e-6 && a.y + a.ly <= 2070 - margin + 1e-6, 'dans le panneau');
      if (parts[a.pi].grain) assert.strictEqual(a.rot, false, 'fil respecté');
      for (const b of sh) {
        if (a === b) continue;
        const sep = a.x + a.lx + gap <= b.x + 1e-6 || b.x + b.lx + gap <= a.x + 1e-6 || a.y + a.ly + gap <= b.y + 1e-6 || b.y + b.ly + gap <= a.y + 1e-6;
        assert.ok(sep, 'pas de chevauchement');
      }
    }
  }
});

test('parcours : perçages, puis rainures/poches, puis détourages petites pièces d’abord, peau finale en dernier', () => {
  const r = E.compute(job([
    { name: 'Joue', l: 720, w: 560, qty: 2, grain: false, ops: P('trou x=37 y=32 d=5 p=13\nrainure x1=0 y1=10 x2=720 y2=10 l=8 p=8') },
    { name: 'Taquet', l: 60, w: 40, qty: 2, ops: [] },
  ]), tools, cfg);
  assert.deepStrictEqual(r.errors, []);
  const kinds = r.sheets[0].ops.map((o) => o.kind);
  const firstContour = kinds.indexOf('contour');
  assert.ok(kinds.lastIndexOf('trou') < kinds.indexOf('rainure') && kinds.lastIndexOf('rainure') < firstContour);
  assert.strictEqual(r.sheets[0].ops[firstContour].small, true, 'petite pièce détourée d’abord');
  assert.deepStrictEqual(kinds.slice(-2), ['peau', 'peau']);
  // Jamais plus bas que le martyr autorisé, et la traversée va bien dans le martyr.
  assert.ok(r.sheets[0].zLow >= -(19 + cfg.martyr_max) - 1e-9);
  assert.ok(Math.abs(r.sheets[0].zLow + (19 + cfg.martyr_cut)) < 1e-6);
  // Un seul changement par outil : foret, puis compression (rainure de 8 = fraise de 8, gardée pour le détourage).
  assert.strictEqual(r.changes, 2);
});

test('contrôles : pièce trop grande, outil manquant, usinage hors pièce, profondeur trop grande', () => {
  const r = E.compute(job([
    { name: 'Géante', l: 3000, w: 500, qty: 1, ops: [] },
    { name: 'Trou Ø3', l: 500, w: 500, qty: 1, ops: P('trou x=50 y=50 d=3 p=10') },
    { name: 'Dehors', l: 500, w: 500, qty: 1, ops: P('trou x=600 y=50 d=5 p=10') },
    { name: 'Profonde', l: 500, w: 500, qty: 1, ops: P('poche x=10 y=10 lo=50 la=50 p=40') },
  ]), tools, cfg);
  const all = r.errors.join(' | ');
  assert.match(all, /Géante ne rentre pas/);
  assert.match(all, /aucun outil pour un trou Ø3/);
  assert.match(all, /hors de la pièce/);
  assert.match(all, /poche plus profonde/);
});

test('G-code NK105 : changement d’outil, broche, zéro, essai à vide remonté', () => {
  const j = job([{ name: 'Joue', l: 720, w: 560, qty: 1, ops: P('trou x=37 y=32 d=5 p=13') }]);
  const r = E.compute(j, tools, cfg);
  const g = POST.gcode(r.sheets[0], { job: j, ref: 'P2026-001', sheets: 1, cfg, post: POST.POST_DEFAULT });
  assert.match(g, /T3 M06/);
  assert.match(g, /T1 M06/);
  assert.match(g, /M03 S18000/);
  assert.match(g, /M30\r\n$/);
  assert.doesNotMatch(g, /[^\x00-\x7F]/, 'aucun caractère accentué');
  const zs = [...g.matchAll(/Z(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(Math.min(...zs) >= -(19 + cfg.martyr_max));
  const dry = POST.gcode(r.sheets[0], { job: j, ref: 'P2026-001', sheets: 1, cfg, post: POST.POST_DEFAULT, dry: true });
  const dz = [...dry.matchAll(/Z(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(Math.min(...dz) > 0, 'à vide, la fraise reste au-dessus du panneau');
  // Zéro sur le martyr : tout est décalé de l'épaisseur.
  const gm = POST.gcode(r.sheets[0], { job: j, ref: 'x', sheets: 1, cfg: { ...cfg, zero: 'martyr' }, post: POST.POST_DEFAULT });
  const zm = [...gm.matchAll(/Z(-?[\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(Math.abs(Math.min(...zm) - (-cfg.martyr_cut)) < 1e-6);
});

test('DXF : un calque par opération', () => {
  const j = job([{ name: 'Joue', l: 720, w: 560, qty: 1, ops: P('trou x=37 y=32 d=5 p=13\nrainure x1=0 y1=10 x2=720 y2=10 l=8 p=8') }]);
  const r = E.compute(j, tools, cfg);
  const d = POST.dxf(r.sheets[0], j);
  for (const l of ['PANNEAU', 'DECOUPE_TRAVERSANT', 'PERCAGE_D5_P13', 'RAINURE_L8_P8']) assert.ok(d.includes(l), l);
  assert.match(d, /EOF\r\n$/);
});
