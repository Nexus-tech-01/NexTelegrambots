# NexControl — identité unifiée V3 (7 novembre 2026)

STATUT : noyau développé sur une branche de travail; **pas encore intégré aux applications ni déployé sur le VPS**.

## Hiérarchie demandée

| Identité | Type | Droits |
| --- | --- | --- |
| tresor | humain / propriétaire | accès complet Linux sudo + contrôle des utilisateurs, appareils, rôles, sessions et intégrations NexControl |
| chatgpt | service technique | root via le pont GitHub OIDC vérifié, avec journalisation et possibilité de révocation par le propriétaire |
| administrateur délégué | humain | rôles et projets explicitement attribués |
| opérateur / observateur | humain | permissions limitées, pas de root par défaut |

Sur le VPS, le compte Linux tresor existe et possède déjà (ALL : ALL) ALL via sudo. Le service chatgpt est une identité logique, **pas** un mot de passe root partagé ou une connexion SSH interactive permanente.

## Fusion logique des accès de l'assistant

Chaque accès réel (GitHub OIDC, intégration NexControl, éventuel agent PC/Android autorisé) reste authentifié indépendamment. Après vérification cryptographique, la passerelle rattache l'opération à l'identité logique chatgpt. Jamais de fusion de cookies, mots de passe ou jetons bruts.

GitHub OIDC vérifie le workflow et le propriétaire GitHub, mais ne prouve pas à lui seul qu'un message précis vient effectivement de ChatGPT. Conserver la provenance réelle de chaque opération dans le journal.

Une identité disposant de root peut techniquement modifier l'ensemble du système, y compris les règles d'accès et les journaux. La souveraineté de tresor doit donc aussi reposer sur un accès indépendant auprès de l'hébergeur, des sauvegardes chiffrées hors VPS et la possibilité de désactiver le pont root.

## Architecture des comptes

Un compte NexControl par humain, une identité d'appareil par installation (PC Windows, Android, navigateur), une session et un jeton par client. Clé privée uniquement dans Android Keystore ou Windows Credential Manager/DPAPI; preuve de possession nécessaire avant délivrance de session.

Registre local sur VPS, sans Supabase. La bibliothèque account_store.py apporte les comptes, rôles, sessions access de 15 minutes, refresh rotatif de 30 jours, révocations, inventaire d'appareils et événements append-only. Elle n'est pas un serveur HTTP et n'ouvre aucun accès réseau par elle-même.

L'accès root au service chatgpt n'est autorisé par la bibliothèque que lorsque la passerelle a déjà vérifié son identité de service. Ne jamais accepter le marqueur verified_service_context directement depuis le navigateur ou l'APK.

## Nouvelles interfaces PC et Android

1. Connexion : nom d'utilisateur, authentification forte, sélection du compte; état de la connexion, motif de coupure et tentative de reconnexion.
2. Appareils : propriétaire, plate-forme, dernière activité, sessions, révocation individuelle, aucune déconnexion globale accidentelle.
3. Utilisateurs : invitations, permissions et rôles; propriétaire tresor non supprimable depuis l'interface déléguée.
4. Assistant : compte de service chatgpt, opérations OIDC récentes, erreurs, contrôles de révocation et canal de secours indépendant.
5. Journal : heure, acteur, appareil, canal, opération, succès/échec, explication. Aucun secret ou contenu de session dans le journal.

## Migration sans interruption

- Sauvegarder et tester la restauration des bases existantes.
- Initialiser le registre V3 local, sans remplacer les clés mobiles ni les sessions web.
- Enrôler le propriétaire tresor avec ses propres identifiants NexControl et une authentification renforcée.
- Adapter le navigateur/PC puis Android, enregistrement d'appareil et preuve de possession; tester perte réseau, expiration et révocation.
- Rattacher les opérations GitHub OIDC vérifiées au compte technique chatgpt et enregistrer l'identité source réelle.
- Enrôler les autres utilisateurs un par un; supprimer les accès hérités seulement après validation.
- Prévoir le rollback et la récupération via fournisseur VPS indépendant du pont.

## État vérifié avant migration

- Passerelle web : sessions de 8 heures, appareils par cookie; 0 appareil et 0 session web active dans la base au moment de l'audit.
- Agent mobile : 2 clés d'accès, pas de compte humain unifié; son registre inclut keys, pairing, seen, aliases.
- Pont OIDC : exécution de commandes root effectivement testée via GitHub Actions.
- Les services de production fonctionnent séparément. Le dépôt public contient des composants web, mais le code exact des APK et du logiciel Windows installés doit être identifié avant leur modification.

## Test logiciel

python3 -m unittest discover -s nexcontrol/identity-v3 -p 'test_*.py' -v

La réussite des tests unitaires ne prouve ni le bon fonctionnement d'une APK ni le déploiement serveur. Restent à intégrer : endpoints HTTP authentifiés et MFA, vraie preuve d'appareil, applications Windows/Android, journal central affiché et migrations de production.
