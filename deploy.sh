#!/bin/bash
# Met à jour et redémarre Planning Atelier sur le NAS.
#
# Utilisation :
#   cd <dossier du projet>   (Synology : /volume1/TRAVAIL/PLANNING_ATELIER/planning-atelier-serveur,
#                              Ugreen : /volume1/docker/planning-atelier/planning-atelier-serveur)
#   bash deploy.sh
#
# Fonctionne sur Synology comme sur Ugreen (UGOS) : le script se place tout seul dans son propre
# dossier, et choisit lui-même la bonne commande Docker (avec ou sans sudo, "docker compose" ou
# "docker-compose").
#
# Le script s'arrête au premier problème (set -e) plutôt que de continuer dans un état incertain.
set -e

cd "$(dirname "$0")"

echo "=== Mise à jour Planning Atelier ==="
echo

# Le système de fichiers du NAS modifie parfois le bit exécutable des fichiers, ce qui fait
# apparaître à tort TOUS les fichiers du dépôt comme "modifiés" pour git (aucun vrai changement de
# contenu). Sans ça, "git pull" refuse de continuer. Réglage fait une bonne fois pour toutes.
git config core.fileMode false

# S'il reste de vraies modifications locales (ex: un dépannage manuel fait directement sur le
# NAS avant qu'un correctif n'arrive), on les met de côté sans les perdre, le temps de récupérer
# la dernière version du dépôt.
STASHED=0
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Modifications locales détectées : mise de côté temporaire (git stash)..."
  git stash
  STASHED=1
fi

echo "Récupération de la dernière version..."
git pull

if [ "$STASHED" -eq 1 ]; then
  echo "Réapplication des modifications locales mises de côté..."
  if ! git stash pop; then
    echo
    echo "/!\\ Conflit lors de la réapplication."
    echo "Vos modifications locales restent en sécurité (voir : git stash list)."
    echo "Ne continuez pas tant que ce conflit n'est pas résolu à la main."
    exit 1
  fi
fi

# TM616.env (clé et adresse de la lecture automatique de la pointeuse, jamais versionné) est
# référencé par docker-compose.yml : s'il manque, docker compose refuse de démarrer. On le crée vide
# (lecture automatique alors inactive) plutôt que de bloquer le déploiement de tout le reste.
if [ ! -f TM616.env ]; then
  echo "TM616.env absent : création d'un fichier vide (lecture automatique de la pointeuse inactive)."
  touch TM616.env
fi

# Cfg_admin.yml / Cfg_backup.yml sont montés par docker-compose.yml : absents, Docker crée à leur
# place des DOSSIERS du même nom et le conteneur ne démarre plus correctement.
for f in Cfg_admin.yml Cfg_backup.yml; do
  if [ -d "$f" ]; then
    echo "/!\\ $f est un dossier (créé par Docker faute de fichier). Supprimez-le puis relancez : rmdir $f"
    exit 1
  fi
  if [ ! -f "$f" ]; then
    if [ "$f" = "Cfg_backup.yml" ] && [ -f Cfg_backup.yml.example ]; then
      echo "$f absent : copie du modèle Cfg_backup.yml.example (à compléter pour les sauvegardes e-mail)."
      cp Cfg_backup.yml.example "$f"
    else
      echo "$f absent : création d'un fichier vide."
      touch "$f"
    fi
  fi
done

# Commande Docker : sans sudo si l'utilisateur a le droit d'accéder à Docker (cas courant sur
# Ugreen), avec sudo sinon (cas Synology) ; "docker compose" (v2) ou "docker-compose" (ancien).
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="sudo docker"; fi
if $DOCKER compose version >/dev/null 2>&1; then
  DC="$DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
  if [ "$DOCKER" = "docker" ]; then DC="docker-compose"; else DC="sudo docker-compose"; fi
else
  echo "Docker Compose introuvable : installez/activez Docker dans l'interface du NAS."
  exit 1
fi

echo
echo "Reconstruction de l'image Docker..."
if ! $DC build; then
  echo "Échec de la construction — nouvelle tentative sans cache..."
  $DC build --no-cache
fi

echo "Redémarrage du conteneur..."
$DC up -d

echo
echo "=== Terminé ! Pensez à Ctrl+Maj+R dans le navigateur pour vider le cache. ==="
