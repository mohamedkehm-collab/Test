/**
 * BOT WHATSAPP - QUIZ DE CULTURE GENERALE V2
 * ------------------------------------------
 * - Questions chargées depuis questions.json
 * - Aucun "owner" : toutes les commandes sont accessibles à tous
 * - 14 secondes par question
 * - Réponse libre, sans QCM
 * - Plusieurs essais possibles pendant la question
 * - Une seule bonne réponse déclenche le passage à la suivante
 * - Thèmes disponibles avec !themes
 * - Santé HTTP pour Render / UptimeRobot
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const P = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const sharp = require('sharp');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const AUTH_FOLDER = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.join(DATA_DIR, 'auth_info');

const PORT = Number(process.env.PORT || 10000);
const PHONE_NUMBER = String(process.env.BOT_PHONE_NUMBER || '')
  .replace(/\D/g, '');

const TEMPS_REPONSE_MS = 14_000;
const TIMER_MIN_SECONDES = 5;
const TIMER_MAX_SECONDES = 60;
const AUTO_REPONSE_PAR_DEFAUT = false;
const AUTO_CHANCE_PAR_DEFAUT = 70;
const AUTO_DELAI_MIN_MS = 3_500;
const AUTO_DELAI_MAX_MS = 8_500;
const DELAI_PROCHAINE_QUESTION_MS = 1_500;
const SCORE_PAR_BONNE_REPONSE = 10;
const QUIZ_PAR_DEFAUT = 25;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(AUTH_FOLDER, { recursive: true });

/* ----------------------------- HTTP / HEALTH ----------------------------- */

let connectionState = 'starting';
let lastConnectionChange = new Date().toISOString();

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const payload = {
      ok: true,
      service: 'whatsapp-quiz-bot',
      whatsapp: connectionState,
      time: new Date().toISOString(),
      lastConnectionChange,
    };

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.url === '/ready') {
    const ready = connectionState === 'open';
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ ready, whatsapp: connectionState }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP health server actif sur le port ${PORT}.`);
});

/* ----------------------------- OUTILS TEXTE ----------------------------- */

function normaliser(texte) {
  return String(texte ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Conserve les lettres Unicode (arabe, grec, cyrillique, etc.).
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function melanger(tableau) {
  const copie = [...tableau];
  for (let i = copie.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

function distanceLevenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  if (a.length > b.length) [a, b] = [b, a];

  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);

  for (let j = 1; j <= b.length; j += 1) {
    const current = [j];

    for (let i = 1; i <= a.length; i += 1) {
      const insertion = current[i - 1] + 1;
      const deletion = previous[i] + 1;
      const substitution = previous[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(insertion, deletion, substitution));
    }

    previous = current;
  }

  return previous[a.length];
}

function estReponseCorrecte(proposition, bonneReponse) {
  const p = normaliser(proposition);
  const b = normaliser(bonneReponse);

  if (!p || !b) return false;
  if (p === b) return true;

  // Tolérance légère aux fautes de frappe, sans le vieux "includes"
  // qui pouvait valider des réponses beaucoup trop larges.
  const distanceMax = b.length >= 10 ? 2 : b.length >= 6 ? 1 : 0;
  if (distanceLevenshtein(p, b) <= distanceMax) return true;

  // Pour les réponses composées de plusieurs mots, on accepte aussi
  // une forme courte uniquement si elle correspond exactement à un nom
  // de famille / terme distinct d'au moins 5 caractères.
  const mots = b.split(' ').filter(Boolean);
  if (mots.length >= 2 && mots[mots.length - 1].length >= 5) {
    if (p === mots[mots.length - 1]) return true;
  }

  return false;
}

function extraireTexte(msg) {
  const message = msg?.message;
  if (!message) return '';

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.ephemeralMessage?.message?.conversation ||
    message.ephemeralMessage?.message?.extendedTextMessage?.text ||
    message.viewOnceMessage?.message?.conversation ||
    message.viewOnceMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

function estCommande(text) {
  return String(text).trim().startsWith('!');
}

/* ----------------------------- QUESTIONS ----------------------------- */

function loadQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    console.error('❌ questions.json introuvable.');
    return [];
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
  } catch (error) {
    console.error('❌ Impossible de lire questions.json :', error.message);
    return [];
  }

  if (!Array.isArray(raw)) {
    console.error('❌ questions.json doit contenir un tableau JSON.');
    return [];
  }

  const seen = new Set();
  const questions = [];

  for (const item of raw) {
    const categorie = String(item?.t ?? 'Divers').trim() || 'Divers';
    const question = String(item?.q ?? '').trim();
    const bonneReponse = String(item?.a ?? '').trim();
    const explication = String(item?.e ?? '').trim();

    if (!question || !bonneReponse) continue;

    const key = normaliser(question);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    questions.push({
      id: item?.id ?? questions.length,
      categorie,
      question,
      bonneReponse,
      explication,
    });
  }

  return questions;
}

const QUESTIONS = loadQuestions();
const THEMES = [...new Set(QUESTIONS.map((q) => q.categorie))].sort((a, b) =>
  a.localeCompare(b, 'fr')
);

const QUESTIONS_PAR_THEME = new Map();
for (const q of QUESTIONS) {
  const key = normaliser(q.categorie);
  if (!QUESTIONS_PAR_THEME.has(key)) QUESTIONS_PAR_THEME.set(key, []);
  QUESTIONS_PAR_THEME.get(key).push(q);
}

console.log(`✅ ${QUESTIONS.length} questions chargées.`);
console.log(`✅ ${THEMES.length} thèmes disponibles.`);

function trouverTheme(nom) {
  const recherche = normaliser(nom);
  if (!recherche) return null;

  const exact = THEMES.find((theme) => normaliser(theme) === recherche);
  if (exact) return exact;

  // Permet par exemple "!quiz mytho" si un seul thème commence par "mytho".
  const correspondances = THEMES.filter((theme) =>
    normaliser(theme).startsWith(recherche)
  );

  return correspondances.length === 1 ? correspondances[0] : null;
}

function questionsDuTheme(theme) {
  return QUESTIONS_PAR_THEME.get(normaliser(theme)) || [];
}

/* ----------------------------- SCORES ----------------------------- */

function loadScores() {
  if (!fs.existsSync(SCORES_FILE)) return {};

  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8'));
  } catch (error) {
    console.log('⚠️ scores.json illisible, nouveau fichier utilisé.');
    return {};
  }
}

function saveScores(scores) {
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2), 'utf-8');
  } catch (error) {
    console.error('❌ Impossible de sauvegarder les scores :', error.message);
  }
}

function formatScore(chatId) {
  const scores = loadScores();
  const chatScores = scores[chatId] || {};

  const entries = Object.entries(chatScores)
    .sort((a, b) => b[1].points - a[1].points)
    .slice(0, 50);

  if (entries.length === 0) {
    return 'Aucun score enregistré pour le moment.';
  }

  let text = '*Classement*\n\n';
  entries.forEach(([, data], index) => {
    text += `${index + 1}. ${data.nom || 'Joueur'} — ${data.points} pt(s)\n`;
  });

  return text.trim();
}

/* ----------------------------- ETAT DU QUIZ ----------------------------- */

// Une session par discussion.
// activeQuizzes contient uniquement la question actuellement affichée.
const sessions = new Map();
const activeQuizzes = new Map();
const timersParChat = new Map();
const autoParChat = new Map();
// État marche/arrêt par discussion. Par défaut, le bot est actif.
const botActifParChat = new Map();

function arreterSession(chatId) {
  const session = sessions.get(chatId);
  if (session?.timeoutId) clearTimeout(session.timeoutId);
  if (session?.nextTimeoutId) clearTimeout(session.nextTimeoutId);

  const quiz = activeQuizzes.get(chatId);
  if (quiz?.timeoutId) clearTimeout(quiz.timeoutId);
  if (quiz?.autoTimeoutId) clearTimeout(quiz.autoTimeoutId);

  sessions.delete(chatId);
  activeQuizzes.delete(chatId);
}

function getTimerSecondes(chatId) {
  const secondes = timersParChat.get(chatId);
  return Number.isInteger(secondes) ? secondes : TEMPS_REPONSE_MS / 1000;
}

function estBotActif(chatId) {
  return botActifParChat.get(chatId) !== false;
}

function getAutoConfig(chatId) {
  return autoParChat.get(chatId) || {
    active: AUTO_REPONSE_PAR_DEFAUT,
    chance: AUTO_CHANCE_PAR_DEFAUT,
  };
}

function nombreAleatoire(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function programmerAutoReponse(sock, chatId, quiz) {
  const config = getAutoConfig(chatId);
  if (!config.active) return;

  if (Math.random() * 100 >= config.chance) return;

  const delai = nombreAleatoire(AUTO_DELAI_MIN_MS, AUTO_DELAI_MAX_MS);
  quiz.autoTimeoutId = setTimeout(async () => {
    const current = activeQuizzes.get(chatId);
    if (!current || current !== quiz || current.resolved) return;

    // Le bot répond publiquement comme le compte du bot. Il ne peut pas
    // envoyer un message à la place du compte WhatsApp de l'utilisateur.
    try {
      await sock.sendMessage(chatId, {
        text: current.question.bonneReponse,
      });
    } catch (error) {
      console.log('Erreur auto-réponse :', error.message);
    }
  }, delai);
}

function formatQuestion(q, numero, total) {
  const compteur = `Question ${numero}/${total}`;
  return `*${compteur} — ${q.categorie}*\n\n${q.question}\n\nRéponds directement dans le chat.`;
}

function lancerQuestion(sock, chatId) {
  const session = sessions.get(chatId);
  if (!session?.running) return;

  if (session.count >= session.total || session.pool.length === 0) {
    session.running = false;
    activeQuizzes.delete(chatId);

    sock.sendMessage(chatId, {
      text: `Quiz terminé : ${session.count} question(s).`,
    }).then(() => sock.sendMessage(chatId, { text: formatScore(chatId) }))
      .catch((error) => console.log('Erreur fin quiz :', error.message));

    sessions.delete(chatId);
    return;
  }

  const q = session.pool.pop();
  session.count += 1;

  const quiz = {
    question: q,
    resolved: false,
    timeoutId: null,
    autoTimeoutId: null,
  };

  activeQuizzes.set(chatId, quiz);

  sock.sendMessage(chatId, {
    text: formatQuestion(q, session.count, session.total),
  }).catch((error) => console.log('Erreur envoi question :', error.message));

  quiz.timeoutId = setTimeout(() => {
    const current = activeQuizzes.get(chatId);
    const currentSession = sessions.get(chatId);

    if (!current || current.resolved) return;

    current.resolved = true;
    activeQuizzes.delete(chatId);

    const message = current.question.explication
      ? `Temps écoulé. Réponse : *${current.question.bonneReponse}*\n${current.question.explication}`
      : `Temps écoulé. Réponse : *${current.question.bonneReponse}*`;

    sock.sendMessage(chatId, { text: message })
      .catch((error) => console.log('Erreur révélation réponse :', error.message))
      .finally(() => {
        if (currentSession?.running) {
          currentSession.nextTimeoutId = setTimeout(
            () => lancerQuestion(sock, chatId),
            DELAI_PROCHAINE_QUESTION_MS
          );
        }
      });
  }, getTimerSecondes(chatId) * 1000);

  session.timeoutId = quiz.timeoutId;
  programmerAutoReponse(sock, chatId, quiz);
}

/* ----------------------------- COMMANDES ----------------------------- */

function parserCommandeQuiz(body) {
  const brut = body.trim();

  // !quiz30
  const legacy = brut.match(/^!quiz(\d+)$/i);
  if (legacy) {
    return { total: Number(legacy[1]), theme: '' };
  }

  // !quiz, !quiz 30, !quiz 30 Mythologie, !quiz Mythologie
  const parts = brut.replace(/^!quiz\b/i, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { total: QUIZ_PAR_DEFAUT, theme: '' };
  }

  const possibleTotal = Number(parts[0]);
  if (Number.isInteger(possibleTotal) && possibleTotal > 0) {
    return {
      total: possibleTotal,
      theme: parts.slice(1).join(' '),
    };
  }

  return {
    total: QUIZ_PAR_DEFAUT,
    theme: parts.join(' '),
  };
}

async function envoyerAide(sock, chatId) {
  await sock.sendMessage(chatId, {
    text:
      '*Commandes du quiz*\n\n' +
      '!quiz → 25 questions\n' +
      '!quiz 30 → 30 questions\n' +
      '!quiz Mythologie → 25 questions du thème Mythologie\n' +
      '!quiz 30 Mythologie → 30 questions du thème Mythologie\n' +
      '!themes → liste des thèmes\n' +
      '!score → classement de la discussion\n' +
      '!timer:12 → régler le temps à 12 secondes (5 à 60)\n' +
      '!timer → voir le timer actuel\n' +
      '!auto → activer/désactiver l’auto-réponse du bot\n' +
      '!auto 70 → auto-réponse sur environ 70 % des questions\n' +
      '!auto off → désactiver l’auto-réponse\n' +
      '!!off → éteindre le bot dans cette discussion\n' +
      '!!on → rallumer le bot dans cette discussion\n' +
      '!stop → arrêter le quiz\n' +
      '!sticker → créer un sticker à partir d’une image\n' +
      '!aide → afficher cette aide\n\n' +
      'Pendant une question, chacun peut proposer plusieurs réponses jusqu’à trouver la bonne ou jusqu’à la fin du timer. Une mauvaise réponse reste silencieuse. Le bot n’envoie ✅ que lorsqu’un message est réellement reconnu comme correct.\n\n' +
      'L’auto-réponse fait parler le compte du bot (pas votre compte WhatsApp) et attend volontairement quelques secondes avant de répondre.',
  });
}

/* ----------------------------- CONNEXION WHATSAPP ----------------------------- */

let reconnectTimer = null;
let reconnectDelay = 3_000;
let currentSocket = null;

function programmerReconnexion() {
  if (reconnectTimer) return;

  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);

  console.log(`Reconnexion dans ${Math.round(delay / 1000)} seconde(s).`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    demarrerBot().catch((error) => {
      console.error('Erreur de reconnexion :', error.message);
      programmerReconnexion();
    });
  }, delay);
}

async function demarrerBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  currentSocket = sock;
  connectionState = 'connecting';
  lastConnectionChange = new Date().toISOString();

  sock.ev.on('creds.update', saveCreds);

  if (!state.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error(
        '❌ BOT_PHONE_NUMBER est obligatoire la première fois pour obtenir le code de connexion.'
      );
      return;
    }

    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('\n=========================================');
        console.log(` CODE DE CONNEXION WHATSAPP : ${code}`);
        console.log('WhatsApp > Paramètres > Appareils connectés');
        console.log('> Connecter un appareil > Se connecter avec un numéro');
        console.log('=========================================\n');
      } catch (error) {
        console.error('Erreur demande code de connexion :', error.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connectionState = 'open';
      lastConnectionChange = new Date().toISOString();
      reconnectDelay = 3_000;
      console.log('✅ Bot connecté à WhatsApp.');
      return;
    }

    if (connection === 'connecting') {
      connectionState = 'connecting';
      lastConnectionChange = new Date().toISOString();
      return;
    }

    if (connection === 'close') {
      connectionState = 'closed';
      lastConnectionChange = new Date().toISOString();

      if (currentSocket === sock) currentSocket = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `Connexion fermée. Code=${statusCode ?? 'inconnu'} | Reconnexion=${!loggedOut}`
      );

      if (!loggedOut) {
        programmerReconnexion();
      } else {
        console.log('❌ Session WhatsApp déconnectée. Il faut reconnecter le numéro.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg?.message || msg.key?.fromMe) continue;

      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      const senderId =
        msg.key.participant ||
        msg.key.remoteJid ||
        `unknown-${msg.key.id || Date.now()}`;

      const senderName = msg.pushName || 'Joueur';
      const textMessage = extraireTexte(msg);
      const body = textMessage.trim();

      if (!body) continue;

      try {
        const bodyLower = body.toLocaleLowerCase('fr-FR');

        /* !!off / !!on : couper ou rallumer le bot dans cette discussion */
        if (bodyLower === '!!off') {
          botActifParChat.set(chatId, false);
          arreterSession(chatId);
          await sock.sendMessage(chatId, { text: 'Bot éteint dans cette discussion. Utilise !!on pour le rallumer.' });
          continue;
        }

        if (bodyLower === '!!on') {
          botActifParChat.set(chatId, true);
          await sock.sendMessage(chatId, { text: 'Bot rallumé.' });
          continue;
        }

        // Quand le bot est éteint, il ignore tout le reste.
        if (!estBotActif(chatId)) continue;

        /* !aide */
        if (bodyLower === '!aide' || bodyLower === '!help') {
          await envoyerAide(sock, chatId);
          continue;
        }

        /* !themes / !thèmes / !theme */
        if (
          bodyLower === '!themes' ||
          bodyLower === '!thèmes' ||
          bodyLower === '!theme' ||
          bodyLower === '!thème'
        ) {
          const lignes = THEMES.map((theme) => {
            const count = questionsDuTheme(theme).length;
            return `• ${theme} (${count})`;
          });

          await sock.sendMessage(chatId, {
            text: `*Thèmes disponibles*\n\n${lignes.join('\n')}`,
          });
          continue;
        }

        /* !timer:12 / !timer 12 */
        const timerMatch = body.match(/^!timer(?::|\s+)(\d+)$/i);
        if (timerMatch) {
          const secondes = Number(timerMatch[1]);

          if (secondes < TIMER_MIN_SECONDES || secondes > TIMER_MAX_SECONDES) {
            await sock.sendMessage(chatId, {
              text: `Le timer doit être compris entre ${TIMER_MIN_SECONDES} et ${TIMER_MAX_SECONDES} secondes.`,
            });
            continue;
          }

          timersParChat.set(chatId, secondes);

          const quizEnCours = activeQuizzes.get(chatId);
          if (quizEnCours && !quizEnCours.resolved) {
            if (quizEnCours.timeoutId) clearTimeout(quizEnCours.timeoutId);
            quizEnCours.timeoutId = setTimeout(() => {
              const current = activeQuizzes.get(chatId);
              const currentSession = sessions.get(chatId);
              if (!current || current.resolved || current !== quizEnCours) return;

              current.resolved = true;
              activeQuizzes.delete(chatId);

              const message = current.question.explication
                ? `Temps écoulé. Réponse : *${current.question.bonneReponse}*\n${current.question.explication}`
                : `Temps écoulé. Réponse : *${current.question.bonneReponse}*`;

              sock.sendMessage(chatId, { text: message })
                .catch((error) => console.log('Erreur révélation réponse :', error.message))
                .finally(() => {
                  if (currentSession?.running) {
                    currentSession.nextTimeoutId = setTimeout(
                      () => lancerQuestion(sock, chatId),
                      DELAI_PROCHAINE_QUESTION_MS
                    );
                  }
                });
            }, secondes * 1000);

            const session = sessions.get(chatId);
            if (session) session.timeoutId = quizEnCours.timeoutId;
          }

          await sock.sendMessage(chatId, {
            text: quizEnCours && !quizEnCours.resolved
              ? `Timer réglé sur ${secondes} secondes pour la question en cours et les suivantes.`
              : `Timer réglé sur ${secondes} secondes pour les prochaines questions.`,
          });
          continue;
        }

        /* !timer : afficher le réglage actuel */
        if (bodyLower === '!timer') {
          await sock.sendMessage(chatId, {
            text: `Timer actuel : ${getTimerSecondes(chatId)} secondes.\nExemple : !timer:12`,
          });
          continue;
        }

        /* !auto / !auto on / !auto off / !auto 70 */
        const autoMatch = body.match(/^!auto(?:\s+(on|off|\d+))?$/i);
        if (autoMatch) {
          const argument = autoMatch[1]?.toLocaleLowerCase('fr-FR');
          const config = getAutoConfig(chatId);

          if (!argument) {
            config.active = !config.active;
          } else if (argument === 'on') {
            config.active = true;
          } else if (argument === 'off') {
            config.active = false;
          } else {
            const chance = Number(argument);
            if (chance < 1 || chance > 100) {
              await sock.sendMessage(chatId, {
                text: 'La probabilité doit être comprise entre 1 et 100 %. Exemple : !auto 70',
              });
              continue;
            }
            config.chance = chance;
            config.active = true;
          }

          autoParChat.set(chatId, config);

          await sock.sendMessage(chatId, {
            text: config.active
              ? `Auto-réponse activée (${config.chance} % des questions), avec un délai volontaire de quelques secondes.`
              : 'Auto-réponse désactivée.',
          });
          continue;
        }

        /* !quiz... */
        if (/^!quiz(?:\d+)?(?:\s+.*)?$/i.test(body)) {
          if (sessions.get(chatId)?.running) {
            await sock.sendMessage(chatId, {
              text: 'Un quiz est déjà en cours dans cette discussion.',
            });
            continue;
          }

          const { total: demande, theme: themeRecherche } = parserCommandeQuiz(body);

          if (!Number.isInteger(demande) || demande <= 0) {
            await sock.sendMessage(chatId, {
              text: 'Nombre invalide. Exemple : !quiz 30',
            });
            continue;
          }

          let poolSource = QUESTIONS;
          let themeChoisi = null;

          if (themeRecherche) {
            themeChoisi = trouverTheme(themeRecherche);

            if (!themeChoisi) {
              await sock.sendMessage(chatId, {
                text:
                  `Thème introuvable : ${themeRecherche}\n\n` +
                  'Utilise !themes pour voir les thèmes disponibles.',
              });
              continue;
            }

            poolSource = questionsDuTheme(themeChoisi);
          }

          if (poolSource.length === 0) {
            await sock.sendMessage(chatId, {
              text: 'Aucune question disponible pour cette sélection.',
            });
            continue;
          }

          const total = Math.min(demande, poolSource.length);

          sessions.set(chatId, {
            running: true,
            count: 0,
            total,
            pool: melanger(poolSource),
            theme: themeChoisi,
            timeoutId: null,
            nextTimeoutId: null,
          });

          lancerQuestion(sock, chatId);
          continue;
        }

        /* !stop : accessible à tout le monde */
        if (bodyLower === '!stop') {
          if (!sessions.has(chatId)) {
            await sock.sendMessage(chatId, { text: 'Aucun quiz en cours.' });
            continue;
          }

          arreterSession(chatId);

          await sock.sendMessage(chatId, { text: 'Quiz arrêté.' });
          await sock.sendMessage(chatId, { text: formatScore(chatId) });
          continue;
        }

        /* !score */
        if (bodyLower === '!score') {
          await sock.sendMessage(chatId, { text: formatScore(chatId) });
          continue;
        }

        /* !sticker : accessible à tout le monde */
        const quotedMessage =
          msg.message.extendedTextMessage?.contextInfo?.quotedMessage;

        const isReplyToImage =
          Boolean(msg.message.imageMessage) ||
          Boolean(quotedMessage?.imageMessage);

        if (bodyLower === '!sticker' && isReplyToImage) {
          await sock.sendMessage(chatId, { text: 'Création du sticker...' });

          let imageMessageContent = msg.message.imageMessage;
          let messageForDownload = msg;

          if (!imageMessageContent && quotedMessage) {
            imageMessageContent = quotedMessage.imageMessage;

            const contextInfo = msg.message.extendedTextMessage.contextInfo;
            messageForDownload = {
              key: {
                remoteJid: chatId,
                id: contextInfo.stanzaId,
                fromMe: false,
                participant: contextInfo.participant,
              },
              message: quotedMessage,
            };
          }

          const buffer = await downloadMediaMessage(
            messageForDownload,
            'buffer',
            {}
          );

          const webpBuffer = await sharp(buffer)
            .resize(512, 512, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            })
            .webp()
            .toBuffer();

          await sock.sendMessage(chatId, { sticker: webpBuffer });
          continue;
        }

        /* Réponse à la question en cours */
        const quiz = activeQuizzes.get(chatId);

        if (quiz && body && !estCommande(body)) {
          if (quiz.resolved) continue;

          const correcte = estReponseCorrecte(
            body,
            quiz.question.bonneReponse
          );

          // Une seule bonne réponse gagne : on verrouille immédiatement
          // avant l'envoi pour éviter deux gagnants en cas de messages simultanés.
          if (correcte) {
            quiz.resolved = true;

            if (quiz.timeoutId) clearTimeout(quiz.timeoutId);
            if (quiz.autoTimeoutId) clearTimeout(quiz.autoTimeoutId);
            activeQuizzes.delete(chatId);

            const scores = loadScores();
            if (!scores[chatId]) scores[chatId] = {};

            if (!scores[chatId][senderId]) {
              scores[chatId][senderId] = {
                nom: senderName,
                points: 0,
              };
            }

            scores[chatId][senderId].nom = senderName;
            scores[chatId][senderId].points += SCORE_PAR_BONNE_REPONSE;
            saveScores(scores);

            const session = sessions.get(chatId);

            await sock.sendMessage(chatId, {
              text: `✅ Bonne réponse, ${senderName} ! +${SCORE_PAR_BONNE_REPONSE} points`,
            });

            if (session?.running) {
              session.nextTimeoutId = setTimeout(
                () => lancerQuestion(sock, chatId),
                DELAI_PROCHAINE_QUESTION_MS
              );
            }
          }

          // Une mauvaise réponse reste silencieuse : le joueur peut réessayer.
        }
      } catch (error) {
        console.error('Erreur traitement message :', error.message);
      }
    }
  });
}

/* ----------------------------- ARRET PROPRE ----------------------------- */

async function arretPropre(signal) {
  console.log(`Arrêt demandé (${signal}).`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  for (const chatId of sessions.keys()) {
    arreterSession(chatId);
  }

  healthServer.close();

  try {
    currentSocket?.end?.(undefined);
  } catch {}

  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => arretPropre('SIGINT'));
process.on('SIGTERM', () => arretPropre('SIGTERM'));

demarrerBot().catch((error) => {
  console.error('❌ Erreur au démarrage :', error);
  programmerReconnexion();
});
