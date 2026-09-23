# Bot WhatsApp Quiz V2

Cette version a été refaite pour utiliser `questions.json` à la place de l'ancien fichier Excel.

## Ce qui a changé

- **9039 questions JSON** utilisées comme source.
- Les doublons exacts sont ignorés au chargement.
- **20 thèmes** détectés automatiquement.
- Plus aucun système d'`owner` : **tout le monde** peut lancer, arrêter un quiz, voir les scores et utiliser le sticker.
- **14 secondes** pour chaque question.
- Pas de compte à rebours.
- Pas de QCM : chacun écrit directement sa réponse.
- Une mauvaise réponse n'affiche pas de message : on peut réessayer jusqu'à la bonne réponse ou jusqu'au temps écoulé.
- Une bonne réponse donne **+10 points**, affiche `✅`, puis la question suivante arrive après une courte pause.
- À la fin, la réponse est révélée si personne n'a trouvé.
- Vérification des réponses améliorée : accents/majuscules/ponctuation ignorés, petite tolérance aux fautes de frappe, et suppression de l'ancien `includes()` trop permissif.
- `!themes` / `!thèmes` affiche les thèmes et leur nombre de questions.
- `!quiz 30 Mythologie` permet de jouer uniquement sur un thème.
- `!quiz Mythologie` lance 25 questions de ce thème.
- `!quiz30` reste accepté pour compatibilité.
- Un quiz ne répète pas une question dans sa série.
- Si un thème contient moins de questions que demandé, le bot utilise toutes les questions disponibles sans inventer de doublons.
- Serveur HTTP `/health` et `/ready` ajouté pour Render.
- Reconnexion avec délai progressif pour éviter les boucles agressives.
- Arrêt propre sur SIGINT/SIGTERM.
- Les variables `OWNER_NUMBERS` et la logique d'owner ont été supprimées.

## Commandes

| Commande | Fonction |
|---|---|
| `!quiz` | 25 questions aléatoires |
| `!quiz 30` | 30 questions |
| `!quiz Mythologie` | 25 questions du thème Mythologie |
| `!quiz 30 Mythologie` | 30 questions du thème Mythologie |
| `!quiz30` | 30 questions |
| `!themes` | liste des thèmes |
| `!score` | classement de la discussion |
| `!stop` | arrêter le quiz |
| `!sticker` | transformer une image en sticker (la commande doit être envoyée sur l'image ou en réponse à l'image) |
| `!aide` | aide |

Toutes ces commandes sont accessibles à tous.

## Installation sur Render

### 1. GitHub

Mets ces fichiers dans ton dépôt :

- `index.js`
- `package.json`
- `questions.json`
- `render.yaml`
- `.gitignore`

Ne mets **jamais** le dossier `auth_info` ni les fichiers de session WhatsApp dans GitHub.

### 2. Render

Crée un **Web Service** avec :

- Build Command : `npm install`
- Start Command : `npm start`
- Instance : `Free` si tu veux commencer sans payer

`render.yaml` contient déjà la configuration de base et le health check `/health`.

Ajoute dans les variables d'environnement :

- `BOT_PHONE_NUMBER` = ton numéro WhatsApp complet sans `+`.

Exemple Côte d'Ivoire : `2250700000000`

`PORT` est fourni par Render automatiquement ; le bot écoute sur `0.0.0.0`.

### 3. Première connexion WhatsApp

Dans les logs Render, le bot affiche un code de connexion.

Sur WhatsApp :

**Paramètres → Appareils connectés → Connecter un appareil → Se connecter avec un numéro**

Entre le code affiché.

Quand c'est bon, les logs indiquent :

`✅ Bot connecté à WhatsApp.`

### 4. Important sur le stockage Render

Le bot sauvegarde l'authentification WhatsApp et les scores dans `DATA_DIR`.

Par défaut :

`data/auth_info/`
`data/scores.json`

Le système de fichiers d'un service Render gratuit n'est pas un stockage persistant. Une nouvelle instance/redeploy peut donc faire perdre la session WhatsApp et les scores locaux.

Si tu utilises plus tard un stockage persistant, tu peux définir :

- `DATA_DIR=/var/data`
- `AUTH_DIR=/var/data/auth_info`

Le chemin exact du disque dépendra de la configuration Render.

## UptimeRobot

Le bot possède maintenant :

- `/health` → indique que le processus HTTP fonctionne.
- `/ready` → indique si WhatsApp est connecté.

Pour un monitoring HTTP, utilise l'URL Render suivie de `/health`.

Un ping HTTP ne remplace pas un vrai stockage persistant et ne garantit pas à lui seul la stabilité de la connexion WhatsApp.

## Utilisation

Dans un groupe :

1. Quelqu'un tape `!quiz`.
2. Le bot pose directement la première question.
3. Tout le monde peut répondre.
4. Une personne peut réessayer après une mauvaise réponse.
5. La première bonne réponse gagne 10 points.
6. Le bot affiche `✅` puis passe à la suivante.
7. Si personne ne trouve en 14 secondes, le bot donne la réponse.
8. `!score` affiche le classement.

Le bot ne donne pas de réponse aux mauvaises propositions, afin d'éviter le spam de messages.

## Attention

Ce bot utilise Baileys pour se connecter à WhatsApp. Utilise-le raisonnablement : évite les volumes de messages artificiellement élevés ou les comportements de spam.

La session WhatsApp est une donnée sensible. Ne partage jamais le contenu de `data/auth_info/`.

## Timer réglable

Le timer est réglé par discussion et vaut 14 secondes par défaut.

- `!timer:12` → règle le timer à 12 secondes
- `!timer 12` → même chose
- `!timer` → affiche le réglage actuel
- valeur autorisée : **5 à 60 secondes**

Si un quiz est déjà en cours, la nouvelle durée est appliquée à la question en cours et aux suivantes.

## Auto-réponse du bot

L'auto-réponse est désactivée par défaut. Elle permet au **compte du bot** de proposer parfois la bonne réponse, avec un délai volontaire de quelques secondes afin de ne pas répondre instantanément.

- `!auto` → active/désactive
- `!auto on` → active
- `!auto off` → désactive
- `!auto 70` → active avec environ 70 % de chance par question

Le bot ne peut pas envoyer un message à la place du compte WhatsApp personnel d'un utilisateur : il répond toujours depuis son propre compte.

L'auto-réponse n'envoie pas de `✅` elle-même. Le `✅` est réservé à une réponse réellement reçue d'un participant et reconnue comme correcte.

## Commandes arrêt/marche

- `!!off` : éteint le bot uniquement dans cette discussion et arrête le quiz en cours.
- `!!on` : rallume le bot dans cette discussion.

Quand le bot est éteint, il ignore les autres messages jusqu'à `!!on`.
