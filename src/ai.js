'use strict';
// Intelligence artificielle (Claude) : facultative. Active seulement si ANTHROPIC_API_KEY est défini.
// Trois usages : écrire un carnet à partir d'une description libre, lire un devis PDF,
// rédiger un message d'avancement pour le client.
const AnthropicMod = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const Anthropic = AnthropicMod.default || AnthropicMod;
const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
let client = null;
const enabled = () => !!process.env.ANTHROPIC_API_KEY;
function api() {
  if (!client) client = new Anthropic({ timeout: 120000 });
  return client;
}

class AIError extends Error {}

// Un appel avec réponse structurée (JSON validé par le schéma).
async function structured({ system, content, schema, effort = 'medium', maxTokens = 16000, timeout }) {
  if (!enabled()) throw new AIError('L’assistant n’est pas activé (clé ANTHROPIC_API_KEY absente).');
  let res;
  try {
    res = await api().beta.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // si le modèle refuse, l'API relance sur un modèle de secours
      output_config: { effort, format: zodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content }],
    }, timeout ? { timeout } : undefined);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('La clé de l’assistant est refusée : vérifie ANTHROPIC_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new AIError('L’assistant est très demandé : réessaie dans une minute.');
    if (e instanceof Anthropic.BadRequestError) throw new AIError(`Demande refusée par l’assistant : ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('Impossible de joindre l’assistant (réseau).');
    if (e instanceof Anthropic.APIError) throw new AIError(`Erreur de l’assistant (${e.status}).`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AIError('L’assistant a refusé de traiter cette demande.');
  if (res.stop_reason === 'max_tokens' || !res.parsed_output) throw new AIError('Réponse de l’assistant incomplète : réessaie avec un texte plus court.');
  return res.parsed_output;
}

// --- 1. Carnet de fabrication à partir d'une description libre ---
const StepsSchema = z.object({
  fiches: z.array(z.object({
    titre: z.string(),
    pieces: z.string(),
    qui: z.string(),
    etape_frise: z.string(),
    geste: z.string(),
    heures: z.number(),
    mot_du_patron: z.string(),
    reperes: z.array(z.string()),
  })),
  remarques: z.string(),
});

async function carnetFromText({ project, text, people, phases, gestes, averages, existing }) {
  const system = `Tu aides un patron d'atelier d'ébénisterie à préparer le carnet de fabrication d'un projet : la suite de fiches que l'équipe suit sur l'iPad.
Chaque fiche = une étape de travail concrète, faite par une personne, en quelques heures à 2 jours.
Règles :
- Écris en français d'atelier, court et concret. Titre de 2 à 6 mots ("Débit du noyer", "Collage du plateau").
- "qui" : exactement un des prénoms fournis, ou "" si la description ne permet pas de choisir.
- "etape_frise" : exactement une des étapes fournies. "geste" : exactement un des gestes fournis.
- "heures" : estimation réaliste. Si une moyenne de l'atelier existe pour ce geste, pars d'elle.
- "mot_du_patron" : reprends les consignes de la description qui concernent cette fiche (vide sinon). N'invente pas de consigne technique.
- "reperes" : 0 à 4 points de contrôle courts, seulement s'ils sont utiles.
- Ordre : l'ordre logique de fabrication.
- N'ajoute pas les fiches qui existent déjà dans le carnet.
- "remarques" : une ou deux phrases sur ce qui manque ou paraît risqué (ou "").`;
  const content = `Projet : ${project.name}${project.wood ? `\nBois : ${project.wood}` : ''}${project.due_date ? `\nLivraison prévue : ${project.due_date}` : ''}
Équipe : ${people.map((p) => `${p.name} (${p.sub || 'atelier'})`).join(', ')}
Étapes de la frise : ${phases.join(', ')}
Gestes : ${gestes.join(', ')}
Moyennes réelles de l'atelier (heures par fiche) : ${Object.entries(averages).map(([g, h]) => `${g} ${h.toFixed(1)} h`).join(', ') || 'pas encore de données'}
Fiches déjà dans le carnet : ${existing.join(' ; ') || 'aucune'}

Description du patron :
"""${text}"""`;
  return structured({ system, content, schema: StepsSchema, effort: 'medium' });
}

// --- 2. Lire un devis PDF (export Qonto ou autre) ---
const QuoteSchema = z.object({
  numero: z.string(),
  client_nom: z.string(),
  client_email: z.string(),
  objet: z.string(),
  montant_ttc: z.string(),
  montant_ht: z.string(),
  acompte: z.string(),
  resume: z.string(),
  lignes: z.array(z.object({ designation: z.string(), quantite: z.string() })),
});
async function readQuotePdf(pdfBuffer) {
  const system = `Tu lis un devis d'ébénisterie (PDF) et tu en extrais les informations demandées, telles qu'elles sont écrites. N'invente rien : si une information n'apparaît pas, renvoie "".
- "objet" : nom court de la pièce ou de l'ouvrage, 2 à 5 mots, ex. "Table à manger · chêne".
- "montant_ttc" et "acompte" : tels qu'écrits, avec la devise.
- "montant_ht" : le total hors taxes, en chiffres seulement (ex. "8400,00").
- "resume" : une phrase sur ce qui est commandé.
- "lignes" : les lignes d'ouvrage du devis, dans l'ordre (désignation courte, sans prix ; quantité telle qu'écrite, "1" si absente). Ignore les lignes de total, de TVA, d'acompte et de conditions.`;
  return structured({
    system,
    schema: QuoteSchema,
    effort: 'low',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { type: 'text', text: 'Extrais les informations de ce devis.' },
    ],
  });
}

// --- 3. Message d'avancement pour le client ---
const MessageSchema = z.object({ objet: z.string(), message: z.string() });
async function clientUpdate({ project, clientName, facts }) {
  const system = `Tu écris, au nom de l'atelier Carchon Les Ateliers (ébénisterie), un court message d'avancement à un client.
Ton de la marque : sobre, précis, sans effet. Vouvoiement. Phrases courtes, verbes concrets : décrire le bois, le geste, le temps passé.
Dire « pièce », jamais « meuble » ni « produit ». Aucun mot d'inflation émotionnelle (« magique », « incroyable », « coup de cœur »), aucun emoji, aucun point d'exclamation.
4 à 7 phrases. Pas de prix, pas de fournisseur, pas de problème interne.
N'annonce que les faits fournis ; ne promets aucune date qui n'est pas dans les faits. Termine par une formule de politesse et "L'équipe Carchon".`;
  return structured({
    system,
    schema: MessageSchema,
    effort: 'low',
    content: `Client : ${clientName}\nProjet : ${project.name}\nFaits :\n${facts.map((f) => `- ${f}`).join('\n')}`,
  });
}

// --- 4. Étude de fabrication d'un projet (chaîne de production) ---
// Aucun modèle figé : l'IA lit la demande (cuisine, dressing, bureau, massif… ou tout à la fois) et
// renvoie une nomenclature complète, la quincaillerie, les postes en heures et le texte du devis.
const StudySchema = z.object({
  titre: z.string(),
  resume: z.string(),
  ensembles: z.array(z.object({
    nom: z.string(), largeur: z.number(), hauteur: z.number(), profondeur: z.number(), description: z.string(),
    vue: z.array(z.object({ x: z.number(), y: z.number(), l: z.number(), h: z.number(), label: z.string() })),
  })),
  pieces: z.array(z.object({
    rep: z.string(), ensemble: z.string(), designation: z.string(), longueur: z.number(), largeur: z.number(), epaisseur: z.number(), quantite: z.number(),
    matiere_id: z.number(), matiere_libre: z.string(), chants_ml_par_piece: z.number(), face_vue: z.boolean(), usinage: z.string(),
  })),
  quincaillerie: z.array(z.object({ designation: z.string(), quantite: z.number(), unite: z.string(), prix_unitaire: z.number() })),
  finition: z.string(),
  couches: z.number(),
  postes: z.array(z.object({
    nom: z.string(), detail: z.string(), groupe: z.enum(['Conception', 'Fabrication', 'Finition', 'Pose']), etape_frise: z.string(), geste: z.string(),
    heures: z.number(), personnes: z.number(), machine: z.boolean(), sechage_jours: z.number(),
  })),
  devis: z.array(z.object({ groupe: z.enum(['Conception', 'Fabrication', 'Finition', 'Pose']), titre: z.string(), descriptif: z.string() })),
  delai_fournisseur_jours: z.number(),
  hypotheses: z.array(z.string()),
  questions_client: z.array(z.string()),
});

async function chainStudy({ project, brief, previous, instruction, refs, stock, bareme, averages, params, phases, gestes }) {
  const system = `Tu es le bureau des méthodes d'un atelier d'ébénisterie et d'agencement (Carchon Les Ateliers). À partir de la demande d'un client, tu prépares l'étude de fabrication complète : elle sert à chiffrer, débiter sur panneaux, commander, planifier et poser.
Aucun modèle figé : adapte-toi au projet tel qu'il est (cuisine, dressing, placard, bureau, bibliothèque, mobilier massif, agencement de magasin… ou plusieurs à la fois). Découpe-le en ensembles cohérents.
Règles :
- Toutes les cotes en millimètres. Longueur = sens du fil. Une ligne par type de pièce (avec quantité), repère court en lettres propre à la ligne (ex. "BC" côtés de caissons bas, "FA" façades).
- Matière : choisis "matiere_id" dans la liste des références de l'atelier (épaisseur cohérente). Si aucune ne convient, matiere_id = 0 et décris-la dans "matiere_libre" (ex. "Chêne massif", "Stratifié compact 12 mm") ; pour le bois massif, écris "massif" dans matiere_libre si la référence n'existe pas.
- Pièces : n'oublie rien (côtés, dessus, dessous, fonds, étagères, traverses, façades, tiroirs et leurs éléments, plinthes, fileurs, joues de finition, plans de travail, plateaux, pieds…). Une pièce plus grande qu'un panneau du stock doit être prévue en plusieurs morceaux ou en matière hors stock.
- "chants_ml_par_piece" : mètres de chant à plaquer sur UNE pièce (0 si massif ou pas de chant). "face_vue" : vrai si la pièce est vue et reçoit la finition.
- Quincaillerie : références précises (marque et modèle quand l'usage est clair, ex. "Coulisse Blum Tandembox antaro 500 mm", "Charnière Blum Clip top 110°"), quantités exactes, prix unitaires HT réalistes. Utilise en priorité ce que l'atelier a déjà en stock (liste fournie). Ajoute fixations, chevilles adaptées au mur et consommables d'assemblage.
- Finition : produit et nombre de couches d'après la demande ("Aucune" et 0 si mélaminé ou brut).
- Postes : la suite réelle des opérations (préparation et plans, débit/CNC, placage des chants, corroyage pour le massif, usinages, ponçage, finition, montage, contrôle et emballage, livraison et pose…). Heures-personne réalistes en partant du barème et des moyennes réelles de l'atelier. "personnes" = nombre de personnes en même temps (2 pour la pose de grands éléments). "machine" = vrai pour l'usinage CNC. "sechage_jours" = attente après le poste (finition). "etape_frise" et "geste" : exactement une valeur des listes fournies. "groupe" : où ce poste apparaît dans le devis.
- Vue de face par ensemble ("vue") : rectangles en mm, origine en bas à gauche, pour dessiner l'élévation (caissons, façades, tiroirs, niches, plan de travail). 4 à 40 rectangles.
- Devis : un titre et un descriptif sobre par groupe concerné (vouvoiement, sans prix, vocabulaire d'atelier, aucun superlatif).
- "hypotheses" : ce que tu as supposé faute d'information. "questions_client" : les questions à poser au client pour lever le doute (courtes). Ne bloque pas : fais l'étude avec des hypothèses raisonnables.
- Si une étude précédente et une consigne d'ajustement sont fournies, repars de l'étude précédente et applique seulement la consigne.`;
  const content = `Projet : ${project.name}${project.descr ? ` · ${project.descr}` : ''}
Contexte de pose : mur ${params.mur}, ${params.km} km de l'atelier, ${params.etage} étage(s) sans ascenseur.
Références de panneaux et bois de l'atelier (id · désignation · type · épaisseur mm · format mm · prix) :
${refs.map((r) => `${r.id} · ${r.name} · ${r.kind} · ${r.thickness} · ${r.length} × ${r.width} · ${r.kind === 'Bois massif' ? `${r.price_m3} €/m³` : `${r.price_m2} €/m²`}`).join('\n') || 'aucune'}
Quincaillerie et consommables en stock à l'atelier : ${stock.join(' ; ') || '—'}
Barème de l'atelier : ${Object.entries(bareme).map(([k, v]) => `${k}=${v}`).join(', ')}
Moyennes réelles (heures par fiche et par geste) : ${Object.entries(averages).map(([g, h]) => `${g} ${Number(h).toFixed(1)} h`).join(', ') || 'pas encore de données'}
Étapes de la frise : ${phases.join(', ')}
Gestes : ${gestes.join(', ')}

Demande du client :
"""${brief}"""${previous ? `

Étude précédente (JSON) :
${JSON.stringify(previous)}

Consigne d'ajustement du patron :
"""${instruction}"""` : ''}`;
  return structured({ system, content, schema: StudySchema, effort: 'high', maxTokens: 32000, timeout: 15 * 60 * 1000 });
}



// --- 4. Carnet de fabrication lu dans les plans + ce que le patron dicte ---
// Les plans (PDF ou images) sont envoyés tels quels : le modèle lit les cotes, les assemblages, les matières.
const PlanCarnetSchema = z.object({
  fiches: StepsSchema.shape.fiches,
  debit: z.array(z.object({
    piece: z.string(),
    quantite: z.string(),
    longueur: z.string(),
    largeur: z.string(),
    epaisseur: z.string(),
    matiere: z.string(),
    remarque: z.string(),
  })),
  elements: z.array(z.object({ nom: z.string(), description: z.string() })),
  questions: z.array(z.string()),
  remarques: z.string(),
});

const PLAN_IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
// Transforme les fichiers de plans en blocs lisibles par l'API. Renvoie aussi ceux qui ont été écartés (format, taille).
function planBlocks(plans, readFile) {
  const path = require('node:path');
  const blocks = [], skipped = [];
  let total = 0;
  for (const pl of plans) {
    if (!pl.file) { skipped.push(`${pl.version} (pas de fichier)`); continue; }
    const ext = path.extname(pl.file).toLowerCase();
    let buf;
    try { buf = readFile(pl.file); } catch { skipped.push(`${pl.version} (fichier introuvable)`); continue; }
    const limit = ext === '.pdf' ? 24 * 1024 * 1024 : 5 * 1024 * 1024;
    if (buf.length > limit || total + buf.length > 24 * 1024 * 1024) { skipped.push(`${pl.version} (trop lourd)`); continue; }
    if (ext === '.pdf') blocks.push({ type: 'document', title: `Plan ${pl.version}`, source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
    else if (PLAN_IMG[ext]) blocks.push({ type: 'image', source: { type: 'base64', media_type: PLAN_IMG[ext], data: buf.toString('base64') } });
    else { skipped.push(`${pl.version} (format ${ext} non lu : exporter en PDF ou JPG)`); continue; }
    blocks.push({ type: 'text', text: `↑ Plan ${pl.version}${pl.descr ? ` · ${pl.descr}` : ''}${pl.status === 'validee' ? ' (version validée, fait foi)' : ''}` });
    total += buf.length;
  }
  return { blocks, skipped };
}

async function carnetFromPlans({ project, plans, readFile, text, people, phases, gestes, averages, existing, subcontracted = [] }) {
  const { blocks, skipped } = planBlocks(plans, readFile);
  if (!blocks.length && !String(text || '').trim()) throw new AIError(`Aucun plan lisible ni dictée : ${skipped.join(', ') || 'ajoute un plan PDF ou image, ou dicte le travail.'}`);
  const system = `Tu prépares le carnet de fabrication d'un projet d'ébénisterie pour l'atelier Carchon Les Ateliers, à partir des plans fournis et de ce que le patron dicte.
Le carnet = la suite de fiches que l'équipe suit sur l'iPad. Chaque fiche = une étape de travail concrète, faite par une personne, en quelques heures à 2 jours.

Lis les plans attentivement : vues, cotes, nomenclature, cartouche, matières, chants, quincaillerie, assemblages, finitions.
La dictée du patron prime sur les plans quand ils divergent (c'est la décision la plus récente) ; signale l'écart dans "questions".

Règles :
- Français d'atelier, court et concret. Titre de 2 à 6 mots ("Débit des caissons", "Placage des chants").
- "qui" : exactement un des prénoms fournis, ou "" si rien ne permet de choisir.
- "etape_frise" : exactement une des étapes fournies. "geste" : exactement un des gestes fournis.
- "heures" : estimation réaliste ; pars de la moyenne de l'atelier pour ce geste si elle existe.
- "mot_du_patron" : les consignes dictées ou lues sur le plan qui concernent cette fiche (vide sinon). N'invente aucune consigne technique.
- "reperes" : 0 à 4 points de contrôle courts (cotes clés, sens du fil, équerrage…), tirés des plans.
- "pieces" : les éléments concernés, avec leur repère du plan s'il existe.
- Ordre logique de fabrication. N'ajoute pas les fiches qui existent déjà.
- "debit" : la liste de débit lue sur les plans (une ligne par élément : quantité, longueur × largeur × épaisseur en mm telles qu'écrites, matière). Mets "" pour une cote illisible ou absente : n'en invente jamais.
- "elements" : les grands éléments de l'ouvrage (caisson, plateau, façades…), 1 à 12, avec une description courte (dimensions hors tout si lisibles).
- La sous-traitance est décidée par le patron seul : ne propose aucune prestation à confier à l'extérieur. Pour les prestations déjà sous-traitées (liste fournie), ne crée pas de fiche pour le travail fait dehors ; seulement, si utile, la préparation avant départ et le contrôle au retour.
- "questions" : cotes manquantes, incohérences, choix à trancher avant de lancer (0 à 6 points).
- "remarques" : une ou deux phrases sur ce qui paraît risqué (ou "").`;
  const content = [
    ...blocks,
    { type: 'text', text: `Projet : ${project.name}${project.ref ? ` (dossier ${project.ref})` : ''}${project.wood ? `\nBois / matière : ${project.wood}` : ''}${project.due_date ? `\nLivraison prévue : ${project.due_date}` : ''}${project.notes ? `\nNotes du dossier : ${project.notes}` : ''}
Équipe : ${people.map((p) => `${p.name} (${p.sub || 'atelier'})`).join(', ')}
Étapes de la frise : ${phases.join(', ')}
Gestes : ${gestes.join(', ')}
Moyennes réelles de l'atelier (heures par fiche) : ${Object.entries(averages).map(([g, h]) => `${g} ${h.toFixed(1)} h`).join(', ') || 'pas encore de données'}
Prestations sous-traitées par le patron : ${subcontracted.join(' ; ') || 'aucune'}
Fiches déjà dans le carnet : ${existing.join(' ; ') || 'aucune'}
${blocks.length ? '' : 'Aucun plan lisible : travaille seulement depuis la dictée, laisse "debit" vide.\n'}
Ce que dicte le patron :
"""${String(text || '').trim() || '(rien : pars uniquement des plans)'}"""` },
  ];
  const out = await structured({ system, content, schema: PlanCarnetSchema, effort: 'high', maxTokens: 32000, timeout: 10 * 60 * 1000 });
  return { ...out, skipped };
}


// --- 4. Chaîne de production : devis + modèle 3D + vues + nomenclature / chiffrage → débit, matière, gamme ---
// Opus 5.5 à l'effort maximal, en flux (réponse longue : la fiche de débit et la gamme complète).
const ChainSchema = z.object({
  analyse: z.string(),
  pieces: z.array(z.object({ nom: z.string(), description: z.string() })),
  debit: z.array(z.object({
    ensemble: z.string(),
    piece: z.string(),
    quantite: z.number(),
    materiau: z.string(),
    longueur_mm: z.number(),
    largeur_mm: z.number(),
    epaisseur_mm: z.number(),
    brut_longueur_mm: z.number(),
    brut_largeur_mm: z.number(),
    brut_epaisseur_mm: z.number(),
    sens_du_fil: z.string(),
    note: z.string(),
  })),
  matiere: z.array(z.object({
    categorie: z.enum(['Bois massif', 'Panneaux', 'Quincaillerie', 'Finition', 'Consommables', 'Autre']),
    designation: z.string(),
    essence: z.string(),
    epaisseur: z.string(),
    quantite: z.number(),
    unite: z.string(),
    fournisseur: z.string(),
    avant_fabrication: z.boolean(),
  })),
  fiches: z.array(z.object({
    titre: z.string(),
    pieces: z.string(),
    qui: z.string(),
    etape_frise: z.string(),
    geste: z.string(),
    machine: z.string(),
    heures: z.number(),
    mot_du_patron: z.string(),
    reperes: z.array(z.string()),
  })),
  remarques: z.string(),
});

async function streamStructured({ system, content, schema, effort = 'max', maxTokens = 64000 }) {
  if (!enabled()) throw new AIError('L’assistant n’est pas activé (clé ANTHROPIC_API_KEY absente).');
  let msg;
  try {
    const stream = api().beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort, format: zodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content }],
    }, { timeout: 30 * 60 * 1000 });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('La clé de l’assistant est refusée : vérifie ANTHROPIC_API_KEY.');
    if (e instanceof Anthropic.RateLimitError) throw new AIError('L’assistant est très demandé : réessaie dans une minute.');
    if (e instanceof Anthropic.BadRequestError) throw new AIError(`Demande refusée par l’assistant : ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('Impossible de joindre l’assistant (réseau).');
    if (e instanceof Anthropic.APIError) throw new AIError(`Erreur de l’assistant (${e.status}).`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new AIError('L’assistant a refusé de traiter cette demande.');
  if (msg.stop_reason === 'max_tokens') throw new AIError('Réponse trop longue : découpe le projet (un fichier 3D par ensemble) et relance.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return schema.parse(JSON.parse(text)); }
  catch { throw new AIError('Réponse de l’assistant illisible : relance la génération.'); }
}

function chainPrompt({ project, people, phases, gestes, averages, suppliers, stock, machines }) {
  const system = `Tu es chef d'atelier et méthodiste dans une ébénisterie haut de gamme (mobilier et luminaires en bois massif, série et sur-mesure). Un projet vient d'être signé. À partir du devis accepté, du modèle 3D (nomenclature mesurée solide par solide), des vues 3D et de la nomenclature ou du chiffrage de l'atelier, tu prépares tout ce qu'il faut pour fabriquer, comme le ferait un méthodiste exigeant. La conception est terminée (elle a été faite avant le chiffrage) : ne crée aucune fiche de conception, de dessin ou de validation de plans.

Ce que tu rends :
1. "analyse" : la lecture technique du projet en 5 à 12 phrases : structure et ensembles, principes d'assemblage (tenons-mortaises, queues d'aronde, dominos, lamelles…), sens du fil et choix de débit, points délicats, ordre de fabrication retenu et pourquoi.
2. "pieces" : les ensembles fabriqués avec une description courte (dimensions, essence).
3. "debit" : la fiche de débit complète, pièce par pièce.
   - Cotes finies : celles mesurées dans la 3D font foi, sinon celles des plans ou de la nomenclature. N'invente aucune cote : si elle manque, mets 0 et explique dans "note".
   - Cotes brutes de débit : surcote réaliste en longueur, largeur et épaisseur selon l'usinage (dégauchissage, rabotage, tenons, coupe d'équerre) et l'essence.
   - "sens_du_fil" : en long, en travers, ou "panneau" ; "note" : assemblage, usinage particulier, choix du bois (fil, maille, aubier).
4. "matiere" : tout ce qu'il faut acheter ou sortir du stock, regroupé par article.
   - Bois massif : volume brut en m³ calculé depuis la fiche de débit, plus 25 à 35 % de chute selon l'essence et la qualité (dis le taux dans la désignation), regroupé par essence et épaisseur commerciale (27, 34, 41, 54, 65 mm…).
   - Panneaux : nombre de panneaux au format commercial, avec optimisation de découpe.
   - Quincaillerie, colle, finition, abrasifs, consommables : quantités réalistes et unités.
   - "fournisseur" : un des fournisseurs connus s'il convient, sinon "".
   - "avant_fabrication" : vrai si c'est nécessaire avant le débit ou l'assemblage.
   - Ce qui est déjà en stock en quantité suffisante n'est pas à acheter.
5. "fiches" : la gamme de fabrication, dans l'ordre réel de l'atelier : débit et corroyage par lot de pièces, usinages, montages à blanc, collages (avec temps de séchage), ponçage, finition (couches et séchages), contrôle final, emballage, livraison et pose si le devis en prévoit.
   - Une fiche = une étape concrète faite par une personne, de 1 h à 2 jours ; découpe les longues opérations. Titre de 2 à 6 mots en français d'atelier.
   - "pieces" : les pièces concernées, avec leurs repères de la fiche de débit.
   - "qui" : exactement un des prénoms fournis, selon les spécialités et en équilibrant la charge, ou "".
   - "etape_frise" : exactement une des étapes fournies (jamais Conception ni Accord). "geste" : exactement un des gestes fournis. "machine" : la machine principale, parmi celles de l'atelier si elle y est, sinon "".
   - "heures" : réalistes pour un ébéniste confirmé. Si le chiffrage donne des heures, elles font foi et tu les répartis ; sinon pars des moyennes réelles de l'atelier.
   - "mot_du_patron" : les consignes utiles tirées des documents (cotes clés, réglages, ordre de collage, finition, points à surveiller).
   - "reperes" : 1 à 5 points de contrôle mesurables (ex. "Équerrage du caisson : diagonales à 1 mm").
"remarques" : ce qui manque ou est incertain dans les documents et qu'il faut vérifier avant de commander (ou "").`;
  const intro = `Projet : ${project.name}${project.due_date ? ` · livraison promise le ${project.due_date}` : ''}
Équipe : ${people.map((p) => `${p.name} (${p.sub || 'atelier'}, ${p.hours_week || 35} h/semaine)`).join(', ')}
Étapes de la frise : ${phases.filter((x) => !['Conception', 'Accord'].includes(x)).join(', ')}
Gestes : ${gestes.join(', ')}
Machines de l'atelier : ${machines.join(', ') || 'non renseignées'}
Moyennes réelles de l'atelier (heures par fiche) : ${Object.entries(averages).map(([g, h]) => `${g} ${h.toFixed(1)} h`).join(', ') || 'pas encore de données'}
Fournisseurs connus : ${suppliers.join(', ') || 'aucun'}
En stock : ${stock.join(', ') || 'rien de suivi'}

Documents du projet ci-dessous.`;
  return { system, intro };
}
async function productionChain(ctx) {
  const { system, intro } = chainPrompt(ctx);
  return streamStructured({ system, content: [{ type: 'text', text: intro }, ...ctx.files], schema: ChainSchema });
}


// --- 5. Pièces à usiner à la CNC, lues dans les plans ---
// L'assistant décrit les pièces et leurs usinages ; il n'écrit jamais de G-code (le moteur de Carchon le calcule et le contrôle).
const CncSchema = z.object({
  pieces: z.array(z.object({
    nom: z.string(),
    longueur: z.number(),
    largeur: z.number(),
    epaisseur: z.number(),
    quantite: z.number(),
    matiere: z.string(),
    sens_du_fil: z.boolean(),
    usinages: z.array(z.object({
      type: z.enum(['trou', 'rainure', 'poche']),
      x: z.number(), y: z.number(), diametre: z.number(),
      x2: z.number(), y2: z.number(), largeur: z.number(), longueur: z.number(),
      profondeur: z.number(), traversant: z.boolean(),
    })),
  })),
  questions: z.array(z.string()),
});
async function cncFromPlans({ project, plans, readFile, text, debit, materials }) {
  const { blocks, skipped } = planBlocks(plans, readFile);
  if (!blocks.length && !String(text || '').trim() && !(debit || []).length) throw new AIError(`Rien à lire : ${skipped.join(', ') || 'ajoute un plan ou une liste de débit.'}`);
  const system = `Tu prépares les pièces à usiner sur une CNC à table à dépression, pour un atelier d'ébénisterie, à partir des plans fournis.
Tu ne produis JAMAIS de G-code : seulement la description des pièces et de leurs usinages ; le logiciel calcule les parcours et les contrôle.

Pour chaque pièce plate à détourer à la CNC (joues, tablettes, fonds, façades, traverses…) :
- "longueur" (axe X de la pièce) et "largeur" (axe Y) en mm, finies, telles que cotées ; "epaisseur" en mm ; "quantite".
- "matiere" : une des matières fournies si possible.
- "sens_du_fil" : true si la pièce a un fil ou un décor à respecter (bois, placage, décor bois) le long de sa longueur ; false pour mélaminé uni, MDF.
- "usinages", repérés depuis le coin bas-gauche de la pièce vue de dessus (face usinée), en mm :
  - trou : x, y = centre ; diametre ; profondeur, ou traversant=true.
  - rainure : de (x, y) à (x2, y2) sur l'axe de la rainure, parallèle à un bord ; largeur ; profondeur.
  - poche : x, y = coin bas-gauche ; longueur (X) ; largeur (Y) ; profondeur.
  - Mets 0 dans les champs inutiles pour le type.
- Système 32 : rangées de trous Ø5 à 37 mm du chant, entraxe 32 mm, seulement s'ils sont dessinés ou dictés.
- N'invente aucune cote ni aucun usinage : une cote absente va dans "questions" et l'usinage n'est pas ajouté.
- Ignore les pièces qui ne passent pas à la CNC (massif tourné, quincaillerie, verre…).
"questions" : cotes manquantes, face d'usinage à confirmer, incohérences (0 à 8).`;
  const content = [
    ...blocks,
    { type: 'text', text: `Projet : ${project.name}${project.wood ? `\nMatière : ${project.wood}` : ''}
Matières de la bibliothèque : ${materials.join(', ')}
${(debit || []).length ? `Liste de débit déjà lue dans le dossier :\n${debit.map((d) => `- ${d.piece} · ${d.quantite} × ${d.longueur} × ${d.largeur} × ${d.epaisseur} · ${d.matiere}`).join('\n')}\n` : ''}
Précisions du patron :
"""${String(text || '').trim() || '(aucune)'}"""` },
  ];
  const out = await structured({ system, content, schema: CncSchema, effort: 'high', maxTokens: 32000, timeout: 10 * 60 * 1000 });
  return { ...out, skipped };
}

// --- 6. Lire une facture de panneaux ou de bois ---
const InvoiceSchema = z.object({
  fournisseur: z.object({ nom: z.string(), email: z.string(), telephone: z.string() }),
  numero: z.string(),
  date: z.string(),
  lignes: z.array(z.object({
    designation: z.string(), type: z.enum(['Panneau', 'Bois massif', 'Chant', 'Autre']),
    epaisseur_mm: z.number(), longueur_mm: z.number(), largeur_mm: z.number(),
    quantite: z.number(), unite: z.enum(['panneau', 'm²', 'm³', 'ml', 'pièce', 'autre']), prix_unitaire_ht: z.number(),
  })),
});
async function readInvoicePdf(pdfBuffer) {
  const system = `Tu lis une facture ou un bon de livraison d'un négoce de bois et panneaux pour un atelier d'ébénisterie. Extrais le fournisseur et chaque ligne d'article, telle qu'écrite.
- "designation" : nom court et clair de la référence SANS l'épaisseur ni le format (ex. "MDF plaqué chêne A/B", "Mélaminé blanc", "Contreplaqué bouleau", "Chêne massif avivé").
- Épaisseur et format en mm (0 si absent ; pour du massif, longueur et largeur moyennes si indiquées).
- "unite" et "prix_unitaire_ht" : tels qu'écrits sur la ligne (prix HT après remise).
- Ignore frais de port, éco-participation, totaux, TVA. N'invente rien : 0 ou "" si absent.`;
  return structured({ system, schema: InvoiceSchema, effort: 'low', timeout: 5 * 60 * 1000,
    content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } }, { type: 'text', text: 'Extrais les lignes de cette facture.' }] });
}

// --- Catalogue ou tarif fournisseur en PDF : articles et prix HT, par tranches de pages ---
const CatalogSchema = z.object({
  pages_total: z.number(),
  articles: z.array(z.object({ reference: z.string(), designation: z.string(), unite: z.string(), conditionnement: z.string(), prix_ht: z.number(), categorie: z.string() })),
});
async function readCatalogPdf(pdfBuffer, { from = 1, to = 10 } = {}) {
  const system = `Tu lis le catalogue ou le tarif d'un fournisseur d'atelier de menuiserie-ébénisterie (bois, panneaux, quincaillerie, droguerie, consommables).
Tu en extrais les articles avec un prix, tels qu'ils sont écrits. N'invente rien : un article sans prix lisible est ignoré.
- "reference" : la référence ou le code article du fournisseur ("" si absente).
- "designation" : le nom de l'article, avec ses dimensions, matière, finition, contenance (ex. "Charnière invisible 35 mm, angle 110°, inox").
- "unite" : l'unité du prix (pièce, boîte, m, m², m³, L, kg…), "" si non précisée.
- "conditionnement" : le conditionnement s'il est indiqué (ex. "boîte de 200"), sinon "".
- "prix_ht" : prix unitaire HT en euros (nombre). Si seul un prix TTC est donné, divise par 1,2. Si plusieurs prix par quantité, prends le prix à l'unité.
- "categorie" : Quincaillerie, Droguerie, Matériaux ou Consommables.
- "pages_total" : le nombre total de pages du document.
Ne traite QUE les pages ${from} à ${to} du document (les autres seront lues séparément).`;
  return structured({
    system, schema: CatalogSchema, effort: 'low', maxTokens: 32000, timeout: 10 * 60 * 1000,
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
      { type: 'text', text: `Extrais les articles et leurs prix des pages ${from} à ${to}.` },
    ],
  });
}

module.exports = { readCatalogPdf, readInvoicePdf, enabled, carnetFromText, carnetFromPlans, cncFromPlans, planBlocks, readQuotePdf, clientUpdate, productionChain, chainPrompt, ChainSchema, chainStudy, AIError, MODEL };
