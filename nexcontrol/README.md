# NexControl V1

NexControl est le centre de contrôle web de la flotte de bots Nextech. Il est conçu pour être déployé sur Vercel et utiliser un MongoDB existant tout en conservant ses données dans une base logique séparée (`nexcontrol`).

## Fonctions incluses

- Dashboard global : bots, destinations, destinations publiables, chaînes.
- Enregistrement automatique des sept bots via une clé de flotte, avec possibilité de créer aussi des clés bot individuelles.
- Écran **Destinations** qui affiche les groupes, supergroupes et chaînes vus par chaque bot.
- Statut **Publication possible** / **Impossible**, avec la cause : bot non admin d'une chaîne, `can_post_messages` absent, restriction Telegram, bot sorti/banni, etc.
- Synchronisation des droits à partir de `getChat` et `getChatMember`.
- Revérification périodique des destinations déjà connues.
- Campagnes multi-bot immédiates ou programmées.
- File de livraison : chaque bot récupère uniquement ses propres jobs.
- Envoi de texte ou d'une image par URL avec légende.
- Gestion du `retry_after` Telegram côté client bot.
- Authentification administrateur par cookie signé HttpOnly.
- Clés bot individuelles stockées côté serveur uniquement sous forme de hash SHA-256 ; clé de flotte conservée uniquement dans les variables d’environnement.

## Fichiers

- `api/index.mjs` : dashboard + API administrateur + API des bots.
- `bot-sdk/nexcontrol-client.mjs` : client à intégrer dans chaque bot Telegram.
- `bot-sdk/telegraf-example.mjs` : exemple Telegraf.
- `bot-sdk/node-telegram-bot-api-example.mjs` : exemple node-telegram-bot-api.
- `vercel.json` : routage Vercel.

## Variables Vercel

```env
MONGODB_URI=mongodb+srv://...
NEXCONTROL_DB_NAME=nexcontrol
ADMIN_PASSWORD=un-mot-de-passe-long
SESSION_SECRET=une-cle-secrete-longue-et-aleatoire
NEXCONTROL_FLEET_KEY=une-cle-flotte-longue-et-aleatoire
```

## Déploiement

Dans le dépôt `Nexus-tech-01/NexTelegrambots`, la V1 se trouve sur la branche `feature/nexcontrol-v1` dans le dossier `nexcontrol/`.

Pour Vercel, crée un projet avec :

- Repository : `Nexus-tech-01/NexTelegrambots`
- Branch : `feature/nexcontrol-v1` pour le premier test
- Root Directory : `nexcontrol`

Ajoute ensuite les quatre variables ci-dessus.

## Connecter la flotte v61.07

La flotte intégrée utilise seulement deux variables communes :

```env
NEXCONTROL_URL=https://ton-nexcontrol.vercel.app
NEXCONTROL_FLEET_KEY=la-meme-cle-que-sur-vercel
```

Le launcher v61.07 enregistre automatiquement NexGame, NexCanal, NexDownloader, NexGroup, NexStick, NexWhisper et Stacy, envoie les heartbeats, importe les destinations déjà présentes dans MongoDB, revérifie leurs permissions Telegram et exécute les campagnes. Les processus enfants signalent aussi les nouveaux groupes/chaînes au launcher via un pont HTTP local protégé par un secret éphémère.

## Limitation Telegram importante

Telegram Bot API ne fournit pas une méthode globale du genre « liste tous les groupes où ce bot est présent ». NexControl construit donc son registre à partir des updates que le bot reçoit et des IDs de chats déjà connus. Pour reprendre immédiatement les anciens groupes après installation, on peut aussi appeler :

```js
await control.syncChats(existingGroupAndChannelIds)
```

en récupérant ces IDs depuis la base actuelle du bot.
