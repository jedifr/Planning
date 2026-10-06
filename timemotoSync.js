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
function expectedEndFor(st, uid, dayKey){
  const d = new Date(dayKey + 'T12:00:00');
  if(d.getDay() === 0 || d.getDay() === 6) return null;
  const conge = (st.leaveRequests || []).some(r => String(r.userId) === String(uid) && r.statut === 'approuve' && r.debut <= dayKey && r.fin >= dayKey && !r.demiJournee);
  if(conge) return null;
  const cfg = autoPause.applyUserLunchOverride({ ...(st.config || {}) }, String(uid), st);
  if(cfg.startHour == null || !(Number(cfg.monThuHours) > 0)) return null;
  const segs = autoPause.dayIntervals(d, cfg);
  return segs.length ? segs[segs.length - 1][1] : null;
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
  const out = [];
  let stt = 'none';
  events.forEach((ev, i) => {
    if(ev.kind === 'in'){
      if(stt === 'none'){ out.push({ type: 'in', ...ev }); stt = 'present'; }
      else if(stt === 'pause'){ out.push({ type: 'pause_end', ...ev }); stt = 'present'; }
      else anomalies.ignored++;
      return;
    }
    if(ev.auto){ anomalies.autoOut++; return; }
    if(stt !== 'present'){ anomalies.ignored++; return; }
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
  return { punches: out.map(p => ({ type: p.type, ts: p.ts, orig: p.orig })), anomalies, events: rawEvents };
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
    const punch = presence.insertPunch(db, { userId: uid, type: p.type, ts: p.ts, source: 'timemoto', createdBy: SYSTEM_USER, commentaire: edited ? `Heure modifiée dans TimeMoto (heure d'origine ${p.orig.slice(11, 19)}).` : '' });
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
  return { flagged: readMeta(db, 'flagged', {}) || {}, flips: readMeta(db, 'flips', {}) || {}, ignored: new Set(readMeta(db, 'flagIgnored', []) || []), dirty: false };
}
function saveFlags(db, f){
  if(!f.dirty) return;
  const cut = presence.localTs(new Date(Date.now() - 400 * 86400000)).slice(0, 10);
  const prune = o => { Object.keys(o).forEach(k => { if((o[k].day || '') < cut) delete o[k]; }); return o; };
  writeMeta(db, 'flagged', prune(f.flagged));
  writeMeta(db, 'flips', prune(f.flips));
  writeMeta(db, 'flagIgnored', [...f.ignored].slice(-1000));
  f.dirty = false;
}
// Tient à jour l'état des journées après le calcul de `d` (résultat de desiredPunches) ; `res.flagged`
// reçoit les journées signalées par CETTE lecture (visible aussi en aperçu, sans rien écrire).
function noteDayFlags(f, tmId, uid, day, d, res){
  const key = `${tmId}|${day}`;
  const raw = d.events || [];
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
    const kind = act.startsWith('entr') ? 'in' : act.startsWith('sort') ? 'out' : null;
    if(!kind){ out.otherAction++; return; }
    const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[iDate] || '');
    const day = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : (presence.DATE_RE.test(c[iDate] || '') ? c[iDate] : null);
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(c[iTime] || '');
    if(!day || !tm){ out.badDate++; return; }
    const ts = `${day}T${String(tm[1]).padStart(2, '0')}:${tm[2]}:${tm[3] || '00'}`;
    const nm = iName >= 0 ? c[iName] : '';
    if(nm && noAccent(nm) !== 'inconnu') out.names.set(uid, nm);
    out.events.push({ uid, day, ts, kind });
  });
  return out;
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
  const byDay = new Map();
  parsed.events.forEach(ev => {
    if(ev.day < from || (until && ev.day > until)) return;
    const k = `${ev.uid}|${ev.day}`;
    if(!byDay.has(k)) byDay.set(k, { uid: ev.uid, day: ev.day, events: [] });
    byDay.get(k).events.push(ev);
  });
  const res = { device: true, from, to: until || today, rows: byDay.size, complete: true, added: 0, cancelled: 0, respected: 0, autoOut: 0, ignored: 0, unmapped: 0, noUser: parsed.noUser, otherAction: parsed.otherAction, badDate: parsed.badDate, dryRun: !!o.dryRun, byUser: {} };
  const flags = loadFlags(db);
  const apply = () => {
    byDay.forEach(g => {
      const tmId = ZK_PREFIX + g.uid;
      const uid = userMap[tmId] ? String(userMap[tmId]) : '';
      if(!uid){ res.unmapped++; return; }
      // Même forme que la réponse TimeMoto Cloud : un « pair » par événement (entrée ou sortie seule).
      const row = rowFromEvents(g.day, g.events);
      const d = desiredPunches(row, uid, st, now, !!flags.flips[`${tmId}|${g.day}`]);
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
    const kind = ev.kind === 'in' ? 'in' : ev.kind === 'out' ? 'out' : null;
    if(!kind){ out.otherAction++; return; }
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(ev.ts || ''));
    if(!m){ out.badDate++; return; }
    const ts = `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`;
    if(new Date(ts).getTime() > limit){ out.future++; return; }
    out.events.push({ uid, day: m[1], ts, kind });
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
  if(hb){ writeMeta(db, 'agent', agent); return { ok: true, heartbeat: true, intervalSec, recover: pendingRecover(db) }; }
  if(payload && payload.recoverId){
    // Réponse à une demande de récupération : aperçu uniquement, jamais traitée comme une lecture normale.
    if(runtime.running) return { ok: false, busy: true, error: 'Un import TimeMoto est déjà en cours.' };
    runtime.running = true;
    try{
      writeMeta(db, 'agent', agent);
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
    return { ok: true, result: publicResult(r), intervalSec, recover: pendingRecover(db) };
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
  initTimemotoTables, runSync, runDeviceImport, runDeviceEvents, parseAgentEvents, parseDeviceCsv, syncDeviceRows, status, syncOnce, desiredPunches, reconcileDay, expectedEndFor, SYSTEM_USER,
  requestRecovery, applyRecovery, cancelRecovery, recoveryRecord, applyFlagAction, flaggedCount, flagInfo, rowFromEvents
};
