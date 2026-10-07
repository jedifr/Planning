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

// Corrections d'un superviseur EN LOT (pop-up « Corriger un pointage » : les changements s'empilent
// dans une liste en attente, un seul « Enregistrer » les applique). Trois sortes d'opérations :
//  - 'retype'  : changer le type (et/ou l'heure) d'un pointage existant — JAMAIS une modification :
//                une annulation de l'original + un remplaçant (source 'manuel', même heure, secondes
//                comprises, sauf heure explicitement modifiée) ;
//  - 'cancel'  : annuler un pointage ;
//  - 'add'     : ajouter un pointage.
// Tout est validé AVANT d'écrire quoi que ce soit, puis écrit dans UNE transaction : un lot est
// appliqué en entier ou pas du tout (jamais un original annulé sans remplaçant). Motif et commentaire
// communs au lot. Validées d'office (le route est réservée aux superviseurs).
function applyCorrections(db, o){
  const ops = Array.isArray(o.ops) ? o.ops : [];
  if(!ops.length) return { ok: false, error: 'Aucune modification à enregistrer.' };
  if(ops.length > 30) return { ok: false, error: 'Trop de modifications à la fois (30 maximum).' };
  const userId = String(o.userId || '');
  const L = t => (o.typeLabels && o.typeLabels[t]) || t;
  const note = extra => (extra + (o.commentaire ? ' — ' + o.commentaire : '')).slice(0, 500);
  const nowTs = localTs(new Date());
  const seen = new Set();
  const plan = [];
  for(const op of ops){
    const kind = String(op.kind || '');
    if(kind === 'add'){
      if(!PUNCH_TYPES.includes(op.type)) return { ok: false, error: 'Type de pointage inconnu.' };
      if(!TS_RE.test(String(op.ts || ''))) return { ok: false, error: 'Heure invalide.' };
      const ts = normTs(String(op.ts));
      if(ts > nowTs) return { ok: false, error: "Impossible d'ajouter un pointage dans le futur." };
      plan.push({ kind, type: op.type, ts, commentaire: o.commentaire ? String(o.commentaire).slice(0, 500) : null });
      continue;
    }
    if(kind !== 'retype' && kind !== 'cancel') return { ok: false, error: 'Opération inconnue.' };
    const orig = getPunch(db, op.id);
    if(!orig || orig.type === 'cancel' || orig.userId !== userId) return { ok: false, error: 'Pointage à modifier introuvable.' };
    if(seen.has(orig.id)) return { ok: false, error: `Le pointage de ${orig.ts.slice(11, 16)} est visé par deux modifications.` };
    seen.add(orig.id);
    const label = `${L(orig.type)} ${orig.ts.slice(11, 16)}`;
    if(orig.status !== 'valide') return { ok: false, error: `« ${label} » : seul un pointage validé peut être modifié.` };
    if(db.prepare("SELECT 1 FROM presence_punches WHERE type = 'cancel' AND cancels_id = ? AND status IN ('valide','a_valider')").get(orig.id))
      return { ok: false, error: `« ${label} » est déjà annulé (ou une annulation est en attente).` };
    if(kind === 'cancel'){ plan.push({ kind, orig, commentaire: o.commentaire ? String(o.commentaire).slice(0, 500) : null }); continue; }
    if(!PUNCH_TYPES.includes(op.type)) return { ok: false, error: 'Type de pointage inconnu.' };
    let ts = orig.ts;
    if(op.ts){
      if(!TS_RE.test(String(op.ts))) return { ok: false, error: 'Heure invalide.' };
      ts = normTs(String(op.ts));
      if(ts.slice(0, 10) !== orig.ts.slice(0, 10)) return { ok: false, error: `« ${label} » doit rester sur le même jour.` };
      if(ts !== orig.ts && ts > nowTs) return { ok: false, error: 'Impossible de placer un pointage dans le futur.' };
    }
    if(op.type === orig.type && ts === orig.ts) return { ok: false, error: `« ${label} » : aucun changement (choisissez un autre type ou une autre heure).` };
    plan.push({ kind, orig, type: op.type, ts, commentaire: note(`Changement : ${label} → ${L(op.type)} ${ts.slice(11, 16)}`) });
  }
  const written = [];
  db.transaction(() => {
    const base = { userId, source: 'manuel', createdBy: o.createdBy, status: 'valide', motif: o.motif, ip: o.ip };
    plan.forEach(x => {
      if(x.kind === 'add') written.push(insertPunch(db, { ...base, type: x.type, ts: x.ts, commentaire: x.commentaire }));
      else {
        written.push(insertPunch(db, { ...base, type: 'cancel', ts: x.orig.ts, cancelsId: x.orig.id, commentaire: x.commentaire }));
        if(x.kind === 'retype') written.push(insertPunch(db, { ...base, type: x.type, ts: x.ts, commentaire: x.commentaire }));
      }
    });
  })();
  return { ok: true, count: plan.length, punches: written };
}

// Contrôle des doublons (v1.102.0), À LA DEMANDE : parcourt les pointages RETENUS d'une période et
// signale deux pointages consécutifs du même salarié, le même jour, de même type —
//  - 'doublon' : à moins de `minutes` minutes l'un de l'autre (double badgeage, pointage manuel ajouté à
//                côté d'un pointage de la pointeuse...) ;
//  - 'repete'  : plus espacés mais enchaînement incohérent (deux arrivées de suite, deux départs...).
// Ne modifie rien : le traitement se fait par annulation (applyCorrections), l'original reste lisible.
function findDuplicates(db, from, to, minutes){
  const m = Math.max(1, Math.min(120, Number(minutes) || 5));
  const end = new Date(to + 'T12:00:00'); end.setDate(end.getDate() + 1);
  const rows = getPunchesBetween(db, from + 'T00:00:00', localTs(end).slice(0, 10) + 'T00:00:00');
  const eff = effectivePunches(rows);
  const groups = new Map();
  eff.forEach(p => { const k = p.userId + '|' + p.ts.slice(0, 10); if(!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
  const short = p => ({ id: p.id, ts: p.ts, source: p.source, createdBy: p.createdBy, motif: p.motif });
  const out = [];
  groups.forEach(list => {
    for(let i = 1; i < list.length; i++){
      const a = list[i - 1], b = list[i];
      if(a.type !== b.type) continue;
      const gapMin = Math.round((new Date(b.ts) - new Date(a.ts)) / 60000);
      out.push({ userId: a.userId, day: a.ts.slice(0, 10), type: a.type, kind: gapMin <= m ? 'doublon' : 'repete', gapMin, a: short(a), b: short(b) });
    }
  });
  return out.sort((x, y) => x.day < y.day ? 1 : x.day > y.day ? -1 : (x.userId < y.userId ? -1 : 1));
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

// Pointages manquants PROBABLES d'une journée (superviseur, pop-up de correction) — jamais enregistrés tout seuls : la
// pop-up les propose, prérenseignés, avec un bouton « ajouter ». Trois sources :
//  1. entrées écartées à l'import (`ignored`, reason 'doubleIn' : la pointeuse a une entrée alors que la personne était
//     déjà présente → une sortie n'a pas été badgée avant) : fin de pause à l'heure lue + début de pause à confirmer ;
//  2. deux pointages retenus de même sens à la suite (deux entrées, deux sorties) ;
//  3. journée passée restée ouverte (dernier pointage = entrée/fin de pause/début de pause) : départ à la fin d'horaire.
// `punches` = pointages retenus de la journée ; `expectedStart/End` = « HH:MM » de l'horaire de la personne (ou null).
// Un manque déjà comblé (pointage à la même minute) n'est plus proposé. `approx` = heure à vérifier.
function suggestMissing(o){
  const hm = ts => String(ts).slice(11, 16);
  const mn = h => { const a = String(h).split(':'); return Number(a[0]) * 60 + Number(a[1]); };
  const hmOf = m => { m = Math.max(0, Math.min(1439, Math.round(m))); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
  const isIn = p => p.type === 'in' || p.type === 'pause_end';
  const P = (o.punches || []).slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id || 0) - (b.id || 0));
  const have = new Set(P.map(p => hm(p.ts)));
  const out = [];
  const add = (type, time, why, approx) => { if(!out.some(x => x.type === type && x.time === time)) out.push({ type, time, why, approx: !!approx }); };
  (o.ignored || []).forEach(ev => {
    if(ev.reason !== 'doubleIn') return;
    const t = hm(ev.ts);
    if(have.has(t)) return;
    const prev = P.filter(p => p.ts < ev.ts).slice(-1)[0];
    add('pause_end', t, `La pointeuse a une entrée à ${t} sans sortie avant : retour de pause ou de sortie.`, false);
    if(!prev || isIn(prev)){
      const lo = prev ? mn(hm(prev.ts)) + 1 : 0;
      add('pause_start', hmOf(Math.max(lo, mn(t) - 10)), `Sortie non pointée avant l'entrée de ${t} — heure à confirmer.`, true);
    }
  });
  if(P.length && P[0].type !== 'in' && o.expectedStart){
    add('in', hmOf(Math.min(mn(o.expectedStart), mn(hm(P[0].ts)) - 1)), `Aucune arrivée pointée avant « ${hm(P[0].ts)} » — heure à confirmer.`, true);
  }
  for(let i = 1; i < P.length; i++){
    const a = P[i - 1], b = P[i];
    if(isIn(a) && isIn(b)){
      add('pause_start', hmOf(Math.max(mn(hm(a.ts)) + 1, mn(hm(b.ts)) - 10)), `Deux entrées de suite (${hm(a.ts)} puis ${hm(b.ts)}) : une sortie manque probablement — heure à confirmer.`, true);
    } else if(!isIn(a) && !isIn(b)){
      add(a.type === 'pause_start' ? 'pause_end' : 'in', hmOf(Math.min(mn(hm(b.ts)) - 1, mn(hm(a.ts)) + 10)), `Deux sorties de suite (${hm(a.ts)} puis ${hm(b.ts)}) : un retour manque probablement — heure à confirmer.`, true);
    }
  }
  if(o.isPast && P.length){
    const last = P[P.length - 1], lm = mn(hm(last.ts));
    const endT = o.expectedEnd && mn(o.expectedEnd) > lm ? o.expectedEnd : hmOf(lm + 1);
    if(isIn(last)) add('out', endT, `Journée passée sans départ pointé (dernier pointage : ${hm(last.ts)}) — heure à confirmer.`, true);
    else if(last.type === 'pause_start') add('out', endT, `Journée passée terminée sur un début de pause (${hm(last.ts)}) : départ non pointé — heure à confirmer.`, true);
  }
  return out.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
}
module.exports = {
  suggestMissing,
  PUNCH_TYPES, TS_RE, DATE_RE, initPresenceTables, localTs, normTs, effectivePunches, getPunchesBetween,
  getPunch, dayEffective, checkTransition, insertPunch, applyCorrections, findDuplicates, decidePunch, purgeOlderThan, getAllPunches,
  setPin, clearPin, usersWithPin, verifyPin, normIp, ipAllowed
};
