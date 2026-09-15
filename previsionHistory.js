// Historique des estimations du moteur de planification juste avant qu'une pièce passe Terminée
// (voir applySingleStatusChange/archivePrevisionHistory dans public/index.html et CLAUDE.md). Sans
// cette table, la dernière position "prévue" par le moteur serait perdue pour toujours dès la
// clôture — computeSchedule ancre alors start/end sur les horaires réels (debutReel/finReel), il
// n'y a plus rien à "prévoir" une fois que c'est arrivé. Table dédiée, JAMAIS incluse dans le blob
// synchronisé à chaque poll/enregistrement — seulement incluse dans les sauvegardes, sur le même
// principe que session_history.
function initPrevisionHistoryTable(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS prevision_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commande_id TEXT NOT NULL,
      piece_id TEXT NOT NULL,
      commande_nom TEXT,
      ref_client TEXT,
      piece TEXT,
      etape TEXT,
      machine_nom TEXT,
      prevu_debut TEXT,
      prevu_fin TEXT,
      debut_reel TEXT,
      fin_reel TEXT,
      archived_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prevision_history_piece ON prevision_history (commande_id, piece_id);`);
  // Une pièce peut être rouverte ("↺ Rouvrir") puis re-clôturée : chaque clôture réelle (fin_reel
  // différente) mérite sa propre ligne d'historique, pas un écrasement — comme pour session_history.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prevision_history_unique ON prevision_history (piece_id, COALESCE(fin_reel, ''));`);
}

const MAX_BATCH_SIZE = 5000; // garde-fou contre un envoi anormalement volumineux

function insertPrevisionHistoryBatch(db, entries){
  if(!Array.isArray(entries) || !entries.length) return 0;
  const capped = entries.slice(0, MAX_BATCH_SIZE);
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO prevision_history
      (commande_id, piece_id, commande_nom, ref_client, piece, etape, machine_nom, prevu_debut, prevu_fin, debut_reel, fin_reel, archived_at)
    VALUES (@commandeId, @pieceId, @commandeNom, @refClient, @piece, @etape, @machineNom, @prevuDebut, @prevuFin, @debutReel, @finReel, @archivedAt)
  `);
  let inserted = 0;
  const insertMany = db.transaction((rows) => {
    rows.forEach(r => {
      if(!r || !r.commandeId || !r.pieceId) return; // entrée mal formée : ignorée plutôt que de faire échouer tout le lot
      const info = stmt.run({
        commandeId: String(r.commandeId),
        pieceId: String(r.pieceId),
        commandeNom: r.commandeNom || '',
        refClient: r.refClient || '',
        piece: r.piece || '',
        etape: r.etape || '',
        machineNom: r.machineNom || '',
        prevuDebut: r.prevuDebut || null,
        prevuFin: r.prevuFin || null,
        debutReel: r.debutReel || null,
        finReel: r.finReel || null,
        archivedAt: now
      });
      if(info.changes > 0) inserted++;
    });
  });
  insertMany(capped);
  return inserted;
}

function getPrevisionHistoryForPiece(db, commandeId, pieceId){
  return db.prepare(`
    SELECT prevu_debut AS prevuDebut, prevu_fin AS prevuFin, debut_reel AS debutReel, fin_reel AS finReel
    FROM prevision_history WHERE commande_id = ? AND piece_id = ? ORDER BY archived_at ASC
  `).all(String(commandeId), String(pieceId));
}

// Utilisé uniquement pour inclure l'historique complet dans une sauvegarde (zip e-mail) — jamais
// renvoyé au client via l'API normale de l'appli (voir GET /api/prevision-history/:cid/:oid).
function getAllPrevisionHistory(db){
  return db.prepare(`SELECT * FROM prevision_history ORDER BY archived_at ASC`).all();
}

module.exports = {
  initPrevisionHistoryTable, insertPrevisionHistoryBatch, getPrevisionHistoryForPiece, getAllPrevisionHistory
};
