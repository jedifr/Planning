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
| `previsionHistory.js` | Historique des prévisions du moteur avant clôture d'une tâche (voir plus bas). |

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
  `autoPausedOperators`, `autoPausedUntil`, `numeroLigne`, `previsionAvantCloture`, `horsPlanning`,
  `dureeReelleH`, `dureeReelleParOperateur` (voir sections
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
moment du contrôle, pas à la vraie fin de pause »).

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
session d'un second opérateur resterait ouverte indéfiniment. La reprise automatique après pause
déjeuner rouvre une session par opérateur qui était en train de travailler (`autoPausedOperators`,
peuplé à la pause, vidé à la reprise), pas une seule.

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

### Type sans décompte de solde (apprentis, etc.)

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

Bouton « ➕ Pointage rapide » (onglet Temps de production, superviseur et « Mon temps de production »)
— pour un salarié qui fait une tâche qui n'était pas prévue : démarre tout de suite une session sur
une commande choisie (ou une nouvelle créée à la volée), sans passer par le formulaire multi-lignes
« Nouvelle commande » (bien trop lourd pour ce cas d'usage — une seule tâche, pas une gamme complète).

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

`state.userDefaultPage` (`{ [userId]: 'planning'|'conges'|'tempsProd'|'zones'|'risques' }`) — chaque
personne choisit, dans Paramètres → **Mon compte** (section accessible à tout rôle, pas seulement à
un administrateur — voir `ADMIN_ONLY_SECTIONS`), la page affichée automatiquement à sa connexion, à
la place du Planning. Même principe que `userMachines`/`userLunch` : un réglage propre à une
personne, rangé dans `state` et synchronisé par le mécanisme habituel (`commit()`), **pas** une
préférence de navigateur comme le dernier profil d'import (`LAST_IMPORT_PROFILE_KEY`) — l'utilisateur
doit retrouver sa page d'accueil quel que soit le poste depuis lequel il se connecte.

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
  `applyAutoPauseResume` ne s'exécute que quand un onglet est ouvert (`startApp`, puis sa boucle de
  60s) — jamais par un déclencheur serveur. Si personne n'a l'appli ouverte entre la fin réelle
  d'une pause et la prochaine connexion (typiquement une pause programmée en fin de journée, ou un
  poste resté sans surveillance le soir), la reprise n'est constatée qu'à cette prochaine connexion,
  potentiellement des heures plus tard. Rouvrir la session à `now` (l'instant du contrôle, comme le
  faisait l'ancien code) horodatait alors la reprise à ce moment-là — ex. une pause déclenchée la
  veille au soir affichée comme reprise le lendemain matin (bug réel signalé pour un superviseur).
  Corrigé en mémorisant `o.autoPausedUntil` (l'heure de fin réelle de la pause, `pause.end`, posée
  dès l'auto-mise en pause) et en l'utilisant comme horodatage de la session rouverte plutôt que
  `now` — borné à `now` par sécurité (horloge cliente, config changée entre-temps : ne jamais ouvrir
  une session dans le futur). Réflexe : toute reprise "automatique" différée dans le temps doit
  horodater l'événement à quand il aurait dû se produire, jamais à quand il a été CONSTATÉ.
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
  `applySingleStatusChange` (branche `termine`) vide `sessions[]` immédiatement après avoir figé
  `dureeReelleH` — sans attendre l'archivage serveur, contrairement à `archiveOldSessions`. Ajouter
  un nouveau calcul qui a besoin du détail des sessions (qui a réellement travaillé, quand, etc.)
  APRÈS ce point ne verrait plus qu'un tableau vide : bug réel corrigé (`computeProductionTimeByUser`
  retombait sur l'opérateur ASSIGNÉ de la pièce pour tout `dureeReelleH`, quel que soit qui avait
  réellement ouvert les sessions — une tâche assignée à Sébastien mais réalisée par Romain créditait
  Sébastien une fois clôturée). Corrigé en figeant `pieces[].dureeReelleParOperateur` (répartition par
  opérateur) au même instant que `dureeReelleH`, **avant** que `sessions[]` ne soit vidé — voir
  `computeSessionsHoursByOperator`. Réflexe : tout ce qui doit survivre à la clôture d'une pièce et
  qui se déduit de `sessions[]` (pas seulement le total déjà couvert par `dureeReelleH`) doit être
  calculé et figé à ce même endroit, jamais après.
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
