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

module.exports = { enabled, carnetFromText, readQuotePdf, clientUpdate, productionChain, chainPrompt, ChainSchema, AIError, MODEL };
