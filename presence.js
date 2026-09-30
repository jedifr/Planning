// Pointage présentiel (voir CLAUDE.md « Pointage présentiel ») — arrivées, pauses et départs des
// salariés, distincts des séances de travail sur les tâches (sessions[]). Table SQLite dédiée,
// JAMAIS incluse dans app_state ni dans la synchro habituelle (elle grossit sans borne, comme
// session_history), consultée à la demande par la borne, « Mon pointage » et la page Présence.
//
// Exigence légale « fiable et infalsifiable » : l'heure d'un pointage est TOUJOURS celle du serveur
// (jamais celle envoyée par la tablette ou le téléphone), et une ligne enregistrée n'est plus jamais
// modifiée — un déclencheur SQLite refuse toute mise à jour de ses champs de fond. Une correction
// ajoute une NOUVELLE ligne (source 'manuel', motif obligatoire, auteur), une erreur se neutralise par
// une ligne d'annulation (type 'cancel' + cancels_id) : le pointage d'origine reste lisible. Seuls les
// champs de décision (status/decided_by/decided_at) d'une demande de correction d'un salarié changent,
// une seule fois, quand un superviseur la valide ou la refuse. La seule suppression est la purge de
// conservation (3 ans par défaut, Paramètres → Pointage présentiel).
const bcrypt = require('bcryptjs');

const PUNCH_TYPES = ['in', 'out', 'pause_start', 'pause_end'];
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function initPresenceTables(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS presence_punches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ts TEXT NOT NULL,
      source TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'valide',
      cancels_id INTEGER,
      motif TEXT,
      commentaire TEXT,
      decided_by TEXT,
      decided_at TEXT,
      ip TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_presence_user_ts ON presence_punches (user_id, ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_presence_ts ON presence_punches (ts);`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS presence_punches_immuable
    BEFORE UPDATE OF user_id, type, ts, source, created_by, created_at, cancels_id, motif, commentaire, ip ON presence_punches
    BEGIN
      SELECT RAISE(ABORT, 'Un pointage enregistré ne peut pas être modifié.');
    END;
  `);
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if(!cols.includes('presence_pin_hash')) db.exec('ALTER TABLE users ADD COLUMN presence_pin_hash TEXT');
}

function pad(n){ return String(n).padStart(2, '0'); }
// Horodatage naïf à la seconde, fuseau du processus (Europe/Paris, fixé en tête de server.js).
function localTs(d){
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function normTs(ts){ return ts.length === 16 ? ts + ':00' : ts; }

function rowToPunch(r){
  return {
    id: r.id, userId: r.user_id, type: r.type, ts: r.ts, source: r.source, createdBy: r.created_by,
    createdAt: r.created_at, status: r.status, cancelsId: r.cancels_id, motif: r.motif || '',
    commentaire: r.commentaire || '', decidedBy: r.decided_by, decidedAt: r.decided_at
  };
}

// Pointages retenus : lignes validées, moins celles qu'une annulation validée neutralise, triées.
// Même règle que le client (effectivePresencePunches) — un seul sens pour « ce qui compte ».
function effectivePunches(punches){
  const cancelled = new Set(punches.filter(p => p.type === 'cancel' && p.status === 'valide').map(p => p.cancelsId));
  return punches
    .filter(p => p.type !== 'cancel' && p.status === 'valide' && !cancelled.has(p.id))
    .sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id);
}

function getPunchesBetween(db, from, to, userId){
  const rows = userId != null
    ? db.prepare('SELECT * FROM presence_punches WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts, id').all(String(userId), from, to)
    : db.prepare('SELECT * FROM presence_punches WHERE ts >= ? AND ts < ? ORDER BY ts, id').all(from, to);
  return rows.map(rowToPunch);
}
function getPunch(db, id){
  const r = db.prepare('SELECT * FROM presence_punches WHERE id = ?').get(Number(id));
  return r ? rowToPunch(r) : null;
}

// Pointage du jour de `ts` (validés et effectifs) pour contrôler l'enchaînement arrivée → pause → départ.
function dayEffective(db, userId, ts){
  const day = ts.slice(0, 10);
  return effectivePunches(getPunchesBetween(db, day + 'T00:00:00', day + 'T99', userId));
}
// Transition autorisée depuis le dernier pointage retenu du jour : évite un double badge « arrivée »
// ou une fin de pause sans début — erreurs d'usage qu'une correction devrait sinon rattraper.
function checkTransition(last, type){
  const lt = last ? last.type : null;
  if(type === 'in') return (!lt || lt === 'out') ? null : 'Vous êtes déjà pointé présent.';
  if(type === 'pause_start') return (lt === 'in' || lt === 'pause_end') ? null : (lt === 'pause_start' ? 'Vous êtes déjà en pause.' : "Pointez d'abord votre arrivée.");
  if(type === 'pause_end') return lt === 'pause_start' ? null : "Vous n'êtes pas en pause.";
  if(type === 'out') return (lt === 'in' || lt === 'pause_end' || lt === 'pause_start') ? null : "Pointez d'abord votre arrivée.";
  return 'Type de pointage inconnu.';
}

function insertPunch(db, p){
  const info = db.prepare(`
    INSERT INTO presence_punches (user_id, type, ts, source, created_by, created_at, status, cancels_id, motif, commentaire, ip)
    VALUES (@userId, @type, @ts, @source, @createdBy, @createdAt, @status, @cancelsId, @motif, @commentaire, @ip)
  `).run({
    userId: String(p.userId), type: p.type, ts: normTs(p.ts), source: p.source,
    createdBy: p.createdBy != null ? String(p.createdBy) : null, createdAt: new Date().toISOString(),
    status: p.status || 'valide', cancelsId: p.cancelsId != null ? Number(p.cancelsId) : null,
    motif: p.motif || null, commentaire: p.commentaire || null, ip: p.ip || null
  });
  return getPunch(db, info.lastInsertRowid);
}

function decidePunch(db, id, decision, byUserId){
  if(decision !== 'valide' && decision !== 'refuse') return { ok: false, error: 'Décision invalide.' };
  const p = getPunch(db, id);
  if(!p) return { ok: false, error: 'Demande introuvable.' };
  if(p.status !== 'a_valider') return { ok: false, error: 'Cette demande a déjà été traitée.' };
  db.prepare('UPDATE presence_punches SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
    .run(decision, String(byUserId), new Date().toISOString(), Number(id));
  return { ok: true, punch: getPunch(db, id) };
}

// Purge de conservation : tout pointage (et ses corrections) antérieur au délai choisi.
function purgeOlderThan(db, years){
  const y = Math.max(1, Math.min(10, Number(years) || 3));
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - y);
  return db.prepare('DELETE FROM presence_punches WHERE ts < ?').run(localTs(cutoff)).changes;
}
function getAllPunches(db){
  return db.prepare('SELECT * FROM presence_punches ORDER BY ts, id').all().map(rowToPunch);
}

// ---------- Code de pointage (borne) ----------
// Haché comme un mot de passe (bcrypt), jamais stocké ni renvoyé en clair. 4 à 6 chiffres.
function setPin(db, userId, pin){
  if(!/^\d{4,6}$/.test(String(pin || ''))) return { ok: false, error: 'Le code doit contenir 4 à 6 chiffres.' };
  db.prepare('UPDATE users SET presence_pin_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(pin), 10), Number(userId));
  return { ok: true };
}
function clearPin(db, userId){
  db.prepare('UPDATE users SET presence_pin_hash = NULL WHERE id = ?').run(Number(userId));
}
function usersWithPin(db){
  return db.prepare("SELECT id FROM users WHERE presence_pin_hash IS NOT NULL AND presence_pin_hash != ''").all().map(r => String(r.id));
}
// Limite les essais de code par personne (en mémoire) : 5 erreurs → 5 minutes de blocage.
const pinAttempts = new Map();
const PIN_MAX = 5, PIN_LOCK_MS = 5 * 60 * 1000;
function verifyPin(db, userId, pin){
  const key = String(userId);
  const a = pinAttempts.get(key);
  if(a && a.lockedUntil && a.lockedUntil > Date.now()) return { ok: false, error: 'Trop d’essais — code bloqué quelques minutes.' };
  const row = db.prepare('SELECT presence_pin_hash FROM users WHERE id = ?').get(Number(userId));
  if(!row || !row.presence_pin_hash) return { ok: false, error: "Aucun code de pointage n'est défini pour cette personne (Paramètres → Mon compte)." };
  if(bcrypt.compareSync(String(pin || ''), row.presence_pin_hash)){ pinAttempts.delete(key); return { ok: true }; }
  const count = (a && !a.lockedUntil ? a.count : 0) + 1;
  pinAttempts.set(key, count >= PIN_MAX ? { count, lockedUntil: Date.now() + PIN_LOCK_MS } : { count });
  return { ok: false, error: 'Code incorrect.' };
}

// Réseaux autorisés pour pointer depuis son téléphone : préfixes d'adresse séparés par des virgules,
// espaces ou retours à la ligne ("192.168.1." ou une adresse exacte). Liste vide = aucune restriction.
function normIp(ip){ return String(ip || '').replace(/^::ffff:/, ''); }
function ipAllowed(ip, reseaux){
  const list = String(reseaux || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if(!list.length) return true;
  const v = normIp(ip);
  return list.some(p => v === p || v.startsWith(p));
}

module.exports = {
  PUNCH_TYPES, TS_RE, DATE_RE, initPresenceTables, localTs, normTs, effectivePunches, getPunchesBetween,
  getPunch, dayEffective, checkTransition, insertPunch, decidePunch, purgeOlderThan, getAllPunches,
  setPin, clearPin, usersWithPin, verifyPin, normIp, ipAllowed
};
