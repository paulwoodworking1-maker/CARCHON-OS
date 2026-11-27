'use strict';
// Test rapide : base neuve + démo, connexion patron, toutes les pages répondent sans erreur.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carchon-'));
let server, base, cookie = '';

before(async () => {
  require('../src/seed-demo');
  const app = require('../src/server');
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/connexion', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=demo-atelier&suite=/' });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  assert.strictEqual(res.status, 302);
});
after(() => server.close());

test('sans connexion, on est renvoyé vers la connexion', async () => {
  const res = await fetch(base + '/projets', { redirect: 'manual' });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get('location'), /connexion/);
});

const pages = ['/', '/projets', '/projets?vue=termines', '/projets/1', '/projets/nouveau', '/carnets', '/carnets/1', '/stock', '/achats', '/commandes',
  '/fournisseurs', '/planning', '/planning?semaines=4', '/poses', '/poses/1/pv', '/pilotage', '/pilotage/export.csv', '/equipe', '/portails', '/portails?nouveau=1', '/recherche?q=chêne', '/automatisations', '/automatisations/resume', '/projets/1/nouvelles', '/entreprise', '/carnets/1/imprimer', '/poses/1/pv/imprimer', '/commandes/1/bon', '/catalogue', '/catalogue?m=1&qty=12', '/machines', '/machines?m=2', '/charge', '/charge?p=2&w=1', '/bois', '/pieces', '/expeditions', '/expeditions/1/bon', '/sav', '/sav?nouveau=1', '/unites', '/unites/1', '/unites/6', '/pilotage/couts', '/projets/4', '/assistant', '/decider', '/decider?tag=Achat', '/projets?f=retard', '/projets?vue=frise', '/projets?resp=1&canal=Boutique', '/projets?f=acompte', '/portails/envoyer', '/portails/reglages', '/portails/parcours?p=1', '/portails?f=espaces', '/portails?f=signes', '/portails/envoyer?depuis=1', '/projets/1/sous-traitance/1/bon', '/projets/1/dossier/imprimer', '/projets/2/dossier/imprimer', '/projets/1?dictee=1', '/cnc', '/cnc/travaux/1', '/cnc/travaux/1/etiquettes', '/projets/2'];
for (const p of pages) {
  test(`GET ${p}`, async () => {
    const res = await fetch(base + p, { headers: { cookie } });
    assert.strictEqual(res.status, 200);
    assert.doesNotMatch(await res.text(), /Un problème est survenu/);
  });
}

test('un lien client inconnu est refusé', async () => {
  assert.strictEqual((await fetch(base + '/p/espace/faux')).status, 404);
  assert.strictEqual((await fetch(base + '/p/devis/faux')).status, 404);
});

test('le planning automatique pose les fiches envoyées', () => {
  const auto = require('../src/automations');
  const r = auto.autoPlan();
  assert.ok(r.bars > 0);
  assert.ok(Array.isArray(auto.alerts()));
});

test('lancer un lot depuis le catalogue numérote les pièces et réserve le bois', async () => {
  const { q } = require('../src/db');
  const P = require('../src/production');
  const t1 = q.get("SELECT id FROM models WHERE code = 'T1'").id;
  const id = P.launchFromModel(t1, { qty: 2, canal: 'Boutique' });
  const units = q.all('SELECT serial FROM units WHERE project_id = ? ORDER BY serial', id).map((u) => u.serial);
  assert.deepStrictEqual(units, ['T1-001', 'T1-002']);
  assert.ok(q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ?', id).n >= 5);
});

test('API Cockpit : clé requise, affaire créée, OF listés', async () => {
  const { setSetting } = require('../src/db');
  setSetting('api_token', 'cle-de-test-123456');
  assert.strictEqual((await fetch(base + '/api/v1/ofs')).status, 401);
  const auth = { authorization: 'Bearer cle-de-test-123456', 'content-type': 'application/json' };
  const res = await fetch(base + '/api/v1/affaires', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Buffet · noyer', client: { name: 'Client test', email: 'c@example.com' }, due_date: '2027-02-01' }) });
  assert.strictEqual(res.status, 201);
  const { ref } = await res.json();
  assert.match(ref, /^P\d{4}-\d{3}$/);
  assert.strictEqual((await fetch(`${base}/api/v1/affaires/${ref}/acompte`, { method: 'POST', headers: auth })).status, 200);
  const list = await (await fetch(base + '/api/v1/ofs', { headers: auth })).json();
  assert.ok(list.ofs.some((o) => o.ref === ref));
});

test('mot de passe oublié : lien valable, nouveau mot de passe, anciennes sessions déconnectées', async () => {
  assert.strictEqual((await fetch(base + '/mot-de-passe-oublie')).status, 200);
  const { setSetting } = require('../src/db');
  const { sha256 } = require('../src/auth');
  setSetting('reset_token', sha256('jeton-test'));
  setSetting('reset_expires', String(Date.now() + 60000));
  assert.strictEqual((await fetch(base + '/mot-de-passe/mauvais')).status, 200);
  const r = await fetch(base + '/mot-de-passe/jeton-test', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nouveau-mdp-1&confirm=nouveau-mdp-1' });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.get('location'), '/');
  const old = await fetch(base + '/projets', { headers: { cookie }, redirect: 'manual' });
  assert.match(old.headers.get('location') || '', /connexion/);
  const login = await fetch(base + '/connexion', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=nouveau-mdp-1&suite=/' });
  assert.strictEqual(login.headers.get('location'), '/');
  cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const again = await fetch(base + '/mot-de-passe/jeton-test');
  assert.match(await again.text(), /plus valable/);
});

test('assistant : chaque outil répond sur les données de démo', () => {
  const { RUN, TOOLS } = require('../src/assistant');
  const args = { chercher_of: { texte: 'S1', statut: 'tous' }, detail_of: { ref: 'P2026-001' }, noter_achat: { texte: 'Vis test × 100', ref_of: '' },
    ajouter_fiche_brouillon: { ref_of: 'P2026-001', titre: 'Fiche test', qui: 'Nina', heures: 2, mot: '' }, ajouter_absence: { qui: 'Nina', du: '2027-03-01', au: '2027-03-02', motif: 'Formation' } };
  assert.strictEqual(TOOLS.length, Object.keys(RUN).length);
  for (const t of TOOLS) {
    const out = RUN[t.name](args[t.name] || {});
    assert.ok(out && !out.erreur, `${t.name} : ${JSON.stringify(out).slice(0, 200)}`);
    JSON.stringify(out);
  }
});

const post = (p, body) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

test('actions groupées sur plusieurs OF : décaler, attribuer, envoyer', async () => {
  const { q } = require('../src/db');
  const ps = q.all("SELECT id, due_date FROM projects WHERE status = 'en_cours' AND due_date IS NOT NULL LIMIT 2");
  const body = new URLSearchParams([['act', 'decaler'], ['days', '7'], ['back', '/projets'], ...ps.map((p) => ['ids', String(p.id)])]);
  const res = await fetch(base + '/projets/lot', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  assert.strictEqual(res.status, 302);
  for (const p of ps) assert.strictEqual(q.get('SELECT due_date FROM projects WHERE id = ?', p.id).due_date, require('../src/html').addDays(p.due_date, 7));
  const lead = q.get("SELECT id FROM people WHERE role != 'patron' LIMIT 1").id;
  await post('/projets/lot', { act: 'resp', lead_id: lead, ids: ps[0].id });
  assert.strictEqual(q.get('SELECT lead_id FROM projects WHERE id = ?', ps[0].id).lead_id, lead);
  assert.strictEqual((await post('/projets/lot', { act: 'decaler' })).status, 302); // rien de coché : message, pas d'erreur
});

test('acompte reçu en un clic depuis À décider', async () => {
  const { q } = require('../src/db');
  const p = q.get("SELECT id FROM projects WHERE client_id IS NOT NULL AND deposit_needed = 1 AND deposit_at IS NULL LIMIT 1");
  if (!p) return;
  const r = await post(`/projets/${p.id}/acompte`, { back: '/decider' });
  assert.strictEqual(r.headers.get('location'), '/decider');
  assert.ok(q.get('SELECT deposit_at FROM projects WHERE id = ?', p.id).deposit_at);
});

test('« Plus tard » écarte une décision, « Tout réafficher » la remet', async () => {
  const L = require('../src/logic');
  const before = L.toDecide();
  assert.ok(before.length > 0);
  await post('/decider/plus-tard', { key: before[0].key, back: '/' });
  assert.strictEqual(L.toDecide().length, before.length - 1);
  await post('/decider/tout-reafficher', {});
  assert.strictEqual(L.toDecide().length, before.length);
});

test('les alertes nombreuses du même genre sont regroupées', () => {
  const L = require('../src/logic');
  const items = Array.from({ length: 6 }, (_, i) => ({ kind: 'ko', tag: 'Acompte', title: `OF ${i} · acompte`, text: '', href: `/projets/${i}`, cta: 'x' }));
  const g = L.groupDecide([...items, { kind: 'wa', tag: 'Achat', title: 'Vis', text: '', href: '/achats', cta: 'x' }]);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].group, 6);
});

test('transactions imbriquées et sauvegarde de la base', async () => {
  const { tx, q } = require('../src/db');
  assert.throws(() => tx(() => { q.run("INSERT INTO suppliers (name) VALUES ('Tmp A')"); tx(() => { throw new Error('non'); }); }));
  assert.ok(!q.get("SELECT id FROM suppliers WHERE name = 'Tmp A'"));
  tx(() => { tx(() => q.run("INSERT INTO suppliers (name) VALUES ('Tmp B')")); });
  assert.ok(q.get("SELECT id FROM suppliers WHERE name = 'Tmp B'"));
  const B = require('../src/backup');
  assert.ok(B.daily());
  assert.strictEqual(B.list().length, 1);
  const res = await fetch(base + '/sauvegarde/maintenant', { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(Buffer.from(await res.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.strictEqual((await fetch(base + '/sauvegarde/..%2Fcarchon.db', { headers: { cookie } })).status, 404);
  assert.strictEqual((await fetch(base + '/sante')).status, 200);
});

test('SMS : numéro, lien chiffré, regroupement des nouveautés, texte final', () => {
  const SMS = require('../src/sms');
  const { q } = require('../src/db');
  assert.strictEqual(SMS.normalize('06 12 34 56 78'), '33612345678');
  assert.strictEqual(SMS.normalize('+33 7 12 34 56 78'), '33712345678');
  assert.strictEqual(SMS.normalize('abc'), '');
  assert.strictEqual(SMS.open(SMS.seal('jeton-secret')), 'jeton-secret');
  const p = q.get('SELECT id, client_id FROM projects WHERE client_id IS NOT NULL LIMIT 1');
  q.run("UPDATE clients SET phone = '06 11 22 33 44', sms_off = 0 WHERE id = ?", p.client_id);
  q.run("UPDATE projects SET portal_state = 'open', portal_token_enc = ? WHERE id = ?", SMS.seal('abc123'), p.id);
  q.run('DELETE FROM sms_queue');
  SMS.notify('maj', { projectId: p.id, quoi: 'nouvelle photo' });
  SMS.notify('maj', { projectId: p.id, quoi: 'nouveau document : plan' });
  const rows = q.all('SELECT * FROM sms_queue');
  assert.strictEqual(rows.length, 1);
  const text = SMS.compose(rows[0]);
  assert.match(text, /nouvelle photo, nouveau document/);
  assert.match(text, /\/p\/espace\/abc123/);
  assert.doesNotMatch(text, /[’«»]/);
  q.run('UPDATE clients SET sms_off = 1 WHERE id = ?', p.client_id); q.run('DELETE FROM sms_queue');
  SMS.notify('acompte', { projectId: p.id });
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM sms_queue').n, 0);
  assert.strictEqual(SMS.quietNow(new Date('2026-11-29T12:00:00+01:00')), true); // dimanche
  assert.strictEqual(SMS.quietNow(new Date('2026-11-26T10:00:00+01:00')), false);
  assert.strictEqual(SMS.quietNow(new Date('2026-11-26T22:00:00+01:00')), true);
});

const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('la fiche projet est rangée en onglets avec le dossier de production et la sous-traitance', async () => {
  const html = await (await fetch(base + '/projets/1', { headers: { cookie } })).text();
  for (const id of ['id="vue"', 'id="dossier"', 'id="achats"', 'id="echanges"', 'id="sous-traitance"', 'id="carnet"', 'id="debit"', 'Laquage des façades', 'Retour en retard']) assert.ok(html.includes(id), id);
});

test('une commande de sous-traitance se crée, avance et recule', async () => {
  const { q } = require('../src/db');
  const res = await fetch(base + '/projets/2/sous-traitance', form({ what: 'Découpe numérique des joues', new_name: 'Atelier CNC', new_email: 'cnc@example.com', pieces: '2 joues', due_at: '2099-01-10', price: '120,50' }));
  assert.strictEqual(res.status, 302);
  const s = q.get("SELECT * FROM subcontracts WHERE what = 'Découpe numérique des joues'");
  assert.strictEqual(s.price, 120.5);
  assert.strictEqual(q.get('SELECT subcontractor FROM suppliers WHERE id = ?', s.supplier_id).subcontractor, 1);
  await fetch(base + `/projets/2/sous-traitance/${s.id}/etape`, form({ to: 'commande' }));
  await fetch(base + `/projets/2/sous-traitance/${s.id}/etape`, form({ to: 'envoye' }));
  let t = q.get('SELECT * FROM subcontracts WHERE id = ?', s.id);
  assert.strictEqual(t.status, 'envoye'); assert.ok(t.ordered_at && t.sent_at);
  await fetch(base + `/projets/2/sous-traitance/${s.id}/etape`, form({ to: 'commande' }));
  t = q.get('SELECT * FROM subcontracts WHERE id = ?', s.id);
  assert.strictEqual(t.status, 'commande'); assert.strictEqual(t.sent_at, null);
  const bon = await (await fetch(base + `/projets/2/sous-traitance/${s.id}/bon`, { headers: { cookie } })).text();
  assert.match(bon, /Atelier CNC/);
  assert.match(await (await fetch(base + '/commandes', { headers: { cookie } })).text(), /Découpe numérique des joues/);
});

test('un retour de sous-traitance en retard remonte dans À décider', () => {
  const L = require('../src/logic');
  assert.ok(L.toDecide().some((d) => d.tag === 'Sous-traitance'));
});

test('sans assistant, la génération du carnet explique quoi faire', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await fetch(base + '/projets/1/dossier/generer', form({ plan_ids: '2', text: 'test' }));
  assert.strictEqual(res.status, 302);
});

test('les plans sont envoyés à l’assistant en PDF ou image, les autres formats sont écartés', () => {
  const ai = require('../src/ai');
  const files = { 'a.pdf': Buffer.from('%PDF-1.4'), 'b.png': Buffer.from('png'), 'c.heic': Buffer.from('x') };
  const out = ai.planBlocks([{ version: 'V1', file: 'a.pdf', status: 'validee' }, { version: 'V2', file: 'b.png' }, { version: 'V3', file: 'c.heic' }, { version: 'V4', file: null }], (f) => files[f]);
  assert.deepStrictEqual(out.blocks.filter((b) => b.type !== 'text').map((b) => b.type), ['document', 'image']);
  assert.strictEqual(out.skipped.length, 2);
});

test('CNC : liste OpenCutList, travail, programme bloqué puis validé, fiche du carnet et iPad', async () => {
  const { q } = require('../src/db');
  const C = require('../src/routes/cnc');
  const cut = C.parseCutList('Nom;Quantité;Longueur;Largeur;Épaisseur;Matière\nJoue;2;720 mm;560 mm;19 mm;Mélaminé\nFond;1;"1 200,5";780;8;MDF\n;;;\n');
  assert.strictEqual(cut.items.length, 2);
  assert.strictEqual(cut.items[1].l, 1200.5);
  // Le travail de démo calcule, s'affiche et se télécharge.
  const nc = await fetch(base + '/cnc/travaux/1/panneau/1.nc', { headers: { cookie } });
  assert.strictEqual(nc.status, 200);
  assert.match(await nc.text(), /M06/);
  assert.strictEqual((await fetch(base + '/cnc/travaux/1/panneau/1.dxf', { headers: { cookie } })).status, 200);
  // Une erreur bloque le téléchargement.
  const fd = { material: 'Mélaminé', thickness: '19', sheet_l: '2800', sheet_w: '2070', n: '2', name_0: 'Énorme', l_0: '5000', w_0: '300', qty_0: '1', ops_0: '' };
  const j = q.run("INSERT INTO cnc_jobs (project_id, name, parts) VALUES (2, 'Essai', '[]')").lastInsertRowid;
  await fetch(base + `/cnc/travaux/${j}`, form(fd));
  assert.strictEqual((await fetch(base + `/cnc/travaux/${j}/panneau/1.nc`, { headers: { cookie } })).status, 404);
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM cnc_programs WHERE job_id = ?', j).n, 0);
  await fetch(base + `/cnc/travaux/${j}`, form({ ...fd, l_0: '700' }));
  const v = await fetch(base + `/cnc/travaux/${j}/valider`, form({}));
  assert.strictEqual(v.status, 302);
  const prog = q.get('SELECT * FROM cnc_programs WHERE job_id = ? AND active = 1', j);
  assert.ok(prog);
  const step = q.get('SELECT * FROM steps WHERE id = (SELECT step_id FROM cnc_jobs WHERE id = ?)', j);
  assert.strictEqual(step.geste, 'Usinage CNC');
  assert.ok(step.est_hours >= 0.5);
  await fetch(base + `/cnc/travaux/${j}/valider`, form({}));
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM cnc_programs WHERE job_id = ? AND active = 1', j).n, 1);
  assert.strictEqual(q.get('SELECT MAX(version) v FROM cnc_programs WHERE job_id = ?', j).v, 2);
  // Achats : panneaux ajoutés au projet.
  await fetch(base + `/cnc/travaux/${j}/achats`, form({}));
  assert.ok(q.get("SELECT id FROM needs WHERE project_id = 2 AND source = 'cnc'"));
});
