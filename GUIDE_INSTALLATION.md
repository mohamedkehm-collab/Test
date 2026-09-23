# WhatsApp Quiz Bot V3.0 — PÉPITE

## Installation Render
1. Mets le contenu de ce dossier sur GitHub.
2. Sur Render : New + → Web Service.
3. Connecte le dépôt GitHub.
4. Build : `npm install`
5. Start : `npm start`
6. Ajoute `BOT_PHONE_NUMBER` avec le numéro WhatsApp du compte bot, sans `+`.
7. Ajoute `OWNER_NUMBERS` avec le même numéro si tu veux utiliser les commandes de gestion.
8. Déploie.
9. Si WhatsApp demande un code de connexion, prends le code affiché dans les logs et utilise WhatsApp → Appareils connectés.

## Commandes visibles
!quiz
!quiz30
!quiz 50
!score
!stats
!stop
!ping
!version
!temps
!statut
!question
!points
!annuler
!aide

Les thèmes ne sont jamais affichés avec les questions.

## Ajouter une question
Commande courte :
`!histoireadd: Quelle bataille... ? | Réponse | Explication facultative`

Commande universelle :
`!add Histoire | Quelle bataille... ? | Réponse | Explication facultative`

Chaque question ajoutée reçoit un ID.

## Modifier / supprimer
`!modifier custom-xxxxx | Nouvelle question | Nouvelle réponse | Explication`
`!supprimer custom-xxxxx`

Ces commandes sont protégées par OWNER_NUMBERS.

## Commandes cachées
`!auto`
`!auto on`
`!auto off`
`!auto 70`
`!timer:20`
`!!on`
`!!off`

Elles ne sont pas listées dans !aide.

## Anti-répétition
Le bot utilise un paquet mélangé par discussion et par thème. Une question ne revient pas avant épuisement du paquet.
L'historique est écrit dans `quiz_state.json`.

## Persistance Render
Sur Render Free, les fichiers locaux peuvent être perdus lors de certaines recréations/redeploys/redémarrages de l'environnement.
Pour une persistance durable des questions ajoutées, scores et historique, utilise un stockage persistant (par exemple un disque persistant ou une base externe).
Le code est déjà séparé pour rendre cette migration simple : questions de base = `questions.json`, questions ajoutées = `custom_questions.json`.

## Sécurité
Les commandes d'ajout/modification/suppression et les commandes cachées de contrôle utilisent `OWNER_NUMBERS`.
Le lancement du quiz et les réponses restent accessibles aux joueurs.
