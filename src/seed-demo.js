'use strict';
// Remplit une base VIDE avec les exemples des maquettes, pour essayer le logiciel.
// Usage : DB_FILE=data/demo.db npm run demo   (mot de passe patron : demo-atelier · codes iPad : Lucas 1111, Nina 2222)
const { q, tx, setSetting, setting } = require('./db');
const { hash } = require('./auth');
const { today, addDays } = require('./html');

if (q.get('SELECT id FROM projects LIMIT 1')) { console.error('La base contient déjà des projets : démo non chargée.'); process.exit(1); }
const t = today();
const d = (n) => addDays(t, n);

tx(() => {
  if (!setting('patron_password')) setSetting('patron_password', hash('demo-atelier'));
  setSetting('portal_test_emails', 'test@example.com');
  const pa = q.get("SELECT id FROM people WHERE role = 'patron'").id;
  q.run('UPDATE people SET pin_hash = ? WHERE id = ?', hash('0000'), pa);
  const lu = q.run("INSERT INTO people (name, ini, color, sub, pin_hash) VALUES ('Lucas', 'LU', '#3D5A73', 'ébéniste', ?)", hash('1111')).lastInsertRowid;
  const ni = q.run("INSERT INTO people (name, ini, color, sub, pin_hash) VALUES ('Nina', 'NI', '#7A4E00', 'menuisière', ?)", hash('2222')).lastInsertRowid;

  const roche = q.run("INSERT INTO clients (name, kind, email) VALUES ('M. et Mme Roche', 'Particulier', 'roche@example.com')").lastInsertRowid;
  const vasse = q.run("INSERT INTO clients (name, kind, email) VALUES ('Atelier Vasse', 'Architecte', 'vasse@example.com')").lastInsertRowid;

  const p1 = q.run(`INSERT INTO projects (name, kind, client_id, due_date, ready_date, lead_id, wood, notes, deposit_at, portal_state)
    VALUES ('Table à manger · chêne', 'Particulier', ?, ?, ?, ?, 'Chêne 27 mm, même lot pour tout le plateau.', 'Vernis mat incolore, 3 couches, égrenage grain 240. 3e étage sans ascenseur, escalier étroit : 2 personnes.', ?, 'none')`, roche, d(18), d(15), lu, d(-20)).lastInsertRowid;
  const p2 = q.run(`INSERT INTO projects (name, kind, client_id, due_date, lead_id, next_action, deposit_asked_at)
    VALUES ('Bibliothèque · noyer', 'Architecte', ?, ?, ?, 'Valider la V2 · acompte attendu', datetime('now', '-6 days'))`, vasse, d(26), pa).lastInsertRowid;
  const p3 = q.run("INSERT INTO projects (name, kind, due_date, lead_id, deposit_needed, next_action) VALUES ('Maggio', 'Atelier', ?, ?, 0, 'Importer les plans')", d(24), pa).lastInsertRowid;

  q.run("INSERT INTO plans (project_id, version, descr, status, validated_at, created_at) VALUES (?, 'V1', 'plateau 90 cm', 'archivee', NULL, datetime('now', '-22 days'))", p1);
  q.run("INSERT INTO plans (project_id, version, descr, status, validated_at) VALUES (?, 'V2', 'plateau élargi à 95 cm', 'validee', datetime('now', '-10 days'))", p1);
  q.run("INSERT INTO plans (project_id, version, descr) VALUES (?, 'V2', 'étagères 28 cm')", p2);
  q.run("INSERT OR REPLACE INTO phase_overrides (project_id, phase, state, label) VALUES (?, 'Bois', 'd', 'Réservé')", p3);
  q.run("INSERT OR REPLACE INTO phase_overrides (project_id, phase, state, label) VALUES (?, 'Bois', 'd', '3 plateaux')", p1);

  q.run("INSERT INTO pieces (project_id, name, descr, status, who_id) VALUES (?, 'Plateau 220 × 95 cm', '3 plateaux chêne 27 mm, joints collés · bords adoucis', 'Finition 2/3', ?)", p1, lu);
  q.run("INSERT INTO pieces (project_id, name, descr, status, who_id) VALUES (?, 'Piètement en compas', 'Chêne massif · tenons-mortaises', 'Finition 2/3', ?)", p1, lu);
  q.run("INSERT INTO pieces (project_id, name, descr, status, who_id) VALUES (?, '2 allonges 50 cm', 'Coulisses bois · réglage avec le plateau', 'Assemblées', ?)", p1, ni);

  const st = (pid, ord, title, piece, who, phase, geste, est, note, checks, status, declared) => q.run(
    `INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks, status, sent, seen, declared_hours, declared_label, started_at, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`, pid, ord, title, piece, who, phase, geste, est, note, JSON.stringify(checks.map((c) => ({ t: c, done: status === 'done' }))), status,
    status === 'todo' ? 0 : 1, declared, declared ? require('./html').hoursLabel(declared) : null,
    status !== 'todo' ? `${d(-12)} 08:00:00` : null, status === 'done' ? `${d(-5)} 17:00:00` : null);
  st(p1, 1, 'Débit et corroyage', 'Toutes pièces', ni, 'Débit', 'Débit, corroyage', 8, '', [], 'done', 8);
  st(p1, 2, 'Collage du plateau', 'Plateau', lu, 'Assemblage', 'Collage', 8, '', ['Serre-joints prêts'], 'done', 12);
  st(p1, 3, 'Piètement', 'Piètement', lu, 'Assemblage', 'Assemblage', 8, '', [], 'done', 16);
  st(p1, 4, 'Allonges', 'Allonges', ni, 'Assemblage', 'Assemblage', 4, '', [], 'done', 4);
  st(p1, 5, 'Retouche de la fente, ponçage 240', 'Plateau', lu, 'Finition', 'Ponçage', 4, 'Colle époxy teintée chêne, armoire finition, 2e étagère. Pas de vernis avant demain matin.', ['Ouvrir la fente et dépoussiérer', 'Couler la colle époxy teintée', 'Araser une fois sec', 'Poncer le plateau au grain 240', 'Photo du plateau terminé'], 'doing', null);
  st(p1, 6, 'Vernis, 3e couche', 'Toutes pièces', lu, 'Finition', 'Vernis', 4, 'Égrenage grain 240 avant la couche.', [], 'todo', null);
  st(p1, 7, 'Contrôle', 'Ensemble', pa, 'Contrôle', 'Contrôle', 1, '', ['Lumière rasante', 'Photos pour le client'], 'todo', null);
  st(p1, 8, 'Emballage couvertures', 'Ensemble', null, 'Livraison', 'Pose', 1, 'Coins protégés, plateau à plat.', ['Couvertures', 'Cornières'], 'todo', null);
  q.run("INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note, checks) VALUES (?, 1, 'Tri et débit du noyer', 'Caisson, étagères', ?, 'Débit', 'Débit, corroyage', 6, 'Garde les plus beaux fils pour les montants de façade.', ?)", p2, ni, JSON.stringify([{ t: 'Débit à +5 mm', done: false }, { t: 'Numéroter chaque pièce', done: false }]));
  q.run("INSERT INTO steps (project_id, ord, title, piece, who_id, phase, geste, est_hours, note) VALUES (?, 2, 'Queues d’aronde du caisson', 'Caisson', ?, 'Assemblage', 'Queues d''aronde', 8, 'Celles du haut restent visibles : à la main, bien serrées.')", p2, lu);
  st(p3, 1, 'Gabarits de perçage', 'Ensembles', ni, 'Conception', 'Autre', 3, 'Commence par la découpe, les plans arrivent demain matin.', ['Découper les panneaux', 'Tracer les axes'], 'todo', null);

  const ff = q.run("INSERT INTO suppliers (name, contact, email, habit, note) VALUES ('Fournisseur finition', '[nom]', 'finition@example.com', 'commande habituelle par mail · livré en 2 jours', 'Grouper avec les abrasifs pour le franco de port.')").lastInsertRowid;
  const sc = q.run("INSERT INTO suppliers (name, contact, phone, habit, note) VALUES ('Scierie', '[nom]', '0600000000', 'devis bois sur demande · délai 1 à 2 semaines', 'Demander des plateaux du même lot pour les pièces visibles.')").lastInsertRowid;
  q.run("INSERT INTO suppliers (name, contact, phone, note) VALUES ('Quincaillerie', '[comptoir]', '0600000001', 'Au comptoir, c’est plus rapide quand c’est urgent.')");
  q.run('UPDATE stock_items SET supplier_id = ? WHERE category = ?', ff, 'Droguerie');
  const vernis = q.get("SELECT id FROM stock_items WHERE name = 'Vernis mat'").id;
  q.run('UPDATE stock_items SET state = 2 WHERE id = ?', vernis);
  q.run("INSERT INTO needs (text, category, supplier_id, stock_item_id, person_id, source) VALUES ('Vernis mat incolore 5 L × 2', 'Droguerie', ?, ?, ?, 'stock')", ff, vernis, lu);
  q.run("INSERT INTO needs (text, category, supplier_id, project_id, person_id, source, acknowledged) VALUES ('Abrasif grain 320 × 1 boîte', 'Consommables', ?, ?, ?, 'note', 1)", ff, p1, pa);
  q.run("INSERT INTO needs (text, category, supplier_id, project_id, person_id, source, needs_deposit, acknowledged) VALUES ('Noyer 27 mm · 2 plateaux, ~2,40 × 0,32 m', 'Matériaux', ?, ?, ?, 'note', 1, 1)", sc, p2, pa);
  q.run('INSERT INTO orders (supplier_id, what, ordered_at, expected_at) VALUES (?, ?, ?, ?)', ff, 'Abrasifs grain 240, huile-cire × 4', d(-4), d(2));

  q.run("INSERT INTO bars (person_id, label, detail, kind, start_date, end_date) VALUES (?, 'Libre', 'à planifier', 'free', ?, ?)", ni, d(2), d(4));
  q.run("INSERT INTO bars (person_id, project_id, label, detail, kind, start_date, end_date) VALUES (?, ?, 'Bibliothèque Vasse', 'Bloqué : V2 non validée, acompte attendu', 'blocked', ?, ?)", ni, p2, d(7), d(11));
  q.run("INSERT INTO bars (person_id, project_id, label, detail, kind, start_date, end_date) VALUES (?, ?, 'Bibliothèque Vasse', 'RDV architecte 15 h', 'work', ?, ?)", pa, p2, d(0), d(0));
  q.run("INSERT INTO bars (lane, project_id, label, detail, kind, start_date, end_date) VALUES ('event', ?, 'Chantier Vasse', 'prise de cotes sur place', 'event', ?, ?)", p2, d(4), d(4));

  q.run(`INSERT INTO trips (project_id, date, what, place, access, contact, team, items) VALUES (?, ?, 'Livraison, montage des allonges, PV', '[Adresse du client]', '3e étage sans ascenseur, escalier étroit', 'M. Roche · [téléphone]', 'Lucas + toi · 4 h', ?)`,
    p1, d(18), JSON.stringify(['Couvertures', 'Sangles', 'Cornières', 'Visserie allonges', 'Chiffon + huile retouche', 'iPad chargé pour le PV'].map((x, i) => ({ t: x, done: i < 2 }))));
  q.run("INSERT INTO issues (project_id, person_id, body) VALUES (?, ?, 'Petite fente en bout de plateau · stabilisée à la colle époxy teintée ?')", p1, lu);
});
console.log('Démo chargée. Patron : demo-atelier · iPad : Lucas 1111, Nina 2222, patron 0000 · adresse de test du portail : test@example.com');
