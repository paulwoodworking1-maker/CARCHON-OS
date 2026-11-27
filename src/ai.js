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

// --- 5. Lire une facture de panneaux ou de bois ---
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

module.exports = { enabled, carnetFromText, readQuotePdf, clientUpdate, chainStudy, readInvoicePdf, AIError, MODEL };
