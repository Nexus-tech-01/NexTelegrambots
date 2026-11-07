# NexControl — accès et supervision v2 (7 novembre 2026)

## Objectif
Avoir une vue centrale de **qui**, **quel appareil**, **quelles permissions**, **quelle opération**, **quel résultat** et **pourquoi une connexion a été perdue**. Garder une administration disponible après panne d'un client, sans identifiant root partagé ni jeton administrateur permanent.

## Situation vérifiée
- Le VPS Debian utilise le service nxc-vps-gateway et une base SQLite locale. La session web actuelle expire au bout de 8 heures, avec un cookie d'identification d'appareil séparé de 90 jours.
- NexControl Mobile utilise un agent et sa propre authentification, distincts de la passerelle web.
- Le relais ChatGPT est un workflow GitHub Actions avec identité OIDC signée et liée à la commande. Le connecteur GitHub et le VPS doivent rester accessibles. Une exécution réussie **n'implique pas une session SSH persistante**.
- La passerelle web comporte déjà une table `audit` et des identités d'appareil, mais pas un registre homogène PC/Android/utilisateurs.

## Identités
1. **Compte humain** : UUID immuable; login individuel, facteurs d'authentification et statut (actif/suspendu). Ne jamais attribuer une identité à partir du nom auto-rempli d'un appareil.
2. **Appareil** : UUID différent pour chaque installation (Windows/Android/web). Clé propre stockée dans le coffre de l'OS (Windows Credential Manager/DPAPI, Android Keystore); clé privée non exportée. Un appareil peut changer de propriétaire explicitement, jamais par simple renommage.
3. **Session** : UUID + utilisateur + appareil + création/dernière activité + expiration + état/reason. Jetons de courte durée avec renouvellement rotatif et révocation par appareil. Pas de cookie ni de token brut dans les logs.
4. **Assistant** : identité de service distincte; opérations OIDC vérifiées par action, droits restreints à la tâche demandée, traces de requêtes/résultats. Pas de mot de passe root dans ChatGPT.
5. **Utilisateurs invités** : chaque personne utilise un compte séparé; invitations expirables, sans mot de passe partagé.

## Autorisations par défaut
| Rôle | Consultation | Console et fichiers | Comptes/accès | Actions critiques |
|---|---|---|---|---|
| Propriétaire | Oui | Oui | Oui | Oui, confirmation renforcée |
| Administrateur délégué | Oui | Selon VPS/projet | Gestion déléguée | Confirmation et approbation |
| Opérateur | Oui | Services attribués seulement | Non | Non |
| Observateur | Oui | Non | Non | Non |
| Assistant | Selon instruction | Par action signée et auditée | Non | Autorisation explicite ponctuelle |

Le rôle n'est jamais déduit du terminal, d'une IP ni du nom du PC; il est contrôlé **côté VPS**. Pas de tout-root aux collaborateurs.

## Sessions et résilience
- Une panne réseau, un 502/503 ou un timeout **ne déclenche pas de déconnexion** : garder le tableau visible mais marqué « données non actualisées », réessayer avec délai progressif et bouton Réessayer.
- Un 401/403 signale explicitement la raison (session expirée, appareil révoqué, droits modifiés, identité non vérifiée); demander alors une reconnexion.
- Mettre en place un renouvellement **lors d'une activité humaine** avec une limite absolue et rotation de jetons, sans prolonger indéfiniment en tâche de fond.
- Lorsque l'appareil redémarre, restaurer uniquement les identifiants autorisés depuis le coffre de l'OS, puis contrôler les droits et révocations avec le serveur.
- Plusieurs connexions en parallèle sont permises; fermer une session n'affecte pas les autres appareils. Révoquer un appareil supprime uniquement ses sessions.
- Sur incident, conserver la raison, l'heure et la durée; afficher « hors ligne », « authentification nécessaire » ou « accès révoqué », jamais seulement « erreur ».

## Journal d'audit unique (VPS)
Événements append-only avec timestamp UTC, `actor_id`, `device_id`, `role`, `origin`, `correlation_id`, `action`, `target`, `outcome`, `reason_code`, `duration_ms`. Pour les commandes, enregistrer une empreinte et un résumé du résultat, pas les mots de passe, cookies, sessions web, clés, jetons, messages privés ou données sensibles.
Les agents PC, Android, web et GitHub OIDC fournissent des événements normalisés; le VPS demeure la source de vérité. Afficher un journal consultable avec filtres et traçabilité des révocations. Protection contre l'effacement par des utilisateurs non propriétaires, rotation et sauvegarde chiffrée.

## Continuité assistant
- Canal principal : GitHub Actions OIDC → passerelle VPS, token éphémère lié au hash du corps de commande + anti-rejeu + compte GitHub propriétaire.
- Sur erreur, distinguer Github indisponible, identifiant OIDC refusé, route HTTPS indisponible, VPS indisponible, commande refusée et dépassement de délai.
- Canal de secours : console hébergeur ou connexion administrateur indépendante déjà autorisée. **Ne pas** rendre la console root publique ni conserver de PAT permanent dans une interface web.
- Les connexions du produit ChatGPT ne sont pas garanties à vie : prévoir un mode secours contrôlé par le propriétaire sans prétendre éviter toute déconnexion de plateforme.

## Plan de migration sans interruption
1. Sauvegarder base et code; tester la passerelle, le mobile et l'OIDC; déployer l'interface qui différencie panne réseau et expiration d'authentification.
2. Déployer uniquement en ajout des tables `users`, `registered_clients`, `sessions_v2`, `access_events`, `grants`; aucun utilisateur existant effacé.
3. Rattacher d'abord **le PC du propriétaire**, ensuite **Android**, puis le web, chacun avec une identité distincte. Validation de connexion, reconnexion, révocation et journal avant de retirer l'ancien mécanisme.
4. Ajouter invitations, rôles et accès délégués; démarrer tous les nouveaux comptes avec le minimum de permissions; tester la séparation des rôles.
5. Ajouter contrôles de disponibilité, notifications pour déconnexion/rejet et export d'audit avec rétention configurée.
6. Prévoir migration atomique, health-check, rollback et preuve de bout en bout avant d'activer les nouveaux accès en production.

## Tests obligatoires
Perte réseau temporaire, VPS reboot, agent crash, expiration/rotation de session, appareil révoqué, mauvais mot de passe, changement de rôle, accès simultané PC+Android, perte GitHub et reprise OIDC, échec de sauvegarde, tentatives d'accès non autorisées.

**Ne pas supprimer les mécanismes en cours ni promettre une connexion permanente avant validation complète PC et Android.**
