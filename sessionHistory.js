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
    SELECT debut, fin FROM session_history WHERE commande_id = ? AND piece_id = ? ORDER BY debut ASC
  `).all(String(commandeId), String(pieceId));
}

// Utilisé uniquement pour inclure l'historique complet dans une sauvegarde (zip e-mail) — jamais
// renvoyé au client via l'API normale de l'appli (voir GET /api/session-history/:cid/:oid).
function getAllSessionHistory(db){
  return db.prepare(`SELECT * FROM session_history ORDER BY debut ASC`).all();
}

module.exports = {
  initSessionHistoryTable, insertSessionHistoryBatch, getSessionHistoryForPiece, getAllSessionHistory
};
