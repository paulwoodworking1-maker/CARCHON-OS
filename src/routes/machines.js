'use strict';
// Machines : parc, entretiens à la date ou à l'usage (calculé depuis les fiches), pannes, pièces d'usure.
const express = require('express');
const { q, tx, GESTES } = require('../db');
const { h, layout, pill, postBtn, ddmm, today } = require('../html');
const { upload, fileUrl } = require('../uploads');
const M = require('../machines');
const { setStockState } = require('./achats');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
const STATE = { ok: ['ok', 'En service'], du: ['wa', 'Entretien dû'], panne: ['ko', 'En panne'] };

r.get('/machines', (req, res) => {
  const all = M.all();
  const m = all.find((x) => String(x.id) === String(req.query.m)) || all[0];
  const overdue = all.reduce((a, x) => a + x.tasks.filter((t) => t.st.late).length, 0);
  const soon = all.reduce((a, x) => a + x.tasks.filter((t) => t.st.soon).length, 0);
  const down = all.filter((x) => x.down_since).length;
  const year = today().slice(0, 4);
  const stops = q.get("SELECT COALESCE(SUM(days_down), 0) d, COUNT(*) n FROM machine_events WHERE kind = 'panne' AND date >= ?", `${year}-01-01`);
  const machineForm = (x = {}) => h`<div class="grid2"><label>Nom <input name="name" value="${x.name || ''}" required></label><label>Type <input name="type" value="${x.type || ''}" placeholder="ex. Corroyage"></label></div>
<div class="grid2"><label>Marque et modèle <input name="brand" value="${x.brand || ''}"></label><label>N° de série <input name="serial" value="${x.serial || ''}"></label></div>
<div class="grid2"><label>En service depuis <input name="since" value="${x.since || ''}" placeholder="ex. 2019"></label><label>Contact SAV <input name="sav_contact" value="${x.sav_contact || ''}"></label></div>
<fieldset><legend>Gestes qui l'utilisent (pour compter les heures d'usage)</legend><div class="chips m0">${GESTES.map((g) => h`<label class="chip"><input type="checkbox" name="gestes" value="${g}" ${String(x.gestes || '').split('|').map((s) => s.trim()).includes(g) ? 'checked' : ''}>${g}</label>`)}</div></fieldset>
<label>Notice (PDF) <input type="file" name="notice" accept="application/pdf"></label>`;
  let detail = h`<section class="card"><p class="mut">Ajoute tes machines : un nom, les gestes qui les utilisent et leurs entretiens.</p></section>`;
  if (m) {
    const [cls, label] = STATE[m.state];
    const lastWear = m.tasks.filter((t) => t.every_hours).map((t) => t.last_done).sort().pop();
    const usage = M.usageSince(m, lastWear || m.since || '1970-01-01');
    const wear = q.all('SELECT * FROM stock_items WHERE machine_id = ? ORDER BY name', m.id);
    const hist = q.all('SELECT * FROM machine_events WHERE machine_id = ? ORDER BY date DESC LIMIT 12', m.id);
    detail = h`
<section class="card" style="border-top:0;padding-top:0">
<div class="line" style="align-items:flex-start"><div class="grow"><div class="eb" style="display:block">${m.type || 'Machine'}</div><div style="font-size:28px;font-weight:700;margin-top:4px">${m.name}</div>
<p class="mut mt4">${[m.brand, m.serial ? `n° ${m.serial}` : '', m.since ? `en service depuis ${m.since}` : ''].filter(Boolean).join(' · ') || 'Marque et modèle à compléter'}</p></div>${pill(cls, label)}</div>
${m.down_since ? h`<div class="flash ko mt12">En panne depuis le ${ddmm(m.down_since)}${m.down_note ? ` : ${m.down_note}` : ''}. Les fiches qui utilisent ses gestes sont signalées dans « À décider ».</div>` : ''}
<div class="line mt12">${m.notice ? h`<a class="btn alt sm" href="${fileUrl(m.notice)}" target="_blank">Notice (PDF)</a>` : ''}${m.sav_contact ? h`<span class="btn alt sm" style="cursor:default">SAV · ${m.sav_contact}</span>` : ''}
${m.down_since ? postBtn(`/machines/${m.id}/panne`, 'Remise en service', 'btn sm', { act: 'fin' })
    : h`<details class="menu"><summary class="btn alt sm">Signaler une panne</summary><form method="post" action="/machines/${m.id}/panne" class="menu-list form pad wide"><input type="hidden" name="act" value="debut"><label>Ce qui se passe <input name="note" required></label><button class="btn sm">Mettre en panne</button></form></details>`}
<details class="menu"><summary class="btn alt sm">Modifier</summary><form method="post" action="/machines/${m.id}" enctype="multipart/form-data" class="menu-list form pad wide">${machineForm(m)}<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1" data-confirm-btn="Supprimer cette machine et son historique ?">Supprimer</button></div></form></details></div>
<div class="line mt20" style="gap:40px;align-items:flex-start"><div><div class="h-light">Usage estimé</div><div class="big" style="font-size:34px;margin-top:8px">${String(usage).replace('.', ',')} h</div><p class="mut">depuis le dernier entretien d'usure</p></div>
<div class="grow"><div class="h-light">D'où vient ce chiffre</div><p class="mut mt8">${m.gestes ? `Heures déclarées des fiches « ${m.gestes.split('|').join(' », « ')} » terminées depuis ${lastWear ? ddmm(lastWear) : 'la mise en service'}. Personne ne pointe.` : 'Choisis dans « Modifier » les gestes qui utilisent cette machine pour suivre son usage.'}</p></div></div>
</section>

<section class="card"><div class="line"><h2>Plan d'entretien</h2></div>
<div class="tablebox"><table class="tbl"><thead><tr><th>Entretien</th><th>Fréquence</th><th>Dernière fois</th><th>Échéance</th><th></th></tr></thead><tbody>
${m.tasks.map((t) => h`<tr><td><b>${t.title}</b><div class="gauge mt8" style="max-width:220px"><i class="${t.st.late ? 'o' : ''}" style="width:${t.st.pct}%"></i></div></td><td class="mut">${t.freq}</td><td class="mut">${t.last_done ? ddmm(t.last_done) : '—'}</td>
<td>${pill(t.st.late ? 'ko' : t.st.soon ? 'wa' : 'no', t.st.label)}</td><td class="num">${postBtn(`/machines/${m.id}/taches/${t.id}/fait`, 'Fait', 'btn sm')}<div>${postBtn(`/machines/${m.id}/taches/${t.id}/supprimer`, 'retirer', 'linkbtn t12', {}, 'Retirer cet entretien ?')}</div></td></tr>`)}
${m.tasks.length ? '' : h`<tr><td colspan="5" class="mut">Aucun entretien prévu.</td></tr>`}</tbody></table></div>
<details class="mt12"><summary class="btn alt sm">+ Entretien</summary><form method="post" action="/machines/${m.id}/taches" class="form mt12 mw680">
<label>Quoi <input name="title" required placeholder="ex. Changer ou affûter les fers"></label>
<div class="grid2"><label>Toutes les … heures d'usage <input name="every_hours" inputmode="decimal" placeholder="ex. 120"></label><label>Ou tous les … jours <input name="every_days" inputmode="numeric" placeholder="ex. 30"></label></div>
<label>Fait la dernière fois le <input type="date" name="last_done" value="${today()}"></label><button class="btn sm">Ajouter</button></form></details>
</section>

<div class="cols" style="margin-top:0">
<section class="card main-col"><h2>Pièces d'usure</h2><p class="mut">Trois états, comme le stock : « Vide » part aux achats.</p>
${wear.map((w) => h`<div class="it"><span class="grow t15 b6">${w.name}</span><form method="post" action="/machines/${m.id}/usure/${w.id}" class="seg3">${['OK', 'Bientôt', 'Vide'].map((s, v) => h`<button name="state" value="${v}" class="${w.state === v ? ['ok', 'lo', 'no'][v] : ''}" aria-pressed="${w.state === v}">${s}</button>`)}</form></div>`)}
<form method="post" action="/machines/${m.id}/usure" class="line mt12"><label class="sr" for="wn">Pièce d'usure</label><input id="wn" class="qin" name="name" placeholder="ex. Fers 410 mm (jeu)" required><button class="btn alt sm">Ajouter</button></form>
</section>
<section class="card side-col"><h2>Historique</h2>
${hist.map((e, i) => h`<div class="who${i ? '' : ' f'}"><span class="day">${ddmm(e.date)}</span><div class="grow"><b class="t14">${e.title}</b><span class="mut t12">${[e.who, e.days_down ? `${String(e.days_down).replace('.', ',')} j d'arrêt` : ''].filter(Boolean).join(' · ')}</span></div>${pill(e.kind === 'panne' ? 'ko' : 'ok', e.kind === 'panne' ? 'Panne' : 'Entretien')}</div>`)}
${hist.length ? '' : h`<p class="mut">Rien encore.</p>`}
<form method="post" action="/machines/${m.id}/note" class="line mt12"><label class="sr" for="hn">Note</label><input id="hn" class="qin" name="title" placeholder="Noter une intervention" required><button class="btn alt sm">Noter</button></form>
</section></div>`;
  }
  const body = h`
<p class="line" style="margin:0 0 16px"><a class="btn alt sm" href="/cnc">CNC · outils, réglages et post-processeur</a></p>
<section class="band" style="padding-top:0"><h2>À faire</h2><span class="count">${overdue + soon + down}</span><span class="count">les entretiens se déclenchent à la date ou à l'usage, calculé depuis les fiches terminées : personne ne pointe</span></section>
<section class="kpis">
<div class="kpi"><div class="kpi-h"><span class="kpi-l">En service</span>${pill(down ? 'ko' : 'ok', down ? `${down} en panne` : 'aucune panne')}</div><div class="big">${all.length - down}</div><div class="sub2">machines sur ${all.length}</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Dépassés</span>${pill('ko', 'à faire')}</div><div class="big">${overdue}</div><div class="sub2">entretien(s) en retard</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Bientôt</span>${pill('wa', 'à prévoir')}</div><div class="big">${soon}</div><div class="sub2">sous 30 jours ou 20 h d'usage</div></div>
<div class="kpi"><div class="kpi-h"><span class="kpi-l">Arrêts ${year}</span>${pill('no', 'pannes')}</div><div class="big">${String(stops.d).replace('.', ',')} j</div><div class="sub2">${stops.n} panne(s) enregistrée(s)</div></div>
</section>
<div class="cols" style="margin-top:0;align-items:stretch">
<aside style="flex:0 0 440px;min-width:0;border-right:1px solid var(--line);margin:0 0 -64px -36px">
<div class="line" style="padding:16px 18px 12px 36px;border-bottom:1px solid var(--line)"><span class="h-light">Parc</span><details class="menu push"><summary class="btn sm">+ Machine</summary><form method="post" action="/machines" enctype="multipart/form-data" class="menu-list right-al form pad wide">${machineForm()}<button class="btn sm">Ajouter</button></form></details></div>
${all.map((x) => { const [c, l] = STATE[x.state]; return h`<a class="pickrow${m && x.id === m.id ? ' on' : ''}" href="/machines?m=${x.id}" style="padding-left:36px"><span class="grow"><b class="t15" style="display:block">${x.name}</b><span class="mut t13">${x.next ? x.next.title : 'Aucun entretien'}</span></span>
<span style="width:130px;flex:none">${x.next ? h`<span class="gauge" style="display:block"><i class="${x.next.st.late ? 'o' : ''}" style="width:${x.next.st.pct}%"></i></span><span class="t12 b" style="color:${x.next.st.late ? 'var(--red)' : 'var(--ink)'}">${x.next.st.label}</span>` : ''}</span>${pill(c, l)}</a>`; })}
</aside>
<div class="main-col" style="flex:999 1 520px;padding-top:24px">${detail}</div></div>`;
  res.send(layout({ title: 'Machines', heading: 'Machines', tab: 'machines', sub: '/machines', body, flash: req.flash }));
});

function machineValues(b, file) {
  const gestes = [].concat(b.gestes || []).map(str).filter(Boolean).join('|');
  return [str(b.name), str(b.type), str(b.brand), str(b.serial), str(b.since), gestes, str(b.sav_contact), file ? file.filename : null];
}
r.post('/machines', upload.single('notice'), (req, res) => {
  const id = q.run('INSERT INTO machines (name, type, brand, serial, since, gestes, sav_contact, notice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...machineValues(req.body, req.file)).lastInsertRowid;
  res.flashTo(`/machines?m=${id}`, 'Machine ajoutée. Ajoute ses entretiens.');
});
r.post('/machines/:id', upload.single('notice'), (req, res) => {
  if (req.body.del) { q.run('DELETE FROM machines WHERE id = ?', req.params.id); return res.flashTo('/machines', 'Machine supprimée.'); }
  q.run('UPDATE machines SET name = ?, type = ?, brand = ?, serial = ?, since = ?, gestes = ?, sav_contact = ?, notice = COALESCE(?, notice) WHERE id = ?', ...machineValues(req.body, req.file), req.params.id);
  res.redirect(`/machines?m=${req.params.id}`);
});
r.post('/machines/:id/taches', (req, res) => {
  const b = req.body;
  if (!num(b.every_hours) && !num(b.every_days)) return res.flashTo(`/machines?m=${req.params.id}`, 'Indique une fréquence en heures d’usage ou en jours.', 'ko');
  q.run('INSERT INTO machine_tasks (machine_id, title, every_hours, every_days, last_done) VALUES (?, ?, ?, ?, ?)', req.params.id, str(b.title), num(b.every_hours), num(b.every_days) ? Math.round(num(b.every_days)) : null, str(b.last_done) || today());
  res.redirect(`/machines?m=${req.params.id}`);
});
r.post('/machines/:id/taches/:tid/fait', (req, res) => {
  const t = q.get('SELECT * FROM machine_tasks WHERE id = ? AND machine_id = ?', req.params.tid, req.params.id);
  if (t) tx(() => {
    q.run("UPDATE machine_tasks SET last_done = datetime('now') WHERE id = ?", t.id);
    q.run("INSERT INTO machine_events (machine_id, title, kind, who) VALUES (?, ?, 'entretien', 'Patron')", req.params.id, t.title);
  });
  res.flashTo(`/machines?m=${req.params.id}`, 'Entretien noté, compteur relancé.');
});
r.post('/machines/:id/taches/:tid/supprimer', (req, res) => { q.run('DELETE FROM machine_tasks WHERE id = ? AND machine_id = ?', req.params.tid, req.params.id); res.redirect(`/machines?m=${req.params.id}`); });
r.post('/machines/:id/panne', (req, res) => {
  const m = q.get('SELECT * FROM machines WHERE id = ?', req.params.id);
  if (!m) return res.redirect('/machines');
  if (req.body.act === 'fin' && m.down_since) {
    const days = Math.max(0.5, Math.round((Date.now() - Date.parse(m.down_since.replace(' ', 'T') + 'Z')) / 864e5 * 2) / 2);
    tx(() => {
      q.run("INSERT INTO machine_events (machine_id, title, kind, who, days_down) VALUES (?, ?, 'panne', 'Patron', ?)", m.id, `Panne : ${m.down_note || 'sans précision'}`, days);
      q.run("UPDATE machines SET down_since = NULL, down_note = '' WHERE id = ?", m.id);
    });
    return res.flashTo(`/machines?m=${m.id}`, 'Machine remise en service, panne gardée dans l’historique.');
  }
  q.run("UPDATE machines SET down_since = datetime('now'), down_note = ? WHERE id = ?", str(req.body.note), m.id);
  res.flashTo(`/machines?m=${m.id}`, 'Machine signalée en panne.', 'ko');
});
r.post('/machines/:id/usure', (req, res) => {
  q.run("INSERT INTO stock_items (category, name, machine_id, ord) VALUES ('Usure machines', ?, ?, 99)", str(req.body.name), req.params.id);
  res.redirect(`/machines?m=${req.params.id}`);
});
r.post('/machines/:id/usure/:sid', (req, res) => {
  setStockState(Number(req.params.sid), Math.max(0, Math.min(2, Number(req.body.state))), L.patron().id);
  res.redirect(`/machines?m=${req.params.id}`);
});
r.post('/machines/:id/note', (req, res) => {
  q.run("INSERT INTO machine_events (machine_id, title, kind, who) VALUES (?, ?, 'entretien', 'Patron')", req.params.id, str(req.body.title));
  res.redirect(`/machines?m=${req.params.id}`);
});

module.exports = r;
