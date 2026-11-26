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
async function structured({ system, content, schema, effort = 'medium', maxTokens = 16000 }) {
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
    });
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

module.exports = { enabled, carnetFromText, readQuotePdf, clientUpdate, AIError, MODEL };
