// Bascule automatiquement en pause les tâches en_cours dont l'opérateur assigné entre dans sa
// pause déjeuner (avec reprise automatique), ou sort des horaires de travail — week-end, avant
// l'ouverture, après la fermeture (SANS reprise automatique, voir plus bas). Portage volontairement
// minimal du même calcul déjà présent côté client (public/index.html : pauseWindowsFor/
// pauseWindowFor/dayIntervals/applyUserLunchOverride/effectiveConfig/configForMachineId/
// configForPiece/isInPauseWindow/applyAutoPauseResume), nécessaire pour que ce contrôle tourne même
// quand personne n'a l'appli ouverte dans un navigateur (voir CLAUDE.md, piège « Reprise automatique
// après pause horodatée au moment du contrôle, pas à la vraie fin de pause » — jusqu'ici, ce calcul
// ne s'exécutait que dans la boucle de 60s de startApp()).
//
// RÉFLEXE : toute modification de la logique de résolution d'horaire par personne côté client
// (applyUserLunchOverride, pauseWindowsFor, dayIntervals, la fermeture de TOUTES les sessions
// ouvertes plutôt qu'une seule...) doit être reportée ICI à l'identique. Ce fichier n'est jamais
// généré automatiquement à partir de public/index.html — la duplication est manuelle et peut donc
// diverger si on ne pense pas aux deux côtés.
//
// Simplification assumée par rapport à la version client : `effectiveConfig` y calcule en plus les
// indisponibilités automatiques d'un poste dont TOUS les opérateurs liés sont en congé
// (operatorLeaveIntersection) — sans incidence sur le calcul de pause déjeuner, et cette fonction
// dépend de `usersList` (uniquement disponible côté client, pour le libellé d'infobulle) qu'il
// aurait été inutile de porter pour un résultat sans effet sur ce calcul. `isDateBlocked` (ci-dessous)
// reste néanmoins portée pour la détection "hors horaires" : `cfg.indisponibilites` propres à un
// poste (maintenance saisie manuellement, pas les congés d'opérateur) y sont bien lues, seule
// l'agrégation automatique par congé d'opérateur est omise.

function pad(n){ return String(n).padStart(2, '0'); }
function toInputValue(d){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function toDateInputValue(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

// Identique à pauseWindowsFor (public/index.html) : toutes les pauses effectives pour ce cfg à
// cette date, triées et fusionnées si elles se chevauchent. `cfg.pauses` (plusieurs pauses propres
// à une personne) prime s'il est présent et non vide ; sinon repli sur l'ancien format à une seule
// pause (pauseActive/pauseDebut/pauseFin), utilisé par la config globale et les horaires de poste.
function pauseWindowsFor(date, cfg){
  const defs = (cfg.pauses && cfg.pauses.length) ? cfg.pauses
    : (cfg.pauseActive && cfg.pauseDebut && cfg.pauseFin ? [{ debut: cfg.pauseDebut, fin: cfg.pauseFin }] : []);
  const raw = [];
  defs.forEach(p => {
    if(!p.debut || !p.fin) return;
    const [ph, pm] = p.debut.split(':').map(Number);
    const [qh, qm] = p.fin.split(':').map(Number);
    if(isNaN(ph) || isNaN(qh)) return;
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), ph, pm||0, 0, 0);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), qh, qm||0, 0, 0);
    if(end > start) raw.push({ start, end });
  });
  raw.sort((a,b) => a.start - b.start);
  const merged = [];
  raw.forEach(w => {
    const last = merged[merged.length-1];
    if(last && w.start <= last.end){ if(w.end > last.end) last.end = w.end; }
    else merged.push({ start: w.start, end: w.end });
  });
  return merged;
}
// Pause active à cet instant précis, s'il y en a une.
function pauseWindowFor(date, cfg){
  return pauseWindowsFor(date, cfg).find(w => date >= w.start && date < w.end) || null;
}

// Identique à applyUserLunchOverride (public/index.html) : applique la pause/l'horaire propre à
// une personne (userLunch) par-dessus un horaire de base. Le ratio lun.-jeu./vendredi de l'horaire
// de base est préservé pour un horaire personnalisé (jamais un report identique de friHours) — un
// bug réel déjà corrigé côté client, voir CLAUDE.md.
function applyUserLunchOverride(cfg, userId, st){
  const userLunch = userId && st.userLunch ? st.userLunch[userId] : null;
  if(!userLunch) return cfg;
  let result = cfg;
  if(userLunch.pauseActive){
    result = { ...result, pauseActive: true, pauses: userLunch.pauses || [], pauseDebut: undefined, pauseFin: undefined };
  }
  if(userLunch.horaireActif && userLunch.heureDebut && userLunch.heureFin){
    const [sh, sm] = userLunch.heureDebut.split(':').map(Number);
    const [eh, em] = userLunch.heureFin.split(':').map(Number);
    if(!isNaN(sh) && !isNaN(eh)){
      const totalMin = (eh*60 + (em||0)) - (sh*60 + (sm||0));
      const pauseMin = pauseWindowsFor(new Date(2000,0,3), result).reduce((s,w) => s + (w.end.getTime()-w.start.getTime())/60000, 0);
      const workingHours = Math.max(0, (totalMin - pauseMin) / 60);
      const friRatio = result.monThuHours > 0 ? (result.friHours / result.monThuHours) : 1;
      result = { ...result, startHour: sh, startMinute: sm||0, monThuHours: workingHours, friHours: workingHours * friRatio };
    }
  }
  return result;
}

// Équivalent simplifié d'effectiveConfig/configForMachineId (voir note en tête de fichier sur
// l'omission volontaire d'operatorLeaveIntersection, sans incidence sur le calcul de pause).
// `m.indisponibilites` propres au poste (saisies manuellement, ex. maintenance), elles, sont
// reportées — utilisées par isDateBlocked pour la détection "hors horaires".
function configForMachineId(machineId, st){
  const m = (st.machines||[]).find(mm => mm.id === machineId);
  const base = (m && m.horairesActifs && m.horaires) ? { ...st.config, ...m.horaires } : { ...st.config };
  base.indisponibilites = (m && Array.isArray(m.indisponibilites)) ? m.indisponibilites : [];
  return base;
}
function configForPiece(op, st){
  const cfg = configForMachineId(op.machineId, st);
  return applyUserLunchOverride(cfg, op.operatorUserId, st);
}
function isInPauseWindow(op, now, st){
  const cfg = configForPiece(op, st);
  const pause = pauseWindowFor(now, cfg);
  return !!(pause && now >= pause.start && now < pause.end);
}

// Identique à isDateBlocked/dayHoursFor/dayStartFor/dayIntervals (public/index.html) — nécessaires
// ici pour déterminer si "maintenant" tombe dans une plage de travail réelle (voir "hors horaires"
// plus bas), pas seulement dans/hors de la pause déjeuner.
function isDateBlocked(date, cfg){
  const list = cfg.indisponibilites;
  if(!list || !list.length) return false;
  const ds = toDateInputValue(date);
  return list.some(p => p.debut && p.fin && ds >= p.debut && ds <= p.fin);
}
function dayHoursFor(dow, cfg){ return dow===5 ? cfg.friHours : cfg.monThuHours; }
function dayStartFor(d, cfg){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), cfg.startHour, cfg.startMinute, 0, 0); }
function dayIntervals(date, cfg){
  const dow = date.getDay();
  const dh = dayHoursFor(dow, cfg);
  const dStart = dayStartFor(date, cfg);
  const nominalEnd = new Date(dStart.getTime() + dh*3600000);
  const pauses = pauseWindowsFor(date, cfg).filter(p => p.end > dStart && p.start < nominalEnd);
  if(!pauses.length) return [[dStart, nominalEnd]];
  let dEnd = new Date(nominalEnd.getTime() + pauses.reduce((s,p) => s + (p.end.getTime()-p.start.getTime()), 0));
  let cursor = dStart;
  const segs = [];
  pauses.forEach(pause => {
    const pStart = pause.start < cursor ? cursor : pause.start;
    const pauseMs = pause.end.getTime() - pause.start.getTime();
    const pEnd = new Date(pStart.getTime() + pauseMs);
    if(pStart > cursor) segs.push([new Date(cursor.getTime()), pStart]);
    cursor = pEnd;
  });
  if(cursor < dEnd) segs.push([cursor, dEnd]);
  return segs.length ? segs : [[dStart, dEnd]];
}

// Retour utilisateur réel : une tâche `en_cours` restait affichée telle quelle tout un week-end (ou
// toute une nuit) si personne n'avait pensé à cliquer "Pause" avant de partir — la pause déjeuner
// automatique ne couvre que le créneau de midi, rien ne gérait le "hors horaires" au sens large.
// Distinct de la pause déjeuner à un point essentiel : PAS DE REPRISE AUTOMATIQUE le jour ouvré
// suivant — contrairement à `autoPausedUntil`/`autoPausedOperators`, qui donnent au job le moyen de
// rouvrir tout seul la bonne session à la bonne heure, ici on veut au contraire que la tâche reste
// en pause jusqu'à ce qu'un opérateur la relance lui-même, en connaissance de cause (ex. reprendre
// un travail resté en plan toute la nuit peut nécessiter une vérification physique de la pièce).
//
// Renvoie 'lunch' | 'outOfHours' | null (aucune action) pour une pièce actuellement en_cours.
// `isWorkDay` conditionne le créneau de pause déjeuner lui-même (pas seulement les horaires
// classiques) : sans ce garde-fou, une pièce restée en_cours un samedi verrait `isInPauseWindow`
// répondre "oui" entre 12h et 13h (elle ne regarde que l'heure, pas le jour de la semaine) et
// basculerait à tort en pause déjeuner — avec reprise automatique à 13h alors que c'est le week-end
// tout entier qui aurait dû la mettre en pause, sans reprise, dès la sortie du vendredi.
function pauseKindForRunningTask(op, now, st){
  const cfg = configForPiece(op, st);
  const dow = now.getDay();
  const isWorkDay = dow !== 0 && dow !== 6 && !isDateBlocked(now, cfg);
  if(isWorkDay && isInPauseWindow(op, now, st)) return 'lunch';
  const withinSegment = isWorkDay && dayIntervals(now, cfg).some(([s,e]) => now >= s && now < e);
  return withinSegment ? null : 'outOfHours';
}

// Identique à applyAutoPauseResume (public/index.html) — voir là-bas pour le détail des choix déjà
// documentés dans CLAUDE.md : fermer TOUTES les sessions ouvertes (`.filter`, jamais `.find`, voir
// « Travail à plusieurs sur une même pièce ») et rouvrir la session de la pause déjeuner à l'heure
// RÉELLE de fin de pause (`autoPausedUntil`), jamais à l'instant où ce contrôle s'exécute. `now`
// injectable pour les tests, sinon l'heure serveur actuelle.
function applyAutoPauseResume(st, now){
  now = now || new Date();
  let changed = false;
  (st.commandes||[]).forEach(c => {
    (c.pieces||[]).forEach(o => {
      if(!o.machineId) return;
      if(o.statut === 'en_cours'){
        const kind = pauseKindForRunningTask(o, now, st);
        if(kind === 'lunch'){
          const cfg = configForPiece(o, st);
          const pause = pauseWindowFor(now, cfg);
          const openSessions = (o.sessions||[]).filter(s => !s.fin);
          openSessions.forEach(s => { s.fin = toInputValue(pause.start); });
          o.autoPausedOperators = openSessions.map(s => s.operatorUserId || null);
          o.autoPausedUntil = toInputValue(pause.end);
          o.statut = 'en_pause';
          o.autoPaused = true;
          changed = true;
        } else if(kind === 'outOfHours'){
          const openSessions = (o.sessions||[]).filter(s => !s.fin);
          openSessions.forEach(s => { s.fin = toInputValue(now); });
          o.statut = 'en_pause';
          // Jamais autoPaused=true ici : ce flag est ce qui déclenche la reprise automatique
          // ci-dessous (branche "en_pause"/"autoPaused") — le laisser à false range cette pause
          // hors horaires dans le même panier qu'une pause manuelle, et donc visible telle quelle
          // dans la bannière "tâches en pause depuis la veille ou avant" (pausedSinceEarlierTasks,
          // qui exclut justement autoPaused) sans code d'affichage supplémentaire à écrire.
          o.autoPaused = false;
          o.autoPausedOutOfHours = true; // informatif — jamais lu par un mécanisme de reprise
          o.autoPausedOperators = null;
          o.autoPausedUntil = null;
          changed = true;
        }
      } else if(o.statut === 'en_pause' && o.autoPaused && !isInPauseWindow(o, now, st)){
        if(!o.sessions) o.sessions = [];
        const operators = (o.autoPausedOperators && o.autoPausedOperators.length)
          ? o.autoPausedOperators
          : [ (o.sessions[o.sessions.length-1]||{}).operatorUserId || o.operatorUserId || null ];
        const resumeDate = o.autoPausedUntil ? new Date(o.autoPausedUntil) : now;
        const resumeStr = toInputValue(resumeDate < now ? resumeDate : now);
        operators.forEach(opId => o.sessions.push({ debut: resumeStr, fin: null, operatorUserId: opId }));
        o.autoPausedOperators = null;
        o.autoPausedUntil = null;
        o.statut = 'en_cours';
        o.autoPaused = false;
        changed = true;
      }
    });
  });
  return changed;
}

module.exports = {
  applyAutoPauseResume,
  isInPauseWindow,
  pauseKindForRunningTask,
  configForPiece,
  configForMachineId,
  pauseWindowFor,
  pauseWindowsFor,
  applyUserLunchOverride,
  dayIntervals,
  isDateBlocked,
};
