'use strict';
// Stock (3 états), À commander, Commandes en cours, Fournisseurs.
const express = require('express');
const { q, tx, STOCK_CATS } = require('../db');
const { h, raw, layout, pill, postBtn, options, ddmm, ddmmyyyy, rel, today, printPage } = require('../html');
const L = require('../logic');

const r = express.Router();
const str = (v) => String(v ?? '').trim();
const STATES = ['OK', 'Bientôt', 'Vide'];

// Passer un article en « Vide » l'ajoute aux achats (une seule fois) ; « OK » retire la ligne si elle n'est pas commandée.
function setStockState(itemId, state, personId) {
  const it = q.get('SELECT * FROM stock_items WHERE id = ?', itemId);
  if (!it) return;
  tx(() => {
    q.run('UPDATE stock_items SET state = ? WHERE id = ?', state, it.id);
    const open = q.get("SELECT id FROM needs WHERE stock_item_id = ? AND status = 'todo'", it.id);
    if (state === 2 && !open) {
      const isPatron = q.get('SELECT role FROM people WHERE id = ?', personId)?.role === 'patron';
      q.run("INSERT INTO needs (text, category, supplier_id, stock_item_id, person_id, source, acknowledged) VALUES (?, ?, ?, ?, ?, 'stock', ?)", it.name, it.category, it.supplier_id, it.id, personId, isPatron ? 1 : 0);
    }
    if (state === 0 && open) q.run('DELETE FROM needs WHERE id = ?', open.id);
  });
}

const counts = () => ({ '/commandes': q.get('SELECT COUNT(*) n FROM orders WHERE arrived_at IS NULL').n });

// ---------- Stock ----------
r.get('/stock', (req, res) => {
  const items = q.all('SELECT * FROM stock_items ORDER BY category, ord, name');
  const cats = [...new Set([...STOCK_CATS, ...items.map((i) => i.category)])];
  const sups = q.all('SELECT id, name FROM suppliers ORDER BY name');
  const body = h`<div class="head"><div><div class="eb">Stock</div><h1>Ce qu'on suit</h1>
<p class="mut mt8 mw680 t14">On ne compte rien. Chaque article a trois états, changés d'un tap, ici ou depuis l'iPad. « Vide » l'ajoute aux achats.</p></div>
<details class="menu push"><summary class="btn alt">+ Suivre un article</summary><form method="post" action="/stock" class="menu-list form pad">
<label>Article <input name="name" required></label><label>Rayon <input name="category" list="cats" required value="Quincaillerie"></label>
<datalist id="cats">${cats.map((c) => h`<option value="${c}">`)}</datalist>
<label>Fournisseur habituel <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]))}</select></label><button class="btn sm">Ajouter</button></form></details></div>
<div class="flexcards mt20">${cats.filter((c) => items.some((i) => i.category === c)).map((c) => h`<section class="card tight"><div class="h3">${c}</div>
${items.filter((i) => i.category === c).map((i, k) => h`<div class="it${k ? '' : ' f'}"><div class="grow"><div class="t15 b6">${i.name}</div>${i.state === 2 ? h`<div class="t12 red">Ajouté aux achats</div>` : ''}</div>
<form method="post" action="/stock/${i.id}" class="seg3" role="group" aria-label="État de ${i.name}">${STATES.map((s, v) => h`<button name="state" value="${v}" class="${i.state === v ? ['ok', 'lo', 'no'][v] : ''}" aria-pressed="${i.state === v}">${s}</button>`)}</form>
<details class="menu"><summary class="iconbtn" aria-label="Modifier ${i.name}">⋯</summary><form method="post" action="/stock/${i.id}/modifier" class="menu-list right-al form pad">
<label>Nom <input name="name" value="${i.name}"></label><label>Rayon <input name="category" value="${i.category}" list="cats"></label>
<label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]), i.supplier_id)}</select></label>
<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Ne plus suivre</button></div></form></details></div>`)}
</section>`)}</div>`;
  res.send(layout({ title: 'Stock', tab: 'stock', body, flash: req.flash }));
});
r.post('/stock', (req, res) => {
  q.run('INSERT INTO stock_items (category, name, supplier_id, ord) VALUES (?, ?, ?, 99)', str(req.body.category) || 'Divers', str(req.body.name), req.body.supplier_id ? Number(req.body.supplier_id) : null);
  res.redirect('/stock');
});
r.post('/stock/:id', (req, res) => { setStockState(Number(req.params.id), Math.max(0, Math.min(2, Number(req.body.state))), L.patron().id); res.redirect('/stock'); });
r.post('/stock/:id/modifier', (req, res) => {
  if (req.body.del) q.run('DELETE FROM stock_items WHERE id = ?', req.params.id);
  else q.run('UPDATE stock_items SET name = ?, category = ?, supplier_id = ? WHERE id = ?', str(req.body.name), str(req.body.category), req.body.supplier_id ? Number(req.body.supplier_id) : null, req.params.id);
  res.redirect('/stock');
});

// ---------- À commander ----------
r.get('/achats', (req, res) => {
  const needs = q.all(`SELECT needs.*, people.name pname, people.role prole, projects.name projname, projects.deposit_at FROM needs
    LEFT JOIN people ON people.id = needs.person_id LEFT JOIN projects ON projects.id = needs.project_id WHERE needs.status = 'todo' ORDER BY needs.created_at DESC`);
  const sups = q.all('SELECT * FROM suppliers ORDER BY name');
  const groups = [...sups.map((s) => ({ s, rows: needs.filter((n) => n.supplier_id === s.id) })), { s: null, rows: needs.filter((n) => !n.supplier_id) }].filter((g) => g.rows.length);
  const projects = q.all("SELECT id, name FROM projects WHERE status = 'en_cours' ORDER BY name");
  const orders = q.all('SELECT orders.*, suppliers.name sname FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE arrived_at IS NULL ORDER BY ordered_at DESC');
  const who = (n) => (n.prole === 'patron' ? 'par toi' : n.pname ? `par ${n.pname}` : '');
  const blocked = (n) => n.needs_deposit && !n.force;
  const body = h`<div class="eb">Achats</div><h1>À commander</h1>
<p class="mut mt8">Ce que les projets demandent et ce qui a été signalé vide, regroupé par fournisseur. Rien ne part sans ta validation.</p>
<section class="card warm mt20" id="noter"><h2>Noter à recommander</h2>
<form method="post" action="/achats/besoin" class="form mt12">
<div class="line"><label class="sr" for="nq">Ce qu'il faut recommander</label><input id="nq" class="qin" name="text" required placeholder="ex. vis SPAX 4 × 40, disques grain 120…"><button class="btn">Noter</button></div>
<fieldset class="chips m0" aria-label="Rayon (facultatif)">${STOCK_CATS.map((c) => h`<label class="chip"><input type="radio" name="category" value="${c}">${c}</label>`)}</fieldset>
<div class="grid2"><label>Fournisseur (facultatif) <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]))}</select></label>
<label>Pour le projet (facultatif) <select name="project_id"><option value="">—</option>${options(projects.map((p) => [p.id, p.name]))}</select></label></div>
<label class="ck"><input type="checkbox" name="needs_deposit" value="1"> Attendre l'acompte du projet avant de commander</label>
</form>
<p class="mut mt8">Le rayon est facultatif. L'atelier note aussi depuis l'iPad avec « Il manque », ou en passant un article en « Vide » dans le stock.</p></section>

<div class="stack18 mt20">
${groups.map((g) => {
    const ready = g.rows.filter((n) => !blocked(n));
    const nChecked = ready.filter((n) => n.checked).length;
    return h`<section class="card"><div class="line"><h2>${g.s ? g.s.name : 'Sans fournisseur'}</h2><span class="mut">${g.s ? [g.s.habit, g.s.email || g.s.phone].filter(Boolean).join(' · ') : 'choisis un fournisseur pour pouvoir commander'}</span></div>
${g.rows.map((n) => h`<div class="ln">
<form method="post" action="/achats/besoin/${n.id}/cocher" class="inline"><input class="ckb" type="checkbox" id="n${n.id}" name="checked" value="1" ${n.checked && !blocked(n) ? 'checked' : ''} ${blocked(n) || !g.s ? 'disabled' : ''} data-auto aria-label="Commander ${n.text}"></form>
<div class="grow"><b>${n.text}</b><div class="mut">${[n.source === 'stock' ? `Signalé vide ${who(n)}` : n.source === 'ipad' ? `Il manque · ${who(n)}` : `Noté ${who(n)} · ${rel(n.created_at)}`, n.category, n.projname].filter(Boolean).join(' · ')}</div></div>
${blocked(n) ? pill('ko', 'Attend l’acompte') : n.source === 'stock' ? pill('wa', 'Vide') : n.project_id ? pill('no', 'Projet') : ''}
<details class="menu"><summary class="iconbtn" aria-label="Modifier">⋯</summary><form method="post" action="/achats/besoin/${n.id}" class="menu-list right-al form pad">
<label>Texte <input name="text" value="${n.text}"></label>
<label>Fournisseur <select name="supplier_id"><option value="">—</option>${options(sups.map((s) => [s.id, s.name]), n.supplier_id)}</select></label>
<div class="line">${blocked(n) ? h`<button class="btn sm" name="force" value="1">Commander quand même</button>` : ''}<button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1">Retirer</button></div></form></details>
</div>`)}
${g.s ? h`<form method="post" action="/achats/commander" class="line mt12"><input type="hidden" name="supplier_id" value="${g.s.id}">
<button class="btn" ${nChecked ? '' : 'disabled'}>${nChecked ? `Commander ${nChecked} ligne${nChecked > 1 ? 's' : ''}` : 'Aucune ligne cochée'}</button>
<label class="mut">Attendue le <input type="date" name="expected_at"></label></form>
${g.rows.some(blocked) ? h`<p class="mut mt8">Les lignes « Attend l’acompte » se débloquent toutes seules quand l'acompte est noté dans le projet.</p>` : ''}` : ''}
</section>`;
  })}
${groups.length ? '' : h`<section class="card"><p class="mut">Rien à commander pour l'instant.</p></section>`}

<section class="card"><div class="line"><h2>Commandes en cours</h2><a class="push b" href="/commandes">Tout voir</a></div>
${orders.map((o, i) => h`<div class="ln${i ? '' : ' f'}"><div class="grow"><b>${o.sname || '—'} · ${o.what}</b><div class="mut">Commandée le ${ddmm(o.ordered_at)}${o.expected_at ? ` · attendue le ${ddmm(o.expected_at)}` : ''}</div></div>${pill('wa', 'Attendue')}${postBtn(`/commandes/${o.id}/arrivee`, 'Arrivé', 'btn alt sm')}</div>`)}
${orders.length ? '' : h`<p class="mut">Aucune commande en route.</p>`}</section>
</div>`;
  res.send(layout({ title: 'À commander', tab: 'achats', sub: '/achats', body, flash: req.flash, counts: counts() }));
});

r.post('/achats/besoin', (req, res) => {
  const b = req.body;
  if (!str(b.text)) return res.redirect('/achats');
  const pid = b.project_id ? Number(b.project_id) : null;
  const dep = pid && b.needs_deposit ? (q.get('SELECT deposit_at FROM projects WHERE id = ?', pid)?.deposit_at ? 0 : 1) : 0;
  q.run("INSERT INTO needs (text, category, supplier_id, project_id, person_id, source, needs_deposit, acknowledged) VALUES (?, ?, ?, ?, ?, 'note', ?, 1)",
    str(b.text), str(b.category), b.supplier_id ? Number(b.supplier_id) : null, pid, L.patron().id, dep);
  res.flashTo('/achats', 'Noté.');
});
r.post('/achats/besoin/:id', (req, res) => {
  const b = req.body;
  if (b.del) q.run('DELETE FROM needs WHERE id = ?', req.params.id);
  else q.run('UPDATE needs SET text = ?, supplier_id = ?, force = MAX(force, ?), acknowledged = 1 WHERE id = ?', str(b.text), b.supplier_id ? Number(b.supplier_id) : null, b.force ? 1 : 0, req.params.id);
  res.redirect('/achats');
});
r.post('/achats/besoin/:id/cocher', (req, res) => { q.run('UPDATE needs SET checked = ? WHERE id = ?', req.body.checked ? 1 : 0, req.params.id); res.redirect('/achats'); });
r.post('/achats/besoin/:id/valider', (req, res) => { q.run('UPDATE needs SET acknowledged = 1 WHERE id = ?', req.params.id); res.flashTo('/achats', 'Validé : la ligne attend ta commande ci-dessous.'); });

r.post('/achats/commander', (req, res) => {
  const sid = Number(req.body.supplier_id);
  const s = q.get('SELECT * FROM suppliers WHERE id = ?', sid);
  const lines = q.all("SELECT * FROM needs WHERE supplier_id = ? AND status = 'todo' AND checked = 1 AND (needs_deposit = 0 OR force = 1)", sid);
  if (!s || !lines.length) return res.redirect('/achats');
  const what = lines.map((l) => l.text).join(', ');
  let oid;
  tx(() => {
    oid = q.run('INSERT INTO orders (supplier_id, what, expected_at) VALUES (?, ?, ?)', sid, what, str(req.body.expected_at) || null).lastInsertRowid;
    lines.forEach((l) => q.run("UPDATE needs SET status = 'ordered', order_id = ?, acknowledged = 1 WHERE id = ?", oid, l.id));
  });
  const mail = s.email ? `mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent('Commande Carchon Les Ateliers')}&body=${encodeURIComponent(`Bonjour,\n\nPouvez-vous nous livrer :\n${lines.map((l) => `- ${l.text}`).join('\n')}\n\nMerci,\nCarchon Les Ateliers`)}` : '';
  res.flashTo('/achats', '', 'ok', { html: `Commande notée chez ${s.name.replace(/[<>&"]/g, '')}. <a href="/commandes/${oid}/bon">Bon de commande</a> · ${mail ? `<a href="${mail.replace(/"/g, '&quot;')}">Écrire le mail de commande</a>` : s.phone ? `Appelle le ${s.phone.replace(/[<>&"]/g, '')}.` : ''}` });
});

// Bon de commande imprimable (ou à joindre en PDF au fournisseur).
r.get('/commandes/:id/bon', (req, res) => {
  const o = q.get('SELECT orders.*, suppliers.name sname, suppliers.contact scontact, suppliers.email semail, suppliers.phone sphone FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE orders.id = ?', req.params.id);
  if (!o) return res.redirect('/commandes');
  const lines = q.all('SELECT needs.*, projects.ref pref, projects.name pname FROM needs LEFT JOIN projects ON projects.id = needs.project_id WHERE order_id = ? ORDER BY needs.id', o.id);
  const ref = `BC-${o.ordered_at.slice(0, 4)}-${String(o.id).padStart(4, '0')}`;
  res.send(printPage('Bon de commande', h`
<table><tr><td><b>Fournisseur</b><br>${o.sname || '—'}${o.scontact ? h`<br>${o.scontact}` : ''}${o.semail ? h`<br>${o.semail}` : ''}${o.sphone ? h`<br>${o.sphone}` : ''}</td>
<td><b>Date de commande</b><br>${ddmmyyyy(o.ordered_at)}</td><td><b>Livraison souhaitée</b><br>${o.expected_at ? ddmmyyyy(o.expected_at) : 'dès que possible'}</td></tr></table>
<h2>Articles</h2>
<table><thead><tr><th>#</th><th>Désignation</th><th>Pour le dossier</th></tr></thead><tbody>
${(lines.length ? lines : o.what.split(', ').map((t) => ({ text: t }))).map((l, i) => h`<tr><td>${i + 1}</td><td>${l.text}</td><td>${l.pref ? `${l.pref} · ${l.pname}` : '—'}</td></tr>`)}
</tbody></table>
<p class="mut" style="margin-top:16px">Merci de rappeler la référence ${ref} sur le bon de livraison et la facture.</p>
<div class="sign"><div>Pour ${require('../db').company().name}<br>Date et signature</div><div>Accusé de réception du fournisseur</div></div>`, { ref, date: ddmmyyyy(o.ordered_at) }));
});

// ---------- Commandes en cours ----------
r.get('/commandes', (req, res) => {
  const rows = q.all('SELECT orders.*, suppliers.name sname FROM orders LEFT JOIN suppliers ON suppliers.id = orders.supplier_id WHERE arrived_at IS NULL OR arrived_at >= date(\'now\', \'-14 days\') ORDER BY arrived_at IS NOT NULL, ordered_at DESC');
  const waiting = q.all("SELECT needs.text, projects.name FROM needs JOIN projects ON projects.id = needs.project_id WHERE needs.status = 'todo' AND needs.needs_deposit = 1 AND needs.force = 0");
  const body = h`<div class="eb">Achats</div><h1>Commandes en cours</h1>
<p class="mut mt8">Deux états seulement : commandé, puis arrivé. Un tap quand le colis est là, et l'article repasse en « OK » dans le stock.</p>
<section class="card mt20">${rows.map((o, i) => h`<div class="it${i ? '' : ' f'}"><div class="grow"><b>${o.sname || '—'}</b><div>${o.what}</div><div class="mut">Commandé le ${ddmm(o.ordered_at)}${o.expected_at ? ` · attendu le ${ddmm(o.expected_at)}` : ''}${o.arrived_at ? ` · arrivé le ${ddmm(o.arrived_at)}` : ''}</div></div>
<a class="btn alt sm" href="/commandes/${o.id}/bon">Bon de commande</a>${o.arrived_at ? postBtn(`/commandes/${o.id}/arrivee`, 'Arrivé ✓', 'btn sm done', { undo: 1 }) : postBtn(`/commandes/${o.id}/arrivee`, 'Arrivé', 'btn alt')}</div>`)}
${rows.length ? '' : h`<p class="mut">Aucune commande en cours.</p>`}</section>
${waiting.map((w) => h`<p class="mut mt12">${w.text} (${w.name}) n'est pas encore commandé : il attend l'acompte, dans <a href="/achats">« À commander »</a>.</p>`)}`;
  res.send(layout({ title: 'Commandes', tab: 'achats', sub: '/commandes', body, flash: req.flash, counts: counts() }));
});
r.post('/commandes/:id/arrivee', (req, res) => {
  const back = req.get('referer')?.includes('/achats') ? '/achats' : '/commandes';
  tx(() => {
    if (req.body.undo) { q.run('UPDATE orders SET arrived_at = NULL WHERE id = ?', req.params.id); q.run("UPDATE needs SET status = 'ordered' WHERE order_id = ?", req.params.id); return; }
    q.run('UPDATE orders SET arrived_at = ? WHERE id = ?', today(), req.params.id);
    q.run("UPDATE needs SET status = 'arrived' WHERE order_id = ?", req.params.id);
    q.run('UPDATE stock_items SET state = 0 WHERE id IN (SELECT stock_item_id FROM needs WHERE order_id = ? AND stock_item_id IS NOT NULL)', req.params.id);
  });
  res.redirect(back);
});

// ---------- Fournisseurs ----------
r.get('/fournisseurs', (req, res) => {
  const rows = q.all('SELECT * FROM suppliers ORDER BY name');
  const form = (s = {}) => h`<label>Nom <input name="name" value="${s.name || ''}" required></label><label>Contact <input name="contact" value="${s.contact || ''}"></label>
<div class="grid2"><label>Téléphone <input name="phone" type="tel" value="${s.phone || ''}"></label><label>E-mail <input name="email" type="email" value="${s.email || ''}"></label></div>
<label>Habitude (délai, mode de commande) <input name="habit" value="${s.habit || ''}" placeholder="ex. commande par mail · livré en 2 jours"></label>
<label>Délai de livraison habituel (jours ouvrés, sert au planning) <input name="lead_days" inputmode="numeric" value="${s.lead_days ?? ''}" placeholder="ex. 5"></label>
<label>Note pour l'équipe <textarea name="note" rows="2">${s.note || ''}</textarea></label>`;
  const body = h`<div class="head"><div><div class="eb">Achats</div><h1>Fournisseurs</h1><p class="mut mt8">Un contact et une note, écrits une fois. L'équipe sait qui appeler.</p></div>
<details class="menu push"><summary class="btn">+ Fournisseur</summary><form method="post" action="/fournisseurs" class="menu-list right-al form pad wide">${form()}<button class="btn sm">Ajouter</button></form></details></div>
<div class="flexcards mt20">${rows.map((s) => h`<section class="card"><div class="line"><h2>${s.name}</h2></div><p class="mut">${[s.contact, s.phone, s.email].filter(Boolean).join(' · ') || 'Pas de contact noté'}</p><p>${s.note}</p>
<div class="line">${s.phone ? h`<a class="btn alt sm" href="tel:${s.phone}">Appeler</a>` : ''}${s.email ? h`<a class="btn alt sm" href="mailto:${s.email}">Écrire</a>` : ''}
<details class="menu"><summary class="btn alt sm">Modifier</summary><form method="post" action="/fournisseurs/${s.id}" class="menu-list form pad wide">${form(s)}<div class="line"><button class="btn sm">Enregistrer</button><button class="btn alt sm" name="del" value="1" data-confirm-btn="Supprimer ce fournisseur ?">Supprimer</button></div></form></details></div></section>`)}
${rows.length ? '' : h`<section class="card"><p class="mut">Ajoute tes fournisseurs habituels : scierie, droguerie, quincaillerie, négoce de panneaux…</p></section>`}</div>`;
  res.send(layout({ title: 'Fournisseurs', tab: 'achats', sub: '/fournisseurs', body, flash: req.flash, counts: counts() }));
});
const supFields = (b) => [str(b.name), str(b.contact), str(b.phone), str(b.email), str(b.habit), str(b.note), Number(b.lead_days) > 0 ? Math.round(Number(b.lead_days)) : null];
r.post('/fournisseurs', (req, res) => { q.run('INSERT INTO suppliers (name, contact, phone, email, habit, note, lead_days) VALUES (?, ?, ?, ?, ?, ?, ?)', ...supFields(req.body)); res.redirect('/fournisseurs'); });
r.post('/fournisseurs/:id', (req, res) => {
  if (req.body.del) q.run('DELETE FROM suppliers WHERE id = ?', req.params.id);
  else q.run('UPDATE suppliers SET name = ?, contact = ?, phone = ?, email = ?, habit = ?, note = ?, lead_days = ? WHERE id = ?', ...supFields(req.body), req.params.id);
  res.redirect('/fournisseurs');
});

module.exports = r;
module.exports.setStockState = setStockState;
void raw;
