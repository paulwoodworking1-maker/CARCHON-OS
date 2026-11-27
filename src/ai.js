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
  acompte: z.string(),
  resume: z.string(),
  lignes: z.array(z.object({ designation: z.string(), quantite: z.string() })),
});
async function readQuotePdf(pdfBuffer) {
  const system = `Tu lis un devis d'ébénisterie (PDF) et tu en extrais les informations demandées, telles qu'elles sont écrites. N'invente rien : si une information n'apparaît pas, renvoie "".
- "objet" : nom court de la pièce ou de l'ouvrage, 2 à 5 mots, ex. "Table à manger · chêne".
- "montant_ttc" et "acompte" : tels qu'écrits, avec la devise.
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

module.exports = { enabled, carnetFromText, carnetFromPlans, cncFromPlans, planBlocks, readQuotePdf, clientUpdate, AIError, MODEL };
