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
  '/fournisseurs', '/planning', '/planning?semaines=4', '/poses', '/poses/1/pv', '/pilotage', '/pilotage/export.csv', '/equipe', '/portails', '/portails?nouveau=1', '/recherche?q=chêne', '/automatisations', '/automatisations/resume', '/projets/1/nouvelles', '/entreprise', '/carnets/1/imprimer', '/poses/1/pv/imprimer', '/commandes/1/bon', '/catalogue', '/catalogue?m=1&qty=12', '/machines', '/machines?m=2', '/charge', '/charge?p=2&w=1', '/bois', '/pieces', '/expeditions', '/expeditions/1/bon', '/sav', '/sav?nouveau=1', '/unites', '/unites/1', '/unites/6', '/pilotage/couts', '/projets/4', '/assistant', '/decider', '/decider?tag=Achat', '/projets?f=retard', '/projets?vue=frise', '/projets?resp=1&canal=Boutique', '/projets?f=acompte'];
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
