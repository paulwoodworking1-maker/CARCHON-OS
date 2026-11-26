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
  '/fournisseurs', '/planning', '/planning?semaines=4', '/poses', '/poses/1/pv', '/pilotage', '/pilotage/export.csv', '/equipe', '/portails', '/portails?nouveau=1', '/recherche?q=chêne', '/automatisations', '/automatisations/resume', '/projets/1/nouvelles', '/entreprise', '/carnets/1/imprimer', '/poses/1/pv/imprimer', '/commandes/1/bon', '/catalogue', '/catalogue?m=1&qty=12', '/machines', '/machines?m=2', '/charge', '/charge?p=2&w=1', '/bois', '/pieces', '/expeditions', '/expeditions/1/bon', '/sav', '/sav?nouveau=1', '/unites', '/unites/1', '/unites/6', '/pilotage/couts', '/projets/4', '/assistant', '/decider', '/decider?tag=Achat', '/projets?f=retard', '/projets?vue=frise', '/projets?resp=1&canal=Boutique', '/projets?f=acompte', '/portails/envoyer', '/portails/reglages', '/portails/parcours?p=1', '/portails?f=espaces', '/portails?f=signes', '/portails/envoyer?depuis=1', '/planning/agenda'];
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
