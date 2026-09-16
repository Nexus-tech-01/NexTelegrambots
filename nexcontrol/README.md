# NexControl V1

Centre de contrôle web pour la flotte Telegram Nextech.

## Fonctionnalités
- Dashboard global des bots et destinations.
- Liste, bot par bot, des groupes, supergroupes et chaînes connus.
- Statut **Publication possible / impossible** avec la raison technique.
- Vérification des droits Telegram (`administrator`, `can_post_messages`, restrictions, bot sorti/banni, etc.).
- Clé API distincte par bot, stockée uniquement sous forme de hash.
- Heartbeat et version de chaque bot.
- Campagnes multi-bot immédiates ou programmées.
- Worker de livraison : chaque bot récupère seulement ses propres tâches.
- Revérification périodique des destinations connues.

## Déploiement Vercel
Crée un projet Vercel dont le **Root Directory** est `nexcontrol`, puis configure :

```env
MONGODB_URI=...
NEXCONTROL_DB_NAME=nexcontrol
ADMIN_PASSWORD=...
SESSION_SECRET=...
```

Le même cluster MongoDB que les bots peut être utilisé : la base logique `nexcontrol` reste séparée.

## Connecter un bot
Depuis l'écran **Bots**, crée le bot et copie la clé `nxc_...` affichée une seule fois. Ajoute ensuite au bot :

```env
NEXCONTROL_URL=https://ton-projet.vercel.app
NEXCONTROL_API_KEY=nxc_...
```

Copie `bot-sdk/nexcontrol-client.mjs`, instancie `NexControlClient`, appelle `control.start()` au démarrage et transmet les updates Telegram à `control.observeUpdate(update)`.

Telegram ne fournit pas d'API globale permettant à un bot de lister tous les groupes où il est présent. NexControl construit donc la liste à partir des updates reçues, puis revérifie les chats connus par lots.
