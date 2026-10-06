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
function desiredPunches(row, uid, st, now){
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
  const anomalies = { autoOut: 0, ignored: 0 };
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
  return { punches: out.map(p => ({ type: p.type, ts: p.ts, orig: p.orig })), anomalies };
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
      const d = desiredPunches(row, uid, st, now);
      res.autoOut += d.anomalies.autoOut; res.ignored += d.anomalies.ignored;
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
  if(o.dryRun) apply(); else db.transaction(apply)();
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
  const byDay = new Map();
  parsed.events.forEach(ev => {
    if(ev.day < from) return;
    const k = `${ev.uid}|${ev.day}`;
    if(!byDay.has(k)) byDay.set(k, { uid: ev.uid, day: ev.day, events: [] });
    byDay.get(k).events.push(ev);
  });
  const res = { device: true, from, to: today, rows: byDay.size, complete: true, added: 0, cancelled: 0, respected: 0, autoOut: 0, ignored: 0, unmapped: 0, noUser: parsed.noUser, otherAction: parsed.otherAction, badDate: parsed.badDate, dryRun: !!o.dryRun, byUser: {} };
  const apply = () => {
    byDay.forEach(g => {
      const tmId = ZK_PREFIX + g.uid;
      const uid = userMap[tmId] ? String(userMap[tmId]) : '';
      if(!uid){ res.unmapped++; return; }
      // Même forme que la réponse TimeMoto Cloud : un « pair » par événement (entrée ou sortie seule).
      const row = { date: g.day, clockData: g.events.map(ev => ev.kind === 'in'
        ? { in: { fullClockTime: ev.ts, clockingActionTypeId: 0 } }
        : { out: { fullClockTime: ev.ts, clockingActionTypeId: 1 } }) };
      const d = desiredPunches(row, uid, st, now);
      res.autoOut += d.anomalies.autoOut; res.ignored += d.anomalies.ignored;
      const r = reconcileDay(db, tmId, g.day, uid, d.punches, o.dryRun);
      res.added += r.added; res.cancelled += r.cancelled; res.respected += r.respected;
      const bu = res.byUser[uid] || (res.byUser[uid] = { added: 0, cancelled: 0, jours: 0 });
      bu.added += r.added; bu.cancelled += r.cancelled; if(d.punches.length) bu.jours++;
    });
  };
  if(o.dryRun) apply(); else db.transaction(apply)();
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

function status(db){
  const s = readMeta(db, 'status', {}) || {};
  return { lastOkAt: s.lastOkAt || null, lastResult: s.lastResult || null, lastImportTo: s.lastImportTo || null, users: readMeta(db, 'users', []) || [] };
}
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
  initTimemotoTables, runSync, runDeviceImport, parseDeviceCsv, syncDeviceRows, status, syncOnce, desiredPunches, reconcileDay, expectedEndFor, SYSTEM_USER
};
