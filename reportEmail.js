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
  const consider = (c, o) => {
    if(!o.debutReel) return;
    const d = new Date(o.debutReel);
    if(isNaN(d.getTime()) || d < since) return;
    const j = retardDemarrageJours(o);
    if(j != null && j >= 0.5) rows.push({ commandeNom: c.nom, piece: o.piece, etape: o.etape, joursRetard: j });
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
  (state.commandes||[]).forEach(c => {
    if(isCommandeFullyDone(c)) return;
    c.pieces.forEach(o => {
      if(o.statut !== 'en_pause' || o.autoPaused || o.autoPausedOutOfHours) return;
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
  pausesSuspectesEnCours
};
