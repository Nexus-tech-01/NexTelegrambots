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
- Gestion du `retry_after` Telegram côté client bot et remise en file bornée côté serveur.
- Authentification administrateur par cookie signé HttpOnly.
- Clés bot individuelles stockées côté serveur uniquement sous forme de hash SHA-256 ; clé de flotte conservée uniquement dans les variables d’environnement.

## Variables Vercel

```env
MONGODB_URI=mongodb+srv://...
NEXCONTROL_DB_NAME=nexcontrol
ADMIN_PASSWORD=un-mot-de-passe-long
SESSION_SECRET=une-cle-secrete-longue-et-aleatoire
NEXCONTROL_FLEET_KEY=une-cle-flotte-longue-et-aleatoire
```

## Déploiement

Dans le dépôt `Nexus-tech-01/NexTelegrambots`, NexControl se trouve sur la branche `feature/nexcontrol-v1` dans le dossier `nexcontrol/`.

Configuration Vercel :

- Repository : `Nexus-tech-01/NexTelegrambots`
- Branch : `feature/nexcontrol-v1`
- Root Directory : `nexcontrol`

## Connecter la flotte v61.07

La flotte intégrée utilise seulement deux variables communes :

```env
NEXCONTROL_URL=https://ton-nexcontrol.vercel.app
NEXCONTROL_FLEET_KEY=la-meme-cle-que-sur-vercel
```

Le launcher v61.07 enregistre automatiquement NexGame, NexCanal, NexDownloader, NexGroup, NexStick, NexWhisper et Stacy, envoie les heartbeats, importe les destinations déjà présentes dans MongoDB, revérifie leurs permissions Telegram et exécute les campagnes. Les processus enfants signalent aussi les nouveaux groupes/chaînes au launcher via un pont HTTP local protégé par un secret éphémère.

## Limitation Telegram importante

Telegram Bot API ne fournit pas de méthode globale permettant de demander la liste complète des groupes où un bot est présent. NexControl construit donc son registre à partir des updates reçues et des IDs de chats déjà connus, puis vérifie chaque destination avec Telegram avant d'afficher si la publication est possible.
