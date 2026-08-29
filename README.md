# Planning Atelier — serveur partagé

Cette version remplace le stockage navigateur par un vrai serveur (Node.js + Express)
avec une base de données SQLite. Tous les postes de l'atelier, connectés au même
réseau, accèdent au **même planning en temps quasi réel** (rafraîchissement
automatique toutes les 8 secondes).

## Contenu du dossier

- `server.js` — serveur web + API
- `public/index.html` — l'application (identique à la version précédente, juste
  reliée à l'API au lieu du stockage du navigateur)
- `data/` — dossier où vit le fichier de base de données `planning.db` (créé
  automatiquement au premier démarrage). **C'est ce dossier qu'il faut sauvegarder.**
- `Dockerfile` / `docker-compose.yml` — pour un déploiement en conteneur sur votre
  NAS Synology via Container Manager

## Déploiement sur votre NAS Synology

### Étape 0 — vérifier que Docker est disponible sur votre modèle

Ouvrez **Panneau de configuration → Centre de paquets**, recherchez **Container
Manager** (DSM 7.2 et plus récent) ou **Docker** (DSM 7.1 et antérieur) et installez-le.

⚠️ Ce paquet n'est proposé que sur les modèles Synology compatibles (essentiellement
les modèles à processeur x86/x86_64 ; beaucoup de petits modèles ARM d'entrée de
gamme — DS220j, DS218, etc. — ne le proposent pas). S'il n'apparaît pas dans le
Centre de paquets, votre modèle ne le supporte pas — voir la section "Si Docker
n'est pas disponible" plus bas.

### Étape 1 — copier le dossier sur le NAS

Via **File Station** (ou un partage réseau SMB depuis votre PC), copiez tout le
dossier `planning-atelier-serveur` dans un dossier partagé, par exemple :

```
/docker/planning-atelier-serveur/
```

(Si vous n'avez pas encore de dossier partagé `docker`, créez-en un depuis
**Panneau de configuration → Dossier partagé**.)

### Étape 2 — créer le projet dans Container Manager

1. Ouvrez **Container Manager → Projet → Créer**.
2. Nom du projet : `planning-atelier`.
3. Chemin : sélectionnez le dossier copié à l'étape 1.
4. Source : choisissez **Utiliser un fichier docker-compose.yml existant** — il est
   déjà présent dans le dossier, Container Manager le détecte automatiquement.
5. Cliquez sur **Suivant** puis **Terminé**. La construction de l'image démarre
   (compte quelques minutes la première fois, le temps d'installer les dépendances).
6. Une fois le statut passé à **En cours d'exécution**, c'est en ligne.

### Étape 3 — ouvrir le port sur le pare-feu (si activé)

Si vous avez activé le pare-feu Synology (**Panneau de configuration → Sécurité →
Pare-feu**), ajoutez une règle autorisant le port **TCP 3000** depuis votre réseau
local, sinon les autres postes ne pourront pas atteindre le service.

### Étape 4 — trouver l'adresse du NAS et se connecter

L'adresse IP locale de votre NAS est visible dans **Panneau de configuration →
Réseau → Interface réseau** (c'est la même IP que celle utilisée pour accéder à
DSM). Depuis n'importe quel poste de l'atelier, ouvrez :

```
http://<IP-de-votre-NAS>:3000
```

Ajoutez cette adresse en favori sur chaque poste — tout le monde travaille alors
sur le même planning, avec synchronisation automatique.

*(Optionnel : si vous préférez une adresse plus lisible qu'une IP suivie d'un
port, vous pouvez configurer un reverse proxy dans **Panneau de configuration →
Portail de connexion → Avancé → Reverse Proxy**, par exemple pour faire
correspondre `planning.local` au port 3000 en interne — dites-le si vous voulez
un coup de main pour cette étape.)*

### Mettre à jour l'application plus tard

Si je vous fournis une nouvelle version des fichiers, remplacez `server.js` et
`public/index.html` dans le dossier du projet, puis dans Container Manager :
**Projet → planning-atelier → Action → Reconstruire**. Vos données ne bougent pas
(elles vivent dans le sous-dossier `data/`, séparé du code).

### Si Docker n'est pas disponible sur votre modèle

Certains modèles Synology (notamment les modèles ARM d'entrée de gamme) ne
proposent pas Container Manager. Dans ce cas, deux pistes :

- Installer le paquet **Node.js** depuis le Centre de paquets (s'il est proposé
  pour votre modèle) et lancer le serveur via une **tâche planifiée déclenchée**
  (Panneau de configuration → Tâche planifiée → Créer → Tâche déclenchée →
  Script défini par l'utilisateur, lancé au démarrage du NAS) — dites-le-moi, je
  vous prépare le script exact.
- Héberger ce serveur sur un autre petit appareil de l'atelier resté allumé
  (mini-PC, Raspberry Pi) plutôt que sur le NAS lui-même, tout en gardant la base
  de données sauvegardée sur le NAS via une synchronisation régulière du dossier
  `data/`.

## Sans Docker, avec Node.js directement (autre machine)

Si vous préférez exécuter ceci sur un PC ou petit serveur qui a déjà Node.js 18+
installé :

```bash
npm install
npm start
```

Le serveur écoute par défaut sur le port `3000`. Pour changer le port ou l'emplacement
de la base de données :

```bash
PORT=8080 DB_PATH=/chemin/vers/planning.db npm start
```

## Sauvegardes

La vraie donnée vit dans un **volume Docker nommé** (`planning-data`), géré par Docker
lui-même plutôt que dans un dossier visible directement dans File Station (ce choix
évite les soucis de montage lié parfois capricieux sur certains NAS Synology).

Pour la sauvegarder manuellement via SSH :

```bash
docker run --rm \
  -v planning-atelier-serveur_planning-data:/data \
  -v /volume1/docker/backups:/backup \
  alpine tar czf /backup/planning-backup-$(date +%Y%m%d).tar.gz -C / data
```

(adaptez `/volume1/docker/backups` vers un dossier existant où stocker l'archive, et
`planning-atelier-serveur_planning-data` vers le nom réel du volume — vérifiable avec
`docker volume ls`).

Le bouton **Exporter (.json)** dans l'application reste le moyen le plus simple pour
une sauvegarde ponctuelle, sans passer par SSH.

## Fonctionnement multi-utilisateurs

- Toutes les 8 secondes, chaque poste récupère automatiquement les dernières
  modifications des autres (sauf si vous êtes en train de saisir un champ ou de
  glisser une tâche, pour ne pas vous interrompre).
- Si deux personnes enregistrent une modification au même instant, la première
  est acceptée ; la seconde reçoit un message l'informant qu'une mise à jour plus
  récente existe, et récupère automatiquement cette version à jour — pour éviter
  qu'une modification écrase silencieusement celle d'un collègue.
- Un badge en haut de l'écran indique l'état de la synchronisation
  (Synchronisé / Enregistrement… / Serveur injoignable / Conflit).

## Sauvegarde automatique par e-mail

L'application peut envoyer chaque jour, par e-mail, un zip (optionnellement protégé
par mot de passe) contenant toutes les données du planning. L'adresse destinataire,
le mot de passe et l'heure d'envoi se règlent dans la pop-up **⚙ Paramétrer** de
l'application, avec une case pour activer/désactiver l'envoi automatique.

Le compte d'envoi (serveur SMTP), lui, se configure dans le fichier **`Cfg_backup.yml`**,
à la racine du projet — pas dans l'application, car il s'agit d'informations sensibles.
Ce fichier est relu à chaque tentative d'envoi : une modification prend effet dans la
minute qui suit, **sans avoir besoin de reconstruire ni redémarrer le conteneur**.

### Configuration avec un compte Gmail (le plus simple)

1. Sur le compte Gmail à utiliser pour l'envoi, activez la validation en deux étapes
   (obligatoire), puis créez un **mot de passe d'application** :
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
   Ce n'est pas votre mot de passe Gmail habituel — c'est un code à 16 caractères
   généré spécifiquement pour cet usage.
2. Ouvrez `Cfg_backup.yml` (dans File Station, ou via un éditeur de texte) et remplissez :
   ```yaml
   smtp:
     host: "smtp.gmail.com"
     port: 587
     secure: false
     user: "votre.adresse@gmail.com"
     pass: "le mot de passe d'application à 16 caractères"
     from: "votre.adresse@gmail.com"
   ```
3. Enregistrez le fichier — pas besoin de relancer le conteneur.
4. Dans l'application, ouvrez **⚙ Paramétrer**, renseignez l'adresse destinataire des
   sauvegardes, activez "Envoyer une sauvegarde chaque jour", et cliquez sur
   **"Tester l'envoi maintenant"** pour vérifier que tout fonctionne.

### Avec un autre fournisseur

N'importe quel serveur SMTP fonctionne (Outlook, OVH, un serveur mail interne à
l'entreprise, etc.) — demandez à votre fournisseur les valeurs d'hôte, de port, et
si le chiffrement TLS/SSL est requis (`secure: true` pour le port 465,
`secure: false` pour le port 587 avec STARTTLS).

### Important : premier déploiement

Le fichier `Cfg_backup.yml` doit exister **avant** le tout premier démarrage du
conteneur (il est monté directement depuis le dossier du projet). Il est déjà présent
dans cette archive — assurez-vous simplement de conserver le fichier au même endroit
que `docker-compose.yml` en le copiant sur le NAS. Si jamais Container Manager crée un
dossier à la place d'un fichier (message d'erreur au démarrage), supprimez ce dossier
et remettez le fichier `Cfg_backup.yml` fourni avant de relancer.

### Dépannage

- **Erreur contenant `wrong version number`** : le couple `secure` / `requireTLS` de
  `Cfg_backup.yml` ne correspond pas à ce qu'attend votre port. Il y a deux
  combinaisons à tester (voir les commentaires du fichier) :
  - `secure: true` / `requireTLS: false` → TLS chiffré dès la connexion.
  - `secure: false` / `requireTLS: true` → connexion en clair puis STARTTLS **obligatoire**.
  Beaucoup d'hébergeurs qui annoncent "il faut forcer le SSL/TLS" veulent en réalité
  dire la deuxième option (STARTTLS obligatoire), pas la première — si la première
  échoue avec cette erreur, essayez systématiquement la seconde.
- **Erreur d'authentification** : vérifiez `user` / `pass` — pour Gmail, ce n'est
  jamais votre mot de passe habituel, uniquement un mot de passe d'application.
- Le bouton "Tester l'envoi maintenant" est le moyen le plus rapide d'itérer : chaque
  modification de `Cfg_backup.yml` est prise en compte dans la minute, sans redémarrage.

### Fonctionnement

- Le serveur vérifie chaque minute si l'heure configurée est atteinte, et envoie au
  maximum une fois par jour.
- En cas d'échec (mauvais identifiants, réseau, etc.), l'erreur est journalisée côté
  serveur (`docker logs planning-atelier` ou dans Container Manager) et l'envoi n'est
  pas retenté avant le lendemain, pour éviter les boucles d'erreur.
- Le bouton "Tester l'envoi maintenant" permet de vérifier la configuration sans
  attendre l'heure programmée.

## Sécurité — comptes utilisateurs et accès depuis internet

Depuis cette version, l'application exige une connexion (identifiant + mot de passe)
pour accéder au planning. C'est la base indispensable si vous comptez ouvrir l'accès
depuis l'extérieur de votre réseau local — mais **plusieurs autres étapes sont tout
aussi indispensables** avant d'exposer réellement le service sur internet.

### Premier démarrage

**Option recommandée — choisir vous-même le mot de passe (le plus simple) :**

Avant le tout premier démarrage, ouvrez `Cfg_admin.yml` dans File Station et
remplissez l'identifiant et le mot de passe voulus :

```yaml
admin:
  username: "admin"
  password: "VotreMotDePasseIci"
```

Démarrez ensuite le conteneur : ce compte est créé avec exactement ces identifiants,
pas besoin d'aller chercher quoi que ce soit dans les logs. Une fois connecté, remettez
`password: "changez-moi"` dans le fichier, pour ne pas laisser un mot de passe en clair
sur le disque (le fichier n'est de toute façon relu qu'une seule fois, au tout premier
démarrage — le remodifier ensuite n'a plus aucun effet).

**Si vous ne touchez pas à ce fichier :** un compte `admin` est créé automatiquement
avec un mot de passe aléatoire. Ce mot de passe s'affiche dans les logs du conteneur
(`sudo docker logs planning-atelier`) et est aussi écrit une seule fois dans
`data/PREMIER-MOT-DE-PASSE.txt` — un fichier situé **à l'intérieur du volume Docker**
`planning-data`, donc pas directement visible dans File Station ; pour le consulter,
passez par les logs (plus simple) ou en SSH :
```
sudo docker exec planning-atelier cat /data/PREMIER-MOT-DE-PASSE.txt
```

Dans tous les cas, une fois connecté, allez dans **⚙ Paramétrer → Utilisateurs** :
créez votre propre compte, changez ou supprimez le compte `admin`, et ajoutez un
compte par personne devant se connecter.

### Obligatoire avant toute exposition sur internet

1. **HTTPS.** Aujourd'hui le trafic circule en clair — exposer ça sans chiffrement
   ferait circuler les mots de passe en clair sur internet. Utilisez le reverse proxy
   de Synology (Panneau de configuration → Portail de connexion → Avancé → Reverse
   Proxy) pointant vers `http://localhost:3000`, avec un certificat Let's Encrypt
   gratuit généré depuis Panneau de configuration → Sécurité → Certificat.
2. **`SESSION_SECRET` fixe.** Dans `docker-compose.yml`, remplacez la valeur vide par
   une chaîne aléatoire longue (générez-la par exemple avec `openssl rand -hex 32` en
   SSH sur le NAS, ou n'importe quel générateur de mot de passe long). Sans ça, un
   redémarrage du conteneur déconnecte tout le monde — ce n'est pas grave en soi, mais
   ce n'est pas non plus une vraie protection si le secret change à chaque fois.
3. **`COOKIE_SECURE=true`** une fois le HTTPS en place (voir point 1). Tant que vous
   êtes uniquement en HTTP sur le réseau local, laissez `false`, sinon la connexion ne
   fonctionnera pas du tout.
4. Redéployez après ces changements (`sudo docker compose down && sudo docker compose up -d --build`).

### Bon à savoir

- Les sessions durent 7 jours, puis la reconnexion est redemandée.
- Après 6 tentatives de connexion échouées pour un même identifiant depuis la même
  adresse IP, une pause de 5 minutes est imposée avant de pouvoir réessayer.
- Tous les comptes ont les mêmes droits (pas de distinction "administrateur" /
  "lecture seule" pour l'instant) — n'importe quel compte peut créer ou supprimer
  d'autres comptes. Adapté à une petite équipe de confiance ; dites-le si vous avez
  besoin de rôles différenciés.
- Les sessions sont actuellement gardées en mémoire par le serveur : un redémarrage du
  conteneur déconnecte tout le monde (reconnexion en un clic, rien n'est perdu côté
  données). Ce n'est pas gênant pour un usage normal, mais c'est bon à savoir si un
  redémarrage a lieu en pleine utilisation.
- Si vous ne comptez finalement exposer le service qu'à quelques personnes connues et
  peu fréquemment, un VPN (Synology VPN Server, WireGuard...) reste l'option la plus
  sûre — dans ce cas, ces comptes applicatifs restent malgré tout utiles comme
  deuxième niveau de protection.
