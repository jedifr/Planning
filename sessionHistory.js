// Historique des sessions de travail (Démarrer/Reprendre → Pause/Terminé), conservé indépendamment
// de app_state une fois qu'une pièce terminée voit ses sessions[] purgées côté client (voir
// backfillDureeReelle/archiveOldSessions dans public/index.html et CLAUDE.md). Table dédiée,
// JAMAIS incluse dans le blob synchronisé à chaque poll/enregistrement — seulement consultée à la
// demande (pop-up "Détail des horaires" sur une tâche ancienne) et incluse dans les sauvegardes.
function initSessionHistoryTable(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commande_id TEXT NOT NULL,
      piece_id TEXT NOT NULL,
      commande_nom TEXT,
      ref_client TEXT,
      piece TEXT,
      etape TEXT,
      machine_nom TEXT,
      operator_user_id TEXT,
      debut TEXT NOT NULL,
      fin TEXT,
      archived_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_history_piece ON session_history (commande_id, piece_id);`);
  // Empêche les doublons si deux onglets/postes archivent la même session en même temps
  // (chacun purge indépendamment côté client) — sans ça, un simple INSERT OR IGNORE ne suffirait pas.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_session_history_unique ON session_history (piece_id, debut, COALESCE(fin, ''));`);
}

const MAX_BATCH_SIZE = 5000; // garde-fou contre un envoi anormalement volumineux

function insertSessionHistoryBatch(db, entries){
  if(!Array.isArray(entries) || !entries.length) return 0;
  const capped = entries.slice(0, MAX_BATCH_SIZE);
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO session_history
      (commande_id, piece_id, commande_nom, ref_client, piece, etape, machine_nom, operator_user_id, debut, fin, archived_at)
    VALUES (@commandeId, @pieceId, @commandeNom, @refClient, @piece, @etape, @machineNom, @operatorUserId, @debut, @fin, @archivedAt)
  `);
  let inserted = 0;
  const insertMany = db.transaction((rows) => {
    rows.forEach(r => {
      if(!r || !r.commandeId || !r.pieceId || !r.debut) return; // entrée mal formée : ignorée plutôt que de faire échouer tout le lot
      const info = stmt.run({
        commandeId: String(r.commandeId),
        pieceId: String(r.pieceId),
        commandeNom: r.commandeNom || '',
        refClient: r.refClient || '',
        piece: r.piece || '',
        etape: r.etape || '',
        machineNom: r.machineNom || '',
        operatorUserId: r.operatorUserId != null ? String(r.operatorUserId) : null,
        debut: r.debut,
        fin: r.fin || null,
        archivedAt: now
      });
      if(info.changes > 0) inserted++;
    });
  });
  insertMany(capped);
  return inserted;
}

function getSessionHistoryForPiece(db, commandeId, pieceId){
  return db.prepare(`
    SELECT debut, fin, operator_user_id AS operatorUserId
    FROM session_history WHERE commande_id = ? AND piece_id = ? ORDER BY debut ASC
  `).all(String(commandeId), String(pieceId));
}

// Fiche salarié : séances archivées d'une personne qui recoupent [from, to[ (horaires naïfs
// "AAAA-MM-JJTHH:mm", triables tels quels). Une séance sans operator_user_id (archivée avant le
// suivi par séance) est renvoyée aussi : le client la rattache à l'opérateur assigné de la pièce.
function getSessionHistoryForUser(db, userId, from, to){
  return db.prepare(`
    SELECT commande_id AS cid, piece_id AS oid, commande_nom AS commandeNom, piece, etape,
           machine_nom AS machineNom, operator_user_id AS operatorUserId, debut, fin
    FROM session_history
    WHERE (operator_user_id = ? OR operator_user_id IS NULL)
      AND debut < ? AND (fin IS NULL OR fin > ?)
    ORDER BY debut ASC
  `).all(String(userId), String(to), String(from));
}
// Temps de production sur une période : séances archivées (toutes personnes) des pièces qui recoupent
// [from, to[. Sert à répartir au jour le jour une tâche close dont sessions[] a été purgé de l'état
// (sinon tout son temps était attribué en bloc à la date de clôture).
function getSessionHistoryRange(db, from, to){
  // TOUTES les séances des pièces qui recoupent la période (pas seulement celles qui la recoupent) :
  // le client a besoin du total de la pièce pour répartir son temps figé (dureeReelleH) au prorata.
  return db.prepare(`
    SELECT piece_id AS oid, operator_user_id AS operatorUserId, debut, fin
    FROM session_history
    WHERE piece_id IN (SELECT piece_id FROM session_history WHERE debut < ? AND (fin IS NULL OR fin > ?))
    ORDER BY debut ASC
  `).all(String(to), String(from));
}
// Pièces ayant au moins une séance archivée pour cette personne (toutes dates) : permet au client de
// distinguer une tâche close dont le détail existe (hors période affichée) d'une tâche close avant
// l'archivage des séances, dont seul le total est connu.
function getSessionHistoryPieceIdsForUser(db, userId){
  return db.prepare(`
    SELECT DISTINCT piece_id AS oid FROM session_history WHERE operator_user_id = ? OR operator_user_id IS NULL
  `).all(String(userId)).map(r => r.oid);
}

// Utilisé uniquement pour inclure l'historique complet dans une sauvegarde (zip e-mail) — jamais
// renvoyé au client via l'API normale de l'appli (voir GET /api/session-history/:cid/:oid).
function getAllSessionHistory(db){
  return db.prepare(`SELECT * FROM session_history ORDER BY debut ASC`).all();
}

module.exports = {
  initSessionHistoryTable, insertSessionHistoryBatch, getSessionHistoryForPiece, getSessionHistoryForUser, getSessionHistoryRange, getSessionHistoryPieceIdsForUser, getAllSessionHistory
};
