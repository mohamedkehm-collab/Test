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

const BASE_QUESTIONS_FILE = path.join(__dirname, "questions.json");
const CUSTOM_FILE = path.join(__dirname, "custom_questions.json");
const STATE_FILE = path.join(__dirname, "quiz_state.json");
const SCORES_FILE = path.join(__dirname, "scores.json");
const AUTH_FOLDER = path.join(__dirname, "auth_info");

const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || PHONE_NUMBER)
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ready") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.url === "/ready" && !global.sock ? "STARTING" : "OK");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("WhatsApp Quiz Bot V3.0 actif");
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

  let number = extractNumber(senderId);
  if (String(senderId).endsWith("@lid") && sock?.signalRepository?.lidMapping) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(senderId);
      if (pn) number = extractNumber(pn);
    } catch {}
  }
  return OWNER_NUMBERS.includes(number);
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

function scoreText(chatId) {
  const rows = Object.entries(scores[chatId] || {})
    .sort((a, b) => (b[1].points - a[1].points) || (b[1].correct - a[1].correct));

  if (!rows.length) return "Aucun score enregistré.";

  return "*Classement*\n\n" + rows.map(([_, p], i) =>
    `${i + 1}. ${p.nom} — ${p.points} pt(s) — ${p.correct} bonne(s) réponse(s)`
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

function levenshtein(a, b) {
  const prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = Math.min(
        cur[j] + 1,
        prev[j + 1] + 1,
        prev[j] + (a[i] === b[j] ? 0 : 1)
      );
    }
    for (let j = 0; j < cur.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function answerIsCorrect(answer, expected) {
  const a = normalize(answer);
  const e = normalize(expected);
  if (!a || !e) return false;
  if (a === e) return true;

  const words = e.split(" ").filter(Boolean);
  if (words.length > 1 && words.some(w => w.length >= 5 && a === w)) return true;

  const dist = levenshtein(a, e);
  if (e.length >= 10 && dist <= 2) return true;
  if (e.length >= 6 && dist <= 1) return true;

  return false;
}

const active = {};
const sessions = {};

function isDisabled(chatId) {
  return persistentState.disabledChats[chatId] === true;
}

function helpText() {
  return [
    "*Commandes*",
    "",
    "!quiz → 25 questions",
    "!quiz30 → 30 questions",
    "!quiz 50 → 50 questions",
    "!score → classement",
    "!stats → statistiques",
    "!stop → arrêter le quiz",
    "!ping → test du bot",
    "!version → version du bot",
    "!temps → voir le temps",
    "!statut → état du quiz",
    "!question → renvoyer la question actuelle",
    "!points → alias de !score",
    "!annuler → arrêter le quiz"
  ].join("\n");
}

async function send(sock, chatId, text) {
  try { await sock.sendMessage(chatId, { text }); }
  catch (e) { console.log("⚠️ Envoi impossible:", e.message); }
}

async function stopQuiz(chatId, sock, showScore = true) {
  const s = sessions[chatId];
  if (s?.timeoutId) clearTimeout(s.timeoutId);
  delete active[chatId];

  if (s?.running) {
    s.running = false;
    for (const id of Object.keys(scores[chatId] || {})) {
      scores[chatId][id].quizzes = scores[chatId][id].quizzes || 0;
    }
    saveScores();
    await send(sock, chatId, "Quiz arrêté.");
    if (showScore) await send(sock, chatId, scoreText(chatId));
  }
  delete sessions[chatId];
}

async function askNext(chatId, sock) {
  const s = sessions[chatId];
  if (!s || !s.running) return;

  if (s.count >= s.total) {
    s.running = false;
    delete active[chatId];
    await send(sock, chatId, "Quiz terminé.");
    await send(sock, chatId, scoreText(chatId));
    delete sessions[chatId];
    return;
  }

  const q = takeQuestion(chatId, s.theme);
  if (!q) {
    s.running = false;
    await send(sock, chatId, "Aucune question disponible.");
    delete sessions[chatId];
    return;
  }

  s.count += 1;
  active[chatId] = {
    question: q,
    resolved: false,
    number: s.count,
    total: s.total,
    timer: s.timer,
    timeoutId: null
  };

  await send(sock, chatId, formatQuestion(q, s.count, s.total));

  const timeoutId = setTimeout(async () => {
    const quiz = active[chatId];
    if (!quiz || quiz.resolved) return;

    quiz.resolved = true;
    delete active[chatId];

    await send(sock, chatId, `Réponse : *${q.a}*`);

    if (sessions[chatId]?.running) {
      setTimeout(() => askNext(chatId, sock), NEXT_DELAY_MS);
    }
  }, s.timer * 1000);

  active[chatId].timeoutId = timeoutId;
  s.timeoutId = timeoutId;

  // Auto-answer is deliberately hidden from help.
  if (s.auto && Math.random() * 100 < s.autoChance) {
    const delay = 3500 + Math.floor(Math.random() * 5000);
    setTimeout(async () => {
      const quiz = active[chatId];
      if (!quiz || quiz.resolved) return;
      quiz.resolved = true;
      clearTimeout(quiz.timeoutId);
      delete active[chatId];
      await send(sock, chatId, `*${q.a}*`);
      if (sessions[chatId]?.running) setTimeout(() => askNext(chatId, sock), NEXT_DELAY_MS);
    }, Math.min(delay, Math.max(1000, s.timer * 1000 - 800)));
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
  if (!(await isOwner(senderId, msg, sock))) {
    await send(sock, chatId, "Commande réservée à l'organisateur.");
    return true;
  }

  const add = text.match(/^!add\s+([^|]+)\|\s*(.+?)\|\s*(.+?)(?:\|\s*(.*))?$/is);
  if (add) {
    const theme = canonicalTheme(add[1]);
    const q = add[2].trim();
    const a = add[3].trim();
    const e = (add[4] || "").trim();

    if (!q || !a) {
      await send(sock, chatId, "Format : !add Thème | Question | Réponse | Explication");
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
    saveCustom();
    await send(sock, chatId, `Question ajoutée. ID : ${item.id}`);
    return true;
  }

  const addTheme = text.match(/^!([^\s:]+)add\s*:\s*(.+)$/is);
  if (addTheme) {
    const theme = canonicalTheme(addTheme[1].replace(/_/g, " "));
    const parts = addTheme[2].split("|").map(x => x.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      await send(sock, chatId, "Format : !histoireadd: Question | Réponse | Explication");
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
    saveCustom();
    await send(sock, chatId, `Question ajoutée. ID : ${item.id}`);
    return true;
  }

  const del = text.match(/^!supprimer\s+(\S+)$/i);
  if (del) {
    const id = del[1];
    const before = customQuestions.length;
    customQuestions = customQuestions.filter(q => String(q.id) !== id);
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

  const edit = text.match(/^!modifier\s+(\S+)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\|\s*(.*))?$/is);
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
    saveCustom();
    for (const key of Object.keys(persistentState.decks)) delete persistentState.decks[key];
    saveState();
    await send(sock, chatId, `Question ${id} modifiée.`);
    return true;
  }

  if (text.toLowerCase() === "!statsbot") {
    await send(sock, chatId,
      `*Bot*\n\nQuestions de base : ${baseQuestionsRaw.length}\nQuestions ajoutées : ${customQuestions.length}\nQuestions totales : ${allQuestions().length}`
    );
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
    if (!raw.startsWith("!")) return;
  }

  if (lower === "!aide" || lower === "!help") {
    await send(sock, chatId, helpText());
    return;
  }

  if (lower === "!ping") { await send(sock, chatId, "Pong"); return; }
  if (lower === "!version") { await send(sock, chatId, "WhatsApp Quiz Bot V3.0"); return; }

  if (lower === "!temps") {
    const s = sessions[chatId];
    await send(sock, chatId, s ? `Temps : ${s.timer} secondes` : `Temps : ${DEFAULT_TIMER} secondes`);
    return;
  }

  if (lower === "!statut") {
    const s = sessions[chatId];
    if (!s) { await send(sock, chatId, "Aucun quiz en cours."); return; }
    const q = active[chatId];
    await send(sock, chatId, `Quiz en cours\nQuestion : ${s.count}/${s.total}\nTemps : ${s.timer}s\nAuto : ${s.auto ? "ON" : "OFF"}`);
    return;
  }

  if (lower === "!question") {
    const q = active[chatId];
    if (!q || q.resolved) { await send(sock, chatId, "Aucune question en cours."); return; }
    await send(sock, chatId, formatQuestion(q.question, q.number, q.total));
    return;
  }

  if (lower === "!score" || lower === "!points") {
    await send(sock, chatId, scoreText(chatId));
    return;
  }

  if (lower === "!stats") {
    await send(sock, chatId, statsText(chatId));
    return;
  }

  if (lower === "!annuler" || lower === "!stop") {
    await stopQuiz(chatId, sock, true);
    return;
  }

  if (lower === "!!off") {
    if (!(await isOwner(senderId, msg, sock))) { await send(sock, chatId, "Commande réservée à l'organisateur."); return; }
    await stopQuiz(chatId, sock, false);
    persistentState.disabledChats[chatId] = true;
    saveState();
    await send(sock, chatId, "Bot désactivé dans cette discussion.");
    return;
  }

  if (lower === "!!on") {
    if (!(await isOwner(senderId, msg, sock))) { await send(sock, chatId, "Commande réservée à l'organisateur."); return; }
    delete persistentState.disabledChats[chatId];
    saveState();
    await send(sock, chatId, "Bot réactivé dans cette discussion.");
    return;
  }

  // Hidden auto command.
  if (lower === "!auto" || lower.startsWith("!auto ")) {
    if (!(await isOwner(senderId, msg, sock))) { await send(sock, chatId, "Commande réservée à l'organisateur."); return; }
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
  const timerMatch = lower.match(/^!timer(?::|\s+)?(\d+)$/);
  if (timerMatch) {
    if (!(await isOwner(senderId, msg, sock))) { await send(sock, chatId, "Commande réservée à l'organisateur."); return; }
    const sec = Math.max(5, Math.min(60, Number(timerMatch[1])));
    const s = sessions[chatId] || (sessions[chatId] = { running: false });
    s.timer = sec;
    await send(sock, chatId, `Temps réglé sur ${sec} secondes.`);
    return;
  }

  if (isDisabled(chatId)) return;

  if (lower.startsWith("!add ") || lower.startsWith("!supprimer ") || lower.startsWith("!modifier ") || lower === "!statsbot" || /^![^\s:]+add\s*:/.test(raw)) {
    if (await handleManagementCommand(raw, chatId, senderId, msg, sock)) return;
  }

  const quizMatch = lower.match(/^!quiz(?:\s+(.+))?$/) || lower.match(/^quiz(?:\s+(.+))?$/);
  const compact = lower.match(/^!quiz(\d+)$/);
  if (quizMatch || compact) {
    if (sessions[chatId]?.running) {
      await send(sock, chatId, "Un quiz est déjà en cours.");
      return;
    }

    const args = compact ? compact[1] : (quizMatch?.[1] || "");
    const parsed = parseQuizArgs(args);
    const pool = getQuestions(parsed.theme);
    if (!pool.length) {
      await send(sock, chatId, "Thème introuvable ou aucune question disponible. Vérifie le nom du thème.");
      return;
    }

    const s = {
      running: true,
      total: parsed.total,
      count: 0,
      theme: parsed.theme ? canonicalTheme(parsed.theme) : null,
      timer: DEFAULT_TIMER,
      timeoutId: null,
      auto: false,
      autoChance: 70
    };

    // Preserve hidden settings from a prior !auto/!timer in this chat.
    const previous = sessions[chatId];
    if (previous) {
      s.timer = previous.timer || DEFAULT_TIMER;
      s.auto = Boolean(previous.auto);
      s.autoChance = previous.autoChance || 70;
    }

    sessions[chatId] = s;

    // Count a quiz for players who already have a score entry.
    for (const id of Object.keys(scores[chatId] || {})) {
      scores[chatId][id].quizzes = (scores[chatId][id].quizzes || 0) + 1;
    }
    saveScores();

    await askNext(chatId, sock);
    return;
  }

  // Ignore bot's own ordinary text to prevent loops.
  if (msg.key.fromMe) return;

  // Answer handling.
  const quiz = active[chatId];
  if (!quiz || quiz.resolved || !raw || raw.startsWith("!")) return;

  const p = ensureScore(chatId, senderId, senderName);
  p.attempts = (p.attempts || 0) + 1;
  saveScores();

  if (answerIsCorrect(raw, quiz.question.a)) {
    quiz.resolved = true;
    clearTimeout(quiz.timeoutId);
    active[chatId] = null;

    p.points += 10;
    p.correct += 1;
    p.nom = senderName;
    saveScores();

    await send(sock, chatId, "✅");
    if (sessions[chatId]?.running) setTimeout(() => askNext(chatId, sock), NEXT_DELAY_MS);
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

console.log(`📚 ${baseQuestionsRaw.length} questions de base chargées.`);
console.log(`➕ ${customQuestions.length} questions personnalisées chargées.`);
startBot().catch(console.error);
