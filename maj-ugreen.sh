#!/bin/bash
# Mise à jour SANS git (NAS Ugreen : apt est verrouillé, git ne s'installe pas).
#
# Utilisation, depuis le dossier du projet :
#   bash maj-ugreen.sh
#
# Télécharge la dernière version (branche main) en zip, remplace les fichiers du projet, puis reconstruit
# et redémarre le conteneur. Vos fichiers locaux ne sont JAMAIS écrasés : docker-compose.yml (votre
# SESSION_SECRET), Cfg_admin.yml, Cfg_backup.yml, TM616.env. Si le docker-compose.yml du dépôt diffère du
# vôtre, la nouvelle version est déposée à côté sous docker-compose.yml.nouveau pour que vous la compariez.
#
# Variables facultatives (tests) : REPO_ZIP (autre adresse du zip), SANS_DOCKER=1 (ne reconstruit pas).
set -e
cd "$(dirname "$0")"

REPO_ZIP="${REPO_ZIP:-https://github.com/jedifr/Planning/archive/refs/heads/main.zip}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "=== Mise à jour Planning Atelier (sans git) ==="
echo "Téléchargement de la dernière version..."
if command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP/main.zip" "$REPO_ZIP" || DL_KO=1
else
  curl -fsSL -o "$TMP/main.zip" "$REPO_ZIP" || DL_KO=1
fi
if [ -n "$DL_KO" ]; then
  echo "Échec du téléchargement (réseau ou adresse) : mise à jour annulée, rien n'a été modifié."
  exit 1
fi
python3 -m zipfile -e "$TMP/main.zip" "$TMP/x" || { echo "Archive illisible : mise à jour annulée, rien n'a été modifié."; exit 1; }
SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$SRC" ] || [ ! -f "$SRC/server.js" ]; then
  echo "Archive inattendue (server.js introuvable) : mise à jour annulée, rien n'a été modifié."
  exit 1
fi

# Fichiers locaux à préserver (ils existent côté dépôt sous une forme d'exemple ou par défaut).
KEEP="docker-compose.yml Cfg_admin.yml Cfg_backup.yml TM616.env"
for f in $KEEP; do [ -f "$f" ] && cp "$f" "$TMP/keep_$f"; done

cp -r "$SRC"/. .

for f in $KEEP; do
  if [ -f "$TMP/keep_$f" ]; then
    if [ "$f" = "docker-compose.yml" ] && ! cmp -s "$SRC/$f" "$TMP/keep_$f"; then
      cp "$SRC/$f" "$f.nouveau"
      NOUVEAU_COMPOSE=1
    fi
    cp "$TMP/keep_$f" "$f"
  fi
done

[ -f TM616.env ] || { echo "TM616.env absent : création d'un fichier vide."; touch TM616.env; }
[ -f Cfg_admin.yml ] || touch Cfg_admin.yml
[ -f Cfg_backup.yml ] || { [ -f Cfg_backup.yml.example ] && cp Cfg_backup.yml.example Cfg_backup.yml || touch Cfg_backup.yml; }

if [ -n "$NOUVEAU_COMPOSE" ]; then
  echo
  echo "Note : le docker-compose.yml du dépôt diffère du vôtre (votre version est conservée)."
  echo "Comparez si besoin :  diff docker-compose.yml docker-compose.yml.nouveau"
fi

if [ -n "$SANS_DOCKER" ]; then echo "Fichiers mis à jour (SANS_DOCKER : pas de reconstruction)."; exit 0; fi

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
echo "=== Terminé ! Actualisez la page du navigateur (Ctrl+Maj+R) puis reconnectez-vous. ==="
