'use strict';
// Charge sur 12 semaines : heures prévues des fiches (envoyées ou non) face aux heures disponibles.
const express = require('express');
const { q } = require('../db');
const { h, layout, pill, postBtn, options, ddmm, today, addDays, parseDate, iso, hoursLabel } = require('../html');
const auto = require('../automations');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const WEEKS = 12;

function monday(s) { const d = parseDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); }
function isoWeek(s) { const d = parseDate(s); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const y = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - y) / 864e5 - 3 + ((y.getDay() + 6) % 7)) / 7); }

// Charge de chacun, semaine par semaine.
function compute() {
  const start = monday(today());
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(start, 7 * i));
  const avg = auto.averages();
  const people = L.people();
  return { weeks, rows: people.map((p) => {
    const { days, busy } = auto.allocate(p, { includeUnsent: true, avg });
    const perDay = (p.hours_week || 35) / 5;
    const cells = weeks.map((w) => {
      let hrs = 0, sentH = 0, cap = 0, absent = 0; const items = {};
      for (let i = 0; i < 5; i++) {
        const d = addDays(w, i);
        if (busy.has(d)) absent++; else if (d >= today()) cap += perDay;
        for (const x of days[d] || []) { hrs += x.hours; if (x.step.sent) sentH += x.hours; const k = x.step.id; items[k] = items[k] || { step: x.step, hours: 0 }; items[k].hours += x.hours; }
      }
      const pctv = cap ? Math.round(hrs / cap * 100) : 0;
      return { w, hrs, sentH, cap, absent, pct: pctv, items: Object.values(items) };
    });
    return { p, cells };
  }) };
}

const lv = (c) => (c.absent === 5 ? 'lvx' : c.pct > 100 ? 'lv3' : c.pct >= 90 ? 'lv2' : c.pct >= 70 ? 'lv1' : 'lv0');

r.get('/charge', (req, res) => {
  const { weeks, rows } = compute();
  const selP = Number(req.query.p) || rows[0]?.p.id;
  const selW = Math.max(0, Math.min(WEEKS - 1, Number(req.query.w) || 0));
  const sel = rows.find((x) => x.p.id === selP);
  const cell = sel?.cells[selW];
  const tot = (i) => rows.reduce((a, x) => ({ h: a.h + x.cells[i].hrs, c: a.c + x.cells[i].cap }), { h: 0, c: 0 });
  const four = [0, 1, 2, 3].map(tot).reduce((a, x) => ({ h: a.h + x.h, c: a.c + x.c }), { h: 0, c: 0 });
  const over = rows.flatMap((x) => x.cells.map((c, i) => ({ p: x.p, c, i }))).filter((x) => x.c.pct > 100 && x.i < 6);
  const absences = q.all('SELECT absences.*, people.name FROM absences JOIN people ON people.id = absences.person_id WHERE end_date >= ? ORDER BY start_date', today());
  const body = h`
<section class="kpis" style="margin-top:-30px">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Charge 4 semaines</span>${pill(four.c && four.h / four.c > 1 ? 'ko' : 'no', four.c ? `${Math.round(four.h / four.c * 100)} %` : '—')}</div><div class="big">${Math.round(four.h)} h</div><div class="sub2">prévues pour ${Math.round(four.c)} h disponibles</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Surcharges</span>${pill(over.length ? 'ko' : 'ok', over.length ? 'à régler' : 'aucune')}</div><div class="big">${over.length}</div><div class="sub2">semaine(s) personne au-delà de 100 %</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Pas encore envoyé</span>${pill('wa', 'carnets')}</div><div class="big">${Math.round(rows.reduce((a, x) => a + x.cells.reduce((b, c) => b + c.hrs - c.sentH, 0), 0))} h</div><div class="sub2">dans des OF lancés, pas encore à l'atelier</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Absences</span>${pill('no', 'à venir')}</div><div class="big">${absences.length}</div><div class="sub2">déduites de la capacité</div></div>
</section>
<section class="card" style="border-top:0">
<p class="mut">Chaque case = heures prévues de la personne cette semaine, face à ses heures disponibles (absences déduites). Les fiches sont posées dans l'ordre du planning automatique, y compris celles pas encore envoyées. Clique une case pour le détail.</p>
<div class="tablebox mt12"><div style="display:grid;grid-template-columns:180px repeat(${WEEKS},minmax(62px,1fr));gap:4px;min-width:980px">
<div></div>${weeks.map((w) => h`<div class="t12 b mut" style="text-align:center;letter-spacing:.1em">S${isoWeek(w)}<div style="font-weight:400">${ddmm(w)}</div></div>`)}
${rows.map((x) => h`<div class="line" style="gap:10px"><span class="ini">${x.p.ini}</span><div><b class="t15" style="display:block">${x.p.role === 'patron' ? 'Toi' : x.p.name}</b><span class="mut t12">${String(x.p.hours_week || 35).replace('.', ',')} h / semaine</span></div></div>
${x.cells.map((c, i) => h`<a class="cellh ${lv(c)}${x.p.id === selP && i === selW ? ' sel' : ''}" href="/charge?p=${x.p.id}&w=${i}" style="${x.p.id === selP && i === selW ? 'outline:2px solid var(--ink);outline-offset:-2px' : ''}" aria-label="${x.p.name} semaine ${isoWeek(c.w)} : ${c.absent === 5 ? 'absent' : c.pct + ' %'}">${c.absent === 5 ? 'Absent' : `${c.pct} %`}<small>${c.absent === 5 ? '' : `${Math.round(c.hrs)} h`}</small></a>`)}`)}
</div></div>
<div class="legend"><span><i class="c lv0" style="min-width:14px"></i>Moins de 70 %</span><span><i class="c lv1" style="min-width:14px"></i>70 à 90 %</span><span><i class="c lv2" style="min-width:14px"></i>90 à 100 %</span><span><i class="c lv3" style="min-width:14px"></i>Surcharge</span><span><i class="c lvx" style="min-width:14px"></i>Absent</span></div>
</section>
<div class="cols" style="margin-top:0">
<section class="card main-col"><h2>${sel ? `${sel.p.role === 'patron' ? 'Toi' : sel.p.name} · semaine ${isoWeek(cell.w)}` : 'Détail'}</h2>
${cell ? h`<p class="mut">${Math.round(cell.hrs)} h prévues pour ${Math.round(cell.cap)} h disponibles${cell.absent ? ` · ${cell.absent} jour(s) d'absence` : ''}</p>
${cell.items.map((it) => h`<div class="row"><span class="ref" style="width:110px">${it.step.pref}</span><a class="grow" href="/carnets/${it.step.project_id}?fiche=${it.step.id}">${it.step.title}<span class="mut t12" style="display:block">${it.step.pname}${it.step.sent ? '' : ' · pas encore envoyée'}</span></a><b>${hoursLabel(Math.round(it.hours * 4) / 4)}</b></div>`)}
${cell.items.length ? '' : h`<p class="mut">Rien de prévu.</p>`}
<p class="mut t12 mt12">Pour alléger : change la personne d'une fiche dans le carnet, décale l'échéance d'un OF, ou ajuste les heures prévues. La charge se recalcule aussitôt.</p>` : ''}
</section>
<section class="card side-col" id="absences"><h2>Absences</h2>
${absences.map((a, i) => h`<div class="who${i ? '' : ' f'}"><div class="grow"><b class="t14">${a.name} · ${a.label}</b><span class="mut t12">du ${ddmm(a.start_date)} au ${ddmm(a.end_date)}</span></div>${postBtn(`/charge/absences/${a.id}/supprimer`, '×', 'iconbtn', {}, 'Retirer cette absence ?')}</div>`)}
${absences.length ? '' : h`<p class="mut">Aucune absence prévue.</p>`}
<form method="post" action="/charge/absences" class="form mt12"><label>Qui <select name="person_id">${options(L.people().map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]))}</select></label>
<div class="grid2"><label>Du <input type="date" name="start_date" required></label><label>Au <input type="date" name="end_date" required></label></div>
<label>Motif <input name="label" value="Congé"></label><button class="btn alt sm">Ajouter</button></form>
</section></div>`;
  res.send(layout({ title: 'Charge', heading: 'Charge · 12 semaines', tab: 'charge', sub: '/charge', body, flash: req.flash }));
});

r.post('/charge/absences', (req, res) => {
  let s = str(req.body.start_date), e = str(req.body.end_date) || s; if (e < s) [s, e] = [e, s];
  q.run('INSERT INTO absences (person_id, start_date, end_date, label) VALUES (?, ?, ?, ?)', Number(req.body.person_id), s, e, str(req.body.label) || 'Congé');
  res.flashTo('/charge#absences', 'Absence ajoutée : planning et charge recalculés.');
});
r.post('/charge/absences/:id/supprimer', (req, res) => { q.run('DELETE FROM absences WHERE id = ?', req.params.id); res.redirect('/charge#absences'); });

module.exports = r;
module.exports.compute = compute;
module.exports.monday = monday;
