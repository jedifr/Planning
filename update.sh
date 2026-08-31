#!/usr/bin/env bash
# Met à jour Planning Atelier depuis git puis reconstruit le conteneur Docker.
# Usage : sudo ./update.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "→ Récupération des dernières modifications (branche actuelle : $(git branch --show-current))..."
git pull

echo "→ Reconstruction et redémarrage du conteneur..."
docker compose down
docker compose up -d --build

echo "→ Terminé. Pense à forcer le rechargement du navigateur (Ctrl+Maj+R) sur chaque poste."
