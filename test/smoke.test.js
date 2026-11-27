'use strict';
// Test rapide : base neuve + démo, connexion patron, toutes les pages répondent sans erreur.
// Même fuseau que le serveur en production (render.yaml, install-vps.sh) : les heures de l'agenda en dépendent.
process.env.TZ = 'Europe/Paris';
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
  '/fournisseurs', '/planning', '/planning?semaines=4', '/poses', '/poses/1/pv', '/pilotage', '/pilotage/export.csv', '/equipe', '/portails', '/portails?nouveau=1', '/recherche?q=chêne', '/automatisations', '/automatisations/resume', '/projets/1/nouvelles', '/entreprise', '/carnets/1/imprimer', '/poses/1/pv/imprimer', '/commandes/1/bon', '/catalogue', '/catalogue?m=1&qty=12', '/machines', '/machines?m=2', '/charge', '/charge?p=2&w=1', '/bois', '/pieces', '/expeditions', '/expeditions/1/bon', '/sav', '/sav?nouveau=1', '/unites', '/unites/1', '/unites/6', '/pilotage/couts', '/projets/4', '/assistant', '/decider', '/decider?tag=Achat', '/projets?f=retard', '/projets?vue=frise', '/projets?resp=1&canal=Boutique', '/projets?f=acompte', '/portails/envoyer', '/portails/reglages', '/portails/parcours?p=1', '/portails?f=espaces', '/portails?f=signes', '/portails/envoyer?depuis=1', '/projets/1/sous-traitance/1/bon', '/projets/1/dossier/imprimer', '/projets/2/dossier/imprimer', '/projets/1?dictee=1', '/cnc', '/cnc/travaux/1', '/cnc/travaux/1/etiquettes', '/projets/2', '/planning/agenda', '/projets/1/chaine', '/projets/1/chaine/devis', '/projets/1/chaine/etiquettes', '/mail/nouveau', '/analyse', '/messages', '/analyse?periode=90', '/analyse?periode=0'];
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
  const res = await fetch(base + '/api/v1/affaires', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Buffet · noyer', client: { name: 'Client test', email: 'c@example.com' }, due_date: '2027-02-01', amount_ht: '8 400,00', family: 'Pièce signature', source: 'Site web' }) });
  assert.strictEqual(res.status, 201);
  const { ref } = await res.json();
  assert.match(ref, /^P\d{4}-\d{3}$/);
  const saved = require('../src/db').q.get('SELECT amount_ht, family, source FROM projects WHERE ref = ?', ref);
  assert.deepStrictEqual({ ...saved }, { amount_ht: 8400, family: 'Pièce signature', source: 'Site web' });
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

test('les en-têtes de sécurité sont envoyés', async () => {
  const res = await fetch(base + '/connexion');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
});

test('une clé API fausse est refusée, puis bloquée après trop d’essais', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await fetch(base + '/api/v1/ofs', { headers: { authorization: 'Bearer faux' } });
  assert.strictEqual(last.status, 429);
  // Le blocage vise l'adresse : on la libère pour les tests suivants.
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) require('../src/auth').forgive('api:' + ip);
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

test('analyse : chiffres de la démo, diagnostic classé, objectifs modifiables', async () => {
  const A = require('../src/analyse');
  const R = A.compute(365);
  assert.ok(R.profit.rate > 0 && R.profit.rate < 200, 'taux horaire réel calculé');
  assert.ok(R.ca.period > 0);
  assert.ok(R.sales.n > 0 && R.sales.funnel[0][1] >= R.sales.funnel[4][1]);
  assert.ok(R.estim.gap > 0, 'la démo dépasse le prévu');
  const order = { ko: 0, wa: 1, idea: 2, ok: 3 };
  R.findings.forEach((f, i) => { if (i) assert.ok(order[R.findings[i - 1].level] <= order[f.level]); assert.ok(f.title && f.action); });
  const res = await fetch(base + '/analyse/objectifs', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'obj_rate=90&obj_ca_month=60000' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(A.objectives().rate, 90);
  assert.strictEqual(A.objectives().ca_month, 60000);
  const page = await (await fetch(base + '/analyse', { headers: { cookie } })).text();
  assert.match(page, /objectif de 90 €/);
});

test('fiche projet : montant, matière, famille et origine enregistrés', async () => {
  const res = await fetch(base + '/projets/1/infos', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Table à manger · chêne', amount_ht: '7 200,50', material_ht: '1500', family: 'Pièce signature', source: 'Site web', lead_id: '' }).toString() });
  assert.strictEqual(res.status, 302);
  const p = require('../src/db').q.get('SELECT amount_ht, material_ht, family, source FROM projects WHERE id = 1');
  assert.deepStrictEqual({ ...p }, { amount_ht: 7200.5, material_ht: 1500, family: 'Pièce signature', source: 'Site web' });
});

test('Qonto : à l’acceptation du devis, facture d’acompte créée, envoyée, puis acompte reçu quand elle est payée', async () => {
  const http = require('node:http');
  const { q, setSetting } = require('../src/db');
  const { sha256 } = require('../src/auth');
  const calls = [];
  let status = 'unpaid';
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      calls.push({ m: req.method, u: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(o ? JSON.stringify(o) : ''); };
      if (req.url === '/v2/organization') return send(200, { organization: { legal_name: 'Carchon', bank_accounts: [{ iban: 'FR7616958000010000000000001', main: true }] } });
      if (req.url.startsWith('/v2/clients?')) return send(200, { clients: [] });
      if (req.url === '/v2/clients') return send(200, { client: { id: 'c-1' } });
      if (req.url.startsWith('/v2/quotes')) return send(200, { quotes: [{ id: 'q-1', number: 'D-QONTO-1' }], meta: { next_page: null } });
      if (req.url === '/v2/client_invoices') return send(201, { client_invoice: { id: 'inv-1', number: 'F-2026-001', invoice_url: 'https://pay.example/inv-1', status: 'unpaid' } });
      if (req.url === '/v2/client_invoices/inv-1/send') return send(204);
      if (req.url === '/v2/client_invoices/inv-1') return send(200, { client_invoice: { id: 'inv-1', number: 'F-2026-001', status, invoice_url: 'https://pay.example/inv-1' } });
      send(404, { errors: [{ code: 'not_found' }] });
    });
  });
  await new Promise((r) => fake.listen(0, r));
  Object.assign(process.env, { QONTO_BASE_URL: `http://127.0.0.1:${fake.address().port}`, QONTO_LOGIN: 'carchon-1', QONTO_SECRET_KEY: 'secret' });
  try {
    setSetting('portal_test_mode', '0');
    // Un devis réel, adresse vérifiée, montant 10 000 € HT.
    const t = 'jeton-qonto-test';
    const id = Number(q.run(`INSERT INTO quotes (number, version, pdf, pdf_sha256, signer_name, signer_email, project_name, valid_until, token_hash, status, test, amount_ht, email_verified_at)
      VALUES ('D-QONTO-1', 1, 'x.pdf', ?, 'Jeanne Martin', 'jeanne@example.com', 'Bibliothèque chêne', '2099-01-01', ?, 'sent', 0, 10000, datetime('now'))`, '', sha256(t)).lastInsertRowid);
    const fs = require('node:fs'); const { filePath } = require('../src/uploads');
    fs.writeFileSync(filePath('qonto-test.pdf'), 'pdf'); q.run('UPDATE quotes SET pdf = ?, pdf_sha256 = ? WHERE id = ?', 'qonto-test.pdf', sha256(Buffer.from('pdf')), id);
    // La page du devis montre le montant et l'acompte.
    const page = await (await fetch(`${base}/p/devis/${t}`)).text();
    assert.match(page, /Acompte 40/); assert.match(page, /TTC à la commande/);
    // Session client vérifiée : on passe par le code.
    const cRes = await fetch(`${base}/p/devis/${t}`); const ck = cRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    q.run("UPDATE quotes SET otp_hash = ?, otp_expires = datetime('now', '+10 minutes'), code_sent_at = datetime('now', '-5 minutes') WHERE id = ?", require('../src/auth').hash('123456'), id);
    const v = await fetch(`${base}/p/devis/${t}/verifier`, { method: 'POST', redirect: 'manual', headers: { cookie: ck, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=123456' });
    const ck2 = [ck, ...v.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
    // Sans adresse : refusé.
    const noAddr = await fetch(`${base}/p/devis/${t}/accepter`, { method: 'POST', redirect: 'manual', headers: { cookie: ck2, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Jeanne+Martin&consent=1' });
    assert.strictEqual(noAddr.status, 302);
    assert.strictEqual(q.get('SELECT status FROM quotes WHERE id = ?', id).status, 'sent');
    const ok = await fetch(`${base}/p/devis/${t}/accepter`, { method: 'POST', redirect: 'manual', headers: { cookie: ck2, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Jeanne Martin', consent: '1', b_street: '3 rue des Forges', b_zip: '21160', b_city: 'Couternon' }).toString() });
    assert.strictEqual(ok.status, 302);
    const pid = q.get('SELECT project_id FROM quotes WHERE id = ?', id).project_id;
    for (let i = 0; i < 50 && q.get('SELECT deposit_invoice_status s FROM projects WHERE id = ?', pid).s !== 'sent'; i++) await new Promise((r) => setTimeout(r, 20));
    const p = q.get('SELECT * FROM projects WHERE id = ?', pid);
    assert.strictEqual(p.deposit_invoice_status, 'sent');
    assert.strictEqual(p.deposit_invoice_number, 'F-2026-001');
    assert.strictEqual(p.deposit_invoice_ttc, 4800);
    const inv = calls.find((c) => c.m === 'POST' && c.u === '/v2/client_invoices');
    assert.strictEqual(inv.auth, 'carchon-1:secret');
    assert.strictEqual(inv.body.client_id, 'c-1');
    assert.strictEqual(inv.body.quote_id, 'q-1');
    assert.strictEqual(inv.body.payment_methods.iban, 'FR7616958000010000000000001');
    assert.deepStrictEqual(inv.body.items[0].unit_price, { value: '4000.00', currency: 'EUR' });
    assert.strictEqual(inv.body.items[0].vat_rate, '0.2');
    const cli = calls.find((c) => c.m === 'POST' && c.u === '/v2/clients').body;
    assert.deepStrictEqual([cli.kind, cli.first_name, cli.last_name, cli.billing_address.city], ['individual', 'Jeanne', 'Martin', 'Couternon']);
    const sent = calls.find((c) => c.u === '/v2/client_invoices/inv-1/send').body;
    assert.deepStrictEqual(sent.send_to, ['jeanne@example.com']);
    assert.match(sent.email_body, /4\s800,00 €|4 800,00 €/);
    // Pas de deuxième facture.
    assert.ok((await require('../src/qonto').createDeposit(pid)).already);
    // Espace client : facture visible.
    assert.match(await (await fetch(`${base}/p/devis/${t}`)).text(), /Voir la facture et payer/);
    // Payée dans Qonto -> acompte reçu.
    assert.strictEqual(await require('../src/qonto').syncPaid(), 0);
    status = 'paid';
    assert.strictEqual(await require('../src/qonto').syncPaid(), 1);
    assert.ok(q.get('SELECT deposit_at FROM projects WHERE id = ?', pid).deposit_at);
  } finally {
    for (const k of ['QONTO_BASE_URL', 'QONTO_LOGIN', 'QONTO_SECRET_KEY']) delete process.env[k];
    require('../src/db').setSetting('portal_test_mode', '1');
    fake.close();
  }
});

test('Qonto : un devis de test ne crée jamais de facture', async () => {
  process.env.QONTO_LOGIN = 'x'; process.env.QONTO_SECRET_KEY = 'y';
  try {
    const { q } = require('../src/db');
    const pid = Number(q.run("INSERT INTO projects (name) VALUES ('Test facture')").lastInsertRowid);
    q.run("INSERT INTO quotes (project_id, number, pdf, pdf_sha256, signer_name, signer_email, valid_until, token_hash, status, test, amount_ht) VALUES (?, 'T-1', 'x', 'x', 'A B', 'a@b.c', '2099-01-01', 'zz', 'accepted', 1, 1000)", pid);
    await assert.rejects(require('../src/qonto').createDeposit(pid), /test/);
  } finally { delete process.env.QONTO_LOGIN; delete process.env.QONTO_SECRET_KEY; }
});

const form = (o) => ({ method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('la fiche projet est rangée en onglets avec le dossier de production et la sous-traitance', async () => {
  const html = await (await fetch(base + '/projets/1', { headers: { cookie } })).text();
  for (const id of ['id="vue"', 'id="dossier"', 'id="04"', 'id="07"', 'id="08"', 'id="09"', 'id="echanges"', 'id="sous-traitance"', 'id="carnet"', 'id="debit"', 'Laquage des façades', 'Retour en retard']) assert.ok(html.includes(id), id);
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

test('Google Agenda : page de réglage, flux iCal privé et lecture d’un agenda', async () => {
  const pg = await (await fetch(base + '/planning/agenda', { headers: { cookie } })).text();
  const m = /\/agenda\/([\w-]+)\.ics/.exec(pg);
  assert.ok(m, 'adresse du flux affichée');
  const ics = await fetch(base + `/agenda/${m[1]}.ics`);
  assert.strictEqual(ics.status, 200);
  const txt = await ics.text();
  assert.match(txt, /^BEGIN:VCALENDAR/);
  assert.match(txt, /BEGIN:VEVENT/);
  assert.strictEqual((await fetch(base + '/agenda/faux.ics')).status, 404);
  const G = require('../src/gcal');
  const sample = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Métré chez M. Dupont', 'LOCATION:Lyon', 'DTSTART:20261203T090000Z', 'DTEND:20261203T100000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2', 'SUMMARY:Salon', 'DTSTART;VALUE=DATE:20261210', 'DTEND;VALUE=DATE:20261213', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a3', 'SUMMARY:Point hebdo', 'DTSTART;TZID=Europe/Paris:20261130T080000', 'DTEND;TZID=Europe/Paris:20261130T083000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;TZID=Europe/Paris:20261207T080000', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const ev = G.parseICS(sample, '2026-11-01', '2026-12-31');
  assert.deepStrictEqual(ev.map((e) => [e.title, e.start_date, e.end_date]), [
    ['Point hebdo', '2026-11-30', '2026-11-30'], ['Métré chez M. Dupont', '2026-12-03', '2026-12-03'], ['Salon', '2026-12-10', '2026-12-12'], ['Point hebdo', '2026-12-14', '2026-12-14']]);
  assert.strictEqual(ev[1].time, '10:00');
});

test('Google Agenda : écriture directe (Google simulé) : création, mise à jour, suppression', async () => {
  const crypto = require('node:crypto');
  const { setSetting, q } = require('../src/db');
  const G = require('../src/gcal');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  setSetting('gcal_sa', JSON.stringify({ type: 'service_account', client_email: 'carchon@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  setSetting('gcal_push_cal', 'atelier@group.calendar.google.com');
  const store = new Map(); const calls = [];
  const real = global.fetch;
  global.fetch = async (url, o = {}) => {
    url = String(url);
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      const [h, c, s] = new URLSearchParams(o.body).get('assertion').split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')), 'jeton signé avec la clé');
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/atelier%40group.calendar.google.com/events')) {
      const id = url.split('/events/')[1]; calls.push(o.method);
      if (o.method === 'PUT') { if (!store.has(id)) return new Response('{}', { status: 404 }); store.set(id, JSON.parse(o.body)); return new Response(o.body, { status: 200 }); }
      if (o.method === 'POST') { const b = JSON.parse(o.body); store.set(b.id, b); return new Response(o.body, { status: 200 }); }
      if (o.method === 'DELETE') { store.delete(id); return new Response(null, { status: 204 }); }
    }
    return real(url, o);
  };
  try {
    const want = G.items('2000-01-01').filter((e) => e.end >= require('../src/html').addDays(require('../src/html').today(), -30));
    let x = await G.push();
    assert.ok(!x.error, x.error);
    assert.strictEqual(store.size, want.length);
    assert.ok(want.length > 0);
    // Rien de changé : aucun appel.
    calls.length = 0; await G.push(); assert.strictEqual(calls.length, 0);
    // Une barre modifiée : une mise à jour ; une barre supprimée : une suppression.
    const bars = q.all("SELECT id FROM bars WHERE end_date >= date('now') LIMIT 2");
    q.run("UPDATE bars SET label = 'Nouveau titre' WHERE id = ?", bars[0].id);
    q.run('DELETE FROM bars WHERE id = ?', bars[1].id);
    calls.length = 0; x = await G.push();
    assert.deepStrictEqual(calls.sort(), ['DELETE', 'PUT']);
    assert.match(store.get(G.evId(`bar-${bars[0].id}`)).summary, /Nouveau titre/);
    assert.ok(!store.has(G.evId(`bar-${bars[1].id}`)));
  } finally { global.fetch = real; setSetting('gcal_push_cal', ''); }
});

test('chaîne de production : l’assistant (simulé) crée pièces, fiches et matière, le planning attend la matière', async () => {
  const { q, setting } = require('../src/db');
  const C = require('../src/chain');
  const A = require('../src/automations');
  const fs = require('node:fs');
  const { filePath } = require('../src/uploads');
  const pid = Number(q.run("INSERT INTO projects (name, kind, due_date) VALUES ('Bibliothèque test chaîne', 'Particulier', date('now', '+60 days'))").lastInsertRowid);
  fs.writeFileSync(filePath('vue-test.csv'), 'Pièce;Long;Larg;Ep;Qté\nMontant;2400;300;27;4\n');
  q.run("INSERT INTO documents (project_id, title, file, visible_client, kind) VALUES (?, 'debit.csv', 'vue-test.csv', 0, 'chiffrage')", pid);
  const sup = Number(q.run("INSERT INTO suppliers (name, lead_days) VALUES ('Scierie Test', 8)").lastInsertRowid);
  const lucas = q.get("SELECT * FROM people WHERE name = 'Lucas'");
  let seen = null;
  const fakeAI = { enabled: () => true, productionChain: async (args) => { seen = args; return {
    pieces: [{ nom: 'Caisson', description: '240 × 300' }, { nom: 'Étagères', description: '6 tablettes' }],
    matiere: [{ categorie: 'Bois massif', designation: 'Chêne', essence: 'Frêne rare', epaisseur: '27 mm', quantite: 0.4, unite: 'm³', fournisseur: 'Scierie Test', avant_fabrication: true },
      { categorie: 'Finition', designation: 'Vernis mat', essence: '', epaisseur: '', quantite: 2, unite: 'L', fournisseur: '', avant_fabrication: false }],
    fiches: [{ titre: 'Plans de détail', pieces: 'Tout', qui: 'Lucas', etape_frise: 'Conception', geste: 'Autre', heures: 3, mot_du_patron: '', reperes: [] },
      { titre: 'Débit du chêne', pieces: 'Caisson', qui: 'Lucas', etape_frise: 'Débit', geste: 'Débit, corroyage', heures: 6, mot_du_patron: 'Garder les beaux fils', reperes: ['Débit à +5 mm'] },
      { titre: 'Assemblage', pieces: 'Caisson', qui: 'Inconnu', etape_frise: 'Assemblage', geste: 'Assemblage', heures: 8, mot_du_patron: '', reperes: [] }],
    analyse: 'Caisson assemblé en queues d’aronde.', debit: [{ ensemble: 'Caisson', piece: 'Montant', quantite: 2, materiau: 'Chêne', longueur_mm: 2400, largeur_mm: 300, epaisseur_mm: 22, brut_longueur_mm: 2450, brut_largeur_mm: 315, brut_epaisseur_mm: 27, sens_du_fil: 'en long', note: '' }],
    remarques: 'Vérifier la hauteur sous plafond.' }; } };
  await C.run(pid, { ai: fakeAI });
  assert.ok(seen.files.some((b) => b.type === 'text' && /Montant;2400/.test(b.text)), 'la nomenclature CSV est transmise');
  const p = q.get('SELECT * FROM projects WHERE id = ?', pid);
  assert.strictEqual(p.prod_status, 'pret');
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM steps WHERE project_id = ? AND ai_generated = 1 AND sent = 0', pid).n, 2, 'pas de fiche de conception : elle est faite avant le chiffrage');
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM cut_list WHERE project_id = ?', pid).n, 1);
  assert.match(q.get("SELECT note FROM steps WHERE project_id = ? AND title = 'Débit du chêne'", pid).note, /fiche de débit/);
  assert.ok(q.get("SELECT who_id FROM steps WHERE project_id = ? AND title = 'Assemblage'", pid).who_id, 'quelqu’un est désigné même si le prénom est inconnu');
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM pieces WHERE project_id = ?', pid).n, 2);
  const needs = q.all('SELECT * FROM needs WHERE project_id = ?', pid);
  assert.strictEqual(needs.length, 2);
  assert.strictEqual(needs.find((n) => n.for_chain).supplier_id, sup);
  // Matière : délai fournisseur 8 jours ouvrés + 1 jour de réception.
  const m = C.material(pid);
  assert.strictEqual(m.date, C.addWorkdays(C.addWorkdays(require('../src/html').today(), 8), 1));
  // Planning : la conception peut démarrer, le débit attend la matière.
  const { days } = A.allocate(lucas, { ready: A.readyDates() });
  const dayOf = (title) => Object.keys(days).sort().find((d) => days[d].some((x) => x.step.project_id === pid && x.step.title === title));
  assert.ok(dayOf('Débit du chêne') >= m.date, `débit le ${dayOf('Débit du chêne')} après la matière ${m.date}`);
  // Commande passée avec une date : le planning suit la date de livraison.
  const o = Number(q.run("INSERT INTO orders (supplier_id, what, expected_at) VALUES (?, 'Chêne', date('now', '+20 days'))", sup).lastInsertRowid);
  q.run("UPDATE needs SET order_id = ?, status = 'ordered' WHERE project_id = ? AND for_chain = 1", o, pid);
  assert.ok(C.material(pid).date > q.get("SELECT date('now', '+20 days') d").d);
  q.run("UPDATE needs SET status = 'arrived' WHERE project_id = ?", pid);
  assert.strictEqual(C.material(pid).date, null);
  // La page de l'OF montre la chaîne, À décider propose de vérifier le carnet.
  const page = await (await fetch(`${base}/projets/${pid}`, { headers: { cookie } })).text();
  assert.match(page, /Chaîne de production/);
  assert.match(page, /Vérifier la hauteur sous plafond/);
  assert.ok(require('../src/logic').toDecide().some((d) => d.tag === 'Chaîne' && d.href === `/carnets/${pid}`));
  void setting;
});

test('facture d’acompte envoyée par Cockpit : publiée sur le portail', async () => {
  const { q, setSetting } = require('../src/db');
  setSetting('api_token', 'cle-test-cockpit');
  const p = q.get('SELECT * FROM projects WHERE client_id IS NOT NULL LIMIT 1');
  const form = new FormData();
  form.append('type', 'acompte'); form.append('numero', 'FA-2026-007'); form.append('montant_ttc', '1 800,00 €');
  form.append('pdf', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'facture.pdf');
  const res = await fetch(`${base}/api/v1/affaires/${p.ref}/factures`, { method: 'POST', headers: { authorization: 'Bearer cle-test-cockpit' }, body: form });
  assert.strictEqual(res.status, 201);
  const d = q.get("SELECT * FROM documents WHERE project_id = ? AND kind = 'facture_acompte'", p.id);
  assert.ok(d && d.visible_client === 1 && d.number === 'FA-2026-007');
  const j = await fetch(`${base}/api/v1/affaires/${p.ref}/factures`, { method: 'POST', headers: { authorization: 'Bearer cle-test-cockpit', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'solde', pdf_base64: Buffer.from('%PDF-1.4 solde').toString('base64') }) });
  assert.strictEqual(j.status, 201);
  assert.strictEqual((await fetch(`${base}/api/v1/affaires/${p.ref}/factures`, { method: 'POST', headers: { authorization: 'Bearer mauvaise' } })).status, 401);
});

test('Cockpit est prévenu (signé) quand un devis est accepté', async () => {
  const http = require('node:http');
  const crypto = require('node:crypto');
  const { setSetting, setting } = require('../src/db');
  let got = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got = { body: b, sig: req.headers['x-carchon-signature'], ev: req.headers['x-carchon-event'] }; res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, r));
  setSetting('cockpit_webhook_url', `http://127.0.0.1:${srv.address().port}/hook`);
  const out = await require('../src/cockpit').send('devis.accepte', { of: { ref: 'P-TEST' } });
  srv.close();
  assert.ok(out.ok);
  assert.strictEqual(got.ev, 'devis.accepte');
  assert.strictEqual(got.sig, 'sha256=' + crypto.createHmac('sha256', setting('api_token')).update(got.body).digest('hex'));
  setSetting('cockpit_webhook_url', '');
});

test('modèle 3D STEP : pièces mesurées, regroupées et prêtes pour la visionneuse', async () => {
  const fs = require('node:fs');
  const { filePath } = require('../src/uploads');
  const M = require('../src/model3d');
  const src = require.resolve('occt-import-js/package.json').replace('package.json', 'test/testfiles/cax-if/as1-tu-203.stp');
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, filePath('assemblage-test.stp'));
  const a = await M.analyze(filePath('assemblage-test.stp'));
  assert.strictEqual(a.parts, 18);
  const plate = a.list.find((g) => g.name === 'plate');
  assert.deepStrictEqual(plate.dims.map(Math.round), [180, 150, 20]);
  assert.ok(a.list.find((g) => g.name === 'bolt').qty >= 2, 'pièces identiques regroupées');
  assert.ok(fs.existsSync(filePath('assemblage-test.stp') + '.view.json'));
  assert.match(M.asText('assemblage.stp', a), /plate · qté 1 · 180 × 150 × 20 mm/);
  // Pièce tournée : la boîte orientée retrouve les vraies cotes.
  const c = Math.cos(0.5), s = Math.sin(0.5), pts = [];
  for (const x of [0, 2400]) for (const y of [0, 300]) for (const z of [0, 27]) pts.push(x * c - y * s, x * s + y * c, z);
  assert.deepStrictEqual(M.obb(pts).size.map(Math.round).sort((x, y) => y - x), [2400, 300, 27]);
});

test('forfait Claude : dossier .zip à déposer dans claude.ai, réponse recollée → production créée', async () => {
  const { q } = require('../src/db');
  const C = require('../src/chain');
  const pid = Number(q.run("INSERT INTO projects (name, kind) VALUES ('Console forfait', 'Particulier')").lastInsertRowid);
  const res = await fetch(`${base}/projets/${pid}/claude`, { headers: { cookie } });
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Télécharger le dossier/);
  const z = await fetch(`${base}/projets/${pid}/claude/dossier.zip`, { headers: { cookie } });
  assert.strictEqual(z.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await z.arrayBuffer());
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
  assert.match(buf.toString('utf8'), /00_INSTRUCTIONS\.md[\s\S]*Format de ta réponse/);
  const answer = { analyse: 'Console en chêne.', pieces: [{ nom: 'Plateau', description: '1200 × 400' }],
    debit: [{ ensemble: 'Console', piece: 'Plateau', quantite: 1, materiau: 'Chêne', longueur_mm: 1200, largeur_mm: 400, epaisseur_mm: 30, brut_longueur_mm: 1250, brut_largeur_mm: 420, brut_epaisseur_mm: 34, sens_du_fil: 'en long', note: '' }],
    matiere: [{ categorie: 'Bois massif', designation: 'Chêne 34 mm (chute 30 %)', essence: 'Chêne rare', epaisseur: '34 mm', quantite: 0.03, unite: 'm³', fournisseur: '', avant_fabrication: true }],
    fiches: [{ titre: 'Débit du plateau', pieces: 'Plateau', qui: '', etape_frise: 'Débit', geste: 'Débit, corroyage', machine: 'Dégauchisseuse', heures: 3, mot_du_patron: '', reperes: [] }],
    remarques: '' };
  // Réponse telle que copiée depuis claude.ai : texte autour + bloc de code.
  const pasted = 'Voici la production :\n```json\n' + JSON.stringify(answer, null, 2) + '\n```\nBonne fabrication.';
  const r = await post(`/projets/${pid}/claude/import`, { answer: pasted });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(q.get('SELECT prod_status FROM projects WHERE id = ?', pid).prod_status, 'pret');
  assert.strictEqual(q.get('SELECT COUNT(*) n FROM cut_list WHERE project_id = ?', pid).n, 1);
  assert.match(q.get('SELECT note FROM steps WHERE project_id = ?', pid).note, /Dégauchisseuse/);
  assert.throws(() => C.importAnswer(pid, 'pas de json ici'), /JSON/);
  assert.throws(() => C.importAnswer(pid, '{"analyse": "x"}'), /format attendu/);
});

test('messages aux clients : texte modifié, encadré masqué si vidé, texte d’origine remis', async () => {
  const M = require('../src/messages');
  const post = (body) => fetch(base + '/messages', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  assert.strictEqual(M.t('next_preparation_titre'), '');
  assert.strictEqual(M.fill('Régler[ : {montant} TTC]', { montant: '' }), 'Régler');
  assert.strictEqual(M.fill('Régler[ : {montant} TTC]', { montant: '10 €' }), 'Régler : 10 € TTC');
  assert.strictEqual((await post({ m_portail_question: 'Appelez Paul.' })).status, 302);
  assert.strictEqual(M.t('portail_question'), 'Appelez Paul.');
  await post({ reset: 'portail_question' });
  assert.match(M.t('portail_question'), /dernier e-mail/);
  // SMS : même réglage que Portails › Réglages.
  await post({ m_sms_acompte: 'Acompte reçu, merci ! {lien}' });
  assert.strictEqual(require('../src/sms').template('acompte'), 'Acompte reçu, merci ! {lien}');
  const E = require('../src/emails').quote({ name: 'Jeanne', number: 'D-1', project: '', url: 'https://x', until: '2026-12-24' });
  assert.match(E.subject, /^Votre devis n° D-1 · /);
  assert.doesNotMatch(E.body, /\{|\[/);
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

test('portail : « Bonjour / Bonsoir Mme Nom Prénom », référence en tête, e-mail en pied', async () => {
  const C = require('../src/civilite');
  assert.deepStrictEqual(C.split('STEPHANIE SCHIFANO'), { first: 'Stéphanie', last: 'Schifano' });
  assert.deepStrictEqual(C.split('Schifano Stéphanie'), { first: 'Stéphanie', last: 'Schifano' });
  assert.strictEqual(C.identity({ name: 'STEPHANIE SCHIFANO' }).formal, 'Mme Schifano Stéphanie');
  assert.strictEqual(C.identity({ name: 'Pierre de la Tour' }).formal, 'M. de la Tour Pierre');
  assert.strictEqual(C.identity({ name: 'Camille Durand' }).formal, 'Durand Camille');
  assert.strictEqual(C.identity({ name: 'Camille Durand', civility: 'Mme' }).formal, 'Mme Durand Camille');
  assert.strictEqual(C.salutation(new Date('2026-11-27T09:00:00Z')), 'Bonjour');
  assert.strictEqual(C.salutation(new Date('2026-11-27T18:30:00Z')), 'Bonsoir');
  assert.strictEqual(C.emailHello(null, 'STEPHANIE SCHIFANO'), 'Bonjour Madame Schifano,');
  const { q } = require('../src/db'); const { sha256 } = require('../src/auth');
  const cid = Number(q.run("INSERT INTO clients (name, email) VALUES ('STEPHANIE SCHIFANO', 's@example.com')").lastInsertRowid);
  const pid = Number(q.run("INSERT INTO projects (name, client_id, portal_state, portal_token_hash) VALUES ('STEPHANIE SCHIFANO', ?, 'open', ?)", cid, sha256('espace-schifano')).lastInsertRowid);
  const html = await (await fetch(`${base}/p/espace/espace-schifano`)).text();
  const ref = q.get('SELECT ref FROM projects WHERE id = ?', pid).ref;
  assert.match(html, new RegExp(`class="cl-ref">Dossier ${ref}<`));
  assert.match(html, /<h1>Bon(jour|soir) Mme Schifano Stéphanie<\/h1>/);
  assert.doesNotMatch(html, /class="cl-meta">STEPHANIE/);
  assert.match(html, /contact@carchon\.com/);
});

test('portail : nom sans accent ou en majuscules reconnu, feuille de style versionnée', async () => {
  const C = require('../src/civilite');
  assert.strictEqual(C.identity({ name: 'Stephanie Schifano' }).formal, 'Mme Schifano Stéphanie');
  assert.ok(C.same('STEPHANIE SCHIFANO', 'Stephanie Schifano'));
  const { q } = require('../src/db'); const { sha256 } = require('../src/auth');
  const cid = Number(q.run("INSERT INTO clients (name) VALUES ('Stephanie Schifano')").lastInsertRowid);
  q.run("INSERT INTO projects (name, client_id, portal_state, portal_token_hash) VALUES ('STEPHANIE SCHIFANO', ?, 'open', ?)", cid, sha256('espace-schifano-2'));
  const html = await (await fetch(`${base}/p/espace/espace-schifano-2`)).text();
  assert.match(html, /Mme Schifano Stéphanie<\/h1>/);
  assert.doesNotMatch(html, /cl-meta/);
  assert.match(html, /\/static\/style\.css\?v=\w+/);
});

test('portails : « Copier le lien » redonne le lien existant sans en créer un nouveau', async () => {
  const { q } = require('../src/db'); const { sha256 } = require('../src/auth'); const SMS = require('../src/sms');
  const cid = Number(q.run("INSERT INTO clients (name, email) VALUES ('Lien Existant', 'l@example.com')").lastInsertRowid);
  const pid = Number(q.run("INSERT INTO projects (name, client_id, portal_state, portal_token_hash, portal_token_enc) VALUES ('Projet lien', ?, 'open', ?, ?)", cid, sha256('jeton-garde'), SMS.seal('jeton-garde')).lastInsertRowid);
  const list = await (await fetch(base + '/portails?f=espaces', { headers: { cookie } })).text();
  assert.match(list, new RegExp(`id="lk-p${pid}" value="[^"]*/p/espace/jeton-garde"`));
  const r = await fetch(base + `/portails/espace/${pid}/lien`, { redirect: 'manual', headers: { cookie } });
  assert.strictEqual(r.status, 302);
  assert.strictEqual(q.get('SELECT portal_token_hash h FROM projects WHERE id = ?', pid).h, sha256('jeton-garde'));
  const page = await (await fetch(base + '/projets/' + pid, { headers: { cookie } })).text();
  assert.match(page, /\/p\/espace\/jeton-garde/);
});

test('achats du projet : rangés par catégorie, prix le plus bas des catalogues fournisseurs', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { q } = require('../src/db'); const P = require('../src/prix');
  const a = Number(q.run("INSERT INTO suppliers (name) VALUES ('Quinca A')").lastInsertRowid);
  const b = Number(q.run("INSERT INTO suppliers (name) VALUES ('Quinca B')").lastInsertRowid);
  const fa = path.join(os.tmpdir(), 'cat-a.csv'), fb = path.join(os.tmpdir(), 'cat-b.csv');
  fs.writeFileSync(fa, 'Référence;Désignation;Prix HT;Unité\nCH-35;Charnière invisible 35 mm;4,20;pce\nVS-4;Vis SPAX 4x40 boîte 200;12,90;boîte\n');
  fs.writeFileSync(fb, 'Code,Libellé,Tarif\nBX35,Charnière invisible 35 mm clip,"3,80"\n');
  assert.strictEqual(await P.importCatalog(a, fa, 'cat-a.csv'), 2);
  assert.strictEqual(await P.importCatalog(b, fb, 'cat-b.csv'), 1);
  const pid = Number(q.run("INSERT INTO projects (name) VALUES ('Achats test')").lastInsertRowid);
  q.run("INSERT INTO needs (text, project_id, qty, source) VALUES ('Charnière invisible 35 mm', ?, 10, 'note'), ('Vernis mat 5 L', ?, 1, 'note')", pid, pid);
  const g = P.projectNeeds(pid);
  const quinca = g.find((x) => x.cat === 'Quincaillerie');
  assert.strictEqual(quinca.items[0].best.sname, 'Quinca B');
  assert.strictEqual(quinca.items[0].best.price, 3.8);
  assert.strictEqual(Math.round(quinca.items[0].total * 100), 3800);
  assert.ok(g.find((x) => x.cat === 'Droguerie'));
  const page = await (await fetch(base + '/projets/' + pid, { headers: { cookie } })).text();
  assert.match(page, /BX35/);
  await fetch(base + `/projets/${pid}/achats/meilleurs`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.strictEqual(q.get("SELECT supplier_id s FROM needs WHERE project_id = ? AND text LIKE 'Charni%'", pid).s, b);
});

test('carnet : geste, étape, temps et plan réglés tout seuls d’après les mots de la fiche', async () => {
  const { q } = require('../src/db');
  const pid = Number(q.run("INSERT INTO projects (name) VALUES ('Carnet auto')").lastInsertRowid);
  q.run("INSERT INTO plans (project_id, version, status) VALUES (?, 'V3', 'validee')", pid);
  const sid = Number(q.run("INSERT INTO steps (project_id, ord, title) VALUES (?, 1, 'x')", pid).lastInsertRowid);
  const r = await fetch(`${base}/carnets/${pid}/fiches/${sid}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ title: 'Ponçage des façades au grain 240', piece: 'Façades', checks: 'Grain 120\nGrain 240' }).toString() });
  assert.strictEqual(r.status, 302);
  const s = q.get('SELECT * FROM steps WHERE id = ?', sid);
  assert.strictEqual(s.geste, 'Ponçage');
  assert.strictEqual(s.phase, 'Finition');
  assert.ok(s.plan_id);
  assert.strictEqual(JSON.parse(s.checks).length, 2);
});

test('suivi client automatique : relances devis J+7/J+21, rappel de facture, avis après la pose, rien sur l’historique', async () => {
  const { q, setSetting } = require('../src/db'); const mail = require('../src/mail'); const SMS = require('../src/sms'); const SC = require('../src/suivi-client');
  const sent = []; const realSend = mail.send, realConf = mail.configured;
  mail.send = async (m) => { sent.push(m); return {}; }; mail.configured = () => true;
  process.env.PUBLIC_URL = 'https://os.example.fr';
  try {
    setSetting('client_auto_since', '2000-01-01 00:00:00');
    const old = Number(q.run("INSERT INTO quotes (number, pdf, pdf_sha256, signer_name, signer_email, valid_until, token_hash, status, test, link_at, token_enc) VALUES ('D-OLD', 'x', 'x', 'A B', 'old@example.com', date('now', '+20 days'), 'h-old', 'sent', 0, datetime('now', '-8 days'), ?)", SMS.seal('tok-old')).lastInsertRowid);
    setSetting('client_auto_since', new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19).replace('T', ' '));
    q.run("UPDATE quotes SET link_at = datetime('now', '-40 days') WHERE id = ?", old); // avant la mise en route : ignoré
    const qid = Number(q.run("INSERT INTO quotes (number, pdf, pdf_sha256, signer_name, signer_email, project_name, valid_until, token_hash, status, test, link_at, token_enc) VALUES ('D-REL', 'x', 'x', 'STEPHANIE SCHIFANO', 's@example.com', 'Bibliothèque', date('now', '+20 days'), 'h-rel', 'sent', 0, datetime('now', '-8 days'), ?)", SMS.seal('tok-rel')).lastInsertRowid);
    await SC.relancesDevis();
    const toS = () => sent.filter((m) => m.to === 's@example.com');
    assert.strictEqual(toS().length, 1);
    assert.ok(!sent.some((m) => m.to === 'old@example.com'), 'rien sur l’historique');
    assert.match(toS()[0].text, /Bonjour Madame Schifano/);
    assert.match(toS()[0].text, /https:\/\/os\.example\.fr\/p\/devis\/tok-rel/);
    await SC.relancesDevis();
    assert.strictEqual(toS().length, 1); // pas deux fois
    q.run("UPDATE quotes SET link_at = datetime('now', '-22 days') WHERE id = ?", qid);
    await SC.relancesDevis();
    assert.strictEqual(toS().length, 2);
    // Facture d'acompte échue, impayée.
    const cid = Number(q.run("INSERT INTO clients (name, email) VALUES ('Jean Facture', 'jf@example.com')").lastInsertRowid);
    const pid = Number(q.run("INSERT INTO projects (name, client_id, deposit_needed, deposit_invoice_id, deposit_invoice_number, deposit_invoice_url, deposit_invoice_ttc, deposit_invoice_due, deposit_invoice_sent_at) VALUES ('Projet facture', ?, 1, 'inv', 'F-1', 'https://pay.example/1', 1200, date('now', '-1 day'), datetime('now', '-8 days'))", cid).lastInsertRowid);
    assert.strictEqual(await SC.relancesFactures(), 1);
    assert.match(sent[sent.length - 1].text, /https:\/\/pay\.example\/1/);
    assert.strictEqual(await SC.relancesFactures(), 0);
    // Avis trois jours après un PV sans réserve.
    setSetting('google_review_url', 'https://g.page/r/test/review');
    q.run("INSERT INTO trips (project_id, date, items, done_at, pv_signed_at, pv_name, pv_reserves) VALUES (?, date('now', '-4 days'), '[]', datetime('now', '-4 days'), datetime('now', '-4 days'), 'Jean', '')", pid);
    await SC.apresPose();
    const toJ = () => sent.filter((m) => m.to === 'jf@example.com' && /Merci/.test(m.subject));
    assert.strictEqual(toJ().length, 1);
    assert.match(toJ()[0].text, /g\.page\/r\/test\/review/);
    await SC.apresPose();
    assert.strictEqual(toJ().length, 1);
  } finally { mail.send = realSend; mail.configured = realConf; delete process.env.PUBLIC_URL; }
});

test('facture de solde Qonto à la signature du PV, payée : Règlement coché', async () => {
  const http = require('node:http'); const { q } = require('../src/db');
  const calls = []; let status = 'unpaid';
  const fake = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    calls.push({ m: req.method, u: req.url, body: b ? JSON.parse(b) : null });
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(o ? JSON.stringify(o) : ''); };
    if (req.url === '/v2/organization') return send(200, { organization: { bank_accounts: [{ iban: 'FR76X', main: true }] } });
    if (req.url.startsWith('/v2/clients?')) return send(200, { clients: [{ id: 'c-9', currency: 'EUR', locale: 'fr', billing_address: { city: 'Dijon' } }] });
    if (req.url === '/v2/client_invoices') return send(201, { client_invoice: { id: 'sol-1', number: 'F-2026-090', invoice_url: 'https://pay.example/sol' } });
    if (req.url === '/v2/client_invoices/sol-1/send') return send(204);
    if (req.url === '/v2/client_invoices/sol-1') return send(200, { client_invoice: { id: 'sol-1', number: 'F-2026-090', status } });
    send(404, { errors: [] }); }); });
  await new Promise((r) => fake.listen(0, r));
  Object.assign(process.env, { QONTO_BASE_URL: `http://127.0.0.1:${fake.address().port}`, QONTO_LOGIN: 'l', QONTO_SECRET_KEY: 's' });
  try {
    const pid = Number(q.run("INSERT INTO projects (name, amount_ht, deposit_at, deposit_invoice_ttc, deposit_invoice_number) VALUES ('Solde test', 10000, date('now'), 4800, 'F-ACO')").lastInsertRowid);
    q.run("INSERT INTO quotes (project_id, number, pdf, pdf_sha256, signer_name, signer_email, valid_until, token_hash, status, test, amount_ht, billing_json) VALUES (?, 'D-SOL', 'x', 'x', 'Jean Solde', 'js@example.com', '2099-01-01', 'h-sol', 'accepted', 0, 10000, ?)", pid, JSON.stringify({ street: '1 rue', zip: '21000', city: 'Dijon' }));
    q.run("INSERT INTO trips (project_id, date, items, done_at, pv_signed_at, pv_name) VALUES (?, date('now'), '[]', datetime('now'), datetime('now'), 'Jean')", pid);
    const o = await require('../src/qonto').createBalance(pid);
    assert.strictEqual(o.number, 'F-2026-090');
    const inv = calls.find((c) => c.m === 'POST' && c.u === '/v2/client_invoices').body;
    assert.strictEqual(inv.items[0].unit_price.value, '6000.00'); // 10 000 − 4 000 HT d'acompte
    assert.strictEqual(q.get('SELECT balance_invoice_ttc t FROM projects WHERE id = ?', pid).t, 7200);
    status = 'paid';
    await require('../src/qonto').syncPaid();
    assert.ok(q.get('SELECT balance_paid_at b FROM trips WHERE project_id = ?', pid).b);
    const fr = require('../src/logic').clientSteps(q.get('SELECT * FROM projects WHERE id = ?', pid));
    assert.strictEqual(fr[7].state, 'd');
  } finally { for (const k of ['QONTO_BASE_URL', 'QONTO_LOGIN', 'QONTO_SECRET_KEY']) delete process.env[k]; fake.close(); }
});
