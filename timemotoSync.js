// Synchronisation de la pointeuse TimeMoto TM-616 via TimeMoto Cloud (voir CLAUDE.md « Pointeuse
// TimeMoto TM-616 »). Sans formule Plus (ni webhook ni clé d'API), seule l'API INTERNE du site
// TimeMoto Cloud est disponible — non documentée, elle peut changer sans prévenir : toute panne est
// signalée (Paramètres, page Présence), jamais silencieuse, et ne bloque jamais le reste de l'appli.
//
// Authentification : OAuth2 « code + PKCE » (client public « Cloud »). Le jeton d'accès vaut 1 h et
// il n'y a PAS de refresh_token : on reprend donc le mécanisme du site lui-même — un /connect/authorize
// avec prompt=none tant que le cookie de session TimeMoto est valide, et seulement sinon une connexion
// complète par e-mail + mot de passe (TIMEMOTO_EMAIL / TIMEMOTO_PASSWORD, variables d'environnement du
// conteneur). SÉCURITÉ : identifiants, cookies, code, code_verifier et jetons ne vivent qu'en mémoire —
// jamais dans app_state, les sauvegardes, la base ou les logs. Après un refus d'identifiants, aucune
// nouvelle tentative avant une heure (ne jamais faire verrouiller le compte TimeMoto).
//
// Import : chaque paire entrée/sortie de TimeMoto devient des pointages de la table presence_punches
// (source 'timemoto', heure de la pointeuse). Réconciliation par (salarié TimeMoto, jour) : ce qui
// manque est ajouté, ce qui a disparu ou changé côté TimeMoto est ANNULÉ par une ligne d'annulation —
// jamais modifié ni supprimé (même règle « infalsifiable » que le reste du module). Une annulation
// faite à la main par un superviseur est respectée : la synchro ne réimporte jamais ce pointage.
const crypto = require('crypto');
const presence = require('./presence');
const autoPause = require('./autoPauseResume');

const SYSTEM_USER = 'timemoto';
const LOGIN_BACKOFF_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 15 * 60 * 1000;

function env(){
  return {
    authUrl: (process.env.TIMEMOTO_AUTH_URL || 'https://auth-eu.timemoto.com').replace(/\/+$/, ''),
    cloudUrl: (process.env.TIMEMOTO_CLOUD_URL || 'https://cloud-eu.timemoto.com').replace(/\/+$/, ''),
    clientId: process.env.TIMEMOTO_CLIENT_ID || 'Cloud',
    scope: process.env.TIMEMOTO_SCOPE || 'openid profile public-api',
    redirectUri: process.env.TIMEMOTO_REDIRECT_URI || 'https://cloud-eu.timemoto.com',
    email: process.env.TIMEMOTO_EMAIL || '',
    password: process.env.TIMEMOTO_PASSWORD || ''
  };
}
function maskEmail(e){
  const m = String(e || '').match(/^(.)(.*)(@.*)$/);
  return m ? `${m[1]}${'•'.repeat(Math.min(6, m[2].length))}${m[3]}` : '';
}

// ---------- Tables (liens pointage ↔ TimeMoto, état de la synchro) ----------
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

// ---------- Client HTTP minimal avec cookies (en mémoire uniquement) ----------
function splitSetCookie(headers){
  if(typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[^;,=\s]+=)/) : [];
}
class CookieJar {
  constructor(){ this.byHost = new Map(); }
  store(url, headers){
    const host = new URL(url).host;
    if(!this.byHost.has(host)) this.byHost.set(host, new Map());
    const jar = this.byHost.get(host);
    splitSetCookie(headers).forEach(c => {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      if(i < 1) return;
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim();
      const expired = attrs.some(a => /^\s*max-age\s*=\s*-?0\b/i.test(a)) || attrs.some(a => { const m = a.match(/^\s*expires\s*=(.*)$/i); return m && new Date(m[1]) < new Date(); });
      if(expired || value === '') jar.delete(name); else jar.set(name, value);
    });
  }
  header(url){
    const jar = this.byHost.get(new URL(url).host);
    return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
  }
  has(url){ const jar = this.byHost.get(new URL(url).host); return !!(jar && jar.size); }
}
async function httpReq(jar, url, opts){
  const headers = { 'User-Agent': 'PlanningAtelier-TimeMotoSync/1.0', ...(opts && opts.headers || {}) };
  const ck = jar.header(url);
  if(ck) headers.Cookie = ck;
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  jar.store(url, res.headers);
  return res;
}

// ---------- OAuth2 code + PKCE ----------
function b64url(buf){ return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function pkcePair(){
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
function authorizeUrl(e, challenge, prompt){
  const p = new URLSearchParams({
    client_id: e.clientId, redirect_uri: e.redirectUri, response_type: 'code', scope: e.scope,
    state: b64url(crypto.randomBytes(12)), nonce: b64url(crypto.randomBytes(12)),
    code_challenge: challenge, code_challenge_method: 'S256', response_mode: 'query'
  });
  if(prompt) p.set('prompt', prompt);
  return `${e.authUrl}/connect/authorize?${p.toString()}`;
}
function isRedirectTarget(e, loc){
  return loc === e.redirectUri || loc.startsWith(e.redirectUri + '/') || loc.startsWith(e.redirectUri + '?') || loc.startsWith(e.redirectUri + '#');
}
function paramsOf(loc){
  const u = new URL(loc);
  const p = new URLSearchParams(u.search);
  if(u.hash.length > 1) new URLSearchParams(u.hash.slice(1)).forEach((v, k) => { if(!p.has(k)) p.set(k, v); });
  return p;
}
// Suit les redirections jusqu'au retour vers redirect_uri (code ou erreur) ou jusqu'à une page HTML
// (la page de connexion). Jamais plus de 15 sauts.
async function follow(jar, e, url, init){
  let res = await httpReq(jar, url, init);
  for(let i = 0; i < 15; i++){
    if(res.status >= 300 && res.status < 400 && res.headers.get('location')){
      const loc = new URL(res.headers.get('location'), url).toString();
      if(isRedirectTarget(e, loc)){
        const p = paramsOf(loc);
        return { code: p.get('code'), error: p.get('error') };
      }
      url = loc;
      res = await httpReq(jar, url, { method: 'GET' });
      continue;
    }
    return { html: await res.text(), url, status: res.status };
  }
  throw new Error('Trop de redirections pendant la connexion à TimeMoto.');
}
function decodeEntities(s){
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#x2F;/g, '/');
}
function attr(tag, name){
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : null;
}
// Formulaire de connexion (générique, pour ne pas dépendre des noms exacts de champs) : celui qui
// contient un champ mot de passe ; identifiant = champ email, sinon premier champ texte visible.
function parseLoginForm(html, pageUrl){
  const forms = String(html).match(/<form\b[\s\S]*?<\/form>/gi) || [];
  const form = forms.find(f => /type\s*=\s*["']?password/i.test(f));
  if(!form) return null;
  const openTag = form.match(/<form\b[^>]*>/i)[0];
  const action = new URL(attr(openTag, 'action') || pageUrl, pageUrl).toString();
  const fields = {};
  let userField = null, passField = null;
  (form.match(/<input\b[^>]*>/gi) || []).forEach(tag => {
    const name = attr(tag, 'name');
    if(!name) return;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if(type === 'password'){ if(!passField) passField = name; return; }
    if(type === 'hidden'){ fields[name] = attr(tag, 'value') || ''; return; }
    if(type === 'checkbox' || type === 'radio'){ if(/\schecked\b/i.test(tag)) fields[name] = attr(tag, 'value') || 'on'; return; }
    if(type === 'submit' || type === 'button') return;
    if(!userField && (type === 'email' || /mail|user|login|name/i.test(name) || type === 'text')) userField = name;
  });
  const btn = (form.match(/<button\b[^>]*>/gi) || []).map(t => ({ name: attr(t, 'name'), value: attr(t, 'value'), type: (attr(t, 'type') || 'submit').toLowerCase() }))
    .find(b => b.name && b.type === 'submit' && !/cancel|annul/i.test(b.value || ''));
  if(btn) fields[btn.name] = btn.value || '';
  if(!userField || !passField) return null;
  return { action, fields, userField, passField };
}
async function exchangeCode(jar, e, code, verifier){
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: e.redirectUri, client_id: e.clientId, code_verifier: verifier });
  const res = await httpReq(jar, `${e.authUrl}/connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
  if(!res.ok) throw new Error(`Échange du code refusé par TimeMoto (HTTP ${res.status}).`);
  const j = await res.json();
  if(!j.access_token) throw new Error('Réponse de jeton TimeMoto inattendue (pas de access_token).');
  return { token: j.access_token, expiresAt: Date.now() + Math.max(60, Number(j.expires_in) || 3600) * 1000 };
}

class AuthError extends Error {}

// Session TimeMoto en mémoire : cookies + jeton en cours. Rien n'est écrit sur disque.
const session = { jar: new CookieJar(), token: null, expiresAt: 0, lastMode: null };
function resetSession(){ session.jar = new CookieJar(); session.token = null; session.expiresAt = 0; }

async function obtainToken(){
  const e = env();
  if(session.token && session.expiresAt - Date.now() > 120000) return session.token;
  // 1) Renouvellement silencieux (comme le site) tant que le cookie de session TimeMoto est valide.
  if(session.jar.has(e.authUrl)){
    const pk = pkcePair();
    const r = await follow(session.jar, e, authorizeUrl(e, pk.challenge, 'none'), { method: 'GET' });
    if(r.code){
      Object.assign(session, await exchangeCode(session.jar, e, r.code, pk.verifier), { lastMode: 'silent' });
      return session.token;
    }
  }
  // 2) Connexion complète par e-mail + mot de passe.
  if(!e.email || !e.password) throw new AuthError('Identifiants TimeMoto non configurés sur le serveur (TIMEMOTO_EMAIL / TIMEMOTO_PASSWORD).');
  resetSession();
  const pk = pkcePair();
  const page = await follow(session.jar, e, authorizeUrl(e, pk.challenge, null), { method: 'GET' });
  if(page.code){
    Object.assign(session, await exchangeCode(session.jar, e, page.code, pk.verifier), { lastMode: 'login' });
    return session.token;
  }
  if(page.error) throw new Error(`TimeMoto a refusé la demande d'autorisation (${page.error}).`);
  const form = parseLoginForm(page.html, page.url);
  if(!form) throw new Error('Page de connexion TimeMoto non reconnue (formulaire introuvable) — le site a peut-être changé.');
  const body = new URLSearchParams({ ...form.fields, [form.userField]: e.email, [form.passField]: e.password });
  const r = await follow(session.jar, e, form.action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if(r.code){
    Object.assign(session, await exchangeCode(session.jar, e, r.code, pk.verifier), { lastMode: 'login' });
    return session.token;
  }
  if(r.html && parseLoginForm(r.html, r.url)){ resetSession(); throw new AuthError('Identifiants TimeMoto refusés (e-mail ou mot de passe incorrect, ou compte bloqué).'); }
  throw new Error(`Connexion à TimeMoto inattendue${r.error ? ` (${r.error})` : ''} — vérifier qu'aucune étape supplémentaire (code, captcha) n'a été ajoutée.`);
}

// ---------- Récupération des journées ----------
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
    if(res.status === 401 || res.status === 403){ const err = new Error(`Jeton TimeMoto refusé (HTTP ${res.status}).`); err.unauthorized = true; throw err; }
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
  let st8 = 'none';
  events.forEach((ev, i) => {
    if(ev.kind === 'in'){
      if(st8 === 'none'){ out.push({ type: 'in', ...ev }); st8 = 'present'; }
      else if(st8 === 'pause'){ out.push({ type: 'pause_end', ...ev }); st8 = 'present'; }
      else anomalies.ignored++;
      return;
    }
    if(ev.auto){ anomalies.autoOut++; return; }
    if(st8 !== 'present'){ anomalies.ignored++; return; }
    const laterIn = events.slice(i + 1).some(x => x.kind === 'in');
    out.push({ type: laterIn ? 'pause_start' : 'out', ...ev });
    st8 = laterIn ? 'pause' : 'done';
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

// Une synchronisation complète : lecture de la période, puis réconciliation de chaque journée des
// salariés associés. `opts.token` (jeton collé à la main pour un test) remplace la connexion et
// n'est JAMAIS conservé. `opts.dryRun` : rien n'est écrit, seul le résumé est renvoyé.
async function syncOnce(db, st, opts){
  const o = opts || {};
  const tmCfg = ((st.config || {}).presence || {}).timemoto || {};
  const userMap = tmCfg.userMap || {};
  const now = new Date();
  const today = presence.localTs(now).slice(0, 10);
  const jours = Math.max(1, Math.min(31, Number(tmCfg.joursSynchro) || 7));
  let from = presence.DATE_RE.test(String(o.since || '')) ? o.since : addDays(today, -(jours - 1));
  if(from > today) from = today;
  if(from < addDays(today, -400)) from = addDays(today, -400);
  let token = o.token ? String(o.token).trim().replace(/^Bearer\s+/i, '') : null;
  let fetched;
  try{
    fetched = await fetchDailyView(token || await obtainToken(), from, today);
  }catch(err){
    if(!err.unauthorized || token) throw err;
    session.token = null; session.expiresAt = 0; // jeton expiré ou révoqué : une seule nouvelle tentative
    fetched = await fetchDailyView(await obtainToken(), from, today);
  }
  token = null;
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

// ---------- Planificateur ----------
const runtime = { running: false, nextAllowedAt: 0 };
function status(db){
  const e = env();
  const s = readMeta(db, 'status', {}) || {};
  return {
    credentials: !!(e.email && e.password), email: maskEmail(e.email),
    running: runtime.running, nextAllowedAt: runtime.nextAllowedAt ? new Date(runtime.nextAllowedAt).toISOString() : null,
    lastRunAt: s.lastRunAt || null, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null, lastErrorAt: s.lastErrorAt || null,
    lastResult: s.lastResult || null, authMode: session.lastMode, users: readMeta(db, 'users', []) || []
  };
}
function publicResult(r){
  const { byUser, tmUsers, ...rest } = r;
  return rest;
}
async function runSync(db, st, opts){
  if(runtime.running) return { ok: false, error: 'Une synchronisation TimeMoto est déjà en cours.' };
  runtime.running = true;
  const s = readMeta(db, 'status', {}) || {};
  const manualToken = !!(opts && opts.token);
  try{
    const r = await syncOnce(db, st, opts);
    if(!r.dryRun){
      Object.assign(s, { lastRunAt: new Date().toISOString(), lastOkAt: new Date().toISOString(), lastError: null, lastErrorAt: null, lastResult: publicResult(r) });
      writeMeta(db, 'status', s);
      if(r.added || r.cancelled) console.log(`TimeMoto : ${r.added} pointage(s) importé(s), ${r.cancelled} annulé(s) (${r.from} → ${r.to}).`);
    }
    runtime.nextAllowedAt = 0;
    return { ok: true, result: r };
  }catch(err){
    // Message seulement (jamais d'objet d'erreur complet : il pourrait contenir une requête).
    const msg = String(err && err.message || err).slice(0, 300);
    if(!manualToken){
      runtime.nextAllowedAt = Date.now() + (err instanceof AuthError ? LOGIN_BACKOFF_MS : ERROR_BACKOFF_MS);
      Object.assign(s, { lastRunAt: new Date().toISOString(), lastError: msg, lastErrorAt: new Date().toISOString() });
      writeMeta(db, 'status', s);
      console.error('Synchronisation TimeMoto impossible :', msg);
    }
    return { ok: false, error: msg };
  }finally{
    runtime.running = false;
  }
}
// Appelée chaque minute par server.js : synchronise si le module et la synchro sont actifs et que
// l'intervalle choisi est écoulé (jamais pendant une attente après erreur).
async function tick(db, st){
  const cfg = st && st.config || {};
  const tm = (cfg.presence || {}).timemoto || {};
  if(!(cfg.modules && cfg.modules.presence) || !tm.actif || runtime.running) return;
  if(runtime.nextAllowedAt && Date.now() < runtime.nextAllowedAt) return;
  const s = readMeta(db, 'status', {}) || {};
  const every = Math.max(5, Math.min(120, Number(tm.intervalleMin) || 10)) * 60000;
  if(s.lastRunAt && Date.now() - new Date(s.lastRunAt).getTime() < every) return;
  await runSync(db, st, {});
}

module.exports = {
  initTimemotoTables, runSync, tick, status, syncOnce, desiredPunches, reconcileDay, parseLoginForm, expectedEndFor,
  _session: session, _runtime: runtime, _resetSession: resetSession, SYSTEM_USER
};
