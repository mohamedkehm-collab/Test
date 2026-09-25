const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ============================================================
// WHATSAPP QUIZ BOT V3.0 — "PÉPITE"
// ============================================================
// - 9039 questions de base
// - questions en gras, thème jamais affiché
// - tirage aléatoire sans répétition jusqu'à épuisement du stock
// - historique de tirage par discussion/thème
// - questions ajoutées séparément dans custom_questions.json
// - sauvegarde automatique des ajouts/modifications/suppressions
// - détection des doublons exacts + quasi-doublons
// - commandes de gestion protégées par OWNER_NUMBERS
// - scores + statistiques
// - auto-réponse conservée mais absente de l'aide
// - aucun sticker / sharp
// ============================================================

const PORT = process.env.PORT || 10000;
const PHONE_NUMBER = process.env.BOT_PHONE_NUMBER || "";
const DEFAULT_TIMER = 14;
const DEFAULT_QUIZ_SIZE = 25;
const MAX_QUIZ_SIZE = 200;
const NEXT_DELAY_MS = 1200;
const CMD_PREFIX = "?"; // symbole des commandes (ex. "?quiz")

const BASE_QUESTIONS_FILE = path.join(__dirname, "questions.json");
const CUSTOM_FILE = path.join(__dirname, "custom_questions.json");
const STATE_FILE = path.join(__dirname, "quiz_state.json");
const SCORES_FILE = path.join(__dirname, "scores.json");
const AUTH_FOLDER = path.join(__dirname, "auth_info");

const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || PHONE_NUMBER)
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

function normalizedPhoneNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

const OWNER_PHONE_NUMBERS = new Set(
  OWNER_NUMBERS.map(normalizedPhoneNumber).filter(Boolean)
);

http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ready") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.url === "/ready" && !global.sock ? "STARTING" : "OK");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("WhatsApp Quiz Bot V3.2 actif");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Serveur HTTP sur ${PORT}`);
});

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.log(`⚠️ Lecture impossible ${path.basename(file)}: ${e.message}`);
    return fallback;
  }
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function saveCustom() { atomicWrite(CUSTOM_FILE, customQuestions); }
function saveState() { atomicWrite(STATE_FILE, persistentState); }
function saveScores() { atomicWrite(SCORES_FILE, scores); }

const baseQuestionsRaw = readJson(BASE_QUESTIONS_FILE, []);
let customQuestions = readJson(CUSTOM_FILE, []);
let persistentState = readJson(STATE_FILE, { decks: {}, disabledChats: {} });
let scores = readJson(SCORES_FILE, {});

if (!Array.isArray(customQuestions)) customQuestions = [];
if (!persistentState || typeof persistentState !== "object") persistentState = { decks: {}, disabledChats: {} };
if (!persistentState.decks) persistentState.decks = {};
if (!persistentState.disabledChats) persistentState.disabledChats = {};
if (!scores || typeof scores !== "object") scores = {};

function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(text) {
  return normalize(text).replace(/\s+/g, "_");
}

function canonicalTheme(input) {
  const wanted = normalize(input);
  const all = [...new Set([...baseQuestionsRaw, ...customQuestions].map(q => q.t).filter(Boolean))];
  const exact = all.find(t => normalize(t) === wanted);
  if (exact) return exact;
  const partial = all.find(t => normalize(t).includes(wanted) || wanted.includes(normalize(t)));
  if (partial) return partial;
  return String(input).trim().replace(/\s+/g, " ").replace(/\b\p{L}/gu, c => c.toUpperCase());
}

function makeQuestionId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function allQuestions() {
  return [...baseQuestionsRaw, ...customQuestions];
}

function getQuestions(theme = null) {
  const all = allQuestions();
  if (!theme) return all;
  const n = normalize(theme);
  return all.filter(q => normalize(q.t) === n);
}

function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  const jaccard = union ? inter / union : 0;
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return 0.7 * jaccard + 0.3 * lenRatio;
}

function duplicateCheck(question, theme) {
  const n = normalize(question);
  const sameTheme = getQuestions(theme);
  for (const q of sameTheme) {
    if (normalize(q.q) === n) return { exact: true, question: q };
    if (similarity(question, q.q) >= 0.92) return { near: true, question: q };
  }
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Persistent deck: a question is not reused in the same chat/theme
// until the deck is exhausted. After exhaustion, a new cycle starts.
function deckKey(chatId, theme) {
  return `${chatId}::${slug(theme || "__TOUS__")}`;
}

function getDeck(chatId, theme, pool) {
  const key = deckKey(chatId, theme);
  let deck = Array.isArray(persistentState.decks[key]) ? persistentState.decks[key] : [];
  const ids = new Set(pool.map(q => String(q.id)));

  deck = deck.filter(id => ids.has(String(id)));

  if (!deck.length) {
    deck = shuffle(pool.map(q => q.id));
  }

  persistentState.decks[key] = deck;
  return { key, deck };
}

function takeQuestion(chatId, theme) {
  const pool = getQuestions(theme);
  if (!pool.length) return null;

  const { key, deck } = getDeck(chatId, theme, pool);
  const byId = new Map(pool.map(q => [String(q.id), q]));
  let q = null;

  while (deck.length && !q) {
    const id = deck.pop();
    q = byId.get(String(id)) || null;
  }

  if (!q) {
    persistentState.decks[key] = shuffle(pool.map(x => x.id));
    const id = persistentState.decks[key].pop();
    q = byId.get(String(id)) || null;
  }

  saveState();
  return q;
}

function extractNumber(id) {
  return String(id || "").split("@")[0].split(":")[0];
}

async function isOwner(senderId, msg, sock) {
  if (msg?.key?.fromMe) return true;

  const candidates = [
    senderId,
    msg?.key?.participantPn,
    msg?.key?.participantAlt,
    msg?.key?.remoteJidAlt
  ].filter(Boolean);

  if (String(senderId).endsWith("@lid") && sock?.signalRepository?.lidMapping) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(senderId);
      if (pn) candidates.push(pn);
    } catch {}
  }

  return candidates.some(candidate =>
    OWNER_PHONE_NUMBERS.has(normalizedPhoneNumber(extractNumber(candidate)))
  );
}

async function resolvePlayerJid(senderId, sock) {
  const jid = String(senderId || "");
  if (!jid.endsWith("@lid") || !sock?.signalRepository?.lidMapping) return jid;
  try {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
    if (pn) return String(pn);
  } catch {}
  return jid;
}

// Commande d'administration : true si la commande a été traitée (autorisée ou refusée).
// Les commandes owner-only silencieuses (tout sauf ?quiz) n'envoient rien à un non-owner,
// pour ne pas révéler leur existence dans une discussion de groupe.
async function guardOwner(senderId, msg, sock, chatId, { announceQuiz = false } = {}) {
  if (await isOwner(senderId, msg, sock)) return true;
  if (announceQuiz) await send(sock, chatId, "chien vert😹");
  return false;
}

// Résout la cible d'un @mention WhatsApp : d'abord via le contextInfo natif,
// sinon via un numéro écrit en toutes lettres après le « @ » dans le texte.
function resolveMentionTarget(raw, msg) {
  const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (Array.isArray(mentioned) && mentioned.length) return mentioned[0];
  const m = String(raw ?? "").match(/@(\d{5,15})/);
  if (m) return `${m[1]}@s.whatsapp.net`;
  return null;
}

function playerKey(senderId) {
  return String(senderId || "unknown");
}

function ensureScore(chatId, senderId, name) {
  if (!scores[chatId]) scores[chatId] = {};
  if (!scores[chatId][playerKey(senderId)]) {
    scores[chatId][playerKey(senderId)] = {
      nom: name || "Joueur",
      points: 0,
      correct: 0,
      attempts: 0,
      quizzes: 0
    };
  }
  const p = scores[chatId][playerKey(senderId)];
  p.nom = name || p.nom;
  return p;
}

function scoreText(chatId, final = false) {
  const rows = Object.entries(scores[chatId] || {})
    .filter(([_, p]) => (p.points || 0) > 0)
    .sort((a, b) => (b[1].points - a[1].points) || (b[1].correct - a[1].correct));

  if (!rows.length) return "";

  const medals = ["🥇", "🥈", "🥉"];
  const title = final ? "*Classement final*" : "*Tableau des scores*";
  return title + "\n\n" + rows.map(([_, p], i) =>
    `${final && i < 3 ? medals[i] : `${i + 1}.`} ${p.nom} — ${p.points} pt(s) — ${p.correct} bonne(s) réponse(s)`
  ).join("\n");
}

function statsText(chatId) {
  const rows = Object.values(scores[chatId] || {});
  if (!rows.length) return "Aucune statistique pour le moment.";

  const points = rows.reduce((s, p) => s + (p.points || 0), 0);
  const correct = rows.reduce((s, p) => s + (p.correct || 0), 0);
  const attempts = rows.reduce((s, p) => s + (p.attempts || 0), 0);
  const quizzes = rows.reduce((s, p) => s + (p.quizzes || 0), 0);

  return `*Statistiques*\n\nJoueurs : ${rows.length}\nPoints distribués : ${points}\nBonnes réponses : ${correct}\nRéponses reçues : ${attempts}\nQuiz lancés : ${quizzes}`;
}

function formatQuestion(q, number, total) {
  const counter = total ? `*${number}/${total}*` : `*${number}*`;
  return `${counter}\n\n*${q.q}*`;
}

// ============================================================
// VALIDATION DES RÉPONSES — tolérante, mais pas permissive
// ============================================================
// La réponse attendue est toujours lue dans le champ `a` de la question
// (base questions.json ou custom_questions.json). Aucune réponse codée en dur.
//
// Formats de variantes reconnus dans `a` :
//   "Constantinople / Istanbul"  ·  "A | B"  ·  "A ; B"  ·  "A ou B"  ·  retour à la ligne
//   "Istanbul (ou Constantinople)"   (parenthèse introduite par ou/aussi/alias/dit)
//   ["Constantinople", "Istanbul"]   (tableau)
//   champs facultatifs `alts` / `alt` / `aliases` (chaîne ou tableau)
// Les autres parenthèses sont considérées comme des précisions et ignorées :
//   "Paris (France)" est comparé à "Paris".
//
// Tolérances : majuscules, accents, ponctuation non significative, espaces,
// articles initiaux facultatifs, formulations introductives, chiffres romains,
// saint/st, œ/oe et « et » / « & ». Les fautes d'orthographe sont refusées.
//
// Nom court (« Van Eyck » pour « Jan van Eyck ») : seule la FIN du nom est
// acceptée, jamais le début (« Jan » est refusé), et uniquement si cette
// forme courte n'apparaît dans aucune autre réponse de la base (aucune
// ambiguïté) et n'est pas un mot générique (guerre, mont, roi…).
// Pas de nom court non plus pour :
//  - une réponse qui n'est pas un nom propre (mots significatifs sans majuscule) ;
//  - une réponse commençant par un article (« Le Costa Rica » n'accepte pas « Rica ») ;
//  - un titre/une expression contenant « et », « au », « des »… (« Guerre et Paix »).
// Pour autoriser une forme courte ambiguë, ajoute-la comme variante dans
// la question : "Bataille d'Austerlitz / Austerlitz".

// Passe à false si « ou » ne doit PAS séparer des variantes.
const ANSWER_SPLIT_ON_OU = true;

// Noms courts (« Van Eyck » pour « Jan van Eyck »). Mets false pour les désactiver partout.
// Par question, tu peux aussi les interdire avec  "strict": true  dans la base.
const ANSWER_ALLOW_SHORT_FORMS = true;

const ANSWER_FUNCTION_WORDS = new Set([
  "le", "la", "les", "l", "un", "une", "des", "du", "de", "d", "au", "aux",
  "et", "the", "of", "and",
  "van", "von", "der", "den", "da", "di", "del", "della"
]);

const ANSWER_OPTIONAL_LEADING_WORDS = new Set([
  "le", "la", "les", "l", "un", "une", "des", "du", "au", "aux", "the", "a", "an"
]);

const ANSWER_ABBREVIATIONS = { st: "saint", ste: "sainte" };

// Une réponse contenant l'un de ces mots (hors 1er mot) est un titre/une expression
// (« Guerre et Paix », « Le Rouge et le Noir ») : aucun nom court n'en est déduit.
const ANSWER_TITLE_CONNECTORS = new Set(["et", "and", "of", "the", "au", "aux", "des", "un", "une"]);

// Le nom court (« Van Eyck » pour « Jan van Eyck ») est réservé aux noms de PERSONNES.
// Une réponse contenant l'un de ces mots est un lieu, un événement, un texte de loi, une
// œuvre… et n'en génère aucun (« Bataille de Waterloo » n'accepte pas « Waterloo » seul,
// « Traité de Tilsit » n'accepte pas « Tilsit » seul). Passe à false pour l'étendre à tout
// nom propre, ou ajoute la forme courte comme variante sur une question précise.
const ANSWER_SHORT_FORMS_PERSONS_ONLY = true;
const NON_PERSON_ANSWER_MARKERS = new Set([
  "bataille", "siege", "guerre", "conflit", "conquete", "offensive", "operation",
  "operations", "campagne", "expedition", "revolte", "insurrection", "massacre",
  "traite", "traites", "convention", "accord", "accords", "pacte", "charte",
  "declaration", "constitution", "loi", "reglement", "decret", "edit", "groupe",
  "theorie", "experience", "paradoxe", "relation", "principe", "equation",
  "formule", "regle", "hypothese",
  "paix", "revolution", "parti", "party",
  "chateau", "palais", "cathedrale", "eglise", "basilique", "temple", "musee",
  "tour", "pont", "fort", "forteresse", "stade", "gare", "monument", "piton",
  "mont", "monts", "cap", "golfe", "lac", "mer", "ocean", "fleuve", "riviere",
  "rio", "ile", "iles", "vallee", "desert", "plaine", "presqu", "col", "alpe",
  "alpes", "ville", "rue", "street", "avenue", "boulevard",
  "royaume", "empire", "republique", "comte", "duche", "principaute",
  "dynastie", "califat", "province", "region", "district", "etat", "etats",
  "rallye", "coupe", "trophee", "championnat", "tournoi", "festival", "prix",
  "jeux", "cup", "grand", "finale", "altesse",
  "mission", "projet", "programme", "plan"
]);

// Réponse « nom de personne » : que des mots propres, et aucun marqueur de lieu/
// événement/texte/œuvre parmi les mots significatifs.
function looksLikePersonName(text) {
  if (!looksLikeProperName(text)) return false;
  const toks = rawAnswerTokens(text);
  return !toks.some(t => NON_PERSON_ANSWER_MARKERS.has(t));
}

// Débuts de phrase ignorés (jamais de négation : « ce n'est pas X » reste refusé).
const ANSWER_LEAD_IN_WORDS = new Set([
  "c", "ce", "cest", "est", "etait", "sera", "serait", "sont",
  "je", "pense", "crois", "dirais", "dirai", "suppose", "que", "qu",
  "il", "s", "agit", "ca", "doit", "etre", "peut", "surement", "probablement",
  "euh", "heu", "hm", "hmm", "ah", "alors", "donc", "en"
]);

// Mots trop génériques pour identifier une réponse à eux seuls.
const GENERIC_ANSWER_TOKENS = new Set([
  "guerre", "bataille", "traite", "revolution", "empire", "royaume", "republique",
  "dynastie", "siecle", "mont", "mer", "ocean", "lac", "fleuve", "riviere", "ile",
  "iles", "ville", "pays", "rue", "place", "tour", "palais", "chateau", "cathedrale",
  "eglise", "musee", "parc", "gare", "pont", "roi", "reine", "empereur", "prince",
  "princesse", "duc", "comte", "saint", "sainte", "pape", "president", "general",
  "docteur", "professeur", "monde", "mondiale", "national", "nationale", "francais",
  "francaise", "americain", "americaine", "europeen", "europeenne", "grand", "grande",
  "petit", "petite", "nouveau", "nouvelle", "premier", "premiere", "second", "seconde",
  "vieux", "vieille", "haut", "haute", "bas", "basse", "nord", "sud", "est", "ouest",
  "centre", "union", "etat", "etats", "unis", "coupe", "championnat", "prix",
  "festival", "jeux", "war", "battle", "king", "queen", "lake", "river", "mount",
  "new", "old", "great", "city", "state", "united", "kingdom", "north", "south",
  "east", "west", "rouge", "noir", "blanc", "vert", "bleu", "jaune", "gris", "rose",
  "orange", "violet", "marron", "red", "black", "white", "green", "blue", "yellow"
]);

const ROMAN_RE = /^(?=[mdclxvi]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

function romanToInt(s) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]];
    const next = map[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

// Texte → mots normalisés (minuscules, sans accents, sans ponctuation).
function rawAnswerTokens(text) {
  const prepared = String(text ?? "")
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .replace(/ß/g, "ss")
    .replace(/&/g, " et ")
    // « XIXe », « XXème » (chiffre romain en majuscules + suffixe) → « 19 », « 20 »
    // (au moins 2 lettres, ou I/V/X seul : « Le », « De », « Ce » ne sont pas des chiffres romains)
    .replace(/(?<![\p{L}\p{N}])([MDCLXVI]{2,7}|[IVX])(?:er|ère|ere|ème|eme|e)(?![\p{L}\p{N}])/gu, (m, r) => {
      const low = r.toLowerCase();
      return ROMAN_RE.test(low) ? ` ${romanToInt(low)} ` : m;
    });
  return normalize(prepared).split(" ").filter(Boolean);
}

// Mots normalisés → forme canonique de comparaison.
function finishAnswerTokens(tokens) {
  let toks = tokens.map(t => ANSWER_ABBREVIATIONS[t] || t);

  if (toks.length > 1 && ANSWER_OPTIONAL_LEADING_WORDS.has(toks[0])) toks.shift();

  toks = toks.map((t, i) => {
    if (t === "ier") return i > 0 ? "1" : t;
    const ord = t.match(/^(\d+)(?:er|re|e|eme|ieme|nd|nde)$/);
    if (ord) return ord[1];
    if (ROMAN_RE.test(t) && (i > 0 || t.length >= 2)) return String(romanToInt(t));
    return t;
  });

  // « 1 000 000 » → « 1000000 »
  const out = [];
  let open = false;
  for (const t of toks) {
    if (open && /^\d{3}$/.test(t)) {
      out[out.length - 1] += t;
      continue;
    }
    out.push(t);
    open = /^\d{1,3}$/.test(t);
  }
  return out;
}

// Réponse attendue (chaîne) → liste de variantes acceptables (chaînes).
function splitAnswerVariants(raw, depth = 0) {
  const text = String(raw ?? "").trim();
  if (!text) return [];

  const stripParens = s => s.replace(/[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\s+/g, " ").trim();
  const sep = ANSWER_SPLIT_ON_OU
    ? /\s*[|;\n]\s*|\s+\/\s+|\s+ou\s+/i
    : /\s*[|;\n]\s*|\s+\/\s+/;

  const out = [];
  const pieces = text.split(sep).map(x => x.trim()).filter(Boolean);

  for (const piece of pieces) {
    // « Constantinople/Istanbul » sans espaces : on sépare seulement si chaque côté est un vrai mot.
    let subs = [piece];
    if (piece.includes("/")) {
      const slashParts = piece.split("/").map(x => x.trim());
      if (slashParts.length > 1 && slashParts.every(x => (x.match(/\p{L}/gu) || []).length >= 3)) {
        subs = slashParts;
      }
    }

    for (const p of subs) {
      const base = stripParens(p);
      out.push({ text: base || p.replace(/[\(\)\[\]]/g, " ").replace(/\s+/g, " ").trim(), exact: false });

      if (depth < 1) {
        const re = /[\(\[]\s*(?:ou|aussi|alias|dit|dite|également|egalement|a\.?k\.?a\.?)\s+([^\)\]]+)[\)\]]/gi;
        for (const m of p.matchAll(re)) out.push(...splitAnswerVariants(m[1], depth + 1));
      }
    }
  }

  // On garde aussi la réponse telle qu'elle est écrite dans la base (parenthèses, « / », « ou »
  // compris), au cas où le joueur la retape en entier. Cette forme n'est comparée qu'à l'identique :
  // elle ne sert jamais à déduire un nom court.
  if (depth === 0 && (out.length > 1 || /[\(\[]/.test(text))) {
    out.push({ text, exact: true });
  }

  return out.filter(v => v.text);
}

// Question (ou simple chaîne/tableau) → toutes les variantes acceptables.
function answerVariantsOf(spec) {
  const list = [];
  const add = v => {
    if (Array.isArray(v)) v.forEach(add);
    else if (v !== null && v !== undefined && typeof v !== "object") list.push(...splitAnswerVariants(String(v)));
  };
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    add(spec.a);
    add(spec.alts);
    add(spec.alt);
    add(spec.aliases);
  } else {
    add(spec);
  }
  return list;
}

// Réponse « nom propre » : tous les mots significatifs commencent par une majuscule
// (Gustave Flaubert, Mont Blanc, Bataille d'Austerlitz). Une phrase ou un nom commun
// (« Le roman épistolaire », « Il se cache sous les moutons ») n'en est pas un.
function looksLikeProperName(text) {
  const words = String(text ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let significant = 0;
  for (const w of words) {
    const toks = rawAnswerTokens(w);
    if (toks.length !== 1) continue;
    if (ANSWER_FUNCTION_WORDS.has(toks[0]) || /^\d/.test(w)) continue;
    significant++;
    if (w[0] === w[0].toLowerCase()) return false;
  }
  return significant > 0;
}

function answerTokenForms(spec) {
  const forms = [];
  const seen = new Set();
  for (const { text: v, exact } of answerVariantsOf(spec)) {
    const raw = rawAnswerTokens(v);
    const T = finishAnswerTokens(raw);
    if (!T.length) continue;
    T.symbolSignature = answerSymbolSignature(v);
    T.exact = exact;
    T.title = raw.slice(1).some(t => ANSWER_TITLE_CONNECTORS.has(t));
    T.proper = looksLikeProperName(v);
    // Un nom précédé d'un article (« Le Costa Rica », « Les 24 Heures du Mans ») est un lieu,
    // un titre ou une chose : l'article fait partie du nom, on n'en déduit pas de nom court.
    T.articleLed = /^\s*(?:l['’]|(?:le|la|les|un|une)\s)/i.test(v);
    T.person = ANSWER_SHORT_FORMS_PERSONS_ONLY ? looksLikePersonName(v) : T.proper;
    T.noShort = exact || T.title || T.articleLed || !T.person;
    const k = T.join(" ");
    if (seen.has(k)) continue;
    seen.add(k);
    forms.push(T);
  }
  return forms;
}

function answerEntityKey(forms) {
  return forms.map(T => T.join(" ")).sort().join("|");
}

// Index des réponses : sert à vérifier qu'une forme courte de nom reste non ambiguë.
let answerIndexCache = null;

function invalidateAnswerIndex() {
  answerIndexCache = null;
}

function getAnswerIndex() {
  if (answerIndexCache) return answerIndexCache;

  const ngrams = new Map(); // "van eyck" -> Set(clés de réponses qui le contiennent)
  const lowerCount = new Map(); // mot -> nb d'apparitions en minuscules dans les textes
  const upperCount = new Map(); // mot -> nb d'apparitions avec majuscule (hors début de question)

  const countCase = (text, skipFirst) => {
    const words = String(text ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    words.forEach((w, i) => {
      if (skipFirst && i === 0) return;
      if (!/^\p{L}/u.test(w)) return;
      const toks = rawAnswerTokens(w);
      if (toks.length !== 1) return;
      const isLower = w[0] === w[0].toLowerCase() && w[0] !== w[0].toUpperCase();
      const map = isLower ? lowerCount : upperCount;
      map.set(toks[0], (map.get(toks[0]) || 0) + 1);
    });
  };

  for (const q of allQuestions()) {
    if (q && typeof q === "object") countCase(q.q, true);
    for (const v of answerVariantsOf(q)) if (!v.exact) countCase(v.text, false);

    const forms = answerTokenForms(q);
    if (!forms.length) continue;
    const key = answerEntityKey(forms);

    for (const T of forms) {
      if (T.exact || T.length > 8) continue;
      for (let i = 0; i < T.length; i++) {
        for (let j = i; j < T.length; j++) {
          const gram = T.slice(i, j + 1).join(" ");
          let owners = ngrams.get(gram);
          if (!owners) { owners = new Set(); ngrams.set(gram, owners); }
          owners.add(key);
        }
      }
    }
  }

  // Mot « commun » : apparaît régulièrement en minuscules (couleur, métier, nom commun…).
  // Un nom propre (Eyck, Hugo, Gaulle) n'apparaît quasiment jamais en minuscules.
  const common = new Set();
  for (const [w, lower] of lowerCount) {
    const upper = upperCount.get(w) || 0;
    if (lower >= 2 && lower >= 0.15 * (lower + upper)) common.add(w);
  }

  answerIndexCache = { ngrams, common };
  return answerIndexCache;
}

function answerSymbolSignature(text) {
  return Array.from(String(text ?? "").normalize("NFKC").toLowerCase())
    .filter(char => char === "@" || /\p{S}/u.test(char))
    .join("");
}

function answerTokensMatch(P, C) {
  if (!P.length || P.length !== C.length) return false;
  if ((P.symbolSignature || C.symbolSignature) && P.symbolSignature !== C.symbolSignature) return false;
  return P.every((token, index) => token === C[index]);
}

// Une forme courte (fin du nom) n'est acceptée que si elle est identifiante et sans ambiguïté.
function isSafeShortForm(S, ownKey, index) {
  if (!S.length) return false;
  if (!S.some(t => !/\d/.test(t) && t.length >= 3)) return false;
  if (S.join("").length < 4) return false;
  if (S.every(t => GENERIC_ANSWER_TOKENS.has(t) || index.common.has(t) || t.length < 3 || /^\d+$/.test(t))) return false;

  const owners = index.ngrams.get(S.join(" "));
  if (owners) {
    for (const k of owners) if (k !== ownKey) return false;
  }
  return true;
}

// Réponse du joueur → formes à tester (telle quelle, et sans « c'est… » en début).
function playerAnswerForms(raw) {
  const rawTokens = rawAnswerTokens(raw);
  if (!rawTokens.length || rawTokens.length > 40) return [];

  const forms = [];
  const base = finishAnswerTokens(rawTokens);
  base.symbolSignature = answerSymbolSignature(raw);
  if (base.length) forms.push(base);

  let k = 0;
  while (k < rawTokens.length && ANSWER_LEAD_IN_WORDS.has(rawTokens[k])) k++;
  if (k > 0 && k < rawTokens.length) {
    const rest = finishAnswerTokens(rawTokens.slice(k));
    rest.symbolSignature = answerSymbolSignature(raw);
    if (rest.length && rest.join(" ") !== base.join(" ")) forms.push(rest);
  }
  return forms;
}

// `expected` : la question complète (recommandé : lit `a` + variantes) ou une simple chaîne.
function answerIsCorrect(answer, expected) {
  const rawAnswer = String(answer ?? "");
  if (!rawAnswer.trim() || rawAnswer.length > 400) return false;

  const spec = (expected && typeof expected === "object" && !Array.isArray(expected))
    ? expected
    : { a: expected };

  const expectedForms = answerTokenForms(spec);

  // Une variante composée uniquement de symboles reste comparable même si d'autres alias
  // de la même réponse contiennent des mots.
  const normalizeSymbolOnly = text => String(text ?? "")
    .normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const symbolOnlyVariants = answerVariantsOf(spec).filter(v => !rawAnswerTokens(v.text).length);
  if (symbolOnlyVariants.some(v => normalizeSymbolOnly(v.text) === normalizeSymbolOnly(rawAnswer))) {
    return true;
  }
  if (!expectedForms.length) return false;

  const playerForms = playerAnswerForms(rawAnswer);
  if (!playerForms.length) return false;

  const index = getAnswerIndex();
  const ownKey = answerEntityKey(expectedForms);

  // 1) Réponse complète (ou l'une des variantes déclarées).
  for (const P of playerForms) {
    for (const C of expectedForms) {
      if (answerTokensMatch(P, C)) return true;
    }
  }

  // 2) Nom court : fin du nom uniquement, identifiante et non ambiguë.
  if (!ANSWER_ALLOW_SHORT_FORMS || spec.strict === true) return false;
  for (const C of expectedForms) {
    if (C.noShort || C.length < 2 || C.length > 5) continue;
    for (let i = 1; i < C.length; i++) {
      const S = C.slice(i);
      if (!isSafeShortForm(S, ownKey, index)) continue;
      for (const P of playerForms) {
        if (answerTokensMatch(P, S)) return true;
      }
    }
  }

  return false;
}

// Texte affiché quand personne ne trouve (gère aussi une réponse en tableau).
function displayAnswer(q) {
  const a = q?.a;
  return Array.isArray(a) ? a.join(" / ") : String(a ?? "");
}

const active = {};
const sessions = {};

function isDisabled(chatId) {
  return persistentState.disabledChats[chatId] === true;
}

function helpText(owner = false) {
  const lines = [
    "*Commandes*",
    "",
    "*Quiz*",
    "?quiz → 25 questions",
    "?quiz 50 → 50 questions",
    "?quiz <thème> → quiz sur un thème",
    "?quiz30 → 30 questions",
    "?themes → thèmes disponibles",
    "",
    "*Score*",
    "?score → classement (alias ?points)",
    "",
    "*Divers*",
    "?ping → test du bot",
    "?version → version du bot",
    "?temps → voir le temps",
    "?statut → état du quiz",
    "?question → renvoyer la question actuelle"
  ];

  if (owner) {
    lines.push(
      "",
      "*Administration*",
      "?pause → mettre le quiz en pause",
      "?reprendre → reprendre le quiz (alias ?continue)",
      "?next → passer à la question suivante",
      "?addpoint <nombre> @personne → ajouter/retirer des points",
      "?on / ?off → activer/désactiver le bot dans la discussion",
      "?add Thème | Question | Réponse | Explication",
      "?histoireadd|Question|Réponse|Explication → ajouter au thème",
      "?supprimer <ID>",
      "?modifier <ID> | Question | Réponse | Explication",
      "?stats → statistiques",
      "?statsbot → statistiques de la base de questions",
      "?stop → arrêter le quiz (alias ?annuler)"
    );
  }

  return lines.join("\n");
}

async function send(sock, chatId, text) {
  try { await sock.sendMessage(chatId, { text }); }
  catch (e) { console.log("⚠️ Envoi impossible:", e.message); }
}

function clearQuestionTimers(chatId, quiz) {
  if (!quiz) return;
  if (quiz.timeoutId) clearTimeout(quiz.timeoutId);
  if (quiz.autoTimeoutId) clearTimeout(quiz.autoTimeoutId);
  quiz.timeoutId = null;
  quiz.autoTimeoutId = null;
  const s = sessions[chatId];
  if (s) s.timeoutId = null;
}

function scheduleNext(chatId, sock, delay = NEXT_DELAY_MS) {
  const s = sessions[chatId];
  if (!s?.running || s.paused) return;
  if (s.advanceTimeoutId) clearTimeout(s.advanceTimeoutId);
  s.advanceTimeoutId = setTimeout(() => {
    s.advanceTimeoutId = null;
    if (sessions[chatId] === s && s.running && !s.paused && !active[chatId]) {
      askNext(chatId, sock).catch(e => console.log("⚠️ Question suivante impossible:", e.message));
    }
  }, delay);
}

function startQuestionTimers(chatId, sock, s, quiz) {
  if (sessions[chatId] !== s || active[chatId] !== quiz || s.paused || quiz.resolved) return;
  const duration = Math.max(0, quiz.remainingMs ?? DEFAULT_TIMER * 1000);
  quiz.remainingMs = null;
  quiz.startedAt = Date.now();
  quiz.timeoutId = setTimeout(async () => {
    if (sessions[chatId] !== s || active[chatId] !== quiz || quiz.resolved || s.paused) return;
    quiz.resolved = true;
    clearQuestionTimers(chatId, quiz);
    delete active[chatId];
    await send(sock, chatId, `Réponse : *${displayAnswer(quiz.question)}*`);
    scheduleNext(chatId, sock);
  }, duration);
  s.timeoutId = quiz.timeoutId;

  // Auto-answer is retained as a hidden owner setting, but pause cancels its timer.
  if (s.auto && Math.random() * 100 < s.autoChance) {
    const delay = 3500 + Math.floor(Math.random() * 5000);
    quiz.autoTimeoutId = setTimeout(async () => {
      if (sessions[chatId] !== s || active[chatId] !== quiz || quiz.resolved || s.paused) return;
      quiz.resolved = true;
      clearQuestionTimers(chatId, quiz);
      delete active[chatId];
      await send(sock, chatId, `*${displayAnswer(quiz.question)}*`);
      scheduleNext(chatId, sock);
    }, Math.min(delay, Math.max(1000, duration - 800)));
  }
}

async function stopQuiz(chatId, sock, showScore = true, notify = true) {
  const s = sessions[chatId];
  if (s?.advanceTimeoutId) clearTimeout(s.advanceTimeoutId);
  clearQuestionTimers(chatId, active[chatId]);
  if (active[chatId]) active[chatId].resolved = true;
  delete active[chatId];

  if (s?.running) {
    s.running = false;
    saveScores();
    if (notify) await send(sock, chatId, "Quiz arrêté.");
    if (notify && showScore) {
      const board = scoreText(chatId, true);
      if (board) await send(sock, chatId, board);
    }
  }
  delete sessions[chatId];
}

async function askNext(chatId, sock) {
  const s = sessions[chatId];
  if (!s || !s.running || s.paused) return;
  if (s.advancing) {
    s.advanceRequested = true;
    return;
  }
  if (active[chatId]) return;

  if (s.advanceTimeoutId) {
    clearTimeout(s.advanceTimeoutId);
    s.advanceTimeoutId = null;
  }
  s.advancing = true;
  try {
    if (s.count >= s.total) {
      s.running = false;
      await send(sock, chatId, "Quiz terminé.");
      const finalBoard = scoreText(chatId, true);
      if (finalBoard) await send(sock, chatId, finalBoard);
      if (sessions[chatId] === s) delete sessions[chatId];
      return;
    }

    const q = takeQuestion(chatId, s.theme);
    if (!q) {
      s.running = false;
      await send(sock, chatId, "Aucune question disponible.");
      if (sessions[chatId] === s) delete sessions[chatId];
      return;
    }

    s.count += 1;
    const quiz = {
      question: q,
      resolved: false,
      number: s.count,
      total: s.total,
      timer: DEFAULT_TIMER,
      timeoutId: null,
      autoTimeoutId: null,
      remainingMs: DEFAULT_TIMER * 1000
    };
    active[chatId] = quiz;

    await send(sock, chatId, formatQuestion(q, s.count, s.total));

    if (sessions[chatId] === s && active[chatId] === quiz && s.running && !s.paused) {
      startQuestionTimers(chatId, sock, s, quiz);
    }
  } finally {
    s.advancing = false;
    if (s.advanceRequested) {
      s.advanceRequested = false;
      if (sessions[chatId] === s && s.running && !s.paused && !active[chatId]) {
        scheduleNext(chatId, sock, 0);
      }
    }
  }
}

function parseQuizArgs(raw) {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let total = DEFAULT_QUIZ_SIZE;
  let theme = null;

  if (parts[0] && /^\d+$/.test(parts[0])) {
    total = Math.max(1, Math.min(MAX_QUIZ_SIZE, Number(parts.shift())));
  }
  if (parts.length) theme = parts.join(" ");
  return { total, theme };
}

async function handleManagementCommand(text, chatId, senderId, msg, sock) {

  const add = text.match(/^\?add\s+([^|]+)\|\s*(.+?)\|\s*(.+?)(?:\|\s*(.*))?$/is);
  if (add) {
    const theme = canonicalTheme(add[1]);
    const q = add[2].trim();
    const a = add[3].trim();
    const e = (add[4] || "").trim();

    if (!q || !a) {
      await send(sock, chatId, "Format : ?add Thème | Question | Réponse | Explication");
      return true;
    }

    const dup = duplicateCheck(q, theme);
    if (dup) {
      await send(sock, chatId, dup.exact
        ? `Question déjà présente (ID ${dup.question.id}).`
        : `Question très proche d'une question existante (ID ${dup.question.id}).`);
      return true;
    }

    const item = {
      id: makeQuestionId(),
      t: theme,
      q,
      a,
      e,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    customQuestions.push(item);
    invalidateAnswerIndex();
    saveCustom();
    await send(sock, chatId, `Question ajoutée. ID : ${item.id}`);
    return true;
  }

  const addTheme = text.match(/^\?([^\s:|]+?)add\s*(?::|\|)\s*(.+)$/is);
  if (addTheme) {
    const theme = canonicalTheme(addTheme[1].replace(/_/g, " "));
    const parts = addTheme[2].split("|").map(x => x.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      await send(sock, chatId, "Format : ?histoireadd|Question|Réponse|Explication");
      return true;
    }

    const dup = duplicateCheck(parts[0], theme);
    if (dup) {
      await send(sock, chatId, dup.exact
        ? `Question déjà présente (ID ${dup.question.id}).`
        : `Question très proche d'une question existante (ID ${dup.question.id}).`);
      return true;
    }

    const item = {
      id: makeQuestionId(),
      t: theme,
      q: parts[0],
      a: parts[1],
      e: parts[2] || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    customQuestions.push(item);
    invalidateAnswerIndex();
    saveCustom();
    await send(sock, chatId, `Question ajoutée. ID : ${item.id}`);
    return true;
  }

  const del = text.match(/^\?supprimer\s+(\S+)$/i);
  if (del) {
    const id = del[1];
    const before = customQuestions.length;
    customQuestions = customQuestions.filter(q => String(q.id) !== id);
    invalidateAnswerIndex();
    if (customQuestions.length === before) {
      await send(sock, chatId, "ID introuvable.");
    } else {
      saveCustom();
      for (const key of Object.keys(persistentState.decks)) delete persistentState.decks[key];
      saveState();
      await send(sock, chatId, `Question ${id} supprimée.`);
    }
    return true;
  }

  const edit = text.match(/^\?modifier\s+(\S+)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\|\s*(.*))?$/is);
  if (edit) {
    const id = edit[1];
    const item = customQuestions.find(q => String(q.id) === id);
    if (!item) {
      await send(sock, chatId, "ID introuvable ou question de base non modifiable.");
      return true;
    }

    const newQ = edit[2].trim();
    const newA = edit[3].trim();
    const newE = (edit[4] || "").trim();

    const dup = duplicateCheck(newQ, item.t);
    if (dup && String(dup.question.id) !== id) {
      await send(sock, chatId, `Modification refusée : question trop proche de l'ID ${dup.question.id}.`);
      return true;
    }

    item.q = newQ;
    item.a = newA;
    item.e = newE;
    item.updatedAt = new Date().toISOString();
    invalidateAnswerIndex();
    saveCustom();
    for (const key of Object.keys(persistentState.decks)) delete persistentState.decks[key];
    saveState();
    await send(sock, chatId, `Question ${id} modifiée.`);
    return true;
  }

  if (text.toLowerCase() === "?statsbot") {
    await send(sock, chatId,
      `*Bot*\n\nQuestions de base : ${baseQuestionsRaw.length}\nQuestions ajoutées : ${customQuestions.length}\nQuestions totales : ${allQuestions().length}`
    );
    return true;
  }

  const addPoint = text.match(/^\?addpoint\s+(-?\d+)\s+(\S.*)$/i);
  if (addPoint) {
    const delta = Number(addPoint[1]);
    const mentionedTarget = resolveMentionTarget(addPoint[2], msg);
    if (!mentionedTarget) {
      await send(sock, chatId, "Mentionne la personne : ?addpoint 10 @personne");
      return true;
    }
    const target = await resolvePlayerJid(mentionedTarget, sock);
    const existing = (scores[chatId] || {})[playerKey(target)];
    const p = ensureScore(chatId, target, existing?.nom);
    p.points = (p.points || 0) + delta;
    saveScores();
    await send(sock, chatId, `${delta >= 0 ? "+" : ""}${delta} point(s) pour ${p.nom}. Total : ${p.points} pt(s).`);
    return true;
  }

  return false;
}

async function handleMessage(msg, sock) {
  if (!msg?.message) return;

  const chatId = msg.key.remoteJid;
  if (!chatId) return;

  const senderId = msg.key.participant || msg.key.remoteJid;
  const senderName = msg.pushName || "Joueur";

  const textMessage =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    "";

  const raw = textMessage.trim();
  const lower = raw.toLowerCase();

  // Commands sent by the bot account itself are accepted only for management,
  // while normal quiz messages fromMe are ignored to avoid loops.
  if (msg.key.fromMe) {
    if (!raw.startsWith("?")) return;
  }

  if (lower === "?off") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    await stopQuiz(chatId, sock, false, false);
    persistentState.disabledChats[chatId] = true;
    saveState();
    await send(sock, chatId, "ok");
    return;
  }

  if (lower === "?on") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    delete persistentState.disabledChats[chatId];
    saveState();
    await send(sock, chatId, "ok");
    return;
  }

  if (isDisabled(chatId)) return;

  if (lower === "?aide" || lower === "?help") {
    await send(sock, chatId, helpText(await isOwner(senderId, msg, sock)));
    return;
  }

  if (lower === "?thème" || lower === "?theme" || lower === "?thèmes" || lower === "?themes") {
    const themes = [...new Set(allQuestions().map(q => q.t).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    await send(sock, chatId, "*Thèmes disponibles*\n\n" + themes.map(t => `• ${t}`).join("\n"));
    return;
  }

  if (lower === "?ping") { await send(sock, chatId, "Pong"); return; }
  if (lower === "?version") { await send(sock, chatId, "WhatsApp Quiz Bot V3.2"); return; }

  if (lower === "?temps") {
    const s = sessions[chatId];
    await send(sock, chatId, s ? `Temps : ${s.timer} secondes` : `Temps : ${DEFAULT_TIMER} secondes`);
    return;
  }

  if (lower === "?statut") {
    const s = sessions[chatId];
    if (!s) { await send(sock, chatId, "Aucun quiz en cours."); return; }
    await send(sock, chatId, `Quiz en cours\nQuestion : ${s.count}/${s.total}\nTemps : ${s.timer}s\nAuto : ${s.auto ? "ON" : "OFF"}`);
    return;
  }

  if (lower === "?question") {
    const q = active[chatId];
    if (!q || q.resolved) { await send(sock, chatId, "Aucune question en cours."); return; }
    await send(sock, chatId, formatQuestion(q.question, q.number, q.total));
    return;
  }

  if (lower === "?score" || lower === "?points") {
    await send(sock, chatId, scoreText(chatId));
    return;
  }

  if (lower === "?stats") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    await send(sock, chatId, statsText(chatId));
    return;
  }

  if (lower === "?annuler" || lower === "?stop") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    await stopQuiz(chatId, sock, true);
    return;
  }

  if (lower === "?pause") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    const s = sessions[chatId];
    if (!s || !s.running) { await send(sock, chatId, "Aucun quiz en cours."); return; }
    if (s.paused) { await send(sock, chatId, "Le quiz est déjà en pause."); return; }
    const quiz = active[chatId];
    if (s.advanceTimeoutId) {
      clearTimeout(s.advanceTimeoutId);
      s.advanceTimeoutId = null;
    }
    if (quiz && !quiz.resolved) {
      const elapsed = quiz.startedAt ? Date.now() - quiz.startedAt : 0;
      quiz.remainingMs = Math.max(0, (quiz.remainingMs ?? DEFAULT_TIMER * 1000) - elapsed);
      clearQuestionTimers(chatId, quiz);
    }
    s.paused = true;
    await send(sock, chatId, "Quiz en pause.");
    return;
  }

  if (lower === "?reprendre" || lower === "?continue") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    const s = sessions[chatId];
    if (!s || !s.running) { await send(sock, chatId, "Aucun quiz en cours."); return; }
    if (!s.paused) { await send(sock, chatId, "Le quiz n'est pas en pause."); return; }
    s.paused = false;
    await send(sock, chatId, "Quiz repris.");
    const quiz = active[chatId];
    if (quiz && !quiz.resolved) {
      if (!s.advancing) startQuestionTimers(chatId, sock, s, quiz);
    } else {
      await askNext(chatId, sock);
    }
    return;
  }

  if (lower === "?addpoint" || lower.startsWith("?addpoint ")) {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    if (await handleManagementCommand(raw, chatId, senderId, msg, sock)) return;
    await send(sock, chatId, "Format : ?addpoint 10 @personne (ou -10 pour retirer)");
    return;
  }

  if (lower === "?next") {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    const s = sessions[chatId];
    if (!s || !s.running) { await send(sock, chatId, "Aucun quiz en cours."); return; }
    if (s.advanceTimeoutId) {
      clearTimeout(s.advanceTimeoutId);
      s.advanceTimeoutId = null;
    }
    const quiz = active[chatId];
    if (quiz) {
      clearQuestionTimers(chatId, quiz);
      quiz.resolved = true;
    }
    delete active[chatId];
    s.paused = false;
    if (s.advancing) {
      s.advanceRequested = true;
      return;
    }
    await askNext(chatId, sock);
    return;
  }

  // Hidden auto command.
  if (lower === "?auto" || lower.startsWith("?auto ")) {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    const s = sessions[chatId] || (sessions[chatId] = { running: false, timer: DEFAULT_TIMER, auto: false, autoChance: 70 });
    const arg = raw.slice(5).trim().toLowerCase();
    if (arg === "on") s.auto = true;
    else if (arg === "off") s.auto = false;
    else if (/^\d+$/.test(arg)) {
      s.auto = true;
      s.autoChance = Math.max(1, Math.min(100, Number(arg)));
    } else {
      s.auto = !s.auto;
    }
    await send(sock, chatId, `Auto : ${s.auto ? "ON" : "OFF"}${s.auto ? ` (${s.autoChance || 70}%)` : ""}`);
    return;
  }

  // Hidden timer command.
  const timerMatch = lower.match(/^\?timer(?::|\s+)?(\d+)$/);
  if (timerMatch) {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    await send(sock, chatId, `Temps fixe : ${DEFAULT_TIMER} secondes.`);
    return;
  }

  if (lower.startsWith("?add ") || lower.startsWith("?supprimer ") || lower.startsWith("?modifier ") || lower === "?statsbot" || /^\?[^\s:|]+add\s*(?::|\|)/.test(lower)) {
    if (!(await guardOwner(senderId, msg, sock, chatId))) return;
    if (await handleManagementCommand(raw, chatId, senderId, msg, sock)) return;
  }

  const quizMatch = lower.match(/^\?quiz(?:\s+(.+))?$/);
  const compact = lower.match(/^\?quiz(\d+)$/);
  if (quizMatch || compact) {
    if (!(await guardOwner(senderId, msg, sock, chatId, { announceQuiz: true }))) return;
    if (sessions[chatId]?.running) {
      await send(sock, chatId, "Un quiz est déjà en cours.");
      return;
    }

    const args = compact ? compact[1] : (quizMatch?.[1] || "");
    const parsed = parseQuizArgs(args);
    const selectedTheme = parsed.theme ? canonicalTheme(parsed.theme) : null;
    const pool = getQuestions(selectedTheme);
    if (!pool.length) {
      await send(sock, chatId, "Thème introuvable ou aucune question disponible. Vérifie le nom du thème.");
      return;
    }

    // Chaque nouveau match repart avec un classement propre.
    scores[chatId] = {};
    saveScores();

    const s = {
      running: true,
      total: parsed.total,
      count: 0,
      theme: selectedTheme,
      timer: DEFAULT_TIMER,
      timeoutId: null,
      auto: false,
      autoChance: 70,
      paused: false,
      advancing: false,
      advanceRequested: false,
      advanceTimeoutId: null
    };

    // Preserve the existing hidden auto-answer setting; the response timer stays fixed at 14s.
    const previous = sessions[chatId];
    if (previous) {
      s.auto = Boolean(previous.auto);
      s.autoChance = previous.autoChance || 70;
    }

    sessions[chatId] = s;

    await askNext(chatId, sock);
    return;
  }

  // Ignore bot's own ordinary text to prevent loops.
  if (msg.key.fromMe) return;

  // Answer handling.
  const quiz = active[chatId];
  if (!quiz || quiz.resolved || !raw || raw.startsWith("?")) return;
  if (sessions[chatId]?.paused) return;

  const correct = answerIsCorrect(raw, quiz.question);
  const canonicalSenderId = await resolvePlayerJid(senderId, sock);
  if (active[chatId] !== quiz || quiz.resolved || sessions[chatId]?.paused) return;
  const p = ensureScore(chatId, canonicalSenderId, senderName);
  p.attempts = (p.attempts || 0) + 1;
  saveScores();

  if (correct) {
    quiz.resolved = true;
    clearQuestionTimers(chatId, quiz);
    delete active[chatId];

    p.points += 10;
    p.correct += 1;
    p.nom = senderName;
    saveScores();

    await send(sock, chatId, "✅");
    scheduleNext(chatId, sock);
  }
}

let reconnectDelay = 3000;
let starting = false;

async function startBot() {
  if (starting) return;
  starting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    global.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    if (!state.creds.registered) {
      if (!PHONE_NUMBER) {
        console.log("❌ BOT_PHONE_NUMBER manquant.");
      } else {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(PHONE_NUMBER);
            console.log("\n====================================");
            console.log(`CODE WHATSAPP : ${code}`);
            console.log("WhatsApp > Appareils connectés > Connecter un appareil > Se connecter avec un numéro");
            console.log("====================================\n");
          } catch (e) {
            console.log("❌ Code de connexion:", e.message);
          }
        }, 3000);
      }
    }

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") {
        reconnectDelay = 3000;
        console.log("✅ Bot connecté à WhatsApp.");
      }

      if (connection === "close") {
        global.sock = null;
        const status = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = status !== DisconnectReason.loggedOut;
        console.log(`Connexion fermée. Code=${status ?? "?"} | Reconnexion=${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            starting = false;
            startBot().catch(console.error);
          }, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        } else {
          starting = false;
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        try {
          await handleMessage(msg, sock);
        } catch (e) {
          console.log("❌ Erreur message:", e?.stack || e);
        }
      }
    });

    starting = false;
  } catch (e) {
    starting = false;
    console.log("❌ Erreur démarrage:", e?.stack || e);
    setTimeout(() => startBot().catch(console.error), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

try {
  getAnswerIndex();
} catch (e) {
  console.log("⚠️ Index des réponses non préchauffé:", e.message);
}

console.log(`📚 ${baseQuestionsRaw.length} questions de base chargées.`);
console.log(`➕ ${customQuestions.length} questions personnalisées chargées.`);
startBot().catch(console.error);
