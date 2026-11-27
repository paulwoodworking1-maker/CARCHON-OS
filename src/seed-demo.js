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
  const lu = q.run("INSERT INTO people (name, ini, color, sub, pin_hash) VALUES ('Lucas', 'LU', '#4A443E', 'ébéniste', ?)", hash('1111')).lastInsertRowid;
  const ni = q.run("INSERT INTO people (name, ini, color, sub, pin_hash) VALUES ('Nina', 'NI', '#6B635A', 'menuisière', ?)", hash('2222')).lastInsertRowid;

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
  const lq = q.run("INSERT INTO suppliers (name, contact, email, habit, subcontractor) VALUES ('Laquage', '[nom]', 'laquage@example.com', 'laquage et vernis industriel · délai 8 à 10 jours', 1)").lastInsertRowid;
  q.run("INSERT INTO subcontracts (project_id, supplier_id, what, pieces, qty, spec, price, status, ordered_at, sent_at, due_at) VALUES (?, ?, 'Laquage des façades', '4 façades de tiroir', '4 pièces', 'Blanc mat, 2 faces, chants compris', 280, 'envoye', date('now', '-9 days'), date('now', '-6 days'), date('now', '-1 days'))", p1, lq);
  q.run("INSERT INTO carnet_runs (project_id, plans, dictation, questions, debit, n) VALUES (?, 'V2', 'Plateau en noyer, Nina débite. Façades au laquage.', '[\"Épaisseur du plateau non cotée\"]', '[{\"piece\":\"Plateau\",\"quantite\":\"1\",\"longueur\":\"1800\",\"largeur\":\"950\",\"epaisseur\":\"\",\"matiere\":\"Noyer\",\"remarque\":\"\"}]', 6)", p1);
  q.run("INSERT INTO cnc_jobs (project_id, name, material, thickness, parts, source) VALUES (?, 'Mélaminé 19 mm', 'Mélaminé', 19, ?, 'démo')", p2, JSON.stringify([
    { name: 'Joue', l: 2100, w: 560, qty: 2, grain: false, ops_text: 'trou x=37 y=37 d=5 p=13\ntrou x=37 y=69 d=5 p=13\nrainure x1=0 y1=10 x2=2100 y2=10 l=8 p=8' },
    { name: 'Tablette', l: 762, w: 540, qty: 5, grain: false, ops_text: '' },
    { name: 'Fond', l: 2090, w: 780, qty: 1, grain: false, ops_text: 'poche x=200 y=200 lo=120 la=60 p=6\ntrou x=1045 y=390 d=12 p=T' },
    { name: 'Taquet', l: 60, w: 40, qty: 4, grain: false, ops_text: '' },
  ]));
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

// --- Version complète : catalogue, bois par lot, machines, lot en fabrication, expédition, SAV ---
const P = require('./production');
const pid = (name) => q.get('SELECT id FROM people WHERE name = ?', name)?.id;
const lu = pid('Lucas'), ni = pid('Nina'), pa = q.get("SELECT id FROM people WHERE role = 'patron'").id;
tx(() => {
  q.run('UPDATE people SET hours_week = 20 WHERE id = ?', pa);
  const sc = q.get("SELECT id FROM suppliers WHERE name = 'Scierie'")?.id || null;
  const lots = [['N-2611', 'Noyer', '27 mm', 0.62, 'Bourgogne'], ['C-2609', 'Chêne', '27 mm', 0.18, 'Bourgogne'], ['C-2611', 'Chêne', '40 mm', 0.02, 'Bourgogne'], ['F-2604', 'Frêne', '50 mm', 0.12, 'Jura'], ['F-2610', 'Frêne', '27 mm', 0.30, 'Jura'], ['N-2602', 'Noyer', '40 mm', 0.11, 'Bourgogne']];
  for (const [code, ess, th, vol, orig] of lots) q.run('INSERT INTO wood_lots (code, essence, thickness, volume, origin, supplier_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)', code, ess, th, vol, orig, sc, d(-30));
  const douille = q.run("INSERT INTO stock_items (category, name, ord) VALUES ('Électricité', 'Douilles E27 laiton', 1)").lastInsertRowid;
  const rosace = q.run("INSERT INTO stock_items (category, name, state, ord) VALUES ('Électricité', 'Rosaces laiton', 2, 2)").lastInsertRowid;
  const huile = q.get("SELECT id FROM stock_items WHERE name = 'Huile-cire'").id;
  const model = (code, name, family, woods, threshold, care, bom, steps) => {
    const id = q.run('INSERT INTO models (code, name, family, woods, threshold, care, checks) VALUES (?, ?, ?, ?, ?, ?, ?)', code, name, family, woods, threshold, care,
      JSON.stringify(['Veinage et teinte du lot', 'Ponçage sans rayure en lumière rasante', family === 'Luminaire' ? 'Câblage : continuité et serrage, essai 30 min' : 'Assemblages et stabilité', 'Numéro marqué sous la pièce'])).lastInsertRowid;
    bom.forEach(([article, qty, unit, essence, thickness, item], i) => q.run('INSERT INTO model_bom (model_id, article, qty, unit, essence, thickness, stock_item_id, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, article, qty, unit, essence || '', thickness || '', item || null, i));
    steps.forEach(([title, geste, est, perUnit], i) => q.run('INSERT INTO model_steps (model_id, ord, title, geste, est_hours, per_unit) VALUES (?, ?, ?, ?, ?, ?)', id, i + 1, title, geste, est, perUnit === false ? 0 : 1));
    return id;
  };
  model('S1', 'Suspension S1', 'Luminaire', 'Frêne, chêne, noyer', 3, 'Dépoussiérer avec un chiffon sec. Une fois par an, une fine couche d’huile-cire.',
    [['Frêne 50 mm', 0.007, 'm³', 'Frêne', '50 mm'], ['Douille E27 laiton', 1, '', '', '', douille], ['Câble textile noir', 1.5, 'm'], ['Rosace laiton', 1, '', '', '', rosace], ['Huile-cire', 0.05, 'L', '', '', huile]],
    [['Débit des pavillons', 'Débit, corroyage', 0.5], ['Tournage', 'Autre', 1.5], ['Câblage et douille', 'Assemblage', 0.7], ['Huile-cire', 'Huile-cire', 0.5], ['Contrôle et emballage', 'Contrôle', 0.3]]);
  model('L2', 'Lampe à poser L2', 'Luminaire', 'Chêne, noyer', 2, 'Chiffon sec. Ampoule E14 de 40 W maximum.',
    [['Chêne 40 mm', 0.005, 'm³', 'Chêne', '40 mm'], ['Abat-jour lin', 1, ''], ['Douille E14', 1, '']],
    [['Débit', 'Débit, corroyage', 0.5], ['Tournage du pied', 'Autre', 1.5], ['Câblage', 'Assemblage', 0.7], ['Finition', 'Huile-cire', 0.5], ['Contrôle', 'Contrôle', 0.3]]);
  model('T1', 'Tabouret T1', 'Mobilier', 'Chêne, frêne', 2, 'Éviter l’humidité stagnante. Huile-cire une fois par an.',
    [['Chêne 40 mm', 0.012, 'm³', 'Chêne', '40 mm'], ['Huile-cire', 0.08, 'L', '', '', huile]],
    [['Débit et corroyage', 'Débit, corroyage', 1], ['Tenons et mortaises', 'Assemblage', 2], ['Collage', 'Collage', 0.5], ['Ponçage et finition', 'Ponçage', 1.2], ['Contrôle', 'Contrôle', 0.3]]);
  const mach = (name, type, gestes, tasks, wear) => {
    const id = q.run("INSERT INTO machines (name, type, brand, since, gestes) VALUES (?, ?, '[Marque · modèle]', ?, ?)", name, type, '2019', gestes).lastInsertRowid;
    for (const [title, hrs, days, last] of tasks) q.run('INSERT INTO machine_tasks (machine_id, title, every_hours, every_days, last_done) VALUES (?, ?, ?, ?, ?)', id, title, hrs, days, last);
    for (const [w, st] of wear) q.run("INSERT INTO stock_items (category, name, state, machine_id) VALUES ('Usure machines', ?, ?, ?)", w, st, id);
    return id;
  };
  mach('Scie à format', 'Débit', 'Débit, corroyage', [['Changer la lame', 200, null, d(-50)], ['Nettoyer et graisser les guides', null, 30, d(-21)], ['Contrôler l’arrêt d’urgence', null, 365, d(-300)]], [['Lame Ø 300', 0]]);
  mach('Dégauchisseuse', 'Corroyage', 'Débit, corroyage', [['Changer ou affûter les fers', 120, null, d(-40)], ['Graisser les tables', null, 30, d(-26)]], [['Fers 410 mm (jeu)', 1]]);
  mach('Raboteuse', 'Corroyage', 'Débit, corroyage', [['Changer ou affûter les fers', 120, null, d(-20)], ['Nettoyer les rouleaux', null, 30, d(-12)]], [['Fers 400 mm (jeu)', 0]]);
  mach('Toupie', 'Moulurage', 'Assemblage', [['Vérifier outils et serrages', null, 30, d(-35)]], []);
  mach('Ponceuse à bande', 'Finition', 'Ponçage', [['Changer la bande', 30, null, d(-10)]], [['Bandes grain 120', 0]]);
  mach('Aspiration', 'Atelier', '', [['Vider et nettoyer les filtres', null, 14, d(-9)]], [['Sacs à copeaux', 0]]);
  q.run("INSERT INTO absences (person_id, start_date, end_date, label) VALUES (?, ?, ?, 'Congé')", lu, d(30), d(34));
});
// Un lot de suspensions lancé, 5 pièces contrôlées dont 2 réservées, 1 expédiée puis en SAV.
const s1 = q.get("SELECT id FROM models WHERE code = 'S1'").id;
const lot = P.launchFromModel(s1, { qty: 12, canal: 'Revendeur', forWhom: '[Revendeur]', dueDate: d(20), personId: pa });
tx(() => {
  q.run('UPDATE steps SET sent = 1, seen = 1, who_id = ? WHERE project_id = ?', lu, lot);
  q.run("UPDATE steps SET status = 'done', declared_hours = 6, declared_label = '6 h', started_at = ?, done_at = ? WHERE project_id = ? AND ord = 1", `${d(-6)} 08:00:00`, `${d(-5)} 17:00:00`, lot);
  q.run("UPDATE steps SET status = 'doing', started_at = ? WHERE project_id = ? AND ord = 2", `${d(-3)} 08:00:00`, lot);
  const units = q.all('SELECT id FROM units WHERE project_id = ? ORDER BY serial', lot);
  units.slice(0, 5).forEach((u, i) => q.run("UPDATE units SET status = 'en_stock', controlled_at = ?, controlled_by = ?, checks = ?, reserved_for = ? WHERE id = ?", `${d(-2)} 16:00:00`, pa,
    JSON.stringify(['Veinage et teinte du lot', 'Câblage : continuité et serrage, essai 30 min']), i < 2 ? 'Boutique · commande web' : '', u.id));
  const sh = q.run("INSERT INTO shipments (project_id, recipient, carrier, tracking, packing, shipped_at, delivered_at) VALUES (?, 'Boutique · client web', '[Transporteur]', '[N° de suivi]', 'Carton double cannelure', ?, ?)", lot, `${d(-1)} 10:00:00`, `${d(0)} 09:00:00`).lastInsertRowid;
  q.run("UPDATE units SET status = 'livree', shipment_id = ?, reserved_for = '' WHERE id = ?", sh, units[0].id);
  q.run("INSERT INTO sav (unit_id, project_id, client, body) VALUES (?, ?, 'Client boutique', 'La lumière clignote quand on touche le pavillon.')", units[0].id, lot);
});
console.log('Démo chargée. Patron : demo-atelier · iPad : Lucas 1111, Nina 2222, patron 0000 · adresse de test du portail : test@example.com');
