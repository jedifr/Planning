# Planning Atelier — contexte projet

Outil de planification d'atelier (fraisage, tournage, découpe) pour Découpe H2O.
Ordonnancement automatique, suivi des délais, gestion des congés.

## Déploiement

Le projet tourne en Docker sur un NAS Synology DS1817+.

```bash
cd /volume1/TRAVAIL/PLANNING_ATELIER/planning-atelier-serveur
sudo docker compose down
sudo docker compose up -d --build
```

Accès : `http://<IP-NAS>:3000` (exposé en HTTPS via reverse proxy Synology).

**Après chaque déploiement, forcer le rechargement du navigateur** (Ctrl+Maj+R). Le
cache a déjà provoqué de fausses pistes de débogage.

## Architecture

| Fichier | Rôle |
|---|---|
| `public/index.html` | **Toute l'application cliente** — ~6600 lignes, ~6000 de JS dans une seule balise `<script>`, ~290 fonctions. Pas de framework, pas de build. |
| `server.js` | Express + better-sqlite3. Sert le statique, expose l'API d'état, gère les congés. |
| `auth.js` | Sessions (express-session), bcryptjs, rôles, réinitialisation de mot de passe. |
| `backup.js` | Sauvegarde automatique par e-mail (nodemailer). |

Base SQLite, deux tables : `app_state` (l'état entier en JSON + numéro de version) et
`users`. Volume Docker nommé `planning-data`.

**Il n'y a pas d'étape de compilation.** On édite `public/index.html` directement.

## Modèle de données

Tout l'état applicatif est un seul objet JSON (`state`) :

- `config` — horaires, pause déjeuner, couleurs, titre, logo, `copyright`,
  `matiereFusionActive`, `modules.conges`
- `machines[]` — postes : `nom`, `dispo` (disponible à partir de), `couleur`,
  `horairesActifs`/`horaires` (horaires spécifiques), `indisponibilites[]`,
  `fusionnable`, `transfertFixeMin`, `transfertParPieceMin`
- `commandes[]` — `nom` (référence), `dateBesoin`, `urgence`, `pieces[]`
- `pieces[]` (dans une commande) — `piece`, `etape`, `machineId`, `tempsUnitaire`
  (minutes), `quantite`, `statut`, `phase`, `manualStart`, `dureeOverrideH`,
  `debutReel`, `finReel`, `sessions[]`, `operatorUserId`, `matiere`, `epaisseur`,
  `fusionGroupId`, `fusionPinned`, `sousTraitance`, `dateDebutPossible`
- `leaveTypes[]`, `leaveRequests[]`, `userLeaveAllocations`, `userMachines`, `userLunch`
- `importProfiles[]` — profils de correspondance de l'import personnalisé

`migrateState()` initialise tout nouveau champ sur les sauvegardes existantes.
**Toujours y ajouter les nouveaux champs**, sinon les états anciens plantent ou se
comportent mal.

## Moteur de planification — `computeSchedule(st)`

Le cœur du produit. Trois phases :

1. **Verrouillage des tâches réellement démarrées.** Une tâche `en_cours`/`en_pause`
   est toujours ancrée sur son démarrage réel (`manualStart`, sinon `debutReel`,
   sinon première session), **même si elle est volante**. Sinon elle retombe dans la
   file d'attente et peut être classée après des tâches pas encore commencées.
2. **Tâches terminées** (horaires réels) et **tâches figées** (`manualStart`).
   `resolveOverlap()` ignore les conflits entre pièces d'un même `fusionGroupId`.
3. **Tâches volantes**, par priorité : urgence, puis échéance, puis phase.
   `findNextFreeSlot()` cherche un vrai créneau libre (remplissage des trous).
   `machineDispoFloor` est un plancher fixe, jamais modifié en phase 3.
   Un groupe fusionné **non figé** (`fusionPinned=false`) n'est pas éclaté en pièces
   indépendantes : ses membres sont regroupés en **un seul candidat** (même poste, durée
   totale, priorité = celle de son membre le plus prioritaire) qui concourt comme
   n'importe quelle tâche volante — voir le regroupement juste avant la boucle de phase 3
   dans `computeSchedule`.

### Dépendances de phase

Elles s'appliquent **par pièce** (rapprochement sur le nom de pièce, insensible à la
casse), pas à l'échelle de la commande. Deux pièces d'une même commande suivent chacune
leur cycle.

**Exception** : une pièce fusionnée est traitée avec ses partenaires, donc la phase
suivante attend la fin du bloc entier.

### Temps de transfert

Réglé **par poste de départ**, en minutes : `transfertFixeMin + transfertParPieceMin × quantité`.
Appliqué même si la phase suivante reste sur le même poste. S'écoule sur les horaires
d'atelier via `addWorkingDuration` (un transfert ne court pas la nuit).

## Regroupement (fusion)

Trois mécanismes **indépendants** produisent un `fusionGroupId` :

1. **Case « Regrouper »** de l'import personnalisé — regroupe toutes les pièces d'une
   même valeur de colonne, sans condition.
2. **Détection matière/épaisseur** — panneau « Regroupements possibles », visible
   uniquement si `config.matiereFusionActive` est activé (Paramètres → Postes).
3. **Bouton manuel** « Regrouper les lignes du même poste » en création de commande.

Les membres d'un groupe partagent `dureeOverrideH` (somme des durées) et, s'il est figé,
`manualStart`. Toute modification (glisser, redimensionner, changer de statut, figer,
libérer) doit se propager à tout le groupe — voir `propagateFusionGroupFields()`.

**Deux modes, portés par `fusionPinned`** :
- **Automatique (`fusionPinned=false`, par défaut à la création)** — pas de `manualStart` :
  le groupe est traité en phase 3 comme un candidat unique qui concourt par priorité
  avec les autres tâches volantes (voir plus haut). C'est la position qui s'affiche et se
  recalcule à chaque changement de planning — jamais figée dans le temps.
- **Figé (`fusionPinned=true`)** — `manualStart` posé sur tous les membres, activé par un
  glisser-déposer, une saisie de date (`setManualStartValue`, `updateFusionGroupStart`,
  `pinOpAtCurrentTime`) ou le contexte-menu « Figer à cet horaire ». Comportement inchangé
  depuis toujours : jamais concerné par le remplissage des trous, position toujours
  respectée.

**Sémantique à respecter** :
- « Libérer » (double-clic, bouton ↺, ou panneau des groupes) = repasser tout le groupe en
  mode automatique (`fusionPinned=false`, `manualStart=null`) — plus jamais besoin de
  recalculer une position ici, la phase 3 s'en charge à chaque appel de `computeSchedule`.
- « Dissocier » (pop-up de regroupement) = seul moyen de casser réellement un groupe
  (`fusionGroupId=null`, redevient indépendant).
- `isPositionPinned(o)` est le point unique qui décide si une pièce affiche le badge
  « 📌 Figée » — pour une pièce fusionnée, il regarde `fusionPinned`, jamais la simple
  présence de `dureeOverrideH` (toujours posé sur un groupe, figé ou non).

## Tests

Il n'y a pas de framework de test. La méthode utilisée, efficace sur ce projet :

```bash
# 1. Extraire le JS de la page
python3 -c "
import re
html = open('public/index.html').read()
m = re.search(r'<script>(.*)</script>', html, re.S)
open('/tmp/app.js','w').write(m.group(1))
"
node --check /tmp/app.js   # vérification syntaxique

# 2. Couper avant les gestionnaires DOM (qui référencent `document`)
grep -n "^document.addEventListener" /tmp/app.js | head -1
sed -n '1,<ligne-1>p' /tmp/app.js > /tmp/engine.js

# 3. Concaténer avec un script de test qui bouchonne render/saveState/etc.
cat /tmp/engine.js /tmp/mon_test.js > /tmp/run.js && node /tmp/run.js
```

Bouchons habituels : `render`, `saveState`, `saveStateWithReapply`, `showToast`,
`escapeHtml`, `uid`, `usersList`, et un `document = { addEventListener: () => {} }`
placé **avant** le moteur si besoin.

Pour figer l'heure : remplacer `global.Date` par une sous-classe dont le constructeur
sans argument renvoie une date fixe.

**Toujours relancer les tests de non-régression du moteur** (dépendances en diamant,
tâche en cours, tâche figée) après toute modification de `computeSchedule`.

## Pièges déjà rencontrés — ne pas les réintroduire

- **Casse et espaces des valeurs d'import.** « Laser 2D » et « laser 2d » créaient deux
  entrées distinctes. Tout est normalisé via `normPosteKey()`. Les clés de
  `posteMapping`, `groupByValue`, `sousTraitanceByValue` sont **toujours normalisées**.
- **Mutation du planning sans invalider le cache avant de le relire.** `scheduleCache`
  n'est recalculé que par `invalidateSchedule()` (par défaut dans `commit()`). Deux bugs
  distincts en ont découlé : la reprise automatique de pause déjeuner (`setInterval` dans
  `startApp`) mutait `state` puis appelait `render()` sans invalider — l'affichage
  réutilisait l'ancien planning, les tâches suivantes ne se décalaient qu'au F5 suivant.
  Et `resetOpOverride()` (« Libérer » un groupe fusionné) détachait les membres puis
  appelait `performFusion()`, qui relisait aussitôt `getSchedule()` — encore le planning
  d'AVANT la libération — et retrouvait donc quasiment la même position : « Libérer »
  semblait n'avoir aucun effet. Réflexe : après toute mutation directe de `state` hors de
  `commit()`, invalider explicitement avant de relire `getSchedule()`/`computeSchedule()`.
- **Dépendance de phase à travers un groupe fusionné non lié.** `resolveEffectiveDeps()`
  faisait dépendre une étape d'une pièce (ex. son Laser, phase basse) d'un groupe fusionné
  auquel cette même pièce participe via une AUTRE étape plus tardive (ex. sa Chaudronnerie,
  fusionnée avec d'autres pièces à phase basse) — sans vérifier que MA propre participation
  à ce groupe se situe bien avant l'étape évaluée. Corrigé en comparant la phase de ma
  propre ligne dans ce groupe à la phase courante, pas seulement la phase des autres membres.
- **Doubles enregistrements concurrents.** Enchaîner deux `commit()` déclenche un conflit
  de version (« Quelqu'un d'autre vient de modifier le planning ») et **perd la
  modification**. `performFusion(items, skipCommit)` existe pour ça. Vérifier qu'une
  action ne produit qu'un seul enregistrement.
- **Champs qui s'effacent en cours de frappe.** `pollRemoteState()` doit re-vérifier
  `isTypingInField()` **après** l'attente réseau, pas seulement avant. Le formulaire
  « Nouvelle commande » mémorise aussi la saisie au fil de la frappe (gestionnaire
  `input`), pour qu'un redessin ne perde rien.
- **Clic simple contre double-clic.** L'ouverture de la pop-up de regroupement et
  l'isolement de commande sont différés (~300 ms) pour qu'un double-clic les annule.
- **Texte échappé dans les infobulles.** Le libellé passe par `escapeHtml` : y injecter
  du HTML (`<br>`) affiche les balises littéralement.
- **Champs de configuration texte.** `updateConfig` convertit par défaut en nombre ;
  un nouveau champ texte a besoin de son cas explicite, sinon il est silencieusement ignoré.

## Conventions

- **Interface entièrement en français**, y compris les messages d'erreur.
- Commentaires de code en français, expliquant le *pourquoi* (souvent un bug passé),
  pas le *quoi*.
- Les styles du tableau des tâches (`table.ops-table`) sont volontairement discrets :
  champs sans bordure au repos, révélés au survol et au focus.
- Ne pas ajouter de dépendance sans nécessité : le client est volontairement sans
  framework ni build.
