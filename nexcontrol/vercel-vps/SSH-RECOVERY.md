# NexControl — récupération SSH directe (sans Supabase)

La page `/ssh/` utilise une fonction Node.js Vercel `/ssh-connect` pour ouvrir
une connexion TCP SSH au VPS, sans dépendre des agents NexControl ni de Supabase.

## Sécurité et activation

La fonction est **désactivée** tant que les deux variables d'environnement
suivantes ne sont pas renseignées sur le **projet Vercel `nexcontrol-nexus-vps`** :

- `NXC_SSH_ADMIN_TOKEN` : secret aléatoire unique (au moins 32 caractères).
  Générer directement via le bouton de la page `/ssh/` (32 octets cryptographiquement aléatoires) ou localement avec `openssl rand -hex 32`, puis le mettre dans Vercel comme
  variable sensible pour les environnements concernés. Ne pas le coller dans
  des conversations, dépôts, captures ou journaux.
- `NXC_SSH_ALLOWED_HOSTS` : adresses IPv4 autorisées, séparées par des virgules,
  par exemple l'IP officielle du VPS.
- `NXC_SSH_PORT` : facultatif (22 par défaut), pour un port SSH différent.

**Redéployer le projet Vercel après la configuration.** Vérifier que sa racine
de déploiement est `nexcontrol/vercel-vps` et qu'il installe `ssh2`.
Après fusion, vérifier le fonctionnement réel avec les identifiants du propriétaire et une empreinte SSH indépendante ; ne pas confondre la validation CI avec un accès fonctionnel au VPS.

Étapes utilisateur :
1. Ouvrir `https://nexcontrol-nexus-vps.vercel.app/ssh/`.
2. Saisir le code administrateur NexControl dans le champ protégé (distinct
   des identifiants SSH), l'adresse IP autorisée, le port, l'utilisateur Linux.
3. Cliquer sur `Vérifier l'identité SSH`. **Comparer** l'empreinte fournie à
   celle du serveur dans le panel de l'hébergeur ou la console de récupération.
   Ne jamais confirmer une empreinte inconnue.
4. Saisir un **nouveau** mot de passe SSH (l'ancien a été exposé) puis tester.
5. Si le test réussit, envoyer des commandes Linux depuis la page.

## Limites

- Une commande SSH non interactive par requête, au maximum ~22 s ; ni terminal
  PTY temps réel, ni SFTP. Les commandes, le répertoire courant et l'état de
  shell ne persistent pas entre les requêtes.
- Le VPS doit être accessible depuis les fonctions Vercel sur le port SSH.
  Firewall, `sshd`, routage et restrictions root doivent être configurés.
- La page est un accès d'administration à protéger. La fonction valide la
  destination IPv4 contre une allowlist explicite, exige un jeton administrateur,
  vérifie l'empreinte SSH, refuse les origines étrangères et ne journalise pas
  les identifiants.
- Les secrets sont envoyés via HTTPS à la fonction Vercel et ne sont pas stockés
  dans la base de données, la page, `localStorage` ou les sources Git.
- Cela n'installe **aucun plugin d'accès direct au VPS dans ChatGPT**. L'assistant
  ne peut pas utiliser ce terminal automatiquement sans une intégration
  autorisée séparée. Ne pas partager les identifiants avec l'assistant.
- Cette méthode ne récupère pas un mot de passe erroné ou un compte désactivé.
  En cas de refus SSH, utiliser la console KVM de l'hébergeur.
