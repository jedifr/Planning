// Alertes e-mail (quotidien/hebdomadaire) — voir CLAUDE.md « Alertes e-mail ». Portage
// VOLONTAIREMENT SIMPLIFIÉ, pas un simple portage à l'identique comme autoPauseResume.js : ce
// rapport n'appelle JAMAIS computeSchedule/getSchedule (le moteur de planification complet, qui vit
// uniquement côté client, voir public/index.html) — le dupliquer côté serveur serait un changement
// d'architecture bien plus large que ce qui est demandé ici. Le rapport se limite donc à des
// métriques calculables DIRECTEMENT à partir des champs déjà persistés sur les pièces (dates,
// rebuts[], previsionAuDemarrage/debutReel, sousTraitanceDateRetour, sessions[]) — jamais une fin
// projetée ni une notion de commande "à risque" (isCommandeAtRisk, qui a besoin du moteur).
// Réflexe explicite : toute évolution de la logique équivalente côté client (retardDemarrageJours,
// isUnexplainedPause, sousTraitanceRetardBadgeHtml...) qui changerait la SÉLECTION des données (pas
// seulement leur affichage) devrait être reportée ici aussi, sous peine de rapport trompeur.

function isCommandeFullyDone(c){
  return c.pieces.length > 0 && c.pieces.every(o => o.statut === 'termine');
}

// Commandes actives dont l'échéance (dateBesoin) est déjà dépassée AUJOURD'HUI — comparaison de date
// directe, pas "à risque" (qui nécessiterait une fin projetée par le moteur de planification).
function commandesEcheanceDepassee(state, now){
  const todayStr = now.toISOString().slice(0,10);
  return (state.commandes||[]).filter(c => !isCommandeFullyDone(c) && c.dateBesoin && c.dateBesoin < todayStr)
    .map(c => ({ commandeNom: c.nom, dateBesoin: c.dateBesoin }));
}

// Même calcul que retardDemarrageJours (public/index.html), réécrit en pur JS sur les champs déjà
// figés (previsionAuDemarrage.debut/debutReel) — aucun appel au moteur nécessaire, ces deux
// horodatages sont posés une fois pour toutes à la création/au premier démarrage de la pièce.
function retardDemarrageJours(o){
  if(!o.previsionAuDemarrage || !o.previsionAuDemarrage.debut || !o.debutReel) return null;
  const prevu = new Date(o.previsionAuDemarrage.debut);
  const reel = new Date(o.debutReel);
  if(isNaN(prevu.getTime()) || isNaN(reel.getTime())) return null;
  return (reel - prevu) / 86400000;
}
// Tâches démarrées en retard (>= 0,5 jour, même seuil que côté client) dont le démarrage réel tombe
// dans la période [since, maintenant] — parcourt commandes actives ET archivées, comme
// computeRetardDemarrageDetail côté client.
function tachesDemarreesEnRetard(state, since){
  const rows = [];
  // Un lot fusionné démarre d'un seul geste : une seule tâche en retard, pas une par pièce du lot
  // (même règle que computeRetardDemarrageDetail côté client).
  const seenGroups = new Set();
  const consider = (c, o) => {
    if(!o.debutReel) return;
    const d = new Date(o.debutReel);
    if(isNaN(d.getTime()) || d < since) return;
    const j = retardDemarrageJours(o);
    if(j != null && j >= 0.5){
      if(o.fusionGroupId){ if(seenGroups.has(o.fusionGroupId)) return; seenGroups.add(o.fusionGroupId); }
      rows.push({ commandeNom: c.nom, piece: o.piece, etape: o.etape, joursRetard: j });
    }
  };
  (state.commandes||[]).forEach(c => c.pieces.forEach(o => consider(c, o)));
  (state.commandesArchivees||[]).forEach(c => c.pieces.forEach(o => consider(c, o)));
  return rows.sort((a,b) => b.joursRetard - a.joursRetard);
}

// Rebuts déclarés dont la date tombe dans la période [since, maintenant].
function rebutsSurPeriode(state, since){
  let total = 0;
  const details = [];
  const consider = (c, o) => (o.rebuts||[]).forEach(r => {
    if(!r.date) return;
    const d = new Date(r.date);
    if(isNaN(d.getTime()) || d < since) return;
    total += Number(r.quantite) || 0;
    details.push({ commandeNom: c.nom, piece: o.piece, quantite: r.quantite, motif: r.motif || '' });
  });
  (state.commandes||[]).forEach(c => c.pieces.forEach(o => consider(c, o)));
  (state.commandesArchivees||[]).forEach(c => c.pieces.forEach(o => consider(c, o)));
  return { total, details };
}

// Sous-traitances en retard EN CE MOMENT (un état à l'instant du rapport, pas un événement de la
// période) — mêmes conditions que sousTraitanceRetardBadgeHtml côté client.
function sousTraitancesEnRetard(state, now){
  const todayStr = now.toISOString().slice(0,10);
  const rows = [];
  (state.commandes||[]).forEach(c => c.pieces.forEach(o => {
    if(!o.sousTraitance || o.statut === 'termine' || !o.sousTraitanceDateRetour) return;
    if(o.sousTraitanceDateRetour < todayStr) rows.push({ commandeNom: c.nom, piece: o.piece, dateRetour: o.sousTraitanceDateRetour });
  }));
  return rows;
}

// Pauses non expliquées EN COURS EN CE MOMENT (état, pas événement de la période) — version
// SIMPLIFIÉE d'isUnexplainedPause/pieceCurrentPauseGap (public/index.html) : mêmes champs
// (autoPaused/autoPausedOutOfHours) pour écarter une pause déjà expliquée, mais la durée de la pause
// en cours est lue directement sur la fin de la DERNIÈRE session fermée plutôt que via le calcul
// complet des trous entre sessions (pauseGapsForPiece) — suffisant pour un simple compteur de
// rapport, sans dupliquer une fonction plus élaborée pour ce seul besoin.
function pausesSuspectesEnCours(state, now, seuilH){
  const rows = [];
  // Un lot fusionné = une seule pause physique : une ligne par lot (même règle que
  // computePauseTimeParPoste côté client).
  const seenFusion = new Set();
  (state.commandes||[]).forEach(c => {
    if(isCommandeFullyDone(c)) return;
    c.pieces.forEach(o => {
      if(o.statut !== 'en_pause' || o.autoPaused || o.autoPausedOutOfHours) return;
      if(o.fusionGroupId){ if(seenFusion.has(o.fusionGroupId)) return; seenFusion.add(o.fusionGroupId); }
      const sessions = o.sessions || [];
      const last = sessions[sessions.length-1];
      if(!last || !last.fin) return;
      const finDate = new Date(last.fin);
      if(isNaN(finDate.getTime())) return;
      const h = (now - finDate) / 3600000;
      if(h >= seuilH) rows.push({ commandeNom: c.nom, piece: o.piece, etape: o.etape, depuisH: h });
    });
  });
  return rows.sort((a,b) => b.depuisH - a.depuisH);
}

const PAUSE_SEUIL_H = 1; // même seuil de bruit que PAUSE_ANOMALIE_SEUIL_H côté client

// ---- Tâches disponibles mais pas démarrées (v1.100.0) ----
// Portage SIMPLIFIÉ de computeDisponiblesNonDemarrees (public/index.html) : même sélection, sans moteur.
// « Disponible » = pièce « À faire » (ni sous-traitée, ni hors planning, ni sur un poste de sous-traitance)
// dont toutes les étapes précédentes sont terminées — mêmes prédécesseurs que le moteur
// (resolveEffectiveDeps, recopié ci-dessous). Elle l'est depuis la fin réelle de sa dernière étape précédente,
// ou depuis la création de la commande pour une première étape ; une date de début possible plus tardive prime.
// À reporter ici si la règle client change (voir l'avertissement en tête de fichier).
function resolveEffectiveDeps(pieces){
  const map = {};
  const pieceKey = p => String(p.piece || '').trim().toLowerCase();
  const groupPieceNames = {};
  const groupMyPhase = {};
  pieces.forEach(p => {
    if(!p.fusionGroupId) return;
    (groupPieceNames[p.fusionGroupId] = groupPieceNames[p.fusionGroupId] || new Set()).add(pieceKey(p));
    groupMyPhase[p.fusionGroupId + '|' + pieceKey(p)] = Number(p.phase) || 1;
  });
  pieces.forEach(p => {
    const myPhase = Number(p.phase) || 1;
    const myKey = pieceKey(p);
    map[p.id] = pieces.filter(other => {
      if(other.id === p.id) return false;
      if((Number(other.phase) || 1) >= myPhase) return false;
      if(pieceKey(other) === myKey) return true;
      if(other.fusionGroupId && groupPieceNames[other.fusionGroupId] && groupPieceNames[other.fusionGroupId].has(myKey)){
        const mine = groupMyPhase[other.fusionGroupId + '|' + myKey];
        return mine !== undefined && mine <= myPhase;
      }
      return false;
    }).map(o => o.id);
  });
  return map;
}
function dateKeyLocal(d){
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function joursCalendaires(since, now){
  const a = new Date(dateKeyLocal(since) + 'T12:00:00'), b = new Date(dateKeyLocal(now) + 'T12:00:00');
  return Math.max(0, Math.round((b - a) / 86400000));
}
function tachesDisponiblesNonDemarrees(state, now, seuilJours){
  if(!(seuilJours > 0)) return [];
  const todayKey = dateKeyLocal(now);
  const machines = state.machines || [];
  const out = [];
  (state.commandes || []).forEach(c => {
    if(!Array.isArray(c.pieces) || isCommandeFullyDone(c)) return;
    const deps = resolveEffectiveDeps(c.pieces);
    const byId = {}; c.pieces.forEach(x => byId[x.id] = x);
    const groups = {};
    const singles = [];
    c.pieces.forEach(o => { if(o.statut === 'a_faire' && o.fusionGroupId) (groups[o.fusionGroupId] = groups[o.fusionGroupId] || { members: [], blocked: false, since: null }).members.push(o); });
    c.pieces.forEach(o => {
      if(o.statut !== 'a_faire') return;
      const m = machines.find(mm => mm.id === o.machineId);
      let since = null;
      const concerned = !o.sousTraitance && !o.horsPlanning && m && !/sous[- ]traitance/i.test(m.nom || '') /* = machineNameLooksLikeSousTraitance côté client */;
      if(concerned){
        const preds = (deps[o.id] || []).map(id => byId[id]).filter(Boolean);
        if(!preds.length){ if(c.dateCreation) since = new Date(c.dateCreation); }
        else if(preds.every(x => x.statut === 'termine')){
          const fins = preds.map(x => x.finReel ? new Date(x.finReel).getTime() : 0);
          const last = Math.max(...fins);
          since = last > 0 ? new Date(last) : null;
        }
        if(since && isNaN(since.getTime())) since = null;
        if(o.dateDebutPossible){
          const d = new Date(o.dateDebutPossible + 'T00:00:00');
          if(!isNaN(d.getTime()) && (!since || d > since)) since = d;
        }
      }
      if(o.fusionGroupId){ const g = groups[o.fusionGroupId]; if(!since) g.blocked = true; else if(!g.since || since > g.since) g.since = since; }
      else if(since) singles.push({ o, since, m });
    });
    const emit = (o, since, m, nbPieces) => {
      if(since > now) return;
      const jours = joursCalendaires(since, now);
      if(jours < seuilJours) return;
      const depasse = !!(c.dateBesoin && c.dateBesoin < todayKey);
      const echeanceJours = depasse ? Math.max(1, Math.round((new Date(todayKey + 'T12:00:00') - new Date(c.dateBesoin + 'T12:00:00')) / 86400000)) : 0;
      out.push({ commandeNom: c.nom, piece: o.piece || '', etape: o.etape || '', machineNom: m.nom, jours, dateBesoin: c.dateBesoin || '', depasse, echeanceJours, nbPieces });
    };
    singles.forEach(x => emit(x.o, x.since, x.m, 1));
    Object.keys(groups).forEach(gid => {
      const g = groups[gid];
      if(g.blocked || !g.since) return;
      const m = machines.find(mm => mm.id === g.members[0].machineId);
      if(m) emit(g.members[0], g.since, m, g.members.length);
    });
  });
  return out.sort((a, b) => (a.depasse === b.depasse ? 0 : a.depasse ? -1 : 1)
    || (a.dateBesoin && b.dateBesoin ? a.dateBesoin.localeCompare(b.dateBesoin) : (a.dateBesoin ? -1 : b.dateBesoin ? 1 : 0))
    || b.jours - a.jours);
}
function seuilDisponibleJours(state){
  const v = Number(((state || {}).config || {}).dispoAlerteJours);
  return (isFinite(v) && v >= 0) ? Math.round(v) : 3; // champ absent d'un état non migré = valeur par défaut
}

// Formate une liste en limitant l'affichage aux N premiers éléments (évite un e-mail interminable
// sur un atelier avec beaucoup d'historique) — "+N autres" au-delà.
function formatListe(items, limit, toLine){
  if(!items.length) return '  (aucun)';
  const shown = items.slice(0, limit).map(it => `  - ${toLine(it)}`).join('\n');
  const rest = items.length - limit;
  return rest > 0 ? `${shown}\n  … et ${rest} autre(s)` : shown;
}

// Construit le corps texte du rapport (français, sans HTML — même simplicité que les autres e-mails
// de l'application, voir backup.js/sendNotificationEmail). `since` = début de la période couverte
// pour les métriques "sur la période" (échéance dépassée/sous-traitance/pauses restent des états
// instantanés, indépendants de `since`).
function buildReportText(state, now, since, frequenceLabel){
  const echeances = commandesEcheanceDepassee(state, now);
  const retards = tachesDemarreesEnRetard(state, since);
  const rebuts = rebutsSurPeriode(state, since);
  const sousTraitance = sousTraitancesEnRetard(state, now);
  const pauses = pausesSuspectesEnCours(state, now, PAUSE_SEUIL_H);
  const seuilDispo = seuilDisponibleJours(state);
  const disponibles = tachesDisponiblesNonDemarrees(state, now, seuilDispo);

  const lines = [];
  lines.push(`Rapport ${frequenceLabel} — Planning Atelier`);
  lines.push(`Généré le ${now.toLocaleString('fr-FR')}`);
  lines.push('');
  lines.push(`⏰ Commandes en échéance dépassée (${echeances.length})`);
  lines.push(formatListe(echeances, 15, r => `${r.commandeNom} — échéance du ${r.dateBesoin}`));
  lines.push('');
  lines.push(`🕓 Tâches démarrées en retard depuis le dernier rapport (${retards.length})`);
  lines.push(formatListe(retards, 15, r => `${r.commandeNom} — ${[r.piece,r.etape].filter(Boolean).join(' / ')} (${Math.round(r.joursRetard*10)/10} j de retard)`));
  lines.push('');
  lines.push(`🗑 Rebuts déclarés depuis le dernier rapport (${rebuts.total})`);
  lines.push(formatListe(rebuts.details, 15, r => `${r.commandeNom} — ${r.piece||'—'} : ${r.quantite}${r.motif?` (${r.motif})`:''}`));
  lines.push('');
  lines.push(`🏭 Sous-traitances en retard (${sousTraitance.length})`);
  lines.push(formatListe(sousTraitance, 15, r => `${r.commandeNom} — ${r.piece||'—'} (retour attendu le ${r.dateRetour})`));
  lines.push('');
  if(seuilDispo > 0){
    lines.push(`⏳ Tâches disponibles depuis plus de ${seuilDispo} j et pas démarrées (${disponibles.length}, dont ${disponibles.filter(r => r.depasse).length} à l'échéance dépassée)`);
    lines.push(formatListe(disponibles, 15, r => `${r.commandeNom} — ${r.machineNom} — ${[r.piece,r.etape].filter(Boolean).join(' / ') || '—'}${r.nbPieces > 1 ? ` (+${r.nbPieces-1} du même lot)` : ''} : disponible depuis ${r.jours} j${r.depasse ? `, échéance dépassée de ${r.echeanceJours} j` : (r.dateBesoin ? `, échéance le ${r.dateBesoin}` : '')}`));
    lines.push('');
  }
  lines.push(`⏸ Pauses actuellement non expliquées, au-delà d'1h (${pauses.length})`);
  lines.push(formatListe(pauses, 15, r => `${r.commandeNom} — ${[r.piece,r.etape].filter(Boolean).join(' / ')} (en pause depuis ${Math.round(r.depuisH*10)/10} h)`));
  lines.push('');
  lines.push('— Ce rapport ne reflète pas le moteur de planification (pas de notion de commande "à');
  lines.push('  risque" ni de fin projetée) : voir la page "Risques de retard" dans l\'application pour');
  lines.push('  une analyse complète.');
  return lines.join('\n');
}

module.exports = {
  buildReportText,
  commandesEcheanceDepassee,
  tachesDemarreesEnRetard,
  rebutsSurPeriode,
  sousTraitancesEnRetard,
  pausesSuspectesEnCours,
  tachesDisponiblesNonDemarrees
};
