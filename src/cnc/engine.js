'use strict';
// Moteur CNC : imbrication des pièces sur les panneaux, puis parcours d'outil pour chaque panneau.
// Code déterministe, sans IA : même entrée, même programme. Unités : mm, mm/min.
// Repère : origine = coin avant gauche du panneau, X le long du panneau, Y en largeur.
// Z = 0 sur le dessus du panneau, négatif dans la matière (le post-processeur convertit si le zéro est ailleurs).

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------
// 1. Usinages d'une pièce, écrits une par ligne (lisible et modifiable par le patron) :
//    trou x=37 y=32 d=5 p=13          (p=T ou p=traversant : traversant)
//    rainure x1=0 y1=10 x2=720 y2=10 l=8 p=8
//    poche x=100 y=50 lo=200 la=80 p=5     (coin bas-gauche, longueur en X, largeur en Y)
// ---------------------------------------------------------------------------
const OP_FIELDS = {
  trou: ['x', 'y', 'd', 'p'],
  rainure: ['x1', 'y1', 'x2', 'y2', 'l', 'p'],
  poche: ['x', 'y', 'lo', 'la', 'p'],
};
function parseOps(text) {
  const ops = [], errors = [];
  String(text || '').split('\n').forEach((line, i) => {
    const t = line.replace(/#.*/, '').trim();
    if (!t) return;
    const [kind, ...rest] = t.split(/\s+/);
    const k = kind.toLowerCase().replace('trous', 'trou').replace('perçage', 'trou').replace('percage', 'trou');
    if (!OP_FIELDS[k]) { errors.push(`Ligne ${i + 1} : « ${kind} » inconnu (trou, rainure ou poche).`); return; }
    const op = { type: k };
    for (const kv of rest) {
      const m = kv.match(/^([a-z0-9]+)=(.+)$/i);
      if (!m) { errors.push(`Ligne ${i + 1} : « ${kv} » illisible (attendu nom=valeur).`); continue; }
      const key = m[1].toLowerCase(), raw = m[2].replace(',', '.').replace(/^ø/i, '');
      if (key === 'p' && /^(t|trav|traversant)$/i.test(raw)) op.p = 'T';
      else { const v = parseFloat(raw); if (!Number.isFinite(v)) errors.push(`Ligne ${i + 1} : ${key} n’est pas un nombre.`); else op[key] = v; }
    }
    const missing = OP_FIELDS[k].filter((f) => op[f] === undefined);
    if (missing.length) errors.push(`Ligne ${i + 1} : il manque ${missing.join(', ')}.`);
    else ops.push(op);
  });
  return { ops, errors };
}
const fmtNum = (n) => String(round(n, 2));
function formatOps(ops) {
  return (ops || []).map((o) => `${o.type} ${OP_FIELDS[o.type].map((f) => `${f}=${o[f] === 'T' ? 'T' : fmtNum(o[f])}`).join(' ')}`).join('\n');
}

// ---------------------------------------------------------------------------
// 2. Imbrication (MaxRects), plusieurs essais, on garde le meilleur.
// ---------------------------------------------------------------------------
function maxRects(W, H) {
  let free = [{ x: 0, y: 0, w: W, h: H }];
  const used = [];
  function score(fr, w, h, rule) {
    if (w > fr.w + 1e-9 || h > fr.h + 1e-9) return null;
    const lw = fr.w - w, lh = fr.h - h;
    if (rule === 'bssf') return [Math.min(lw, lh), Math.max(lw, lh)];
    if (rule === 'baf') return [fr.w * fr.h - w * h, Math.min(lw, lh)];
    return [fr.y + h, fr.x]; // bottom-left
  }
  function find(w, h, canRotate, rule) {
    let best = null;
    for (const fr of free) {
      for (const [ww, hh, rot] of canRotate && w !== h ? [[w, h, false], [h, w, true]] : [[w, h, false]]) {
        const s = score(fr, ww, hh, rule);
        if (s && (!best || s[0] < best.s[0] - 1e-9 || (Math.abs(s[0] - best.s[0]) < 1e-9 && s[1] < best.s[1]))) best = { x: fr.x, y: fr.y, w: ww, h: hh, rot, s };
      }
    }
    return best;
  }
  function place(n) {
    const out = [];
    for (const fr of free) {
      if (n.x >= fr.x + fr.w || n.x + n.w <= fr.x || n.y >= fr.y + fr.h || n.y + n.h <= fr.y) { out.push(fr); continue; }
      if (n.x > fr.x) out.push({ x: fr.x, y: fr.y, w: n.x - fr.x, h: fr.h });
      if (n.x + n.w < fr.x + fr.w) out.push({ x: n.x + n.w, y: fr.y, w: fr.x + fr.w - n.x - n.w, h: fr.h });
      if (n.y > fr.y) out.push({ x: fr.x, y: fr.y, w: fr.w, h: n.y - fr.y });
      if (n.y + n.h < fr.y + fr.h) out.push({ x: fr.x, y: n.y + n.h, w: fr.w, h: fr.y + fr.h - n.y - n.h });
    }
    free = out.filter((a, i) => !out.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h && (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)));
    used.push(n);
  }
  return { find, place, used };
}

// job : { sheet_l, sheet_w, margin, gap } ; parts : [{ name, l, w, qty, grain, ops }]
function nest(parts, { sheet_l, sheet_w, margin = 10, gap = 10 }) {
  const items = [];
  parts.forEach((p, pi) => { for (let k = 0; k < Math.max(0, Math.floor(p.qty || 0)); k++) items.push({ pi, k, l: p.l, w: p.w, grain: !!p.grain }); });
  const W = sheet_l - 2 * margin + gap, H = sheet_w - 2 * margin + gap;
  const tooBig = items.filter((it) => !((it.l + gap <= W && it.w + gap <= H) || (!it.grain && it.w + gap <= W && it.l + gap <= H)));
  const ok = items.filter((it) => !tooBig.includes(it));
  const sorts = {
    aire: (a, b) => b.l * b.w - a.l * a.w,
    long: (a, b) => Math.max(b.l, b.w) - Math.max(a.l, a.w) || b.l * b.w - a.l * a.w,
    perim: (a, b) => b.l + b.w - a.l - a.w,
    court: (a, b) => Math.min(b.l, b.w) - Math.min(a.l, a.w) || b.l * b.w - a.l * a.w,
  };
  let best = null;
  for (const sk of Object.keys(sorts)) {
    for (const rule of ['bssf', 'baf', 'bl']) {
      const order = ok.slice().sort(sorts[sk]);
      const sheets = [];
      for (const it of order) {
        let placed = false;
        for (const s of sheets) {
          const f = s.mr.find(it.l + gap, it.w + gap, !it.grain, rule);
          if (f) { s.mr.place(f); s.parts.push({ ...it, x: f.x, y: f.y, rot: f.rot }); placed = true; break; }
        }
        if (!placed) {
          const s = { mr: maxRects(W, H), parts: [] };
          const f = s.mr.find(it.l + gap, it.w + gap, !it.grain, rule);
          s.mr.place(f); s.parts.push({ ...it, x: f.x, y: f.y, rot: f.rot });
          sheets.push(s);
        }
      }
      // Critère : moins de panneaux, puis le dernier panneau le moins rempli (grande chute réutilisable).
      const last = sheets.length ? sheets[sheets.length - 1].parts.reduce((m, p) => Math.max(m, p.x + (p.rot ? p.w : p.l)), 0) : 0;
      const cand = { n: sheets.length, last, sheets, how: `${sk}/${rule}` };
      if (!best || cand.n < best.n || (cand.n === best.n && cand.last < best.last)) best = cand;
    }
  }
  const sheets = (best ? best.sheets : []).map((s) => s.parts.map((p) => ({
    pi: p.pi, k: p.k, rot: p.rot, x: round(p.x + margin), y: round(p.y + margin), lx: p.rot ? p.w : p.l, ly: p.rot ? p.l : p.w,
  })));
  const partArea = ok.reduce((a, it) => a + it.l * it.w, 0);
  const yieldPct = sheets.length ? partArea / (sheets.length * sheet_l * sheet_w) : 0;
  return { sheets, tooBig: tooBig.map((it) => it.pi), yield: yieldPct, how: best?.how || '' };
}

// Position d'un point de la pièce sur le panneau (rotation de 90° dans le sens trigo si pivotée).
function toSheet(pl, part, px, py) {
  return pl.rot ? { x: pl.x + (part.w - py), y: pl.y + px } : { x: pl.x + px, y: pl.y + py };
}

// ---------------------------------------------------------------------------
// 3. Choix des outils
// ---------------------------------------------------------------------------
function feedsFor(tool, material) {
  const f = (tool.feeds || []).find((x) => x.material === material);
  return f ? { rpm: f.rpm, feed: f.feed, plunge: f.plunge, pass: f.pass_depth, fromMaterial: true } : { rpm: tool.rpm, feed: tool.feed, plunge: tool.plunge, pass: tool.pass_depth, fromMaterial: false };
}
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;
function pickHoleTool(tools, d, depth) {
  const drill = tools.filter((t) => t.kind === 'foret' && near(t.diameter, d) && t.max_depth >= depth).sort((a, b) => a.max_depth - b.max_depth)[0];
  if (drill) return { tool: drill, mode: 'percer' };
  const mill = tools.filter((t) => t.kind === 'fraise' && t.diameter <= d + 0.05 && t.max_depth >= depth).sort((a, b) => b.diameter - a.diameter)[0];
  if (mill) return { tool: mill, mode: near(mill.diameter, d) ? 'percer' : 'helice' };
  return null;
}
function pickSlotTool(tools, width, depth, maxD) {
  const exact = tools.filter((t) => t.kind === 'fraise' && near(t.diameter, width) && t.max_depth >= depth)[0];
  if (exact) return { tool: exact, mode: 'rainure' };
  const mill = tools.filter((t) => t.kind === 'fraise' && t.diameter < width && t.diameter <= maxD && t.max_depth >= depth).sort((a, b) => b.diameter - a.diameter)[0];
  return mill ? { tool: mill, mode: 'poche' } : null;
}

// ---------------------------------------------------------------------------
// 4. Parcours d'un panneau
// ---------------------------------------------------------------------------
// Une opération = une suite de déplacements à un même outil, entrée et sortie en Z de dégagement.
// Déplacement : { g: 0|1|2|3, x, y, z, i?, j?, f? }

// Boucle fermée (liste de points) à une profondeur, avec descente en rampe sur le premier côté.
function loopPasses(pts, depths, feeds, rampLen) {
  const moves = [];
  const n = pts.length;
  let zPrev = 0;
  const p0 = pts[0], p1 = pts[1];
  const edge = dist(p0, p1);
  const r = Math.min(edge, rampLen);
  const rp = { x: p0.x + (p1.x - p0.x) * (r / edge), y: p0.y + (p1.y - p0.y) * (r / edge) };
  for (const z of depths) {
    // Rampe de p0 vers rp en descendant, puis tour complet à la profondeur, jusqu'à rp de nouveau.
    moves.push({ g: 1, x: rp.x, y: rp.y, z, f: feeds.plunge });
    for (let k = 1; k <= n; k++) { const q = pts[k % n]; moves.push({ g: 1, x: q.x, y: q.y, z, f: feeds.feed }); }
    moves.push({ g: 1, x: rp.x, y: rp.y, z, f: feeds.feed });
    // Retour au départ pour la passe suivante (déjà usiné à cette profondeur).
    moves.push({ g: 1, x: p0.x, y: p0.y, z, f: feeds.feed });
    zPrev = z;
  }
  return { start: p0, moves, zEnd: zPrev };
}
function passDepths(total, pass, from = 0) {
  const n = Math.max(1, Math.ceil((total - from) / Math.max(0.5, pass) - 1e-9));
  return Array.from({ length: n }, (_, i) => -round(from + ((total - from) * (i + 1)) / n));
}
// Rectangle (x0,y0)-(x1,y1) : sens horaire ou trigo.
function rectPts(x0, y0, x1, y1, cw) {
  const pts = [{ x: x0, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y1 }, { x: x1, y: y0 }];
  return cw ? pts : [pts[0], pts[3], pts[2], pts[1]];
}
// Poche rectangulaire par boucles concentriques (de l'intérieur vers le bord).
function pocketLoops(x0, y0, x1, y1, D, climb) {
  const r = D / 2, step = D * 0.6;
  const maxO = Math.min(x1 - x0, y1 - y0) / 2;
  const offs = [];
  for (let o = r; o < maxO - 1e-6; o += step) offs.push(o);
  if (!offs.length) offs.push(Math.min(r, maxO));
  if (maxO - offs[offs.length - 1] > r * 0.8) offs.push(maxO); // le centre ne doit pas rester debout
  const loops = offs.map((o) => [x0 + o, y0 + o, x1 - o, y1 - o]);
  // Intérieur → extérieur ; à l'intérieur d'une poche, l'usinage en avalant tourne dans le sens trigo.
  return loops.reverse().map(([a, b, c, d]) => (c - a < 1e-6 || d - b < 1e-6 ? [{ x: a, y: b }, { x: c, y: d }] : rectPts(a, b, c, d, !climb)));
}

function sheetJob(job, placements, cfg, tools) {
  const T = job.thickness;
  const through = round(T + cfg.martyr_cut);
  const errors = [], warnings = [];
  const ops = [];
  const contourTool = tools.find((t) => t.id === cfg.contour_tool_id && t.kind === 'fraise') || tools.filter((t) => t.kind === 'fraise' && t.max_depth >= through).sort((a, b) => b.diameter - a.diameter)[0];
  const climb = (job.climb ?? cfg.climb) ? true : false;
  const depthOf = (p) => (p === 'T' || Math.abs(p - T) < 0.01 ? through : p);
  const feedsCache = new Map();
  const F = (tool) => { if (!feedsCache.has(tool.id)) { const f = feedsFor(tool, job.material); if (!f.fromMaterial) warnings.push(`${toolLabel(tool)} : pas de réglage pour « ${job.material} », valeurs générales de l’outil utilisées.`); feedsCache.set(tool.id, f); } return feedsCache.get(tool.id); };
  const smallArea = cfg.small_area * 1e6;

  placements.forEach((pl, idx) => {
    const part = job.parts[pl.pi];
    const label = `${part.name}${part.qty > 1 ? ` #${pl.k + 1}` : ''}`;
    const inPart = (x, y) => x >= -1e-6 && y >= -1e-6 && x <= part.l + 1e-6 && y <= part.w + 1e-6;
    (part.ops || []).forEach((o) => {
      const depth = depthOf(o.p);
      if (o.p !== 'T' && o.p <= 0) { errors.push(`${label} : profondeur nulle ou négative.`); return; }
      if (o.p !== 'T' && o.p > T + 0.01) { errors.push(`${label} : ${o.type} plus profonde (${o.p} mm) que l’épaisseur du panneau (${T} mm). Écris p=T pour traverser.`); return; }
      if (o.type === 'trou') {
        if (!inPart(o.x - o.d / 2, o.y - o.d / 2) || !inPart(o.x + o.d / 2, o.y + o.d / 2)) { errors.push(`${label} : trou Ø${o.d} en ${o.x};${o.y} hors de la pièce.`); return; }
        const pick = pickHoleTool(tools, o.d, depth);
        if (!pick) { errors.push(`${label} : aucun outil pour un trou Ø${o.d} de ${round(depth, 1)} mm.`); return; }
        const c = toSheet(pl, part, o.x, o.y);
        const f = F(pick.tool);
        const moves = [];
        if (pick.mode === 'percer') {
          // Débourrage : on remonte de 2 mm au-dessus du panneau entre chaque passe.
          for (const z of passDepths(depth, f.pass)) { moves.push({ g: 1, x: c.x, y: c.y, z, f: f.plunge }); if (z > -depth + 1e-6) moves.push({ g: 0, x: c.x, y: c.y, z: cfg.clear }); }
        } else {
          const rr = (o.d - pick.tool.diameter) / 2;
          const s = { x: c.x + rr, y: c.y };
          for (const z of passDepths(depth, f.pass)) { moves.push({ g: 1, x: s.x, y: s.y, z, f: f.plunge }); moves.push({ g: climb ? 3 : 2, x: s.x, y: s.y, z, i: -rr, j: 0, f: f.feed }); }
          ops.push({ phase: 0, tool: pick.tool, label: `Trou Ø${o.d} · ${label}`, start: s, moves, kind: 'trou' });
          return;
        }
        ops.push({ phase: 0, tool: pick.tool, label: `Trou Ø${o.d} · ${label}`, start: c, moves, kind: 'trou' });
      } else if (o.type === 'rainure' || o.type === 'poche') {
        let x0, y0, x1, y1, width;
        if (o.type === 'rainure') {
          if (!near(o.x1, o.x2, 0.001) && !near(o.y1, o.y2, 0.001)) { errors.push(`${label} : rainure en biais, non gérée (seulement parallèle aux bords).`); return; }
          width = o.l;
          const horiz = near(o.y1, o.y2, 0.001);
          x0 = horiz ? Math.min(o.x1, o.x2) : o.x1 - o.l / 2; x1 = horiz ? Math.max(o.x1, o.x2) : o.x1 + o.l / 2;
          y0 = horiz ? o.y1 - o.l / 2 : Math.min(o.y1, o.y2); y1 = horiz ? o.y1 + o.l / 2 : Math.max(o.y1, o.y2);
        } else { x0 = o.x; y0 = o.y; x1 = o.x + o.lo; y1 = o.y + o.la; width = Math.min(o.lo, o.la); }
        // Une rainure peut déboucher sur le bord (0 ou longueur) ; elle ne doit pas en sortir.
        if (!inPart(x0, y0) || !inPart(x1, y1)) { errors.push(`${label} : ${o.type} hors de la pièce.`); return; }
        const pick = o.type === 'rainure' ? pickSlotTool(tools, width, depth, width) : (() => { const t = tools.filter((t) => t.kind === 'fraise' && t.diameter <= width + 0.05 && t.max_depth >= depth).sort((a, b) => b.diameter - a.diameter)[0]; return t ? { tool: t, mode: 'poche' } : null; })();
        if (!pick) { errors.push(`${label} : aucune fraise pour cette ${o.type} (${round(width, 1)} mm, ${round(depth, 1)} mm de profondeur).`); return; }
        const f = F(pick.tool);
        const a = toSheet(pl, part, x0, y0), b = toSheet(pl, part, x1, y1);
        const X0 = Math.min(a.x, b.x), X1 = Math.max(a.x, b.x), Y0 = Math.min(a.y, b.y), Y1 = Math.max(a.y, b.y);
        const moves = [];
        let start;
        if (pick.mode === 'rainure') {
          const horiz = X1 - X0 >= Y1 - Y0;
          const p = horiz ? [{ x: X0 + pick.tool.diameter / 2, y: (Y0 + Y1) / 2 }, { x: X1 - pick.tool.diameter / 2, y: (Y0 + Y1) / 2 }] : [{ x: (X0 + X1) / 2, y: Y0 + pick.tool.diameter / 2 }, { x: (X0 + X1) / 2, y: Y1 - pick.tool.diameter / 2 }];
          start = p[0];
          let at = 0;
          for (const z of passDepths(depth, f.pass)) {
            // Aller-retour : chaque passe descend en rampe sur toute la longueur.
            const to = p[1 - at];
            moves.push({ g: 1, x: to.x, y: to.y, z, f: f.plunge });
            moves.push({ g: 1, x: p[at].x, y: p[at].y, z, f: f.feed });
            moves.push({ g: 1, x: to.x, y: to.y, z, f: f.feed });
            at = 1 - at;
          }
        } else {
          const loops = pocketLoops(X0, Y0, X1, Y1, pick.tool.diameter, climb);
          start = loops[0][0];
          for (const z of passDepths(depth, f.pass)) {
            moves.push({ g: 1, x: loops[0][0].x, y: loops[0][0].y, z, f: f.plunge });
            for (const lp of loops) {
              moves.push({ g: 1, x: lp[0].x, y: lp[0].y, z, f: f.feed });
              for (let k = 1; k <= lp.length; k++) { const q = lp[k % lp.length]; moves.push({ g: 1, x: q.x, y: q.y, z, f: f.feed }); }
            }
            moves.push({ g: 1, x: loops[0][0].x, y: loops[0][0].y, z, f: f.feed });
          }
        }
        ops.push({ phase: 1, tool: pick.tool, label: `${o.type === 'rainure' ? 'Rainure' : 'Poche'} · ${label}`, start, moves, kind: o.type });
      }
    });
    // Détourage : à l'extérieur de la pièce, sens horaire = en avalant (broche M03).
    if (!contourTool) { if (idx === 0) errors.push(`Aucune fraise de détourage assez longue pour ${through} mm.`); return; }
    const f = F(contourTool), r = contourTool.diameter / 2;
    const pts = rectPts(pl.x - r, pl.y - r, pl.x + pl.lx + r, pl.y + pl.ly + r, climb);
    const area = part.l * part.w;
    const small = area < smallArea;
    const skin = small ? Math.min(cfg.skin, T / 3) : 0;
    const main = loopPasses(pts, passDepths(through - skin, f.pass), f, cfg.ramp);
    ops.push({ phase: 2, tool: contourTool, label: `Détourage · ${label}`, start: main.start, moves: main.moves, kind: 'contour', area, small, rect: [pl.x, pl.y, pl.lx, pl.ly], name: label });
    if (small) {
      const fin = loopPasses(pts, [-through], f, cfg.ramp);
      ops.push({ phase: 3, tool: contourTool, label: `Peau finale · ${label}`, start: fin.start, moves: fin.moves, kind: 'peau', area, small });
    }
    if (Math.min(part.l, part.w) < cfg.min_part && pl.k === 0) warnings.push(`${part.name} : pièce étroite (${round(Math.min(part.l, part.w), 1)} mm), la dépression la tient mal : peau laissée et coupée en dernier.`);
  });
  return { ops: order(ops, contourTool), errors, warnings };
}
const toolLabel = (t) => `T${t.num} ${t.name} Ø${t.diameter}`;

// Ordre : perçages, puis rainures et poches, puis détourages (petites pièces d'abord), puis peaux finales.
// Dans chaque phase : regroupé par outil, et l'outil de la phase suivante en dernier pour éviter un changement.
// Dans chaque groupe : plus proche voisin puis amélioration 2-opt (trajets à vide plus courts).
function order(ops, contourTool) {
  const out = [];
  let pos = { x: 0, y: 0 }, cur = null;
  for (const phase of [0, 1, 2, 3]) {
    const list = ops.filter((o) => o.phase === phase);
    const byTool = new Map();
    list.forEach((o) => { if (!byTool.has(o.tool.id)) byTool.set(o.tool.id, []); byTool.get(o.tool.id).push(o); });
    const ids = [...byTool.keys()].sort((a, b) => (a === cur ? -1 : b === cur ? 1 : 0) || (a === contourTool?.id ? 1 : b === contourTool?.id ? -1 : 0) || byTool.get(a)[0].tool.num - byTool.get(b)[0].tool.num);
    for (const id of ids) {
      const group = byTool.get(id);
      const buckets = phase === 2 ? [group.filter((o) => o.small), group.filter((o) => !o.small)] : [group];
      for (const b of buckets) {
        const seq = tour(b, pos);
        seq.forEach((o) => out.push(o));
        if (seq.length) pos = endOf(seq[seq.length - 1]);
      }
      cur = id;
    }
  }
  return out;
}
const endOf = (o) => { const m = o.moves[o.moves.length - 1]; return { x: m.x, y: m.y }; };
function tour(list, from) {
  const left = list.slice(), seq = [];
  let p = from;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((o, i) => { const d = dist(p, o.start); if (d < bd) { bd = d; bi = i; } });
    const o = left.splice(bi, 1)[0];
    seq.push(o); p = endOf(o);
  }
  // 2-opt sur les points de départ (utile pour les perçages, qui commencent et finissent au même endroit).
  if (seq.length > 3 && seq.length < 400 && seq.every((o) => dist(o.start, endOf(o)) < 1e-6)) {
    const d = (a, b) => dist(a.start, b.start);
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < seq.length - 2; i++) {
        for (let j = i + 2; j < seq.length; j++) {
          const a = i === 0 ? { start: from } : seq[i - 1];
          const before = d(a, seq[i]) + (j + 1 < seq.length ? d(seq[j], seq[j + 1]) : 0);
          const after = d(a, seq[j]) + (j + 1 < seq.length ? d(seq[i], seq[j + 1]) : 0);
          if (after < before - 1e-6) { seq.splice(i, j - i + 1, ...seq.slice(i, j + 1).reverse()); improved = true; }
        }
      }
    }
  }
  return seq;
}

// ---------------------------------------------------------------------------
// 5. Contrôles sur le programme final (indépendants de la façon dont il a été calculé) et durée.
// ---------------------------------------------------------------------------
function flatten(ops, cfg) {
  // Suite complète des déplacements, avec les montées/descentes de dégagement et les changements d'outil.
  const seq = [];
  let tool = null, p = null;
  for (const o of ops) {
    if (!tool || tool.id !== o.tool.id) { seq.push({ change: o.tool, feeds: o.feeds }); tool = o.tool; p = null; }
    seq.push({ g: 0, x: o.start.x, y: o.start.y, z: p ? cfg.clear : cfg.safe });
    seq.push({ g: 0, x: o.start.x, y: o.start.y, z: cfg.clear });
    seq.push({ g: 1, x: o.start.x, y: o.start.y, z: 0.5, f: o.moves[0].f });
    o.moves.forEach((m) => seq.push(m));
    p = endOf(o);
    seq.push({ g: 0, x: p.x, y: p.y, z: cfg.clear });
  }
  return seq;
}

function checkAndTime(seq, job, cfg) {
  const errors = [];
  const zMin = -(job.thickness + cfg.martyr_max);
  let p = { x: 0, y: 0, z: cfg.safe }, t = 0, len = { cut: 0, rapid: 0 }, changes = 0, zLow = 0;
  const bad = (m, why) => { if (errors.length < 8) errors.push(`${why} (X${round(m.x, 1)} Y${round(m.y, 1)} Z${round(m.z, 2)})`); };
  for (const m of seq) {
    if (m.change) { changes++; t += cfg.tool_change_s / 60; continue; }
    if (m.z < zMin - 1e-6) bad(m, `Profondeur au-delà du martyr autorisé (${round(-zMin, 2)} mm sous le dessus)`);
    if (m.x < -1e-6 || m.y < -1e-6 || m.x > cfg.table_x + 1e-6 || m.y > cfg.table_y + 1e-6) bad(m, 'Déplacement hors de la table');
    if (m.x > job.sheet_l + 1e-6 || m.y > job.sheet_w + 1e-6) { if (m.z < 0) bad(m, 'Usinage hors du panneau'); }
    if (m.g !== 0 && !(m.f > 0)) bad(m, 'Avance nulle');
    let L;
    if (m.g === 2 || m.g === 3) { const r = Math.hypot(m.i, m.j); L = 2 * Math.PI * r; } else L = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z);
    if (m.g === 0) { len.rapid += L; t += L / cfg.rapid; } else { len.cut += L; t += L / m.f; }
    zLow = Math.min(zLow, m.z);
    p = m;
  }
  return { errors, minutes: t + cfg.load_min, cut_m: len.cut / 1000, rapid_m: len.rapid / 1000, changes, zLow };
}

// ---------------------------------------------------------------------------
// 6. Tout le travail : imbrication + parcours + contrôles, panneau par panneau.
// ---------------------------------------------------------------------------
function compute(job, tools, cfg) {
  const errors = [], warnings = [];
  if (!(job.thickness > 0)) errors.push('Épaisseur du panneau à indiquer.');
  if (job.sheet_l > cfg.table_x || job.sheet_w > cfg.table_y) errors.push(`Le panneau ${job.sheet_l} × ${job.sheet_w} dépasse la table (${cfg.table_x} × ${cfg.table_y}).`);
  job.parts.forEach((p) => {
    if (!(p.l > 0 && p.w > 0)) errors.push(`${p.name} : dimensions à indiquer.`);
    if (p.opsErrors?.length) p.opsErrors.forEach((e) => errors.push(`${p.name} · ${e}`));
  });
  const contour = tools.find((t) => t.id === cfg.contour_tool_id) || tools.filter((t) => t.kind === 'fraise').sort((a, b) => b.diameter - a.diameter)[0];
  const gap = (contour ? contour.diameter : 8) + cfg.gap_extra;
  const parts = job.parts.filter((p) => p.l > 0 && p.w > 0);
  const n = nest(job.parts.map((p) => (parts.includes(p) ? p : { ...p, qty: 0 })), { sheet_l: job.sheet_l, sheet_w: job.sheet_w, margin: cfg.margin, gap });
  [...new Set(n.tooBig)].forEach((pi) => errors.push(`${job.parts[pi].name} ne rentre pas dans le panneau (${job.sheet_l} × ${job.sheet_w}, marges comprises).`));
  const sheets = n.sheets.map((pls, i) => {
    const sj = sheetJob(job, pls, cfg, tools);
    sj.ops.forEach((o) => { o.feeds = feedsFor(o.tool, job.material); });
    const seq = flatten(sj.ops, cfg);
    const chk = checkAndTime(seq, job, cfg);
    return { ...chk, index: i, placements: pls, ops: sj.ops, seq, errors: [...sj.errors, ...chk.errors], warnings: sj.warnings };
  });
  const allWarn = [...new Set([...warnings, ...sheets.flatMap((s) => s.warnings)])];
  const allErr = [...new Set([...errors, ...sheets.flatMap((s) => s.errors)])];
  return {
    sheets, errors: allErr, warnings: allWarn, yield: n.yield, gap,
    minutes: sheets.reduce((a, s) => a + s.minutes, 0), changes: sheets.reduce((a, s) => a + s.changes, 0),
    pieces: n.sheets.reduce((a, s) => a + s.length, 0),
  };
}

const DEFAULT_CFG = {
  table_x: 3100, table_y: 2100, safe: 25, clear: 5, rapid: 12000, tool_change_s: 15, load_min: 4,
  martyr_cut: 0.3, martyr_max: 1, margin: 10, gap_extra: 2, skin: 0.4, small_area: 0.06, min_part: 80,
  ramp: 40, climb: 1, zero: 'dessus', contour_tool_id: null, dry_offset: 25,
};

module.exports = { parseOps, formatOps, nest, compute, sheetJob, flatten, checkAndTime, passDepths, DEFAULT_CFG, toolLabel, feedsFor, OP_FIELDS };
