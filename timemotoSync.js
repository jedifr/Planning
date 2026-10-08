// Import des pointages de la pointeuse TimeMoto TM-616 via TimeMoto Cloud (voir CLAUDE.md « Pointeuse
// TimeMoto TM-616 »). Sans formule Plus (ni webhook ni clé d'API officielle), la seule voie est
// l'API interne du site TimeMoto Cloud — non documentée, elle peut changer sans prévenir.
//
// IMPORTANT — pas de connexion automatique. La page de connexion de TimeMoto est protégée par un
// reCAPTCHA (vérification anti-robot de Google) : le serveur ne peut donc PAS se connecter seul, et
// on ne cherche pas à contourner cette protection. C'est l'utilisateur qui se connecte lui-même à
// TimeMoto dans son navigateur (il passe donc le reCAPTCHA), récupère son jeton d'accès d'un clic
// (marque-page fourni dans Paramètres) et le colle dans Planning. Le jeton sert à cette seule
// lecture, il n'est jamais enregistré (ni dans app_state, ni en base, ni dans les sauvegardes ni
// les logs) — il vit le temps d'une requête, puis est oublié.
//
// Import : chaque paire entrée/sortie de TimeMoto devient des pointages de la table presence_punches
// (source 'timemoto', heure de la pointeuse). Réconciliation par (salarié TimeMoto, jour) : ce qui
// manque est ajouté, ce qui a disparu ou changé côté TimeMoto est ANNULÉ par une ligne d'annulation
// — jamais modifié ni supprimé (même règle « infalsifiable » que le reste du module). Une annulation
// faite à la main par un superviseur est respectée : l'import ne réimporte jamais ce pointage.
const presence = require('./presence');
const autoPause = require('./autoPauseResume');

const SYSTEM_USER = 'timemoto';

function env(){
  return {
    cloudUrl: (process.env.TIMEMOTO_CLOUD_URL || 'https://cloud-eu.timemoto.com').replace(/\/+$/, '')
  };
}

// ---------- Tables (liens pointage ↔ TimeMoto, état du dernier import) ----------
function initTimemotoTables(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS timemoto_punch_refs (
      punch_id INTEGER PRIMARY KEY,
      tm_user_id TEXT NOT NULL,
      tm_day TEXT NOT NULL,
      orig_ts TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tm_refs_user_day ON timemoto_punch_refs (tm_user_id, tm_day);`);
  db.exec(`CREATE TABLE IF NOT EXISTS timemoto_meta (key TEXT PRIMARY KEY, value TEXT);`);
}
function readMeta(db, key, fallback){
  try{ const r = db.prepare('SELECT value FROM timemoto_meta WHERE key = ?').get(key); return r ? JSON.parse(r.value) : fallback; }
  catch(e){ return fallback; }
}
function writeMeta(db, key, value){
  db.prepare('INSERT INTO timemoto_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

// ---------- Lecture des journées (jeton fourni par l'utilisateur) ----------
async function fetchDailyView(token, startDate, endDate){
  const e = env();
  const rows = [];
  let skip = 0, total = null;
  for(let guard = 0; guard < 200; guard++){
    const res = await fetch(`${e.cloudUrl}/api/clocking/reporting/gettimereportdailyview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'X-TimeMoto-Origin': 'Web' },
      body: JSON.stringify({ skip, take: 100, sortField: 'UserLastName', sortDirection: 'asc', startDate, endDate, projectIds: [], projectNames: [], clockLocationIds: [], departmentIds: [], userIds: [], userLocations: [] })
    });
    if(res.status === 401 || res.status === 403){ const err = new Error('Jeton TimeMoto refusé ou expiré (récupérez-en un nouveau, il ne vaut qu’une heure).'); err.unauthorized = true; throw err; }
    if(!res.ok) throw new Error(`TimeMoto a répondu HTTP ${res.status} à la lecture des pointages.`);
    const j = await res.json();
    const page = Array.isArray(j.results) ? j.results : [];
    total = Number(j.totalRows) || 0;
    rows.push(...page);
    skip += page.length;
    if(!page.length || skip >= total) return { rows, complete: true };
  }
  return { rows, complete: false };
}

// ---------- Traduction d'une journée TimeMoto en pointages ----------
function tsOf(x){ return x && x.fullClockTime && presence.TS_RE.test(String(x.fullClockTime).slice(0, 19)) ? presence.normTs(String(x.fullClockTime).slice(0, 19)) : null; }
function origOf(x){ return x && x.originalFullClockTime ? presence.normTs(String(x.originalFullClockTime).slice(0, 19)) : null; }
// Fin d'horaire attendue de la personne ce jour-là (null si jour non travaillé ou en congé) : tant
// qu'elle n'est pas passée, la DERNIÈRE sortie du jour est une pause (retour attendu), pas un départ.
function expectedBoundsFor(st, uid, dayKey){
  const d = new Date(dayKey + 'T12:00:00');
  if(d.getDay() === 0 || d.getDay() === 6) return null;
  const conge = (st.leaveRequests || []).some(r => String(r.userId) === String(uid) && r.statut === 'approuve' && r.debut <= dayKey && r.fin >= dayKey && !r.demiJournee);
  if(conge) return null;
  const cfg = autoPause.applyUserLunchOverride({ ...(st.config || {}) }, String(uid), st);
  if(cfg.startHour == null || !(Number(cfg.monThuHours) > 0)) return null;
  const segs = autoPause.dayIntervals(d, cfg);
  return segs.length ? { start: segs[0][0], end: segs[segs.length - 1][1] } : null;
}
function expectedEndFor(st, uid, dayKey){
  const b = expectedBoundsFor(st, uid, dayKey);
  return b ? b.end : null;
}
// Paires TimeMoto → pointages : 1re entrée = arrivée, sortie suivie d'une entrée = pause, dernière
// sortie = départ (ou pause si la fin d'horaire du jour n'est pas encore passée). Sortie automatique
// de TimeMoto ignorée (la journée reste « départ non pointé »), doubles entrées et sortie sans
// entrée ignorées (comptées dans les anomalies).
function desiredPunches(row, uid, st, now, flip){
  const events = [];
  (Array.isArray(row.clockData) ? row.clockData : []).forEach(pair => {
    ['in', 'out'].forEach(k => {
      const x = pair && pair[k];
      const ts = tsOf(x);
      if(!ts) return;
      const kind = x.clockingActionTypeId === 1 || (x.clockingActionTypeId == null && k === 'out') ? 'out' : 'in';
      events.push({ kind, ts, orig: origOf(x), auto: !!x.isAutoClockOut });
    });
  });
  events.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.kind === 'in' ? -1 : 1));
  // Événements bruts (avant toute inversion), conservés pour signaler/corriger une journée décalée.
  const rawEvents = events.map(e => ({ kind: e.kind, ts: e.ts, auto: !!e.auto }));
  // Journée « décalée » : le premier événement (hors sortie automatique) est une SORTIE — la pointeuse a
  // perdu le fil (un pointage de la veille mal passé). L'import l'ignore (une sortie ne vaut qu'après une
  // entrée). `flip` (choix explicite d'un superviseur, voir applyFlagAction) inverse alors entrées et
  // sorties de cette journée ; sans effet si le premier événement n'est plus une sortie.
  const firstEv = events.find(e => !e.auto);
  const startsWithOut = !!firstEv && firstEv.kind === 'out';
  let flipped = false;
  if(flip && startsWithOut){
    events.forEach(e => { if(!e.auto) e.kind = e.kind === 'in' ? 'out' : 'in'; });
    events.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.kind === 'in' ? -1 : 1));
    flipped = true;
  }
  const anomalies = { autoOut: 0, ignored: 0, startsWithOut, flipped };
  // Événements écartés (entrée alors que la personne est déjà présente, sortie sans entrée) : conservés pour
  // que la pop-up de correction PROPOSE le pointage manquant (voir noteDayFlags/presence.suggestMissing).
  const ignoredEvents = [];
  const out = [];
  let stt = 'none';
  events.forEach((ev, i) => {
    if(ev.kind === 'in'){
      if(stt === 'none'){ out.push({ type: 'in', ...ev }); stt = 'present'; }
      else if(stt === 'pause'){ out.push({ type: 'pause_end', ...ev }); stt = 'present'; }
      else { anomalies.ignored++; ignoredEvents.push({ kind: 'in', ts: ev.ts, reason: 'doubleIn' }); }
      return;
    }
    if(ev.auto){ anomalies.autoOut++; return; }
    if(stt !== 'present'){ anomalies.ignored++; ignoredEvents.push({ kind: 'out', ts: ev.ts, reason: 'outSansEntree' }); return; }
    const laterIn = events.slice(i + 1).some(x => x.kind === 'in');
    out.push({ type: laterIn ? 'pause_start' : 'out', ...ev });
    stt = laterIn ? 'pause' : 'done';
  });
  const last = out[out.length - 1];
  const dayKey = String(row.date || '').slice(0, 10);
  if(last && last.type === 'out' && dayKey === presence.localTs(now).slice(0, 10)){
    const end = expectedEndFor(st, uid, dayKey);
    if(end && now < end) last.type = 'pause_start';
  }
  return { punches: out.map(p => ({ type: p.type, ts: p.ts, orig: p.orig })), anomalies, events: rawEvents, ignoredEvents };
}

// Pointages déjà importés pour (salarié TimeMoto, jour), avec leur état d'annulation.
function existingFor(db, tmUserId, day){
  const rows = db.prepare(`
    SELECT p.*, r.orig_ts FROM timemoto_punch_refs r JOIN presence_punches p ON p.id = r.punch_id
    WHERE r.tm_user_id = ? AND r.tm_day = ?`).all(tmUserId, day);
  return rows.map(r => {
    const c = db.prepare("SELECT created_by FROM presence_punches WHERE type = 'cancel' AND status = 'valide' AND cancels_id = ? ORDER BY id LIMIT 1").get(r.id);
    return { id: r.id, userId: r.user_id, type: r.type, ts: r.ts, status: r.status, cancelledBy: c ? (c.created_by || '') : null };
  });
}
const keyOf = (uid, type, ts) => `${uid}|${type}|${ts}`;
function reconcileDay(db, tmUserId, day, uid, desired, dryRun){
  const existing = existingFor(db, tmUserId, day);
  const active = existing.filter(x => x.cancelledBy === null && x.status === 'valide');
  const activeKeys = new Set(active.map(x => keyOf(x.userId, x.type, x.ts)));
  const humanCancelled = new Set(existing.filter(x => x.cancelledBy !== null && x.cancelledBy !== SYSTEM_USER).map(x => keyOf(x.userId, x.type, x.ts)));
  const desiredKeys = new Set(desired.map(p => keyOf(uid, p.type, p.ts)));
  let added = 0, cancelled = 0, respected = 0;
  active.forEach(x => {
    if(desiredKeys.has(keyOf(x.userId, x.type, x.ts))) return;
    cancelled++;
    if(!dryRun) presence.insertPunch(db, { userId: x.userId, type: 'cancel', ts: x.ts, source: 'timemoto', createdBy: SYSTEM_USER, cancelsId: x.id, motif: 'Mis à jour depuis TimeMoto', commentaire: 'Pointage modifié, supprimé ou reclassé dans TimeMoto.' });
  });
  desired.forEach(p => {
    const k = keyOf(uid, p.type, p.ts);
    if(activeKeys.has(k)) return;
    if(humanCancelled.has(k)){ respected++; return; }
    added++;
    if(dryRun) return;
    const edited = p.orig && p.orig !== p.ts;
    const punch = presence.insertPunch(db, { userId: uid, type: p.type, ts: p.ts, source: 'timemoto', createdBy: SYSTEM_USER, commentaire: p.byHand ? 'Passage ajouté à la main lors du tri des pointages (oubli de badge).' : edited ? `Heure modifiée dans TimeMoto (heure d'origine ${p.orig.slice(11, 19)}).` : '' });
    db.prepare('INSERT OR REPLACE INTO timemoto_punch_refs (punch_id, tm_user_id, tm_day, orig_ts) VALUES (?, ?, ?, ?)').run(punch.id, tmUserId, day, p.orig || null);
  });
  return { added, cancelled, respected };
}


// ---------- Journées « décalées » : signalement et correction proposée (v1.102.0) ----------
// Quand le premier événement d'une journée est une SORTIE, la pointeuse a perdu le fil (le plus souvent
// un pointage de la veille mal passé : elle alterne Entrée/Sortie à partir du dernier). L'import ignore
// ce pointage (sortie sans entrée) : la journée apparaît incomplète ou en retard. On se contente de la
// SIGNALER (meta `flagged`) ; un superviseur peut alors accepter la correction proposée = inverser
// entrées et sorties de CETTE journée (meta `flips`, appliquée à chaque lecture suivante par
// desiredPunches) ou l'ignorer (meta `flagIgnored`). Jamais automatique : l'hypothèse « la pointeuse
// alterne strictement » n'est pas garantie. Tout reste tracé (annulations + nouveaux pointages).
function loadFlags(db){
  return { flagged: readMeta(db, 'flagged', {}) || {}, flips: readMeta(db, 'flips', {}) || {}, gaps: readMeta(db, 'gapEvents', {}) || {}, ignored: new Set(readMeta(db, 'flagIgnored', []) || []), dirty: false };
}
function saveFlags(db, f){
  if(!f.dirty) return;
  const cut = presence.localTs(new Date(Date.now() - 400 * 86400000)).slice(0, 10);
  const prune = o => { Object.keys(o).forEach(k => { if((o[k].day || '') < cut) delete o[k]; }); return o; };
  writeMeta(db, 'flagged', prune(f.flagged));
  writeMeta(db, 'flips', prune(f.flips));
  writeMeta(db, 'gapEvents', prune(f.gaps));
  writeMeta(db, 'flagIgnored', [...f.ignored].slice(-1000));
  f.dirty = false;
}
// Tient à jour l'état des journées après le calcul de `d` (résultat de desiredPunches) ; `res.flagged`
// reçoit les journées signalées par CETTE lecture (visible aussi en aperçu, sans rien écrire).
function noteDayFlags(f, tmId, uid, day, d, res){
  const key = `${tmId}|${day}`;
  const raw = d.events || [];
  // Pointages écartés de la journée (voir desiredPunches) : mémorisés, remplacés à chaque lecture, effacés dès qu'il n'y en a plus.
  const gapEv = d.ignoredEvents || [];
  if(gapEv.length){
    const next = { tmId, uid, day, events: gapEv };
    if(JSON.stringify(f.gaps[key]) !== JSON.stringify(next)){ f.gaps[key] = next; f.dirty = true; }
  } else if(f.gaps[key]){ delete f.gaps[key]; f.dirty = true; }
  if(d.anomalies.startsWithOut){
    if(f.flips[key]){ f.flips[key] = { ...f.flips[key], events: raw }; f.dirty = true; delete f.flagged[key]; return; }
    if(f.ignored.has(key)) return;
    const prev = f.flagged[key];
    f.flagged[key] = { tmId, uid, day, events: raw, firstSeen: prev ? prev.firstSeen : new Date().toISOString() };
    f.dirty = true;
    if(res) (res.flagged = res.flagged || []).push({ uid, day });
  } else {
    if(f.flagged[key]){ delete f.flagged[key]; f.dirty = true; }
    if(f.flips[key]){ delete f.flips[key]; f.dirty = true; }
  }
}
function rowFromEvents(day, events){
  return { date: day, clockData: (events || []).map(ev => ev.kind === 'in'
    ? { in: { fullClockTime: ev.ts, clockingActionTypeId: 0 } }
    : { out: { fullClockTime: ev.ts, clockingActionTypeId: 1, isAutoClockOut: !!ev.auto } }) };
}
const KIND_FR = { in: 'Entrée', out: 'Sortie' };
const TYPE_FR = { in: 'Arrivée', pause_start: 'Début de pause', pause_end: 'Fin de pause', out: 'Départ' };
// Description lisible pour l'interface : séquence brute de la pointeuse et pointages obtenus si l'on
// inverse la journée (calculée à la lecture à partir des événements bruts conservés).
function describeFlag(entry, st, flipped){
  const now = new Date();
  const asIs = desiredPunches(rowFromEvents(entry.day, entry.events), entry.uid, st, now, false);
  const fixed = desiredPunches(rowFromEvents(entry.day, entry.events), entry.uid, st, now, true);
  return {
    key: `${entry.tmId}|${entry.day}`, uid: entry.uid, tmId: entry.tmId, day: entry.day, firstSeen: entry.firstSeen || null, at: entry.at || null,
    raw: (entry.events || []).map(e => `${KIND_FR[e.kind] || e.kind} ${e.ts.slice(11, 16)}`),
    current: asIs.punches.map(p => `${TYPE_FR[p.type] || p.type} ${p.ts.slice(11, 16)}`),
    proposed: fixed.punches.map(p => `${TYPE_FR[p.type] || p.type} ${p.ts.slice(11, 16)}`)
  };
}
// Événements écartés à l'import pour (salarié Planning, jour) — voir presence.suggestMissing.
function ignoredEventsFor(db, uid, day){
  const f = loadFlags(db);
  const out = [];
  Object.values(f.gaps).forEach(g => { if(String(g.uid) === String(uid) && g.day === day) (g.events || []).forEach(e => out.push(e)); });
  return out;
}
function flagInfo(db, st){
  const f = loadFlags(db);
  const byDayDesc = (a, b) => a.day < b.day ? 1 : a.day > b.day ? -1 : 0;
  return {
    flagged: Object.values(f.flagged).sort(byDayDesc).slice(0, 60).map(e => describeFlag(e, st)),
    flips: Object.values(f.flips).sort(byDayDesc).slice(0, 30).map(e => describeFlag(e, st))
  };
}
// Actions d'un superviseur sur une journée signalée. `flip` : applique l'inversion et réconcilie tout de
// suite cette journée (annule les pointages mal classés, ajoute les bons — rien n'est supprimé).
function applyFlagAction(db, st, key, action){
  const f = loadFlags(db);
  const now = new Date();
  const redo = (entry, flip) => {
    const d = desiredPunches(rowFromEvents(entry.day, entry.events), entry.uid, st, now, flip);
    return reconcileDay(db, entry.tmId, entry.day, entry.uid, d.punches, false);
  };
  let out = null;
  db.transaction(() => {
    if(action === 'flip'){
      const e = f.flagged[key];
      if(!e) throw new Error('Journée introuvable (déjà traitée ?).');
      f.flips[key] = { ...e, at: new Date().toISOString() };
      delete f.flagged[key];
      out = redo(e, true);
    } else if(action === 'ignore'){
      if(!f.flagged[key]) throw new Error('Journée introuvable (déjà traitée ?).');
      f.ignored.add(key);
      delete f.flagged[key];
      out = { added: 0, cancelled: 0 };
    } else if(action === 'unflip'){
      const e = f.flips[key];
      if(!e) throw new Error('Cette journée n’est pas corrigée.');
      delete f.flips[key];
      f.ignored.delete(key);
      f.flagged[key] = { tmId: e.tmId, uid: e.uid, day: e.day, events: e.events, firstSeen: e.firstSeen || new Date().toISOString() };
      out = redo(e, false);
    } else throw new Error('Action inconnue.');
    f.dirty = true;
    saveFlags(db, f);
  })();
  return out;
}

function tmName(row){ return [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || String(row.userId || ''); }
function addDays(key, n){ const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return presence.localTs(d).slice(0, 10); }

// Un import : lecture de la période avec le jeton fourni, puis réconciliation de chaque journée des
// salariés associés. `opts.token` (obligatoire) n'est JAMAIS conservé. `opts.dryRun` : rien n'est écrit.
async function syncOnce(db, st, opts){
  const o = opts || {};
  const token = String(o.token || '').trim().replace(/^Bearer\s+/i, '');
  if(!token) throw new Error('Aucun jeton TimeMoto fourni.');
  const tmCfg = ((st.config || {}).presence || {}).timemoto || {};
  const userMap = tmCfg.userMap || {};
  const now = new Date();
  const today = presence.localTs(now).slice(0, 10);
  const jours = Math.max(1, Math.min(31, Number(tmCfg.joursSynchro) || 7));
  let from = presence.DATE_RE.test(String(o.since || '')) ? o.since : addDays(today, -(jours - 1));
  if(from > today) from = today;
  if(from < addDays(today, -400)) from = addDays(today, -400);
  const fetched = await fetchDailyView(token, from, today);
  const tmUsers = new Map();
  const seen = new Set();
  const res = { from, to: today, rows: fetched.rows.length, complete: fetched.complete, added: 0, cancelled: 0, respected: 0, autoOut: 0, ignored: 0, unmapped: 0, dryRun: !!o.dryRun, byUser: {} };
  const flags = loadFlags(db);
  const apply = () => {
    fetched.rows.forEach(row => {
      const tmId = String(row.userId || '');
      const day = String(row.date || '').slice(0, 10);
      if(!tmId || !presence.DATE_RE.test(day)) return;
      tmUsers.set(tmId, tmName(row));
      const uid = userMap[tmId] ? String(userMap[tmId]) : '';
      const hasClock = Array.isArray(row.clockData) && row.clockData.length > 0;
      if(!uid){ if(hasClock) res.unmapped++; return; }
      seen.add(`${tmId}|${day}`);
      const d = desiredPunches(row, uid, st, now, !!flags.flips[`${tmId}|${day}`]);
      res.autoOut += d.anomalies.autoOut; res.ignored += d.anomalies.ignored;
      noteDayFlags(flags, tmId, uid, day, d, res);
      const r = reconcileDay(db, tmId, day, uid, d.punches, o.dryRun);
      res.added += r.added; res.cancelled += r.cancelled; res.respected += r.respected;
      const bu = res.byUser[uid] || (res.byUser[uid] = { added: 0, cancelled: 0, jours: 0 });
      bu.added += r.added; bu.cancelled += r.cancelled; if(d.punches.length) bu.jours++;
    });
    // Journée importée qui n'existe plus du tout côté TimeMoto (pointages supprimés) : annulée — mais
    // seulement après une lecture COMPLÈTE et non vide, jamais sur une réponse partielle.
    if(fetched.complete && fetched.rows.length){
      db.prepare('SELECT DISTINCT tm_user_id, tm_day FROM timemoto_punch_refs WHERE tm_day >= ? AND tm_day <= ?').all(from, today).forEach(r => {
        if(seen.has(`${r.tm_user_id}|${r.tm_day}`) || !userMap[r.tm_user_id]) return;
        const x = reconcileDay(db, r.tm_user_id, r.tm_day, String(userMap[r.tm_user_id]), [], o.dryRun);
        res.cancelled += x.cancelled;
      });
    }
  };
  if(o.dryRun) apply(); else { db.transaction(apply)(); saveFlags(db, flags); }
  res.tmUsers = [...tmUsers].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  // Liste des salariés TimeMoto conservée (pour l'association dans Paramètres), fusionnée avec la
  // précédente pour ne pas perdre quelqu'un d'absent sur la période lue.
  const known = new Map((readMeta(db, 'users', []) || []).map(u => [u.id, u.name]));
  res.tmUsers.forEach(u => known.set(u.id, u.name));
  writeMeta(db, 'users', [...known].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')));
  return res;
}

// ---------- Import du fichier CSV de la pointeuse (lecture directe en réseau local) ----------
// Variante SANS TimeMoto Cloud : un script Python (tools/tm616_export.py, bibliothèque pyzk, port 4370)
// lit la pointeuse TM-616 directement sur le réseau de l'atelier et produit un CSV `;` UTF-8 :
// UID;UserID;Nom;Badge;Date;Heure;Action;Status. Le sens Entrée/Sortie vient de la pointeuse elle-même.
// Les pointages passent par le MÊME moteur que l'import cloud (desiredPunches → reconcileDay) : mêmes
// règles (1re entrée = arrivée, sortie suivie d'une entrée = pause, dernière sortie = départ), même
// réconciliation (rien n'est jamais modifié ni supprimé, une annulation humaine est respectée). Les
// salariés de la pointeuse sont identifiés `zk:<UserID>` dans userMap : jamais de collision avec les
// identifiants TimeMoto Cloud.
const runtime = { running: false };
const ZK_PREFIX = 'zk:';
const noAccent = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
function parseDeviceCsv(text){
  let src = String(text || '').replace(/^﻿/, '');
  const lines = src.split(/\r?\n/).filter(l => l.trim());
  if(!lines.length) throw new Error('Fichier vide.');
  const sep = lines[0].split(';').length >= lines[0].split(',').length ? ';' : ',';
  const head = lines[0].split(sep).map(noAccent);
  const col = n => head.indexOf(n);
  const iUser = col('userid'), iName = col('nom'), iDate = col('date'), iTime = col('heure'), iAct = col('action');
  if(iUser < 0 || iDate < 0 || iTime < 0 || iAct < 0) throw new Error('Fichier non reconnu : colonnes attendues UserID, Date, Heure, Action (CSV produit par tools/tm616_export.py).');
  const out = { events: [], names: new Map(), noUser: 0, otherAction: 0, badDate: 0, lines: lines.length - 1 };
  lines.slice(1).forEach(l => {
    const c = l.split(sep).map(x => x.trim());
    const uid = c[iUser] || '';
    if(!uid){ out.noUser++; return; }
    const act = noAccent(c[iAct]);
    const pm = /^punch\s*([2-5])$/.exec(act);
    const kind = act.startsWith('entr') ? 'in' : act.startsWith('sort') ? 'out' : pm ? 'other' : null;
    if(!kind){ out.otherAction++; return; }
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[iDate] || '');
    const day = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : (presence.DATE_RE.test(c[iDate] || '') ? c[iDate] : null);
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(c[iTime] || '');
    if(!day || !tm){ out.badDate++; return; }
    const ts = `${day}T${String(tm[1]).padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}`;
    const nm = iName >= 0 ? c[iName] : '';
    if(nm && noAccent(nm) !== 'inconnu') out.names.set(uid, nm);
    out.events.push(kind === 'other' ? { uid, day, ts, kind, punch: Number(pm[1]) } : { uid, day, ts, kind });
  });
  return out;
}
// ---------- Lecture « par ordre de passage » (v1.115.0) ----------
// Cas réel (Cyril, 07/10) : un salarié qui n'appuie pas sur la bonne touche (Sortie à l'arrivée, Entrée à la pause, puis
// Pause-sortie/Pause-entrée au retour) ne peut pas être lu « selon la touche » : la journée se retrouvait inversée puis figée
// « en pause ». Pour lui (ou pour tous), la touche est IGNORÉE : chaque passage fait basculer présent/absent (1er = entrée,
// 2e = sortie, 3e = entrée…), toutes touches confondues (0 à 5). Deux passages à moins de `antiDoubleMin` minutes comptent
// pour un seul (le PREMIER est gardé : double appui, ou touche corrigée aussitôt). Le classement arrivée/pause/départ reste
// celui de desiredPunches. Une journée impaire (retour ou départ non badgé) reste visible : « départ non pointé » / suggestion.
function sequenceModeFor(tmCfg, tmId){ return !!(tmCfg && tmCfg.ordreTous) || (Array.isArray(tmCfg && tmCfg.ordreIds) && tmCfg.ordreIds.includes(tmId)); }
function antiDoubleMinOf(tmCfg){ const n = Number(tmCfg && tmCfg.antiDoubleMin); return (tmCfg && tmCfg.antiDoubleMin != null && tmCfg.antiDoubleMin !== '' && isFinite(n) && n >= 0) ? Math.min(30, n) : 3; }
function sequenceKinds(events, antiMin){
  const sorted = events.slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  const kept = [], dropped = [];
  sorted.forEach(e => {
    const last = kept[kept.length - 1];
    if(last && antiMin > 0 && (Date.parse(e.ts) - Date.parse(last.ts)) / 60000 < antiMin){ dropped.push(e); return; }
    kept.push(e);
  });
  return { events: kept.map((e, i) => ({ ts: e.ts, kind: i % 2 === 0 ? 'in' : 'out' })), dropped };
}
// ---------- Tri des pointages avant import (v1.119.0) ----------
// Deux mémoires, en meta, appliquées à TOUTES les lectures de la pointeuse (agent, CSV, récupération) par syncDeviceRows :
//  - `excluded` : passages que l'administrateur a décochés au tri. Ils sont filtrés avant toute interprétation, donc jamais
//    réimportés ; la journée reste réconciliée (un pointage déjà importé qui n'a plus de passage derrière lui est annulé,
//    ligne d'annulation tracée, rien n'est supprimé). Rétablir = rouvrir le tri sur la période et recocher.
//  - `added` : passages manquants ajoutés à la main (oubli de badge). Injectés comme de vrais passages DANS la séquence de la
//    journée : en lecture « par ordre », ils décalent la parité comme un passage réel ; en lecture « selon la touche », leur
//    sens se déduit de l'état de présence juste avant (présent → sortie, absent → entrée).
const evKey = (uid, ts) => `${uid}|${ts}`;
function triageMeta(db){ return { excluded: readMeta(db, 'excluded', {}) || {}, added: readMeta(db, 'added', {}) || {} }; }
function assignAddedKinds(events){
  const sorted = events.slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
  let present = false;
  return sorted.map(e => {
    const x = e.added ? { ...e, kind: present ? 'out' : 'in' } : e;
    if(x.kind === 'in') present = true; else if(x.kind === 'out') present = false;
    return x;
  });
}
// Interprétation d'UNE journée d'un salarié de la pointeuse : même code pour l'import et pour l'écran de tri.
function deviceGroupInterpret(st, tmCfg, tmId, uid, day, events, antiMin, now, flip){
  let evs, dropped = [];
  if(sequenceModeFor(tmCfg, tmId)){ const sq = sequenceKinds(events, antiMin); evs = sq.events; dropped = sq.dropped; }
  else evs = assignAddedKinds(events).filter(e => e.kind === 'in' || e.kind === 'out'); // lecture selon la touche : les touches pause/heures sup restent ignorées
  const d = desiredPunches(rowFromEvents(day, evs), uid, st, now, flip);
  return { d, dropped, evs };
}
function syncDeviceRows(db, st, parsed, opts){
  const o = opts || {};
  const tmCfg = ((st.config || {}).presence || {}).timemoto || {};
  const userMap = tmCfg.userMap || {};
  const now = new Date();
  const today = presence.localTs(now).slice(0, 10);
  const jours = Math.max(1, Math.min(31, Number(tmCfg.joursSynchro) || 7));
  let from = presence.DATE_RE.test(String(o.since || '')) ? o.since : addDays(today, -(jours - 1));
  if(from > today) from = today;
  const until = presence.DATE_RE.test(String(o.until || '')) ? o.until : null;
  const inRange = day => !(day < from || (until && day > until));
  const byDay = new Map();
  const group = (uid, day) => { const k = `${uid}|${day}`; if(!byDay.has(k)) byDay.set(k, { uid, day, events: [] }); return byDay.get(k); };
  const tri = triageMeta(db);
  let excludedN = 0;
  parsed.events.forEach(ev => {
    if(!inRange(ev.day)) return;
    const g = group(ev.uid, ev.day); // la journée existe même si tous ses passages sont écartés : l'import déjà fait est alors réconcilié
    if(tri.excluded[evKey(ev.uid, ev.ts)]){ excludedN++; return; }
    g.events.push(ev);
  });
  Object.values(tri.added).forEach(a => { if(a && inRange(a.day)) group(a.uid, a.day).events.push({ uid: a.uid, day: a.day, ts: a.ts, kind: 'in', added: true }); });
  const antiMin = antiDoubleMinOf(tmCfg);
  const res = { device: true, from, to: until || today, rows: byDay.size, complete: true, doubles: 0, added: 0, cancelled: 0, respected: 0, autoOut: 0, ignored: 0, unmapped: 0, excluded: excludedN, noUser: parsed.noUser, otherAction: parsed.otherAction, badDate: parsed.badDate, dryRun: !!o.dryRun, byUser: {} };
  const flags = loadFlags(db);
  const apply = () => {
    byDay.forEach(g => {
      const tmId = ZK_PREFIX + g.uid;
      const uid = userMap[tmId] ? String(userMap[tmId]) : '';
      if(!uid){ res.unmapped++; return; }
      const gi = deviceGroupInterpret(st, tmCfg, tmId, uid, g.day, g.events, antiMin, now, !!flags.flips[`${tmId}|${g.day}`]);
      res.doubles += gi.dropped.length;
      const d = gi.d;
      const addedTs = new Set(g.events.filter(e => e.added).map(e => e.ts));
      d.punches.forEach(pn => { if(addedTs.has(pn.ts)) pn.byHand = true; });
      res.autoOut += d.anomalies.autoOut; res.ignored += d.anomalies.ignored;
      noteDayFlags(flags, tmId, uid, g.day, d, res);
      const r = reconcileDay(db, tmId, g.day, uid, d.punches, o.dryRun);
      res.added += r.added; res.cancelled += r.cancelled; res.respected += r.respected;
      const bu = res.byUser[uid] || (res.byUser[uid] = { added: 0, cancelled: 0, jours: 0 });
      bu.added += r.added; bu.cancelled += r.cancelled; if(d.punches.length) bu.jours++;
    });
  };
  if(o.dryRun) apply(); else { db.transaction(apply)(); saveFlags(db, flags); }
  // Liste des salariés de la pointeuse (association dans Paramètres), fusionnée avec la précédente.
  const ids = new Set(parsed.events.map(e => e.uid));
  const known = new Map((readMeta(db, 'users', []) || []).map(u => [u.id, u.name]));
  ids.forEach(id => known.set(ZK_PREFIX + id, parsed.names.get(id) || `Pointeuse n° ${id} (nom absent — salarié supprimé de la pointeuse ?)`));
  writeMeta(db, 'users', [...known].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')));
  return res;
}
function runDeviceImport(db, st, csvText, opts){
  if(runtime.running) return { ok: false, error: 'Un import TimeMoto est déjà en cours.' };
  runtime.running = true;
  try{
    const parsed = parseDeviceCsv(csvText);
    const r = syncDeviceRows(db, st, parsed, opts);
    if(!r.dryRun){
      const s = readMeta(db, 'status', {}) || {};
      Object.assign(s, { lastOkAt: new Date().toISOString(), lastResult: publicResult(r), lastImportTo: r.to });
      writeMeta(db, 'status', s);
      if(r.added || r.cancelled) console.log(`Pointeuse (CSV) : ${r.added} pointage(s) importé(s), ${r.cancelled} annulé(s) (${r.from} → ${r.to}).`);
    }
    return { ok: true, result: r };
  }catch(err){
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }finally{
    runtime.running = false;
  }
}

// ---------- Écran « Trier avant d'importer » (v1.119.0) ----------
// Prend les événements d'une lecture déjà faite (fichier CSV, ou aperçu d'une « récupération de période ») au lieu de les
// importer d'un bloc : l'administrateur voit chaque passage brut, décoche ceux qu'il ne veut pas, ajoute un passage oublié,
// et le résultat de la journée est recalculé par le MÊME code que l'import (deviceGroupInterpret). Les événements restent
// en réserve côté serveur (meta `triage`, 1 h) : seules les décisions (écarté / ajouté) reviennent du navigateur, validées
// contre ces événements. La lecture automatique de l'agent n'est pas triée, mais respecte les décisions déjà prises.
const TRIAGE_KEEP_MS = 60 * 60 * 1000;
const TRIAGE_MAX_GROUPS = 3000;
const PUNCH_LABEL = { 2: 'Pause (sortie)', 3: 'Pause (entrée)', 4: 'Heures sup. (entrée)', 5: 'Heures sup. (sortie)' };
function eventLabelDir(ev){
  if(ev.added) return { label: 'Ajouté', dir: null };
  if(ev.kind === 'in') return { label: 'Entrée', dir: 'in' };
  if(ev.kind === 'out') return { label: 'Sortie', dir: 'out' };
  return { label: PUNCH_LABEL[ev.punch] || 'Autre touche', dir: (ev.punch === 3 || ev.punch === 4) ? 'in' : 'out' };
}
function triageStash(db){
  const t = readMeta(db, 'triage', null);
  if(!t) return null;
  if(Date.now() - new Date(t.at).getTime() > TRIAGE_KEEP_MS){ writeMeta(db, 'triage', null); return null; }
  return t;
}
function triageInterpretGroup(db, st, flags, stash, uid, day, keepTs, addedTs){
  const tmCfg = ((st.config || {}).presence || {}).timemoto || {};
  const tmId = ZK_PREFIX + uid;
  const planning = (tmCfg.userMap || {})[tmId] ? String((tmCfg.userMap || {})[tmId]) : '';
  if(!planning) return null;
  const keep = new Set(keepTs);
  const events = stash.events.filter(e => e.uid === uid && e.day === day && keep.has(e.ts)).concat(addedTs.map(ts => ({ uid, day, ts, kind: 'in', added: true })));
  const now = new Date();
  const gi = deviceGroupInterpret(st, tmCfg, tmId, planning, day, events, antiDoubleMinOf(tmCfg), now, !!flags.flips[`${tmId}|${day}`]);
  return {
    punches: gi.d.punches.map(p => ({ type: p.type, ts: p.ts })),
    dropped: gi.dropped.map(e => e.ts),
    ignored: (gi.d.ignoredEvents || []).map(e => ({ ts: e.ts, reason: e.reason })),
    autoOut: gi.d.anomalies.autoOut
  };
}
// Démarre un tri : `parsed` (événements lus) est mis en réserve et l'aperçu complet est renvoyé.
function triageStart(db, st, parsed, o){
  const tmCfg = ((st.config || {}).presence || {}).timemoto || {};
  const userMap = tmCfg.userMap || {};
  const now = new Date();
  const today = presence.localTs(now).slice(0, 10);
  const jours = Math.max(1, Math.min(31, Number(tmCfg.joursSynchro) || 7));
  let from = presence.DATE_RE.test(String(o.since || '')) ? o.since : addDays(today, -(jours - 1));
  if(from > today) from = today;
  const to = presence.DATE_RE.test(String(o.until || '')) ? o.until : today;
  const dbl = Math.max(0, Math.min(30, o.dbl != null ? Number(o.dbl) : (antiDoubleMinOf(tmCfg) || 3)));
  const tri = triageMeta(db);
  const flags = loadFlags(db);
  const byDay = new Map();
  parsed.events.forEach(ev => {
    if(ev.day < from || ev.day > to) return;
    const k = `${ev.uid}|${ev.day}`;
    if(!byDay.has(k)) byDay.set(k, { uid: ev.uid, day: ev.day, events: [] });
    byDay.get(k).events.push(ev);
  });
  Object.values(tri.added).forEach(a => { if(a && a.day >= from && a.day <= to){ const k = `${a.uid}|${a.day}`; if(!byDay.has(k)) byDay.set(k, { uid: a.uid, day: a.day, events: [] }); } });
  const groups = [];
  let unmappedDays = 0, unmappedEvents = 0;
  byDay.forEach(g => {
    const tmId = ZK_PREFIX + g.uid;
    const planning = userMap[tmId] ? String(userMap[tmId]) : '';
    if(!planning){ unmappedDays++; unmappedEvents += g.events.length; return; }
    const raw = g.events.slice().sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
    const events = [];
    raw.forEach((e, i) => {
      const prev = i > 0 ? raw[i - 1] : null;
      const isDouble = !!prev && dbl > 0 && (Date.parse(e.ts) - Date.parse(prev.ts)) < dbl * 60000;
      const prevExcluded = !!tri.excluded[evKey(g.uid, e.ts)];
      const ld = eventLabelDir(e);
      events.push({ ts: e.ts, kind: e.kind, punch: e.punch == null ? null : e.punch, label: ld.label, dir: ld.dir, keep: !prevExcluded && !isDouble, prevExcluded, double: isDouble });
    });
    const added = Object.values(tri.added).filter(a => a && a.uid === g.uid && a.day === g.day).map(a => a.ts).sort();
    const keepTs = events.filter(e => e.keep).map(e => e.ts);
    const stashLike = { events: parsed.events };
    const r = triageInterpretGroup(db, st, flags, stashLike, g.uid, g.day, keepTs, added);
    groups.push({ key: `${g.uid}|${g.day}`, uid: g.uid, day: g.day, userId: planning, today: g.day === today, events, added, result: r });
  });
  groups.sort((a, b) => a.day < b.day ? 1 : a.day > b.day ? -1 : (a.userId < b.userId ? -1 : 1));
  if(groups.length > TRIAGE_MAX_GROUPS) return { ok: false, error: `Trop de journées (${groups.length}) : choisissez une période plus courte.` };
  writeMeta(db, 'triage', { events: parsed.events.filter(e => e.day >= from && e.day <= to), source: o.source || 'csv', recoveryId: o.recoveryId || null, from, to, at: new Date().toISOString() });
  return { ok: true, triage: { source: o.source || 'csv', from, to, dbl, antiMin: antiDoubleMinOf(tmCfg), sequence: tmCfg.ordreTous ? 'tous' : null, groups, unmapped: { days: unmappedDays, events: unmappedEvents }, totalEvents: parsed.events.filter(e => e.day >= from && e.day <= to).length } };
}
function triageBegin(db, st, o){
  if(runtime.running) return { ok: false, error: 'Un import TimeMoto est déjà en cours.' };
  if(o.source === 'recovery'){
    const r = recoveryRecord(db);
    if(!r || r.state !== 'received') return { ok: false, error: 'Aucun aperçu de récupération à trier (relancez la demande).' };
    const stash = readMeta(db, 'recoveryEvents', null);
    if(!stash || !Array.isArray(stash.events)) return { ok: false, error: 'Aperçu expiré : relancez la demande.' };
    const parsed = { events: stash.events, names: new Map(stash.names || []), noUser: 0, otherAction: 0, badDate: 0 };
    return triageStart(db, st, parsed, { source: 'recovery', recoveryId: r.id, since: r.from, until: r.to, dbl: o.dbl });
  }
  try{
    const parsed = parseDeviceCsv(o.csv);
    return triageStart(db, st, parsed, { source: 'csv', since: o.since || null, dbl: o.dbl });
  }catch(err){
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }
}
// Recalcule le résultat de journées pour des cases cochées (une requête par action de l'écran, pas par case).
function triageInterpret(db, st, days){
  const stash = triageStash(db);
  if(!stash) return { ok: false, error: 'Le tri a expiré (plus d’une heure) : relancez la lecture.' };
  const flags = loadFlags(db);
  const results = {};
  (Array.isArray(days) ? days : []).slice(0, TRIAGE_MAX_GROUPS).forEach(d => {
    const uid = String((d && d.uid) == null ? '' : d.uid), day = String((d && d.day) || '');
    if(!uid || !presence.DATE_RE.test(day)) return;
    const added = (Array.isArray(d.added) ? d.added : []).map(String).filter(t => t.slice(0, 10) === day && presence.TS_RE.test(t)).map(presence.normTs).slice(0, 20);
    const r = triageInterpretGroup(db, st, flags, stash, uid, day, (Array.isArray(d.keep) ? d.keep : []).map(String), added);
    if(r) results[`${uid}|${day}`] = r;
  });
  return { ok: true, results };
}
function triageApply(db, st, payload, by){
  if(runtime.running) return { ok: false, error: 'Un import TimeMoto est déjà en cours.' };
  const stash = triageStash(db);
  if(!stash) return { ok: false, error: 'Le tri a expiré (plus d’une heure) : relancez la lecture.' };
  const tmCfg = ((st.config || {}).presence || {}).timemoto || {};
  const userMap = tmCfg.userMap || {};
  const groups = Array.isArray(payload && payload.groups) ? payload.groups : [];
  if(groups.length > TRIAGE_MAX_GROUPS) return { ok: false, error: 'Trop de journées.' };
  const limit = Date.now() + FUTURE_TOLERANCE_MS;
  const rawByKey = new Map();
  stash.events.forEach(e => { const k = `${e.uid}|${e.day}`; if(!rawByKey.has(k)) rawByKey.set(k, new Set()); rawByKey.get(k).add(e.ts); });
  const tri = triageMeta(db);
  const nowIso = new Date().toISOString();
  let dropped = 0, restored = 0, added = 0;
  // Validation AVANT toute écriture : un seul ajout invalide rejette tout.
  for(const g of groups){
    const uid = String((g && g.uid) == null ? '' : g.uid), day = String((g && g.day) || '');
    if(!uid || !presence.DATE_RE.test(day)) return { ok: false, error: 'Journée invalide.' };
    if(day < stash.from || day > stash.to) return { ok: false, error: 'Journée hors de la période triée.' };
    if(!userMap[ZK_PREFIX + uid]) return { ok: false, error: `Le salarié n° ${uid} de la pointeuse n’est associé à personne.` };
    for(const t of (Array.isArray(g.added) ? g.added : [])){
      const ts = String(t);
      if(!presence.TS_RE.test(ts) || ts.slice(0, 10) !== day) return { ok: false, error: `Pointage ajouté invalide (${ts}).` };
      if(new Date(presence.normTs(ts)).getTime() > limit) return { ok: false, error: 'Un pointage ajouté est dans le futur.' };
    }
  }
  groups.forEach(g => {
    const uid = String(g.uid), day = String(g.day);
    const known = rawByKey.get(`${uid}|${day}`) || new Set();
    (Array.isArray(g.drop) ? g.drop : []).forEach(t => { const ts = String(t); if(!known.has(ts)) return; if(!tri.excluded[evKey(uid, ts)]) dropped++; tri.excluded[evKey(uid, ts)] = { uid, day, ts, at: nowIso, by: String(by || '') }; });
    (Array.isArray(g.keep) ? g.keep : []).forEach(t => { const ts = String(t); if(known.has(ts) && tri.excluded[evKey(uid, ts)]){ delete tri.excluded[evKey(uid, ts)]; restored++; } });
    Object.keys(tri.added).forEach(k => { const a = tri.added[k]; if(a && a.uid === uid && a.day === day) delete tri.added[k]; });
    (Array.isArray(g.added) ? g.added : []).slice(0, 20).forEach(t => { const ts = presence.normTs(String(t)); tri.added[evKey(uid, ts)] = { uid, day, ts, at: nowIso, by: String(by || '') }; added++; });
  });
  const cut = presence.localTs(new Date(Date.now() - 400 * 86400000)).slice(0, 10);
  [tri.excluded, tri.added].forEach(m => Object.keys(m).forEach(k => { if((m[k].day || '') < cut) delete m[k]; }));
  writeMeta(db, 'excluded', tri.excluded);
  writeMeta(db, 'added', tri.added);
  runtime.running = true;
  try{
    const parsed = { events: stash.events, names: new Map(), noUser: 0, otherAction: 0, badDate: 0, lines: stash.events.length };
    (readMeta(db, 'users', []) || []).forEach(u => { if(String(u.id).startsWith(ZK_PREFIX)) parsed.names.set(String(u.id).slice(ZK_PREFIX.length), u.name); });
    const res = syncDeviceRows(db, st, parsed, { dryRun: false, since: stash.from, until: stash.to });
    const s = readMeta(db, 'status', {}) || {};
    Object.assign(s, { lastOkAt: new Date().toISOString(), lastResult: publicResult(res), lastImportTo: res.to });
    writeMeta(db, 'status', s);
    if(stash.source === 'recovery' && stash.recoveryId){
      const r = readMeta(db, 'recovery', null);
      if(r && r.id === stash.recoveryId && r.state === 'received'){ r.state = 'applied'; r.appliedAt = nowIso; r.result = publicResult(res); r.result.flagged = res.flagged || []; writeMeta(db, 'recovery', r); }
      writeMeta(db, 'recoveryEvents', null);
    }
    writeMeta(db, 'triage', null);
    console.log(`Pointeuse (tri ${stash.from} → ${stash.to}) : ${res.added} pointage(s) importé(s), ${res.cancelled} annulé(s), ${dropped} passage(s) écarté(s), ${restored} rétabli(s), ${added} ajouté(s) à la main.`);
    return { ok: true, result: res, counts: { dropped, restored, added } };
  }catch(err){
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }finally{
    runtime.running = false;
  }
}
function triageCancel(db){ writeMeta(db, 'triage', null); return { ok: true }; }
// Passages actuellement écartés (nombre), pour information dans le panneau TimeMoto.
function triageExcludedCount(db){ return Object.keys(readMeta(db, 'excluded', {}) || {}).length; }

// ---------- Lecture automatique (conteneur annexe tools/tm616_sync.py) ----------
// L'agent lit la pointeuse en réseau local toutes les N minutes et envoie les événements des derniers
// jours, en JSON, à POST /api/presence/device-sync (clé machine DEVICE_SYNC_KEY, voir server.js). Même
// moteur que l'import CSV (syncDeviceRows) : réconciliation par (salarié, jour), idempotent, annulation
// humaine respectée. Un événement daté du futur (horloge de la pointeuse déréglée) est écarté.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
function parseAgentEvents(payload){
  const out = { events: [], names: new Map(), noUser: 0, otherAction: 0, badDate: 0, future: 0, lines: 0 };
  const limit = Date.now() + FUTURE_TOLERANCE_MS;
  (Array.isArray(payload.users) ? payload.users : []).slice(0, 500).forEach(u => {
    const id = String((u && u.uid) == null ? '' : u.uid).trim();
    const nm = String((u && u.name) || '').trim().slice(0, 80);
    if(id && nm && noAccent(nm) !== 'inconnu') out.names.set(id, nm);
  });
  (Array.isArray(payload.events) ? payload.events : []).slice(0, 20000).forEach(ev => {
    out.lines++;
    const uid = String((ev && ev.uid) == null ? '' : ev.uid).trim();
    if(!uid || uid === '0'){ out.noUser++; return; }
    // Touches pause / heures sup de la pointeuse (code 2 à 5) : conservées avec leur code — ignorées par défaut (lecture « selon la
    // touche »), prises en compte seulement pour un salarié lu « par ordre de passage » (voir sequenceKinds). Porte, alarme... : écartées.
    const pc = Number(ev && ev.punch);
    const brk = ev.kind === 'other' && pc >= 2 && pc <= 5;
    const kind = ev.kind === 'in' ? 'in' : ev.kind === 'out' ? 'out' : brk ? 'other' : null;
    if(!kind){ out.otherAction++; return; }
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(ev.ts || ''));
    if(!m){ out.badDate++; return; }
    const ts = `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`;
    if(new Date(ts).getTime() > limit){ out.future++; return; }
    out.events.push(kind === 'other' ? { uid, day: m[1], ts, kind, punch: pc } : { uid, day: m[1], ts, kind });
  });
  return out;
}
// Intervalle de lecture choisi dans l'interface (`config.presence.timemoto.intervalleMin`, minutes, 1–60),
// renvoyé à l'agent zk-sync à chaque contact. `null` = pas de réglage : l'agent garde SYNC_INTERVAL.
function agentIntervalSec(st){
  const tm = (((st || {}).config || {}).presence || {}).timemoto || {};
  const n = Math.round(Number(tm.intervalleMin));
  return (tm.intervalleMin == null || tm.intervalleMin === '' || !(n >= 1)) ? null : Math.min(60, n) * 60;
}

// ---------- Récupération d'une période, À LA DEMANDE (v1.102.0) ----------
// La lecture automatique ne renvoie que les derniers jours (SYNC_DAYS). Pour rattraper une période plus
// ancienne (agent arrêté, salarié mal associé…), un administrateur demande une « récupération » depuis la
// page Présence : la demande est mise en attente (meta `recovery`) et l'agent zk-sync, qui contacte
// Planning chaque minute, la découvre dans la réponse (`recover`), relit la pointeuse sur ces dates et
// renvoie les événements avec `recoverId`. Planning les range d'abord en APERÇU (rien n'est écrit,
// événements gardés en meta `recoveryEvents`), puis l'administrateur confirme : même moteur que la lecture
// automatique (réconciliation par salarié et par jour, idempotent, annulation humaine respectée).
const RECOVERY_WAIT_MS = 10 * 60 * 1000;     // au-delà, l'agent est considéré absent ou trop ancien
const RECOVERY_KEEP_MS = 60 * 60 * 1000;     // un aperçu non confirmé est oublié après 1 h
const RECOVERY_MAX_DAYS = 400;
const RECOVERY_MAX_EVENTS = 20000;
function recoveryRecord(db){
  const r = readMeta(db, 'recovery', null);
  if(!r) return null;
  const age = Date.now() - new Date(r.requestedAt).getTime();
  if(r.state === 'pending' && age > RECOVERY_WAIT_MS){
    r.state = 'error';
    r.error = "L'agent de lecture n'a pas répondu (conteneur zk-sync arrêté, ou version à mettre à jour avec « bash deploy.sh »).";
    writeMeta(db, 'recovery', r);
  } else if(r.state === 'received' && Date.now() - new Date(r.receivedAt).getTime() > RECOVERY_KEEP_MS){
    r.state = 'error'; r.error = 'Aperçu expiré (plus d’une heure) : relancez la demande.';
    writeMeta(db, 'recovery', r); writeMeta(db, 'recoveryEvents', null);
  }
  return r;
}
function requestRecovery(db, o){
  const from = String(o.from || ''), to = String(o.to || '');
  if(!presence.DATE_RE.test(from) || !presence.DATE_RE.test(to)) return { ok: false, error: 'Dates invalides.' };
  const today = presence.localTs(new Date()).slice(0, 10);
  if(from > to) return { ok: false, error: 'La date de début doit précéder la date de fin.' };
  if(to > today) return { ok: false, error: 'La date de fin ne peut pas être dans le futur.' };
  if(from < addDays(today, -RECOVERY_MAX_DAYS)) return { ok: false, error: `Période trop ancienne (${RECOVERY_MAX_DAYS} jours maximum).` };
  const cur = recoveryRecord(db);
  if(cur && cur.state === 'pending') return { ok: false, error: 'Une demande est déjà en attente de l’agent.' };
  const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from, to, state: 'pending', requestedAt: new Date().toISOString(), requestedBy: String(o.by || '') };
  writeMeta(db, 'recovery', rec);
  writeMeta(db, 'recoveryEvents', null);
  return { ok: true, recovery: rec };
}
function pendingRecover(db){
  const r = recoveryRecord(db);
  return r && r.state === 'pending' ? { id: r.id, from: r.from, to: r.to } : null;
}
// Événements reçus de l'agent pour la demande en cours : aperçu uniquement (dryRun), jamais appliqué ici.
function receiveRecovery(db, st, payload){
  const r = recoveryRecord(db);
  if(!r || r.state !== 'pending' || r.id !== payload.recoverId) return { ok: true, ignored: true };
  if(Array.isArray(payload.events) && payload.events.length > RECOVERY_MAX_EVENTS){
    r.state = 'error'; r.error = `Trop d'événements (${payload.events.length}) : choisissez une période plus courte.`;
    writeMeta(db, 'recovery', r); return { ok: true };
  }
  const parsed = parseAgentEvents(payload);
  const res = syncDeviceRows(db, st, parsed, { dryRun: true, since: r.from, until: r.to });
  res.future = parsed.future;
  r.state = 'received'; r.receivedAt = new Date().toISOString(); r.preview = publicResult(res); r.preview.flagged = res.flagged || []; r.deviceEvents = parsed.events.length;
  writeMeta(db, 'recovery', r);
  writeMeta(db, 'recoveryEvents', { events: parsed.events, names: [...parsed.names] });
  return { ok: true };
}
function applyRecovery(db, st){
  if(runtime.running) return { ok: false, error: 'Un import TimeMoto est déjà en cours.' };
  const r = recoveryRecord(db);
  if(!r || r.state !== 'received') return { ok: false, error: 'Aucun aperçu à appliquer (relancez la demande).' };
  const stash = readMeta(db, 'recoveryEvents', null);
  if(!stash || !Array.isArray(stash.events)) return { ok: false, error: 'Aperçu expiré : relancez la demande.' };
  runtime.running = true;
  try{
    const parsed = { events: stash.events, names: new Map(stash.names || []), noUser: 0, otherAction: 0, badDate: 0, lines: stash.events.length };
    const res = syncDeviceRows(db, st, parsed, { dryRun: false, since: r.from, until: r.to });
    r.state = 'applied'; r.appliedAt = new Date().toISOString(); r.result = publicResult(res); r.result.flagged = res.flagged || [];
    writeMeta(db, 'recovery', r);
    writeMeta(db, 'recoveryEvents', null);
    if(res.added || res.cancelled) console.log(`Pointeuse (récupération ${r.from} → ${r.to}) : ${res.added} pointage(s) importé(s), ${res.cancelled} annulé(s).`);
    return { ok: true, recovery: r };
  }catch(err){
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }finally{
    runtime.running = false;
  }
}
function cancelRecovery(db){
  const r = readMeta(db, 'recovery', null);
  if(r && (r.state === 'pending' || r.state === 'received')){ r.state = 'cancelled'; writeMeta(db, 'recovery', r); }
  writeMeta(db, 'recoveryEvents', null);
  return { ok: true };
}


// ---------- Badges de la pointeuse, gérés depuis l'application (v1.116.0) ----------
// Un administrateur PRÉPARE une modification (ajout d'un salarié, changement de nom ou de badge, retrait du badge,
// suppression), la CONFIRME, puis l'agent zk-sync — qui contacte Planning chaque minute — la découvre dans la réponse
// (`badge`), l'écrit sur la pointeuse (`set_user` / `delete_user` de pyzk), RELIT la pointeuse pour vérifier et renvoie
// le résultat (`badgeResult`). File dans la meta `badgeCmds` (la plus récente en tête) = aussi le JOURNAL (qui, quand,
// avant → après). Jamais de biométrie : nom + n° de badge + code facultatif. Le code (PIN) n'est conservé que le temps de
// l'envoi (effacé dès le résultat, l'annulation ou l'expiration), jamais affiché, relu ni journalisé.
const BADGE_WAIT_TTL_MS = 60 * 60 * 1000;        // préparée mais jamais confirmée : oubliée après 1 h
const BADGE_DELIVER_TTL_MS = 10 * 60 * 1000;     // confirmée mais l'agent ne l'a pas prise : agent absent ou ancien
const BADGE_RESULT_TTL_MS = 5 * 60 * 1000;       // envoyée mais sans réponse : à vérifier dans la liste
const BADGE_USERS_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const BADGE_KEEP = 100;
const BADGE_ACTIVE = ['wait', 'confirmed', 'sent'];
const CARD_MAX = 4294967295;
function badgeCmds(db){ return readMeta(db, 'badgeCmds', []) || []; }
function saveBadgeCmds(db, list){ writeMeta(db, 'badgeCmds', list.slice(0, BADGE_KEEP)); }
function dropPin(c){ delete c.pin; delete c.clearPin; return c; }
// Les états « en attente » trop vieux passent en erreur (les écritures de la meta restent ici, pas dans une lecture HTTP anodine).
function expireBadgeCmds(db){
  const list = badgeCmds(db); let changed = false; const now = Date.now();
  list.forEach(c => {
    if(c.state === 'wait' && now - new Date(c.requestedAt).getTime() > BADGE_WAIT_TTL_MS){ c.state = 'expired'; c.error = 'Non confirmée dans l’heure : demande oubliée.'; dropPin(c); changed = true; }
    else if(c.state === 'confirmed' && now - new Date(c.confirmedAt).getTime() > BADGE_DELIVER_TTL_MS){ c.state = 'error'; c.error = "L'agent de lecture n'a pas pris la demande (conteneur zk-sync arrêté, ou version à mettre à jour avec « bash deploy.sh »). Rien n'a été écrit sur la pointeuse."; c.doneAt = new Date().toISOString(); dropPin(c); changed = true; }
    else if(c.state === 'sent' && now - new Date(c.sentAt).getTime() > BADGE_RESULT_TTL_MS){ c.state = 'error'; c.error = "L'agent n'a pas rendu de résultat : vérifiez dans la liste si la modification a bien eu lieu."; c.doneAt = new Date().toISOString(); dropPin(c); changed = true; }
  });
  if(changed) saveBadgeCmds(db, list);
  return list;
}
function normCardInput(v){
  const s = String(v == null ? '' : v).replace(/\s+/g, '');
  if(!s) return { ok: true, card: 0 };
  if(!/^\d{1,10}$/.test(s)) return { ok: false, error: 'Le n° de badge ne contient que des chiffres (10 au maximum).' };
  const n = Number(s);
  if(n > CARD_MAX) return { ok: false, error: 'N° de badge trop grand (4 294 967 295 au maximum).' };
  return { ok: true, card: n };
}
function normNameInput(v){
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if(!s) return { ok: false, error: 'Le nom est obligatoire.' };
  if(Buffer.byteLength(s, 'utf8') > 24) return { ok: false, error: 'Nom trop long : 24 caractères au maximum sur la pointeuse (un accent en compte 2).' };
  return { ok: true, name: s };
}
function devUsersInfo(db){
  const m = readMeta(db, 'devUsers', null);
  return { users: (m && Array.isArray(m.users)) ? m.users : [], at: (m && m.at) || null };
}
// Liste détaillée des salariés de la pointeuse, lue par l'agent (jamais le code : seulement « défini » ou non).
function noteDevUsers(db, payload){
  const arr = Array.isArray(payload && payload.users) ? payload.users : [];
  if(!arr.length || !arr.some(u => u && u.slot != null)) return;
  const users = arr.slice(0, 500).map(u => ({
    slot: Number(u.slot), uid: String(u.uid == null ? '' : u.uid).trim(), name: String(u.name || '').slice(0, 40),
    card: Math.max(0, Number(u.card) || 0), hasPin: !!u.hasPin, privilege: Number(u.privilege) || 0
  })).filter(u => isFinite(u.slot) && u.uid);
  writeMeta(db, 'devUsers', { at: new Date().toISOString(), users });
}
// Prochain « UserID » sûr : au-dessus de tout identifiant connu de la pointeuse ET de tout identifiant déjà vu dans les
// pointages (`zk:N`) ou associé — un salarié supprimé garde ses pointages sous son ancien n° : le réutiliser rattacherait
// l'ancien historique au nouveau salarié.
function nextDeviceUserId(db, st, devUsers){
  let max = 0;
  const take = id => { const n = Number(String(id).replace(/^zk:/, '')); if(isFinite(n) && /^(zk:)?\d+$/.test(String(id)) && n > max) max = n; };
  devUsers.forEach(u => take(u.uid));
  try{ db.prepare("SELECT DISTINCT tm_user_id FROM timemoto_punch_refs WHERE tm_user_id LIKE 'zk:%'").all().forEach(r => take(r.tm_user_id)); }catch(e){}
  const tmCfg = ((((st || {}).config || {}).presence || {}).timemoto) || {};
  Object.keys(tmCfg.userMap || {}).forEach(take);
  (readMeta(db, 'users', []) || []).forEach(u => take(u.id));
  return max + 1;
}
function nextFreeSlot(devUsers, cmds){
  const used = new Set(devUsers.map(u => u.slot));
  cmds.filter(c => BADGE_ACTIVE.includes(c.state) && c.slot != null).forEach(c => used.add(c.slot));
  for(let i = 1; i < 10000; i++) if(!used.has(i)) return i;
  return null;
}
const snap = u => u ? { name: u.name, card: u.card || 0, hasPin: !!u.hasPin } : null;
function badgeSummary(c){
  const cardTxt = n => n ? String(n) : 'aucun';
  if(c.kind === 'add') return `Ajouter ${c.after.name} — badge ${cardTxt(c.after.card)}`;
  if(c.kind === 'delete') return `Supprimer ${c.before.name} de la pointeuse`;
  const parts = [];
  if(c.before.name !== c.after.name) parts.push(`nom « ${c.before.name} » → « ${c.after.name} »`);
  if((c.before.card || 0) !== (c.after.card || 0)) parts.push(`badge ${cardTxt(c.before.card)} → ${cardTxt(c.after.card)}`);
  if(c.pin) parts.push('code modifié'); else if(c.clearPin) parts.push('code effacé');
  return `${c.before.name} — ${parts.join(', ')}`;
}
// Prépare (état « wait ») : toutes les vérifications côté serveur — l'agent les refait sur la pointeuse avant d'écrire.
function prepareBadge(db, st, o){
  const kind = String(o.kind || '');
  if(!['add', 'edit', 'delete'].includes(kind)) return { ok: false, error: 'Action inconnue.' };
  const info = devUsersInfo(db);
  if(!info.at) return { ok: false, error: "La liste des salariés de la pointeuse n'a pas encore été lue par l'agent (conteneur zk-sync à reconstruire avec « bash deploy.sh » ?)." };
  if(Date.now() - new Date(info.at).getTime() > BADGE_USERS_MAX_AGE_MS) return { ok: false, error: "La liste de la pointeuse date de plus de 2 h : l'agent semble arrêté. Réessayez quand il est de nouveau en ligne." };
  const cmds = expireBadgeCmds(db);
  const active = cmds.filter(c => BADGE_ACTIVE.includes(c.state));
  const cmd = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, state: 'wait', requestedBy: String(o.by || ''), requestedAt: new Date().toISOString() };
  let target = null;
  if(kind !== 'add'){
    target = info.users.find(u => u.slot === Number(o.slot));
    if(!target) return { ok: false, error: 'Salarié introuvable sur la pointeuse (liste à jour ?).' };
    if(active.some(c => c.slot === target.slot)) return { ok: false, error: 'Une modification est déjà en attente pour ce salarié.' };
    cmd.slot = target.slot; cmd.userId = target.uid; cmd.before = snap(target);
  }
  if(kind === 'delete'){
    if(target.privilege) return { ok: false, error: "Ce salarié est administrateur de la pointeuse : sa suppression depuis l'application est refusée (risque de perdre l'accès au menu de l'appareil)." };
    cmd.after = null;
  } else {
    const nm = normNameInput(o.name != null ? o.name : (target && target.name));
    if(!nm.ok) return nm;
    let card;
    if(o.removeCard) card = { ok: true, card: 0 };
    else if(kind === 'edit' && (o.card === undefined || o.card === null)) card = { ok: true, card: target.card || 0 };
    else card = normCardInput(o.card);
    if(!card.ok) return card;
    let pin = null;
    if(o.pin != null && String(o.pin) !== ''){
      if(!/^\d{1,8}$/.test(String(o.pin))) return { ok: false, error: 'Le code ne contient que des chiffres (8 au maximum).' };
      pin = String(o.pin);
    }
    if(card.card){
      const dup = info.users.find(u => u.card === card.card && (kind === 'add' || u.slot !== target.slot));
      if(dup) return { ok: false, error: `Ce n° de badge est déjà attribué à « ${dup.name} » : modification impossible.` };
      const dupP = active.find(c => c.after && c.after.card === card.card && (kind === 'add' || c.slot !== target.slot));
      if(dupP) return { ok: false, error: `Ce n° de badge fait déjà l'objet d'une modification en attente (« ${dupP.after.name} »).` };
    }
    cmd.after = { name: nm.name, card: card.card, hasPin: pin ? true : (o.clearPin ? false : !!(target && target.hasPin)) };
    cmd.name = nm.name; cmd.card = card.card;
    if(pin) cmd.pin = pin; else if(o.clearPin) cmd.clearPin = true;
    if(kind === 'edit' && cmd.before.name === nm.name && (cmd.before.card || 0) === card.card && !pin && !o.clearPin) return { ok: false, error: 'Aucun changement à envoyer.' };
    if(kind === 'add'){
      cmd.slot = nextFreeSlot(info.users, cmds);
      if(cmd.slot == null) return { ok: false, error: 'Plus de place sur la pointeuse.' };
      cmd.userId = String(nextDeviceUserId(db, st, info.users));
      if(o.planningUserId) cmd.planningUserId = String(o.planningUserId).slice(0, 80);
    }
  }
  cmd.summary = badgeSummary(cmd);
  cmds.unshift(cmd); saveBadgeCmds(db, cmds);
  return { ok: true, cmd: publicBadgeCmd(cmd) };
}
function confirmBadge(db, id, by){
  const list = expireBadgeCmds(db);
  const c = list.find(x => x.id === id);
  if(!c) return { ok: false, error: 'Demande introuvable.' };
  if(c.state !== 'wait') return { ok: false, error: 'Cette demande n’est plus en attente de confirmation.' };
  c.state = 'confirmed'; c.confirmedBy = String(by || ''); c.confirmedAt = new Date().toISOString();
  saveBadgeCmds(db, list);
  return { ok: true, cmd: publicBadgeCmd(c) };
}
function cancelBadge(db, id, by){
  const list = expireBadgeCmds(db);
  const c = list.find(x => x.id === id);
  if(!c) return { ok: false, error: 'Demande introuvable.' };
  if(c.state !== 'wait' && c.state !== 'confirmed') return { ok: false, error: c.state === 'sent' ? 'Déjà envoyée à la pointeuse : trop tard pour annuler.' : 'Cette demande est terminée.' };
  c.state = 'cancelled'; c.cancelledBy = String(by || ''); c.doneAt = new Date().toISOString(); dropPin(c);
  saveBadgeCmds(db, list);
  return { ok: true };
}
// La demande confirmée la plus ancienne, remise à l'agent dans la réponse d'un contact (passe à « sent »).
function nextBadgeForAgent(db){
  const list = expireBadgeCmds(db);
  const c = list.slice().reverse().find(x => x.state === 'confirmed');
  if(!c) return null;
  c.state = 'sent'; c.sentAt = new Date().toISOString();
  saveBadgeCmds(db, list);
  const out = { id: c.id, kind: c.kind, slot: c.slot, userId: c.userId, name: c.name, card: c.card || 0 };
  if(c.pin) out.pin = c.pin;
  if(c.clearPin) out.clearPin = true;
  if(c.before) out.before = c.before;
  return out;
}
// Résultat renvoyé par l'agent (après relecture de la pointeuse). Renvoie la commande terminée (pour que le serveur
// applique l'association Planning d'un ajout réussi), ou null si elle est inconnue ou déjà traitée.
function receiveBadgeResult(db, payload){
  const r = payload && payload.badgeResult;
  if(!r || !r.id) return null;
  const list = badgeCmds(db);
  const c = list.find(x => x.id === String(r.id));
  if(!c || c.state !== 'sent') return null;
  c.doneAt = new Date().toISOString();
  c.verified = !!(r.ok && r.verified !== false);
  if(r.ok){ c.state = 'done'; c.error = null; }
  else { c.state = 'error'; c.error = String(r.error || 'Échec de l’écriture sur la pointeuse.').slice(0, 300); }
  dropPin(c);
  saveBadgeCmds(db, list);
  if(Array.isArray(r.users)) noteDevUsers(db, { users: r.users });
  if(c.state === 'done' && c.kind !== 'delete'){
    const known = new Map((readMeta(db, 'users', []) || []).map(u => [u.id, u.name]));
    known.set(ZK_PREFIX + c.userId, c.after.name);
    writeMeta(db, 'users', [...known].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')));
  }
  console.log(`Badges pointeuse : ${c.summary} — ${c.state === 'done' ? 'écrit et vérifié' : 'ÉCHEC (' + c.error + ')'} (demandé par ${c.requestedBy}, confirmé par ${c.confirmedBy}).`);
  return c;
}
function publicBadgeCmd(c){
  const o = { ...c };
  o.pinChange = c.pin ? 'set' : (c.clearPin ? 'clear' : null);
  delete o.pin; delete o.clearPin;
  return o;
}
function badgeState(db){
  const info = devUsersInfo(db);
  return { users: info.users, usersAt: info.at, cmds: expireBadgeCmds(db).map(publicBadgeCmd), agent: readMeta(db, 'agent', null) };
}

function runDeviceEvents(db, st, payload, opts){
  const now = new Date().toISOString();
  const agent = readMeta(db, 'agent', {}) || {};
  agent.lastSeenAt = now;
  agent.host = String((payload && payload.host) || '').slice(0, 60);
  agent.deviceRecords = Number(payload && payload.deviceRecords) || agent.deviceRecords || 0;
  agent.intervalSec = Number(payload && payload.interval) > 0 ? Math.round(Number(payload.interval)) : (agent.intervalSec || null);
  const intervalSec = agentIntervalSec(st);
  const hb = !Array.isArray(payload.events) && !payload.deviceError;
  if(payload && payload.deviceError){
    agent.lastError = String(payload.deviceError).slice(0, 200);
    agent.lastErrorAt = now;
    writeMeta(db, 'agent', agent);
    const rr = recoveryRecord(db);
    if(rr && rr.state === 'pending' && payload.recoverId === rr.id){ rr.state = 'error'; rr.error = 'Pointeuse injoignable : ' + agent.lastError; writeMeta(db, 'recovery', rr); }
    return { ok: true, heartbeat: true, intervalSec, recover: pendingRecover(db) };
  }
  if(hb){
    writeMeta(db, 'agent', agent);
    noteDevUsers(db, payload);
    const done = receiveBadgeResult(db, payload);
    return { ok: true, heartbeat: true, intervalSec, recover: pendingRecover(db), badge: nextBadgeForAgent(db), badgeDone: done ? publicBadgeCmd(done) : undefined };
  }
  if(payload && payload.recoverId){
    // Réponse à une demande de récupération : aperçu uniquement, jamais traitée comme une lecture normale.
    if(runtime.running) return { ok: false, busy: true, error: 'Un import TimeMoto est déjà en cours.' };
    runtime.running = true;
    try{
      writeMeta(db, 'agent', agent);
      noteDevUsers(db, payload);
      receiveRecovery(db, st, payload);
      return { ok: true, recovered: true, intervalSec, recover: pendingRecover(db) };
    }catch(err){
      const rr = readMeta(db, 'recovery', null);
      if(rr && rr.id === payload.recoverId){ rr.state = 'error'; rr.error = String(err && err.message || err).slice(0, 200); writeMeta(db, 'recovery', rr); }
      return { ok: false, error: String(err && err.message || err).slice(0, 200) };
    }finally{
      runtime.running = false;
    }
  }
  if(runtime.running) return { ok: false, busy: true, error: 'Un import TimeMoto est déjà en cours.' };
  runtime.running = true;
  try{
    const parsed = parseAgentEvents(payload);
    const r = syncDeviceRows(db, st, parsed, { dryRun: false, since: opts && opts.since });
    r.future = parsed.future;
    agent.lastError = null; agent.lastSyncAt = now;
    agent.lastResult = { added: r.added, cancelled: r.cancelled, unmapped: r.unmapped, rows: r.rows, future: parsed.future };
    writeMeta(db, 'agent', agent);
    const s = readMeta(db, 'status', {}) || {};
    Object.assign(s, { lastOkAt: now, lastResult: publicResult(r), lastImportTo: r.to });
    writeMeta(db, 'status', s);
    if(r.added || r.cancelled) console.log(`Pointeuse (auto) : ${r.added} pointage(s) importé(s), ${r.cancelled} annulé(s) (${r.from} → ${r.to}).`);
    noteDevUsers(db, payload);
    return { ok: true, result: publicResult(r), intervalSec, recover: pendingRecover(db), badge: nextBadgeForAgent(db) };
  }catch(err){
    agent.lastError = String(err && err.message || err).slice(0, 200); agent.lastErrorAt = now;
    writeMeta(db, 'agent', agent);
    return { ok: false, error: agent.lastError };
  }finally{
    runtime.running = false;
  }
}

function status(db, st){
  const s = readMeta(db, 'status', {}) || {};
  const out = { lastOkAt: s.lastOkAt || null, lastResult: s.lastResult || null, lastImportTo: s.lastImportTo || null, users: readMeta(db, 'users', []) || [], agent: readMeta(db, 'agent', null), recovery: recoveryRecord(db) };
  if(st) out.flags = flagInfo(db, st);
  return out;
}
// Nombre de journées signalées (résumé léger pour la page Présence, sans calcul de description).
function flaggedCount(db){ return Object.keys(readMeta(db, 'flagged', {}) || {}).length; }
function publicResult(r){ const { byUser, tmUsers, ...rest } = r; return rest; }
async function runSync(db, st, opts){
  if(runtime.running) return { ok: false, error: 'Un import TimeMoto est déjà en cours.' };
  runtime.running = true;
  try{
    const r = await syncOnce(db, st, opts);
    if(!r.dryRun){
      const s = readMeta(db, 'status', {}) || {};
      Object.assign(s, { lastOkAt: new Date().toISOString(), lastResult: publicResult(r), lastImportTo: r.to });
      writeMeta(db, 'status', s);
      if(r.added || r.cancelled) console.log(`TimeMoto : ${r.added} pointage(s) importé(s), ${r.cancelled} annulé(s) (${r.from} → ${r.to}).`);
    }
    return { ok: true, result: r };
  }catch(err){
    // Message seulement (jamais l'objet d'erreur complet : il pourrait contenir la requête/le jeton).
    return { ok: false, error: String(err && err.message || err).slice(0, 300) };
  }finally{
    runtime.running = false;
  }
}

module.exports = {
  initTimemotoTables, runSync, runDeviceImport, runDeviceEvents, parseAgentEvents, parseDeviceCsv, syncDeviceRows, status, syncOnce, desiredPunches, reconcileDay, expectedEndFor, expectedBoundsFor, ignoredEventsFor, SYSTEM_USER,
  triageBegin, triageStart, triageInterpret, triageApply, triageCancel, triageExcludedCount, deviceGroupInterpret, triageMeta,
  requestRecovery, applyRecovery, cancelRecovery, recoveryRecord, applyFlagAction, flaggedCount, flagInfo, rowFromEvents, sequenceKinds, sequenceModeFor,
  badgeState, prepareBadge, confirmBadge, cancelBadge, nextBadgeForAgent, receiveBadgeResult, noteDevUsers, nextDeviceUserId
};
