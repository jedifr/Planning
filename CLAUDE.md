# Planning Atelier — contexte projet

Outil de planification d'atelier (fraisage, tournage, découpe) pour Découpe H2O.
Ordonnancement automatique, suivi des délais, gestion des congés.

## Déploiement

Le projet tourne en Docker sur un NAS Synology DS1817+.

**Mise à jour** : `bash deploy.sh` depuis le dossier du projet — récupère la dernière version
(en gérant proprement d'éventuelles modifications locales sur le NAS, ex. Cfg_admin.yml) puis
reconstruit et redémarre le conteneur. Corrige aussi au passage un piège connu du NAS : son
système de fichiers modifie parfois le bit exécutable des fichiers, ce qui fait apparaître à tort
*tout* le dépôt comme modifié pour git (`git config core.fileMode false` — déjà dans le script).

Sans le script, l'équivalent manuel :
```bash
cd /volume1/TRAVAIL/PLANNING_ATELIER/planning-atelier-serveur
git pull
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
| `sessionHistory.js` | Historique des sessions de travail archivées (voir plus bas). |

Base SQLite, trois tables : `app_state` (l'état entier en JSON + numéro de version), `users`,
et `session_history` (voir ci-dessous). Volume Docker nommé `planning-data`.

**Il n'y a pas d'étape de compilation.** On édite `public/index.html` directement.

## Modèle de données

Tout l'état applicatif est un seul objet JSON (`state`) :

- `config` — horaires, pause déjeuner, couleurs, titre, logo, `copyright`,
  `matiereFusionActive`, `modules.conges`, `storageZones[]` (allées de zones de stockage —
  voir section dédiée plus bas)
- `machines[]` — postes : `nom`, `dispo` (disponible à partir de), `couleur`,
  `horairesActifs`/`horaires` (horaires spécifiques), `indisponibilites[]`,
  `fusionnable`, `transfertFixeMin`, `transfertParPieceMin`
- `commandes[]` — `nom` (référence), `dateBesoin`, `urgence`, `zoneStockage`, `pieces[]`
- `pieces[]` (dans une commande) — `piece`, `etape`, `machineId`, `tempsUnitaire`
  (minutes), `quantite`, `statut`, `phase`, `manualStart`, `dureeOverrideH`,
  `debutReel`, `finReel`, `sessions[]`, `operatorUserId`, `matiere`, `epaisseur`,
  `fusionGroupId`, `fusionPinned`, `sousTraitance`, `dateDebutPossible`,
  `autoPausedOperators`
  - `sousTraitance` se coche **automatiquement** (jamais décoché automatiquement) dès que le poste
    choisi pour la ligne a un nom contenant "sous-traitance"/"sous traitance"
    (`machineNameLooksLikeSousTraitance`) — dans `updateOpField` (ligne d'une commande existante) et
    dans `applyImportProfile` (correspondance de poste de l'import personnalisé). Reste modifiable à
    la main ensuite dans les deux cas.
  - `operatorUserId` de la pièce = **opérateur assigné** (intention de planification, jamais
    écrasé automatiquement). Chaque élément de `sessions[]` porte son propre `operatorUserId`
    = qui a **réellement** ouvert cette session (identité active au moment du clic — voir
    plus bas) : les deux peuvent diverger sur un poste partagé (tâche assignée à Simon,
    démarrée/reprise par Louca). Repli sur l'opérateur assigné pour une session qui n'a pas ce
    champ (données antérieures à ce suivi).
  - `sessions[]` peut contenir **plusieurs entrées ouvertes en même temps** (`fin: null`) sur
    une même pièce : voir « Travail à plusieurs sur une même pièce » ci-dessous. Toujours
    fermer (`.filter(s=>!s.fin).forEach(...)`), jamais une seule (`.find`), en pause/clôture.
- `leaveTypes[]`, `leaveRequests[]`, `userLeaveAllocations`, `userMachines`, `userLunch`
- `importProfiles[]` — profils de correspondance de l'import personnalisé. Le dernier profil
  réellement utilisé (confirmé, pas juste survolé) est proposé par défaut au prochain import via
  `localStorage` (`LAST_IMPORT_PROFILE_KEY`), pas dans `state` — préférence de navigateur, pas
  donnée d'atelier à synchroniser.

`migrateState()` initialise tout nouveau champ sur les sauvegardes existantes.
**Toujours y ajouter les nouveaux champs**, sinon les états anciens plantent ou se
comportent mal.

## Historique des sessions (`session_history`)

Une pièce `termine` voit ses `sessions[]` (détail Démarrer/Pause/Reprendre) archivées puis vidées
de l'état — sans ça, l'état synchronisé à chaque poll grossirait indéfiniment. L'archivage vit dans
une table SQLite **séparée**, jamais incluse dans `app_state` ni dans la synchro habituelle :

- `backfillDureeReelle(st)` fige `dureeReelleH` si besoin — purement local, ne touche jamais
  `sessions[]`.
- `archiveOldSessions(st)` (async) envoie les sessions à `POST /api/session-history`, et **ne vide
  `sessions[]` qu'une fois le serveur confirmé (`res.ok`)**. Un échec réseau laisse les sessions en
  place, retentées au prochain démarrage — jamais de perte de données. Idempotent côté serveur
  (`INSERT OR IGNORE` sur un index unique `piece_id, debut, fin`) : un même lot renvoyé deux fois
  (deux onglets, une retentative) ne crée jamais de doublon.
- La pop-up « Détail des horaires » (`renderTempsProdSessionModal`, onglet Temps de production)
  interroge `GET /api/session-history/:cid/:oid` **à la demande** (jamais au chargement de la page)
  quand `sessions[]` est vide localement, via `tempsProdHistoryCache` (clé `"cid|oid"`). Sans
  historique disponible (tâche terminée avant l'introduction de cette table), elle retombe sur
  `debutReel`/`finReel`/`dureeReelleH` — voir le piège plus bas sur l'affichage du jour dans ce cas.
- Les sauvegardes (`/api/backup/test` et le planificateur) ajoutent `sessionHistory` à la copie en
  mémoire de `app_state` juste avant l'envoi — jamais réenregistré dans `app_state` lui-même.
- Chaque ligne de `session_history` porte l'`operator_user_id` **de la session** (qui l'a
  réellement ouverte), pas celui de la pièce — voir `computeProductionTimeByUser` et la note sur
  `operatorUserId` dans le modèle de données.

### Qui a réellement produit, vs qui est assigné

`applySingleStatusChange` tague chaque session ouverte (`en_cours`) avec `activeIdentityId()` au
moment précis du clic — **jamais** l'opérateur assigné de la pièce, qu'on ne touche que s'il était
vide (auto-remplissage au tout premier démarrage, jamais d'écrasement ensuite). Sur un poste
partagé, une tâche assignée à Simon peut donc être réellement réalisée par Louca : le Kanban
affiche alors « 👤 Simon (assigné) → Louca (réalise) », et `computeProductionTimeByUser` crédite
Louca, pas Simon, pour cette session.

**Reprise automatique après pause déjeuner** (`applyAutoPauseResume`) : ce n'est PAS un clic de
quelqu'un — on conserve l'`operatorUserId` de la session qu'on referme, jamais l'identité active du
poste qui déclenche la reprise (qui peut être n'importe quel navigateur en train de sonder l'état).

### Travail à plusieurs sur une même pièce

Cas volontairement géré, distinct du split en plusieurs lignes utilisé pour deux **machines**
différentes (une ligne par poste) : deux personnes peuvent physiquement travailler **en même
temps sur la même ligne**. `joinOpSession(cid, oid)` (menu contextuel « ➕ Travailler aussi sur
cette tâche », visible seulement si `statut==='en_cours'`) ouvre une session supplémentaire sans
toucher au statut — la pièce peut donc avoir **plusieurs sessions ouvertes simultanément**
(`fin: null`). Avertissement `confirm()` avant de rejoindre : les heures de chacun sont comptées
séparément et **s'additionnent** (2h à deux personnes = 4h cumulées), assumé volontairement — ce
n'est pas un bug de double-comptage, c'est la mesure du travail (main-d'œuvre) réellement investi,
pas du temps d'horloge. `opElapsedHours`/`dureePasseeH` et `computeProductionTimeByUser` n'ont rien
de spécial à faire : ils somment déjà chaque session indépendamment par son propre `operatorUserId`.

Conséquence sur tout code qui ferme une session : `applySingleStatusChange` (pause/clôture) et
`applyAutoPauseResume` (pause déjeuner automatique) doivent fermer **toutes** les sessions
ouvertes (`.filter(s=>!s.fin).forEach(...)`), jamais une seule (`.find(s=>!s.fin)`) — sinon la
session d'un second opérateur resterait ouverte indéfiniment. La reprise automatique après pause
déjeuner rouvre une session par opérateur qui était en train de travailler (`autoPausedOperators`,
peuplé à la pause, vidé à la reprise), pas une seule.

## Temps de production vs présence théorique

**L'application n'a aucun système de pointage réel** (pas d'entrée/sortie physique). La seule
notion de « présence » disponible est donc **théorique** : ce que l'horaire attendait de la
personne, pas une mesure de qui était physiquement là. Onglet « Temps de production »
(`renderTempsProdPage`/`renderTempsProdSelfPage`), superposé au temps de production déjà mesuré
par `computeProductionTimeByUser` :

- `applyUserLunchOverride(cfg, userId, st)` — factorise la logique de surcharge horaire propre à
  une personne (`st.userLunch[userId]` : pause(s) propre(s) et/ou horaire de début/fin), utilisée à
  la fois par `configForPiece` (poste en base, pour planifier une pièce) et `baseConfigForUser`
  (horaire d'atelier `st.config` en base, pour estimer la présence théorique) — même règle de
  surcharge dans les deux cas, ne jamais la dupliquer une troisième fois.
- `theoreticalPresenceHoursForUser(userId, st, periodStart, periodEnd)` — somme les horaires
  nominaux (`dayHoursFor`) de chaque jour ouvré (lun-ven, hors jours fériés français via
  `isFrenchPublicHoliday`) de la période, moins les jours couverts par un congé **approuvé**
  (`leaveRequests` avec `statut==='approuve'` ; une demande encore `en_attente` ne compte pas).
  Ignore volontairement les indisponibilités de poste (`machine.indisponibilites`) : une machine en
  maintenance n'implique pas que la personne est absente.
- `tempsProdRows(byUser, periodStart, periodEnd)` — `periodStart`/`periodEnd` sont optionnels
  (compatibilité) ; fournis, chaque ligne gagne `presenceH` (présence théorique) et
  `tauxOccupation` (`totalH / presenceH`, `null` si présence nulle sur la période). Le taux peut
  dépasser 100% (heures supplémentaires, ou travail à plusieurs sur une même pièce qui additionne
  le temps de chaque opérateur — voir plus haut) : ce n'est pas traité comme une anomalie en soi.
  Nouvelles clés de tri : `'presence'` et `'taux'`.
  - **Salariés attendus mais sans aucune tâche suivie.** Avec une période fournie, la liste ne se
    limite plus aux clés de `byUser` (qui n'a une entrée que pour un salarié ayant au moins une
    session/tâche mesurable) : elle s'étend à tout `usersList` ayant une présence théorique non
    nulle sur la période, même à 0 tâche — pour repérer quelqu'un censé travailler mais totalement
    absent des données de production (jamais démarré/repris une tâche via l'appli), pas seulement
    ceux qui ont un temps de production à comparer. Un salarié ni attendu ni actif (ex. congé
    couvrant toute la période, sans tâche) est en revanche filtré — rien à montrer. Ne change rien
    sans période fournie (comportement identique à avant cette fonctionnalité).
- `occupationBarColor(taux)` / `renderOccupationBar(taux, big)` — barre de progression (pas un
  simple texte coloré) : rouge sous 50%, ambre entre 50 et 80%, vert au-delà, accent au-delà de
  120% (heures sup/travail à plusieurs, volontairement distingué d'une anomalie). Le remplissage
  visuel est plafonné à 100% de largeur (au-delà, seule la couleur change) pour ne jamais donner
  l'impression que la barre déborde de son cadre. `big=true` pour la variante plus grande utilisée
  dans la tuile de stat de « Mon temps de production ».
- Colonne « Présence théo. » (texte) et « Taux d'occupation » (barre `renderOccupationBar`) dans
  le tableau superviseur, équivalents dans la vue « Mon temps de production » (présence en texte,
  occupation en grande barre `big`), et deux colonnes numériques supplémentaires (présence en
  heures, occupation en %) dans l'export Excel (feuille Résumé) — l'export garde des nombres bruts,
  pas la barre, qui n'a de sens qu'à l'écran.

## Zones de stockage

Emplacements physiques où sont entreposées les pièces d'une commande pendant sa production.
**Paramétrable** (Paramètres → Zones de stockage) : `state.config.storageZones[]` est la liste des
**allées** — `{ id, code, nom, nbEmplacements, couleur }`. Une allée de code `"B"` et
`nbEmplacements:16` produit les emplacements `B1`…`B16`. `DEFAULT_STORAGE_ZONES` (3 allées A/B/C de
16, sans nom, couleurs de `MACHINE_COLORS`) est la valeur de migration — reprise telle quelle par
`migrateState` sur une installation existante pour ne rien changer aux zones déjà attribuées.
Attribut de la **commande** (`zoneStockage`, une chaîne comme `"B7"`), pas de la pièce : toutes les
pièces d'une commande partagent une seule zone. Plusieurs commandes peuvent aussi partager
volontairement la même zone (regroupement manuel de petites affaires dans un même casier) — voir
`setCommandeZone` ci-dessous.

- `computeStorageZones(st)` — reconstruit `{ list, byCode }` à partir de `st.config.storageZones` :
  `list` est la liste à plat de tous les codes de zone dans l'ordre des allées, `byCode` associe
  chaque code à son allée (pour la couleur/le nom). Remplace l'ancienne constante figée
  `STORAGE_ZONES` — **toujours** passer par cette fonction plutôt que de reconstruire la liste
  ailleurs, sinon un changement de configuration (allée ajoutée/redimensionnée) ne serait pas pris
  en compte partout.
- `isCommandeFullyDone(c)` — même condition que le badge "Terminée" de `renderCommandeCard`
  (`pieces.length>0 && pieces.every(termine)`) — une commande dans cet état n'occupe plus rien,
  **même si `zoneStockage` n'est pas effacé** (trace historique volontairement conservée).
- `occupiedStorageZones(st, excludeCommandeId)` — l'ENSEMBLE des zones occupées par au moins une
  commande active (donc pas totalement terminée) autre que `excludeCommandeId`. Sert uniquement à
  `assignStorageZone` pour trouver une zone **entièrement vide** — ne dit pas combien ni qui.
- `commandesInZone(st, zone, excludeCommandeId)` — la LISTE des commandes actives occupant
  précisément une zone donnée (hors `excludeCommandeId`), potentiellement plusieurs si regroupées
  manuellement. Sert au badge (`renderCommandeCard`) et à la page "Zones de stockage" pour afficher
  qui est déjà là.
- `assignStorageZone(st, c)` — attribue la première zone de `computeStorageZones(st).list`
  **entièrement vide** à une commande qui n'en a pas encore ; ne fait rien si elle en a déjà une, si
  elle est déjà totalement terminée, ou si toutes les zones sont occupées (reste alors `null` jusqu'à
  une attribution manuelle). Ne rejoint jamais automatiquement une zone déjà partagée — le
  regroupement reste un choix humain délibéré. Appelée à chaque création de commande (les trois
  `targetState.commandes.push(...)`, dont celui de l'import personnalisé) et une seule fois au
  chargement pour les commandes déjà en cours au moment de l'introduction de cette fonctionnalité
  (`migrateState`, garde `_zonesStockageMigrated` — ne retente jamais après coup, y compris si une
  zone se libère : seules la création d'une commande ou l'action manuelle réattribuent).
- `setCommandeZone(cid, zone)` — changement manuel depuis le badge "📍 Zone" (`renderCommandeCard`).
  Contrairement à `assignStorageZone`, autorise le regroupement dans une zone déjà occupée par
  d'autres commandes actives, mais demande confirmation (`confirm()`, listant qui est déjà là) avant
  de le faire — jamais silencieux. Réattribuer à une commande sa PROPRE zone déjà occupée ne redemande
  rien (pas de faux-positif, `commandesInZone` exclut `cid`).
- **Zone "hors configuration actuelle"** : si une allée est supprimée ou réduite (Paramètres) après
  qu'une commande y a été assignée, cette commande garde sa valeur de `zoneStockage` **telle quelle**
  (jamais effacée automatiquement) mais le code n'apparaît plus dans `computeStorageZones(...).list` —
  `renderCommandeCard` l'ajoute alors comme option supplémentaire du menu déroulant (étiquetée "hors
  configuration actuelle") pour ne jamais la perdre silencieusement du `<select>`, et `renderZonesPage`
  la signale dans une note dédiée plutôt que dans la grille (qui n'affiche que les emplacements
  encore configurés). `removeStorageAllee` avertit explicitement (via `confirm()`, en les nommant) si
  des commandes actives seraient concernées avant de supprimer une allée.
- Page "📍 Zones de stockage" (`renderZonesPage`, `currentPage==='zones'`) — vue d'ensemble en
  lecture, une ligne par allée dans l'ordre de `state.config.storageZones`, colorée avec la couleur
  de l'allée ; hauteur de ligne homogène entre toutes les allées (`grid-auto-rows` sur
  `.zone-row-cells` + `min-height` sur `.zone-cell`), qu'une case contienne 0, 1 ou plusieurs
  commandes regroupées. Cliquer le nom d'une commande occupante l'isole dans le planning
  (`selectedCommandeId` + retour à `currentPage='planning'`).
- Paramètres → Zones de stockage (`sectionDefs.storageZones`) — une carte par allée (réutilise les
  classes `.machine-card`/`.machines-grid`/`.add-machine-row` des postes, par cohérence visuelle) :
  couleur, code (préfixe, unique — `updateStorageAllee` refuse un doublon), nom optionnel, nombre
  d'emplacements. `addStorageAllee` propose automatiquement la prochaine lettre A-Z libre.
- Kanban (`renderKanbanView`) — chaque carte affiche « 📍 {zone} », coloré selon l'allée
  (`computeStorageZones` calculé une fois par rendu, pas par carte), quand sa commande en a une, sauf
  sur une carte fusionnée multi-commandes (`o._fusionMembers`) : `o.zoneStockage` n'y porterait que
  la zone du premier membre du groupe, ce qui serait trompeur pour les autres — volontairement omis
  dans ce cas plutôt que d'afficher une info fausse.
- **Notification de la zone à la création** : `newCommandeZoneNotice` (`{ nom, zoneStockage } | null`)
  déclenche une pop-up dédiée (`renderNewCommandeZoneNoticeModal`) juste après la création manuelle
  d'une commande (`submitNewCommande`, uniquement dans les branches qui créent VRAIMENT une nouvelle
  commande — pas quand des lignes s'ajoutent à une commande déjà existante du même nom, où aucune
  zone n'est réattribuée). L'import (Excel ou personnalisé) n'utilise pas cette pop-up à une seule
  commande : `commitImportGroups` porte `zoneStockage` sur chaque entrée de `createdNoms`, et
  `renderExcelImportModal` (déjà partagée par les deux flux d'import) l'affiche directement dans sa
  colonne "Zone de stockage" du tableau récapitulatif — plus adapté qu'une pop-up par commande quand
  un import en crée plusieurs d'un coup.
- **Casiers désactivés** (`state.config.inactiveStorageZones`, simple tableau de codes comme `"A13"`)
  — un casier cassé/réservé, à sortir de la rotation. `isZoneInactive(st, zone)` : jamais proposé par
  `assignStorageZone` (exclu de la sélection automatique) ni acceptable par `setCommandeZone`
  (refusé avec message). `toggleStorageZoneActive(zone)`, déclenché en cliquant une case **libre**
  de `renderZonesPage`, bascule l'état — refuse de désactiver une zone actuellement occupée
  (`commandesInZone` non vide : il faut d'abord la libérer). Rendu : case hachurée rouge avec
  « 🚫 Désactivée » dans la grille, option `disabled` (avec la mention "désactivée") dans le menu
  déroulant `renderCommandeCard` — sauf si c'est déjà la zone en cours de cette commande, jamais
  masquée pour ne pas la faire disparaître du `<select>` sans explication. Comme pour un allée
  réduite/supprimée, un code désactivé n'est jamais nettoyé automatiquement des données existantes
  (mêmes conséquences inoffensives qu'une zone "hors configuration actuelle").

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
- **Restauration du focus sur une ligne répétée sans identifiant unique reconnu.**
  `captureFocusRef()`/`restoreFocusRef()` retrouvent le champ actif après un `render()` via un
  sélecteur CSS construit à partir d'une liste fixe d'attributs (`data-action`, `data-field`,
  `data-cid`, `data-oid`, `data-idx`...). Les lignes du formulaire "Nouvelle commande"
  (`renderDraftOpRow`) n'utilisent QUE `data-idx` pour distinguer une ligne d'une autre (pas de
  `data-cid`/`data-oid`, ces pièces n'existent pas encore) — `data-idx` manquait de cette liste, donc
  le sélecteur reconstruit après le `render()` déclenché par `updateDraftOpField`/`updateDraftOpDuree`
  ne contenait que `data-action`+`data-field`, communs à toutes les lignes : `document.querySelector`
  renvoyait toujours le premier élément correspondant, ramenant le focus sur la ligne 1 quel que soit
  la ligne modifiée (bug rapporté : taper le temps unitaire/la quantité/la durée sur une ligne 2+ fait
  sauter le curseur sur ce même champ, mais ligne 1). Réflexe : tout nouvel attribut `data-*` servant
  à distinguer des lignes répétées d'un même formulaire doit être ajouté à la liste `attrs` de
  `captureFocusRef`, pas seulement utilisé dans le marquage HTML.
- **Vider une donnée avant confirmation de son archivage.** `archiveOldSessions()` ne met
  `o.sessions = []` qu'après un `POST /api/session-history` réussi — vider d'abord et archiver
  ensuite perdrait ces horaires pour toujours au moindre problème réseau.
- **Fermer une seule session avec `.find` alors que plusieurs peuvent être ouvertes.** Depuis
  l'ajout du travail à plusieurs sur une même pièce (`joinOpSession`), `o.sessions` peut avoir
  2+ entrées avec `fin: null` en même temps. Un `.find(s=>!s.fin)` (comme l'ancien code de pause/
  clôture) n'en ferme qu'une seule et laisse les autres ouvertes pour toujours, gonflant
  indéfiniment `opElapsedHours`. Toujours `.filter(s=>!s.fin).forEach(...)`.
- **N'afficher que le jour du début sur une plage début/fin.** Une pièce `termine` sans
  `sessions[]` (déjà archivées, ou terminée avant l'introduction de `session_history`) n'a plus que
  `debutReel`/`finReel`, qui peuvent tomber des jours différents (nuit, week-end, pause entre deux
  reprises). Un rendu du type "Jour : {jour du début}" fait croire à tort que tout s'est joué ce
  jour-là (bug réel : une tâche commencée un vendredi et terminée le lundi suivant affichait
  seulement "vendredi"). Toujours comparer les deux dates et afficher la plage si elles diffèrent.

## Conventions

- **Interface entièrement en français**, y compris les messages d'erreur.
- Commentaires de code en français, expliquant le *pourquoi* (souvent un bug passé),
  pas le *quoi*.
- Les styles du tableau des tâches (`table.ops-table`) sont volontairement discrets :
  champs sans bordure au repos, révélés au survol et au focus.
- Ne pas ajouter de dépendance sans nécessité : le client est volontairement sans
  framework ni build.
