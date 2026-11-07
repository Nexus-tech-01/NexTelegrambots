# NexControl V3 — Windows et Android

Le dossier contient un nouveau client Flutter commun. Il est livré **en parallèle** des anciennes applications, et ne remplace pas leurs APK/EXE existants.

## Connexions
- Nom utilisateur et mot de passe SSH
- Clé privée OpenSSH/PEM, avec phrase secrète facultative
- Ancienne clé API NexControl (compatibilité HTTPS)
- Ajouter plusieurs VPS : adresse IPv4/domaine, port, utilisateur, méthode et secret
- Empreinte d'hôte SSH à vérifier explicitement la première fois ; refus automatique en cas de modification inattendue
- Sauvegarde des secrets uniquement sur option, chiffrés dans le stockage sécurisé Windows/Android
- Lien vers la console NexControl web existante

## Outils inclus
Vue système, exécution de commandes Linux, listing SFTP, services actifs, inventaire des comptes Linux et des ponts NexControl accessibles avec les droits du compte connecté.

Le listing des utilisateurs Linux **n'est pas une liste exhaustive** de toutes les voies d'accès : console de l'hébergeur, clés SSH, sessions API, GitHub OIDC et accès de conteneur doivent aussi être inventoriés côté serveur. Le registre V3 stocke le compte de service chatgpt et le propriétaire tresor, mais seuls les comptes autorisés peuvent le lire.

## Compilation
Le workflow GitHub Actions nexcontrol-clients-v3.yml compile deux variantes Android (APK debug) et deux variantes Windows (distributions ZIP contenant l'EXE et ses bibliothèques). Consulte la page Actions du dépôt pour accéder aux artefacts après réussite des deux jobs.

Les versions debug Android ont une identité d'application distincte ; elles ne mettent pas à jour l'ancienne APK. Les fichiers Windows ne sont pas signés, donc Windows SmartScreen peut présenter un avertissement. Une version de production exige signature de code et tests réels.

## Limites encore à traiter
- Les comptes NexControl V3 ne disposent pas encore du login HTTP autonome MFA ; l'écran actuel se connecte avec l'utilisateur SSH Linux ou l'ancienne clé API.
- Écriture/upload SFTP, commandes administratives graphiques, gestion fine des rôles et tableau complet de toutes les identités (PC, Android, API et OIDC) ne sont pas encore intégrés dans ce client.
- Ne pas prétendre que les anciennes versions ont été modifiées : leurs sources Android/Windows complètes n'ont pas été localisées.
- Les mots de passe des VPS tiers ne sont pas envoyés à HONTAVYR ; SSH est établi depuis l'appareil.
