#!/bin/bash
# Met à jour et redémarre Planning Atelier sur le NAS.
#
# Utilisation :
#   cd /volume1/TRAVAIL/PLANNING_ATELIER/planning-atelier-serveur
#   bash deploy.sh
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

echo
echo "Reconstruction de l'image Docker..."
if ! sudo docker compose build; then
  echo "Échec de la construction — nouvelle tentative sans cache..."
  sudo docker compose build --no-cache
fi

echo "Redémarrage du conteneur..."
sudo docker compose up -d

echo
echo "=== Terminé ! Pensez à Ctrl+Maj+R dans le navigateur pour vider le cache. ==="
