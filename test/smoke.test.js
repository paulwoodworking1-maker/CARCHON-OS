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
  '/fournisseurs', '/planning', '/planning?semaines=4', '/poses', '/poses/1/pv', '/pilotage', '/pilotage/export.csv', '/equipe', '/portails', '/portails?nouveau=1', '/recherche?q=chêne', '/automatisations', '/automatisations/resume', '/projets/1/nouvelles', '/entreprise', '/carnets/1/imprimer', '/poses/1/pv/imprimer', '/commandes/1/bon', '/catalogue', '/catalogue?m=1&qty=12', '/machines', '/machines?m=2', '/charge', '/charge?p=2&w=1', '/bois', '/pieces', '/expeditions', '/expeditions/1/bon', '/sav', '/sav?nouveau=1', '/unites', '/unites/1', '/unites/6', '/pilotage/couts', '/projets/4', '/assistant'];
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

test('les en-têtes de sécurité sont envoyés', async () => {
  const res = await fetch(base + '/connexion');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('une clé API fausse est refusée, puis bloquée après trop d’essais', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await fetch(base + '/api/v1/ofs', { headers: { authorization: 'Bearer faux' } });
  assert.strictEqual(last.status, 429);
});
