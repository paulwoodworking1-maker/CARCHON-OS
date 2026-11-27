'use strict';
// Patron : Aujourd'hui, recherche, liste des projets et fiche projet.
const express = require('express');
const { q, tx, PHASES, FAMILIES, SOURCES, logActivity } = require('../db');
const { icon, h, raw, layout, pill, avatar, postBtn, options, hidden, ddmm, longDate, today, addDays, rel, hoursLabel, dayMonth, hhmm } = require('../html');
const L = require('../logic');
const { upload, fileUrl, isImage } = require('../uploads');
const decideRow = (...a) => require('./decider').row(...a);
const SMS = require('../sms');
const Q = require('../qonto');

const r = express.Router();
const int = (v) => (v === undefined || v === '' || v === null ? null : Number(v));
const str = (v) => String(v ?? '').trim();
// « 8 400,50 € » -> 8400.5 ; vide -> null.
const euros = (v) => { const x = Number(String(v ?? '').replace(/[\s\u00a0\u202f€]/g, '').replace(',', '.')); return String(v ?? '').trim() && Number.isFinite(x) ? x : null; };

const friseBar = (fr) => h`<div class="bar" aria-hidden="true">${fr.map((f) => h`<i class="${f.state}" title="${f.phase} · ${f.label}"></i>`)}</div>`;

function projectCard(p) {
  return h`<a class="proj" href="/projets/${p.id}">
<div class="line"><span class="ref">${p.ref}</span><b class="t16">${p.name}</b>${p.descr ? h`<span class="mut">${p.descr}</span>` : ''}${pill('no', p.kind)}<span class="mut">${p.client ? p.client.name : 'hors commande client'}</span>
<span class="mut push">${p.due_date ? `Livraison ${ddmm(p.due_date)} · ` : ''}<b style="color:${p.slack.color}">${p.slack.text}</b></span></div>
${friseBar(p.cfrise)}
<div class="line"><span class="mut"><b class="ink">${p.cur.phase}</b> · ${p.next}</span><span class="push">${avatar(p.lead, 28)}</span></div></a>`;
}

// ---------- Aujourd'hui ----------
r.get('/', (req, res) => {
  const t = today();
  const projects = q.all("SELECT * FROM projects WHERE status = 'en_cours' ORDER BY due_date IS NULL, due_date").map(L.projectSummary);
  const decide = L.toDecide();
  const issues = q.all("SELECT issues.*, projects.name pname, people.name who FROM issues LEFT JOIN projects ON projects.id = issues.project_id LEFT JOIN people ON people.id = issues.person_id WHERE issues.status = 'open' ORDER BY issues.created_at DESC");
  const { weeks, rows } = require('./charge').compute();
  const tot = weeks.map((w, i) => rows.reduce((a, x) => ({ h: a.h + x.cells[i].hrs, c: a.c + x.cells[i].cap }), { h: 0, c: 0 }));
  const four = tot.slice(0, 4).reduce((a, x) => ({ h: a.h + x.h, c: a.c + x.c }), { h: 0, c: 0 });
  const worst = rows.flatMap((x) => x.cells.slice(0, 4).map((c, i) => ({ p: x.p, c, i }))).sort((a, b) => b.c.pct - a.c.pct)[0];
  const capMax = Math.max(...tot.map((x) => x.c), 1);
  const scaleMax = Math.max(capMax * 1.35, ...tot.map((x) => x.h), 1);
  const N = 16;
  const monthEnd = t.slice(0, 7) + '-31';
  const toDeliver = q.get("SELECT COUNT(*) n, COALESCE(SUM(qty), 0) pcs FROM projects WHERE status = 'en_cours' AND due_date BETWEEN ? AND ?", t, monthEnd);
  const late = projects.filter((p) => p.slack.text === 'en retard');
  const ready = q.get("SELECT COUNT(*) n, SUM(reserved_for != '') r FROM units WHERE status = 'en_stock'");
  const mach = require('../machines').all();
  const machDue = mach.flatMap((m) => [...(m.down_since ? [{ m, t: { title: 'En panne', st: { label: m.down_note || 'signalée' } }, down: true }] : []), ...m.tasks.filter((x) => x.st.late).map((x) => ({ m, t: x }))]);
  const crew = rows.map((x) => {
    const p = x.p;
    const doing = q.get(`SELECT steps.title, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE who_id = ? AND steps.status = 'doing' ORDER BY started_at DESC LIMIT 1`, p.id);
    const next = doing ? null : L.stepsFor(p.id)[0];
    return { p, line: doing ? doing.pname : next ? next.pname : 'Rien de prévu', sub: doing ? doing.title : next ? `Prochaine fiche : ${next.title}` : '', load: x.cells[0].pct };
  });
  const head = decide[0];
  const grouped = L.groupDecide(decide.slice(1));
  const shown = grouped.slice(0, 8);
  // Les OF les plus urgents d'abord : retard, puis marge la plus faible, puis échéance.
  const urg = (p) => (p.slack.text === 'en retard' ? 0 : p.slack.text === 'tendu' ? 1 : p.due_date ? 2 : 3);
  const urgent = [...projects].sort((a, b) => urg(a) - urg(b) || String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  const ofs = urgent.slice(0, 10).map((p) => {
    const hrs = q.get('SELECT COALESCE(SUM(declared_hours), 0) d, COALESCE(SUM(est_hours), 0) e, SUM(status = \'done\') nd, COUNT(*) n FROM steps WHERE project_id = ?', p.id);
    const pctv = hrs.n ? Math.round((hrs.nd || 0) / hrs.n * 100) : 0;
    return { p, hrs, pct: pctv };
  });
  const body = h`
<section class="band" style="padding-top:0;margin-top:-8px"><h2>Ton point du matin</h2><span class="count">${decide.length}</span><span class="count">${longDate(t)} · ${decide.length} décision${decide.length > 1 ? 's' : ''} · ${issues.length} problème${issues.length > 1 ? 's' : ''} signalé${issues.length > 1 ? 's' : ''} · ${machDue.length} alerte${machDue.length > 1 ? 's' : ''} machine</span></section>
${head ? h`<section class="row f" style="padding:22px 0;border-bottom:1px solid var(--line)"><span class="kind">${pill(head.kind, head.tag)}</span><div class="grow"><b class="t16">${head.title}</b><span class="mut">${head.text}</span></div>
${head.href2 ? h`<a class="btn" href="${head.href2}">${head.cta2}</a>` : ''}${head.ack ? postBtn(`/achats/besoin/${head.ack}/valider`, 'Valider', 'btn') : h`<a class="btn" href="${head.href}">${head.cta}</a>`}</section>` : ''}
<section class="kpis">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('load', 15)}Charge</span>${worst && worst.c.pct > 100 ? pill('ko', `${worst.p.role === 'patron' ? 'Toi' : worst.p.name} ${worst.c.pct} %`) : pill('ok', 'ça passe')}</div><div class="big">${four.c ? Math.round(four.h / four.c * 100) : 0} %</div><div class="sub2">des heures disponibles, 4 semaines</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('truck', 15)}À livrer</span>${pill('no', 'ce mois')}</div><div class="big">${toDeliver.n}</div><div class="sub2">OF · ${toDeliver.pcs} pièce${toDeliver.pcs > 1 ? 's' : ''}</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('cal', 15)}En retard</span>${pill(late.length ? 'ko' : 'ok', late.length ? 'prévu' : 'aucun')}</div><div class="big">${late.length}</div><div class="sub2">${late.map((p) => p.name).slice(0, 2).join(', ') || 'OF dans les temps'}</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">${icon('box', 15)}Prêtes</span>${pill('wa', `${ready.r || 0} réservée${(ready.r || 0) > 1 ? 's' : ''}`)}</div><div class="big">${ready.n}</div><div class="sub2">pièces contrôlées en stock</div></div>
</section>
<div class="split">
<section style="flex:2 1 560px"><div class="line"><h2 class="h-light">Charge de l'atelier</h2><a class="btn sm push" href="/charge">12 semaines</a></div>
<div class="big">${Math.round(four.h)} h</div><div class="sub2">prévues sur 4 semaines, pour ${Math.round(four.c)} h disponibles</div>
<div role="img" aria-label="Heures prévues par semaine face à la capacité" style="display:grid;grid-template-columns:repeat(${weeks.length},minmax(0,1fr));gap:6px;margin-top:26px;align-items:end">
${tot.map((x) => { const f = Math.round(x.h / scaleMax * N), cs = Math.round(x.c / scaleMax * N); return h`<div class="segcol">${Array.from({ length: N }, (_, i) => h`<i class="${i < Math.min(f, cs) ? 'f' : i < f ? 'o' : ''}"></i>`)}</div>`; })}</div>
<div style="display:grid;grid-template-columns:repeat(${weeks.length},minmax(0,1fr));gap:6px;margin-top:10px">${weeks.map((w) => h`<div class="mut t13" style="text-align:center">${ddmm(w)}</div>`)}</div>
<div class="legend"><span><i class="c" style="background:var(--sand);min-width:14px"></i>Prévu</span><span><i class="c" style="background:var(--overload);min-width:14px"></i>Au-delà de la capacité</span><span><i class="c" style="background:var(--line2);min-width:14px"></i>Disponible</span></div>
</section>
<section style="flex:1 1 340px"><div class="line"><h2 class="h-light">L'atelier aujourd'hui</h2><span class="count push">${crew.length} personne${crew.length > 1 ? 's' : ''}</span></div>
<div class="big" style="font-size:32px">${projects.length} OF en cours</div>
${crew.map((c, i) => h`<div class="who${i ? '' : ' f'}" style="margin-top:${i ? 0 : 10}px"><span class="ini">${c.p.ini}</span><div class="grow"><b class="t15">${c.p.role === 'patron' ? 'Toi' : c.p.name} · ${c.line}</b><span class="mut t13">${c.sub}</span></div><b class="t14" style="color:${c.load > 100 ? 'var(--red)' : 'var(--ink)'}">${c.load} %</b></div>`)}
${issues.map((s) => h`<div class="who">${pill('ko', 'Signalé')}<div class="grow"><b class="t14">${s.body}</b><span class="mut t12">${s.pname || ''} · ${s.who || ''} · ${rel(s.created_at)}</span></div><a class="btn alt sm" href="/projets/${s.project_id}#probleme">Traiter</a></div>`)}
${machDue.slice(0, 3).map((x) => h`<div class="who">${pill(x.down ? 'ko' : 'wa', x.down ? 'Panne' : 'Entretien')}<div class="grow"><b class="t14">${x.m.name} : ${x.t.title}</b><span class="mut t12">${x.t.st.label}</span></div><a class="btn alt sm" href="/machines?m=${x.m.id}">Voir</a></div>`)}
</section></div>
<section class="card" id="decider"><div class="line"><h2>À décider</h2>${pill(decide.length ? 'ko' : 'ok', decide.length)}<span class="mut push">Le plus urgent en haut</span>${decide.length ? h`<a class="btn alt sm" href="/decider">Tout voir</a>` : ''}</div>
${shown.length ? shown.map((d, i) => decideRow(d, i, { back: '/' })) : h`<p class="mut">Rien n'attend ta réponse.</p>`}
${grouped.length > shown.length ? h`<div class="line mt12"><a class="btn alt sm" href="/decider">${grouped.length - shown.length} autre${grouped.length - shown.length > 1 ? 's' : ''} sujet${grouped.length - shown.length > 1 ? 's' : ''} · tout voir</a></div>` : ''}
</section>
<section class="band" style="border-bottom:0"><h2>Ordres de fabrication</h2><span class="count">${projects.length}</span><span class="count">${projects.length > ofs.length ? `les ${ofs.length} plus urgents` : 'sur-mesure, boutique, revendeurs et salons'}</span>
<span class="line push"><a class="btn" href="/projets">Voir tous les OF</a><a class="btn dark" href="/catalogue">+ Lancer un OF</a></span></section>
<div class="tablebox"><table class="tbl dense" style="min-width:960px"><thead><tr><th>OF</th><th>Pièce</th><th>Canal et étape</th><th>Responsable</th><th class="num">Heures</th><th>Avancement</th><th>Fin prévue</th></tr></thead><tbody>
${ofs.map(({ p, hrs, pct: pc }) => h`<tr><td class="ref">${p.ref}</td><td><a class="b" href="/projets/${p.id}">${p.name}</a><div class="mut t12">${p.client ? p.client.name : p.for_whom || 'atelier'}</div></td>
<td>${pill('no', p.canal)} ${pill(p.cur.state === 'p' ? 'ko' : 'wa', p.cur.phase)}</td><td>${p.lead ? h`<span class="line" style="gap:8px"><span class="ini" style="width:26px;height:26px">${p.lead.ini}</span><b class="t14">${p.lead.role === 'patron' ? 'Toi' : p.lead.name}</b></span>` : '—'}</td>
<td class="num">${String(Math.round(hrs.d)).replace('.', ',')} / ${Math.round(hrs.e)} h</td>
<td><span class="line" style="gap:10px"><span class="segbar">${Array.from({ length: 20 }, (_, i) => h`<i class="${i < Math.round(pc / 5) ? (p.slack.text === 'en retard' ? 'o' : 'f') : ''}"></i>`)}</span><span class="t14">${pc} %</span></span></td>
<td class="b" style="color:${p.slack.text === 'en retard' ? 'var(--red)' : 'var(--ink)'}">${p.due_date ? ddmm(p.due_date) : 'à fixer'}<div class="t12" style="font-weight:400;color:${p.slack.color}">${p.slack.text}</div></td></tr>`)}
${ofs.length ? '' : h`<tr><td colspan="7" class="mut">Aucun OF en cours. Lance un lot depuis le catalogue, ou crée un OF sur-mesure.</td></tr>`}</tbody></table></div>`;
  res.send(layout({ title: 'Tableau de bord', tab: 'aujourdhui', sub: '/', body, flash: req.flash }));
});

// ---------- Recherche ----------
r.get('/recherche', (req, res) => {
  const s = str(req.query.q);
  const like = `%${s}%`;
  const projects = s ? q.all('SELECT projects.*, clients.name cname FROM projects LEFT JOIN clients ON clients.id = projects.client_id WHERE projects.name LIKE ? OR clients.name LIKE ? OR projects.notes LIKE ? LIMIT 30', like, like, like) : [];
  const steps = s ? q.all('SELECT steps.*, projects.name pname FROM steps JOIN projects ON projects.id = steps.project_id WHERE steps.title LIKE ? OR steps.note LIKE ? LIMIT 30', like, like) : [];
  const stock = s ? q.all('SELECT * FROM stock_items WHERE name LIKE ? LIMIT 20', like) : [];
  const sup = s ? q.all('SELECT * FROM suppliers WHERE name LIKE ? OR note LIKE ? LIMIT 20', like, like) : [];
  const body = h`<h1>Rechercher</h1>
<form class="line mt12" method="get"><label class="sr" for="q2">Recherche</label><input id="q2" class="qin" name="q" value="${s}" autofocus><button class="btn">Chercher</button></form>
${s ? h`<div class="stack12 mt20">
<section class="card"><h2>Projets</h2>${projects.map((p) => h`<div class="row"><a class="grow b" href="/projets/${p.id}">${p.name}</a><span class="mut">${p.cname || ''}</span></div>`)}${projects.length ? '' : h`<p class="mut">Aucun.</p>`}</section>
<section class="card"><h2>Fiches de fabrication</h2>${steps.map((x) => h`<div class="row"><a class="grow b" href="/carnets/${x.project_id}?fiche=${x.id}">${x.title}</a><span class="mut">${x.pname}</span></div>`)}${steps.length ? '' : h`<p class="mut">Aucune.</p>`}</section>
<section class="card"><h2>Stock et fournisseurs</h2>${stock.map((x) => h`<div class="row"><a class="grow" href="/stock">${x.name}</a><span class="mut">${x.category}</span></div>`)}${sup.map((x) => h`<div class="row"><a class="grow" href="/fournisseurs">${x.name}</a><span class="mut">${x.note}</span></div>`)}${stock.length + sup.length ? '' : h`<p class="mut">Rien.</p>`}</section>
</div>` : ''}`;
  res.send(layout({ title: 'Rechercher', tab: '', body }));
});

// ---------- Projets ----------
const CELL = { d: 'd', c: 'cc', p: 'p', w: 'w', n: 'n' };
r.get('/projets', (req, res) => {
  const done = req.query.vue === 'termines';
  const frise = req.query.vue === 'frise';
  const t = today(), week = addDays(t, 7), monthEnd = t.slice(0, 7) + '-31';
  const all = q.all(`SELECT * FROM projects WHERE status = ? ORDER BY ${done ? 'finished_at DESC' : 'due_date IS NULL, due_date'}`, done ? 'termine' : 'en_cours').map(L.projectSummary);
  // Avancement de tous les OF en une seule requête.
  const prog = Object.fromEntries(q.all("SELECT project_id, COUNT(*) n, SUM(status = 'done') d, SUM(sent = 0 OR changed = 1) unsent FROM steps GROUP BY project_id").map((x) => [x.project_id, x]));
  const FILTERS = {
    all: ['Tous', () => true],
    retard: ['En retard', (p) => p.slack.text === 'en retard'],
    tendu: ['Tendus', (p) => p.slack.text === 'tendu'],
    semaine: ['À livrer sous 7 j', (p) => p.due_date && p.due_date <= week],
    livrer: ['Ce mois', (p) => p.due_date && p.due_date <= monthEnd],
    bloque: ['À débloquer', (p) => p.cfrise.some((f) => f.state === 'p') || p.frise.some((f) => f.state === 'p')],
    acompte: ['Acompte attendu', (p) => p.client_id && p.deposit_needed && !p.deposit_at],
    envoyer: ['Carnet à envoyer', (p) => (prog[p.id] || {}).unsent > 0],
    sansdate: ['Sans échéance', (p) => !p.due_date],
  };
  const f = done ? 'all' : (FILTERS[req.query.f] ? req.query.f : 'all');
  const canal = String(req.query.canal || '');
  const resp = String(req.query.resp || '');
  const rows = all.filter(FILTERS[f][1]).filter((p) => !canal || p.canal === canal).filter((p) => !resp || String(p.lead_id) === resp);
  const qs = (o) => { const x = { f, canal, resp, vue: req.query.vue || '', ...o }; return '/projets?' + Object.entries(x).filter(([, v]) => v && v !== 'all').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'); };
  const here = qs({});
  const ppl = L.people();
  const body = h`
<div class="head"><div><div class="eb">Fabriquer</div><h1>${done ? 'OF terminés' : 'Ordres de fabrication'}</h1></div>
<span class="line push"><a class="btn alt" href="/catalogue">Lancer depuis le catalogue</a><a class="btn" href="/projets/nouveau">+ OF sur-mesure</a></span></div>
${done ? '' : h`<div class="chips mt12" role="group" aria-label="Filtrer">${Object.entries(FILTERS).map(([k, [l, fn]]) => { const n = all.filter(fn).length; return k !== 'all' && !n ? '' : h`<a class="chip${f === k ? ' on' : ''}${k === 'retard' && n ? ' hot' : ''}" href="${qs({ f: k })}">${l} · ${n}</a>`; })}</div>`}
<div class="line mt12 tools">
<label class="sr" for="flt">Filtrer la liste</label><input id="flt" class="qin" type="search" placeholder="Filtrer : nom, client, réf…  (touche /)" data-filter="#oftable" autocomplete="off">
<form method="get" action="/projets" class="line">${done ? h`<input type="hidden" name="vue" value="termines">` : h`<input type="hidden" name="f" value="${f === 'all' ? '' : f}">`}${frise ? h`<input type="hidden" name="vue" value="frise">` : ''}
<label class="sr" for="fresp">Responsable</label><select id="fresp" name="resp" data-auto><option value="">Tous les responsables</option>${options(ppl.map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]), resp)}</select>
<label class="sr" for="fcanal">Canal</label><select id="fcanal" name="canal" data-auto><option value="">Tous les canaux</option>${options([...new Set(all.map((p) => p.canal).filter(Boolean))], canal)}</select></form>
${done ? '' : h`<span class="push seg"><a class="chip${frise ? '' : ' on'}" href="${qs({ vue: '' })}">Liste</a><a class="chip${frise ? ' on' : ''}" href="${qs({ vue: 'frise' })}">Frise</a></span>`}
</div>
${done ? '' : h`<form method="post" action="/projets/lot" id="lot" class="lotbar" data-lot hidden>
<input type="hidden" name="back" value="${here}"><b data-lot-count>0 sélectionné</b>
<span class="line"><label class="sr" for="ldays">Décaler de</label><select id="ldays" name="days">${options([[7, '+ 1 semaine'], [14, '+ 2 semaines'], [3, '+ 3 jours'], [-7, '− 1 semaine']], 7)}</select><button class="btn alt sm" name="act" value="decaler">Décaler l'échéance</button></span>
<span class="line"><label class="sr" for="llead">Responsable</label><select id="llead" name="lead_id">${options(ppl.map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]))}</select><button class="btn alt sm" name="act" value="resp">Attribuer</button></span>
<button class="btn alt sm" name="act" value="envoyer">Envoyer les carnets</button>
<button class="btn alt sm" name="act" value="acompte">Acompte reçu aujourd'hui</button>
<button class="btn alt sm" name="act" value="terminer" data-confirm-btn="Marquer ces OF comme terminés ?">Terminer</button>
<button type="button" class="btn ghost sm push" data-lot-clear>Désélectionner</button></form>`}
${frise ? h`<div class="tablebox mt12"><table class="frise" id="oftable">
<thead><tr><th class="pcol">OF · prochaine action</th>${(rows[0]?.cfrise || L.clientSteps(null)).map((f) => h`<th>${f.phase}</th>`)}<th>Échéance</th></tr></thead>
<tbody>${rows.map((p) => h`<tr data-q="${[p.ref, p.name, p.client ? p.client.name : '', p.for_whom].join(' ').toLowerCase()}"><td class="pcol"><span class="ref">${p.ref}</span> <a href="/projets/${p.id}" class="b">${p.name}</a><div class="mut">${p.client ? p.client.name : p.for_whom || 'atelier'} → ${p.next}</div></td>
${p.cfrise.map((c) => h`<td><span class="c ${CELL[c.state]}">${c.label}</span></td>`)}
<td class="due"><b>${p.due_date ? ddmm(p.due_date) : 'à fixer'}</b><div style="color:${p.slack.color}" class="t12 b">${p.slack.text}</div></td></tr>`)}</tbody></table></div>
<div class="legend"><span><i class="c d"></i>Fait</span><span><i class="c cc"></i>En cours</span><span><i class="c p"></i>Bloque · à traiter</span><span><i class="c w"></i>À venir</span><span><i class="c n"></i>Sans objet</span></div>`
  : h`<div class="tablebox mt12"><table class="tbl dense" id="oftable">
<thead><tr>${done ? '' : h`<th class="ck"><input type="checkbox" data-lot-all aria-label="Tout sélectionner"></th>`}<th data-sort>Réf.</th><th data-sort>Projet</th><th data-sort>Où en est le projet</th><th data-sort class="num">Fiches</th><th data-sort>Livraison</th><th data-sort>Marge</th></tr></thead>
<tbody>${rows.map((p) => { const g = prog[p.id] || { n: 0, d: 0 }; const pc = g.n ? Math.round(g.d / g.n * 100) : 0; const urgv = p.slack.text === 'en retard' ? -1000 : p.slack.text === 'tendu' ? -500 : parseInt(p.slack.text, 10) || 9999;
    return h`<tr data-q="${[p.ref, p.name, p.descr, p.client ? p.client.name : '', p.for_whom, p.canal, p.cur.phase].join(' ').toLowerCase()}">
${done ? '' : h`<td class="ck"><input type="checkbox" name="ids" value="${p.id}" form="lot" aria-label="Sélectionner ${p.name}"></td>`}
<td class="ref" data-v="${p.ref}">${p.ref}</td>
<td class="ofname" data-v="${p.name}"><a class="b" href="/projets/${p.id}">${p.name}</a> <span class="mut">${p.descr || (p.client ? '' : p.for_whom || '')}</span>${(g.unsent || 0) > 0 && !done ? h` <span class="dot-wa" title="Carnet à envoyer à l’atelier">à envoyer</span>` : ''}</td>
${(() => { const ci = p.cfrise.findIndex((x) => x.state !== 'd'); const c = p.cfrise[ci < 0 ? p.cfrise.length - 1 : ci];
    return h`<td class="where" data-v="${ci < 0 ? 99 : ci}"><div class="line" style="gap:8px;flex-wrap:nowrap"><b class="${c.state === 'p' ? 'red' : ''}">${c.phase}</b><span class="mut t12">${c.label === 'À venir' || c.label === 'En cours' ? '' : c.label}</span></div>${friseBar(p.cfrise)}</td>`; })()}
<td class="num" data-v="${pc}">${g.n ? `${g.d}/${g.n}` : '—'}</td>
<td data-v="${p.due_date || '9999'}" class="b">${p.due_date ? ddmm(p.due_date) : 'à fixer'}</td>
<td data-v="${done ? p.finished_at || '' : urgv}" class="t13 b" style="color:${p.slack.color}">${done ? (p.finished_at ? `terminé ${ddmm(p.finished_at)}` : '') : p.slack.text}</td></tr>`; })}
${rows.length ? '' : h`<tr><td colspan="7" class="mut">Aucun OF dans ce filtre.</td></tr>`}</tbody></table></div>
<p class="mut mt8" data-filter-count>${rows.length} OF affiché${rows.length > 1 ? 's' : ''}. Clique sur un titre de colonne pour trier. Coche plusieurs OF pour agir sur tous d'un coup.</p>`}`;
  res.send(layout({ title: done ? 'OF terminés' : 'Ordres de fabrication', tab: 'projets', sub: done ? '/projets?vue=termines' : '/projets', body, flash: req.flash }));
});

// Actions sur plusieurs OF d'un coup.
r.post('/projets/lot', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const back = String(req.body.back || '/projets').startsWith('/projets') ? String(req.body.back) : '/projets';
  if (!ids.length) return res.flashTo(back, 'Coche au moins un OF.', 'ko');
  const list = ids.map((id) => q.get('SELECT * FROM projects WHERE id = ?', id)).filter(Boolean);
  const act = req.body.act;
  let msg = '';
  tx(() => {
    for (const p of list) {
      if (act === 'decaler') {
        const days = Math.max(-60, Math.min(120, Number(req.body.days) || 7));
        if (!p.due_date) continue;
        const nd = addDays(p.due_date, days);
        q.run('UPDATE projects SET due_date = ? WHERE id = ?', nd, p.id);
        logActivity(p.id, null, `Date de livraison : ${ddmm(nd)} (au lieu du ${ddmm(p.due_date)})`, 'Patron');
        msg = `Échéance décalée de ${days} jour${Math.abs(days) > 1 ? 's' : ''}.`;
      } else if (act === 'resp') {
        const lead = int(req.body.lead_id);
        q.run('UPDATE projects SET lead_id = ? WHERE id = ?', lead, p.id);
        logActivity(p.id, null, `Responsable : ${L.personName(q.get('SELECT * FROM people WHERE id = ?', lead))}`, 'Patron');
        msg = 'Responsable attribué.';
      } else if (act === 'envoyer') {
        const n = q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ? AND (sent = 0 OR changed = 1)', p.id).n;
        if (!n) continue;
        q.run('UPDATE steps SET sent = 1, changed = 0 WHERE project_id = ? AND (sent = 0 OR changed = 1)', p.id);
        q.run("UPDATE projects SET sent_to_atelier_at = datetime('now') WHERE id = ?", p.id);
        logActivity(p.id, null, `Carnet envoyé à l’atelier (${n} fiche${n > 1 ? 's' : ''})`, 'Patron');
        msg = 'Carnets envoyés à l’atelier.';
      } else if (act === 'acompte') {
        if (!p.client_id || p.deposit_at) continue;
        q.run("UPDATE projects SET deposit_at = date('now', 'localtime') WHERE id = ?", p.id);
        q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
        logActivity(p.id, null, `Acompte reçu le ${ddmm(today())}`, 'Patron');
        SMS.notify('acompte', { projectId: p.id });
        msg = 'Acomptes notés. Les achats bloqués sont débloqués.';
      } else if (act === 'terminer') {
        q.run("UPDATE projects SET status = 'termine', finished_at = datetime('now') WHERE id = ?", p.id);
        logActivity(p.id, null, 'Projet terminé', 'Patron');
        msg = 'OF terminés.';
      }
    }
  });
  res.flashTo(back, msg ? `${msg} (${list.length} OF)` : 'Rien à changer sur ces OF.', msg ? 'ok' : 'ko');
});

r.get('/projets/nouveau', (req, res) => {
  const body = h`<div class="eb"><a href="/projets">Projets</a></div><h1>Nouveau projet</h1>
<form method="post" action="/projets/nouveau" class="card form mt20" style="max-width:640px">
<label>Ce qu'on fabrique <input name="descr" placeholder="ex. Agencement bureau · mélaminé blanc et chêne"></label>
<p class="mut">Le titre du projet est le nom du client, en majuscules. Sans client (stock, salon…), indique un nom :</p><label>Nom (projets sans client) <input name="name" placeholder="ex. Série de tabourets"></label>
<p class="mut">Pour une pièce du catalogue, lance plutôt un lot depuis le <a href="/catalogue">catalogue</a> : nomenclature, carnet et numéros sont repris.</p>
<div class="grid2"><label>Canal <select name="canal">${options(['Sur-mesure', 'Boutique', 'Revendeur', 'Salon', 'Stock'], 'Sur-mesure')}</select></label>
<label>Type <select name="kind">${options(['Particulier', 'Architecte', 'Professionnel', 'Atelier', 'Reprise'], 'Particulier')}</select></label></div>
<label>Pour (client, revendeur, salon…) <input name="for_whom"></label>
<label>Client (base Cockpit) <input name="client_pick" list="clientbase" placeholder="Tape le nom, l’e-mail ou la ville" autocomplete="off"></label>
<datalist id="clientbase">${q.all('SELECT id, name, email, address FROM clients ORDER BY name').map((c) => h`<option value="${c.name}${c.email ? ` · ${c.email}` : ''} #${c.id}">${c.address || ''}</option>`)}</datalist>
<div class="grid2"><label>Échéance <input type="date" name="due_date"></label>
<label>Responsable <select name="lead_id">${options(L.people().map((p) => [p.id, p.role === 'patron' ? 'Toi' : p.name]))}</select></label></div>
<fieldset class="card warm m0"><legend class="b">Portail du client</legend>
<p class="mut t13">Réglé une fois ici, à la création. Sans client choisi, ces réglages sont ignorés.</p>
<label class="ck"><input type="checkbox" name="open_portal" value="1" checked> Ouvrir son espace de suivi tout de suite</label>
<div class="grid2"><label>Civilité <select name="civility">${options([['', 'Deviner d’après le prénom'], ['Mme', 'Mme'], ['M.', 'M.'], ['none', 'Aucune']], '')}</select></label>
<label>Portable (SMS de suivi) <input type="tel" name="phone" placeholder="06 12 34 56 78"></label></div>
<div class="grid2"><label>Nom <input name="last_name" placeholder="vide = repris de la fiche client"></label><label>Prénom <input name="first_name" placeholder="vide = repris de la fiche client"></label></div>
<div class="grid2"><label>Montant vendu HT (€) <input name="amount_ht" inputmode="decimal" placeholder="ex. 8400"></label>
<label class="ck" style="align-self:end"><input type="checkbox" name="deposit_needed" value="1" checked> Acompte demandé</label></div>
<label class="ck"><input type="checkbox" name="sms_on" value="1" checked> Prévenir le client par SMS à chaque nouveauté</label></fieldset>
<button class="btn">Créer le projet</button></form>`;
  res.send(layout({ title: 'Nouveau projet', tab: 'projets', sub: '/projets', body }));
});
// Client choisi, ou créé à la volée (nom + e-mail).
function clientFrom(b) {
  const pick = /#(\d+)\s*$/.exec(str(b.client_pick));
  if (pick) return Number(pick[1]);
  if (str(b.client_pick)) { const c = q.get('SELECT id FROM clients WHERE lower(name) = lower(?)', str(b.client_pick)); if (c) return c.id; }
  if (str(b.client_name)) {
    const ex = str(b.client_email) ? q.get('SELECT id FROM clients WHERE lower(email) = lower(?)', str(b.client_email)) : null;
    return ex ? ex.id : Number(q.run('INSERT INTO clients (name, email, phone, kind) VALUES (?, ?, ?, ?)', str(b.client_name), str(b.client_email), str(b.client_phone), str(b.kind) || 'Particulier').lastInsertRowid);
  }
  return int(b.client_id);
}
r.post('/projets/nouveau', (req, res) => {
  const b = { ...req.body, client_id: clientFrom(req.body) };
  if (!b.client_id && !str(b.name) && !str(b.descr)) return res.flashTo('/projets/nouveau', 'Choisis un client (le titre du projet sera son nom) ou indique un nom.', 'ko');
  const id = q.run('INSERT INTO projects (name, descr, kind, canal, for_whom, client_id, due_date, lead_id, deposit_needed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    str(b.name) || str(b.descr), str(b.descr), str(b.kind), str(b.canal) || 'Sur-mesure', str(b.for_whom), int(b.client_id), str(b.due_date) || null, int(b.lead_id), b.client_id ? 1 : 0).lastInsertRowid;
  L.syncProjectName(Number(id));
  logActivity(Number(id), null, 'Projet créé', 'Patron');
  let opened = false;
  if (b.client_id) {
    const C = require('../civilite');
    const sets = [], vals = [];
    if (['Mme', 'M.', 'none'].includes(b.civility)) { sets.push('civility = ?'); vals.push(b.civility); }
    if (str(b.last_name)) { sets.push('last_name = ?'); vals.push(C.tidy(str(b.last_name))); }
    if (str(b.first_name)) { sets.push('first_name = ?'); vals.push(C.tidy(str(b.first_name))); }
    if (str(b.phone)) { sets.push('phone = ?'); vals.push(str(b.phone)); }
    sets.push('sms_off = ?'); vals.push(b.sms_on ? 0 : 1);
    q.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, ...vals, b.client_id);
    q.run('UPDATE projects SET deposit_needed = ?, amount_ht = ?, deposit_asked_at = CASE WHEN ? THEN datetime(\'now\') END WHERE id = ?', b.deposit_needed ? 1 : 0, euros(b.amount_ht), b.deposit_needed ? 1 : 0, id);
    if (b.open_portal) opened = !!require('./portails').openSpace(req, Number(id));
  }
  res.flashTo(`/projets/${id}`, opened ? 'Projet créé et espace client ouvert : « Copier le lien du portail » dans l’onglet Client et documents.' : 'Projet créé. Prépare son carnet de fabrication quand tu es prêt.');
});

// ---------- Dossier de production : étapes 07 à 09 ----------
function studyOf(p) {
  const CH = require('../chaine'); const c = CH.get(p.id);
  if (!c) return { c: null, x: null, ens: [] };
  let x = null; try { x = CH.compute(p.id, c.params, c.study); } catch { x = null; }
  const ens = (c.study?.ensembles || []).map((e) => ({ nom: e.nom, L: Number(e.largeur) || 0, H: Number(e.hauteur) || 0, P: Number(e.profondeur) || 0 }));
  return { c, x, ens };
}
const mm = (v) => `${Math.round(v).toLocaleString('fr-FR')} mm`;
function assemblageBlock(p) {
  const { x, ens } = studyOf(p);
  const steps = q.all('SELECT * FROM steps WHERE project_id = ? ORDER BY ord, id', p.id);
  const pm = L.peopleMap();
  const est = steps.reduce((a, t) => a + (t.est_hours || 0), 0);
  const doneS = steps.filter((t) => t.status === 'done' && t.declared_hours != null);
  const e1 = doneS.reduce((a, t) => a + (t.est_hours || 0), 0), r1 = doneS.reduce((a, t) => a + t.declared_hours, 0);
  const ctrl = ens.length ? ens : x?.dims ? [{ nom: 'Ensemble', txt: x.dims }] : [];
  return h`<div class="cols dz-cols"><div class="main-col"><section class="card" id="carnet"><div class="line"><h2>Fiches de l’atelier</h2><span class="count">${steps.length}</span>
<span class="push line"><a class="btn alt sm" href="/carnets/${p.id}/imprimer">Imprimer</a><a class="btn sm" href="/carnets/${p.id}">Ouvrir le carnet</a></span></div>
${steps.length ? h`<ol class="dz-fiche">${steps.map((t) => h`<li class="${t.status}"><div class="grow"><a class="b" href="/carnets/${p.id}?fiche=${t.id}">${t.piece ? `${t.piece} · ` : ''}${t.title}</a>
<span class="mut t12">${[pm[t.who_id] ? (pm[t.who_id].role === 'patron' ? 'toi' : pm[t.who_id].name) : 'à attribuer', t.geste, t.sent ? '' : 'pas encore envoyée'].filter(Boolean).join(' · ')}</span></div>
<span class="t12 dz-h">${t.est_hours ? hoursLabel(t.est_hours) : '—'}${t.declared_hours != null ? h`<b> → ${hoursLabel(t.declared_hours)}</b>` : ''}</span>${t.status === 'done' ? pill('ok', 'Fait') : t.status === 'doing' ? pill('wa', 'En cours') : ''}</li>`)}</ol>`
  : h`<p class="mut">Pas encore de fiche : envoie la chaîne au carnet (étape 05) ou génère le carnet depuis les plans, ci-dessous.</p>`}</section></div>
<aside class="side-col"><section class="card"><h2>Cotes de contrôle</h2>
${ctrl.length ? h`<table class="tbl mt8"><tbody>${ctrl.map((e) => (e.txt ? h`<tr><td>${e.nom}</td><td class="num b">${e.txt}</td></tr>` : h`<tr><td>${e.nom}<div class="mut t12">diagonale de face (équerrage)</div></td><td class="num"><b>${e.L} × ${e.H} × ${e.P}</b><div class="mut t12">${mm(Math.hypot(e.L, e.H))} ± 2</div></td></tr>`))}</tbody></table>`
  : h`<p class="mut">Les cotes apparaissent quand l’étude du devis (étape 01) est faite.</p>`}</section>
<section class="card"><h2>Prévu et réel</h2><table class="tbl mt8"><tbody>
<tr><td>Temps prévu au carnet</td><td class="num b">${hoursLabel(est)}</td></tr>
<tr><td>Fiches finies avec un temps</td><td class="num">${doneS.length} / ${steps.length}</td></tr>
${doneS.length ? h`<tr><td>Sur ces fiches : prévu → réel</td><td class="num b" style="color:${r1 > e1 * 1.1 ? 'var(--red)' : 'var(--ink)'}">${hoursLabel(e1)} → ${hoursLabel(r1)}</td></tr>` : ''}
</tbody></table></section></aside></div>`;
}
function poseBlock(p) {
  const { x, ens } = studyOf(p);
  const trips = q.all('SELECT * FROM trips WHERE project_id = ? ORDER BY date', p.id);
  const next = trips.find((t) => !t.done_at) || null;
  const items = next ? (() => { try { return JSON.parse(next.items || '[]'); } catch { return []; } })() : [];
  // Colis : un par ensemble, poids estimé depuis les pièces de l'étude (panneaux ~ 700 kg/m³).
  const kgOf = (name) => (x?.lines || []).filter((l) => !name || l.ensemble === name).reduce((a, l) => a + (Number(l.len) * Number(l.wid) * Number(l.ep) * (Number(l.qty) || 1)) * 7e-7, 0);
  const colis = ens.length ? ens.map((e) => ({ n: e.nom, d: `${e.H} × ${e.L} × ${e.P}`, kg: kgOf(e.nom) })) : x ? [{ n: 'Ouvrage', d: x.dims || '', kg: kgOf('') }] : [];
  const kgMax = Math.max(0, ...colis.map((c) => c.kg));
  const camion = items.length ? items : ['Couvertures et sangles', 'Cornières de protection', 'Visserie et fixations murales', 'Niveau, perceuse, visseuse', 'Cales de réglage', 'Chiffon et produit de retouche', 'iPad chargé pour le PV'].map((t) => ({ t, done: false }));
  return h`<div class="cols dz-cols"><div class="main-col"><section class="card"><h2>Colisage</h2>
${colis.length ? h`<div class="tablebox mt8"><table class="tbl"><thead><tr><th>Colis</th><th class="num">Dimensions</th><th class="num">Poids estimé</th></tr></thead><tbody>
${colis.map((c) => h`<tr><td>${c.n}</td><td class="num">${c.d}</td><td class="num">${c.kg ? `${Math.round(c.kg)} kg` : '—'}</td></tr>`)}</tbody></table></div>
<p class="mut t12 mt8">${kgMax > 35 ? 'Un colis dépasse 35 kg : prévoir deux personnes.' : 'Colis portables par une personne.'}${next ? ` Prochaine date : ${ddmm(next.date)}${next.team ? ` · ${next.team}` : ''}.` : ''}</p>`
  : h`<p class="mut">Le colisage se calcule depuis l’étude du devis (étape 01).</p>`}</section></div>
<aside class="side-col"><section class="card"><h2>Dans le camion</h2>${next ? h`<p class="mut t12">Coché depuis l’iPad la veille de la pose.</p>` : ''}
<ul class="dz-checks">${camion.map((it) => h`<li class="${it.done ? 'on' : ''}"><span class="box">${it.done ? '✓' : ''}</span>${it.t}</li>`)}</ul></section>
<section class="card"><h2>Procès-verbal</h2>${trips.filter((t) => t.pv_signed_at).map((t) => h`<div class="who f"><span class="grow">Signé le ${ddmm(t.pv_signed_at)}${t.pv_reserves ? h`<span class="mut t12 red">Réserve : ${t.pv_reserves}${t.pv_reserves_lifted_at ? ' (levée)' : ''}</span>` : h`<span class="mut t12">sans réserve</span>`}</span><a class="btn alt sm" href="/poses/${t.id}/pv">Voir</a></div>`)}
${trips.some((t) => t.pv_signed_at) ? '' : next ? h`<p class="mut">Signé sur l’iPad à la pose.</p><a class="btn alt sm mt8" href="/poses/${next.id}/pv">Ouvrir le PV</a>` : h`<p class="mut">Ajoute d’abord une date de pose ci-dessous.</p>`}</section></aside></div>`;
}
function retourBlock(p) {
  const rows = q.all(`SELECT COALESCE(NULLIF(geste, ''), 'Autre') g, COUNT(*) n, SUM(est_hours) e, SUM(declared_hours) d FROM steps
    WHERE project_id = ? AND status = 'done' AND declared_hours IS NOT NULL GROUP BY g ORDER BY (SUM(declared_hours) - SUM(est_hours)) DESC`, p.id);
  const rate = Number(String(require('../db').setting('hourly_rate', '0')).replace(',', '.')) || Number(require('../db').setting('obj_rate', '78')) || 78;
  const added = q.get('SELECT COUNT(*) n, COALESCE(SUM(declared_hours), 0) h FROM steps WHERE project_id = ? AND added_by_atelier = 1', p.id);
  const res = q.all("SELECT pv_reserves FROM trips WHERE project_id = ? AND pv_reserves != ''", p.id);
  const sav = q.get('SELECT COUNT(*) n FROM sav WHERE project_id = ?', p.id).n;
  const E = rows.reduce((a, r0) => a + (r0.e || 0), 0), D = rows.reduce((a, r0) => a + (r0.d || 0), 0);
  return h`<div class="cols dz-cols"><div class="main-col"><section class="card"><h2>Prévu contre réel, par geste</h2>
${rows.length ? h`<div class="tablebox mt8"><table class="tbl"><thead><tr><th>Geste</th><th class="num">Fiches</th><th class="num">Prévu</th><th class="num">Réel</th><th class="num">Écart</th></tr></thead><tbody>
${rows.map((r0) => { const g = r0.e ? (r0.d - r0.e) / r0.e : null; return h`<tr><td>${r0.g}</td><td class="num">${r0.n}</td><td class="num">${hoursLabel(r0.e || 0)}</td><td class="num b">${hoursLabel(r0.d)}</td><td class="num" style="color:${g > 0.1 ? 'var(--red)' : 'var(--ink)'}">${g == null ? '—' : `${g > 0 ? '+' : ''}${Math.round(g * 100)} %`}</td></tr>`; })}
<tr class="b"><td>Total</td><td></td><td class="num">${hoursLabel(E)}</td><td class="num">${hoursLabel(D)}</td><td class="num">${E ? `${D >= E ? '+' : ''}${Math.round((D - E) / E * 100)} %` : '—'}</td></tr></tbody></table></div>
<p class="mt8">${D > E ? h`<b>${hoursLabel(D - E)} de plus que prévu</b>, soit environ ${Math.round((D - E) * rate).toLocaleString('fr-FR')} € au taux de ${rate} € / h. Corrige ces gestes dans le barème avant le prochain devis du même type.` : E ? 'Chiffrage tenu : le barème est bon pour ce type de projet.' : ''}</p>`
  : h`<p class="mut">Se remplit au fil des fiches finies à l’atelier (« Ça t’a pris combien ? »).</p>`}</section></div>
<aside class="side-col"><section class="card"><h2>À retenir</h2><table class="tbl mt8"><tbody>
<tr><td>Tâches ajoutées par l’atelier</td><td class="num b">${added.n}${added.h ? ` · ${hoursLabel(added.h)}` : ''}</td></tr>
<tr><td>Réserves au PV</td><td class="num b">${res.length}</td></tr>
<tr><td>Demandes SAV</td><td class="num b">${sav}</td></tr></tbody></table>
${res.map((r0) => h`<p class="mut t12 mt8">« ${r0.pv_reserves} »</p>`)}
<p class="mut t12 mt8">Toutes les affaires : <a href="/analyse#chiffrage">Analyse › Chiffrage</a>.</p></section></aside></div>`;
}

// ---------- Achats du projet : rangés comme le stock, au prix le plus bas des catalogues ----------
function achatsCard(p) {
  const P = require('../prix');
  const groups = P.projectNeeds(p.id);
  const eur = (v) => (v == null ? '—' : `${(Math.round(v * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
  const n = groups.reduce((a, g) => a + g.items.length, 0);
  const total = groups.reduce((a, g) => a + g.total, 0);
  const priced = groups.some((g) => g.items.some((x) => x.best));
  const state = (x) => (x.status === 'ordered' ? pill('wa', 'Commandé') : x.needs_deposit && !x.force ? pill('ko', 'Attend l’acompte') : pill('no', 'À commander'));
  return h`<section class="card" id="achats-projet"><div class="line"><h2>Achats du projet</h2><span class="count">${n}</span>
<span class="push line">${priced ? postBtn(`/projets/${p.id}/achats/meilleurs`, 'Attribuer au moins cher', 'btn alt sm') : ''}<a class="btn ghost sm" href="/achats">Tous les achats</a></span></div>
${n ? h`<p class="mut">${priced ? h`Comparé dans les catalogues fournisseurs : <b>${eur(total)} HT</b> au total au meilleur prix.` : h`Aucun prix trouvé : dépose les tarifs de tes fournisseurs dans <a href="/fournisseurs#catalogues">Fournisseurs › Catalogues</a>.`}</p>
${groups.map((g) => h`<h3 class="h3 mt20">${g.cat}${g.total ? h` <span class="mut">· ${eur(g.total)}</span>` : ''}</h3>
<div class="tablebox"><table class="tbl dense"><thead><tr><th>Article</th><th class="num">Qté</th><th>Référence</th><th>Fournisseur</th><th class="num">Prix u.</th><th class="num">Total</th><th>État</th></tr></thead><tbody>
${g.items.map((x) => h`<tr><td>${x.text}${x.offers.length > 1 ? h`<div class="mut t12">${x.offers.length} offres · jusqu’à ${eur(x.saving)} d’écart</div>` : ''}</td>
<td class="num">${String(x.qty).replace('.', ',')}${x.unit ? ` ${x.unit}` : ''}</td>
<td class="mono">${x.best?.ref || '—'}</td>
<td>${x.best ? h`<b>${x.best.sname}</b>${x.best.pack ? h`<div class="mut t12">${x.best.pack}</div>` : ''}` : x.sname || h`<span class="mut">—</span>`}</td>
<td class="num">${x.best ? eur(x.best.price) : '—'}</td><td class="num b">${x.total != null ? eur(x.total) : '—'}</td><td>${state(x)}</td></tr>`)}
</tbody></table></div>`)}` : h`<p class="mut">Rien à acheter pour ce projet. La matière arrive ici quand la chaîne de production est générée, ou quand l’atelier signale un manque.</p>`}
</section>`;
}
r.post('/projets/:id/achats/meilleurs', loadProject, (req, res) => {
  const P = require('../prix'); let n = 0;
  for (const g of P.projectNeeds(req.project.id)) for (const x of g.items) if (x.best && x.status !== 'ordered') { q.run('UPDATE needs SET supplier_id = ?, category = ? WHERE id = ?', x.best.supplier_id, g.cat, x.id); n++; }
  res.flashTo(`/projets/${req.project.id}#achats`, `${n} article(s) attribué(s) au fournisseur le moins cher : ils sont regroupés par fournisseur dans Achats.`);
});

// ---------- Chaîne de production (devis + 3D + chiffrage → carnet, matière, planning) ----------
function chainCard(p) {
  const C = require('../chain');
  const { files } = C.filesFor(p.id);
  const m = C.material(p.id);
  const nSteps = q.get('SELECT COUNT(*) n, SUM(sent = 0) unsent FROM steps WHERE project_id = ?', p.id);
  const ai = require('../ai').enabled();
  const st = p.prod_status;
  if (p.status !== 'en_cours' && !st) return '';
  return h`<section class="card mt20" id="chaine"><div class="line"><h2>Chaîne de production</h2>
${pill(st === 'pret' ? 'ok' : st === 'erreur' ? 'ko' : st === 'en_cours' ? 'wa' : 'no', st === 'pret' ? `Générée ${rel(p.prod_at)}` : st === 'erreur' ? 'Non générée' : st === 'en_cours' ? 'L’assistant prépare…' : 'Pas encore générée')}
<span class="push line">${st === 'pret' && nSteps.unsent ? h`<a class="btn sm" href="/carnets/${p.id}">Vérifier et envoyer le carnet (${nSteps.unsent} fiches)</a>` : ''}
${st !== 'en_cours' ? h`<form method="post" action="/projets/${p.id}/chaine/claude" class="inline" data-views><button class="btn sm">${st === 'pret' ? 'Refaire avec Claude (forfait)' : 'Préparer la production avec Claude'}</button></form>` : ''}
${ai && st !== 'en_cours' ? h`<form method="post" action="/projets/${p.id}/chaine/generer" class="inline" data-views data-confirm="Générer par l’API Anthropic (facturé à l’usage, environ 1 à 3 € par projet) ?"><button class="btn ghost sm">Par l’API</button></form>` : ''}</span></div>
${st === 'en_cours' ? h`<p class="mut mt8">L’assistant (Opus 5.5, réflexion maximale) étudie le devis, le modèle 3D et le chiffrage : compte 3 à 10 minutes. Recharge la page.</p>` : ''}
${st === 'erreur' ? h`<p class="flash ko mt8">${p.prod_error}</p>` : ''}
${p.prod_note ? h`<p class="mt8"><span class="mut">Remarques de l’assistant :</span> ${p.prod_note}</p>` : ''}

${(() => { const m3 = q.get("SELECT * FROM documents WHERE project_id = ? AND kind = 'modele3d' ORDER BY id DESC LIMIT 1", p.id) || (() => { const f = files.find((x) => x.kind === 'modele3d'); return f ? { id: 'q' + q.get('SELECT id FROM quote_files WHERE file = ?', f.file).id, title: f.name } : null; })();
    return m3 ? h`<script type="importmap">${raw(require('../html').INLINE.importmap3d)}</script>
<div class="v3d mt12" data-model="/projets/${p.id}/3d/${m3.id}"><div class="v3d-msg mut">Chargement du modèle 3D…</div>
<div class="v3d-bar"><button type="button" class="chip" data-view="iso">3D</button><button type="button" class="chip" data-view="face">Face</button><button type="button" class="chip" data-view="dessus">Dessus</button><button type="button" class="chip" data-view="cote">Côté</button><span class="v3d-info mut t12"></span></div></div>
<p class="mut t12 mt4">${m3.title} · fais tourner à la souris, molette pour zoomer, clic sur une pièce pour ses cotes.</p>
<script type="module" src="/static/viewer3d.js"></script>` : ''; })()}
${p.prod_analysis ? h`<details class="mt12"><summary class="b" style="cursor:pointer">Analyse technique de l’assistant</summary><p class="mt8">${p.prod_analysis}</p></details>` : ''}
${q.get('SELECT id FROM cut_list WHERE project_id = ?', p.id) ? h`<div class="line mt12"><a class="btn alt sm" href="/projets/${p.id}/debit">Fiche de débit (${q.get('SELECT COUNT(*) n FROM cut_list WHERE project_id = ?', p.id).n} lignes)</a><a class="btn ghost sm" href="/projets/${p.id}/debit?imprimer=1" target="_blank">Imprimer</a></div>` : ''}
<div class="h3 mt12">Fichiers lus par l’assistant</div>
${files.length ? h`<div class="mt4">${files.map((f) => h`<div class="who"><span class="grow">${f.name || f.file}</span><span class="mut t12">${require('../chain').KINDS[f.kind] || ''}</span><a class="btn ghost sm" href="${fileUrl(f.file)}" target="_blank">Ouvrir</a></div>`)}</div>` : h`<p class="mut">Devis seul. Ajoute le modèle 3D (STEP ou .3dm), les vues (PDF, images) et la nomenclature ou le chiffrage (CSV, Excel, PDF) pour une chaîne précise.</p>`}
<form method="post" action="/projets/${p.id}/fichiers-prod" enctype="multipart/form-data" class="line mt8"><select name="kind" aria-label="Type" style="width:auto">${options(Object.entries(require('../chain').KINDS))}</select><input type="file" name="files" multiple required aria-label="Fichiers"><button class="btn alt sm">Ajouter</button></form>
<div class="h3 mt20">Matière avant fabrication</div>
${(() => { const lots = q.all('SELECT * FROM wood_lots WHERE project_id = ?', p.id); return lots.length ? h`<p class="mt4">Bois réservé dans le stock : ${lots.map((l) => `lot ${l.code} · ${l.essence} ${l.thickness} · ${String(l.volume).replace('.', ',')} m³`).join(' ; ')}.</p>` : ''; })()}
${m.items.length ? h`<p class="mt4">${m.date ? h`Fabrication possible à partir du <b>${ddmm(m.date)}</b>${m.estimated ? ' (estimation : délais habituels des fournisseurs, en attendant les dates de commande)' : ''}.` : h`<b>Toute la matière est là.</b>`} <a href="/achats">Voir les achats</a></p>
<div class="tablebox mt8"><table class="tbl dense"><thead><tr><th>Article</th><th>Fournisseur</th><th>Où en est-on</th><th>Arrivée</th></tr></thead><tbody>
${m.items.map((i) => h`<tr><td>${i.text}</td><td>${i.sname || '—'}</td><td>${pill(i.how === 'reçu' ? 'ok' : i.how === 'en retard' ? 'ko' : 'wa', i.how)}</td><td>${ddmm(i.when)}</td></tr>`)}</tbody></table></div>` : h`<p class="mut">Pas encore de matière liée. Elle apparaît ici quand la chaîne est générée.</p>`}
</section>`;
}
// Vues du modèle 3D capturées dans la visionneuse : remplacent les précédentes.
function saveViews(req) {
  const views = { iso: 'Vue en perspective', face: 'Vue de face', dessus: 'Vue de dessus', cote: 'Vue de côté' };
  const got = Object.keys(views).filter((k) => /^data:image\/jpeg;base64,/.test(String(req.body['vue_' + k] || '')));
  if (got.length) {
    for (const d of q.all("SELECT * FROM documents WHERE project_id = ? AND kind = 'vue_auto'", req.project.id)) { try { require('node:fs').unlinkSync(require('../uploads').filePath(d.file)); } catch {} }
    q.run("DELETE FROM documents WHERE project_id = ? AND kind = 'vue_auto'", req.project.id);
    for (const k of got) {
      const buf = Buffer.from(String(req.body['vue_' + k]).split(',')[1], 'base64');
      if (buf.length > 4 * 1024 * 1024) continue;
      const name = require('node:crypto').randomBytes(12).toString('hex') + '.jpg';
      require('node:fs').writeFileSync(require('../uploads').filePath(name), buf);
      q.run("INSERT INTO documents (project_id, title, file, visible_client, kind) VALUES (?, ?, ?, 0, 'vue_auto')", req.project.id, views[k], name);
    }
  }
  return got;
}

// Avec le forfait Claude : dossier à déposer dans claude.ai, réponse à recoller.
r.post('/projets/:id/chaine/claude', loadProject, (req, res) => { saveViews(req); res.redirect(`/projets/${req.project.id}/claude`); });
r.get('/projets/:id/claude/dossier.zip', loadProject, async (req, res, next) => {
  try {
    const pk = await require('../chain').claudePackage(req.project.id);
    res.set('content-type', 'application/zip').set('content-disposition', `attachment; filename="${pk.name}.zip"`).send(pk.zip);
  } catch (e) { next(e); }
});
r.get('/projets/:id/claude', loadProject, async (req, res, next) => {
  try {
    const p = req.project;
    const pk = await require('../chain').claudePackage(p.id);
    const body = h`<div class="eb"><a href="/projets/${p.id}#chaine">${p.name}</a></div><h1 class="mt8">Préparer la production avec Claude</h1>
<p class="mut mt8 mw680">Avec ton forfait Claude, sans coût d’API. Carchon OS a préparé le dossier ; Claude l’étudie dans une conversation ; tu recolles sa réponse ici et tout se crée : fiche de débit, matière, carnet en brouillon, planning.</p>
<section class="card mt20 mw680"><h2>1. Télécharge le dossier</h2>
<p class="mt8">${pk.attach.length + 1} fichiers : les instructions (avec la nomenclature mesurée dans la 3D${pk.instructions.includes('Nomenclature et chiffrage') ? ' et ton chiffrage' : ''}) et ${pk.attach.length} document${pk.attach.length > 1 ? 's' : ''} (devis, vues du modèle, plans).</p>
<div class="line mt12"><a class="btn" href="/projets/${p.id}/claude/dossier.zip">Télécharger le dossier (.zip)</a></div>
<p class="mut t12 mt8">Double-clique le .zip pour l’ouvrir : un dossier apparaît avec tous les fichiers.</p></section>
<section class="card mt20 mw680"><h2>2. Donne-le à Claude</h2>
<ol class="steps mt8"><li>Ouvre <a href="https://claude.ai/new" target="_blank" rel="noopener"><b>claude.ai</b></a> (ou l’application Claude), nouvelle conversation.</li>
<li>Choisis le modèle <b>Opus 5.5</b> et active la <b>réflexion étendue</b> (bouton sous la zone de texte).</li>
<li>Glisse <b>tous les fichiers du dossier</b> dans la conversation, y compris <b>00_INSTRUCTIONS.md</b>.</li>
<li>Écris simplement : « Suis les instructions du fichier 00_INSTRUCTIONS.md » et envoie.</li>
<li>Quand Claude a fini, clique l’icône <b>Copier</b> sous sa réponse.</li></ol>
<details class="mt12"><summary class="mut t13" style="cursor:pointer">Si Claude refuse le fichier .md : copier les instructions en texte</summary>
<textarea id="instr" readonly rows="6" class="mt8">${pk.instructions}</textarea><button type="button" class="btn alt sm mt8" data-copy="#instr">Copier les instructions</button></details></section>
<section class="card mt20 mw680" id="reponse"><h2>3. Recolle la réponse de Claude</h2>
<form method="post" action="/projets/${p.id}/claude/import" class="form mt8" data-busy="Carchon OS crée la production…">
<label class="sr" for="ans">Réponse de Claude</label><textarea id="ans" name="answer" rows="10" required placeholder="Colle ici toute la réponse de Claude (le bloc JSON)"></textarea>
<button class="btn">Créer la production</button></form>
<p class="mut t12 mt8">Si la réponse est coupée, écris « continue » à Claude et recolle le tout. Les fiches arrivent en brouillon : tu les vérifies avant de les envoyer à l’atelier.</p></section>`;
    res.send(layout({ title: 'Production avec Claude', tab: 'projets', sub: '/projets', body, flash: req.flash }));
  } catch (e) { next(e); }
});
r.post('/projets/:id/claude/import', loadProject, (req, res) => {
  try {
    const c = require('../chain').importAnswer(req.project.id, req.body.answer);
    res.flashTo(`/projets/${req.project.id}#chaine`, `Production créée : ${c.fiches} fiches en brouillon, ${c.debit} lignes de débit, ${c.matiere} achats${c.reserve ? `, ${c.reserve} lot(s) de bois réservé(s)` : ''}. Vérifie le carnet puis envoie-le à l’atelier.`);
  } catch (e) {
    if (e instanceof require('../ai').AIError) return res.flashTo(`/projets/${req.project.id}/claude#reponse`, e.message, 'ko');
    throw e;
  }
});

r.post('/projets/:id/chaine/generer', loadProject, (req, res) => {
  if (!require('../ai').enabled()) return res.flashTo(`/projets/${req.project.id}#chaine`, 'L’assistant n’est pas activé.', 'ko');
  const got = saveViews(req);
  require('../chain').start(req.project.id);
  res.flashTo(`/projets/${req.project.id}#chaine`, `L’assistant prépare la production${got.length ? ` avec ${got.length} vues du modèle 3D` : ''} (3 à 10 minutes). Recharge la page dans un instant.`);
});
// Modèle 3D allégé pour la visionneuse (calculé une fois, puis gardé à côté du fichier).
r.get('/projets/:id/3d/:did', loadProject, async (req, res) => {
  const did = String(req.params.did);
  const doc = did.startsWith('q') ? q.get('SELECT file, name title FROM quote_files WHERE id = ?', Number(did.slice(1))) : q.get("SELECT * FROM documents WHERE id = ? AND project_id = ? AND kind = 'modele3d'", Number(did), req.project.id);
  if (!doc) return res.status(404).type('text').send('introuvable');
  const fp = require('../uploads').filePath(doc.file);
  try {
    if (!require('node:fs').existsSync(fp + '.view.json')) await require('../model3d').analyze(fp);
    res.type('json').sendFile(fp + '.view.json');
  } catch (e) { res.status(422).type('text').send(e.message); }
});
// Fiche de débit (écran et impression atelier).
r.get('/projets/:id/debit', loadProject, (req, res) => {
  const p = req.project;
  const rows = q.all('SELECT * FROM cut_list WHERE project_id = ? ORDER BY ord, id', p.id);
  const n = (x) => (x ? String(Math.round(x * 10) / 10).replace('.', ',') : '—');
  const vol = rows.reduce((a, r) => a + (r.bl && r.bw && r.bt ? r.bl * r.bw * r.bt * r.qty : 0), 0) / 1e9;
  const table = h`<table class="tbl dense"><thead><tr><th>Ensemble</th><th>Pièce</th><th class="num">Qté</th><th>Matériau</th><th class="num">Fini L × l × ép.</th><th class="num">Débit brut</th><th>Fil</th><th>Note</th></tr></thead><tbody>
${rows.map((r) => h`<tr><td>${r.ensemble}</td><td class="b">${r.piece}</td><td class="num">${n(r.qty)}</td><td>${r.material}</td><td class="num">${n(r.l)} × ${n(r.w)} × ${n(r.t)}</td><td class="num">${n(r.bl)} × ${n(r.bw)} × ${n(r.bt)}</td><td>${r.grain}</td><td class="t12">${r.note}</td></tr>`)}</tbody></table>
<p class="mut mt8">${rows.length} lignes · volume brut débité ${vol.toFixed(3).replace('.', ',')} m³ (hors chute de débit)</p>`;
  if (req.query.imprimer) return res.send(require('../html').printPage(`Fiche de débit · ${p.name}`, table, { ref: p.ref }));
  res.send(layout({ title: 'Fiche de débit', tab: 'projets', sub: '/projets', body: h`<div class="eb"><a href="/projets/${p.id}#chaine">${p.name}</a></div><div class="head"><h1>Fiche de débit</h1><a class="btn alt push" href="/projets/${p.id}/debit?imprimer=1" target="_blank">Imprimer pour l’atelier</a></div>
<p class="mut mt8">Préparée par l’assistant à partir du modèle 3D, des plans et du chiffrage. Vérifie les cotes avant de débiter.</p><div class="tablebox mt12">${table}</div>` }));
});

r.post('/projets/:id/fichiers-prod', loadProject, require('../uploads').uploadDocs.array('files', 12), (req, res) => {
  const M = require('../model3d');
  for (const f of req.files || []) {
    const kind = M.is3D(f.originalname) ? 'modele3d' : ['plan3d', 'chiffrage'].includes(req.body.kind) ? req.body.kind : 'plan3d';
    q.run('INSERT INTO documents (project_id, title, file, visible_client, kind) VALUES (?, ?, ?, 0, ?)', req.project.id, f.originalname, f.filename, kind);
  }
  res.flashTo(`/projets/${req.project.id}#chaine`, `${(req.files || []).length} fichier(s) ajouté(s). Clique « Générer » pour que l’assistant les lise.`);
});
r.post('/projets/:id/facture', loadProject, upload.single('pdf'), (req, res) => {
  if (!req.file || !/\.pdf$/.test(req.file.filename)) return res.flashTo(`/projets/${req.project.id}#facture`, 'Il faut le PDF de la facture.', 'ko');
  require('../cockpit').addInvoice(req.project.id, { file: req.file.filename, type: 'acompte', number: str(req.body.numero), source: 'Patron' });
  res.flashTo(`/projets/${req.project.id}#facture`, 'Facture d’acompte publiée sur le portail du client.');
});

// ---------- Fiche projet ----------
function loadProject(req, res, next) {
  const p = q.get('SELECT * FROM projects WHERE id = ?', req.params.id);
  if (!p) return res.status(404).send(layout({ title: 'Introuvable', tab: 'projets', body: h`<h1>Projet introuvable</h1>` }));
  req.project = p; next();
}

// Accès à la chaîne de production du projet (cotes → devis, plans, débit, commandes, planning).
function chaineCard(p) {
  const C = require('../chaine');
  const c = C.get(p.id);
  const x = c ? C.compute(p.id, c.params) : null;
  const eur = (v) => `${Math.round(v).toLocaleString('fr-FR')} €`;
  return h`<section class="card" id="chiffrage"><div class="line"><h2>Chaîne de production · chiffrage</h2>${c ? pill(c.frozen_at ? 'ok' : 'wa', c.frozen_at ? `Indice ${c.indice} figé` : 'Chiffrage') : pill('no', 'À démarrer')}${c?.consumed_at ? pill('ok', 'Débit fait') : ''}</div>
<p class="mut">Une seule saisie, les cotes et les choix du client : prix, plans, débit et calepinage, commandes, quincaillerie, planning et pose en découlent.</p>
${x ? h`<div class="ch-mini-kpis mt12"><div><b>${eur(x.ht)}</b><span>prix HT</span></div><div><b>${Math.round(x.marge * 100)} %</b><span>marge</span></div><div><b>${x.pieces}</b><span>pièces · ${x.panelsCount} panneaux</span></div><div><b>${Math.round(x.hours)} h</b><span>atelier et pose</span></div><div><b>${ddmm(x.plan.poseDate)}</b><span>pose au plus tôt</span></div></div>` : ''}
<div class="line mt12"><a class="btn" href="/projets/${p.id}/chaine">${c ? 'Ouvrir la chaîne de production' : 'Démarrer la chaîne de production'}</a>${c ? h`<a class="btn alt sm" href="/projets/${p.id}/chaine#03">Débit</a><a class="btn alt sm" href="/projets/${p.id}/chaine#04">Commandes</a><a class="btn alt sm" href="/projets/${p.id}/chaine#05">Planning</a>` : ''}</div></section>`;
}

// Livraisons et poses : plusieurs dates, décidées ici, infos pratiques reprises de la fiche client.
function tripsCard(p) {
  const LV = require('../livraisons');
  const trips = q.all('SELECT * FROM trips WHERE project_id = ? ORDER BY date', p.id);
  const auto = LV.autoInfo(p);
  return h`<section class="card" id="livraisons"><div class="line"><h2>Livraisons et poses</h2><span class="count">${trips.length}</span></div>
<p class="mut">Ajoute autant de dates que nécessaire (livraison partielle, pose, reprise…). Adresse, contact, accès et équipe sont repris tout seuls ; chaque date entre dans le planning et sur le portail du client.</p>
${trips.map((t, i) => h`<details class="row${i ? '' : ' f'}"><summary class="line grow"><b style="width:70px">${ddmm(t.date)}</b><div class="grow"><b>${t.kind || t.what}</b><span class="mut">${[t.place, t.access, t.team].filter(Boolean).join(' · ')}</span></div>${t.pv_signed_at ? pill('ok', 'PV signé') : t.done_at ? pill('ok', 'Fait') : pill('wa', 'Prévue')}</summary>
<form method="post" action="/projets/${p.id}/livraisons/${t.id}" class="form grid2 mt8">
<label>Date <input type="date" name="date" value="${t.date}" required></label><label>Type <select name="kind">${options(LV.KINDS, t.kind)}</select></label>
<label>Adresse <input name="place" value="${t.place}"></label><label>Accès <input name="access" value="${t.access}"></label>
<label>Contact <input name="contact" value="${t.contact}"></label><label>Équipe <input name="team" value="${t.team}"></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1" data-confirm-btn="Supprimer cette date ?">Supprimer</button><a class="btn alt sm" href="/poses/${t.id}/pv">PV</a></div></form></details>`)}
${trips.length ? '' : h`<p class="mut mt8">Aucune date pour l’instant.</p>`}
<form method="post" action="/projets/${p.id}/livraisons" class="form mt12">
<div class="grid2"><label>Date <input type="date" name="date" required></label><label>Type <select name="kind">${options(LV.KINDS)}</select></label></div>
<div class="grid2"><label>Durée sur place (h) <input name="hours" inputmode="decimal" placeholder="ex. 4"></label><label>Équipe <input name="team" placeholder="${auto.team || 'ex. Lucas + toi'}"></label></div>
<p class="mut t12">Repris automatiquement : ${[auto.place || 'adresse à compléter dans la fiche client', auto.contact, auto.access].filter(Boolean).join(' · ')}</p>
<button class="btn sm">+ Ajouter la date</button></form></section>`;
}

r.post('/projets/:id/livraisons', loadProject, (req, res) => {
  const id = require('../livraisons').addTrip(req.project, req.body);
  res.flashTo(`/projets/${req.project.id}#livraisons`, id ? 'Date ajoutée : elle est dans le planning, sur la frise et sur le portail.' : 'Indique une date.', id ? 'ok' : 'ko');
});
r.post('/projets/:id/livraisons/:tid', loadProject, (req, res) => {
  const b = req.body, p = req.project;
  if (b.del) q.run('DELETE FROM trips WHERE id = ? AND project_id = ?', req.params.tid, p.id);
  else q.run('UPDATE trips SET date = ?, kind = ?, what = ?, place = ?, access = ?, contact = ?, team = ? WHERE id = ? AND project_id = ?',
    str(b.date), str(b.kind), str(b.kind), str(b.place), str(b.access), str(b.contact), str(b.team), req.params.tid, p.id);
  const last = q.get('SELECT MAX(date) d FROM trips WHERE project_id = ?', p.id).d;
  if (last) q.run('UPDATE projects SET due_date = ? WHERE id = ?', last, p.id);
  res.flashTo(`/projets/${p.id}#livraisons`, b.del ? 'Date supprimée.' : 'Date mise à jour (planning compris).');
});

r.get('/projets/:id', loadProject, (req, res) => {
  const p = L.projectSummary(req.project);
  const pm = L.peopleMap();
  const plans = q.all('SELECT * FROM plans WHERE project_id = ? ORDER BY id DESC', p.id);
  const pieces = q.all('SELECT * FROM pieces WHERE project_id = ? ORDER BY id', p.id);
  const photos = q.all('SELECT * FROM photos WHERE project_id = ? ORDER BY created_at DESC', p.id);
  const issues = q.all("SELECT * FROM issues WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC", p.id);
  const docs = q.all('SELECT * FROM documents WHERE project_id = ? ORDER BY id DESC', p.id);
  const history = q.all('SELECT * FROM activity WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 40', p.id);
  const time = q.all("SELECT COALESCE(NULLIF(geste,''), title) g, SUM(declared_hours) h, COUNT(*) n, SUM(status = 'doing') doing FROM steps WHERE project_id = ? AND (declared_hours IS NOT NULL OR status = 'doing') GROUP BY g", p.id);
  const total = time.reduce((a, t) => a + (t.h || 0), 0);
  const quote = q.get("SELECT * FROM quotes WHERE project_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", p.id);
  const shared = photos.filter((x) => x.shared_client).length;
  const units = q.all('SELECT * FROM units WHERE project_id = ? ORDER BY serial', p.id);
  const lots = q.all('SELECT * FROM wood_lots WHERE project_id = ? ORDER BY code', p.id);
  const resAll = require('../chaine').reservations();
  const panelRes = Object.entries(resAll).flatMap(([rid, o]) => o.projects.filter((x) => x.id === p.id && x.frozen).map((x) => ({ ...x, name: (q.get('SELECT name, thickness FROM panel_refs WHERE id = ?', rid) || {}).name || '' })));
  const pneeds = q.all("SELECT * FROM needs WHERE project_id = ? AND status != 'arrived' ORDER BY id", p.id);
  const model = p.model_id ? q.get('SELECT * FROM models WHERE id = ?', p.model_id) : null;
  const ustate = { a_faire: '', en_stock: 'done', expediee: 'done', livree: 'done' };
  const ulabel = { a_faire: 'À contrôler', en_stock: 'En stock', expediee: 'Expédiée', livree: 'Livrée' };
  const people = L.people();
  const D = require('./dossier');
  const sst = D.sstSummary(p.id);
  const steps = q.all('SELECT status, sent FROM steps WHERE project_id = ?', p.id);
  const stDone = steps.filter((s) => s.status === 'done').length, stDrafts = steps.filter((s) => !s.sent).length;
  const valid = plans.find((x) => x.status === 'validee');
  const dictee = req.query.dictee ? q.get('SELECT dictation FROM carnet_runs WHERE id = ? AND project_id = ?', req.query.dictee, p.id)?.dictation || '' : '';
  const toBuy = pneeds.filter((n) => n.status !== 'ordered').length;
  // Bandeau « À suivre » : l'essentiel du dossier en un coup d'œil, chaque case ouvre le bon onglet.
  const tiles = [
    { href: '#07', label: 'Carnet', val: steps.length ? `${stDone}/${steps.length} fiches` : 'Vide', sub: !steps.length ? (valid ? `Générer depuis ${valid.version}` : 'Ajouter un plan') : stDrafts ? `${stDrafts} à envoyer à l’atelier` : 'À jour sur l’iPad', warn: !steps.length || stDrafts },
    { href: '#04', label: 'Sous-traitance', val: sst.list.length ? `${sst.open.length} en cours` : 'Aucune', sub: sst.late.length ? `${sst.late.length} retour en retard` : sst.toOrder ? `${sst.toOrder} à commander` : sst.nextBack ? `Retour prévu ${ddmm(sst.nextBack)}` : sst.list.length ? 'Tout est revenu' : 'Laquage, verre, CNC…', ko: sst.late.length, warn: sst.toOrder },
    { href: '#04', label: 'Achats', val: pneeds.length ? `${pneeds.length} en attente` : 'Rien à acheter', sub: pneeds.length ? `${toBuy} à commander · ${pneeds.length - toBuy} commandé${pneeds.length - toBuy > 1 ? 's' : ''}` : lots.length ? `${lots.length} lot${lots.length > 1 ? 's' : ''} de bois réservé${lots.length > 1 ? 's' : ''}` : '', warn: toBuy },
    { href: '#08', label: 'Livraison', val: p.due_date ? ddmm(p.due_date) : 'À fixer', sub: p.slack.text, ko: p.slack.color === '#A20212' },
  ];
  const body = h`
<div class="mut"><a href="/projets">Projets</a> › ${p.name}</div>
<div class="head mt4"><div><div class="ref">Dossier ${p.ref}</div><h1 class="m0">${p.name}</h1>${p.descr ? h`<div class="t16 mt4">${p.descr}</div>` : ''}
<div class="line mt8">${pill('no', p.kind)}<span class="mut">${p.client ? p.client.name : 'hors commande client'}${p.due_date ? ` · Livraison ${ddmm(p.due_date)}` : ''}</span><b style="color:${p.slack.color}" class="t13">${p.slack.text}</b>${p.portal_state === 'open' ? pill('ok', 'Visible sur le portail client') : ''}${p.status === 'termine' ? pill('no', 'Terminé') : ''}</div></div>
<div class="push line"><a class="btn alt" href="#photos">Ajouter une photo</a><a class="btn alt" href="#dossier">Dossier de production</a><a class="btn" href="/carnets/${p.id}">Ouvrir le carnet</a></div></div>

<section class="card mt20" aria-label="Avancement">
<div class="frise-big">${p.cfrise.map((f) => h`<div class="fz ${f.state}"><span class="fz-dot"></span><b>${f.phase}</b><span class="mut t12">${f.label}</span></div>`)}</div>
<p class="mut t12 mt8">La même frise que sur le portail du client. Elle avance toute seule : devis, acompte, fiches de l’atelier, dates de pose, PV et solde.</p>
</section>

${issues.map((s) => {
    const ph = s.photo_id ? q.get('SELECT file FROM photos WHERE id = ?', s.photo_id) : null;
    return h`<section class="card danger mt20" id="probleme"><div class="line">${ph ? h`<a href="${fileUrl(ph.file)}"><img class="thumb" src="${fileUrl(ph.file)}" alt="Photo jointe"></a>` : ''}<div class="grow"><b>Problème signalé · ${s.body}</b><div class="mut">${pm[s.person_id]?.name || ''} · ${rel(s.created_at)}${ph ? ' · photo jointe' : ''}</div></div></div>
<form method="post" action="/projets/${p.id}/probleme/${s.id}" class="line mt12"><label class="sr" for="rep${s.id}">Réponse</label><input id="rep${s.id}" class="qin" name="reply" placeholder="Ta réponse, elle s’affiche sur l’iPad" value="${s.reply}"><button class="btn alt" name="act" value="reply">Répondre</button><button class="btn" name="act" value="close">Marquer traité</button></form></section>`;
  })}

<div class="suivi mt20" aria-label="À suivre">${tiles.map((t) => h`<a class="suivi-t${t.ko ? ' ko' : t.warn ? ' wa' : ''}" href="${t.href}" data-tab-link><span class="h3">${t.label}</span><b>${t.val}</b><span class="mut t12">${t.sub}</span></a>`)}</div>

<nav class="ptabs mt20" aria-label="Sections du projet" data-ptabs>
<a href="#vue">Vue d’ensemble</a><a href="#dossier">Dossier de production${stDrafts ? h` <span class="dot"></span>` : ''}</a><a href="#echanges">Client et documents</a></nav>

<div class="ptab" id="vue"><div class="cols">
<div class="main-col">
${chaineCard(p)}

<section class="card"><h2>Prochaine action</h2><p class="t15 mt8"><b>${p.next}</b></p>
<p class="mut t12">Tirée de la frise si le champ « Prochaine action » est vide.</p></section>

</div>
<aside class="side-col">
<section class="card" id="acompte"><h2>Projet</h2>
${(() => { const c = p.client || {}; const qx = quote; const eur = (v) => (v ? `${Math.round(v).toLocaleString('fr-FR')} € HT` : '');
    const rows = [['Client', c.name ? h`${c.name}${c.phone ? h`<br><a href="tel:${c.phone}">${c.phone}</a>` : ''}${c.email ? h`<br><a href="mailto:${c.email}">${c.email}</a>` : ''}` : ''],
      ['Adresse', c.address || ''], ['On fabrique', p.descr || ''], ['Montant', eur(p.amount_ht || qx?.amount_ht)], ['Devis', qx ? `${qx.number} · accepté le ${ddmm(qx.accepted_at)}` : ''],
      ['Acompte', p.deposit_at ? `reçu le ${ddmm(p.deposit_at)}` : p.deposit_needed && p.client_id ? 'attendu' : ''], ['Livraison', p.due_date ? `${ddmm(p.due_date)} · ${p.slack.text}` : 'à fixer'],
      ['Responsable', p.lead ? (p.lead.role === 'patron' ? 'Toi' : p.lead.name) : ''], ['Famille', p.family || ''], ['Origine', p.source || ''], ['Bois', p.wood || ''], ['Notes', p.notes || '']].filter(([, v]) => v);
    return h`<dl class="pinfo">${rows.map(([k, v]) => h`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`; })()}
<details class="mt12"><summary class="btn alt sm">Modifier</summary>
<form method="post" action="/projets/${p.id}/infos" class="form mt12">
${p.client_id ? h`<p class="mut">Titre : nom du client.</p>` : h`<label>Nom <input name="name" value="${p.name}"></label>`}
<label>Ce qu'on fabrique <input name="descr" value="${p.descr || ''}"></label>
<label>Échéance (livraison) <input type="date" name="due_date" value="${p.due_date || ''}"></label>
<label>Responsable <select name="lead_id"><option value="">—</option>${options(people.map((pp) => [pp.id, pp.role === 'patron' ? 'Toi' : pp.name]), p.lead_id)}</select></label>
<label>Prochaine action (vide = automatique) <input name="next_action" value="${p.next_action}"></label>
${p.client_id ? h`<label class="ck"><input type="checkbox" name="deposit_needed" value="1" ${p.deposit_needed ? 'checked' : ''}> Acompte demandé</label>
<label>Acompte reçu le <input type="date" name="deposit_at" value="${p.deposit_at ? p.deposit_at.slice(0, 10) : ''}"></label>` : ''}
<div class="grid2"><label>Montant vendu HT (€) <input name="amount_ht" inputmode="decimal" value="${p.amount_ht ?? ''}" placeholder="ex. 8400"></label><label>Matière et sous-traitance HT (€) <input name="material_ht" inputmode="decimal" value="${p.material_ht ?? ''}" placeholder="ex. 1900"></label></div>
<div class="grid2"><label>Famille <select name="family"><option value="">—</option>${options(FAMILIES, p.family)}</select></label><label>Origine du client <select name="source"><option value="">—</option>${options(SOURCES, p.source)}</select></label></div>
<p class="mut t12">Servent à l'Analyse : taux horaire réel, familles et canaux qui rapportent.</p>
<label>Bois <textarea name="wood" rows="2">${p.wood}</textarea></label>
<label>Notes <textarea name="notes" rows="4">${p.notes}</textarea></label>
<button class="btn sm">Enregistrer</button></form></details>
<div class="line mt12">${p.status === 'en_cours' ? postBtn(`/projets/${p.id}/statut`, 'Marquer terminé', 'btn alt sm', { status: 'termine' }, 'Marquer ce projet comme terminé ?') : postBtn(`/projets/${p.id}/statut`, 'Reprendre', 'btn alt sm', { status: 'en_cours' })}</div>
</section>
<section class="card"><h2>Temps passé</h2><p class="mut">Déclaré en un tap quand une fiche est finie.</p>
${time.map((t, i) => h`<div class="who${i ? '' : ' f'}"><span class="grow">${t.g}</span><b>${t.h ? hoursLabel(t.h) : 'en cours'}</b></div>`)}
<div class="who"><b class="grow">Total à ce jour</b><b>${hoursLabel(total)}</b></div></section>
</aside></div></div>

<div class="ptab" id="dossier">
${(() => { const CH = require('./chaine'); const k = CH.chaineParts(p); const S = k.steps; const SH = CH.stepHead;
  const NAV = [['01', 'Devis'], ['02', 'Plans et 3D'], ['03', 'Débit'], ['04', 'Commandes'], ['05', 'Planning'], ['06', 'CNC et étiquettes'], ['07', 'Assemblage'], ['08', 'Pose'], ['09', 'Retour']];
  return h`<nav class="ch-nav dz-nav" aria-label="Étapes du dossier">${NAV.map(([n, l]) => h`<a href="#${n}"><span>${n}</span> ${l}</a>`)}</nav>
${k.hero}
${S[0]}<details class="card dz-more"><summary class="h3">Préparer avec l’IA depuis le devis, le modèle 3D et le chiffrage</summary>${chainCard(p)}</details>
${S[1]}<div class="cols dz-cols"><div class="main-col"><section class="card" id="plans"><div class="line"><h2>Plans</h2></div>
${plans.map((x, i) => h`<div class="row${i ? '' : ' f'}"><div class="grow"><b>${x.version}${x.descr ? ` · ${x.descr}` : ''}</b><span class="mut">${x.status === 'validee' ? `Validée${x.validated_at ? ` le ${ddmm(x.validated_at)}` : ''} · fait foi pour l'atelier` : x.status === 'archivee' ? `${ddmm(x.created_at)} · remplacée` : `${ddmm(x.created_at)} · à valider`}</span></div>
${pill(x.status === 'validee' ? 'ok' : 'no', x.status === 'validee' ? 'Validée' : x.status === 'archivee' ? 'Archivée' : 'Brouillon')}
${x.file ? h`<a class="btn alt sm" href="${fileUrl(x.file)}" target="_blank">Ouvrir</a>` : ''}
${x.status === 'brouillon' ? postBtn(`/projets/${p.id}/plans/${x.id}/valider`, 'Valider', 'btn sm') : ''}</div>`)}
<details class="mt12"${plans.length ? '' : ' open'}><summary class="btn alt sm">+ Nouvelle version</summary>
<form method="post" action="/projets/${p.id}/plans" enctype="multipart/form-data" class="form grid2 mt8"><label>Version <input name="version" value="V${plans.length + 1}" required></label><label>Ce qui change <input name="descr"></label><label>Fichier (PDF ou image) <input type="file" name="file" accept="application/pdf,image/*"></label><button class="btn sm">Ajouter</button></form></details>
</section></div></div>
${S[2]}
${S[3]}<div class="dz-block">${achatsCard(p)}${D.sstSection(p)}<section class="card"><h2>Panneaux et bois réservés</h2>${panelRes.map((l, i) => h`<div class="row${i ? '' : ' f'}"><span class="grow">${l.name}</span><span>${String(Math.round(l.m2 * 10) / 10).replace('.', ',')} m² · ${l.panels} panneau${l.panels > 1 ? 'x' : ''}</span></div>`)}${lots.map((l, i) => h`<div class="row${i || panelRes.length ? '' : ' f'}"><b>${l.code}</b><span class="grow">${l.essence} ${l.thickness}</span><span>${String(l.volume).replace('.', ',')} m³</span></div>`)}${panelRes.length || lots.length ? '' : h`<p class="mut">Rien de réservé. Les panneaux se réservent quand la <a href="/projets/${p.id}/chaine">chaîne de production</a> est figée ; <a href="/bois">réserver un lot de bois</a>.</p>`}</section></div>
${S[4]}
${SH('06', 'Usinage CNC et étiquettes', 'Programme par panneau', 'Le programme par panneau et par outil, le placement des pièces, la simulation et les étiquettes.', 'La passe à vide, puis le départ cycle : rien ne démarre sans toi devant la machine.')}
<div class="dz-block">${require('./cnc').cncSection(p)}</div>${raw(S[5].toString().replace(/<div class="ch-step" id="06">[\s\S]*?<\/div><\/div><\/div>/, ''))}
${SH('07', 'Assemblage à l’atelier', 'Carnet de fabrication', 'Les fiches dans l’ordre, avec la pièce, son plan et les étapes à cocher sur l’iPad. À la fin de chacune : « Ça t’a pris combien ? ».', 'Les fiches avant de les envoyer à l’atelier, puis le contrôle final de chaque pièce.')}
${assemblageBlock(p)}
<div class="cols dz-cols"><div class="main-col">${raw(D.dossierSection(p, { dictee }).toString().replace(/<section class="card" id="carnet">[\s\S]*?<\/section>/, ''))}</div><aside class="side-col"><section class="card"><div class="line"><h2>Éléments du projet</h2></div>
${pieces.map((x, i) => h`<details class="row${i ? '' : ' f'}"><summary class="line grow"><div class="grow"><b>${x.name}</b><span class="mut">${x.descr}</span></div>${x.status ? pill('no', x.status) : ''}${avatar(pm[x.who_id], 28)}</summary>
<form method="post" action="/projets/${p.id}/pieces/${x.id}" class="form mt8"><label>Nom <input name="name" value="${x.name}"></label><label>Description <input name="descr" value="${x.descr}"></label>
<label>État <input name="status" value="${x.status}" placeholder="ex. Finition 2/3"></label><label>Qui <select name="who_id"><option value="">—</option>${options(people.map((pp) => [pp.id, pp.name]), x.who_id)}</select></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Retirer</button></div></form></details>`)}
${pieces.length ? '' : h`<p class="mut">Caisson, plateau, façades… remplis à la génération du carnet ou à la main.</p>`}
<details class="mt12"><summary class="btn alt sm">+ Élément</summary><form method="post" action="/projets/${p.id}/pieces" class="form mt8"><label>Nom <input name="name" required></label><label>Description <input name="descr"></label><button class="btn sm">Ajouter</button></form></details>
</section><section class="card"><div class="line"><h2>Contrôle et numéros</h2>${pill('no', p.canal)}</div>
${model ? h`<p class="mut"><a href="/catalogue?m=${model.id}">Modèle ${model.name}</a>${p.for_whom ? ` · pour ${p.for_whom}` : ''}</p>` : p.for_whom ? h`<p class="mut">Pour ${p.for_whom}</p>` : ''}
${units.length ? h`<div class="h3 mt12">Pièces · ${units.filter((u) => u.status !== 'a_faire').length} contrôlée(s) sur ${units.length}</div><div class="unitgrid">${units.map((u) => h`<a class="unit ${ustate[u.status]}" href="/unites/${u.id}"><b>${u.serial}</b>${ulabel[u.status]}</a>`)}</div>` : h`<p class="mut mt8">La pièce reçoit son numéro (${p.ref}) au contrôle final.</p>`}
${units.some((u) => u.status === 'a_faire') || !units.length ? h`<div class="mt12">${postBtn(`/projets/${p.id}/controle`, units.length > 1 ? 'Contrôler la pièce suivante' : 'Contrôle final', 'btn sm')}</div>` : ''}
</section></aside></div>
${SH('08', 'Livraison et pose', 'Préparée la veille', 'Les colis, la liste du camion, les dates et l’équipe, le rappel au client deux jours avant.', 'La pose et la réception avec le client : PV signé sur l’iPad, puis le solde.')}
${poseBlock(p)}<div class="dz-block">${tripsCard(p)}</div>
${SH('09', 'Retour d’expérience', 'Le projet suivant est mieux chiffré', 'Les temps réels déclarés au carnet comparés au chiffrage, poste par poste, et les réserves du PV.', 'Ce qu’il faut corriger dans le barème et dans les carnets types.')}
${retourBlock(p)}
<div class="dz-block"><section class="card"><h2>Imprimer</h2><p class="mut">Pour l’établi ou le classeur du dossier.</p>
<div class="stack mt12"><a class="btn alt sm" href="/projets/${p.id}/dossier/imprimer">Dossier de production complet</a><a class="btn alt sm" href="/carnets/${p.id}/imprimer">Carnet seul</a></div></section></div>`; })()}
</div>

<div class="ptab" id="echanges"><div class="cols">
<div class="main-col">
<section class="card" id="photos"><h2>Journal de fabrication</h2><p class="mut">Tu choisis ce que le client voit sur son portail, et ce que tu peux publier.</p>
<form method="post" action="/projets/${p.id}/photos" enctype="multipart/form-data" class="line mt12"><label class="sr" for="ph">Photo</label><input id="ph" type="file" name="photo" accept="image/*" required><input class="qin" name="title" placeholder="Légende"><button class="btn sm">Ajouter</button></form>
<div class="photos mt12">${photos.map((x) => h`<figure class="ph">${isImage(x.file) ? h`<a href="${fileUrl(x.file)}" target="_blank"><img src="${fileUrl(x.file)}" alt="${x.title}" loading="lazy"></a>` : h`<a href="${fileUrl(x.file)}">Fichier</a>`}
<figcaption><b>${x.title || 'Photo'}</b><span class="mut t12">${ddmm(x.created_at)} · ${pm[x.person_id]?.name || ''}</span>
<form method="post" action="/projets/${p.id}/photos/${x.id}" class="ckrow"><label><input type="checkbox" name="shared_client" value="1" ${x.shared_client ? 'checked' : ''} data-auto> Partagée au client</label><label><input type="checkbox" name="publishable" value="1" ${x.publishable ? 'checked' : ''} data-auto> Publiable</label></form></figcaption></figure>`)}
${photos.length ? '' : h`<p class="mut">Pas encore de photo. L’atelier en ajoute depuis l’iPad.</p>`}</div>
</section>
</div>
<aside class="side-col">
${p.client_id ? h`<section class="card"><div class="line"><h2>Portail client</h2>${pill(p.portal_state === 'open' ? 'ok' : 'no', p.portal_state === 'open' ? 'Ouvert' : p.portal_state === 'cut' ? 'Accès coupé' : 'Pas ouvert')}</div>
<p class="mut">Ce que ${p.client.name} voit dans son espace. Tout part tout seul, dates de livraison comprises.</p>
${(() => { const id = require('../civilite').identity(p.client); return h`<form method="post" action="/projets/${p.id}/client-nom" class="form mt8"><span class="mut t12">Le portail l’accueille ainsi : <b>« ${require('../civilite').salutation()} ${id.formal} »</b></span>
<div class="line" style="gap:8px;flex-wrap:nowrap"><select name="civility" aria-label="Civilité" style="max-width:96px">${options([['', 'Auto'], ['Mme', 'Mme'], ['M.', 'M.'], ['none', 'Aucune']], p.client.civility || '')}</select>
<input name="last_name" placeholder="Nom" aria-label="Nom" value="${p.client.last_name || id.last}"><input name="first_name" placeholder="Prénom" aria-label="Prénom" value="${p.client.first_name || id.first}"><button class="btn alt sm">OK</button></div></form>`; })()}
<div class="who f"><span class="grow">Devis</span><b>${quote ? `Accepté le ${ddmm(quote.accepted_at)}` : '—'}</b></div>
<div class="who"><span class="grow">Acompte</span><b>${p.deposit_at ? `Reçu le ${ddmm(p.deposit_at)}` : 'Attendu'}</b></div>
${p.deposit_invoice_id || Q.on() ? h`<div class="who" id="facture"><span class="grow">Facture d’acompte${p.deposit_invoice_number ? h` <span class="mut">${p.deposit_invoice_number}</span>` : ''}${p.deposit_invoice_error ? h`<span class="mut t12 red">${p.deposit_invoice_error}</span>` : ''}</span>
<b>${p.deposit_invoice_status === 'paid' || (p.deposit_invoice_id && p.deposit_at) ? 'Payée' : p.deposit_invoice_status === 'sent' ? `Envoyée le ${ddmm(p.deposit_invoice_sent_at)}` : p.deposit_invoice_status === 'created' ? 'Créée, pas envoyée' : p.deposit_invoice_status === 'creating' ? 'En cours…' : p.deposit_invoice_status === 'error' ? 'Échec' : '—'}</b></div>
${p.deposit_invoice_url ? h`<a class="btn alt sm mt8" href="${p.deposit_invoice_url}" target="_blank" rel="noopener">Voir la facture</a>` : ''}
${quote && !p.deposit_at && Q.configured() && p.deposit_invoice_status !== 'sent' && p.deposit_invoice_status !== 'creating' ? postBtn(`/projets/${p.id}/facture-acompte`, p.deposit_invoice_id ? 'Renvoyer la facture' : 'Créer et envoyer la facture d’acompte', 'btn alt sm mt8', {}, p.deposit_invoice_id ? '' : 'Créer la facture d’acompte dans Qonto et l’envoyer au client ?') : ''}` : h`${(() => { const inv = q.get("SELECT * FROM documents WHERE project_id = ? AND kind = 'facture_acompte' ORDER BY id DESC LIMIT 1", p.id);
    return inv ? h`<div class="who" id="facture"><span class="grow">Facture d’acompte</span><a class="b" href="${fileUrl(inv.file)}" target="_blank">${inv.number ? `n° ${inv.number}` : 'publiée'}</a></div>`
      : p.deposit_needed && !p.deposit_at ? h`<form method="post" action="/projets/${p.id}/facture" enctype="multipart/form-data" class="who" id="facture"><span class="grow">Facture d’acompte<span class="mut t12" style="display:block">${require('../cockpit').configured() ? 'attendue de Cockpit · ou dépose-la ici' : 'dépose le PDF : il part sur le portail'}</span></span>
<input type="file" name="pdf" accept="application/pdf" required aria-label="Facture d’acompte (PDF)" style="max-width:190px"><input name="numero" placeholder="N°" aria-label="Numéro de facture" style="max-width:90px"><button class="btn alt sm">Publier</button></form>` : ''; })()}`}
<form method="post" action="/projets/${p.id}/infos" class="who"><label class="grow" for="rd">Prête à poser vers le</label><input id="rd" type="date" name="ready_date" value="${p.ready_date || ''}" data-auto><input type="hidden" name="only" value="ready_date"></form>
<div class="who"><span class="grow">Photos partagées</span><b>${shared} sur ${photos.length}</b></div>
<div class="line mt12">${(() => { const t = p.portal_state === 'open' ? SMS.open(p.portal_token_enc) : null; return t ? h`<input type="hidden" id="lk-proj" value="${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/p/espace/${t}"><button type="button" class="btn sm" data-copy="#lk-proj">Copier le lien du portail</button>` : ''; })()}<a class="btn alt sm" href="/portails#p${p.id}">Gérer le portail</a><a class="btn alt sm" href="/projets/${p.id}/nouvelles">Donner des nouvelles</a></div>
${p.portal_state !== 'open' ? postBtn(`/portails/espace/${p.id}/ouvrir`, 'Ouvrir l’espace client', 'btn sm mt12') : ''}</section>`
    : h`<section class="card" id="client"><h2>Client</h2><p class="mut">Choisis le client dans la base clientèle de Cockpit. Le projet prend son nom, et tu pourras lui ouvrir un espace de suivi (avancement, photos, documents, dates de livraison).</p>
<form method="post" action="/projets/${p.id}/client" class="form mt12">
<label>Client (base Cockpit) <input name="client_pick" list="clientbase" required placeholder="Tape le nom, l’e-mail ou la ville" autocomplete="off"></label>
<datalist id="clientbase">${q.all('SELECT id, name, email, address FROM clients ORDER BY name').map((c) => h`<option value="${c.name}${c.email ? ` · ${c.email}` : ''} #${c.id}">${c.address || ''}</option>`)}</datalist>
<button class="btn sm">Rattacher le client</button></form>
<p class="mut t12 mt8">${q.get('SELECT COUNT(*) n FROM clients').n} clients dans la base.</p>${require('../cockpit').syncConfigured() ? require('./cockpit-sync').syncTools(`/projets/${p.id}#client`) : h`<p class="mut t12">Liaison Cockpit à régler dans <a href="/entreprise#cockpit">Équipe et réglages › Entreprise</a>.</p>`}</section>`}

<section class="card"><h2>Documents</h2><p class="mut">Devis accepté, PV, facture… Cochés « client », ils s’affichent dans son espace.</p>
${docs.map((d) => h`<div class="row"><a class="grow" href="${fileUrl(d.file)}" target="_blank">${d.title}</a>
<form method="post" action="/projets/${p.id}/documents/${d.id}" class="ckrow"><label><input type="checkbox" name="visible_client" value="1" ${d.visible_client ? 'checked' : ''} data-auto> Client</label></form></div>`)}
<form method="post" action="/projets/${p.id}/documents" enctype="multipart/form-data" class="form mt12"><label>Titre <input name="title" required placeholder="ex. Facture de solde"></label><input type="file" name="file" required accept="application/pdf,image/*"><label class="ck"><input type="checkbox" name="visible_client" value="1"> Visible par le client</label><button class="btn alt sm">Ajouter</button></form>
</section>
<details class="card hist" id="historique"><summary class="h3">Historique du dossier · ${history.length}</summary>
<ol class="timeline mt8">${history.map((a) => h`<li><time datetime="${a.created_at}">${ddmm(a.created_at)} · ${hhmm(a.created_at)}</time><span>${a.text}${a.who ? h` <span class="mut">· ${a.who}</span>` : ''}</span></li>`)}</ol>
${history.length ? '' : h`<p class="mut">Rien encore.</p>`}</details>
</aside></div></div>`;
  res.send(layout({ title: p.name, tab: 'projets', sub: '/projets', body, flash: req.flash }));
});

r.post('/projets/:id/phase', loadProject, (req, res) => {
  const { phase, state, label } = req.body;
  if (!PHASES.includes(phase)) return res.redirect(`/projets/${req.project.id}`);
  if (state === 'auto') q.run('DELETE FROM phase_overrides WHERE project_id = ? AND phase = ?', req.project.id, phase);
  else q.run('INSERT OR REPLACE INTO phase_overrides (project_id, phase, state, label) VALUES (?, ?, ?, ?)', req.project.id, phase, state, str(label));
  res.redirect(`/projets/${req.project.id}`);
});

r.post('/clients/synchroniser', async (req, res) => {
  const back = String(req.body.back || '/').startsWith('/') ? String(req.body.back) : '/';
  try { const n = await require('../cockpit').pull(); res.flashTo(back, `Base clientèle à jour : ${n} client(s) de Cockpit.`); }
  catch (e) { res.flashTo(back, `Cockpit injoignable : ${e.message}`, 'ko'); }
});
r.post('/projets/:id/client', loadProject, (req, res) => {
  const cid = clientFrom(req.body);
  if (!cid) return res.flashTo(`/projets/${req.project.id}#client`, 'Client introuvable dans la base : choisis-le dans la liste proposée.', 'ko');
  q.run('UPDATE projects SET client_id = ?, for_whom = COALESCE(NULLIF(for_whom, \'\'), (SELECT name FROM clients WHERE id = ?)) WHERE id = ?', cid, cid, req.project.id);
  L.syncProjectName(req.project.id);
  logActivity(req.project.id, null, 'Client rattaché', 'Patron');
  res.flashTo(`/projets/${req.project.id}`, 'Client rattaché. Tu peux maintenant lui ouvrir son espace (bloc « Portail client »).');
});
r.post('/projets/:id/infos', loadProject, (req, res) => {
  const b = req.body, p = req.project;
  if (b.only === 'ready_date') {
    q.run('UPDATE projects SET ready_date = ? WHERE id = ?', str(b.ready_date) || null, p.id);
    return res.flashTo(`/projets/${p.id}`, 'Date « prête à poser » mise à jour sur le portail.');
  }
  const depositAt = str(b.deposit_at) || null;
  tx(() => {
    q.run('UPDATE projects SET name = ?, descr = ?, due_date = ?, lead_id = ?, next_action = ?, wood = ?, notes = ?, deposit_needed = ?, deposit_at = ?, amount_ht = ?, material_ht = ?, family = ?, source = ? WHERE id = ?',
      p.client_id ? p.name : str(b.name) || p.name, str(b.descr), str(b.due_date) || null, int(b.lead_id), str(b.next_action), str(b.wood), str(b.notes), p.client_id ? (b.deposit_needed ? 1 : 0) : 0, depositAt,
      euros(b.amount_ht), euros(b.material_ht), FAMILIES.includes(b.family) ? b.family : '', SOURCES.includes(b.source) ? b.source : '', p.id);
    // Acompte reçu : les achats qui l'attendaient se débloquent.
    if (depositAt && !p.deposit_at) { q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id); logActivity(p.id, null, `Acompte reçu le ${ddmm(depositAt)}`, 'Patron'); SMS.notify('acompte', { projectId: p.id }); }
    if (str(b.due_date) && str(b.due_date) !== (p.due_date || '')) logActivity(p.id, null, `Date de livraison : ${ddmm(str(b.due_date))}${p.due_date ? ` (au lieu du ${ddmm(p.due_date)})` : ''}`, 'Patron');
  });
  res.flashTo(`/projets/${p.id}`, depositAt && !p.deposit_at ? 'Acompte noté. Les achats bloqués sont débloqués.' : 'Enregistré.');
});

// Comment le portail s'adresse au client : civilité, nom, prénom.
r.post('/projets/:id/client-nom', loadProject, (req, res) => {
  const p = req.project; const b = req.body; const C = require('../civilite');
  if (!p.client_id) return res.redirect(`/projets/${p.id}`);
  q.run('UPDATE clients SET civility = ?, last_name = ?, first_name = ? WHERE id = ?', ['Mme', 'M.', 'none'].includes(b.civility) ? b.civility : '', C.tidy(str(b.last_name)).slice(0, 80), C.tidy(str(b.first_name)).slice(0, 80), p.client_id);
  res.flashTo(`/projets/${p.id}`, 'Enregistré : le portail s’adresse au client avec ces nom et prénom.');
});

r.post('/projets/:id/facture-solde', loadProject, async (req, res) => {
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : `/projets/${req.project.id}#08`;
  try { const o = await Q.createBalance(req.project.id); res.flashTo(back, o.already ? 'La facture de solde existe déjà.' : `Facture de solde ${o.number || ''} créée et envoyée par Qonto.`); }
  catch (e) { res.flashTo(back, e.message, 'ko'); }
});

// Facture d'acompte Qonto : créer, ou renvoyer si elle existe déjà.
r.post('/projets/:id/facture-acompte', loadProject, async (req, res) => {
  const p = req.project;
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : `/projets/${p.id}#facture`;
  try {
    const out = p.deposit_invoice_id ? await Q.resend(p.id) : await Q.createDeposit(p.id);
    res.flashTo(back, out.busy ? 'La facture est déjà en cours de création.' : p.deposit_invoice_id ? 'Facture d’acompte renvoyée au client par Qonto.' : `Facture d’acompte ${out.number || ''} créée et envoyée au client par Qonto.`);
  } catch (e) { res.flashTo(back, e.message, 'ko'); }
});

// Acompte reçu en un clic (depuis À décider).
r.post('/projets/:id/acompte', loadProject, (req, res) => {
  const p = req.project;
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : `/projets/${p.id}`;
  if (!p.deposit_at) {
    tx(() => {
      q.run("UPDATE projects SET deposit_at = date('now', 'localtime') WHERE id = ?", p.id);
      q.run('UPDATE needs SET needs_deposit = 0 WHERE project_id = ?', p.id);
      logActivity(p.id, null, `Acompte reçu le ${ddmm(today())}`, 'Patron');
    });
    SMS.notify('acompte', { projectId: p.id });
  }
  res.flashTo(back, `Acompte noté pour ${p.name}. Les achats bloqués sont débloqués.`);
});

r.post('/projets/:id/statut', loadProject, (req, res) => {
  const st = req.body.status === 'termine' ? 'termine' : 'en_cours';
  q.run("UPDATE projects SET status = ?, finished_at = CASE WHEN ? = 'termine' THEN datetime('now') ELSE NULL END WHERE id = ?", st, st, req.project.id);
  logActivity(req.project.id, null, st === 'termine' ? 'Projet terminé' : 'Projet repris', 'Patron');
  res.flashTo(`/projets/${req.project.id}`, st === 'termine' ? 'Projet terminé.' : 'Projet repris.');
});

r.post('/projets/:id/probleme/:iid', loadProject, (req, res) => {
  if (req.body.act === 'close') { q.run("UPDATE issues SET status = 'closed', reply = ? WHERE id = ? AND project_id = ?", str(req.body.reply), req.params.iid, req.project.id); logActivity(req.project.id, null, `Problème traité${str(req.body.reply) ? ` : ${str(req.body.reply)}` : ''}`, 'Patron'); }
  else q.run('UPDATE issues SET reply = ? WHERE id = ? AND project_id = ?', str(req.body.reply), req.params.iid, req.project.id);
  res.flashTo(`/projets/${req.project.id}`, req.body.act === 'close' ? 'Problème traité.' : 'Réponse envoyée sur l’iPad.');
});

r.post('/projets/:id/pieces', loadProject, (req, res) => {
  q.run('INSERT INTO pieces (project_id, name, descr) VALUES (?, ?, ?)', req.project.id, str(req.body.name), str(req.body.descr));
  res.redirect(`/projets/${req.project.id}`);
});
r.post('/projets/:id/pieces/:pid', loadProject, (req, res) => {
  const b = req.body;
  if (b.del) q.run('DELETE FROM pieces WHERE id = ? AND project_id = ?', req.params.pid, req.project.id);
  else q.run('UPDATE pieces SET name = ?, descr = ?, status = ?, who_id = ? WHERE id = ? AND project_id = ?', str(b.name), str(b.descr), str(b.status), int(b.who_id), req.params.pid, req.project.id);
  res.redirect(`/projets/${req.project.id}`);
});

r.post('/projets/:id/plans', loadProject, upload.single('file'), (req, res) => {
  q.run('INSERT INTO plans (project_id, version, descr, file) VALUES (?, ?, ?, ?)', req.project.id, str(req.body.version), str(req.body.descr), req.file ? req.file.filename : null);
  res.flashTo(`/projets/${req.project.id}`, 'Plan ajouté. Valide-le quand il fait foi pour l’atelier.');
});
r.post('/projets/:id/plans/:pid/valider', loadProject, (req, res) => {
  tx(() => {
    q.run("UPDATE plans SET status = 'archivee' WHERE project_id = ? AND status = 'validee'", req.project.id);
    q.run("UPDATE plans SET status = 'validee', validated_at = datetime('now') WHERE id = ? AND project_id = ?", req.params.pid, req.project.id);
    logActivity(req.project.id, null, `Plan ${q.get('SELECT version FROM plans WHERE id = ?', req.params.pid)?.version || ''} validé`, 'Patron');
    q.run("DELETE FROM phase_overrides WHERE project_id = ? AND phase = 'Conception'", req.project.id);
  });
  res.flashTo(`/projets/${req.project.id}`, 'Plan validé : c’est lui qui fait foi pour l’atelier.');
});

r.post('/projets/:id/photos', loadProject, upload.single('photo'), (req, res) => {
  if (!req.file) return res.flashTo(`/projets/${req.project.id}#photos`, 'Format de fichier non reconnu.', 'ko');
  const me = L.patron();
  q.run('INSERT INTO photos (project_id, file, title, person_id) VALUES (?, ?, ?, ?)', req.project.id, req.file.filename, str(req.body.title), me.id);
  res.flashTo(`/projets/${req.project.id}#photos`, 'Photo ajoutée au journal.');
});
r.post('/projets/:id/photos/:pid', loadProject, (req, res) => {
  const was = q.get('SELECT shared_client FROM photos WHERE id = ?', req.params.pid);
  q.run('UPDATE photos SET shared_client = ?, publishable = ? WHERE id = ? AND project_id = ?', req.body.shared_client ? 1 : 0, req.body.publishable ? 1 : 0, req.params.pid, req.project.id);
  if (req.body.shared_client && was && !was.shared_client) SMS.notify('maj', { projectId: req.project.id, quoi: 'nouvelle photo' });
  res.redirect(`/projets/${req.project.id}#photos`);
});

r.post('/projets/:id/documents', loadProject, upload.single('file'), (req, res) => {
  if (!req.file) return res.flashTo(`/projets/${req.project.id}`, 'Fichier refusé (PDF ou image).', 'ko');
  q.run('INSERT INTO documents (project_id, title, file, visible_client) VALUES (?, ?, ?, ?)', req.project.id, str(req.body.title), req.file.filename, req.body.visible_client ? 1 : 0);
  if (req.body.visible_client) SMS.notify('maj', { projectId: req.project.id, quoi: `nouveau document : ${str(req.body.title).toLowerCase()}` });
  res.flashTo(`/projets/${req.project.id}`, 'Document ajouté.');
});
r.post('/projets/:id/documents/:did', loadProject, (req, res) => {
  const wasDoc = q.get('SELECT visible_client, title FROM documents WHERE id = ?', req.params.did);
  q.run('UPDATE documents SET visible_client = ? WHERE id = ? AND project_id = ?', req.body.visible_client ? 1 : 0, req.params.did, req.project.id);
  if (req.body.visible_client && wasDoc && !wasDoc.visible_client) SMS.notify('maj', { projectId: req.project.id, quoi: `nouveau document : ${String(wasDoc.title).toLowerCase()}` });
  res.redirect(`/projets/${req.project.id}`);
});

// Message d'avancement pour le client : rédigé par l'assistant si activé, sinon modèle prêt à adapter.
r.get('/projets/:id/nouvelles', loadProject, async (req, res, next) => {
  const p = L.projectSummary(req.project);
  if (!p.client) return res.redirect(`/projets/${p.id}`);
  const ai = require('../ai');
  const done = q.all("SELECT title FROM steps WHERE project_id = ? AND status = 'done' AND done_at >= datetime('now', '-14 days') ORDER BY done_at", p.id).map((s) => s.title);
  const doing = q.all("SELECT title FROM steps WHERE project_id = ? AND status = 'doing'", p.id).map((s) => s.title);
  const trip = q.get('SELECT * FROM trips WHERE project_id = ? AND done_at IS NULL ORDER BY date LIMIT 1', p.id);
  const nPhotos = q.get('SELECT COUNT(*) n FROM photos WHERE project_id = ? AND shared_client = 1', p.id).n;
  const facts = [
    `Étape actuelle : ${p.cur.phase.toLowerCase()}`,
    done.length ? `Fait ces deux dernières semaines : ${done.join(', ')}` : null,
    doing.length ? `En cours à l'atelier : ${doing.join(', ')}` : null,
    p.ready_date ? `Prêt à poser vers le ${dayMonth(p.ready_date)}` : null,
    trip ? `Livraison / pose prévue le ${longDate(trip.date)}` : null,
    nPhotos && p.portal_state === 'open' ? `${nPhotos} photo${nPhotos > 1 ? 's' : ''} de l'atelier dans votre espace en ligne` : null,
  ].filter(Boolean);
  let subject = `Des nouvelles de votre projet · ${p.name}`;
  let text = require('../messages').t('mail_nouvelles_texte', { projet: p.name, faits: facts.map((f) => `- ${f}`).join('\n') });
  let note = ai.enabled() ? '' : 'Modèle simple : active l’assistant IA (Pilotage › Automatisations) pour un message rédigé.';
  if (ai.enabled() && req.query.modele !== '1') {
    try { const m = await ai.clientUpdate({ project: p, clientName: p.client.name, facts }); subject = m.objet; text = m.message; note = 'Rédigé par l’assistant à partir de l’avancement réel. Relis avant d’envoyer.'; }
    catch (e) { if (!(e instanceof ai.AIError)) return next(e); note = `${e.message} Voici un modèle simple.`; }
  }
  const body = h`<div class="mut"><a href="/projets/${p.id}">${p.name}</a></div><h1>Donner des nouvelles à ${p.client.name}</h1>
<section class="card mt20 mw680"><p class="mut">${note}</p>
${require('./mail').composeForm({ to: p.client.email || '', subject, body: text, back: `/projets/${p.id}`, projectId: p.id, id: 'newsmsg' })}
<p class="mut t12 mt12">Faits utilisés : ${facts.join(' · ')}</p></section>`;
  res.send(layout({ title: 'Nouvelles', tab: 'projets', sub: '/projets', body }));
});

module.exports = r;
module.exports.loadProject = loadProject;
module.exports.friseBar = friseBar;
