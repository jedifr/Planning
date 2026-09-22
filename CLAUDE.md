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

### Fuseau horaire

`server.js` fixe `process.env.TZ = 'Europe/Paris'` tout en tête du fichier, avant le moindre
`require()` — cette application ne sert qu'un seul client français (interface entièrement en
français, jours fériés déjà codés en dur pour la France), il n'y a donc jamais de raison de
dépendre du fuseau horaire de l'hôte. Un conteneur Docker sans `TZ` explicite tourne par défaut en
UTC : sans ce correctif, `new Date()` et le parsing des horaires naïfs `"AAAA-MM-JJTHH:mm"`
(`sessions[]`, `debutReel`/`finReel`...) étaient décalés côté serveur de l'écart UTC/Europe-Paris
courant (2h en heure d'été) par rapport à l'heure réelle du navigateur — voir le piège dédié plus
bas (« Job serveur qui interprète les horaires dans le fuseau de l'hôte, pas celui de la France »).
`docker-compose.yml` porte aussi `TZ: "Europe/Paris"` en complément (documente l'intention, couvre
ce qui ne passerait pas par `server.js`, ex. horodatages des logs Docker) — mais ne pas s'y fier
seul : c'est le `process.env.TZ` de `server.js` qui fait foi, justement pour ne jamais dépendre d'un
réglage d'environnement qu'on pourrait oublier lors d'un futur redéploiement.

### Rechargement automatique après déploiement

Un Ctrl+Maj+R manuel après chaque déploiement a longtemps été nécessaire (le cache navigateur a
déjà provoqué de fausses pistes de débogage — une fonctionnalité "manquante" alors qu'elle était
juste servie par une page restée ouverte, jamais rechargée). Deux mécanismes, ajoutés ensemble,
rendent ce geste manuel inutile dans le cas courant :

- **`index.html` n'est plus jamais mis en cache sans revalidation** (`Cache-Control: no-cache`, posé
  par `server.js` aux trois points qui le servent — `express.static`, et la route `*` de secours).
  Un F5 tout simple (ou n'importe quel rechargement programmatique) obtient donc toujours les octets
  réellement déployés, sans avoir besoin d'un vidage de cache forcé.
- **Détection automatique côté client** (`checkAppVersion()`, appelée à chaque `pollRemoteState()` —
  aucune requête supplémentaire, `APP_VERSION` du code effectivement servi est déjà inclus dans la
  réponse `/api/state`, lue une seule fois par `server.js` au démarrage directement dans
  `public/index.html`). Dès qu'un déploiement a eu lieu pendant qu'une page reste ouverte :
  rechargement immédiat (`location.reload()`) si rien n'est en cours (saisie, glisser-déposer,
  pop-up Paramètres, sauvegarde en vol — mêmes conditions que celles qui protègent déjà
  l'application d'un état distant reçu par ce même poll) ; sinon un bandeau discret
  (`#update-banner`, hors de `#app` — jamais reconstruit par `render()`, donc jamais un risque de
  couper une saisie en cours) reste affiché avec un bouton "Recharger maintenant", et le
  rechargement automatique est retenté à chaque poll suivant jusqu'à ce que ce soit sûr.
- **Portée réelle de la détection automatique : dépend de la survie de la session au redémarrage du
  conteneur.** `server.js` utilise le `MemoryStore` par défaut d'`express-session` (aucun `store:`
  configuré) : toute session, quel que soit `SESSION_SECRET`, est perdue à chaque redémarrage du
  processus — `deploy.sh` en déclenche systématiquement un (`docker compose up -d --build`). Le
  premier `pollRemoteState()` suivant un déploiement reçoit donc en général un 401 AVANT même
  d'atteindre `checkAppVersion()` (`if(res.status===401) return;` — volontairement silencieux, pour
  ne pas arracher l'utilisateur à ce qu'il regarde ; voir plus bas), et l'utilisateur ne sera invité
  à se reconnecter qu'à sa prochaine action mutante (qui, elle, ramène à l'écran de connexion —
  lequel charge de toute façon la dernière version). Le rechargement automatique/bandeau ne se
  déclenche donc de façon fiable que si la session survit (déploiement n'ayant pas redémarré le
  conteneur, ou session store devenu persistant un jour) — dans le cas courant actuel, c'est surtout
  le correctif `Cache-Control` ci-dessus qui garantit qu'on ne charge jamais une version périmée,
  quel que soit le chemin (reconnexion normale ou rechargement déclenché par le bandeau).

## Architecture

| Fichier | Rôle |
|---|---|
| `public/index.html` | **Toute l'application cliente** — ~6600 lignes, ~6000 de JS dans une seule balise `<script>`, ~290 fonctions. Pas de framework, pas de build. |
| `server.js` | Express + better-sqlite3. Sert le statique, expose l'API d'état, gère les congés. |
| `auth.js` | Sessions (express-session), bcryptjs, rôles, réinitialisation de mot de passe. |
| `backup.js` | Sauvegarde automatique par e-mail (nodemailer). |
| `sessionHistory.js` | Historique des sessions de travail archivées (voir plus bas). |
| `previsionHistory.js` | Historique des prévisions du moteur avant clôture d'une tâche (voir plus bas). |
| `autoPauseResume.js` | Reprise automatique de pause déjeuner par personne, tournée côté serveur (voir plus bas). |

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
  `autoPausedOperators`, `autoPausedUntil`, `pauseReminderSnoozeUntil`, `numeroLigne`,
  `previsionAvantCloture`, `horsPlanning`, `dureeReelleH`, `dureeReelleParOperateur` (voir sections
  dédiées plus bas)
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
- `leaveTypes[]`, `leaveRequests[]`, `userLeaveAllocations`, `userMachines`, `userLunch`,
  `userDefaultPage` (page d'accueil par défaut de chaque personne — voir section dédiée plus bas)
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

**Répartition par opérateur figée à la clôture (`pieces[].dureeReelleParOperateur`).** À la clôture
(`applySingleStatusChange`, branche `termine`), `sessions[]` est vidé dans la foulée (pas d'attente
de l'archivage serveur ici — différent de `archiveOldSessions`/`session_history` plus haut, qui
lui attend bien la confirmation) : sans précaution, `computeProductionTimeByUser` n'aurait plus que
l'opérateur ASSIGNÉ (`o.operatorUserId`) à créditer pour tout `dureeReelleH`, **quel que soit qui
avait réellement ouvert les sessions** — bug réel corrigé (Romain avait réellement produit des
pièces assignées à Sébastien ; une fois clôturées, tout leur temps était compté sur Sébastien).
`computeSessionsHoursByOperator(o, st)` calcule la répartition **avant** que `sessions[]` ne soit
vidé (même endroit, même instant que le calcul de `dureeReelleH` lui-même) et la fige dans
`dureeReelleParOperateur` (`{ [operatorUserId]: heures } | null`) ; `computeProductionTimeByUser`
lit ce champ en priorité pour une pièce `termine` sans `sessions[]`, et ne retombe sur l'opérateur
assigné (comportement historique, inchangé) que si ce champ est absent — pièce jamais démarrée via
Démarrer/Reprendre (import déjà terminé, temps saisi à la main), ou clôturée avant l'introduction de
ce champ. `backfillDureeReelle` (rattrapage de pièces déjà terminées avec `sessions[]` encore
peuplé, legacy) fige la même répartition en même temps que `dureeReelleH`. Remis à `null` en même
temps que `dureeReelleH` à la réouverture (`↺ Rouvrir`) — la répartition, comme le total, sera
reconstituée à la prochaine clôture. **Ne recouvre pas rétroactivement les pièces déjà closes avant
ce correctif** : leur `sessions[]` étant déjà vide, l'opérateur réel n'y est plus récupérable — seuls
les temps de production comptés à partir de ce correctif sont concernés.

**Correction manuelle (bouton « ✎ Opérateur »).** Pour justement rattraper les pièces déjà closes
avant le correctif ci-dessus (temps réellement passé mal attribué, sans espoir de le retrouver
automatiquement), un bouton apparaît sur la page **Temps de production** (`renderTempsProdDetail`,
colonne "Temps passé" du détail par salarié — superviseur et « Mon temps de production »), pas sur
le planning : c'est là que se lit et se corrige l'attribution du temps de production, pas dans le
tableau des tâches. `isCorrectableProductionEntry(cid, oid)` — garde-fou affiché uniquement
`canSupervise()` **et** pour une pièce `termine` avec un `dureeReelleH` positif : sur une pièce
encore `en_cours`/`en_pause`, `sessions[]` existe toujours et prime dans
`computeProductionTimeByUser` (voir plus haut) — corriger `dureeReelleParOperateur` n'y aurait
alors aucun effet visible, d'où l'exclusion explicite plutôt qu'un bouton trompeur qui ne changerait
rien. `openCorrectOperator(cid, oid)`/`renderCorrectOperatorModal` : petit formulaire qui préremplit
la personne actuellement créditée (celle de `dureeReelleParOperateur` s'il n'y en a qu'une, sinon
l'opérateur assigné) et laisse en choisir une autre. `submitCorrectOperator()` réattribue
**l'intégralité** du temps réellement passé à la personne choisie
(`o.dureeReelleParOperateur = { [id]: o.dureeReelleH }`) — pas de répartition partielle entre
plusieurs personnes : le cas visé est justement « tout ce temps était en fait celui de quelqu'un
d'autre », pas un partage à corriger finement. `renderCorrectOperatorModal()` fait partie de la
composition `render()` de la page Temps de production (`currentPage==='tempsProd'`), pas de celle du
planning.

**Reprise automatique après pause déjeuner** (`applyAutoPauseResume`) : ce n'est PAS un clic de
quelqu'un — on conserve l'`operatorUserId` de la session qu'on referme, jamais l'identité active du
poste qui déclenche la reprise (qui peut être n'importe quel navigateur en train de sonder l'état).
Horodatage de la session rouverte : `o.autoPausedUntil` (l'heure à laquelle la pause aurait dû
réellement se terminer, mémorisée dès l'auto-mise en pause), **jamais** l'instant où ce contrôle
s'exécute réellement — voir le piège dédié plus bas (« Reprise automatique après pause horodatée au
moment du contrôle, pas à la vraie fin de pause »). Ce même calcul tourne désormais **aussi** côté
serveur, indépendamment de tout onglet ouvert — voir « Fiabilisation côté serveur » ci-dessous.

**Bannière « tâches en pause depuis la veille ou avant »** (vue superviseur/admin,
`renderPausedTasksBanner`/`pausedSinceEarlierTasks`) affiche qui travaillait au moment de la mise en
pause (`pausedByUserIds` : toutes les sessions fermées exactement à `pausedAt`, réparties si travail
à plusieurs — voir ci-dessous — repli sur `o.operatorUserId` pour une session sans son propre
`operatorUserId`). C'est qui **travaillait**, pas forcément qui a cliqué « Pause » (une mise en
pause manuelle ne re-tague rien, contrairement à l'ouverture d'une session) — un superviseur peut
mettre en pause le poste de quelqu'un d'autre ; l'affichage reste correct dans ce cas au sens où il
répond quand même à « qui était sur cette tâche », l'info concrètement utile ici.

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
session d'un second opérateur resterait ouverte indéfiniment. `autoPausedOperators` (peuplé à la
mise en pause, un id par opérateur dont une session vient d'être fermée) sert désormais à savoir
**qui** doit confirmer son retour dans la pop-up de rappel — voir « Pop-up de retour de pause
déjeuner » plus bas — jamais à rouvrir une session tout seul.

### Mise en pause automatique de la pause déjeuner, fiabilisée côté serveur (`autoPauseResume.js`)

Retour utilisateur réel : les salariés n'ont ni les mêmes horaires ni la même durée de pause (ex.
Romain 7h45-16h30, Sébastien 7h00-17h30, pauses de durées différentes) — déjà couvert par
`userLunch[userId]` (voir ci-dessus), mais `applyAutoPauseResume` ne s'exécutait jusqu'ici que dans
la boucle de 60s d'un onglet client ouvert (`startApp`) : sans personne connecté au moment où la
pause déjeuner démarre (fréquent avec des horaires décalés par personne, ou un poste sans
surveillance), la mise en pause n'était constatée qu'à la prochaine connexion.

**Ne couvre plus que la mise en pause (entrée en pause), jamais la reprise** — la reprise
automatique qui existait ici a été retirée, voir « Pop-up de retour de pause déjeuner » juste après
(un cas réel de sessions dupliquées, provoqué par ce même job côté serveur, en a démontré le risque).

- **`autoPauseResume.js`** — module serveur, **portage volontairement dupliqué** (pas
  partagé/importé) du même calcul déjà présent côté client dans `public/index.html` :
  `pauseWindowsFor`/`pauseWindowFor` (pauses effectives à un instant donné, plusieurs pauses par
  personne fusionnées si elles se chevauchent), `dayIntervals`/`dayHoursFor`/`dayStartFor`/
  `isDateBlocked` (segments de travail réels d'une journée, voir « Hors horaires » ci-dessous),
  `applyUserLunchOverride` (horaire et pause propres à une personne, avec le même ratio
  lun.-jeu./vendredi préservé pour un horaire personnalisé — bug déjà corrigé côté client, voir
  plus bas), `configForMachineId`/`configForPiece`, `isInPauseWindow`, et `applyAutoPauseResume`
  lui-même (fermeture de **toutes** les sessions ouvertes — voir « Travail à plusieurs » ci-dessus).
  Aucun mécanisme de partage de code entre le client (une seule balise `<script>`, pas de build,
  voir Architecture) et le serveur (modules Node classiques) n'existe dans ce projet — introduire un
  fichier `.js` chargé par le navigateur en plus de `public/index.html` aurait été un changement
  d'architecture plus large que ce qui était demandé. **Réflexe explicite documenté en tête de
  `autoPauseResume.js`** : toute évolution de cette logique côté client (`applyUserLunchOverride`,
  `pauseWindowsFor`, `dayIntervals`, la fermeture de toutes les sessions plutôt qu'une seule...) doit
  être reportée à l'identique dans ce fichier, sous peine de divergence silencieuse entre les deux
  copies.
  - **Simplification assumée, partielle depuis « Hors horaires » ci-dessous** : la version client
    calcule en plus, dans `effectiveConfig`, les indisponibilités automatiques d'un poste dont
    **tous** les opérateurs liés sont en congé (`operatorLeaveIntersection`) — toujours omise côté
    serveur (dépend de `usersList`, uniquement disponible côté client, pour le libellé d'infobulle ;
    sans incidence sur le calcul de pause déjeuner lui-même, `pauseWindowsFor` ne lisant jamais
    `indisponibilites`). En revanche, `m.indisponibilites` **propre au poste** (saisi à la main dans
    Paramètres → Postes, ex. maintenance programmée) est désormais reporté par
    `configForMachineId` — nécessaire à `isDateBlocked`, qui lui a une incidence directe sur la
    détection « hors horaires ».
- **`checkAutoPauseResume()`** (`server.js`, `setInterval` toutes les 60s, même cadence que la
  boucle client et que `checkScheduledBackup` déjà en place pour les sauvegardes programmées) — lit
  `app_state`, appelle `applyAutoPauseResume(data, new Date())`, et n'écrit que si `changed` est
  vrai. Également appelée une fois immédiatement au démarrage du serveur (redémarrage du conteneur
  après un déploiement), sans attendre le premier tic à 60s.
- **Aucun risque de conflit de version pour ce job lui-même** : lecture et écriture SQLite sont
  toutes deux **synchrones** (`better-sqlite3`), sans `await` entre les deux — Node étant
  mono-thread, aucune requête HTTP concurrente (dont un `PUT /api/state` d'un client) ne peut
  s'exécuter entre cette lecture et cette écriture. Un `PUT` client réellement concurrent (entre le
  moment où CE client a lu l'état et celui où il l'enregistre) recevra en revanche un 409 tout à
  fait normal — déjà géré côté client par `silentSave()`/`saveStateWithReapply()` (rechargement
  silencieux de la version fraîche, jamais de perte de données), exactement comme pour n'importe
  quel autre conflit d'écriture concurrente déjà couvert par ce mécanisme (voir le piège « Doubles
  enregistrements concurrents »).
- **Idempotent par construction** : rejouer `applyAutoPauseResume` sur un état déjà à jour (ex. le
  job serveur ET la boucle client qui se déclenchent l'un juste après l'autre sur la même pièce) ne
  produit aucun changement supplémentaire — la branche `en_cours`→`en_pause` vérifie l'état courant
  avant d'agir, jamais une simple bascule inconditionnelle. Le client garde donc son propre calcul en
  plus de celui du serveur (retrait non nécessaire) : bascule visuelle immédiate dans un onglet resté
  ouvert, sans attendre le prochain sondage.
- **Réflexe Dockerfile** (piège déjà documenté plus bas, réappliqué ici) : `autoPauseResume.js` est
  un nouveau fichier serveur requis par `server.js`, donc ajouté à la fois au `require()` et à la
  ligne `COPY autoPauseResume.js ./` du `Dockerfile` — vérifié par
  `grep -oE "require\('\./[a-zA-Z]+'\)" server.js` comparé à `grep "^COPY" Dockerfile`.

### Pop-up de retour de pause déjeuner (reprise non automatique)

Demande utilisateur directe, suite à un cas réel de sessions dupliquées sur une pièce active (voir
le piège « Job serveur qui interprète les horaires dans le fuseau de l'hôte » plus bas — le job
serveur et le navigateur, horloges divergentes le temps de l'incident, se sont mis à rouvrir/
refermer la même tâche en boucle) : *« pour éviter tout risque de travaux en double, je souhaite ne
plus avoir de redémarrage automatique à la fin des pauses, mais qu'une grosse pop-up s'ouvre au
retour théorique des pauses »*. La reprise automatique de la pause déjeuner (client ET serveur,
`applyAutoPauseResume`) a donc été **retirée** — seule la mise en pause automatique subsiste (voir
juste au-dessus) — et remplacée par une confirmation explicite de l'opérateur.

- `pieces[].pauseReminderSnoozeUntil` (`{ [operatorUserId]: horodatage } | null`) — seul nouveau
  champ introduit par cette fonctionnalité (`migrateState` l'initialise à `null`) : report du
  rappel, PAR opérateur concerné (jamais pour les autres opérateurs attendus sur la même pièce, voir
  « Travail à plusieurs » plus haut). `autoPausedUntil`/`autoPausedOperators` (déjà existants) sont
  réutilisés tels quels — ils ne servent plus qu'à savoir QUAND et POUR QUI proposer ce rappel,
  jamais à rouvrir quoi que ce soit tout seul.
- `pendingPauseReminders()` — la liste des pièces à proposer à **l'identité active de ce poste**
  (`activeIdentityId()`, jamais le compte réellement connecté si une autre identité a été choisie —
  voir modèle de données) : `autoPausedUntil` déjà dépassé, `activeIdentityId()` présent dans
  `autoPausedOperators`, et pas de report en cours (`pauseReminderSnoozeUntil[aid]` absent ou déjà
  expiré). Ne regarde jamais `o.statut` directement (une pièce fusionnée ou travaillée à plusieurs
  peut déjà être repassée `en_cours` pour un premier opérateur pendant qu'un second reste attendu —
  voir plus bas) : seule la présence dans `autoPausedOperators` fait foi. Dédupliquée par
  `fusionGroupId` (un seul membre représente tout le groupe, même convention que
  `sumDedupedByFusionGroup` — voir « Temps de production vs présence théorique »).
- `renderPauseReminderModal(otherModalOpen)` — grande pop-up (`.pause-reminder-box`), une carte par
  tâche en attente (commande, pièce/étape, poste, « pause depuis {heure théorique} »), bouton
  « ▶ Reprendre » par tâche et « ✔ Reprendre les N tâches »/« ✔ Reprendre cette tâche » global, plus
  trois boutons de report (15 min / 30 min / 1 h). `otherModalOpen` (calculé dans `render()` via
  `document.querySelector('.modal-box:not(.pause-reminder-box)')`, sur le DOM D'AVANT le rendu, comme
  `modalScrollTop`/`focusRef` juste au-dessus) : cette pop-up ne s'affiche jamais par-dessus une
  autre déjà ouverte (Paramètres, correction de pointage...) — elle réapparaît au rendu suivant, une
  fois l'autre refermée. Ajoutée à la composition de **chaque** page (`render()`), pas seulement au
  planning — un rappel de pause déjeuner n'a aucune raison de dépendre de l'onglet ouvert.
- `resumeFromPauseReminder(cid, oid)` / `resumeAllPauseReminders()` — délèguent à
  `applyResumeFromPauseReminder(o, aid)` (mutation pure, sans `commit()`, réutilisée par les deux
  pour n'émettre **qu'un seul** `commit()` par action — voir le piège des doubles enregistrements
  concurrents) : ouvre une session pour `aid` (**jamais** pour qui que ce soit d'autre — chaque
  opérateur confirme lui-même son propre retour, contrairement à l'ancienne reprise automatique qui
  rouvrait tout le monde d'un coup), horodatée à **l'instant du clic** (pas à `autoPausedUntil`) :
  c'est justement une confirmation humaine explicite, la meilleure information disponible sur le
  moment réel du retour — contrairement à l'ancien mécanisme automatique, qui n'avait que l'heure
  théorique à défaut de mieux. Propage à tout le groupe fusionné le cas échéant (comme `setOpStatut`).
  - **Poste partagé (deux opérateurs attendus sur la même pièce)** : le premier qui confirme repasse
    la pièce `en_cours` et ouvre sa session ; le second reste dans `autoPausedOperators` (et voit
    donc toujours son propre rappel, indépendamment du statut désormais `en_cours` — voir
    `pendingPauseReminders` ci-dessus) jusqu'à ce qu'il confirme à son tour, auquel cas il rejoint
    simplement (une session de plus, comme `joinOpSession`, mais **sans** son avertissement de
    chevauchement — ce n'est pas la découverte surprise que quelqu'un d'autre est déjà dessus, c'est
    justement la personne qu'on attendait). `autoPausedUntil`/`autoPausedOperators` ne sont vidés
    qu'une fois **tous** les opérateurs attendus confirmés.
  - **Statut changé entre-temps** (ex. un superviseur a clôturé la pièce pendant la pause) : ne
    rouvre jamais de session sur une pièce qui n'est plus `en_pause`/`en_cours` — se contente de
    retirer l'opérateur de la liste d'attente, ce rappel n'ayant plus lieu d'être.
- `snoozeAllPauseReminders(minutes)` — reporte, pour l'identité active uniquement, toutes les tâches
  actuellement affichées dans la pop-up (bouton global, pas un report par tâche). Ne touche ni au
  statut ni à `autoPausedUntil` : un simple enregistrement transitoire
  (`pauseReminderSnoozeUntil[aid]`), le rappel réapparaît de lui-même une fois le report expiré.
- **`pausedSinceEarlierTasks` (bannière « tâches en pause depuis la veille ou avant ») n'exclut plus
  les pauses déjeuner automatiques.** Avant ce correctif, `o.autoPaused` en excluait les pièces
  (censées se résorber seules) ; puisqu'une pause déjeuner non confirmée ne se résorbe plus jamais
  toute seule, elle doit pouvoir y apparaître si elle traîne jusqu'au lendemain — filet de sécurité
  demandé explicitement par l'utilisateur, en réutilisant un mécanisme déjà existant plutôt que
  d'en inventer un second. Le garde-fou de date (`toDateInputValue(last.fin) >= todayKey`) évite
  tout chevauchement avec la pop-up le jour même : une pause déjeuner du jour reste seulement dans
  `pendingPauseReminders`, jamais aussi dans cette bannière tant que minuit n'est pas passé.

#### Mise en pause automatique « hors horaires » (soir, nuit, week-end) — sans reprise automatique

Retour utilisateur réel : une tâche `en_cours` restait affichée telle quelle tout un week-end si
personne n'avait pensé à cliquer « Pause » avant de partir — la pause déjeuner automatique
ci-dessus ne couvre que le créneau de midi, rien ne gérait le reste des horaires non travaillés.
Distinct de la pause déjeuner sur un point précis, explicitement demandé dès l'origine : **aucune
reprise automatique** le jour ouvré suivant, ni même une pop-up de rappel comme pour la pause
déjeuner (voir plus haut) — la tâche doit rester en pause jusqu'à ce qu'un **opérateur la relance
lui-même**, de sa propre initiative (reprendre un travail resté en plan toute la nuit peut
nécessiter une vérification physique de la pièce, une raison humaine que le serveur ne peut pas
connaître). Elle reste néanmoins visible dans la bannière « tâches en pause depuis la veille ou
avant » dès qu'elle a passé la nuit (voir `pausedSinceEarlierTasks`, qui ne l'a jamais exclue).

- `pauseKindForRunningTask(op, now, st)` (`autoPauseResume.js`) — point unique qui classe une
  pièce `en_cours` en `'lunch'` | `'outOfHours'` | `null` (aucune action) à l'instant `now` :
  calcule d'abord `isWorkDay` (ni samedi/dimanche, ni jour bloqué par `isDateBlocked` — indisponibilité
  de poste) ; `'lunch'` seulement si `isWorkDay` **et** dans la fenêtre de pause déjeuner ; sinon
  `'outOfHours'` dès que `now` ne tombe dans aucun segment de travail du jour (`dayIntervals`) —
  qu'il s'agisse d'un jour non travaillé, d'avant l'ouverture, d'après la fermeture, ou d'un poste
  bloqué.
  - **Piège explicitement évité par le garde-fou `isWorkDay` sur la branche `'lunch'`.**
    `isInPauseWindow` (comme côté client, inchangée) ne regarde que l'heure de la journée, jamais le
    jour de la semaine — un samedi entre 12h00 et 13h00 correspondrait donc, par pure coïncidence
    d'horaire, à "en pause déjeuner" si on l'utilisait telle quelle. Sans le garde-fou `isWorkDay`,
    une tâche restée `en_cours` un samedi midi aurait basculé à tort en pause déjeuner **avec
    reprise automatique à 13h** — exactement l'inverse de l'effet recherché (le week-end entier
    aurait dû la mettre en pause, sans reprise, dès la sortie du vendredi soir). Couvert par un test
    dédié (`test_server_out_of_hours_pause.js`, « samedi midi doit être classé outOfHours »).
- `pieces[].autoPausedOutOfHours` (bool, `false` par défaut, `migrateState`) — posé à `true` par la
  branche `'outOfHours'` d'`applyAutoPauseResume`, qui ferme toutes les sessions ouvertes à `now`
  (comme la pause déjeuner) mais **laisse `autoPaused` à `false`** et `autoPausedUntil`/
  `autoPausedOperators` à `null` — c'est `autoPaused` (pas `autoPausedOutOfHours`) que la branche de
  reprise automatique d'`applyAutoPauseResume` regarde pour décider de rouvrir une session ; le
  laisser à `false` range donc cette pause dans le même panier qu'une pause manuelle, et lui évite
  tout risque d'être un jour repris automatiquement par mégarde. `autoPausedOutOfHours` lui-même
  n'est lu par aucun mécanisme de reprise : purement informatif (traçabilité), remis à `false` par
  `applySingleStatusChange` dès qu'un opérateur relance la tâche manuellement (même endroit que la
  remise à `false` d'`autoPaused`) ou qu'elle est rouverte via « ↺ Rouvrir ».
  - **Conséquence gratuite, sans code d'affichage supplémentaire** : `pausedSinceEarlierTasks`
    (bannière « tâches en pause depuis la veille ou avant », voir plus haut) exclut déjà les tâches
    `autoPaused` (elles sont censées se résorber seules) — une tâche mise en pause « hors horaires »
    (`autoPaused=false`) y apparaît donc automatiquement dès qu'elle a passé la nuit, avec son
    bouton « ▶ Continuer ce travail », sans avoir eu à toucher à cette bannière.
- `configForMachineId` (voir ci-dessus) reporte désormais `m.indisponibilites` (mais toujours pas
  `operatorLeaveIntersection`) pour qu'`isDateBlocked` puisse aussi classer en `'outOfHours'` un
  poste en maintenance programmée un jour par ailleurs ouvré.

#### Exception « 🕐 Je travaille maintenant » (venir travailler hors horaires normaux)

Retour utilisateur réel, question directe : *« si je viens travailler en dehors des heures de
travail normales, est-ce que je peux lancer ou redémarrer une tâche ? »* — la réponse initiale
(rien n'empêche de cliquer Démarrer/Continuer) s'est révélée incomplète : le contrôle serveur
"hors horaires" ci-dessus (`checkAutoPauseResume`, toutes les 60s) ne fait aucune différence entre
une tâche oubliée `en_cours` depuis la veille et une tâche que quelqu'un vient réellement de
démarrer/reprendre pour travailler ce soir-là — il compare uniquement l'horloge à la configuration,
sans connaître la présence réelle. Sans exception, une tâche démarrée un soir se retrouverait donc
remise en pause automatiquement à la prochaine passe du job, au plus tard 60 secondes après. Option
retenue parmi trois proposées (bouton décidé sur le moment, vs. exception planifiée sur un poste,
vs. exception planifiée sur une personne) : **un bouton, décidé sur le moment par l'opérateur**,
sans aucune configuration préalable — demande explicite : applicable aussi bien à une tâche déjà
`en_cours` qu'à une tâche encore `a_faire`.

- `pieces[].workHoursExceptionUntil` (`"AAAA-MM-JJTHH:mm" | null`, `migrateState`) — borne haute
  **exclusive** (minuit du jour du clic, `nextDayStart(new Date())`), jamais une durée fixe depuis
  l'instant du clic : plus simple à comprendre pour l'opérateur ("jusqu'à ce soir minuit", pas
  "jusqu'à telle heure précise à calculer de tête"), et se désactive de lui-même une fois minuit
  passé — comme `pauseReminderSnoozeUntil`, aucun code n'a besoin de le réinitialiser après coup.
- `setWorkHoursException(cid, oid)` — pose ce champ et `commit()` une seule fois ; propage la même
  valeur à tout le groupe fusionné via `propagateFusionGroupFields` — nécessaire car
  `applyAutoPauseResume`/`pauseKindForRunningTask` (serveur) évaluent **chaque pièce
  indépendamment** via sa propre `sessions[]` (voir « Travail à plusieurs sur une même pièce »),
  même quand tout le groupe a démarré strictement en même temps : sans cette propagation, un membre
  du groupe resterait mis en pause malgré l'exception posée sur un autre.
- **Disponible à la fois sur une tâche `a_faire` et `en_cours`** (menu contextuel, clic droit sur
  une carte/barre — `renderContextMenu`, action `ctx-work-exception`), **jamais** sur `en_pause`
  (la reprise d'une pause a déjà son propre mécanisme, voir « Pop-up de retour de pause déjeuner »
  et « hors horaires » ci-dessus) ni sur `termine`. Le proposer dès `a_faire` couvre une course
  possible sinon : cliquer "Démarrer" d'abord, puis "🕐 Je travaille maintenant" ensuite, laisse une
  fenêtre où le contrôle des 60s pourrait s'exécuter entre les deux et remettre la tâche en pause
  avant même que l'exception n'ait eu le temps d'être posée. Poser l'exception AVANT de démarrer
  évite entièrement cette course : le champ est déjà présent sur la pièce quand `setOpStatut` la
  fait passer `en_cours`, sans qu'aucun code de transition n'ait à s'en préoccuper.
- **Le serveur seul en tient compte** (`pauseKindForRunningTask`, `autoPauseResume.js`) : contrairement
  à la pause déjeuner, la branche "hors horaires" n'a jamais eu de mirroir client (elle n'a pas
  besoin d'un retour visuel instantané dans un onglet resté ouvert — voir plus haut, "Simplification
  assumée" — c'est le job serveur des 60s qui fait foi). L'exception est donc vérifiée uniquement
  côté serveur, **après** le test `withinSegment` normal et seulement pour la branche `'outOfHours'`
  (jamais `'lunch'`) : `if(op.workHoursExceptionUntil && now < new Date(op.workHoursExceptionUntil))
  return null;`. Une pause déjeuner normale un jour ouvré continue donc de s'appliquer même avec une
  exception active — les deux répondent à des besoins distincts (pas question de bloquer la vraie
  pause de midi juste parce qu'on a coché "je travaille ce soir").
- `workHoursExceptionBadgeHtml(o)` — petit badge (« 🕐 Exception hors horaires active »), visible
  tant que la borne n'est pas dépassée, sur le tableau des tâches (`renderOpsRow`, dans la note
  d'écoulement d'une tâche `en_cours`/`en_pause`) et sur la carte Kanban (colonnes "À faire"/"En
  cours" uniquement) — traçabilité pour un superviseur qui retrouverait lundi matin une tâche restée
  `en_cours` tout le week-end : sans ce badge, aucun moyen de distinguer "quelqu'un est
  réellement venu travailler dessus, en connaissance de cause" d'"elle a été oubliée et le job
  serveur a un problème".

## Historique des prévisions avant clôture (`prevision_history`)

Une fois une pièce marquée `termine`, `computeSchedule` ancre définitivement `start`/`end` sur ses
horaires réels (`debutReel`/`finReel`, voir « Moteur de planification » plus bas) — **la dernière
estimation que le moteur avait calculée juste avant** (ce qu'il "prévoyait" avant que ce soit fini)
n'est alors conservée nulle part : une fois la pièce clôturée, il n'y a plus rien à comparer au réel
(constaté en simplifiant l'affichage de la page « ⚠️ Risques de retard » à 2 colonnes Début/Fin,
voir plus bas). Cette table, sur le même principe que `session_history` (table SQLite **séparée**,
jamais incluse dans `app_state` ni dans la synchro habituelle), corrige ça.

- `pieces[].previsionAvantCloture` (`{ debut, fin } | null`) — posé par `applySingleStatusChange`
  **au moment précis** de la transition vers `termine`, à partir du planning d'AVANT cette mutation
  (`getSchedule()` appelé par `setOpStatut` avant de rien modifier, comme `plannedEndsBefore` déjà
  utilisé pour le toast "terminée en avance" — mêmes données de départ, portée plus large : calculé
  quel que soit le statut précédent, pas seulement `en_cours`/`en_pause`). Ce champ est purement
  transitoire côté client, jamais affiché directement : uniquement lu par `archivePrevisionHistory`.
  `migrateState` l'initialise à `null` sur les pièces existantes.
- `archivePrevisionHistory(st)` (async) — même robustesse que `archiveOldSessions` : balaie les
  pièces `termine` avec un `previsionAvantCloture` posé, les envoie à `POST /api/prevision-history`,
  et **ne vide `previsionAvantCloture` qu'une fois le serveur confirmé (`res.ok`)** — un échec réseau
  laisse le champ en place, retenté au prochain démarrage (appelée juste après `archiveOldSessions`
  dans `startApp`). Idempotent côté serveur (`INSERT OR IGNORE` sur un index unique
  `piece_id, COALESCE(fin_reel,'')`) : une pièce rouverte (`↺ Rouvrir`) puis re-clôturée produit une
  nouvelle ligne (nouveau `fin_reel`), jamais un doublon de la même clôture renvoyée deux fois.
- Chaque ligne porte `prevu_debut`/`prevu_fin` (la prévision archivée) **et** `debut_reel`/`fin_reel`
  (recopiés au moment de l'archivage) côte à côte, pour comparer sans avoir à recouper avec l'état
  applicatif au moment de la lecture.
- `GET /api/prevision-history/:cid/:oid` (même forme que son équivalent `session_history`) est
  consommé par la pop-up « Détail des horaires » (`renderTempsProdSessionModal`, onglet Temps de
  production) : section « Prévu vs réalisé » affichée pour une pièce `termine`, sur le même schéma
  de chargement à la demande que `session_history` (`tempsProdPrevisionCache`, clé `"cid|oid"`,
  `loadTempsProdPrevision`). `previsionForCurrentClosure(o, cid, oid)` retrouve l'entrée pertinente :
  `o.previsionAvantCloture` local (pas encore archivé) prime sur l'historique serveur ; sinon
  recherche, dans l'historique, l'entrée dont `finReel` correspond exactement à la clôture
  **actuelle** de la pièce (`o.finReel`) — une pièce rouverte (`↺ Rouvrir`) puis re-clôturée plusieurs
  fois a plusieurs entrées, seule celle de la clôture en cours est affichée. Sans correspondance
  (tâche terminée avant l'introduction de ce suivi) : message explicite plutôt qu'une section vide.
- Comme pour `session_history`, ajoutée à la copie en mémoire de `app_state` juste avant l'envoi des
  sauvegardes (`/api/backup/test` et le planificateur) — jamais réenregistrée dans `app_state`
  lui-même.

## Congés

### Demi-journée

Une demande de congé (`state.leaveRequests[]`) porte `demiJournee` (`null` | `'matin'` |
`'apres-midi'`). **N'a de sens que pour une demande d'un seul jour** (`debut === fin`) — sur une
plage de plusieurs jours, toujours ramené à `null` (silencieusement, pas d'erreur) par le code qui
construit la demande (`startLeaveRequestSubmission`, `adminAssignLeave`, `previewEditLeaveRequest`),
jamais par `confirmLeaveRequestSubmission` lui-même qui persiste tel quel ce qu'on lui donne — la
normalisation est la responsabilité de l'appelant, pas de la validation finale.

- `leaveRequestDurationDays(r)` — durée réelle d'une demande : 0.5 jour si `demiJournee` posé sur
  un seul jour ouvré, sinon la valeur pleine de `countWorkingDaysInRange(r.debut, r.fin)`. Si ce
  jour unique n'est de toute façon pas ouvré (week-end/férié saisi par erreur), le résultat reste 0,
  pas 0.5. **Remplace `countWorkingDaysInRange` partout où on dispose d'un objet demande** (soldes,
  tableaux, pop-up de conséquences) — `countWorkingDaysInRange` reste utilisé tel quel là où il n'y
  a pas de demande concrète (recherche de plage libre dans `suggestFreeRange`, comptage générique).
- `computeLeaveBalance` (utilisé/en attente) et le formulaire d'allocation annuelle
  (`step="0.5"`, déjà en place avant cette fonctionnalité) acceptent nativement les demi-jours.
- Trois surfaces de saisie/édition partagent le même sélecteur (`demiJourneeSelectHtml`) :
  formulaire salarié « Nouvelle demande », formulaire admin « Attribuer un congé directement », et
  la pop-up d'édition d'une demande existante (`renderEditLeaveRequestModal`) — toutes les trois
  laissent le sélecteur visible en permanence (pas de masquage conditionnel réactif selon que
  début=fin) et se contentent d'ignorer la valeur à la validation si la plage dépasse un jour, pour
  éviter la complexité d'un formulaire réactif (voir le piège sur les champs qui s'effacent en
  cours de frappe).
- `theoreticalPresenceHoursForUser` (voir plus bas) traite la fraction du jour couverte : une seule
  demi-journée retire la moitié des heures nominales de ce jour, deux demi-journées qui se
  complètent (matin + après-midi, éventuellement de deux demandes/types différents) retirent la
  journée entière — jamais un double-retrait de la même moitié.
- **Le blocage automatique de poste reste à la journée entière**, volontairement inchangé :
  `operatorLeaveIntersection`/`isDateBlocked` (moteur de planification) ignorent `demiJournee` — un
  congé d'une demi-journée continue de rendre tout le poste indisponible ce jour-là dans
  `computeSchedule` si c'est le seul opérateur lié. Granularité demi-journée dans le moteur de
  planification lui-même = hors périmètre de cette fonctionnalité (RH/présence), pas fait.
- `demiJourneeLabel(demiJournee)` / `leaveDateRangeLabel(r)` — libellé humain (« matin »/« après-
  midi ») utilisé dans les tableaux (Mes demandes, Équipe, À valider) et les e-mails de
  notification. `leaveDureeLabel(jours)` formate un nombre de jours (entier ou `.5`) en français.

### Chevauchement de congés (même personne, types différents ou pas)

`findLeaveConflicts(userId, debut, fin, excludeId)` détecte les congés d'une même personne qui
chevauchent une période donnée, **quel que soit leur type** (un RTT posé au milieu d'un congé payé
reste un doublon) — seuls les congés `refuse` ne comptent pas. `suggestFreeRange` s'en sert pour
proposer la plus longue plage réellement libre à l'intérieur de la période demandée.

- **À la création/modification d'une demande** (`renderLeaveRequestPreviewModal`, pop-up
  « Conséquences ») : le chevauchement est affiché avec le détail des congés concernés et, si une
  plage libre existe, une suggestion pour s'y ramener en un clic. Pour un salarié qui soumet sa
  propre demande, c'est **bloquant** (pas de bouton de confirmation, juste « Corrigez les dates »).
  Pour un administrateur (attribution directe ou correction d'un congé existant), c'est un simple
  **avertissement** : il garde la main (« Attribuer malgré le chevauchement »), une raison légitime
  de superposer étant possible (ex. régularisation).
- **Bug réel corrigé : deux points qui font BASCULER une demande à `approuve` ne vérifiaient aucun
  chevauchement**, contournant entièrement l'avertissement ci-dessus — signalé après qu'une personne
  (Cyril) s'est retrouvée avec deux types de congés différents ("Congés payés" ET "Sans solde")
  tous deux approuvés le même jour. Chaque demande, prise isolément au moment de sa création, ne
  chevauchait rien d'encore existant ; c'est leur approbation **séparée**, plus tard, qui a créé le
  doublon, sans qu'aucun des deux flux d'approbation ne les compare l'une à l'autre :
  - `decideLeaveRequest(reqId, 'approuve')` (bouton « ✓ Approuver » de l'onglet « À valider ») —
    appelle désormais `findLeaveConflicts` et affiche un `confirm()` listant le(s) congé(s) en
    conflit avant de finaliser l'approbation. Refuser une demande, ou approuver une demande sans
    aucun chevauchement, ne déclenche jamais cet avertissement (comportement inchangé dans ces cas).
  - `confirmMyLeaveAssignment(reqId, 'accept')` (la personne accepte, depuis « Mes demandes » ou le
    lien e-mail, une proposition d'un administrateur) — même avertissement, cette fois adressé à la
    personne elle-même (c'est elle qui, à cet instant précis, décide en connaissance de cause).
    Refuser une proposition ne déclenche jamais l'avertissement (aucun nouveau congé approuvé ne
    serait créé).
  - Dans les deux cas : un simple avertissement (`confirm()`), jamais un blocage silencieux — cohérent
    avec l'esprit du reste de la fonctionnalité congés (l'admin/la personne concernée garde toujours
    la main, informée plutôt qu'empêchée).
- **Visibilité avant même de cliquer** : un badge rouge (« ⚠ chevauche N congé(s) déjà posé(s) »)
  apparaît directement dans la ligne du tableau de l'onglet « À valider »
  (`renderAValiderTab`) et dans la bannière « Propositions à confirmer » de « Mes demandes »
  (`renderMesDemandesTab`) dès qu'un chevauchement existe — pour ne pas dépendre uniquement du
  `confirm()` déclenché au clic, qui n'apparaît qu'après coup.
- Réflexe : tout nouveau point de code qui fait passer une demande de congé au statut `approuve`
  (pas seulement les trois déjà couverts : création directe imposée, `decideLeaveRequest`,
  `confirmMyLeaveAssignment`) doit se demander s'il doit aussi vérifier `findLeaveConflicts` — une
  demande qui n'était pas encore en conflit au moment de sa création peut très bien l'être devenue
  entre-temps (une autre demande approuvée sur la même période, dans l'intervalle).

### Calendrier annuel des congés

Onglet « Calendrier annuel » (`congesTab==='calendrier'`, `renderCalendrierAnnuelTab`) — vue
d'ensemble type calendrier mural (inspirée d'un outil RH externe montré par l'utilisateur, Lucca) :
une pastille par jour et par personne en congé, plutôt que la liste tabulaire des autres onglets.

- `calendrierYear`/`calendrierPersonneFilter`/`calendrierStatutFilter` — état d'affichage purement
  transitoire (comme `searchQuery`/`selectedCommandeId`), jamais persisté. Le filtre statut
  (`approuve_attente` par défaut, ou `approuve`/`en_attente`/`toutes` avec les refusées) et le
  filtre personne s'appliquent à l'indexation `byDate` (une seule fois pour toute l'année visible,
  jamais recalculée par mois), commune aux deux vues ci-dessous.
- **Vue « Année » (par défaut)** — les 12 mois de l'année en grille compacte (`calyear-months-wrap`),
  une pastille pleine par personne en congé approuvé ce jour (contour seulement si `en_attente`),
  infobulle (`title`) au survol pour le détail. Comportement et rendu strictement inchangés par les
  ajouts ci-dessous.
- **Vue « Mois » (nouvelle)** — `calendrierViewMode` (`'annee'` | `'mois'`), bascule via les deux
  boutons `.view-tabs` en tête de l'onglet (même style que les onglets de vues du planning
  Jour/Semaine/...). Un seul mois affiché en grand (`calendrierMonth`, 0-11), avec le **nom des
  personnes directement lisible** (`.calmonth-name-pill`) plutôt que de simples pastilles — assez de
  place disponible en vue mono-mois pour ne pas se limiter à un survol. Au-delà de 3 personnes un
  même jour, un compteur `+N` remplace les pastilles supplémentaires (comportement volontairement
  identique à la troncature déjà en place à 4 pastilles en vue Année). Navigation par mois
  (`calmonth-nav`, gère le passage à l'année suivante/précédente en butée décembre/janvier) et
  bouton « Mois en cours » (`calmonth-today`), symétriques des équivalents déjà existants côté année
  (`calyear-nav`/`calyear-today`, tous deux inchangés).
- `renderCalMonthBlock(year, mois, byDate, todayKey, large)` — factorise la construction d'un bloc
  mois, partagée par les deux vues (`large=false` en vue Année, `large=true` en vue Mois) : même
  indexation `byDate`, seule la richesse d'affichage de chaque case change. Réflexe déjà appliqué
  ailleurs dans l'appli (`ganttBarsHtml`, `ADMIN_ONLY_SECTIONS`...) : factoriser plutôt que dupliquer
  un rendu presque identique entre deux contextes.
- **Filtre par type de congé** — au départ un simple sélecteur à côté de « Personne »/« Statut »,
  **remplacé depuis** par un filtre à cases à cocher partagé avec « Congés de l'équipe »
  (`visibleLeaveTypeIds`) — voir la section dédiée plus bas, juste après « Ergonomie mobile ».
- **Week-ends et jours fériés mis en évidence** (`isFrenchPublicHoliday`, déjà utilisée ailleurs
  dans l'appli) — fond légèrement teinté (`.calmonth-daycell.weekend`, réutilise `--panel-2`) sur
  ces jours dans la grille, dans les deux vues — repère visuel rapide pour ne pas confondre un jour
  sans aucun congé posé avec un jour où, de toute façon, personne ne travaille.
- **Poser un congé directement depuis le calendrier** — chaque cellule de jour (`data-action=
  "calendrier-request-day"`, dans les deux vues) est cliquable : le clic bascule sur l'onglet « Mes
  demandes » avec Début **et** Fin pré-remplis sur la date cliquée (l'utilisateur ajuste la fin pour
  une plage de plusieurs jours). `leaveReqPrefillDate` — variable transitoire posée par le clic,
  **consommée une seule fois** par `renderMesDemandesTab` (lue puis aussitôt remise à `null`) : un
  rendu ultérieur quelconque (n'importe quelle autre action déclenchant un `render()` pendant que
  l'onglet est encore ouvert) ne doit jamais réappliquer cette même date par-dessus une saisie déjà
  en cours — piège symétrique de la « capture/restauration désynchronisée » déjà documenté plus haut
  pour la recherche de commande, ici résolu par une consommation en un coup plutôt qu'un calcul à la
  volée (le préremplissage n'a de sens qu'une fois, contrairement à un filtre qui doit rester
  neutralisé tant qu'une condition dure). Une note (« 📅 Date pré-remplie depuis le calendrier »)
  s'affiche uniquement au rendu qui consomme effectivement le préremplissage. Le clic reste possible
  sur n'importe quel jour (y compris un jour déjà couvert par un congé d'un tiers, ou un jour d'un
  mois adjacent affiché en grisé) — c'est `findLeaveConflicts` (voir plus haut) qui avertit déjà au
  moment de la confirmation en cas de chevauchement, inutile de dupliquer cette vérification ici.
- **Cliquer une pastille/pilule pour modifier directement le congé concerné** (retour utilisateur
  réel : « serait-il possible de revenir à la demande de congé en cliquant sur la pastille
  concernée ? ») — distinct du clic sur la cellule du jour ci-dessus (qui prépare une **nouvelle**
  demande) : cliquer la pastille (vue Année, `.calmonth-dot`) ou la pilule de nom (vue Mois,
  `.calmonth-name-pill`) d'une personne déjà en congé ouvre directement la pop-up « Modifier ce
  congé » (`startEditLeaveRequest`, même formulaire que le bouton « ✎ Modifier » de « Congés de
  l'équipe ») pour **cette** demande précise — un seul clic, aucun changement d'onglet, plutôt que
  de devoir la retrouver dans un tableau. `renderCalMonthBlock` calcule `canEditFromPill =
  canSupervise()` et n'ajoute `data-action="calendrier-edit-leave" data-id="{id de la demande}"`
  sur la pastille/pilule que si vrai — **aucune nouvelle capacité accordée**, juste un raccourci
  vers un accès déjà existant (mêmes conditions que "✎ Modifier", jamais ouvert à un simple
  employé qui verrait alors un congé d'autrui devenir cliquable sans pouvoir le modifier). L'entrée
  `byDate` construite par `renderCalendrierAnnuelTab` porte désormais `id: r.id` (l'id de la
  demande, pas seulement les champs déjà affichés) pour permettre ce raccourci. Le `data-action`
  de la pastille/pilule est capturé par `closest('[data-action]')` avant celui, plus englobant, de
  la cellule du jour (`calendrier-request-day`) — aucun `stopPropagation()` nécessaire, c'est
  l'ancêtre-ou-soi-même le plus proche du point de clic qui l'emporte naturellement. Non-admin :
  aucune pastille cliquable, le clic sur la cellule du jour (poser une nouvelle demande) reste
  inchangé. **Pop-up agrandie** (`modal-box-wide`, comme les autres grandes pop-up de l'appli —
  import, regroupement...) suite à un retour direct après la mise en place de ce raccourci : la
  pop-up « Modifier ce congé » se voulait accessible d'un clic bien visible, pas étriquée dans la
  largeur de modale par défaut (520px) pensée pour un petit formulaire secondaire.
- **Supprimer un congé directement depuis cette même pop-up** (retour utilisateur réel, juste après
  la mise en place du raccourci ci-dessus) — bouton « 🗑 Supprimer ce congé » (`.danger-ghost`,
  séparé à gauche dans `.form-actions` grâce à `justify-content:space-between`, les deux autres
  boutons regroupés à droite dans un `.toolbar-mini`) dans `renderEditLeaveRequestModal`.
  `deleteLeaveRequestFromEdit(reqId)` ne duplique **aucune** logique de suppression déjà existante :
  il redirige vers la fonction adaptée au statut courant de la demande — `revokeLeaveRequest`
  (`approuve`, avec sa confirmation, sa seconde confirmation si déjà passée, et son e-mail de
  révocation) ou `withdrawLeaveRequest` (`en_attente`, déjà utilisable par un admin sur la demande
  de n'importe qui, pas seulement par son auteur) — et ne code en direct qu'un troisième cas resté
  sans fonction dédiée nulle part ailleurs dans l'appli : une demande `refuse` (simple confirmation,
  suppression directe, aucun solde ni planning à recalculer puisqu'un congé refusé n'en affecte
  déjà aucun). Après l'appel, si la demande a effectivement disparu de `state.leaveRequests`
  (confirmation acceptée) : `editingLeaveRequestDraft = null` referme la pop-up et un `render()`
  explicite l'efface de l'écran — si la confirmation a été annulée (fonctions existantes comme cas
  direct ci-dessus), la demande est toujours là et la pop-up reste ouverte sans rien faire de plus.
- **Solde compact en tête du calendrier** (`renderCalendrierBalanceStrip`) — même donnée que les
  cartes de solde de « Mes demandes »/le tableau de « Soldes & types » (`computeLeaveBalance`), mais
  condensée sur une seule ligne pour ne pas avoir à changer d'onglet en consultant le calendrier.
  Affiche le solde de la personne **actuellement filtrée** (`calendrierPersonneFilter`) si un filtre
  précis est choisi, sinon celui de la personne connectée — comportement adaptatif, jamais de
  sélecteur dédié supplémentaire à maintenir en plus du filtre « Personne » déjà présent.
- **Bandeau « qui est absent aujourd'hui »** (`absenceBannerHtml`, fonction déjà existante — jusque-
  là utilisée uniquement par les vues Jour/Semaine du planning, voir moteur de planification plus
  bas) — étendu à deux emplacements qui en étaient dépourvus : la vue **Kanban** du planning
  (`renderKanbanView`, juste avant la barre de filtres de postes) et la **page Congés dans son
  ensemble** (`renderCongesPage`, juste sous le titre — donc visible quel que soit l'onglet ouvert,
  y compris le calendrier annuel). Inspiré d'un outil RH externe (Lucca) montré par l'utilisateur.
  Aucune donnée ni logique nouvelle : `absenceBannerHtml([new Date()])` réutilise tel quel le même
  calcul (`absencesForRange`) déjà utilisé pour une plage de jours quelconque, appliqué ici à la
  seule journée du jour ; entièrement absent (pas d'encart vide) si personne n'est en congé
  aujourd'hui, comme sur les vues Jour/Semaine.

### Ergonomie mobile du calendrier annuel

Trois correctifs suite à une revue explicite de l'utilisation sur smartphone (retour utilisateur
réel, testé à 390px de large) :

- **`isNarrowViewport()`/`MOBILE_BREAKPOINT_PX`** (720, même seuil que la règle CSS `@media
  screen and (max-width:720px)` déjà utilisée ailleurs) — petite fonction utilitaire (`typeof
  window !== 'undefined' && window.innerWidth <= 720`) réutilisée par les deux points suivants.
- **Vue « Mois » par défaut sur petit écran** — `calendrierViewMode` est désormais initialisée à
  `isNarrowViewport() ? 'mois' : 'annee'` (plus une constante figée à `'annee'`) : une cellule de
  38px de la vue Année, avec plusieurs pastilles, est trop petite pour viser un jour précis au
  doigt, alors que "Mois" (cellules bien plus grandes) s'y prête. Un calcul **une seule fois**, à la
  déclaration de la variable (donc au chargement de l'appli) — jamais réappliqué ensuite : basculer
  manuellement sur "Année" reste possible et n'est jamais annulé par un redessin, même principe que
  `userDefaultPlanningView` (une préférence posée une fois, jamais réécrasée après coup).
- **Détail du jour accessible au tap, avant de foncer vers "Nouvelle demande"**
  (`calendrierDayDetail`/`renderCalendrierDayDetailModal`/`leaveEntriesForDate`) — le clic sur un
  jour ("Poser un congé directement depuis le calendrier", voir plus haut) montre déjà cette info au
  survol sur ordinateur (`title`), mais un survol n'existe pas au doigt : sur petit écran, cliquer un
  jour où quelqu'un est **déjà** en congé ouvre donc d'abord une pop-up listant qui (indépendante des
  filtres personne/type/statut du calendrier — le but est de répondre à "qui est vraiment là", pas de
  reproduire la vue déjà filtrée à l'écran), avec un bouton "📅 Poser un congé ce jour" pour
  poursuivre. Sur un jour sans personne en congé, ou sur grand écran (le survol souris couvre déjà ce
  cas), le clic fonce directement vers "Nouvelle demande" comme avant — aucun changement de
  comportement en dehors de ce cas précis.
- **`.view-tabs`/`.search-bar` avec `flex-wrap`** — ces deux conteneurs (barre d'onglets Congés,
  barre de filtres du calendrier, et plus généralement toute barre de recherche/filtres de l'appli)
  n'avaient aucun retour à la ligne : sur un téléphone, 5 onglets ou plusieurs sélecteurs côte à côte
  débordaient plutôt que de s'empiler proprement. `.search-bar-group` — petit conteneur
  `inline-flex` qui garde un couple `<label>`+`<select>` ensemble sur la même ligne quand la barre
  se met à retomber sur plusieurs lignes (sinon le label et son select pourraient se retrouver
  séparés sur deux lignes différentes) ; utilisé pour les filtres Personne/Type/Statut du calendrier.
- **Bug réel découvert en vérifiant "Nouvelle demande" à 390px : `!important` manquant sur la règle
  mobile de `.commande-top-fields`.** Plusieurs formulaires (« Nouvelle demande », « Attribuer un
  congé directement », « Générer un rythme d'alternance ») fixent leur propre nombre de colonnes en
  style **inline** (`style="grid-template-columns:1fr 1fr 1fr 1fr 1.2fr auto;"`, etc.) — un style
  inline gagne toujours face à une règle de classe, y compris une règle `@media`, sauf `!important`.
  La règle mobile `.commande-top-fields{grid-template-columns:1fr;}` (sous `max-width:720px`)
  n'avait donc **jamais** eu d'effet sur ces formulaires, malgré l'intention affichée depuis
  longtemps dans ce document ("le formulaire Nouvelle commande... repasse déjà en une seule colonne
  sous 720px" — inexact pour ces instances-là) : les champs restaient collés sur plusieurs colonnes
  étroites au lieu de s'empiler. Corrigé en ajoutant `!important` à cette règle, même remède déjà
  appliqué juste au-dessus pour `.commandes-columns` (qui a le même problème avec un style posé par
  JS plutôt qu'en dur) — réflexe : toute nouvelle règle mobile visant une classe qui peut aussi
  recevoir un style inline (grille de colonnes personnalisée par formulaire) doit être vérifiée en
  conditions réelles à largeur réduite, pas seulement relue dans le code, sous peine de croire un
  correctif effectif alors qu'il ne s'applique en pratique jamais.

### Filtre par type de congé (cases à cocher, partagé) et menu "Types affichés"

Bug/besoin réel signalé : « Congés de l'équipe » n'avait **aucun** filtre par type, et le rythme
d'alternance d'un apprenti (voir plus bas, « Génération en masse d'un rythme d'alternance ») y
génère des dizaines de lignes « Alternance à l'école » qui noient les vraies demandes ponctuelles
(retour utilisateur réel : Louka/Mathys en alternance rendaient la liste illisible). Au même moment,
la légende du calendrier annuel faisait doublon avec son sélecteur de type (les deux listaient les
mêmes couleurs/noms), et l'utilisateur a explicitement demandé une sélection **par case à cocher**
plutôt qu'un choix unique.

- `visibleLeaveTypeIds` (`Set|null`, `null` = tous les types visibles) — **une seule préférence,
  partagée** entre « Congés de l'équipe » et « Calendrier annuel » (pas une par onglet) : le besoin
  est le même des deux côtés (ne pas se laisser noyer par un type prolifique), inutile de la régler
  deux fois. Même mécanisme et même persistance que `kanbanMachineFilters`
  (`LEAVE_TYPE_FILTER_STORAGE_KEY`, `loadLeaveTypeFilter`/`saveLeaveTypeFilter`, chargée au démarrage
  aux côtés de `loadKanbanMachineFilters()`) : décocher UN type matérialise le `Set` complet moins ce
  type ; recocher le dernier type manquant refait retomber sur `null` (aucun filtre) — jamais un état
  "tous cochés mais un `Set` quand même" qui se distinguerait sans raison de "pas de filtre du tout".
  `isLeaveTypeVisible(typeId)`/`toggleLeaveTypeFilter(typeId, checked)`/`setAllLeaveTypeFilter(all)`
  ("Tout"/"Aucun").
- `renderLeaveTypeCheckboxItems()` — le contenu (une case à cocher par type, pastille de couleur,
  puis "Tout"/"Aucun") est une fonction à part, **sans** le `<details>` englobant : réutilisé tel
  quel à deux endroits qui ont besoin du contenu SANS le dupliquer, mais pas toujours sous la même
  forme d'enveloppe (voir plus bas, mobile vs desktop). `renderLeaveTypeFilterMenu(ddKey)` l'enrobe
  dans un `<details class="dd-menu">` complet ("Types affichés (X/Y) ▾"), sur le modèle exact de
  "Postes affichés" du Kanban — `ddKey` distinct par emplacement (`'equipe-types'`, `'cal-types'`)
  pour que l'ouverture/fermeture de l'un n'affecte pas l'autre (`openMiniDropdowns`).
- **« Congés de l'équipe »** (`renderEquipeTab`) — `renderLeaveTypeFilterMenu('equipe-types')`
  ajouté à côté de Personne/Statut ; la liste (`list`) est filtrée par `isLeaveTypeVisible(r.typeId)`
  avant affichage. Message d'état vide explicite (« — aucun type de congé sélectionné ») quand
  `visibleLeaveTypeIds` est un `Set` vide (bouton "Aucun"), pour ne pas laisser croire à un tableau
  vide par erreur/chargement.
- **« Calendrier annuel »** (`renderCalendrierAnnuelTab`) — l'ancien sélecteur unique (`<select>`,
  `calendrierTypeFilter`) est **supprimé**, remplacé par ce même filtre partagé, appliqué au même
  point qu'avant dans l'indexation `byDate`. La **légende séparée a été retirée entièrement** (plus
  de `legend`/`legendHtml`/`legendTypes`) : les cases à cocher affichent déjà pastille de couleur +
  nom, ça n'avait plus de raison d'exister à côté — la seule information de la légende qui n'était
  PAS un type (« ◦ En attente », le sens du contour vs pastille pleine) était de toute façon déjà
  répétée en toutes lettres dans le `footer-note` du bas de page, donc rien perdu. `renderCalendrier
  BalanceStrip` filtre aussi ses lignes par `isLeaveTypeVisible` — masquer un type masque également
  son solde (souvent "Illimité" pour un type comme l'alternance, qui n'apporte alors rien à afficher).
  - **Desktop** — `renderLeaveTypeFilterMenu('cal-types')` prend directement la place de l'ancien
    `<select>`, à côté de Personne/Statut, dans la barre de filtres.
  - **Mobile** — jamais un `<details>` DANS un `<details>` (peu maniable) : le menu "Filtres ▾"
    replié (voir « Ergonomie mobile » ci-dessus) inclut directement le contenu nu de
    `renderLeaveTypeCheckboxItems()` sous un petit titre "Types affichés" (`.dd-panel-title`), pas
    un second `<details>` imbriqué.
- **Débordement d'un `dd-menu` positionné au milieu d'une barre qui retombe à la ligne (mobile).**
  Repéré en vérifiant le menu "Filtres ▾" du calendrier à 390px : son panneau (`position:absolute;
  left:0` relatif au `<details>`) démarrait où que le `<details>` se soit retrouvé après le retour à
  la ligne de `.search-bar` — assez loin à droite dans ce cas précis — et débordait donc du bord
  droit de l'écran (texte "Approuvés + en attente" coupé net). Corrigé en forçant, sous
  `max-width:720px`, TOUT `details.dd-menu` à occuper `width:100%` de sa ligne : il ne partage alors
  plus jamais sa ligne avec un autre élément et démarre donc toujours au bord gauche du conteneur,
  laissant au panneau toute la largeur de l'écran pour s'ouvrir sans déborder. Réflexe : tout
  nouveau `dd-menu` ajouté à une barre capable de retomber à la ligne sur mobile hérite de ce
  correctif automatiquement (règle générique sur `details.dd-menu`, pas par instance) — mais à
  vérifier visuellement à largeur réduite si un jour ce menu doit partager sciemment sa ligne avec
  autre chose (auquel cas cette règle générique devrait être exclue pour lui).

`leaveTypes[]` porte `sansSolde` (bool, `false` par défaut) — un type dont les jours pris ne
s'imputent sur aucune allocation annuelle (typiquement un type « École » pour un apprenti en
alternance : ses jours d'école n'ont pas à grignoter un solde de congés payés/RTT).

- `computeLeaveBalance` renvoie `allocated`/`remaining` = `Infinity` pour un tel type — se propage
  naturellement dans toutes les soustractions (`remaining` reste `Infinity` quel que soit l'usage),
  et dans toute comparaison `demanded > bal.remaining` (toujours fausse) : **aucun code de blocage
  ou d'avertissement de solde insuffisant n'a besoin de connaître `sansSolde`**, le seul point qui
  le lit explicitement est `computeLeaveBalance` lui-même.
- `formatLeaveBalancePair(remaining, allocated)` — affiche « Illimité » plutôt que « ∞ / ∞ j »
  (`Infinity.toLocaleString('fr-FR')` fonctionnerait déjà correctement — `leaveDureeLabel(Infinity)`
  affiche bien `∞` — mais un texte explicite est plus clair sur ce point précis). Utilisé partout où
  un solde `remaining/allocated` s'affiche ; certains affichages (cartes de solde, tableau
  d'allocation) gardent leur propre `isFinite(bal.allocated)` pour une mise en page différente
  (masquer complètement l'input numérique d'allocation d'un type sans solde, par exemple).
- Paramètres → Congés → Soldes & types : case « Sans décompte de solde (illimité) » par type.
  `updateLeaveTypeField` reçoit `el.checked` (pas `el.value`) pour ce champ — comme `updateConfig`,
  le dispatcher (`dispatchChangeAction`, case `'leave-type-field'`) teste `el.type==='checkbox'`.

### Génération en masse d'un rythme d'alternance

Paramètres → Congés → Soldes & types → « Générer un rythme d'alternance » : crée en une fois toutes
les demandes de congé (déjà approuvées, motif `"Alternance"`) correspondant à un rythme régulier sur
toute une période — pensé pour un apprenti dont le calendrier école/entreprise ne varie pas d'une
semaine sur l'autre, pour ne pas les saisir une par une.

- `alternanceDraft` — état du formulaire (`userId`, `typeId`, `debut`, `fin`, `mode`:
  `'jours'`\|`'semaines'`, `joursSemaine[]`, `semaineRef`), mis à jour en direct
  (`updateAlternanceField`/`toggleAlternanceJour`, un `render()` à chaque changement) pour que les
  champs du mode `'jours'` (cases Lundi..Vendredi) et du mode `'semaines'` (date de semaine de
  référence) s'affichent/masquent conditionnellement — contrairement au reste des formulaires de
  congé, qui gardent volontairement tous leurs champs visibles en permanence pour éviter la
  complexité d'un formulaire réactif (voir demi-journée ci-dessus) : ici la bascule entre deux jeux
  de champs entièrement différents justifie la réactivité.
- `computeAlternanceDates(debut, fin, mode, opts)` — calcule les jours ouvrés (hors week-end et
  jours fériés français) correspondant au rythme sur `[debut, fin]`, puis les **fusionne en plages
  contiguës** (jours ouvrés consécutifs au calendrier). Mode `'jours'` : `joursSemaine` (1=lundi..
  5=vendredi) coche les mêmes jours chaque semaine. Mode `'semaines'` : `semaineRef` (une date
  quelconque dans la première semaine « école ») détermine la parité — cette semaine et une sur deux
  ensuite sont « école », les semaines intermédiaires ne le sont pas (calculé via `startOfWeek`,
  déjà utilisé ailleurs dans l'appli, et un simple modulo sur l'écart en semaines). Aucun traitement
  spécial pour les week-ends/jours non concernés : ils ne rejoignent simplement jamais la liste des
  jours « école », ce qui casse naturellement la contiguïté d'une plage.
- `submitAlternanceGeneration()` — ignore silencieusement (les compte, mais ne les recrée pas) les
  jours déjà couverts par un congé existant non refusé de la même personne, pour pouvoir relancer la
  génération sur une période étendue (ex. rajouter un trimestre) sans créer de doublons ni de
  chevauchement. Demande confirmation (`confirm()`, nombre de périodes et de jours ouvrés) avant de
  créer quoi que ce soit.
- Comme pour la demi-journée, **le blocage automatique de poste et le moteur de planification** ne
  distinguent pas un congé généré par ce rythme d'un congé posé normalement — mêmes conséquences
  (bloque le poste si l'apprenti en est le seul opérateur lié ce jour-là).
- **Mode "Sélection manuelle sur calendrier"** (`alternanceDraft.mode==='manuel'`) — un rythme
  régulier (jours fixes, semaines alternées) ne correspond pas forcément au calendrier réel d'un
  alternant (retour utilisateur réel). Ce mode remplace le calcul par rythme par une vue mensuelle
  cliquable (`renderAlternanceCalendar`) : premier clic sur un jour = début d'une période "école"
  en attente (`alternanceDraft.calendarPendingStart`), second clic = fin — la période `{debut,fin}`
  (remise dans l'ordre chronologique quel que soit l'ordre des deux clics) rejoint
  `alternanceDraft.periodes[]`, affichée sous forme de puces retirables individuellement
  (`remove-alternance-periode`). Cliquer deux fois le même jour annule la sélection en attente
  plutôt que de créer une période d'un jour "par accident". `navigateAlternanceCalendar(dir)` fait
  défiler `alternanceDraft.calendarMonth` (`"AAAA-MM"`) mois par mois ; la grille (lundi en première
  colonne, comme `startOfWeek` déjà utilisé ailleurs) mute visuellement week-ends/fériés sans les
  rendre non cliquables (une période "école" traversant un week-end reste possible à sélectionner,
  simplement sans effet sur la génération — voir plus bas).
  - `submitAlternanceGeneration()` en mode `'manuel'` : passe chaque période cliquée à
    `computeAlternanceDates(p.debut, p.fin, 'jours', { joursSemaine:[1,2,3,4,5] })` (tous les jours
    ouvrés cochés) plutôt que de dupliquer le filtrage week-ends/fériés et la fusion en plages
    contiguës — un week-end à l'intérieur d'une période cliquée casse donc naturellement sa
    contiguïté, exactement comme les deux autres modes. Le reste (confirmation, jours déjà couverts
    ignorés, motif `"Alternance"`, statut `approuve` direct) est strictement partagé avec les modes
    `'jours'`/`'semaines'`, aucune duplication de cette partie.
  - `alternanceDraft`/`periodes`/`calendarPendingStart`/`calendarMonth` sont purement transitoires
    côté client (comme `draft`/`customImportState`) — jamais dans `state`, pas de migration requise.
- **Réinitialisation après génération.** Ce formulaire reste affiché en permanence dans Paramètres →
  Congés → Soldes & types (pas de pop-up ouverte/fermée à chaque utilisation, contrairement à
  `quickPointageDraft`/`correctOperatorDraft`) : `alternanceDraft` est un unique objet global jamais
  recréé entre deux utilisations. Sans réinitialisation, paramétrer le rythme pour une SECONDE
  personne juste après une première génération réussie rappelait encore tous les réglages du premier
  apprenti (personne, dates, jours cochés, périodes cliquées sur le calendrier...) — bug réel signalé,
  contournable seulement en rechargeant la page (F5) entre deux personnes. `submitAlternanceGeneration()`
  appelle désormais `alternanceDraft = newAlternanceDraft()` juste après le `commit()` d'une génération
  réussie (jamais avant confirmation ni en cas d'erreur de validation, pour ne pas faire perdre une
  saisie en cours à la moindre erreur) — même principe que `draft = newDraft()` ailleurs dans l'appli.

## Temps de production vs présence théorique

**L'application n'a aucun système de pointage réel** (pas d'entrée/sortie physique). La seule
notion de « présence » disponible est donc **théorique** : ce que l'horaire attendait de la
personne, pas une mesure de qui était physiquement là. Onglet « Temps de production »
(`renderTempsProdPage`/`renderTempsProdSelfPage`), superposé au temps de production déjà mesuré
par `computeProductionTimeByUser` :

- **Groupe fusionné : compté une seule fois, jamais une fois par pièce.** `dureeOverrideH` d'un
  groupe fusionné est déjà la SOMME du groupe entier, posée à l'identique sur chaque membre (voir
  « Regroupement » plus bas) ; et `setOpStatut` démarre/met en pause/clôture tout le groupe EN MÊME
  TEMPS (mêmes horodatages sur chaque membre) — physiquement, c'est une seule et même opération sur
  le poste. `computeProductionTimeByUser`/`renderArchivesPanel` (temps prévu/passé par commande
  archivée) dédupliquent donc par `fusionGroupId` (`sumDedupedByFusionGroup`, ou l'équivalent
  `seenFusionGroups`/`fusionGroupCounts` dans `computeProductionTimeByUser`) : un seul membre
  représente tout le groupe dans la somme et dans le détail par salarié (libellé `"{pièce} (+N
  pièces du même lot)"`), les autres sont ignorés. Bug réel corrigé (retour utilisateur : Cyril,
  page Temps de production) — un lot de 5 pièces à 9,5h prévues/1,8h réelles comptait pour 47,5h/9h
  (5×), un lot de 3 pièces à 10,2h comptait pour 30,6h (3×), soit ~78h prévues affichées au lieu des
  ~19,7h réelles du lot. Réflexe : toute nouvelle somme de durées sur plusieurs pièces (`c.pieces`
  d'une commande, ou plus largement) doit dédupliquer par `fusionGroupId` de la même façon — sinon
  toute commande dont plusieurs pièces partagent un même lot verra son total gonflé par le nombre de
  pièces de ce lot.
- `applyUserLunchOverride(cfg, userId, st)` — factorise la logique de surcharge horaire propre à
  une personne (`st.userLunch[userId]` : pause(s) propre(s) et/ou horaire de début/fin), utilisée à
  la fois par `configForPiece` (poste en base, pour planifier une pièce) et `baseConfigForUser`
  (horaire d'atelier `st.config` en base, pour estimer la présence théorique) — même règle de
  surcharge dans les deux cas, ne jamais la dupliquer une troisième fois.
  - **Horaire personnalisé (`horaireActif`) et vendredi.** Un seul couple `heureDebut`/`heureFin`
    dans ce réglage (pas de variante « vendredi » dédiée). Appliquer `workingHours` (calculé à
    partir de ce couple) tel quel à `friHours` était un bug réel (présence théorique de 8-9h
    affichée un vendredi pour une personne avec horaire personnalisé, alors que l'atelier n'ouvre
    que 4h ce jour-là pour tout le monde) : `friHours` doit suivre le **même ratio** que celui de
    l'atelier entre un jour normal et le vendredi (`friHours/monThuHours` d'origine, calculé
    **avant** d'écraser ces deux champs), jamais un report identique ni une simple conservation de
    la valeur atelier telle quelle. Si l'atelier ne raccourcit pas le vendredi (`friHours ===
    monThuHours`, ratio 1), l'horaire personnalisé continue de s'appliquer identiquement les 5
    jours — cas réel couvert par ailleurs (une personne à temps partiel travaillant les mêmes
    heures réduites toute la semaine, y compris le vendredi).
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
  dans la tuile de stat de « Mon temps de production ». Sous 50%, le fond de la piste (pas
  seulement le remplissage) est teinté en rouge pâle (`rgba(178,58,48,0.18)`) : un remplissage réel
  de 10% de largeur serait sinon presque invisible sur un fond neutre — l'alerte doit sauter aux
  yeux même quand la barre elle-même est quasi vide, pas seulement son maigre remplissage.
- Colonne « Présence théo. » (texte) et « Taux d'occupation » (barre `renderOccupationBar`) dans
  le tableau superviseur, équivalents dans la vue « Mon temps de production » (présence en texte,
  occupation en grande barre `big`), et deux colonnes numériques supplémentaires (présence en
  heures, occupation en %) dans l'export Excel (feuille Résumé) — l'export garde des nombres bruts,
  pas la barre, qui n'a de sens qu'à l'écran.
- **Sélecteur de période** (`tempsProdPeriodMode` : `'jour'` | `'semaine'` | `'mois'` | `'annee'` |
  `'plage'`) — `'semaine'` va du lundi au dimanche inclus (`startOfWeek`, déjà utilisé ailleurs dans
  l'appli), navigation (`navigateTempsProdPeriod`) par pas de 7 jours dans ce mode. Comme les autres
  modes (hors `'plage'`), n'affecte que `tempsProdPeriodBounds()` — aucune donnée ni logique de
  calcul propre à ce mode, juste des bornes `[start, end[` différentes.
- **Salariés masqués de la vue superviseur** (`state.hiddenTempsProdUserIds[]`, tableau d'ids
  comme `storageZones`/`inactiveStorageZones`) — case à cocher "Afficher dans le temps de
  production" par salarié (Paramètres → Utilisateurs), pour ne pas surcharger la page de comptes
  sans intérêt ici (admin sans activité d'atelier, compte de test...). `isHiddenFromTempsProd(st,
  userId)` / `toggleTempsProdVisibility(userId)`. Filtré **uniquement** au point d'affichage/export
  superviseur (`renderTempsProdPage` et `exportTempsProdExcel` sans `onlyUid`) — jamais dans
  `tempsProdRows` lui-même ni dans `renderTempsProdSelfPage`/l'export personnel (`onlyUid` fourni) :
  un salarié masqué de la vue d'ensemble garde un accès intact à ses propres données via "Mon temps
  de production", ce masquage n'étant qu'une question d'encombrement de la liste superviseur, jamais
  une restriction d'accès.

### Pointage rapide (tâche non planifiée)

Bouton « ➕ Pointage rapide » — pour un salarié qui fait une tâche qui n'était pas prévue : démarre
tout de suite une session sur une commande choisie (ou une nouvelle créée à la volée), sans passer
par le formulaire multi-lignes « Nouvelle commande » (bien trop lourd pour ce cas d'usage — une
seule tâche, pas une gamme complète). Disponible à **trois** endroits, en plus l'un de l'autre
(jamais un déplacement qui retirerait les autres) : onglet Temps de production (superviseur et
« Mon temps de production »), et la vue Kanban du planning (barre d'outils sous les filtres de
poste, à côté de « Vue groupée des pièces fusionnées ») — plus naturel pour démarrer une tâche
directement là où on regarde le travail en cours par statut, plutôt que sur une page d'analyse.
`openQuickPointage()`/`quickPointageDraft`/`renderQuickPointageModal()` restent strictement
partagés entre les trois emplacements (aucune duplication de logique, seul le bouton déclencheur
est dupliqué) ; `renderQuickPointageModal()` fait donc partie de la composition `render()` des
**deux** pages (`currentPage==='tempsProd'` et la page Planning par défaut), pas d'une seule.

- `quickPointageDraft` (`{ cid, nouvelleCommandeNom, machineId, piece, etape, tempsUnitaire, quantite,
  operatorUserId } | null`) — état du formulaire, purement transitoire côté client (comme `draft`),
  ouvert/fermé par `openQuickPointage()`/`closeQuickPointage()`. Les champs texte/nombre passent par
  le même mécanisme que le formulaire « Nouvelle commande » (`data-action="quick-pointage-field"`,
  mémorisés au fil de la frappe **sans** `render()` — voir le piège sur les champs qui s'effacent en
  cours de frappe) ; les `<select>` (commande, poste, opérateur) déclenchent un `render()` normal
  (`data-action="quick-pointage-select"`) pour que le champ "Nom de la nouvelle commande" apparaisse/
  disparaisse selon qu'une commande existante est choisie ou non.
- `submitQuickPointage()` — résout la commande (existante par id, existante retrouvée par nom si le
  nom tapé correspond déjà à une commande — même sécurité anti-doublon que `submitNewCommande` — ou
  nouvelle, avec `dateBesoin` posée automatiquement à aujourd'hui plutôt que de la demander : pas
  pertinent de bloquer un pointage "vite fait" sur une échéance à réfléchir), puis pousse directement
  une pièce déjà `en_cours` (session ouverte, `debutReel`/`manualStart` = maintenant) — **sans**
  passer par `setOpStatut` : construire la pièce déjà démarrée en un seul passage évite d'avoir à la
  pousser dans `state` PUIS la démarrer par un second appel commit()-ant séparément (voir le piège des
  doubles enregistrements concurrents). Un seul `commit()` pour toute l'action. L'avertissement "poste
  déjà occupé" (même logique que `setOpStatut`) est vérifié **avant** toute mutation de `state`, pour
  ne rien laisser en mémoire si la confirmation est annulée.
- **Durée connue ou non, décidé au moment de la saisie** — trois champs optionnels dans le
  formulaire : Temps unitaire, Quantité, et **Durée totale (h)**, cette dernière pensée pour une
  tâche qui n'a pas vraiment de "quantité" (ex. un dépannage de 45 min). Temps unitaire et quantité
  doivent être renseignés ensemble ou pas du tout (validation explicite — l'un sans l'autre est
  rejeté comme incohérent) ; la durée totale, elle, se suffit à elle-même : quantité posée à `1` par
  défaut si absente, temps unitaire déduit par le même calcul que `updateOpDuree` sur une pièce
  existante (`tempsUnitaire = duréeTotale×60 / quantité`) — **jamais** `dureeOverrideH`, un champ
  réservé aux groupes fusionnés (voir « Regroupement » plus bas : `isPositionPinned` et le
  redimensionnement d'une barre en Semaine supposent tous deux qu'une pièce seule ne le porte
  jamais). Une durée totale renseignée prévaut sur un temps unitaire par ailleurs rempli, plutôt que
  d'obliger à vider ce dernier pour lever l'ambiguïté. Au moins une des deux façons ayant abouti à un
  temps unitaire et une quantité positifs, la pièce est créée normalement (`horsPlanning:false`) et
  rejoint la planification comme n'importe quelle tâche démarrée manuellement. Sans aucune des deux,
  `pieces[].horsPlanning` passe à `true` : la tâche est suivie (temps réel, historique, temps de
  production) mais **jamais placée sur le planning**, faute de durée fiable à y projeter.
- `pieces[].horsPlanning` (bool, `false` par défaut) — dans `computeSchedule`, traitée exactement
  comme une pièce sous-traitée (jamais de poste réservé, dates réelles conservées telles quelles,
  contribue aux dépendances des phases suivantes seulement une fois `termine`) mais pour la raison
  inverse : une pièce sous-traitée n'a pas besoin de poste parce que le travail se fait ailleurs ; une
  pièce hors planning n'en a pas parce qu'aucune durée fiable n'est connue pour la placer. Manuellement
  cochable/décochable ensuite sur n'importe quelle pièce (case "📋 Hors planning" à côté de "🏭 Sous-
  traité" dans le tableau des tâches, `toggleOpHorsPlanning`) — utile pour rebasculer une tâche dans
  la planification une fois sa durée réellement connue, ou l'inverse.
- Affichage : Kanban (`timeInfo`) et tableau des tâches (`datesCell`) ont chacun une branche dédiée
  pour `horsPlanning`, insérée **avant** la branche générique qui affiche `o.start`/`o.end` — une
  pièce hors planning non terminée a un `start` réel (`debutReel`) mais un `end` toujours `null`
  (jamais de projection), ce que la branche générique ne gère pas (elle suppose l'un présent
  implique l'autre). Même piège que celui déjà rencontré sur les colonnes Début/Fin de la page
  Risques de retard (voir plus bas) — un `end` manquant sur une pièce activement suivie n'est pas
  une anomalie ici, juste l'état normal d'une tâche sans durée estimée.

### Filtre Kanban par poste et tâches sans poste

`kanbanMachineFilters` (`Set` d'ids de postes affichés, `null` = tous — Kanban, cases à cocher
« Postes affichés ») ne contenait que des ids de vrais postes : une tâche sans poste choisi
(`machineId===null`, typiquement un « Pointage rapide » sans durée fiable où l'opérateur n'a pas
désigné de poste — voir ci-dessus) n'appartenait à AUCUN poste du filtre, donc disparaissait dès
qu'on décochait ne serait-ce qu'un seul poste — bug réel signalé (Cyril filtrait sur ses postes
habituels et ne retrouvait plus son propre pointage rapide).

- `KANBAN_SANS_POSTE_MOI` / `KANBAN_SANS_POSTE_TOUS` — deux pseudo-ids ajoutés à ce même `Set`
  (jamais un second mécanisme de préférence séparé) : réutilisent tel quel tout ce qui existait déjà
  pour les postes (persistance `localStorage` via `saveKanbanMachineFilters`, boutons "Tout"/"Aucun",
  bascule "tous cochés → `null`" via `nbTotalKanbanFilterEntries()` = `state.machines.length + 2`).
  `toggleKanbanMachineFilter` matérialise désormais le `Set` complet (postes **+** ces deux
  pseudo-entrées) au premier décochage — décocher un seul poste ne fait donc plus jamais disparaître
  les tâches sans poste au passage.
- Dans `renderKanbanView`, une tâche `machineId===null` ignore totalement `kanbanMachineFilters.has
  (o.machineId)` (qui vaudrait toujours faux) : elle est visible si `KANBAN_SANS_POSTE_TOUS` est
  coché, sinon si `KANBAN_SANS_POSTE_MOI` est coché **et** `o.operatorUserId` correspond à
  `activeIdentityId()` — l'opérateur ASSIGNÉ de la pièce (voir modèle de données), pas qui a
  réellement ouvert une session dessus. Sans filtre actif du tout (`kanbanMachineFilters===null`,
  cas par défaut), aucune de ces deux vérifications n'intervient : toutes les tâches sans poste
  restent visibles comme avant ce correctif, zéro régression pour qui n'a jamais touché ce filtre.
- Le compteur « Postes affichés (X/N) » ne compte que les vrais postes (`state.machines`), jamais
  les deux pseudo-entrées, pour ne pas afficher un total qui ne correspondrait à rien de visible à
  l'écran (pas de case "postes" numérotée N+2).
- Cases dédiées dans la barre de filtres (`renderKanbanView`), même mécanisme `data-action=
  "toggle-kanban-machine"` que les postes (aucun nouveau cas de dispatch nécessaire, `machineId` y
  est traité comme une clé opaque) : « 📋 Sans poste (moi) » et « 📋 Sans poste (tout) ».

## Onglet « Pointages »

Retour utilisateur réel : jusqu'ici, voir/corriger un pointage demandait de retrouver la bonne
commande dans le planning (active ou archivée) puis, pour une correction, de passer par le bouton
« ✎ Opérateur » de la page « Temps de production » — suffisant pour rattraper QUI a réellement
travaillé (voir « Correction manuelle » plus haut), mais pas pour corriger un début/une fin/une
durée réellement fausse. Nouvel onglet (`currentPage==='pointages'`, bouton `"🕘 Pointages"` dans
`renderHeader`, **`canSupervise()` uniquement** — jamais visible d'un simple employé) qui réunit
tous les pointages (actifs ET archivés) dans un même tableau, avec une correction plus complète que
le bouton « ✎ Opérateur ».

- `computeAllPointages(st)` — balaie `st.commandes` **et** `st.commandesArchivees` (contrairement à
  `computeProductionTimeByUser`, qui ne regarde que les commandes actives + `commandesArchivees`
  pour son propre besoin ; ici le même balayage est refait à plat, une ligne par pointage plutôt
  qu'agrégé par salarié). Ignore les pièces `a_faire` et celles sans aucune donnée exploitable
  (`termine` sans `dureeReelleH` positif — jamais réellement pointée, ex. import déjà terminé sans
  temps saisi ; ou pas encore démarrée). Déduplique par `fusionGroupId` (même convention que
  `computeProductionTimeByUser`/`sumDedupedByFusionGroup` — voir « Temps de production vs présence
  théorique » plus haut) : un lot fusionné n'apparaît qu'une fois, avec son `fusionCount` réel.
  `operatorIds` = les clés de `dureeReelleParOperateur` si posé (qui a RÉELLEMENT travaillé),
  sinon repli sur `operatorUserId` (opérateur assigné) — même priorité que
  `computeProductionTimeByUser`.
- `pointagesRangeBounds(range)` (`'today'`\|`'week'`\|`'thisWeek'`\|`'thisMonth'`\|`'all'`\|`'custom'`)
  — bornes `[start, end[` de la fenêtre de récence appliquée **uniquement** aux pointages déjà
  `termine` (une tâche encore `en_cours`/`en_pause` reste toujours visible, quelle que soit la
  fenêtre choisie) : même principe que `doneFilterRange` sur la liste "Tâches terminées" du
  planning, pour ne pas noyer la liste sous des mois d'historique par défaut (`'thisMonth'`).
  Remplace l'ancienne `pointagesRangeCutoff` (`'week'`\|`'month'`\|`'quarter'`\|`'all'`, une seule
  borne basse) — retour utilisateur réel : "30 derniers jours"/"90 derniers jours" (fenêtres
  **glissantes**, ancrées sur l'instant présent) ne répondaient pas à "cette semaine"/"ce mois"
  (fenêtres **calendaires**, ancrées sur lundi/le 1er du mois), et il manquait "Aujourd'hui" ainsi
  qu'une plage entre deux dates choisies à la main.
  - `'today'`/`'thisWeek'`/`'thisMonth'`/`'custom'` sont calendaires (`end` exclusif, même
    convention que `dueFilterBounds`/`tempsProdPeriodBounds`) : `'thisWeek'` démarre au lundi
    (`startOfWeek`, déjà utilisé ailleurs dans l'appli), `'thisMonth'` au 1er du mois.
  - `'week'` (« 7 derniers jours ») est **conservée telle quelle** (fenêtre glissante, sans borne
    haute) — seules "30 derniers jours"/"90 derniers jours" ont été retirées, pas "7 derniers
    jours" : rien ne demandait son retrait, et une fenêtre glissante courte reste utile pour
    "qu'est-ce qui s'est passé récemment", une question différente de "cette semaine civile".
  - `'custom'` lit `pointagesFilters.customFrom`/`customTo` (`"AAAA-MM-JJ"`, deux `<input
    type="date">` affichés uniquement quand `range==='custom'`, sur le modèle exact de
    `tempsProdRangeDebut`/`Fin` côté "Temps de production") — sans les deux dates renseignées :
    aucune borne, pas de plantage. Bénéficie automatiquement du redessin différé jusqu'au
    `focusout` (`isDeferredTimeField`, générique à tout `type="date"`/`"time"` porteur d'un
    `data-action` — voir Pièges), aucun code supplémentaire nécessaire.
- Filtres (`pointagesFilters` — personne, poste, statut, période, recherche texte) : purement
  transitoires, jamais persistés (comme `searchQuery`). La recherche texte réutilise le mécanisme
  de saisie "live" déjà en place pour `#commande-search-input`/`#archive-search-input` (id dédié
  `#pointages-search-input`, géré par le même `document.addEventListener('input', ...)`) plutôt que
  `data-action` + événement `change` (qui n'aurait redessiné qu'à la perte du focus) — cohérent avec
  les autres barres de recherche de l'appli.
- **Correction (`✎ Corriger`)** — visible uniquement si `isPointageCorrectable(cid, oid)` : une
  pièce `termine` avec `dureeReelleH` positif, retrouvée via `findPieceAnywhere(cid, oid)` (balaie
  `state.commandes` **et** `state.commandesArchivees` — plus large que
  `isCorrectableProductionEntry`, limité aux commandes actives, car une correction depuis cet onglet
  vise plus souvent un pointage déjà ancien). Une pièce `en_cours`/`en_pause` n'est jamais
  corrigeable : `sessions[]` y prime toujours dans `computeProductionTimeByUser`, corriger
  `dureeReelleH` n'y aurait aucun effet visible tant que la tâche n'est pas clôturée — même
  garde-fou que le bouton « ✎ Opérateur ».
  - `correctPointageDraft` (`{ cid, oid, debutReel, finReel, dureeReelleH, operatorUserId } | null`)
    — volontairement un draft/modal **séparé** de `correctOperatorDraft`/`renderCorrectOperatorModal`
    (formulaire édité différent : ici début/fin/durée en plus de l'opérateur) plutôt qu'une extension
    du même outil, déjà en place et testé tel quel depuis "Temps de production" — pas de raison de
    risquer une régression sur un outil qui fonctionne pour en faire un troisième usage.
  - `submitCorrectPointage()` — remplace **intégralement** `debutReel`/`finReel`/`dureeReelleH`
    (jamais de fusion partielle), valide (début et fin renseignés, fin ≥ début, durée > 0) avant
    toute confirmation (`confirm()`). Si un opérateur est choisi dans le sélecteur, réattribue
    **l'intégralité** du temps à cette seule personne (`dureeReelleParOperateur = { [id]: dureeH }`)
    — même sémantique que `submitCorrectOperator` (pas de répartition partielle, voir « Correction
    manuelle » plus haut) ; laisser "Ne pas modifier l'attribution actuelle" (valeur vide) conserve
    `dureeReelleParOperateur` tel quel. Propagé à tout le lot fusionné via
    `propagateFusionGroupFields` (déjà utilisée ailleurs pour ce même besoin), pour qu'une pièce
    fusionnée corrigée entraîne ses partenaires — cohérent avec le fait que `dureeOverrideH`/les
    horodatages d'un lot sont déjà partagés entre ses membres.
- Aucun nouveau point serveur : cette correction n'édite que des champs déjà présents dans
  `app_state` (`debutReel`/`finReel`/`dureeReelleH`/`dureeReelleParOperateur`), synchronisés par le
  mécanisme habituel (`commit()`) — pas de `PUT`/`PATCH` dédié sur `session_history` (table
  d'archive, append-only par conception, voir plus haut). Corriger le DÉTAIL par session archivée
  dans `session_history` elle-même resterait hors périmètre de cet onglet : ce qui compte pour le
  temps de production et la présence théorique d'une pièce déjà terminée, ce sont les champs
  agrégés édités ici. Pour une pièce encore active, voir le mécanisme distinct ci-dessous.

### Correction du détail des sessions d'une pièce encore active

Retour utilisateur réel, posé directement après la mise en place de l'onglet ci-dessus : « est-il
envisageable de corriger une étape en pause (non terminée) ? » — motivé par le bug de fuseau
horaire serveur (voir le piège dédié plus bas) qui a laissé, sur des tâches encore `en_cours`/
`en_pause`, des sessions fermées avec une fin antérieure à leur propre début. `✎ Corriger`
(ci-dessus) ne peut structurellement rien faire pour une pièce pas encore `termine` :
`computeProductionTimeByUser`/`opElapsedHours` lisent `sessions[]` **en direct** tant que la pièce
n'est pas clôturée (voir `isPointageCorrectable`) — corriger `debutReel`/`dureeReelleH` n'aurait
aucun effet visible. Il faut donc un second outil qui édite `sessions[]` **elle-même**.

- `isSessionsCorrectable(cid, oid)` — vrai pour une pièce `en_cours`/`en_pause`, avec au moins une
  session, **et sans `fusionGroupId`**. Exclusion volontaire des pièces fusionnées : chaque membre
  d'un groupe porte sa PROPRE `sessions[]` (contrairement à `dureeOverrideH`, réellement partagé —
  voir « Regroupement » plus bas), et `propagateFusionGroupFields` (`Object.assign` d'un champ
  scalaire sur chaque membre) ne convient pas à un tableau : lui passer `sessions` ferait partager
  la **même référence** d'array à tous les membres, un futur `joinOpSession`/pause sur l'un
  corromprait alors silencieusement tous les autres. Propager correctement (une copie profonde par
  membre) est un problème plus large que celui posé ici — hors périmètre, bouton simplement absent
  pour une pièce fusionnée plutôt qu'une correction à moitié fiable.
- Bouton « 🕘 Sessions » dans le tableau de la page Pointages (à côté de « ✎ Corriger », les deux
  pouvant apparaître sur des lignes différentes mais jamais sur la même — un statut ne peut être à
  la fois `termine` et `en_cours`/`en_pause`).
- `correctSessionsDraft` (`{ cid, oid, sessions: [{ orig, debut, fin, operatorUserId, open }] } |
  null`) — chaque entrée du draft garde `orig`, la **référence réelle** vers l'entrée de
  `sessions[]` (jamais un clone) : `submitCorrectSessions()` reconstruit `o.sessions` entièrement à
  partir du draft plutôt que de raccorder par indice à l'ancien tableau, pour rester correct même
  après une suppression (qui décale les indices suivants).
- **Session actuellement ouverte (`fin: null`) : jamais éditable, jamais supprimable.**
  `updateCorrectSessionField`/`removeCorrectSessionRow` refusent tout net (silencieusement pour
  l'édition — le champ est simplement absent du formulaire pour cette ligne ; avec une alerte
  explicite pour la suppression) sur une entrée marquée `open`. Une session encore en cours est
  celle de quelqu'un actuellement au travail : y toucher depuis un écran de correction pensé pour
  rattraper des horodatages **passés** pourrait interférer avec le décompte en direct de cette
  personne — hors de portée de ce que cet outil doit décider. `submitCorrectSessions()` la reporte
  strictement telle quelle (`s.orig`) dans le résultat final.
- `removeCorrectSessionRow(idx)` — demande confirmation (`confirm()`, destructif et définitif,
  aucun brouillon de récupération) avant de retirer une ligne du draft ; utile pour une session
  totalement aberrante (ex. le bug de fuseau horaire a aussi pu créer des sessions à durée nulle,
  `debut === fin`, lors d'allers-retours rapides Reprendre/Pause pendant l'incident).
- `submitCorrectSessions()` — valide chaque session non ouverte (début renseigné, fin absente ou
  postérieure/égale au début) **avant** toute confirmation ; une seule ligne invalide bloque
  l'ensemble de l'enregistrement (pas de sauvegarde partielle), avec le message d'erreur pointant
  clairement la règle violée. `operatorUserId` : préremplie par `openCorrectSessions` avec la
  valeur déjà résolue (celle de la session, ou l'opérateur assigné de la pièce en repli — même
  priorité que partout ailleurs dans l'appli), mais toujours réécrite explicitement sur la session
  au moment d'enregistrer, même si non modifiée — un repli implicite devient une valeur explicite,
  sans effet visible ailleurs (`computeSessionsHoursByOperator`/`computeProductionTimeByUser`
  appliquent de toute façon le même repli si le champ venait à nouveau à manquer).
- **« 🧩 Fusionner les sessions qui se chevauchent ».** Cas réel signalé juste après la mise en
  place de l'outil ci-dessus : une pièce avait accumulé ~18 sessions ouvertes à une minute
  d'intervalle, toutes fermées ensemble à l'heure de la pause déjeuner de l'opérateur — conséquence
  probable du bug de fuseau horaire serveur (voir le piège dédié plus bas) : le job de reprise
  automatique de pause déjeuner (serveur, horloge alors faussée) et le navigateur (horloge correcte)
  se sont mis à rouvrir/refermer la même tâche l'un après l'autre pendant que leurs horloges
  divergeaient, jusqu'à ce que la vraie pause déjeuner ferme tout ce tas d'un coup. Pas qu'un
  problème d'affichage : `computeProductionTimeByUser`/`opElapsedHours` somment CHAQUE session
  indépendamment (c'est précisément ce qui permet de compter deux personnes en parallèle, voir
  « Travail à plusieurs » plus haut) — des sessions qui se chevauchent pour la MÊME personne
  gonflaient donc à tort son temps de production compté sur cette tâche. Les supprimer une par une
  (`🗑`) aurait été long sur une telle avalanche.
  - `mergeOverlappingCorrectSessions()` — regroupe les sessions **fermées** du draft **par
    opérateur** (jamais entre deux opérateurs différents, même sur un créneau identique — voir
    « Travail à plusieurs » : additionner leur temps à deux est le comportement voulu, pas un
    doublon à corriger), trie chacune par `debut` (comparaison directe des chaînes
    `"AAAA-MM-JJTHH:mm"`, triables telles quelles), puis fusionne par balayage d'intervalles :
    deux sessions qui se chevauchent OU se touchent exactement (`debut` de l'une ≤ `fin` de la
    précédente déjà fusionnée) deviennent une seule, bornée du `debut` le plus ancien au `fin` le
    plus tardif ; des sessions disjointes (un vrai trou entre les deux) restent des lignes
    séparées. Une session encore **ouverte** n'est jamais concernée (ni fusionnée, ni réordonnée) —
    même garde-fou que pour l'édition/suppression individuelle ci-dessus.
  - Bouton dans la pop-up « Corriger les sessions » (au-dessus du tableau, visible même sur une
    longue liste) : agit uniquement sur le **draft** (`correctSessionsDraft.sessions`), aucun
    `commit()` — la fusion reste annulable en fermant la pop-up sans cliquer « Enregistrer ». Le
    compte de sessions affiché en tête de la pop-up (« N sessions ») permet de voir immédiatement
    l'effet de la fusion avant de valider.
  - **Doublons EXACTS fusionnés même sur un intervalle invalide.** Retour utilisateur réel, sur un
    cas concret : plusieurs sessions identiques `debut`/`fin`/opérateur, mais avec `fin < debut`
    (voir « Ligne invalide » ci-dessous) — la fusion par intervalles seule ne les regroupait pas
    (elle suppose un intervalle bien formé pour décider d'un chevauchement, ce qui n'a pas de sens
    ici). `mergeOverlappingCorrectSessions()` élimine donc d'abord, par une passe séparée, les
    doublons dont `operatorUserId`/`debut`/`fin` sont **identiques**, avant la fusion par
    intervalles habituelle — aucune ambiguïté sur ce qu'il faut faire dans ce cas précis (une pure
    répétition de la même ligne), contrairement à deux sessions invalides mais non identiques
    (même horaire un autre jour, par exemple), jamais fusionnées à l'aveugle faute de certitude.
- **Ligne invalide (fin < début) surlignée, nommée dans l'erreur, et bouton « ⇄ » pour l'inverser.**
  Retour utilisateur réel : avec plusieurs dizaines de sessions dans le tableau, le message d'erreur
  générique de validation ne disait pas LAQUELLE posait problème — fastidieux à repérer à l'œil.
  - `renderCorrectSessionsModal` calcule `invalid = s.debut && s.fin && s.fin < s.debut` par ligne :
    fond rouge pâle sur toute la ligne (`.correct-session-invalid-row`), badge « ⚠ fin < début »
    à côté du champ Fin, et bouton « ⇄ » (`swapCorrectSessionRow(idx)`, échange `debut`/`fin` de
    cette ligne) affiché **uniquement** sur une ligne invalide — jamais proposé sur une ligne déjà
    correcte, où l'inverser la casserait plutôt que la corriger.
  - `submitCorrectSessions()` cite désormais l'horaire exact de la session fautive dans l'alerte
    (« La session commençant le {debut} a une fin ({fin}) antérieure à son début... ») plutôt qu'un
    message générique — permet de la retrouver immédiatement dans le tableau, en plus du surlignage.
  - Ce genre de ligne (`fin`/`debut` très exactement inversés) se rencontre typiquement quand les
    deux valeurs correspondent à des bornes de configuration réelles (ex. les horaires de pause
    déjeuner d'une personne) — un signe que le couple a probablement été enregistré à l'envers plutôt
    qu'avec des valeurs arbitrairement fausses ; le bouton « ⇄ » couvre directement ce cas courant
    sans obliger à retaper les deux champs à la main.

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
  commande : `commitImportGroups` porte `zoneStockage` sur chaque entrée de `createdNoms`, affiché
  dans `renderExcelImportModal` (déjà partagée par les deux flux d'import) via le bandeau ci-dessous
  — plus adapté qu'une pop-up par commande quand un import en crée plusieurs d'un coup.
  - **Bandeau « 📍 Zones à ranger »** — un premier essai avait affiché la zone dans une colonne dédiée
    du tableau récapitulatif, mais celle-ci se perdait facilement dans un tableau par ailleurs chargé
    (pièces, échéance, urgence), alors que c'est justement l'information qui demande une action
    physique immédiate (retour utilisateur réel : "j'aimerais que la zone de stockage soit vraiment
    très visible"). `renderExcelImportModal` affiche donc, juste sous la ligne de stats (même
    emplacement que l'avertissement ambre "échéance provisoire"), un badge par commande **créée**
    ayant réellement reçu une zone (`r.refs.filter(c => c.zoneStockage)`) — gros texte monospace,
    couleur de l'allée (`readableZoneTextColor`), fond teinté (`hexToRgba(couleur, 0.15)`), trié par
    code de zone. Repris du même langage visuel que le badge 32px de
    `renderNewCommandeZoneNoticeModal` (création manuelle), ici pour potentiellement plusieurs
    commandes d'un coup. Une commande sans zone (toutes occupées) ou simplement **complétée**
    (`updatedRefs`, pas une nouvelle création — aucune zone n'y est réattribuée) n'apparaît jamais
    dans ce bandeau ; entièrement absent (pas d'encart vide) si aucune commande créée n'a reçu de
    zone. **La colonne "Zone de stockage" du tableau récapitulatif a ensuite été retirée**
    (retour utilisateur réel : doublon visuel avec ce bandeau, désormais le seul point d'affichage
    de la zone dans cette pop-up) — `zoneCellHtml` (devenue inutile) a été supprimée avec elle.
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
- **Libération manuelle du casier** (`state.config.modules.expedition`, désactivé par défaut —
  Paramètres → Zones de stockage) — pour le cas où une pièce a en réalité une étape de
  nettoyage/conditionnement volontairement absente de la gamme (pas envie de la modéliser comme
  poste) : sans ce module, le casier se libère dès que `isCommandeFullyDone` est vrai, comme avant
  cette fonctionnalité ; avec, il reste occupé jusqu'à confirmation manuelle.
  - `isCommandeReadyToFreeZone(st, c)` — remplace `isCommandeFullyDone(c)` **uniquement** aux trois
    points qui décident si une commande occupe encore sa zone (`occupiedStorageZones`,
    `commandesInZone`, l'avertissement d'occupants de `removeStorageAllee`) : module désactivé ⇒
    identique à `isCommandeFullyDone` ; module actif ⇒ en plus vrai que `c.pretExpedition`.
    **N'affecte jamais** le badge "Terminée" (`renderCommandeCard`) ni le décompte des commandes
    actives, qui continuent de lire `isCommandeFullyDone` directement — une pièce réellement
    terminée reste "Terminée" à l'affichage, seule l'occupation du casier est retardée.
  - `markCommandePretExpedition(cid)` — bascule `commande.pretExpedition` à `true` (jamais remis à
    `false` automatiquement) ; no-op si la commande n'est pas encore `isCommandeFullyDone`. Déclenché
    par le bouton "✓ Prêt à expédier — libérer le casier" du bandeau `.commande-expedition-pending`
    (`renderCommandeCard`), affiché seulement quand le module est actif, la commande terminée, et
    `pretExpedition` encore `false`.
  - `assignStorageZone`/`setCommandeZone` n'ont pas besoin d'être modifiés : ils lisent déjà
    `occupiedStorageZones`/`commandesInZone`, qui portent maintenant la nouvelle règle.

## Numéro de ligne, doublons et éclatement en campagnes à l'import

Certains GPAO clients (ex. export "CodeOF" du type `C026-0721/001`) numérotent chaque ligne d'une
commande, et peuvent légitimement demander la **même** pièce/étape deux fois sous deux numéros
différents — typiquement deux lots de la même référence à livrer à des dates distinctes. Sans le
savoir, ce n'est indiscernable d'un doublon accidentel.

- `pieces[].numeroLigne` (chaîne ou `null`) — le numéro de ligne d'origine (ex. `"001"`), purement
  informatif : n'entre dans aucun calcul du moteur de planification (pas de tri, pas de dépendance),
  seulement dans la détection de doublon (voir ci-dessous) et l'affichage.
- **Import personnalisé** : quand la case « Découper sur le dernier "/" » est cochée sur la colonne
  Référence (`map.referenceSplitSlash`), le suffixe qui était jusqu'ici simplement jeté (`"001"` dans
  `"C026-0721/001"`) est désormais conservé comme `numeroLigne` (`transformCustomRow`, colonne
  canonique `'NumeroLigne'`) plutôt que perdu.
- **Import standard (Excel)** : colonne optionnelle reconnue par `normalizeHeaderKey` sous les noms
  « Numéro de ligne »/« N° ligne »/etc. — absente, `numeroLigne` reste `null`, comportement inchangé.
- `buildImportGroups` — la détection de doublon (`pieceKey`) inclut désormais `numeroLigne` en plus
  de pièce/étape : **deux lignes identiques mais de numéros de ligne différents ne sont plus
  traitées comme un doublon** (bug réel corrigé : la seconde occurrence, avec sa propre échéance,
  était auparavant silencieusement ignorée — `duplicateLines`). Un vrai doublon (même numéro de
  ligne aussi) reste détecté et ignoré comme avant.
- `pieceDupKey(piece, etape, machineId, numeroLigne)` — même correctif appliqué à la détection de
  doublon **manuelle** (création de commande `submitNewCommande`, toast d'avertissement
  `updateOpField`) : sans `numeroLigne` dans la clé, saisir à la main deux lignes identiques à
  l'exception du numéro de ligne aurait silencieusement perdu la seconde à la validation du
  formulaire — même bug que côté import, corrigé au même endroit.
- Affiché et éditable (`data-field="numeroLigne"`, via `updateOpField`/`updateDraftOpField` comme
  n'importe quel autre champ texte) : petit champ sous "Pièce" dans le tableau des tâches
  (`renderOpsRow`) et dans le formulaire "Nouvelle commande" ; suffixe `(n°XXX)` sur le titre d'une
  carte Kanban non fusionnée (jamais sur une carte fusionnée multi-pièces, même raison que pour la
  zone de stockage : afficher un seul numéro serait trompeur pour les autres membres) ; colonne
  dédiée dans les trois tableaux de détail d'un regroupement fusionné (groupes déjà fusionnés,
  regroupements possibles par matière/épaisseur, pop-up de détail d'un groupe) — **une pièce
  fusionnée garde son propre numéro de ligne**, jamais écrasé par la fusion, exactement ce qui
  permet de fusionner deux lots de numéros différents (ex. pour les découper ensemble) tout en
  distinguant encore lequel est lequel.
- **Éclatement d'une référence en plusieurs commandes.** `dateBesoin` reste un champ de la
  **commande**, pas de la pièce (voir modèle de données) — une référence dont les lignes portent
  plusieurs échéances réellement différentes ne peut donc pas rester une seule commande avec une
  échéance juste. Plutôt que de n'en retenir qu'une arbitrairement (ancien comportement, corrigé),
  `buildImportGroups` regroupe d'abord les dates en **campagnes** par proximité
  (`clusterImportDates(dateStrs, toleranceDays)`, glouton, ancré sur la date la plus ancienne de
  chaque campagne — pas d'effet de chaîne : la distance qui compte est toujours par rapport au début
  de la campagne, jamais à la date précédente) puis éclate la référence en autant de commandes que de
  campagnes détectées :
  - Une seule campagne pour la référence ⇒ un seul groupe, nommé comme la référence elle-même
    (`ref`) — comportement strictement identique à avant cette fonctionnalité.
  - Plusieurs campagnes ⇒ une commande par campagne, nommée `"RÉF (date de la campagne)"` (ex.
    `"C026-0721 (03/12/2026)"`), pour rester traçable à sa référence d'origine tout en étant
    distinguable dans la liste des commandes. `commitImportGroups`/l'aperçu d'import n'ont pas eu
    besoin d'être modifiés : ils utilisent déjà la clé du groupe comme nom de commande, quelle
    qu'elle soit.
  - L'échéance retenue pour une commande de campagne est la date d'ancrage de sa campagne (la plus
    ancienne du lot fusionné), jamais une date arbitraire selon l'ordre des lignes dans le fichier.
  - Une ligne sans date parsable, sur une référence qui éclate par ailleurs, rejoint la campagne la
    plus ancienne (repli prudent — impossible de savoir à laquelle elle appartient réellement).
  - `state.config.importDateGroupingToleranceDays` (nombre de jours, `0` par défaut = aucune fusion,
    une commande par date exacte) — réglable dans Paramètres → « Profils d'import personnalisé » →
    « Regroupement des dates de livraison proches », pour ne faire qu'**une seule mise en campagne**
    quand deux dates sont en réalité proches (ex. à quelques jours d'écart) plutôt que de multiplier
    inutilement les commandes. S'applique aux deux imports (standard et personnalisé), qui partagent
    tous deux `buildImportGroups`. `updateConfig` le convertit en nombre par défaut (pas de cas
    spécial nécessaire, contrairement à un champ texte ou booléen).

### Détail des lignes ignorées (import personnalisé)

`buildImportGroups` renvoie, en plus des messages texte `errors`/`duplicateLines` (phrases toutes
faites, inchangées — toujours utilisées telles quelles par le résumé de l'import Excel standard,
`renderExcelImportModal`), deux tableaux **structurés** parallèles : `errorDetails`/`duplicateDetails`
— une entrée par ligne ignorée, avec les valeurs **brutes du fichier** (`lineNo`, `ref`, `piece`,
`etape`, `poste`, `operateur`, `tempsUnitaireBrut`, `quantiteBrut`, `numeroLigne`) et un `motif` court
(ex. `Poste "X" introuvable`). Toutes les valeurs brutes sont lues **avant** les vérifications qui
peuvent faire sortir de la boucle (référence manquante, poste introuvable, pièce manquante, TU/qté
invalide) : une ligne ignorée pour une seule raison garde donc le détail complet des autres colonnes,
pas seulement celle qui a posé problème.

- Utilisé **uniquement** par l'aperçu de l'import personnalisé (`renderCustomImportModal`, étape
  `'preview'`) : affiché en tableau (Ligne, Référence, Pièce / Étape, Poste (fichier), Opérateur
  (fichier), Qté × T.U., Motif) plutôt qu'en résumé texte à base de `<br>` — pour retrouver à quoi
  correspondait une ligne ignorée sans devoir rouvrir l'Excel. `errors`/`duplicateLines` (texte)
  restent inchangés et continuent de servir à l'import Excel standard (`renderExcelImportModal`),
  qui n'a pas été modifié par cette fonctionnalité.
- `proceedFromPostes()` propage `errorDetails`/`duplicateDetails` dans `cs.preview`, au même endroit
  que `groups`/`errors`/`duplicateLines`.

### Date de début « au mieux » à l'aperçu (import personnalisé)

Avant même de confirmer, l'aperçu (`renderCustomImportModal`, étape `'preview'`) affiche la date de
début que le moteur donnerait à chaque pièce si l'import était validé tel quel — colonne « Début au
mieux » sur chaque ligne, et un résumé sur l'en-tête de chaque référence (« — début au mieux :
{date} », la plus précoce de ses pièces). Uniquement sur l'import **personnalisé** : c'est le seul
des deux flux à avoir une étape « avant de confirmer » — l'import Excel standard
(`processExcelImportRows`) importe directement puis affiche un résultat, sans jamais repasser par un
écran de confirmation (voir plus bas, § Import Excel standard : direct, aucun aperçu chiffré).

- `simulateImportStarts(groups)` — clone `state` en profondeur (JSON, comme la sauvegarde/l'export),
  reconstruit une copie des groupes en **rattachant `existing` à la commande correspondante DANS LE
  CLONE** (jamais un clone JSON brut du groupe : `g.existing` pointe vers une commande RÉELLE de
  `state.commandes`, et `commitImportGroups` mute cet objet par référence pour y ajouter les
  nouvelles pièces — un clone JSON détacherait `existing` de la copie de l'état, et les pièces
  fusionnées n'apparaîtraient nulle part de visible dans la simulation), appelle
  `commitImportGroups(clonedState, ...)` sur cette copie jetable, puis lit `o.start` pour chaque
  pièce dans `computeSchedule(clonedState)`. **Jamais un `commit()`, jamais un `render()` du vrai
  planning** — purement une lecture, le vrai `state` n'est jamais touché tant que « ✓ Confirmer
  l'import » n'a pas été cliqué.
- Recalculée **à chaque rendu** de l'étape preview (pas mise en cache) : une correction de poste ou
  d'opérateur dans ce même aperçu (`updateImportPreviewPoste`/`updateImportPreviewOperateur`, qui
  déclenchent déjà un `render()`) change la file d'attente du poste choisi, donc la date projetée —
  la recalculer à la volée évite tout état supplémentaire à invalider (même philosophie que
  `effectiveDueFilterRange()`, voir plus haut).
- C'est une **simulation sur l'état actuel**, pas un engagement figé (texte explicite dans l'aperçu) :
  la position réelle une fois l'import confirmé dépendra de ce qui aura changé entre-temps (une autre
  commande créée sur le même poste, une urgence, etc.) — d'autant plus vrai si l'aperçu reste ouvert
  un moment avant de cliquer « Confirmer ».
- **Import Excel standard : direct, aucun aperçu chiffré.** `processExcelImportRows` appelle
  `commitImportGroups(state, groups)` immédiatement, `commit()` dans la foulée, puis affiche
  seulement un résultat (`excelImportResult`/`renderExcelImportModal`) — jamais de « Début au mieux »
  ici, puisqu'il n'y a structurellement aucun moment « avant de confirmer » où l'afficher. Ajouter un
  tel aperçu à l'import standard serait un changement de flux plus large (introduire une étape de
  confirmation qui n'existe pas aujourd'hui), pas fait.

### Date de début possible à l'import

`pieces[].dateDebutPossible` (voir modèle de données — déjà respecté par `computeSchedule` comme
plancher de planification, `materialFloor`) est désormais renseignable **dès l'import**, pas
seulement après coup ligne par ligne dans le tableau des tâches — cas réel : une pièce qui ne peut
pas démarrer avant l'arrivée d'une matière première, connue au moment de préparer l'import.

- **Import standard (Excel)** : colonne optionnelle reconnue par `normalizeHeaderKey` sous les noms
  « Date de début possible »/« Départ possible »/« Date matière »/etc. — absente, `dateDebutPossible`
  reste `null`, comportement inchangé. Parsée par `parseFlexibleDate` (même formats flexibles que la
  date de besoin, voir plus bas).
- **Import personnalisé** : colonne à associer dans le mapping (`map.dateDebutPossible`, optionnelle,
  comme `numeroLigne`/`matiere`), propagée par `transformCustomRow` sous la clé canonique
  `'DateDebutPossible'` que `buildImportGroups` reçoit en dernier paramètre (`kDateDebutPossible`).
  **Également éditable ligne par ligne dans l'aperçu** (`renderCustomImportModal`, étape `'preview'`,
  colonne "Départ possible", un `<input type="date">` par pièce à côté de Poste/Opérateur/Durée) —
  utile quand l'information n'est pas dans le fichier mais connue au moment de valider l'import.
  `updateImportPreviewDateDebutPossible(oid, value)` (même mécanisme que
  `updateImportPreviewPoste`/`updateImportPreviewOperateur`) pose la valeur sur la bonne pièce dans
  `cs.preview.groups` et déclenche un `render()` — la colonne "Début au mieux" (voir ci-dessus) se
  recalcule donc aussitôt en fonction, `simulateImportStarts` clonant déjà les pièces telles quelles.
  `applyImportProfile` initialise `dateDebutPossible: ''` sur un profil enregistré avant l'ajout de ce
  champ (même garde-fou que pour `reference2`/`refClient`).
- Une valeur illisible (colonne mappée mais cellule vide ou mal formée) **n'est jamais un motif de
  ligne ignorée** contrairement à une date de besoin invalide — `dateDebutPossible` reste simplement
  `null`, un champ optionnel qu'on peut de toute façon corriger après coup.
- `<input type="date">` bénéficie automatiquement du redessin différé jusqu'au `focusout`
  (`isDeferredTimeField`, voir Pièges) — aucun code supplémentaire nécessaire, le mécanisme est
  générique à tout champ `type="date"`/`"time"` porteur d'un `data-action`.

## Dates flexibles à l'import

`parseFlexibleDate(raw)` accepte, en plus d'un objet `Date` déjä résolu (cellule Excel réellement
typée date) et du format ISO `AAAA-MM-JJ` : `JJ/MM/AAAA` **et** `JJ/MM/AA` (année sur 2 chiffres,
ex. `"03/12/26"`) indifféremment — un même fichier ou des exports successifs du même GPAO client
peuvent changer de format de date sans prévenir. L'année sur 2 chiffres est **toujours** interprétée
comme `20XX` (jamais `19XX`) : l'application ne planifie jamais dans le siècle précédent, pas besoin
d'une logique de pivot plus fine. Une date invalide (ex. 31 février) est rejetée dans les deux
formats, comme avant.

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

### Fin projetée d'une tâche en_cours/en_pause — temps restant, pas « début + durée »

Une tâche `en_cours`/`en_pause` peut être interrompue longtemps (poste partagé, opérateur qui saute
d'une tâche à l'autre en mettant en pause celles qu'il ne fait pas dans l'instant — voir « Travail à
plusieurs sur une même pièce » plus haut pour le cas où DEUX personnes travaillent en même temps ;
ici c'est la MÊME personne qui alterne). Calculer sa fin comme `début + durée totale` ignore
totalement ces pauses : pour une tâche interrompue plusieurs jours, ça peut placer la fin
**dans le passé** alors qu'il reste réellement du travail à faire — invisible sur le planning
visuel, et les phases suivantes de la même pièce la croient déjà finie (dépendances faussées).

- `runningTaskEnd(op, st, dureeH, cfg)` — la fin d'une tâche `en_cours`/`en_pause` est désormais
  systématiquement `maintenant (prochain instant ouvré) + temps RESTANT`, où temps restant =
  `dureeH - opElapsedHours(op, st)` (jamais négatif). Remplace l'ancien `stretchIfOverdueRunning`,
  qui ne corrigeait qu'un dépassement déjà en cours et **uniquement** pour `en_cours` (jamais pour
  `en_pause` — c'était précisément le bug : une pièce en pause depuis plusieurs jours gardait une
  fin calculée depuis son ancien début, tombée dans le passé). Sans pause (temps déjà passé ≈ temps
  écoulé depuis le début), le résultat reste identique à l'ancien calcul — seul le cas avec une
  vraie pause change de résultat, jamais le cas nominal.
- Utilisé aux trois points de `computeSchedule` qui calculent la fin d'une tâche verrouillée
  (phase 1 avec `manualStart`, phase 2 `alreadyLocked`, phase 2 "en cours sans ancrage") — plus
  jamais `stretchIfOverdueRunning`, supprimée.
- `computedEnd[op.id]` utilise cette fin corrigée : une étape suivante de la même pièce (dépendance
  de phase, voir ci-dessus) attend désormais la vraie fin projetée, jamais une fin bogguée tombée
  dans le passé.

#### Fragmentation visuelle (Jour/Semaine)

Avant ce correctif, une tâche `en_cours`/`en_pause` s'affichait comme un unique bloc continu sur le
Gantt, masquant les allers-retours réels d'un opérateur entre plusieurs tâches d'un même poste
(retour utilisateur réel, cas de Simon : plusieurs tâches en_cours/en_pause sur Chaudronnerie,
alternées au fil de la journée). `renderDayView`/`renderWeekView` découpent maintenant une telle
tâche en segments distincts au lieu d'un bloc unique.

- `runningTaskSegments(o, st, windowStart, windowEnd)` — un segment par session déjà travaillée
  (`sessions[]`, réel, y compris la session ouverte en cours le cas échéant) **plus** un segment
  final "restant" projeté à partir de maintenant jusqu'à `o.end` (même ancrage que
  `runningTaskEnd`). `windowStart`/`windowEnd` bornent la fenêtre visible (jour ou semaine) : un
  segment entièrement hors de cette fenêtre est écarté plutôt que rendu à largeur nulle — une tâche
  interrompue depuis plusieurs jours peut donc n'avoir **aucun** segment visible un jour donné (rien
  ne s'y est passé ce jour-là), plus fidèle qu'un bloc continu qui laissait croire à une occupation
  ininterrompue. Sans aucune session (pièce jamais démarrée via Démarrer/Reprendre, legacy) : replie
  sur un unique segment "restant" couvrant tout `start`→`end`, jamais de plantage.
- `ganttBarsHtml(o, pos, meta, label, tooltipExtra, hlCls, tempsModCls, minWidthPct, windowStart,
  windowEnd)` — factorise la construction des blocs `.gantt-bar`, partagée par `renderDayView` et
  `renderWeekView` (avant cette fonctionnalité, dupliquée à l'identique dans les deux). Pour une
  tâche `en_cours`/`en_pause` non fusionnée, un bloc par segment de `runningTaskSegments` ; pour
  toute autre tâche (à faire, figée, terminée, sous-traitée, hors planning) **ou une barre fusionnée**
  (`o._fusionMembers` — statut et sessions y sont ambigus entre plusieurs pièces, volontairement
  exclue), un seul bloc classique, comportement strictement inchangé.
  - Un segment réel (`.gantt-bar-reel`) est juste **estompé** (opacité réduite) par rapport au
    segment restant — pas de resize-handle (purement informatif : dragger/redimensionner un
    historique n'a pas de sens). Le segment restant garde le style et le comportement plein
    habituels de la tâche — déjà non-draggable pour `en_cours`/`en_pause` de toute façon (voir
    `barStatusMeta`/le garde-fou du `pointerdown` qui exclut `done`/`running`/`paused`), donc aucun
    changement d'interaction n'était nécessaire pour rendre ce découpage sûr.
  - Le libellé de la tâche n'est affiché que sur le **dernier** segment (le "restant", ou l'unique
    segment classique) — pas répété sur chaque segment réel, pour ne pas surcharger visuellement des
    segments parfois très étroits (quelques minutes de session).

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

## Recherche/isolement de commande — rien ne doit masquer un résultat trouvé

La barre `#commande-search-input` (au-dessus de "Tâches en cours") filtre à la fois « Tâches en
cours » et « Tâches terminées » (`matchesSearch`) ; isoler une commande (`selectedCommandeId` —
clic sur un occupant de casier "Zones de stockage", une commande liée depuis "Risques de retard"/
"Temps de production", ou le bouton `#N` d'une carte) restreint la liste à cette seule commande.
`highlightActive()` (`!!(selectedCommandeId || searchQuery)`) traite les deux de façon symétrique
pour le surlignage — mais plusieurs réglages indépendants pouvaient encore masquer silencieusement
le résultat trouvé/isolé, sans que rien à l'écran n'indique lequel en était la cause : les bandeaux
repliés, le filtre "Commande à livrer" (`dueFilterRange`) laissé sur une fenêtre restreinte, le
filtre "⚠️ À risque" resté actif, et la fenêtre de récence des tâches terminées (`doneFilterRange`).
Corrigés en deux temps : d'abord pour la recherche seule, puis (bug réel signalé séparément :
cliquer un occupant de casier n'affichait rien si l'un de ces réglages traînait d'une session de tri
précédente) étendu à l'isolement, qui n'avait pas été repris lors du premier correctif alors que le
même principe s'appliquait déjà.

**Fonctions pures, sans aucun état à garder synchronisé** — recalculent, à chaque rendu, la valeur à
utiliser à partir de `highlightActive()`, sans jamais modifier `dueFilterRange`/`panelCollapsed`/
`doneFilterRange` eux-mêmes :
```js
function effectiveDueFilterRange(){ return highlightActive() ? 'all' : dueFilterRange; }
function isPanelEffectivelyCollapsed(key){ return !!panelCollapsed[key] && !highlightActive(); }
```
Pendant une recherche OU un isolement, la fenêtre d'échéance est donc **toujours** ignorée et les
deux bandeaux **toujours** dépliés — quoi qu'il arrive par ailleurs. Dès que recherche et isolement
sont tous deux retombés à rien, la vraie valeur (jamais touchée) redevient effective
automatiquement : pas de restauration à coder, rien à oublier de remettre en place.

- `renderCommandes` (filtre `active`, message d'état vide, sélecteur "Commande à livrer", indicateur
  "•" du menu "Filtres & tri", chevrons/corps des deux bandeaux) et `exportActiveCommandesExcel`
  (même filtre sur l'export, pour rester cohérent avec ce qui est affiché à l'écran) appellent ces
  deux fonctions au lieu de lire `dueFilterRange`/`panelCollapsed` directement.
- Le sélecteur "Commande à livrer" affiche l'option correspondant à `effectiveDueFilterRange()`
  (donc "Toutes" pendant une recherche/un isolement, jamais la valeur réelle suspendue) et porte une
  note "Suspendu pendant la recherche ou l'isolement d'une commande" tant que `highlightActive()` est
  vrai — la neutralisation est expliquée à l'écran, pas seulement appliquée en silence.
- **Filtre "⚠️ À risque"** (`atRiskFilterActive`) — même règle, appliquée directement au point
  d'usage (pas de fonction `effective...` dédiée, une seule condition suffit) : `if(atRiskFilterActive
  && !highlightActive())` dans `renderCommandes` et `exportActiveCommandesExcel`. Sans ce garde-fou,
  isoler une commande qui n'est pas à risque restait invisible si ce filtre était resté actif.
- **Fenêtre de récence des tâches terminées** (`doneFilterRange`/`doneFilterCutoff`) — même règle :
  `const doneCutoff = highlightActive() ? null : doneFilterCutoff(doneFilterRange);` dans
  `renderCommandes`. Cas réel visé : isoler, depuis un casier occupé, une commande déjà entièrement
  terminée mais dont le casier n'est pas encore libéré (module "Libération manuelle du casier" actif,
  voir plus bas) — sans ce correctif, une fenêtre "1 semaine" par exemple aurait pu la masquer si sa
  date de clôture était plus ancienne.
- `togglePanelCollapse`/`case 'set-due-filter'`/`toggle-at-risk-filter`/`case 'set-done-filter'`
  continuent d'écrire directement `panelCollapsed`/`dueFilterRange`/`atRiskFilterActive`/
  `doneFilterRange`, exactement comme avant — ce sont les seuls points d'écriture, jamais modifiés
  par la recherche/l'isolement eux-mêmes.
- Message d'état vide dédié dans `renderCommandes` : si `selectedCommandeId` est posé mais qu'aucune
  commande n'apparaît dans "Tâches en cours" (tous les filtres étant pourtant neutralisés), le
  message explique qu'elle est sans doute déjà entièrement terminée plutôt que d'afficher à tort
  "Aucune commande à risque"/un message générique — ce cas prime sur les autres messages d'état vide.
- **Pourquoi pas un mécanisme "mémoriser l'état d'avant, restaurer à l'effacement" ?** Une première
  version fonctionnait ainsi (`panelCollapsedBeforeSearch`/`dueFilterRangeBeforeSearch`, capturés à
  l'ouverture de la recherche, restaurés à la fermeture) — bug réel corrigé : un changement manuel du
  filtre "Commande à livrer" **pendant** la recherche (re-sélectionner "Cette semaine" dans le menu
  tout en continuant de taper) écrivait directement `dueFilterRange` sans passer par ce mécanisme, et
  restait donc actif pour le reste de la recherche — exactement le même bug, signalé une seconde
  fois par l'utilisateur juste après le premier correctif. Le calcul à la volée (sans état à
  synchroniser) rend ce scénario structurellement impossible : quoi qu'on modifie pendant une
  recherche, le filtre reste neutralisé jusqu'à ce que la recherche soit vidée, un point c'est tout.
  Un changement manuel fait *pendant* la recherche devient simplement la nouvelle valeur de
  référence une fois la recherche terminée (comportement voulu : la dernière action explicite de la
  personne l'emporte, sans notion d'"avant/après" à retenir).
- Réflexe : tout NOUVEAU filtre/repli qui peut exclure une commande de la liste "Tâches en
  cours"/"Terminées" doit avoir sa propre fonction `effectiveXxx()`/`isXxxEffectively...()` (ou au
  minimum un `&& !highlightActive()` au point d'usage) sur ce modèle plutôt qu'un mécanisme de
  capture/restauration — plus robuste par construction, jamais de travers-caisse possible entre une
  modification manuelle et l'état mémorisé. Et **vérifier qu'un correctif déjà fait pour la
  recherche couvre aussi l'isolement** (et réciproquement) : les deux masquent le même genre de
  résultat pour les mêmes raisons, un correctif qui ne traite que l'un des deux repropage la faille
  sur l'autre, comme signalé ici.

## Filtre « Commande à livrer » (liste des tâches en cours)

Sélecteur dans l'en-tête de la section « Tâches en cours » (`renderCommandes`, à côté de "Trier par
priorité"/"⚠️ À risque") : limite la liste à une fenêtre d'échéance — `dueFilterRange` (`'all'` |
`'week'` | `'nextWeek'` | `'month'` | `'nextMonth'`), persisté comme les autres préférences
d'affichage de cette liste (`DUE_FILTER_STORAGE_KEY`, chargé au démarrage).

- `dueFilterBounds(range)` — bornes `[début, fin[` de la fenêtre, `null` pour `'all'` (aucun
  filtre). Semaine = lundi à dimanche inclus (`startOfWeek`, déjà utilisé ailleurs dans l'appli) ;
  mois = 1er au dernier jour du mois calendaire — jamais "30 jours glissants" comme le filtre
  "Terminées" (`doneFilterCutoff`), qui répond à une question différente (récence, pas fenêtre de
  livraison).
- `commandeMatchesDueFilter(c, range)` — compare `c.dateBesoin` aux bornes. Une commande sans
  échéance connue est **exclue** dès qu'une fenêtre précise est choisie (contrairement au filtre
  "Terminées", qui garde par prudence une date de clôture inconnue) : ici on cherche justement à
  répondre "à livrer quand", pas juste à trier par récence approximative — `dateBesoin` est de
  toute façon obligatoire à la création d'une commande (voir modèle de données), ce cas reste
  théorique.
- Appliqué dans `renderCommandes` juste après le filtre "commande active" (pieces non toutes
  `termine`), avant le calcul de `nbAtRisk` et le filtre "⚠️ À risque" — les deux filtres se
  combinent (le badge "À risque" ne compte alors que les commandes à risque **dans la fenêtre
  choisie**), comme la recherche texte s'y combine déjà.

### Badge « Échéance dépassée » distinct d'« à risque », tri par échéance, export Excel

Trois ajouts sur la même liste « Tâches en cours », pour distinguer une commande simplement à
risque (l'échéance n'est pas encore arrivée mais la fin estimée la dépasserait) d'une commande dont
l'échéance est **déjà** dépassée aujourd'hui — un cran de gravité de plus, jusque-là confondues sous
le même badge "Retard estimé".

- `commandeDelayStatus(c)` — point unique de calcul du statut de délai d'une commande, utilisé à la
  fois par le badge de `renderCommandeCard` et par `exportActiveCommandesExcel` (jamais dupliqué) :
  `{ kind:'unknown', ... }` sans échéance ou sans fin estimée ; `'ontime'` si la fin estimée ne
  dépasse pas l'échéance ; `'overdue'` (+ `overdueDays`, jours écoulés depuis l'échéance, et
  `deltaDays`, le retard estimé) si l'échéance est déjà passée **aujourd'hui** ; sinon `'atrisk'`
  (+ `deltaDays`) si la fin estimée dépasse l'échéance mais que celle-ci n'est pas encore arrivée.
- `.badge.red.badge-overdue` — fond rouge plein, texte blanc, gras (contraste volontaire avec le
  contour rouge/fond pâle du badge "Retard estimé" existant) : « ⏰ Échéance dépassée depuis X j ».
- `sortByDueDate()` — même convention que `sortByPriority()` (mutation persistée de
  `state.commandes`, `commit()` une seule fois, pas un filtre d'affichage) mais classe uniquement
  par `dateBesoin`, urgence totalement ignorée — une commande urgente à échéance lointaine passe
  après une commande normale à échéance proche, contrairement à `sortByPriority`. Bouton "📅 Trier
  par échéance" à côté de "⇕ Trier par priorité".
- `exportActiveCommandesExcel()` — export .xlsx (feuille "Commandes en cours") de la liste **telle
  qu'affichée à l'écran**, en réappliquant exactement les mêmes filtres que `renderCommandes`
  (recherche, `dueFilterRange`, "⚠️ À risque") plutôt que d'exporter toutes les commandes actives —
  sinon l'export contredirait ce que l'utilisateur a sous les yeux. Message d'erreur explicite
  (`alert`) si la bibliothèque `XLSX` n'a pas pu se charger (nécessite une connexion internet),
  plutôt qu'un plantage silencieux. Colonnes : Commande, Réf. client, Urgence, Échéance, Fin
  estimée, État (texte dérivé de `commandeDelayStatus`), Zone de stockage, Nb pièces, Pièces
  terminées. Bouton "⬇ Exporter (.xlsx)" dans le même groupe que les boutons de tri.

## Page « ⚠️ Risques de retard »

Avant cette page, comprendre pourquoi une commande à risque (`isCommandeAtRisk`) est en retard
demandait de rechercher à la main, poste par poste, les étapes précédentes de la même pièce dont
dépend la phase actuelle (voir « Dépendances de phase » ci-dessus) — long et fastidieux. Nouvel
onglet (`currentPage==='risques'`, bouton dans `renderHeader`) qui réunit ça directement.

- `renderRisquesPage()` — liste les commandes **actives** (même filtre que `renderCommandes` :
  `c.pieces.length===0 || !c.pieces.every(termine)`) et **à risque** (`isCommandeAtRisk`), triées de
  la plus en retard à la moins en retard (`commandeRiskDaysLate`). Une commande dont la toute
  dernière étape a dépassé l'échéance mais qui est déjà totalement terminée (`isCommandeFullyDone`)
  n'a aucun intérêt à apparaître ici — exclue par le filtre "actif", même si `isCommandeAtRisk`
  resterait techniquement vrai pour elle.
- `pieceChainsForCommande(c)` — regroupe les pièces de la commande par nom de pièce et les trie par
  phase, en réutilisant `sortPiecesByPieceThenPhase` (déjà utilisée par `renderCommandeCard`) plutôt
  que de redéfinir un tri équivalent — **même critère que les dépendances de phase du moteur**
  (par pièce, pas par commande, voir plus haut). L'étape bloquante d'une chaîne est sa première ligne
  (dans l'ordre des phases, pas l'ordre brut de `pieces[]`) dont le statut n'est pas `termine` : c'est
  elle qui retient toutes les suivantes, quel que soit leur propre statut.
- Affichage : une carte par commande à risque (nom cliquable → isole la commande dans le planning,
  action `isolate-commande-goto-planning`, partagée avec le même lien depuis la page Zones de
  stockage — renommée à cette occasion, elle ne servait plus seulement aux zones). **Un seul
  `<table>` par commande**, avec une ligne de titre (`.risque-piece-row`, `colspan`) par pièce
  distincte plutôt qu'un `<table>` séparé par pièce — même principe que les tableaux de détail de
  regroupement ailleurs dans l'appli. Colonnes : Étape / Poste / Statut / Début / Fin ; la ligne
  bloquante est surlignée et porte la mention « ⛔ bloque la suite ».
  - **Un seul `<table>`, pas un par pièce.** Chaque pièce recalculait sinon indépendamment ses
    largeurs de colonnes (bug réel signalé : « toutes les colonnes sont désalignées ») — un tableau
    séparé par pièce n'a par nature aucune raison de s'aligner sur le suivant.
  - **Début/Fin : « réalisé »/« prévu » par CELLULE, pas par ligne.** Deux colonnes seulement (pas
    quatre) : `debutVal = o.debutReel || o.start`, `finVal = o.finReel || o.end`, chacune étiquetée
    séparément. Piège corrigé : une tâche `en_cours` a un début réel (`debutReel` posé au démarrage)
    mais une fin encore *projetée* (`o.end`, calculée par `computeSchedule` à partir de la durée
    restante) — les deux ne basculent jamais ensemble d'un même statut. Pour une tâche `termine`,
    `computeSchedule` ancre déjà `start`/`end` sur `debutReel`/`finReel` (voir plus haut) : les deux
    colonnes affichent alors « réalisé », ce qui explique pourquoi une ancienne version affichant
    séparément « prévu » et « réel » les montrait toujours identiques sur une ligne terminée — pas un
    bug, un artefact du moteur qu'il valait mieux ne plus afficher en double. Ce même artefact est
    ce qui a motivé l'archivage `prevision_history` (voir plus haut) : sans lui, la dernière
    estimation avant clôture serait perdue pour toujours, pas seulement plus affichée en double ici.
  - **Blocage inter-commandes** (`buildMachineTimelines(schedule)`/`machineNeighbors(byMachine,
    machineId, pieceId)`) — dimension différente de la chaîne de phases ci-dessus (qui ne regarde que
    la même pièce dans la même commande) : sur le poste de l'étape bloquante, identifie, TOUTES
    commandes confondues, l'occupant programmé juste avant elle (`before`, retenue par lui) et celui
    programmé juste après (`after`, retenu par elle) sur `o.start` trié. N'affiché que si le voisin
    appartient à une **autre** commande (`before.cid !== c.id` / `after.cid !== c.id`) — sinon c'est
    déjà visible dans la chaîne intra-commande. Ligne de contexte dédiée (`.risque-context-row`) sous
    la ligne bloquante, chaque commande citée cliquable (même action `isolate-commande-goto-planning`
    que le titre de carte).
- Bouton de l'onglet (`renderHeader`) : badge avec le nombre de commandes à risque, sur le même
  modèle que le badge de congés en attente — recalculé à chaque rendu via `getSchedule()`, jamais
  mis en cache séparément.

### Retard de démarrage

Distinct de l'écart de durée déjà mesuré par la page « ⏱ Temps de production » (théorique
`tempsUnitaire×quantité` vs réellement passé, attribué par opérateur, voir `computeProductionTimeByUser`/
`formatEcart`) : ici, on mesure si une tâche a **démarré** quand le planning le prévoyait, pas
combien de temps elle a pris une fois commencée. Volontairement **jamais attribué à une personne** —
un retard de démarrage tient à la disponibilité du poste et à l'ordonnancement (une autre commande
l'occupait, une urgence est passée devant), pas à qui a fini par exécuter la tâche une fois prise en
main.

- `pieces[].previsionAuDemarrage` (`{ debut } | null`) — posé par `applySingleStatusChange`
  **au moment précis** de la transition `a_faire → en_cours` (le tout premier « Démarrer », jamais
  une reprise après pause), à partir du planning d'AVANT cette mutation (`getSchedule()` appelé par
  `setOpStatut`, même principe que `previsionAvantCloture` — voir plus haut — mais à la transition
  symétrique : ici on fige le DÉBUT juste avant qu'il devienne réel, là-bas la FIN). Remis à `null`
  à la réouverture (`↺ Rouvrir`), comme `dureeReelleH` — un nouveau retard sera mesuré au prochain
  vrai démarrage. `migrateState` l'initialise à `null` sur les pièces existantes. Champ purement
  transitoire côté client au sens où il n'est jamais réaffiché tel quel : seul `retardDemarrageJours`
  le lit.
- `retardDemarrageJours(o)` — écart en jours entre `previsionAuDemarrage.debut` et `debutReel` ;
  positif = démarrée en retard, négatif = en avance. `null` si l'un des deux horodatages manque
  (pièce jamais démarrée via l'appli, ou démarrée avant l'introduction de ce suivi) — **aucune
  donnée rétroactive**, exactement comme `previsionAvantCloture`.
- `retardDemarrageBadgeHtml(o)` — badge discret (🕓, rouge) sur la ligne d'une pièce, dans le tableau
  des tâches (`renderOpsRow`/`datesCell`, branches « Terminée » et « volante/en cours »), affiché
  **seulement au-delà d'un demi-jour** de retard — une tâche pile à l'heure ou en avance n'affiche
  rien, pour ne pas noyer l'info utile sous du bruit de planification normal.
- `computeRetardDemarrageParPoste(st)` — vue d'ensemble groupée **par poste**, jamais par personne :
  nombre de tâches démarrées en retard, retard moyen, retard cumulé. Parcourt commandes actives ET
  archivées (comme `computeProductionTimeByUser`) — `previsionAuDemarrage` n'est jamais vidé par
  l'archivage. Affichée dans une section dédiée « 🕓 Retards de démarrage constatés » en tête de la
  page « ⚠️ Risques de retard » (page choisie plutôt que « Temps de production », qui reste
  exclusivement organisée par personne) — section indépendante du filtre « commande active/à
  risque » du reste de la page : un poste peut être régulièrement en retard au démarrage même une
  fois ses commandes terminées ou hors risque.

### Lisibilité des couleurs d'allée utilisées comme texte

`readableZoneTextColor(hex)` — les couleurs d'allée (Paramètres → Zones de stockage) sont choisies
pour une pastille/un fond pâle (Kanban, badges), pas pour du texte de petite taille : une couleur
claire utilisée telle quelle comme couleur de texte (ex. la puce "B10" sur une commande) devient
illisible (retour utilisateur réel). Assombrit une couleur dont la luminance perçue dépasse un seuil
(`0.55`, formule `0.299r+0.587g+0.114b`) à 55% de sa valeur d'origine ; renvoie la couleur **telle
quelle** (même format hex, pas de conversion en `rgb()`) si elle est déjà assez sombre — pour ne rien
changer aux couleurs qui fonctionnaient déjà. Appliqué à tous les points qui utilisent une couleur
d'allée comme `color` de texte (puce `.zone-select` des commandes, ligne de zone sur une carte
Kanban, code de zone occupée sur la page Zones de stockage, badges de la pop-up de notification de
zone à la création) — **jamais** aux usages en fond (`background`, déjà à faible opacité via
`hexToRgba`) ni aux swatches de couleur pure (pas du texte, pas de problème de lisibilité).

## Page d'accueil par défaut (par utilisateur)

`state.userDefaultPage` (`{ [userId]: 'planning'|'conges'|'tempsProd'|'zones'|'risques'|'pointages' }`)
— chaque personne choisit, dans Paramètres → **Mon compte** (section accessible à tout rôle, pas
seulement à un administrateur — voir `ADMIN_ONLY_SECTIONS`), la page affichée automatiquement à sa
connexion, à la place du Planning. Même principe que `userMachines`/`userLunch` : un réglage propre
à une personne, rangé dans `state` et synchronisé par le mécanisme habituel (`commit()`), **pas**
une préférence de navigateur comme le dernier profil d'import (`LAST_IMPORT_PROFILE_KEY`) —
l'utilisateur doit retrouver sa page d'accueil quel que soit le poste depuis lequel il se connecte.
L'option `'pointages'` (voir « Onglet Pointages » plus bas) n'est proposée dans le sélecteur, et
n'a d'effet dans `applyUserDefaultPageOnStart`, que pour `canSupervise()` — un employé qui aurait eu
cette préférence enregistrée puis perdu son rôle superviseur/admin retombe sur Planning, comme pour
`'conges'` quand le module correspondant est désactivé.

- **Bug réel corrigé : "Mon compte" documentée accessible à tout rôle, mais inatteignable pour un
  non-admin.** Le bouton "⚙ Paramétrer" de l'en-tête (`renderHeader`) et le dispatch
  `case 'open-settings'` étaient tous deux réservés à `isAdmin()` — un employé/superviseur ne
  pouvait donc jamais ouvrir la pop-up, y compris pour sa propre section "Mon compte" (changer son
  mot de passe, sa page d'accueil...), malgré ce paragraphe documentant l'intention contraire depuis
  le début. Corrigé : le bouton est désormais toujours affiché (libellé "⚙ Mon compte" pour un
  non-admin, "⚙ Paramétrer" pour un admin — même `title` adapté), et `open-settings` n'est plus
  gardé par `isAdmin()`. `ADMIN_ONLY_SECTIONS` (dans `renderSettingsModal`) est désormais dérivée de
  `SETTINGS_SECTION_KEYS.filter(key => key !== 'moncompte')` plutôt qu'une liste figée
  (`['utilisateurs','conges','backup','importProfiles','maintenance']`, qui omettait `horaires`/
  `pause`/`affichage`/`machines`/`storageZones` — sans conséquence tant que la pop-up entière était
  admin-only, mais qui aurait exposé ces réglages d'atelier à tout le monde dès l'ouverture permise à
  un non-admin) : "Mon compte" reste la SEULE section accessible à tout rôle, toute nouvelle section
  future est admin-only par défaut sans avoir à y penser. `renderSettingsModal` masque le volet de
  navigation (`showNav = visibleKeys.length > 1`) et titre la pop-up "Mon compte" plutôt que
  "Paramètres" quand une seule catégorie est visible (cas d'un non-admin) — pas de sidebar à une
  seule entrée avec des flèches de réorganisation grisées pour rien.

- `updateUserDefaultPage(userId, page)` — enregistre la préférence (`state.userDefaultPage[userId]`),
  `page` vide (choix "Planning (par défaut)" du sélecteur) stocké comme `null`, jamais comme chaîne
  vide. `migrateState` initialise `userDefaultPage = {}` sur les états existants qui ne l'ont pas.
- `applyUserDefaultPageOnStart()` — appliquée **une seule fois par démarrage d'appli** (`startApp`,
  juste après `state = await loadState()`, avant le premier `render()` — `startApp` est appelée aussi
  bien à la connexion qu'à la reprise d'une session existante, donc les deux chemins sont couverts) :
  positionne `currentPage` sur la préférence enregistrée pour `currentUser`. N'a ensuite plus aucun
  effet sur la navigation manuelle en session (les boutons `goto-*` du sélecteur de pages restent
  seuls maîtres de `currentPage` une fois l'appli démarrée) — sinon revenir sur "Planning" en cours de
  session serait immédiatement annulé au prochain redémarrage seulement, pas un problème en soi
  puisque `applyUserDefaultPageOnStart` ne tourne qu'au chargement, mais autant que ce soit explicite.
  Garde-fou : une préférence `"conges"` alors que le module Congés a été désactivé depuis (Paramètres
  → Module Congés) est ignorée plutôt que d'ouvrir une page indisponible — retombe sur Planning,
  comme l'absence de préférence.
- Le sélecteur (section "Mon compte") ne propose l'option "🏖 Congés" que si `state.config.modules.
  conges` est actif — même condition que le bouton correspondant du sélecteur de pages
  (`renderHeader`) — pour ne jamais laisser choisir une page qui n'existe pas encore à l'écran.

### Vue de planning par défaut

Quand la page d'accueil choisie est Planning (valeur vide, le cas par défaut), la personne peut en
plus choisir la **vue** du planning ouverte automatiquement — Jour, Semaine, Mois, Année, Kanban ou
Liste (`currentView`, voir `setView`) — plutôt que de retomber systématiquement sur "Semaine".

- `state.userDefaultPlanningView` (`{ [userId]: 'jour'|'semaine'|'mois'|'annee'|'kanban'|'liste' }`)
  — même principe que `userDefaultPage` (réglage par personne, synchronisé, pas une préférence de
  navigateur). `updateUserDefaultPlanningView(userId, view)` stocke `view` vide comme `null`.
  `migrateState` initialise `userDefaultPlanningView = {}`.
- Second sélecteur "Vue de planning par défaut" (section "Mon compte"), affiché **seulement** quand
  le premier sélecteur ("Page d'accueil par défaut") vaut Planning — se cache dès qu'une autre page
  d'accueil est choisie, puisque le réglage n'a alors aucun effet (la préférence reste cependant
  enregistrée telle quelle, pas remise à zéro : elle reprendra effet si la page d'accueil repasse un
  jour sur Planning). Changer l'un ou l'autre sélecteur déclenche un `commit()` donc un `render()`
  complet de la pop-up Paramètres — c'est ce qui permet à ce second sélecteur d'apparaître/disparaître
  réactivement sans code de rafraîchissement dédié.
- `applyUserDefaultPageOnStart()` — quand la préférence de page d'accueil est vide/`'planning'`,
  applique en plus `userDefaultPlanningView[userId]` à `currentView` (si une valeur valide est
  enregistrée) avant de rendre la main. Reproduit le même garde-fou que `setView()` pour la vue
  "Jour" (jamais ouvrir sur un samedi/dimanche, `viewAnchor` avancé au premier jour ouvré) **sans**
  appeler `setView()` lui-même, qui appelle `render()` — cette fonction s'exécute avant le tout
  premier rendu de l'appli (voir plus haut), un `render()` prématuré verrait un `state` encore
  incomplet (`draft`/`usersList` pas encore initialisés à ce stade de `startApp`).

## Ergonomie de l'interface

Quatre pistes issues d'une revue ergonomique (perspective manager + designer), pour réduire
l'encombrement d'écrans devenus denses au fil des fonctionnalités ajoutées une à une — aucune
d'elles ne change de comportement fonctionnel, seulement la façon dont les actions déjà existantes
sont regroupées/exposées.

- **Export .json déplacé dans Paramètres → Maintenance.** Le bouton "Exporter (.json)" de l'en-tête
  (`renderHeader`) est une sauvegarde manuelle complète, utile en admin mais jamais en usage
  quotidien — il n'a plus sa place à côté de la déconnexion sur chaque page. Toujours le même
  `data-action="export-data"`/`exportData()`, simplement rendu depuis la section `maintenance` de
  `renderSettingsModal()` au lieu de `renderHeader()`. "Importer" (et son `<input type="file">`)
  reste dans l'en-tête — c'est le seul des deux qui a besoin d'être accessible en un clic depuis
  n'importe quelle page.
- **Menu "Filtres & tri ▾" dans l'en-tête "Tâches en cours".** Les deux tris one-shot (`sortByPriority`/
  `sortByDueDate` — voir plus haut, ce sont des actions déclenchées à la main, pas un mode persistant)
  et le sélecteur de fenêtre d'échéance (`dueFilterRange`) étaient 3 des 7 contrôles alignés dans
  l'en-tête du panneau, ajoutés indépendamment au fil du temps. Regroupés dans un unique
  `<details class="dd-menu" data-dd-key="active-filters-tri">` — "⚠️ À risque" et "⬇ Exporter (.xlsx)"
  restent seuls visibles en permanence, ce sont les deux actions les plus utilisées d'un coup d'œil.
- **Filtre Kanban par poste en menu déroulant.** L'ancienne rangée de puces à cocher
  (`.kanban-filter-chip`, une par poste + les deux pseudo-entrées "Sans poste") ne passait pas à
  l'échelle au-delà de 5-6 postes (retour à plusieurs lignes). Remplacée par
  `<details class="dd-menu" data-dd-key="kanban-postes">` affichant "Postes affichés (X/Y) ▾" —
  toujours une seule ligne quel que soit le nombre de postes. Le contenu du menu (cases à cocher,
  Tout/Aucun) et toute la logique de filtrage (`kanbanMachineFilters`, `KANBAN_SANS_POSTE_MOI`/
  `KANBAN_SANS_POSTE_TOUS`, `toggleKanbanMachineFilter`...) sont strictement inchangés — seul le
  conteneur visuel a changé, les classes `.kanban-filter-chip`/`.kanban-filter-label` ont été
  supprimées (plus aucun usage).
- **Pop-up Paramètres en deux volets.** L'ancien accordéon vertical (`settingsSectionOpen`,
  plusieurs sections dépliables indépendamment, un long défilement pour atteindre les dernières)
  est remplacé par un classique volet catégories (gauche, toujours visible, avec les mêmes flèches
  ▲/▼ de réorganisation qu'avant) + contenu de la catégorie sélectionnée (droite) —
  `settingsActiveSection` (une seule clé active à la fois) remplace `settingsSectionOpen` (un bool
  par section). `ADMIN_ONLY_SECTIONS` et `settingsSectionOrder` (ordre personnalisable, persisté
  côté navigateur) sont inchangés ; `select-settings-section` (nouveau) remplace
  `toggle-settings-section` (supprimé) dans `dispatchClickAction`. Repli automatique sur la première
  catégorie visible si `settingsActiveSection` pointe vers une clé absente (ancienne préférence
  enregistrée avant suppression d'une section) — jamais de volet de droite vide.
- **Pop-up Paramètres agrandie (`modal-box-xl`).** Retour utilisateur réel : restait visuellement
  petite sur un grand écran même après le passage général des grandes pop-up à `modal-box-wide`
  (1180px/96vw) — c'est la pop-up la plus dense de l'appli (navigation + contenu, souvent des
  tableaux par poste/allée côte à côte, voir « Postes de production » ci-dessus), celle qui profite
  le plus d'espace supplémentaire. `.modal-box-xl{width:min(1560px, 97vw); max-height:92vh;}` —
  variante dédiée plutôt qu'un simple agrandissement de `.modal-box-wide` (qui reste utilisée telle
  quelle par les autres grandes pop-up — import, regroupement, édition de congé — qui n'ont pas ce
  besoin). `.settings-modal-body` (hauteur du corps à deux volets, indépendante du `max-height` du
  `.modal-box` englobant) suit : `height:min(780px, 84vh)` (était `min(620px, 74vh)`).
- **`openMiniDropdowns` — état ouvert/fermé des petits menus `<details class="dd-menu">`.** Un
  `render()` complet reconstruit tout le DOM à chaque action (voir le piège "mutation du planning
  sans invalider le cache" plus bas pour le principe général) : un `<details>` sans suivi d'état
  retomberait toujours fermé dès qu'une action à l'intérieur (cocher un poste, changer un tri)
  déclenche ce `render()`. `openMiniDropdowns[key]` (objet global, purement transitoire, jamais
  persisté) est mis à jour par un `ontoggle` inline sur chaque `<details data-dd-key="...">`, et lu
  au rendu pour poser l'attribut `open` en conséquence. Un `<details>` natif ne se referme jamais
  tout seul au clic en dehors : le gestionnaire `document.addEventListener('click', ...)` existant
  (déjà responsable de fermer `contextMenu`) referme aussi, à chaque clic, tout
  `details.dd-menu[open]` dont le clic n'était pas à l'intérieur — à la fois dans le DOM (`d.open =
  false`) et dans `openMiniDropdowns`, pour que ça reste fermé au prochain `render()`. Réflexe : tout
  nouveau menu déroulant du planning doit réutiliser ce même mécanisme (`class="dd-menu"`,
  `data-dd-key`, `ontoggle`) plutôt qu'en inventer un troisième.

## Planning sur téléphone

Retour utilisateur réel : les vues du planning principal (Jour, Semaine, Mois, Année — Gantt fin ou
grille calendaire dense, navigation temporelle ‹ › à viser au doigt) ne sont pas exploitables sur un
écran de téléphone. Demande explicite : les retirer entièrement sous 720px (même seuil que
`MOBILE_BREAKPOINT_PX`/`isNarrowViewport()`, déjà utilisé pour le calendrier de congés — voir plus
haut), et adapter le Kanban lui-même (sa grille à 4 colonnes n'est pas plus utilisable qu'un Gantt
sur un écran étroit). Trois maquettes visuelles ont été proposées pour le Kanban (onglets de statut /
accordéon vertical / défilement horizontal à accroche) ; l'utilisateur a choisi les **onglets**.

- **`effectivePlanningView()`** — point unique qui décide de la vue RÉELLEMENT affichée : identique à
  `currentView`, sauf sous 720px où une vue datée (`jour`/`semaine`/`mois`/`annee`) devient `kanban`.
  Fonction pure, sur le modèle exact d'`effectiveDueFilterRange()`/`isPanelEffectivelyCollapsed()`
  (voir « Recherche/isolement de commande » plus haut) : ne mute **jamais** `currentView` lui-même,
  recalculée à chaque rendu à partir de `isNarrowViewport()`. Conséquence directe de ce choix (plutôt
  qu'une capture/restauration ou une réécriture de `currentView`) : la préférence réelle — celle
  choisie à la main sur grand écran, ou `userDefaultPlanningView` (voir plus haut) — n'est jamais
  perdue ni écrasée ; elle redevient effective d'elle-même dès que la fenêtre s'élargit à nouveau
  (session Bureau/Continuity, fenêtre redimensionnée...), sans code de restauration à écrire.
  `renderPlanningToolbar()` et `renderPlanningSection()` lisent toutes deux `effectivePlanningView()`
  au lieu de `currentView` directement — les deux DOIVENT rester synchronisées (l'onglet actif affiché
  doit toujours correspondre à la vue réellement rendue), réflexe à vérifier pour toute future
  modification de l'une des deux fonctions.
- `renderPlanningToolbar()` — sous 720px, les boutons `Jour`/`Semaine`/`Mois`/`Année` ne sont même
  plus générés (pas seulement masqués en CSS) : seuls `Kanban`/`Liste` restent proposés. Le bloc
  `.view-nav` (‹ › Aujourd'hui) ne s'affiche que pour une vue **effectivement** datée
  (`effectivePlanningView()`), donc jamais sur mobile — `dated` en dépend directement, pas de
  condition séparée à maintenir.
- **Kanban mobile (`renderKanbanView`)** — sous 720px, un **onglet de statut à la fois** (segmented
  control : À faire / En cours / En pause / Terminée, avec le nombre de tâches par statut) remplace
  la grille `.kanban-board` à 4 colonnes, illisible sur un écran étroit. Le contenu de chaque colonne
  (cartes, compteur — construit dans `colObjs`, une passe commune aux deux présentations) est
  strictement identique à la version bureau : **seule la mise en page change**, jamais la logique de
  filtrage/tri/limite déjà en place (filtre par poste, limite "À faire"/"Terminée", vue groupée des
  fusions...), qui reste, elle, affichée en tête de page sur les deux formats sans changement.
  - `kanbanMobileStatusTab` (`'a_faire'|'en_cours'|'en_pause'|'termine'`, défaut `'en_cours'`) — état
    purement transitoire côté client (comme `congesTab`), jamais persisté : reprend `'en_cours'` (le
    plus souvent pertinent d'un coup d'œil) à chaque rechargement plutôt que de mémoriser le dernier
    onglet consulté. Une valeur devenue invalide (ancien onglet supprimé, jamais le cas actuellement)
    retombe silencieusement sur le premier statut plutôt que de planter — même réflexe défensif que
    `settingsActiveSection`.
  - Bouton `data-action="kanban-mobile-tab" data-tab="<statut>"` — dispatch trivial (`kanbanMobileStatusTab
    = el.dataset.tab; render();`), aucun `commit()` : ce n'est qu'un choix d'affichage, pas une donnée
    de `state`.
  - Le conteneur de cartes de l'onglet actif garde la classe `kanban-col-body` (en plus de
    `kanban-mobile-body`, pour le style) et son `data-col-key` — `captureKanbanScroll()`/
    `restoreKanbanScroll()` (voir le piège plus bas sur les ascenseurs de colonne) continuent donc de
    fonctionner sans modification sur ce conteneur unique.
- **Bandeau d'en-tête réduit (`renderHeader`).** Retour utilisateur direct, juste après la
  fonctionnalité ci-dessus : la rangée de pages (`page-switcher`) débordait encore en largeur sur un
  téléphone. Sous 720px (`mobileHeader = isNarrowViewport()`, calculé une fois par rendu), seuls
  `Planning`/`Congés` (si le module est actif)/`Zones de stockage` restent affichés — `Temps de
  production`, `Risques de retard` et `Pointages` ne sont plus générés du tout dans le bandeau
  (comme les onglets de vue Jour/Semaine/Mois/Année ci-dessus, pas seulement masqués en CSS, y
  compris le calcul du badge "N à risque" de `Risques de retard`, jamais exécuté sur mobile).
  **Ce sont des pages qui restent parfaitement valides et accessibles** (`currentPage` peut très
  bien pointer dessus, ex. via `userDefaultPage` — voir plus haut) : seul le raccourci direct depuis
  l'en-tête disparaît sur petit écran, aucune page n'est bloquée ni son contenu modifié. Une
  personne dont la page d'accueil par défaut est "Temps de production" continue donc d'y atterrir
  normalement sur son téléphone ; elle n'a simplement plus de bouton pour y revenir depuis Planning
  sans repasser par un écran plus large (compromis assumé : la demande portait sur la largeur du
  bandeau, pas sur l'accessibilité de ces pages en elles-mêmes).
- **Sections "Tâches en cours"/"Tâches terminées" repliées par défaut sur téléphone
  (`loadPanelCollapsePref`).** Même demande, même motivation (la page s'étirait en hauteur avant
  même d'atteindre le Kanban). Contrairement à `effectivePlanningView()` ci-dessus (fonction pure,
  recalculée à *chaque* rendu), ceci est une **valeur initiale posée une seule fois**, sur le même
  principe que `calendrierViewMode = isNarrowViewport() ? 'mois' : 'annee'` (voir « Ergonomie mobile
  du calendrier annuel ») : `loadPanelCollapsePref()` (appelée une fois dans `startApp`, avant le
  tout premier rendu) ne force `panelCollapsed.active`/`.done` à `true` que si **aucune préférence
  n'est encore enregistrée** dans le `localStorage` de cet appareil (`raw` absent) **et** que la
  fenêtre est étroite à cet instant — jamais recalculé à chaque rendu, contrairement à
  `effectivePlanningView()`, car on ne veut PAS re-refermer une section qu'un opérateur vient de
  déplier lui-même sur son téléphone. Une fois cette section rouverte manuellement, `togglePanelCollapse`
  persiste aussitôt le choix dans ce même `localStorage` (mécanisme déjà existant, inchangé) : au
  chargement suivant, `raw` existe déjà et ce repli par défaut ne s'applique plus jamais — c'est bien
  la dernière action explicite de la personne qui l'emporte, jamais ce réglage automatique. Seules
  `active`/`done` sont concernées (les deux sections nommées "Tâches..." dans l'interface) — ni
  `planning` (le Kanban lui-même, qu'on veut au contraire voir tout de suite), ni `archives` (déjà
  repliée par défaut de toute façon, sur petit comme grand écran).
- **Non traité par cette fonctionnalité** (hors périmètre de la demande) : les filtres/le "Postes
  affichés" au-dessus du Kanban, et les autres pages (Congés, Temps de production, Zones, Risques,
  Pointages) elles-mêmes ne sont pas retouchées ici — seules les vues du planning principal et la
  largeur/hauteur de la page d'accueil du planning étaient en cause.

### Bandeau `.toolbar-mini` encore débordant malgré la réduction du bandeau de pages

Retour utilisateur réel, capture d'écran d'un vrai téléphone prise juste après le déploiement du
correctif ci-dessus (v1.36.0) : la rangée de pages était bien réduite à 3 boutons comme prévu, mais
la page s'étirait **encore** en largeur — cette fois à cause de la **seconde** rangée de l'en-tête
(`.toolbar-mini` : badge "Poste en cours/Hors horaires · heure", badge "Synchronisé · heure",
bouton "N en pause", "Importer", "⚙ Paramétrer"/"Mon compte", sélecteur d'identité active, nom
d'utilisateur, "Déconnexion"), jamais couverte par le correctif précédent (explicitement listée
"non traité" ci-dessus à l'époque). `.toolbar-mini{display:flex; gap:8px; align-items:center;}`
n'avait jamais reçu de `flex-wrap` (contrairement à `.title-block`, qui l'a depuis toujours) — sur
un écran étroit, ses ~8 éléments restaient forcés sur une seule ligne, provoquant le débordement
horizontal exactement comme `.title-block` en aurait souffert sans son propre `flex-wrap`.

- `flex-wrap:wrap` ajouté à `.toolbar-mini` — filet de sécurité générique, quel que soit le contenu
  affiché par ailleurs.
- **En plus du simple retour à la ligne** : les deux badges purement informatifs (`shift-badge`
  "Poste en cours/Hors horaires · heure" et `renderSyncBadge()` "Synchronisé · heure" — aucun des
  deux n'est cliquable, contrairement à tout le reste de cette barre) sont désormais masqués sur
  téléphone (`mobileHeader`, déjà calculé par `renderHeader()` pour le bandeau de pages ci-dessus,
  réutilisé tel quel ici). Ce sont précisément ces deux badges que l'utilisateur a qualifiés
  d'« informations techniques » dans son retour — contrairement à "Importer"/"⚙ Paramétrer"/
  l'identité active/le nom d'utilisateur/"Déconnexion", qui restent tous des actions réelles
  nécessaires sur n'importe quel appareil et ne sont donc jamais masqués. Un simple retour à la
  ligne (sans rien masquer) aurait suffi à éliminer le débordement horizontal, mais aurait laissé
  une seconde ligne entière d'informations à faible valeur ajoutée sur un écran déjà contraint en
  hauteur — cohérent avec le principe déjà appliqué au bandeau de pages juste au-dessus (« ce sont
  des pages qui restent parfaitement valides... seul le raccourci disparaît sur petit écran ») :
  masquer ce qui n'est pas actionnable plutôt que de le laisser encombrer l'écran.
- Le compteur "N en pause" (bouton actionnable, pas un simple badge) reste affiché sur mobile
  comme sur bureau : il déclenche `show-paused-banner`, ce n'est pas de la même nature que les deux
  badges purement informatifs ci-dessus.
- Vérifié à 390px (Playwright) : `document.documentElement.scrollWidth === clientWidth` après
  connexion, plus aucun débordement horizontal.

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

- **Surbrillance de recherche repliée sur le nom de commande, masquant la pièce ciblée.**
  `isHighlighted(cid, commandeNom, piece, refClient)` testait `commandeNom`/`refClient` AVANT de
  conclure — si la chaîne recherchée recoupe par coïncidence le nom de la commande (identifiants de
  pièce et de commande partageant souvent un radical commun, ex. piece "0668-A" et commande
  "C026-0668"), la commande entière s'allumait, masquant laquelle de ses pièces correspondait
  vraiment (bug réel corrigé). `searchMatchesAnyPieceItself(query)` détecte qu'AU MOINS une pièce du
  planning correspond directement au nom recherché (mémorisé par référence de `schedule`, stable le
  temps d'un rendu) ; si c'est le cas, `isHighlighted` ne retombe plus sur `commandeNom`/`refClient`
  pour une ligne dont la PROPRE `piece` ne correspond pas — seule la pièce visée s'allume. Une
  recherche par référence de commande/client (aucune pièce ne correspond nulle part) continue de
  surligner toute la commande, comportement inchangé.
- **Casse et espaces des valeurs d'import.** « Laser 2D » et « laser 2d » créaient deux
  entrées distinctes. Tout est normalisé via `normPosteKey()`. Les clés de
  `posteMapping`, `groupByValue`, `sousTraitanceByValue` sont **toujours normalisées**.
- **`config` présent mais incomplet dans `migrateState()`, jamais complété.** L'ancien
  `migrateState()` ne posait `startHour`/`startMinute`/`monThuHours`/`friHours` que si
  `st.config` était **totalement absent** (`if(!st.config) st.config = {...DEFAULT_CONFIG}`) —
  un `config` présent mais partiel (`{}`, état corrompu, import, fixture de test) laissait ces
  champs `undefined`. `dayStartFor`/`dayHoursFor` produisaient alors des dates invalides, et
  `nextWorkingInstant`/`addWorkingDuration` tournaient à vide jusqu'à leur garde-fou (5000
  itérations chacun, imbriqués : ~25 millions d'itérations pour un seul calcul de durée) — un
  blocage indéfini de `getSchedule()` dès plusieurs commandes en attente sur le même poste (bug
  réel pré-existant, repéré via la suite de tests de `test_limit.js` : 30 commandes, `config:{}`,
  un seul poste). Corrigé en complétant individuellement chacun de ces quatre champs (comme les
  autres réglages déjà migrés un par un juste en dessous), et en appliquant le même correctif
  défensif à l'horaire spécifique d'un poste (`m.horaires`) pour la même classe de bug. Attention
  au piège inverse en écrivant ce genre de correctif : `friHours` peut légitimement valoir `0`
  (atelier fermé le vendredi) — un simple `if(!st.config.friHours)` l'aurait confondu avec
  "manquant" et écrasé ; la condition doit explicitement exclure `0` (`if(!st.config.friHours &&
  st.config.friHours !== 0)`), comme `margeEcheanceJours` le fait déjà un peu plus bas pour la
  même raison. Réflexe : toute nouvelle valeur de configuration numérique pouvant légitimement
  valoir `0`/`false` doit être testée avec `=== undefined`, jamais une simple négation.
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
- **Ascenseur d'une colonne remonté en haut par un `render()` intégral.** Chaque colonne du Kanban
  (`.kanban-col-body`) a son propre défilement indépendant. Cliquer une carte pour isoler sa commande
  (`card-isolate` → `toggleIsolateCommande` → `render()`) reconstruit tout `#app`, donc tous les
  `.kanban-col-body` d'un coup — un `<div>` neuf démarre toujours à `scrollTop=0` (bug réel : cliquer
  une carte en bas d'une colonne faisait "sauter" son ascenseur en haut à chaque clic). Corrigé sur le
  même principe que `modalScrollTop`/`restoreModalScroll` : chaque colonne porte un `data-col-key`
  (son `col.key`), `captureKanbanScroll()`/`restoreKanbanScroll()` mémorisent puis réappliquent la
  position de chaque colonne autour de `render()`. Réflexe : tout nouveau conteneur à défilement
  indépendant qui survit visuellement à un `render()` (et pas seulement les pop-up/modales, déjà
  couvertes) a besoin du même traitement capture-avant/restaure-après.
- **Nouveau module serveur oublié dans le `Dockerfile`.** Contrairement à `public/` (copié en bloc,
  `COPY public ./public`), les fichiers serveur sont copiés **un par un** (`COPY sessionHistory.js
  ./`, etc.) — pas de `COPY . .`. Ajouter un `require('./monModule')` dans `server.js` sans ajouter
  la ligne `COPY monModule.js ./` correspondante passe la vérification syntaxique locale
  (`node --check`) et tous les tests, mais fait planter le conteneur au démarrage une fois déployé
  (`Error: Cannot find module './monModule'`) — le fichier n'existe simplement pas dans l'image,
  aucun moyen de le détecter sans reconstruire l'image (bug réel : `previsionHistory.js`, requis par
  `server.js` mais absent du `Dockerfile`, a cassé le conteneur en production). Réflexe : tout
  nouveau fichier `.js` à la racine requis par `server.js` doit être ajouté au `Dockerfile` dans le
  même commit — vérifier après coup avec `grep -oE "require\('\./[a-zA-Z]+'\)" server.js` comparé à
  `grep "^COPY" Dockerfile`, les deux listes doivent se correspondre.
- **Surcharge horaire personnalisée appliquée à l'identique un jour particulier.**
  `applyUserLunchOverride` (horaire propre à une personne, un seul couple `heureDebut`/`heureFin`,
  pas de variante par jour) écrasait `friHours` avec la même valeur que `monThuHours` — une personne
  avec un horaire personnalisé affichait alors la même présence théorique un vendredi qu'un jour
  normal, alors que l'atelier peut fermer bien plus tôt ce jour-là pour tout le monde (bug réel,
  signalé par une présence théorique de 8-9h un vendredi au lieu des ~4h attendues). Corrigé en
  reportant sur `friHours` le même **ratio** que celui de l'atelier entre un jour normal et le
  vendredi (`friHours/monThuHours` d'origine), jamais une simple copie ni un report identique — une
  correction plus naïve (ex. laisser `friHours` intact, non modifié par la surcharge) casserait à son
  tour le cas où l'atelier ne distingue PAS le vendredi (`friHours===monThuHours` à la base) : une
  personne à temps partiel travaillant les mêmes heures réduites toute la semaine doit alors garder
  ce même horaire le vendredi aussi. Réflexe : toute nouvelle surcharge horaire (personne, poste...)
  qui touche à un champ décliné par jour de la semaine (`monThuHours`/`friHours`) doit préserver le
  ratio entre les jours plutôt que d'en écraser un avec la valeur d'un autre, ou de le laisser
  totalement intact en ignorant la surcharge.
- **Reprise automatique après pause horodatée au moment du contrôle, pas à la vraie fin de pause.**
  `applyAutoPauseResume` ne s'exécutait à l'origine que quand un onglet est ouvert (`startApp`, puis
  sa boucle de 60s) — jamais par un déclencheur serveur (corrigé depuis par `autoPauseResume.js`,
  voir plus haut « Reprise automatique de pause déjeuner, fiabilisée côté serveur » — mais le piège
  de fond ci-dessous reste valable pour QUICONQUE recalcule cet horodatage, client ou serveur). Si
  personne n'a l'appli ouverte entre la fin réelle d'une pause et la prochaine connexion (typiquement
  une pause programmée en fin de journée, ou un poste resté sans surveillance le soir), la reprise
  n'est constatée qu'à cette prochaine connexion, potentiellement des heures plus tard. Rouvrir la
  session à `now` (l'instant du contrôle, comme le faisait l'ancien code) horodatait alors la reprise
  à ce moment-là — ex. une pause déclenchée la veille au soir affichée comme reprise le lendemain
  matin (bug réel signalé pour un superviseur). Corrigé en mémorisant `o.autoPausedUntil` (l'heure de
  fin réelle de la pause, `pause.end`, posée dès l'auto-mise en pause) et en l'utilisant comme
  horodatage de la session rouverte plutôt que `now` — borné à `now` par sécurité (horloge cliente,
  config changée entre-temps : ne jamais ouvrir une session dans le futur). Réflexe : toute reprise
  "automatique" différée dans le temps doit horodater l'événement à quand il aurait dû se produire,
  jamais à quand il a été CONSTATÉ — y compris dans `autoPauseResume.js`, qui reproduit ce même choix
  à l'identique côté serveur.
  **Ce correctif est devenu sans objet : la reprise automatique de la pause déjeuner a depuis été
  retirée entièrement** (voir « Pop-up de retour de pause déjeuner » plus haut) — un cas réel de
  sessions dupliquées (le piège de fuseau horaire serveur ci-dessous) a montré qu'une reprise sans
  confirmation humaine n'est pas fiable. La reprise passe désormais toujours par un clic explicite
  de l'opérateur (`resumeFromPauseReminder`), horodaté à l'instant réel de ce clic — plus besoin de
  deviner "à quand l'événement aurait dû se produire" puisqu'il y a désormais une confirmation
  humaine directe. Ce paragraphe reste documenté pour le réflexe général (toute FUTURE reprise
  différée dans le temps, si le produit en réintroduit une un jour, doit s'en souvenir), pas parce
  que le code qu'il décrivait existe encore.
- **Redessin en cours de frappe dans un champ `type="date"`, comme un ancien bug déjà connu sur
  `type="time"`.** Le navigateur déclenche déjà "change" sur un champ `date` dès qu'un segment
  (jour/mois/année) atteint son nombre de chiffres attendu, sans attendre les autres segments ni la
  sortie du champ — un redessin à cet instant reconstruit l'`<input>` avec une valeur encore
  incomplète et fait sauter le curseur au segment suivant (bug réel signalé : année affichée "0002"
  en tapant dans le formulaire "Générer un rythme d'alternance"). `isDeferredTimeField` traitait déjà
  ce cas pour `type="time"` (redessin différé jusqu'au `focusout`) mais pas encore pour `type="date"`
  — corrigé en l'étendant aux deux types. Réflexe : tout nouveau champ natif segmenté (date, time,
  et plus généralement tout `<input>` dont la valeur peut être "complète" avant que l'utilisateur ait
  fini d'y saisir quelque chose) doit passer par ce même mécanisme de redessin différé.
- **Vider `sessions[]` à la clôture avant que l'opérateur réel n'ait été extrait ailleurs.**
  `applySingleStatusChange` (branche `termine`) vidait autrefois `sessions[]` immédiatement après
  avoir figé `dureeReelleH` — sans attendre l'archivage serveur, contrairement à
  `archiveOldSessions`. Ajouter un nouveau calcul qui a besoin du détail des sessions (qui a
  réellement travaillé, quand, etc.) APRÈS ce point ne verrait plus qu'un tableau vide : bug réel
  corrigé (`computeProductionTimeByUser` retombait sur l'opérateur ASSIGNÉ de la pièce pour tout
  `dureeReelleH`, quel que soit qui avait réellement ouvert les sessions — une tâche assignée à
  Sébastien mais réalisée par Romain créditait Sébastien une fois clôturée). Corrigé en figeant
  `pieces[].dureeReelleParOperateur` (répartition par opérateur) au même instant que `dureeReelleH`,
  **avant** que `sessions[]` ne soit vidé — voir `computeSessionsHoursByOperator`. Réflexe : tout ce
  qui doit survivre à la clôture d'une pièce et qui se déduit de `sessions[]` (pas seulement le
  total déjà couvert par `dureeReelleH`) doit être calculé et figé à ce même endroit, jamais après.
  **Ce correctif a depuis été rendu inutile par un second, plus radical : `sessions[]` n'est
  aujourd'hui plus vidée du tout à cet endroit** — voir « Archivage des sessions déclenché dès la
  clôture » plus bas, qui laisse `sessions[]` en place jusqu'à ce qu'`archiveOldSessions` confirme
  l'avoir bien enregistrée côté serveur. Ce correctif-ci reste documenté : le principe (figer AVANT
  qu'une donnée dérivée de `sessions[]` ne disparaisse) est le même, et `dureeReelleParOperateur`
  reste indispensable pour toute pièce dont `sessions[]` a fini par être vidée (une fois l'archivage
  confirmé, ou une pièce ancienne close avant l'introduction de ce mécanisme).
- **Fin d'une tâche `en_cours`/`en_pause` calculée comme « début + durée totale », sans jamais tenir
  compte des pauses.** L'ancien `stretchIfOverdueRunning` ne corrigeait un dépassement que pour le
  statut `en_cours`, jamais `en_pause` — une pièce interrompue plusieurs jours (opérateur qui alterne
  entre plusieurs tâches d'un même poste, la mettant en pause à chaque fois) gardait donc une fin
  calculée depuis son ancien début, qui pouvait tomber **dans le passé** alors qu'il restait
  réellement du travail (bug réel signalé : une pièce en_pause depuis une semaine, à moitié faite,
  affichait une fin déjà passée — invisible sur le planning visuel, et faussant les dépendances de
  phase des étapes suivantes de la même pièce, qui la croyaient déjà terminée). Corrigé en
  remplaçant ce calcul par `runningTaskEnd` : la fin est désormais toujours `maintenant + temps
  RESTANT` (`durée totale - temps réellement passé`, via `opElapsedHours`), jamais `début + durée
  totale`. Réflexe : toute fin projetée d'une tâche qui peut être interrompue doit se déduire du
  temps qu'il reste **réellement** à faire, projeté depuis maintenant — jamais d'une durée totale
  appliquée telle quelle depuis un point de départ ancien, qui ignore silencieusement tout ce qui
  s'est passé (ou pas) entre-temps.
- **Case à cocher écrasée par la règle globale `input,select{width:100%}`.** Cette règle (pensée
  pour les champs texte/nombre des formulaires) s'applique aussi, faute de sélecteur plus précis, à
  n'importe quel `<input type="checkbox">` — dans un conteneur flex (`.dd-panel-check`, label d'un
  menu déroulant), la case s'étire alors sur toute la largeur disponible et écrase visuellement
  l'espacement avec le texte à côté (bug réel repéré à la relecture visuelle du menu "Postes
  affichés" du Kanban : case à gauche, texte collé au bord droit, pastille de couleur du poste
  flottant entre les deux). Les anciennes puces `.kanban-filter-chip` avaient déjà ce correctif
  (`.kanban-filter-chip input{width:auto; ...}`) mais ce n'est pas un réflexe acquis : le nouveau
  `.dd-panel-check input` en manquait à l'écriture. Réflexe : toute checkbox/radio posée dans un
  nouveau conteneur (pas un simple `<label class="statut-chip">`/`<label class="field">` déjà
  couverts ailleurs) doit explicitement recevoir `width:auto`, jamais supposer que l'absence de
  `width` dans la règle du conteneur suffit.
- **Somme d'une durée sur plusieurs pièces sans dédupliquer les groupes fusionnés.**
  `computeProductionTimeByUser` sommait `dureePrevueH(o)`/le temps réel de chaque session pour
  CHAQUE pièce d'un groupe fusionné, alors que `dureeOverrideH` est déjà la somme du groupe ENTIER
  (posée à l'identique sur chaque membre) et que `setOpStatut` démarre/pause/clôture tout le groupe
  en même temps (sessions à horodatages identiques sur chaque membre — une seule opération physique
  sur le poste). Résultat : un lot de N pièces comptait pour N× son temps réel, prévu comme passé
  (bug réel signalé : un lot de 5 pièces à 9,5h/1,8h comptait pour 47,5h/9h, un lot de 3 pièces à
  10,2h comptait pour 30,6h — total affiché ~78h au lieu des ~19,7h réelles). `renderArchivesPanel`
  avait le même défaut pour le total par commande archivée. Corrigé en dédupliquant par
  `fusionGroupId` (un seul membre représente tout le groupe dans la somme — voir
  `sumDedupedByFusionGroup`/« Temps de production vs présence théorique » plus haut). Réflexe :
  toute nouvelle somme de durées sur une liste de pièces (`c.pieces`, ou un sous-ensemble plus large)
  doit se demander si ces pièces peuvent partager un `fusionGroupId` — si oui, dédupliquer, sinon le
  total gonfle avec le nombre de pièces du lot.
- **"Mémoriser l'état d'avant, restaurer à la fin" desynchronisé par une écriture directe pendant
  l'intervalle.** Neutraliser temporairement un réglage pendant une recherche (bandeaux repliés,
  filtre "Commande à livrer") en capturant sa valeur au début puis en la réappliquant à la fin
  (`xxxBeforeSearch`) a un point faible structurel : tout code qui écrit DIRECTEMENT ce réglage
  PENDANT l'intervalle (ex. re-sélectionner "Cette semaine" dans le menu tout en continuant de
  taper une recherche) contourne le mécanisme sans le savoir, et le réglage reste actif pour le
  reste de l'opération — bug réel signalé deux fois de suite (le correctif "mémoriser/restaurer" du
  filtre "Commande à livrer" pendant la recherche a été cassé par exactement ce scénario, dans la
  session qui l'a introduit). Corrigé en remplaçant la capture/restauration par un calcul à la
  volée, sans aucun état à synchroniser (`effectiveDueFilterRange()`/`isPanelEffectivelyCollapsed(key)`,
  voir « Recherche de commande/pièce » plus haut) : la neutralisation se déduit de `searchQuery` à
  chaque rendu, jamais mémorisée nulle part, donc jamais contournable par une écriture directe
  ailleurs. Réflexe : dès qu'un "avant/pendant/après" doit neutraliser un réglage existant plutôt
  que d'en introduire un nouveau, préférer une fonction pure qui recalcule l'effectif à chaque
  lecture plutôt qu'une capture ponctuelle suivie d'une restauration — la capture/restauration ne
  protège que les chemins qui passent par elle, jamais les écritures directes qui existent déjà
  ailleurs dans le code.
- **Toute session est perdue à chaque redémarrage du conteneur, quel que soit `SESSION_SECRET`.**
  En travaillant sur la détection automatique de mise à jour (`checkAppVersion`, voir « Rechargement
  automatique après déploiement »), vérification en conditions réelles (redémarrage du serveur pendant
  qu'une page reste ouverte) : le premier `pollRemoteState()` suivant reçoit systématiquement un 401,
  AVANT même d'atteindre la comparaison de version — pas un bug du nouveau mécanisme, mais une
  conséquence du `MemoryStore` par défaut d'`express-session` (aucun `store:` persistant configuré) :
  fixer `SESSION_SECRET` (déjà recommandé par le message au démarrage du serveur) évite seulement
  qu'un secret aléatoire invalide les cookies existants à la prochaine comparaison de signature — les
  données de session elles-mêmes, en mémoire du process, sont de toute façon détruites par n'importe
  quel redémarrage, y compris avec `SESSION_SECRET` fixe. `deploy.sh` redémarre systématiquement le
  conteneur (`docker compose up -d --build`) : aujourd'hui, un déploiement se traduit donc toujours,
  pour tout le monde, par une session invalidée — silencieusement pour un poste resté inactif (401
  volontairement ignoré par le poll, voir juste au-dessus), visible seulement à la prochaine action
  mutante de la personne (`renderLoginScreen('Votre session a expiré...')`). Réflexe pour toute
  future fonctionnalité qui suppose une session active en continu (comme le rechargement automatique
  ci-dessus) : vérifier son comportement à travers un VRAI redémarrage du processus serveur, pas
  seulement un rafraîchissement de `state`, sous peine de la croire fonctionnelle alors qu'elle ne
  s'exécute en pratique jamais après un déploiement réel. Rendre les sessions persistantes à travers
  un redémarrage demanderait un store dédié (ex. `connect-sqlite3` sur la même base) — non fait,
  changement plus large qu'une simple configuration.
- **Un aperçu qui se met à appeler `computeSchedule()` expose les fixtures de test à l'ancien piège
  du `config` incomplet.** `simulateImportStarts` (date de début « au mieux » à l'aperçu d'import,
  voir plus haut) a fait exécuter le moteur de planification dans un rendu (`renderCustomImportModal`,
  étape preview) qui ne le sollicitait jamais auparavant — un test de non-régression existant
  (`test_import_ignored_lines_detail.js`) construisait un `state.config` minimal
  (`{ matiereFusionActive, storageZones, importDateGroupingToleranceDays }`, sans jamais passer par
  `migrateState`) qui n'avait jamais posé problème puisque rien n'appelait le moteur sur cet état —
  jusqu'à ce que ce nouveau rendu le fasse, retombant exactement dans le piège déjà documenté plus
  haut (« `config` présent mais incomplet dans `migrateState()` ») : `nextWorkingInstant`/
  `addWorkingDuration` tournant à vide jusqu'à leur garde-fou, ralentissant le test au point de
  dépasser le timeout (15 s) de la suite. Corrigé en complétant le `config` de la fixture, pas en
  modifiant le moteur (un vrai `state` applicatif passe toujours par `migrateState`, donc ce
  `config` incomplet n'existe que dans un test construit à la main). Réflexe : tout nouveau code qui
  fait dépendre un rendu jusque-là "léger" de `computeSchedule()`/`getSchedule()` doit rejouer toute
  la suite de tests existante, pas seulement ses propres tests — un test qui construisait un `state`
  minimal en toute sécurité peut cesser de l'être du jour au lendemain.
- **Détacher `g.existing` d'une commande réelle en clonant un groupe d'import pour une simulation.**
  `simulateImportStarts` doit exécuter `commitImportGroups` sur une copie jetable de `state` (jamais
  le vrai) — la tentation immédiate est de cloner `groups` tel quel (`JSON.parse(JSON.stringify(...))`)
  en même temps que `state`. Piège : `g.existing`, quand il est posé, pointe vers une commande RÉELLE
  de `state.commandes` (pas une copie), et `commitImportGroups` la mute PAR RÉFÉRENCE pour lui
  ajouter les nouvelles pièces (`existing.pieces.push(...)`) — un clone JSON de `groups` détache
  `g.existing` de la copie de l'état (`clonedState`) sur laquelle tourne la simulation : les pièces
  "fusionnées dans une commande existante" ne rejoindraient alors AUCUNE commande visible de
  `clonedState.commandes`, et `computeSchedule` ne leur donnerait donc jamais de position. Corrigé en
  reconstruisant les groupes de simulation à la main, en rattachant explicitement `existing` à la
  commande de même id retrouvée DANS `clonedState.commandes`, plutôt qu'en clonant le groupe entier.
  Réflexe : avant de cloner un objet pour une simulation jetable, vérifier qu'aucun de ses champs ne
  porte une référence vers un objet qu'une fonction appelée ensuite mute par référence — sinon le
  clone silencieusement "perd" cette relation.
- **`parseFlexibleDate` renvoie une chaîne "AAAA-MM-JJ", jamais un objet `Date`.** En ajoutant la
  colonne "Date de début possible" à l'import (voir plus haut), première version : `const parsed =
  parseFlexibleDate(...); dateDebutPossible: parsed ? toDateInputValue(parsed) : null` — plantage
  immédiat (`d.getFullYear is not a function`), détecté par le test de non-régression avant tout
  déploiement. `parseFlexibleDate` fait DÉJÀ tout le travail de conversion en interne et renvoie
  directement la chaîne au format attendu par les champs `dateDebutPossible`/`dateBesoin` (ou `''`
  si illisible) — lui repasser le résultat dans `toDateInputValue` (qui attend un objet `Date`, pas
  une chaîne) est une erreur de type silencieuse à l'écriture, plantant seulement à l'exécution. Le
  reste du fichier l'utilise déjà correctement ainsi (`resolvedDate`, `datesByRef`, comparaisons de
  chaînes) — un nouveau point d'appel doit s'aligner sur ce contrat plutôt que de supposer qu'un
  nom de fonction commençant par "parse" renvoie l'objet qu'on imagine. Réflexe : avant de
  réutiliser le retour d'une fonction existante, vérifier son type réel (au besoin en lisant son
  corps), surtout quand un nom pourrait suggérer autre chose.
- **Règle CSS mobile sans effet face à un style inline sur le même élément.** Une règle `@media
  (max-width:...)` a une spécificité de classe normale : un `style="grid-template-columns:..."`
  posé en dur sur l'élément (nombre de colonnes propre à chaque formulaire, ex.
  `.commande-top-fields`) la bat systématiquement, quelle que soit la largeur d'écran — la règle
  mobile ne s'applique alors JAMAIS, en silence, sans erreur ni avertissement nulle part. Repéré en
  vérifiant "Nouvelle demande" (Congés) à 390px de large : les champs restaient sur plusieurs
  colonnes étroites malgré la règle `@media max-width:720px{.commande-top-fields{grid-template-
  columns:1fr;}}` déjà présente. `.commandes-columns` avait déjà ce correctif un peu plus haut dans
  la feuille de style (`!important`), mais ce n'est pas un réflexe acquis : `.commande-top-fields`
  n'avait pas reçu le même traitement. Réflexe : toute règle mobile visant une classe qui peut aussi
  recevoir un `style` inline (JS ou marquage) doit être **vérifiée en conditions réelles à largeur
  réduite** (DevTools ou Playwright avec un viewport étroit), jamais seulement relue dans le code —
  sous peine de croire un correctif effectif alors qu'il ne s'applique en pratique jamais. Si la
  vérification révèle le problème, ajouter `!important` à la règle mobile (même remède que
  `.commandes-columns`).
- **Job serveur qui interprète les horaires dans le fuseau de l'hôte, pas celui de la France.** Bug
  réel signalé (Romain, commande C025-1071) : une tâche reprise en pleine matinée de travail se
  remettait automatiquement en pause quelques dizaines de secondes plus tard, sans intervention de
  personne. Cause : le NAS (conteneur Docker) tourne par défaut en UTC, sans `TZ` explicite —
  `autoPauseResume.js` (job serveur `checkAutoPauseResume`, toutes les 60s, voir plus haut) lisait
  `new Date()` et les horaires naïfs `"AAAA-MM-JJTHH:mm"` (`sessions[]`, `debutReel`...) selon le
  fuseau LOCAL DU PROCESSUS — en UTC, une reprise à 08h54 heure française (CEST, UTC+2 en septembre)
  était donc lue comme 06h54, avant l'ouverture de l'atelier, et classée à tort "hors horaires" (voir
  « Mise en pause automatique hors horaires » plus haut) — avec en prime un horodatage de fin de
  session lui-même décalé de 2h trop tôt (`sessions[].fin` antérieur à `sessions[].debut` dans les
  données). Le calcul CLIENT (navigateur) n'a jamais ce problème : `new Date()` y utilise déjà le
  fuseau réel de l'utilisateur. Seul le job SERVEUR, qui tourne dans le conteneur, était concerné.
  Corrigé en fixant `process.env.TZ = 'Europe/Paris'` tout en tête de `server.js`, avant le moindre
  `require()` — cette application ne sert qu'un seul client français (comme les jours fériés déjà
  codés en dur), il n'y a jamais de raison de dépendre du fuseau de l'hôte. Une simple variable
  d'environnement `TZ` dans `docker-compose.yml` aurait aussi suffi, mais dépend d'un réglage qu'on
  pourrait oublier de reporter sur un futur redéploiement/nouvelle installation — le fixer en dur
  dans le code protège contre cet oubli (la variable est quand même ajoutée aussi à
  `docker-compose.yml`, en complément, jamais en remplacement). Réflexe : tout nouveau calcul
  SERVEUR qui lit `new Date()` ou parse un horaire naïf sans fuseau doit se rappeler que le résultat
  dépend du fuseau du PROCESSUS, jamais supposé aligné avec celui des utilisateurs — vérifié ici en
  testant explicitement le scénario avec `process.env.TZ` réassigné à `'UTC'` puis à
  `'Europe/Paris'` sur le même instant réel, pas seulement en relisant le code (voir
  `test_server_timezone_bug.js`). Une pièce déjà mise en pause à tort par ce bug avant le correctif
  ne reprend jamais automatiquement (comportement volontaire de la pause "hors horaires", voir plus
  haut) : l'opérateur doit cliquer "▶ Continuer" une fois le correctif déployé.
- **Archivage des sessions déclenché dès la clôture, pas seulement au prochain démarrage de
  l'appli.** `session_history` (voir plus haut) était devenue effectivement morte pour toute pièce
  close depuis l'introduction du correctif précédent (« Vider `sessions[]` à la clôture... ») :
  `applySingleStatusChange` vidait `sessions[]` IMMÉDIATEMENT à la clôture, avant même
  qu'`archiveOldSessions()` — qui ne tourne qu'au démarrage de l'appli (`startApp`) — n'ait eu la
  moindre chance de la lire. Toute pièce close après ce point n'avait donc plus jamais de détail de
  session archivé (la pop-up « Détail des horaires » retombait systématiquement sur
  `debutReel`/`finReel`/`dureeReelleH`, jamais sur le détail par session). Corrigé en deux temps :
  `applySingleStatusChange` ne vide plus `sessions[]` du tout à la clôture (seuls `dureeReelleH`/
  `dureeReelleParOperateur` y sont encore figés, comme avant) ; `setOpStatut` déclenche désormais
  lui-même `archiveOldSessions(state)` juste après son `commit()`, dès qu'une pièce passe `termine`
  — sans attendre le prochain démarrage. `archiveOldSessions` elle-même est inchangée (toujours
  asynchrone, ne vide `sessions[]` qu'une fois le serveur confirmé, idempotente côté serveur) : ce
  correctif ne fait que la déclencher plus tôt, à l'endroit où elle aurait toujours dû l'être.
  Réflexe : un mécanisme d'archivage différé (« vider une fois confirmé ») doit être DÉCLENCHÉ au
  bon moment, pas seulement correctement implémenté — un vidage prématuré ailleurs dans le code peut
  le rendre inoffensif en apparence (pas de perte de données visible) mais totalement inopérant.
- **Occupation d'une zone de stockage qui ignore le module "Libération manuelle du casier".** Bug
  réel signalé (retour utilisateur, page "Zones de stockage") : une commande entièrement terminée
  mais pas encore marquée "Prêt à expédier" (module `config.modules.expedition` actif — voir
  « Libération manuelle du casier » plus haut) affichait pourtant son casier comme "Libre" sur cette
  page, alors qu'`occupiedStorageZones`/`commandesInZone` la considéraient bien occupée ailleurs
  (badge de la commande, refus de désactiver le casier...) — `renderZonesPage` avait été oublié lors
  de l'introduction de ce module : elle filtrait encore les commandes actives avec l'ancien
  `isCommandeFullyDone(c)` au lieu d'`isCommandeReadyToFreeZone(state, c)`. Corrigé en alignant
  `renderZonesPage` sur cette dernière, comme les deux autres fonctions. À cette occasion, un bouton
  "🧹 Prêt à expédier" a été ajouté directement sur chaque casier occupé par une commande terminée en
  attente (module actif) — retour utilisateur : il fallait jusque-là aller chercher, dans "Tâches
  terminées" du Planning, la commande portant le bandeau orange équivalent, pas toujours évident à
  repérer dans une longue liste. Réutilise `markCommandePretExpedition` tel quel (aucune nouvelle
  action de dispatch), simplement rendu à un second endroit. Réflexe : toute nouvelle page/vue qui
  affiche "occupé/libre" pour une zone de stockage doit passer par `isCommandeReadyToFreeZone`,
  jamais directement par `isCommandeFullyDone` — les trois points existants (`occupiedStorageZones`,
  `commandesInZone`, l'avertissement de `removeStorageAllee`) donnent le bon modèle à suivre.

## Conventions

- **Interface entièrement en français**, y compris les messages d'erreur.
- Commentaires de code en français, expliquant le *pourquoi* (souvent un bug passé),
  pas le *quoi*.
- Les styles du tableau des tâches (`table.ops-table`) sont volontairement discrets :
  champs sans bordure au repos, révélés au survol et au focus.
- Ne pas ajouter de dépendance sans nécessité : le client est volontairement sans
  framework ni build.

## Numéro de version

`APP_VERSION` (tout en haut du `<script>` de `public/index.html`) — seule source de vérité pour le
numéro de version affiché dans l'application (écran de connexion, en-tête visible sur **toutes**
les pages une fois connecté via `renderHeader`, et pied de page du planning principal). Aucun suivi
de version réel n'existait avant (`package.json` restait figé à `"1.0.0"`, jamais modifié ; aucun
tag git) : `APP_VERSION` est parti de `'1.0.0'` comme premier numéro réellement suivi.

- **Incrémenté systématiquement à chaque commit livré**, en SemVer (`MAJEUR.MINEUR.CORRECTIF`) :
  `CORRECTIF` pour un correctif de bug, `MINEUR` pour une nouvelle fonctionnalité, `MAJEUR` réservé à
  un changement de rupture (pas encore arrivé sur ce projet). Aucune automatisation (pas de build, pas
  de hook de commit) : fait à la main, dans le même commit que le reste du changement — mais sans
  attendre qu'on le demande, à chaque livraison.
- Le champ `"version"` de `package.json` (serveur, jamais lu au runtime par l'application) doit être
  mis à jour en même temps que `APP_VERSION`, pour rester le reflet de la même version du produit,
  côté client comme côté serveur.

## Mention de copyright en dur (écran de connexion)

`« © {année} Découpe H2O »` s'affiche **toujours** sur l'écran de connexion, en dur — impossible à
faire disparaître, y compris depuis Paramètres → Affichage. `config.copyright` (« Mention
additionnelle sur l'écran de connexion ») ne remplace plus cette mention : il ajoute un second
texte, personnalisable, en plus d'elle — jamais à sa place.

- `defaultCopyrightMention()` — retourne `` `© ${annéeCourante} Découpe H2O` ``, calculée (pas une
  chaîne figée) pour que l'année reste juste sans intervention.
- `renderLoginScreen` affiche systématiquement `defaultMention` (`defaultCopyrightMention()`) dans
  un premier `.login-copyright`, puis un second **seulement** si `config.copyright` (ou
  `loginBranding.copyright`) est renseigné et diffère du texte par défaut (`showCustomCopyright`) —
  évite un doublon visuel pour une ancienne installation dont `config.copyright` valait encore
  exactement la mention par défaut (posée par une version antérieure de `migrateState`, avant ce
  changement).
- `migrateState` initialise `config.copyright` à `''` (pas à la mention par défaut) sur une config
  fraîche — puisque la mention en dur s'affiche de toute façon, il n'y a plus de raison de
  pré-remplir ce champ avec elle. Ne touche jamais une valeur déjà configurée.
