// Fixe le fuseau horaire du processus AVANT tout require() qui pourrait manipuler des dates — cette
// application ne sert qu'un seul client français (Découpe H2O, interface entièrement en français,
// jours fériés déjà codés en dur pour la France) : autant ne jamais dépendre du fuseau horaire du
// système hôte (le NAS Synology tourne par défaut en UTC dans son conteneur Docker, sans réglage
// TZ explicite dans docker-compose.yml). Sans ce correctif, `new Date()` et le parsing des horaires
// naïfs "AAAA-MM-JJTHH:mm" (sessions[], debutReel/finReel...) sur le SERVEUR étaient décalés de
// l'écart UTC/Europe-Paris courant (2h en heure d'été) par rapport à l'heure réelle du navigateur —
// bug réel signalé : une tâche reprise par un opérateur en pleine journée de travail se remettait en
// pause automatiquement quelques secondes plus tard, le job serveur "hors horaires" (voir
// autoPauseResume.js/CLAUDE.md) croyant à tort être avant l'ouverture de l'atelier. Voir aussi
// docker-compose.yml (TZ ajoutée par prudence en complément, sans dépendre de ce seul réglage).
process.env.TZ = 'Europe/Paris';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const Database = require('better-sqlite3');
const cors = require('cors');
const { runBackup, hasSmtpConfig, sendNotificationEmail } = require('./backup');
const auth = require('./auth');
const license = require('./license');
const sessionHistory = require('./sessionHistory');
const previsionHistory = require('./previsionHistory');
const autoPauseResume = require('./autoPauseResume');
const reportEmail = require('./reportEmail');
const presence = require('./presence');
const timemoto = require('./timemotoSync');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'planning.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Numéro de version du code effectivement servi — lu une seule fois au démarrage directement dans
// public/index.html (APP_VERSION y est la seule source de vérité, voir CLAUDE.md). Un déploiement
// redémarre toujours le conteneur (deploy.sh), donc cette constante reflète toujours le code
// réellement en cours d'exécution. Renvoyée à chaque /api/state pour que le client détecte une mise
// à jour déployée pendant qu'une page reste ouverte, et se recharge automatiquement (voir
// checkAppVersion() côté client) plutôt que de compter sur un Ctrl+Maj+R manuel.
const APP_VERSION = (() => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const m = html.match(/const APP_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
})();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
`);

function nowIso(){ return new Date().toISOString(); }
function toInputValue(d){
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function defaultState(){
  const now = toInputValue(new Date());
  return {
    config: {
      startHour: 8, startMinute: 0, monThuHours: 8.75, friHours: 4, pauseActive: true, pauseDebut: '12:00', pauseFin: '13:00',
      backup: { destinataire: '', motDePasse: '', heure: '02:00', actif: false, dernierEnvoi: null }
    },
    machines: [
      { id: 'm-1', nom: 'Fraiseuse 1', dispo: now, horairesActifs: false, horaires: null },
      { id: 'm-2', nom: 'Fraiseuse 2 — Petites séries', dispo: now, horairesActifs: false, horaires: null },
      { id: 'm-3', nom: 'Tour', dispo: now, horairesActifs: false, horaires: null }
    ],
    commandes: []
  };
}

const existing = db.prepare('SELECT id FROM app_state WHERE id = 1').get();
if(!existing){
  db.prepare('INSERT INTO app_state (id, data, version, updated_at) VALUES (1, ?, 1, ?)')
    .run(JSON.stringify(defaultState()), nowIso());
  console.log('Base initialisée avec un planning par défaut.');
}

auth.initUsersTable(db);
auth.bootstrapFirstUser(db, path.dirname(DB_PATH));
license.initLicenseTable(db);
license.bootstrapInitialLicense(db);
sessionHistory.initSessionHistoryTable(db);
previsionHistory.initPrevisionHistoryTable(db);
presence.initPresenceTables(db);
timemoto.initTimemotoTables(db);

const app = express();
app.set('trust proxy', 1); // nécessaire pour que les cookies "secure" fonctionnent derrière un reverse proxy (Synology, etc.)
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if(!process.env.SESSION_SECRET){
  console.log("SESSION_SECRET non défini : un secret aléatoire a été généré pour cette exécution.");
  console.log("Les sessions ne survivront pas à un redémarrage du conteneur tant qu'un SESSION_SECRET fixe n'est pas défini dans docker-compose.yml.");
}
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';
app.use(session({
  secret: SESSION_SECRET,
  name: 'planning.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: COOKIE_SECURE, // à activer (COOKIE_SECURE=true) une fois l'accès servi en HTTPS
    maxAge: 7 * 24 * 3600 * 1000 // 7 jours
  }
}));

function requireAuth(req, res, next){
  if(req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Authentification requise.' });
}
function requireAdmin(req, res, next){
  if(!req.session || !req.session.userId) return res.status(401).json({ error: 'Authentification requise.' });
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if(!user || user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux comptes Administrateur.' });
  next();
}
// Bloque l'accès aux fonctionnalités réelles de l'appli si aucune licence valide n'est installée.
// Volontairement PAS appliqué à /api/login, /api/session, /api/branding, /api/health ni aux routes
// /api/license/* elles-mêmes — sinon un administrateur ne pourrait plus se connecter pour justement
// installer une nouvelle clé après expiration.
const requireLicense = license.requireLicense(db);

// ---------------- Authentification ----------------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip || 'unknown';
  if(!username || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  if(auth.isLocked(ip, username)){
    return res.status(429).json({ error: `Trop de tentatives — réessayez dans quelques minutes.` });
  }
  const user = auth.findUserByUsername(db, username);
  if(!auth.verifyPassword(user, password)){
    auth.registerFailure(ip, username);
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  auth.registerSuccess(ip, username);
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username, userId: user.id, role: user.role });
});
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/session', (req, res) => {
  if(req.session && req.session.userId){
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
    return res.json({ authenticated: true, username: req.session.username, userId: req.session.userId, role: user ? user.role : 'employe' });
  }
  res.json({ authenticated: false });
});

// ---------------- Mot de passe oublié (aucune authentification requise) ----------------
app.post('/api/forgot-password', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if(auth.isLocked(ip, 'forgot-password')){
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
  }
  const { username } = req.body || {};
  // Réponse volontairement identique que le compte existe ou non, et qu'il ait un e-mail ou pas —
  // pour ne jamais révéler quels identifiants existent réellement sur le serveur.
  const genericMsg = "Si un compte avec cet identifiant existe et qu'une adresse e-mail y est associée, un lien de réinitialisation vient de lui être envoyé.";
  auth.registerFailure(ip, 'forgot-password'); // comptabilisé même en cas de succès : limite le nombre total de requêtes, pas juste les échecs
  if(!username) return res.json({ ok: true, message: genericMsg });
  const user = auth.findUserByUsername(db, username.trim());
  if(!user || !user.email){ return res.json({ ok: true, message: genericMsg }); }
  const token = auth.createResetToken(db, user.id);
  const baseUrl = req.protocol + '://' + req.get('host');
  const link = `${baseUrl}/?reset=${token}`;
  const subject = 'Réinitialisation de votre mot de passe';
  const text = `Une réinitialisation de mot de passe a été demandée pour le compte "${user.username}".\n\nCliquez sur ce lien pour choisir un nouveau mot de passe (valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail — votre mot de passe actuel reste inchangé.`;
  await sendNotificationEmail(user.email, subject, text);
  res.json({ ok: true, message: genericMsg });
});
app.post('/api/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if(!password || password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  const user = auth.findUserByResetToken(db, token);
  if(!user) return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou a expiré. Merci de refaire une demande.' });
  auth.updateUserPassword(db, user.id, password);
  auth.clearResetToken(db, user.id);
  res.json({ ok: true, username: user.username });
});

// ---------------- Confirmation d'un congé attribué par un administrateur (aucune authentification
// requise — la personne agit via un lien reçu par e-mail, sans avoir à se connecter). Ce sont les
// deux seules routes où le serveur va lire/modifier une donnée précise à l'intérieur du blob
// d'état de l'appli, plutôt que de le traiter comme une simple donnée opaque. ----------------
app.get('/api/leave-confirm-info/:token', (req, res) => {
  const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get();
  const state = JSON.parse(row.data);
  const reqObj = (state.leaveRequests||[]).find(r => r.confirmToken === req.params.token && r.statut === 'a_confirmer');
  if(!reqObj) return res.status(404).json({ error: "Cette proposition de congé est introuvable, a déjà été traitée, ou ce lien n'est plus valide." });
  const type = (state.leaveTypes||[]).find(t=>t.id===reqObj.typeId);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(Number(reqObj.userId));
  res.json({ ok:true, typeNom: type?type.nom:'Congé', debut: reqObj.debut, fin: reqObj.fin, motif: reqObj.motif||'', username: user?user.username:'' });
});
app.post('/api/leave-confirm', (req, res) => {
  const { token, decision } = req.body || {};
  if(!token || (decision!=='accept' && decision!=='refuse')) return res.status(400).json({ error: 'Requête invalide.' });
  const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
  const state = JSON.parse(row.data);
  const reqObj = (state.leaveRequests||[]).find(r => r.confirmToken === token && r.statut === 'a_confirmer');
  if(!reqObj) return res.status(404).json({ error: "Cette proposition de congé est introuvable ou a déjà été traitée." });
  const type = (state.leaveTypes||[]).find(t=>t.id===reqObj.typeId);
  reqObj.statut = decision === 'accept' ? 'approuve' : 'refuse';
  reqObj.traiteLe = nowIso();
  reqObj.commentaireValidation = decision === 'accept'
    ? 'Confirmé par la personne concernée via le lien reçu par e-mail.'
    : 'Refusé par la personne concernée via le lien reçu par e-mail.';
  delete reqObj.confirmToken;
  const newVersion = row.version + 1;
  db.prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(state), newVersion, nowIso());
  res.json({ ok:true, decision, typeNom: type?type.nom:'Congé' });
});

// ---------------- Licence (protection commerciale, valable pour une durée donnée) ----------------
// Statut consultable par tout compte connecté (pour afficher l'écran de blocage le cas échéant) ;
// seul un administrateur peut installer une nouvelle clé.
app.get('/api/license/status', requireAuth, (req, res) => {
  res.json(license.getLicenseStatus(db));
});
app.put('/api/license', requireAdmin, (req, res) => {
  const { key } = req.body || {};
  if(!key || typeof key !== 'string' || !key.trim()) return res.status(400).json({ error: 'Clé de licence requise.' });
  const result = license.verifyLicenseString(key.trim());
  if(!result.ok) return res.status(400).json({ error: result.error });
  if(result.expired) return res.status(400).json({ error: `Cette licence a déjà expiré le ${new Date(result.payload.expiresAt).toLocaleDateString('fr-FR')}.` });
  license.setStoredLicenseString(db, key.trim());
  res.json({ ok: true, status: license.getLicenseStatus(db) });
});

// ---------------- Gestion des comptes (authentifié) ----------------
app.get('/api/users', requireAuth, requireLicense, (req, res) => {
  res.json({ users: auth.listUsers(db) });
});
app.post('/api/users', requireAdmin, requireLicense, (req, res) => {
  const { username, password, role } = req.body || {};
  if(!username || !username.trim()) return res.status(400).json({ error: "Identifiant requis." });
  if(!password || password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  if(auth.findUserByUsername(db, username.trim())) return res.status(409).json({ error: 'Cet identifiant existe déjà.' });
  try{
    auth.createUser(db, username.trim(), password, role);
    res.json({ ok: true });
  }catch(e){ res.status(500).json({ error: "Impossible de créer ce compte." }); }
});
app.put('/api/users/:id/password', requireAuth, requireLicense, (req, res) => {
  const { password } = req.body || {};
  const targetId = Number(req.params.id);
  const isSelf = req.session.userId === targetId;
  if(!isSelf){
    const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
    if(!me || me.role !== 'admin') return res.status(403).json({ error: "Vous ne pouvez modifier que votre propre mot de passe." });
  }
  if(!password || password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  auth.updateUserPassword(db, targetId, password);
  res.json({ ok: true });
});
app.put('/api/users/:id/role', requireAdmin, requireLicense, (req, res) => {
  const { role } = req.body || {};
  const result = auth.updateUserRole(db, Number(req.params.id), role);
  if(!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});
app.put('/api/users/:id/email', requireAuth, requireLicense, (req, res) => {
  const targetId = Number(req.params.id);
  const isSelf = req.session.userId === targetId;
  if(!isSelf){
    const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
    if(!me || me.role !== 'admin') return res.status(403).json({ error: "Vous ne pouvez modifier que votre propre adresse e-mail." });
  }
  const { email } = req.body || {};
  auth.updateUserEmail(db, targetId, email);
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireAdmin, requireLicense, (req, res) => {
  const total = auth.listUsers(db).length;
  if(total <= 1) return res.status(400).json({ error: 'Impossible de supprimer le dernier compte restant.' });
  const result = auth.deleteUser(db, Number(req.params.id));
  if(!result.ok) return res.status(400).json({ error: result.error });
  // Si l'utilisateur se supprime lui-même, on ferme aussi sa session en cours.
  if(req.session.userId === Number(req.params.id)){
    return req.session.destroy(() => res.json({ ok: true, selfDeleted: true }));
  }
  res.json({ ok: true });
});

// ---------------- Notifications e-mail (congés) ----------------
app.post('/api/notify-admins', requireAuth, requireLicense, async (req, res) => {
  const { subject, text } = req.body || {};
  if(!subject || !text) return res.status(400).json({ error: 'Sujet et texte requis.' });
  const admins = db.prepare("SELECT email FROM users WHERE role='admin' AND email IS NOT NULL AND email != ''").all();
  let sent = 0;
  for(const a of admins){
    const r = await sendNotificationEmail(a.email, subject, text);
    if(r.ok) sent++;
  }
  res.json({ ok: true, sent, total: admins.length });
});
app.post('/api/notify-user/:id', requireAdmin, requireLicense, async (req, res) => {
  const { subject, text } = req.body || {};
  if(!subject || !text) return res.status(400).json({ error: 'Sujet et texte requis.' });
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(Number(req.params.id));
  if(!user || !user.email) return res.json({ ok: true, sent: false, note: "Pas d'adresse e-mail pour ce compte." });
  const r = await sendNotificationEmail(user.email, subject, text);
  res.json({ ok: r.ok, sent: r.ok, error: r.error });
});

// Renvoie l'état courant du planning et sa version
app.get('/api/state', requireAuth, requireLicense, (req, res) => {
  const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
  res.json({ data: JSON.parse(row.data), version: row.version, appVersion: APP_VERSION });
});

// Enregistre un nouvel état, avec verrouillage optimiste sur la version
app.put('/api/state', requireAuth, requireLicense, (req, res) => {
  const { data, expectedVersion } = req.body || {};
  if(data === undefined || expectedVersion === undefined){
    return res.status(400).json({ error: 'Champs manquants (data, expectedVersion).' });
  }
  const row = db.prepare('SELECT version, data FROM app_state WHERE id = 1').get();
  if(row.version !== expectedVersion){
    // Quelqu'un d'autre a déjà enregistré depuis : on refuse et on renvoie la version à jour
    return res.status(409).json({ conflict: true, data: JSON.parse(row.data), version: row.version });
  }
  const newVersion = row.version + 1;
  db.prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(data), newVersion, nowIso());
  res.json({ version: newVersion });
});

// ---------------- Historique des sessions (voir sessionHistory.js) ----------------
// Reçoit les sessions qu'un client vient de purger de app_state (pièce terminée) pour les
// conserver indéfiniment sans jamais alourdir l'état synchronisé à chaque poll. Idempotent
// (INSERT OR IGNORE sur un index unique) : un même lot renvoyé deux fois (deux onglets, un
// échec réseau retenté) ne crée jamais de doublon.
app.post('/api/session-history', requireAuth, requireLicense, (req, res) => {
  const { entries } = req.body || {};
  if(!Array.isArray(entries)) return res.status(400).json({ error: 'Champ "entries" (tableau) requis.' });
  const inserted = sessionHistory.insertSessionHistoryBatch(db, entries);
  res.json({ ok: true, inserted });
});
// Détail archivé d'une pièce précise — consulté à la demande (pop-up "Détail des horaires" sur
// une tâche dont les sessions ont déjà été purgées de app_state), jamais chargé en masse.
app.get('/api/session-history/:cid/:oid', requireAuth, requireLicense, (req, res) => {
  const rows = sessionHistory.getSessionHistoryForPiece(db, req.params.cid, req.params.oid);
  res.json({ entries: rows });
});
// Fiche salarié : séances archivées d'une personne sur une période ([from, to[, "AAAA-MM-JJTHH:mm").
// Même niveau d'accès que la route par pièce ci-dessus (tout compte connecté) : l'état synchronisé
// expose déjà à chacun les séances en cours de toute l'équipe, et un poste partagé peut cibler
// « Mon temps de production » sur une autre identité que le compte connecté (activeIdentityId) —
// la restriction « un employé ne voit que sa propre fiche » est appliquée par l'interface.
// Temps de production : séances archivées de toute l'équipe sur [from, to[ (même niveau d'accès).
app.get('/api/session-history-range', requireAuth, requireLicense, (req, res) => {
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const { from, to } = req.query || {};
  if(!re.test(String(from||'')) || !re.test(String(to||''))) return res.status(400).json({ error: 'Paramètres "from" et "to" (AAAA-MM-JJTHH:mm) requis.' });
  res.json({ entries: sessionHistory.getSessionHistoryRange(db, from, to) });
});
app.get('/api/session-history-user/:uid', requireAuth, requireLicense, (req, res) => {
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const { from, to } = req.query || {};
  if(!re.test(String(from||'')) || !re.test(String(to||''))) return res.status(400).json({ error: 'Paramètres "from" et "to" (AAAA-MM-JJTHH:mm) requis.' });
  const rows = sessionHistory.getSessionHistoryForUser(db, req.params.uid, from, to);
  const pieceIds = sessionHistory.getSessionHistoryPieceIdsForUser(db, req.params.uid);
  res.json({ entries: rows, pieceIds });
});

// ---------------- Historique des prévisions avant clôture (voir previsionHistory.js) ----------------
// Reçoit la dernière estimation du moteur (prévu) juste avant qu'une pièce soit passée Terminée,
// que le client vient de purger de app_state (voir archivePrevisionHistory). Même robustesse
// qu'/api/session-history : idempotent (INSERT OR IGNORE sur un index unique), un même lot renvoyé
// deux fois ne crée jamais de doublon.
app.post('/api/prevision-history', requireAuth, requireLicense, (req, res) => {
  const { entries } = req.body || {};
  if(!Array.isArray(entries)) return res.status(400).json({ error: 'Champ "entries" (tableau) requis.' });
  const inserted = previsionHistory.insertPrevisionHistoryBatch(db, entries);
  res.json({ ok: true, inserted });
});
app.get('/api/prevision-history/:cid/:oid', requireAuth, requireLicense, (req, res) => {
  const rows = previsionHistory.getPrevisionHistoryForPiece(db, req.params.cid, req.params.oid);
  res.json({ entries: rows });
});

// ---------------- Pointage présentiel (voir presence.js et CLAUDE.md) ----------------
function readConfigFromState(){
  try{ return (JSON.parse(db.prepare('SELECT data FROM app_state WHERE id = 1').get().data) || {}).config || {}; }
  catch(e){ return {}; }
}
function presenceConfig(){
  const cfg = readConfigFromState();
  return { actif: !!(cfg.modules && cfg.modules.presence), ...(cfg.presence || {}) };
}
function sessionRole(req){
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  return u ? u.role : 'employe';
}
function isSupervisorReq(req){ const r = sessionRole(req); return r === 'admin' || r === 'superviseur'; }
function requirePresence(req, res, next){
  if(!presenceConfig().actif) return res.status(403).json({ error: 'Le module Pointage présentiel est désactivé (Paramètres → Pointage présentiel).' });
  next();
}
function localDateKey(d){ return presence.localTs(d).slice(0, 10); }
function addDaysKey(key, n){ const d = new Date(key + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateKey(d); }
// Pointage depuis son propre appareil (sans code) : autorisé si le réglage « téléphone » est actif
// et que l'adresse vue par le serveur fait partie des réseaux de l'atelier (liste vide = partout).
function selfPunchCheck(req){
  const cfg = presenceConfig();
  if(cfg.telephone === false) return 'Le pointage depuis un téléphone ou un poste est désactivé (Paramètres → Pointage présentiel).';
  if(!presence.ipAllowed(req.ip, cfg.reseaux)) return `Pointage depuis votre appareil accepté uniquement sur le réseau de l'atelier (adresse vue : ${presence.normIp(req.ip)}).`;
  return null;
}

// Journée d'une date : pointages bruts (toutes lignes, y compris corrections et demandes) pour un
// superviseur ; pour un salarié, ses propres lignes et, pour les autres, seulement leur dernier
// pointage retenu (statut affiché par la borne) — jamais le détail de la journée d'un collègue.
app.get('/api/presence/day', requireAuth, requireLicense, requirePresence, (req, res) => {
  const date = presence.DATE_RE.test(String(req.query.date || '')) ? req.query.date : localDateKey(new Date());
  const me = String(req.session.userId);
  const sup = isSupervisorReq(req);
  const all = presence.getPunchesBetween(db, date + 'T00:00:00', date + 'T99');
  const byUser = {};
  presence.effectivePunches(all).forEach(p => { byUser[p.userId] = p; });
  const lastByUser = Object.values(byUser).map(p => ({ userId: p.userId, type: p.type, ts: p.ts }));
  // Journées précédentes (7 jours) restées ouvertes : arrivée sans départ.
  let openDays = [];
  if(sup){
    const prev = presence.effectivePunches(presence.getPunchesBetween(db, addDaysKey(date, -7) + 'T00:00:00', date + 'T00:00:00'));
    const lastOfDay = {};
    prev.forEach(p => { lastOfDay[p.userId + '|' + p.ts.slice(0, 10)] = p; });
    openDays = Object.values(lastOfDay).filter(p => p.type !== 'out').map(p => ({ userId: p.userId, day: p.ts.slice(0, 10), lastType: p.type, lastTs: p.ts }));
  }
  const pending = db.prepare("SELECT id FROM presence_punches WHERE status = 'a_valider' ORDER BY ts, id").all()
    .map(r => presence.getPunch(db, r.id)).filter(p => sup || p.userId === me);
  res.json({
    date, serverNow: presence.localTs(new Date()),
    punches: sup ? all : all.filter(p => p.userId === me),
    lastByUser, openDays, pending,
    pinUserIds: presence.usersWithPin(db),
    clientIp: presence.normIp(req.ip),
    selfPunchError: selfPunchCheck(req),
    timemoto: sup ? timemotoSummary() : null
  });
});
// Période [from, to] (jours inclus) : un superviseur peut viser n'importe qui (ou tout le monde),
// un salarié uniquement lui-même. Demandes en attente jointes pour la page Présence.
app.get('/api/presence/range', requireAuth, requireLicense, requirePresence, (req, res) => {
  const { from, to } = req.query || {};
  if(!presence.DATE_RE.test(String(from || '')) || !presence.DATE_RE.test(String(to || ''))) return res.status(400).json({ error: 'Paramètres "from" et "to" (AAAA-MM-JJ) requis.' });
  if(to < from) return res.status(400).json({ error: 'Période invalide.' });
  if((new Date(to) - new Date(from)) / 86400000 > 400) return res.status(400).json({ error: 'Période limitée à 400 jours.' });
  const sup = isSupervisorReq(req);
  const me = String(req.session.userId);
  const userId = sup ? (req.query.userId ? String(req.query.userId) : null) : me;
  const punches = presence.getPunchesBetween(db, from + 'T00:00:00', addDaysKey(to, 1) + 'T00:00:00', userId);
  const pendingRows = db.prepare("SELECT * FROM presence_punches WHERE status = 'a_valider' ORDER BY ts, id").all();
  const pending = pendingRows.map(r => presence.getPunch(db, r.id)).filter(p => sup || p.userId === me);
  res.json({ from, to, punches, pending });
});
app.post('/api/presence/punch', requireAuth, requireLicense, requirePresence, (req, res) => {
  const body = req.body || {};
  const me = String(req.session.userId);
  const target = String(body.userId || me);
  const type = String(body.type || '');
  if(!presence.PUNCH_TYPES.includes(type)) return res.status(400).json({ error: 'Type de pointage inconnu.' });
  if(!db.prepare('SELECT id FROM users WHERE id = ?').get(Number(target))) return res.status(404).json({ error: 'Salarié introuvable.' });
  let source;
  if(body.pin != null && String(body.pin) !== ''){
    const v = presence.verifyPin(db, target, body.pin);
    if(!v.ok) return res.status(403).json({ error: v.error });
    source = 'borne';
  } else {
    if(target !== me) return res.status(403).json({ error: 'Code de pointage requis.' });
    const err = selfPunchCheck(req);
    if(err) return res.status(403).json({ error: err });
    source = body.source === 'poste' ? 'poste' : 'mobile';
  }
  const ts = presence.localTs(new Date()); // heure du SERVEUR, jamais celle de l'appareil
  const last = presence.dayEffective(db, target, ts).slice(-1)[0];
  const err = presence.checkTransition(last, type);
  if(err) return res.status(409).json({ error: err, last: last || null });
  const punch = presence.insertPunch(db, { userId: target, type, ts, source, createdBy: me, ip: presence.normIp(req.ip) });
  res.json({ ok: true, punch });
});
// Correction : jamais une modification — une nouvelle ligne (ou une annulation), motif obligatoire.
// Superviseur : validée d'office. Salarié : pour lui seul, en attente de validation.
app.post('/api/presence/correction', requireAuth, requireLicense, requirePresence, (req, res) => {
  const body = req.body || {};
  const me = String(req.session.userId);
  const sup = isSupervisorReq(req);
  const target = String(body.userId || me);
  if(!sup && target !== me) return res.status(403).json({ error: 'Vous ne pouvez demander une correction que pour vous-même.' });
  const motif = String(body.motif || '').trim();
  if(!motif) return res.status(400).json({ error: 'Le motif est obligatoire.' });
  const type = String(body.type || '');
  let ts = String(body.ts || '');
  let cancelsId = null;
  if(type === 'cancel'){
    const orig = presence.getPunch(db, body.cancelsId);
    if(!orig || orig.userId !== target || orig.type === 'cancel') return res.status(400).json({ error: 'Pointage à annuler introuvable.' });
    ts = orig.ts; cancelsId = orig.id;
  } else {
    if(!presence.PUNCH_TYPES.includes(type)) return res.status(400).json({ error: 'Type de pointage inconnu.' });
    if(!presence.TS_RE.test(ts)) return res.status(400).json({ error: 'Heure invalide.' });
    if(presence.normTs(ts) > presence.localTs(new Date())) return res.status(400).json({ error: "Impossible d'ajouter un pointage dans le futur." });
  }
  const punch = presence.insertPunch(db, {
    userId: target, type, ts, source: 'manuel', createdBy: me, status: sup ? 'valide' : 'a_valider',
    cancelsId, motif, commentaire: String(body.commentaire || '').slice(0, 500), ip: presence.normIp(req.ip)
  });
  res.json({ ok: true, punch });
});
// Corrections en lot (superviseur) : changements de type, annulations et ajouts appliqués ensemble,
// en une transaction (voir presence.applyCorrections) — motif et commentaire communs.
const PUNCH_TYPE_LABELS_FR = { in: 'Arrivée', pause_start: 'Début de pause', pause_end: 'Fin de pause', out: 'Départ' };
app.post('/api/presence/correction/batch', requireAuth, requireLicense, requirePresence, (req, res) => {
  if(!isSupervisorReq(req)) return res.status(403).json({ error: 'Réservé aux superviseurs.' });
  const body = req.body || {};
  const motif = String(body.motif || '').trim();
  if(!motif) return res.status(400).json({ error: 'Le motif est obligatoire.' });
  const target = String(body.userId || '');
  if(!db.prepare('SELECT id FROM users WHERE id = ?').get(Number(target))) return res.status(404).json({ error: 'Salarié introuvable.' });
  const r = presence.applyCorrections(db, {
    userId: target, ops: body.ops, motif, commentaire: String(body.commentaire || '').slice(0, 300),
    createdBy: String(req.session.userId), ip: presence.normIp(req.ip), typeLabels: PUNCH_TYPE_LABELS_FR
  });
  if(!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.post('/api/presence/decide', requireAuth, requireLicense, requirePresence, (req, res) => {
  if(!isSupervisorReq(req)) return res.status(403).json({ error: 'Réservé aux superviseurs.' });
  const { id, decision } = req.body || {};
  const r = presence.decidePunch(db, id, decision, req.session.userId);
  if(!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});
// Code de pointage : chacun définit le sien ; un superviseur peut effacer celui de quelqu'un (oubli).
app.post('/api/presence/pin', requireAuth, requireLicense, (req, res) => {
  const r = presence.setPin(db, req.session.userId, (req.body || {}).pin);
  if(!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});
app.post('/api/presence/pin/clear', requireAuth, requireLicense, (req, res) => {
  const target = String((req.body || {}).userId || req.session.userId);
  if(target !== String(req.session.userId) && !isSupervisorReq(req)) return res.status(403).json({ error: 'Réservé aux superviseurs.' });
  presence.clearPin(db, target);
  res.json({ ok: true });
});
// ---------- Pointeuse TimeMoto TM-616 (voir timemotoSync.js et CLAUDE.md) ----------
function readStateFull(){
  try{ return JSON.parse(db.prepare('SELECT data FROM app_state WHERE id = 1').get().data) || {}; }
  catch(e){ return {}; }
}
// Résumé pour la page Présence (superviseurs) : uniquement l'état du dernier import.
function timemotoSummary(){
  const tm = presenceConfig().timemoto || {};
  if(!tm.actif) return { actif: false };
  const s = timemoto.status(db);
  return { actif: true, lastOkAt: s.lastOkAt, lastImportTo: s.lastImportTo, nFlagged: timemoto.flaggedCount(db) };
}
app.get('/api/presence/timemoto/status', requireAuth, requireLicense, requirePresence, (req, res) => {
  if(!isSupervisorReq(req)) return res.status(403).json({ error: 'Réservé aux superviseurs.' });
  res.json(timemoto.status(db, readStateFull()));
});
// Pointages manquants probables d'une journée (pop-up de correction) : entrées écartées à l'import,
// enchaînements incohérents, journée passée sans départ — voir presence.suggestMissing. Un superviseur
// peut interroger n'importe qui ; un salarié UNIQUEMENT lui-même (l'identifiant demandé est ignoré et
// remplacé par celui de sa session : jamais le détail d'un collègue).
app.get('/api/presence/missing', requireAuth, requireLicense, requirePresence, (req, res) => {
  const userId = isSupervisorReq(req) ? String(req.query.userId || '') : String(req.session.userId || '');
  const date = String(req.query.date || '');
  if(!userId || !presence.DATE_RE.test(date)) return res.status(400).json({ error: 'Paramètres "userId" et "date" (AAAA-MM-JJ) requis.' });
  const st = readStateFull();
  const punches = presence.effectivePunches(presence.getPunchesBetween(db, date + 'T00:00:00', date + 'T99', userId));
  const b = timemoto.expectedBoundsFor(st, userId, date);
  const hmOfDate = d => d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
  res.json({ suggestions: presence.suggestMissing({
    punches, ignored: timemoto.ignoredEventsFor(db, userId, date),
    expectedStart: b ? hmOfDate(b.start) : null, expectedEnd: b ? hmOfDate(b.end) : null,
    isPast: date < localDateKey(new Date())
  }) });
});
// Récupération d'une période à la demande par l'agent zk-sync (voir timemotoSync.js) : l'administrateur
// demande, l'agent répond au contact suivant (≤ 1 min) avec un aperçu, l'administrateur confirme.
app.post('/api/presence/timemoto/recover', requireAdmin, requireLicense, requirePresence, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || 'request');
  if(action === 'apply'){
    const r = timemoto.applyRecovery(db, readStateFull());
    if(!r.ok) return res.status(400).json({ error: r.error });
    return res.json({ ok: true, status: timemoto.status(db, readStateFull()) });
  }
  if(action === 'cancel'){ timemoto.cancelRecovery(db); return res.json({ ok: true, status: timemoto.status(db, readStateFull()) }); }
  const r = timemoto.requestRecovery(db, { from: b.from, to: b.to, by: req.session.userId });
  if(!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, status: timemoto.status(db, readStateFull()) });
});
// Journées dont le premier pointage de la pointeuse est une sortie : correction proposée (inverser
// entrées et sorties de la journée) ou ignorée, par un superviseur.
app.post('/api/presence/timemoto/flag', requireAuth, requireLicense, requirePresence, (req, res) => {
  if(!isSupervisorReq(req)) return res.status(403).json({ error: 'Réservé aux superviseurs.' });
  const b = req.body || {};
  try{
    const r = timemoto.applyFlagAction(db, readStateFull(), String(b.key || ''), String(b.action || ''));
    res.json({ ok: true, result: r, status: timemoto.status(db, readStateFull()) });
  }catch(e){
    res.status(400).json({ error: String(e && e.message || e).slice(0, 200) });
  }
});
// Contrôle des doublons à la demande (voir presence.findDuplicates) — lecture seule.
app.get('/api/presence/duplicates', requireAuth, requireLicense, requirePresence, (req, res) => {
  if(!isSupervisorReq(req)) return res.status(403).json({ error: 'Réservé aux superviseurs.' });
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if(!presence.DATE_RE.test(from) || !presence.DATE_RE.test(to) || from > to) return res.status(400).json({ error: 'Période invalide.' });
  if((new Date(to) - new Date(from)) / 86400000 > 400) return res.status(400).json({ error: 'Période trop longue (400 jours maximum).' });
  res.json({ duplicates: presence.findDuplicates(db, from, to, Number(req.query.minutes) || 5) });
});
// Import déclenché par l'administrateur (pas d'automatisme : la connexion à TimeMoto passe par un
// reCAPTCHA que seul un humain franchit — voir timemotoSync.js). `token` est OBLIGATOIRE : le jeton
// que l'utilisateur a récupéré dans sa propre session TimeMoto, utilisé pour cette seule requête,
// jamais conservé ni journalisé. `dryRun` : aperçu sans rien enregistrer.
app.post('/api/presence/timemoto/sync', requireAdmin, requireLicense, requirePresence, async (req, res) => {
  const b = req.body || {};
  const token = typeof b.token === 'string' && b.token.trim() ? b.token : null;
  if(!token) return res.status(400).json({ error: 'Aucun jeton TimeMoto fourni. Récupérez-le depuis votre session TimeMoto (marque-page) et collez-le.' });
  if(token.length > 10000) return res.status(400).json({ error: 'Jeton invalide.' });
  if(b.since != null && b.since !== '' && !presence.DATE_RE.test(String(b.since))) return res.status(400).json({ error: 'Date de reprise invalide.' });
  const r = await timemoto.runSync(db, readStateFull(), { since: b.since || null, token, dryRun: !!b.dryRun });
  if(!r.ok) return res.status(502).json({ error: r.error, status: timemoto.status(db, readStateFull()) });
  res.json({ ok: true, result: r.result, status: timemoto.status(db, readStateFull()) });
});

// Import du CSV produit par tools/tm616_export.py (lecture directe de la pointeuse en réseau local,
// sans TimeMoto Cloud ni jeton). Même niveau d'accès que l'import cloud : administrateur.
app.post('/api/presence/timemoto/device-import', requireAdmin, requireLicense, requirePresence, (req, res) => {
  const b = req.body || {};
  if(typeof b.csv !== 'string' || !b.csv.trim()) return res.status(400).json({ error: 'Aucun fichier CSV fourni.' });
  if(b.since != null && b.since !== '' && !presence.DATE_RE.test(String(b.since))) return res.status(400).json({ error: 'Date de reprise invalide.' });
  const r = timemoto.runDeviceImport(db, readStateFull(), b.csv, { since: b.since || null, dryRun: !!b.dryRun });
  if(!r.ok) return res.status(400).json({ error: r.error, status: timemoto.status(db, readStateFull()) });
  res.json({ ok: true, result: r.result, status: timemoto.status(db, readStateFull()) });
});

// Lecture automatique de la pointeuse : le conteneur annexe `zk-sync` (tools/tm616_sync.py) envoie les
// événements lus en réseau local. Authentification MACHINE par clé partagée (DEVICE_SYNC_KEY, en-tête
// X-Device-Key) — aucune session. Désactivée tant que la variable est absente ou trop courte (< 16
// caractères). Comparaison en temps constant, blocage 5 min par adresse après 10 clés fausses.
const DEVICE_KEY = String(process.env.DEVICE_SYNC_KEY || '').trim();
const deviceKeyHash = DEVICE_KEY.length >= 16 ? crypto.createHash('sha256').update(DEVICE_KEY).digest() : null;
const deviceKeyFailures = new Map();
function deviceKeyOk(req){
  if(!deviceKeyHash) return false;
  const got = crypto.createHash('sha256').update(String(req.get('x-device-key') || '')).digest();
  return crypto.timingSafeEqual(got, deviceKeyHash);
}
app.post('/api/presence/device-sync', requireLicense, requirePresence, (req, res) => {
  const ip = req.ip || 'unknown';
  if(!deviceKeyHash) return res.status(503).json({ error: 'Lecture automatique non configurée (variable DEVICE_SYNC_KEY absente ou de moins de 16 caractères).' });
  const f = deviceKeyFailures.get(ip);
  if(f && f.until > Date.now()) return res.status(429).json({ error: 'Trop de tentatives — réessayez dans quelques minutes.' });
  if(!deviceKeyOk(req)){
    const n = ((f && f.n) || 0) + 1;
    deviceKeyFailures.set(ip, { n, until: n >= 10 ? Date.now() + 5 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Clé invalide.' });
  }
  deviceKeyFailures.delete(ip);
  const tm = presenceConfig().timemoto || {};
  if(!tm.actif) return res.status(403).json({ error: 'Le suivi TimeMoto est désactivé (page Présence → TimeMoto → case d\'activation).' });
  const r = timemoto.runDeviceEvents(db, readStateFull(), req.body || {}, {});
  if(!r.ok) return res.status(r.busy ? 409 : 400).json({ error: r.error });
  res.json(r);
});

// Sortie du mode borne : mot de passe du compte connecté sur la tablette.
app.post('/api/presence/verify-password', requireAuth, requireLicense, (req, res) => {
  const ip = req.ip || 'unknown';
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if(!user) return res.status(401).json({ error: 'Session invalide.' });
  if(auth.isLocked(ip, user.username)) return res.status(429).json({ error: 'Trop de tentatives — réessayez dans quelques minutes.' });
  if(!auth.verifyPassword(user, String((req.body || {}).password || ''))){
    auth.registerFailure(ip, user.username);
    return res.status(403).json({ error: 'Mot de passe incorrect.' });
  }
  auth.registerSuccess(ip, user.username);
  res.json({ ok: true });
});

// Identité visuelle (titre, logo, mention de copyright) — publique, car l'écran de connexion
// s'affiche avant toute authentification. N'expose volontairement rien d'autre de l'état.
app.get('/api/branding', (req, res) => {
  try{
    const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get();
    const cfg = (JSON.parse(row.data) || {}).config || {};
    res.json({
      appTitle: cfg.appTitle || 'Planning Atelier',
      logoDataUrl: cfg.logoDataUrl || null,
      copyright: cfg.copyright || ''
    });
  }catch(e){
    res.json({ appTitle: 'Planning Atelier', logoDataUrl: null, copyright: '' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Déclenche une sauvegarde immédiate (bouton "Tester l'envoi maintenant" de la pop-up Paramètres)
app.post('/api/backup/test', requireAuth, requireLicense, async (req, res) => {
  const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get();
  const data = JSON.parse(row.data);
  // Ajouté seulement sur cette copie en mémoire, pour la sauvegarde — jamais réenregistré dans
  // app_state (l'historique des sessions et des prévisions reste hors du blob synchronisé à chaque poll).
  data.sessionHistory = sessionHistory.getAllSessionHistory(db);
  data.previsionHistory = previsionHistory.getAllPrevisionHistory(db);
  data.presencePunches = presence.getAllPunches(db);
  const backupConfig = (data.config && data.config.backup) || {};
  const result = await runBackup(data, backupConfig);
  if(result.ok) return res.json({ ok: true });
  res.status(500).json({ ok: false, error: result.error });
});

app.get('/api/backup/status', requireAuth, requireLicense, (req, res) => {
  res.json({ smtpConfigured: hasSmtpConfig() });
});

// Déclenche un rapport immédiat (bouton "Tester l'envoi maintenant" de la section "Rapports par
// e-mail") — voir reportEmail.js/CLAUDE.md « Alertes e-mail ». Même configuration SMTP que la
// sauvegarde automatique (Cfg_backup.yml, via sendNotificationEmail).
app.post('/api/report/test', requireAuth, requireLicense, async (req, res) => {
  const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get();
  const data = JSON.parse(row.data);
  const cfg = (data.config && data.config.emailReport) || {};
  if(!cfg.destinataires) return res.status(500).json({ ok:false, error:'Aucune adresse destinataire configurée.' });
  const now = new Date();
  const isHebdo = cfg.frequence === 'hebdomadaire';
  const since = new Date(now.getTime() - (isHebdo ? 7 : 1) * 86400000);
  const text = reportEmail.buildReportText(data, now, since, isHebdo ? 'hebdomadaire' : 'quotidien');
  const result = await sendNotificationEmail(cfg.destinataires, `Rapport Planning Atelier — ${now.toLocaleDateString('fr-FR')}`, text);
  if(result.ok) return res.json({ ok: true });
  res.status(500).json({ ok: false, error: result.error });
});

// Planificateur : vérifie chaque minute si l'heure de sauvegarde configurée est atteinte.
function todayStr(){ return new Date().toISOString().slice(0,10); }
async function checkScheduledBackup(){
  try{
    const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
    const data = JSON.parse(row.data);
    const backupConfig = data.config && data.config.backup;
    if(!backupConfig || !backupConfig.actif || !backupConfig.destinataire) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if(hhmm !== backupConfig.heure) return;
    if(backupConfig.dernierEnvoi === todayStr()) return; // déjà envoyée aujourd'hui

    console.log('Sauvegarde automatique programmée : envoi en cours...');
    data.sessionHistory = sessionHistory.getAllSessionHistory(db); // idem : copie en mémoire uniquement, voir /api/backup/test
    data.previsionHistory = previsionHistory.getAllPrevisionHistory(db); // idem
    data.presencePunches = presence.getAllPunches(db); // idem (pointage présentiel, voir presence.js)
    const result = await runBackup(data, backupConfig);
    if(result.ok){
      console.log('Sauvegarde automatique envoyée avec succès à', backupConfig.destinataire);
    } else {
      console.error('Échec de la sauvegarde automatique :', result.error);
    }
    // On marque la tentative comme faite pour aujourd'hui dans tous les cas (succès ou échec),
    // pour ne pas boucler sur une erreur de configuration toutes les minutes.
    const current = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
    const currentData = JSON.parse(current.data);
    if(currentData.config && currentData.config.backup){
      currentData.config.backup.dernierEnvoi = todayStr();
      db.prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(currentData), current.version + 1, nowIso());
    }
  }catch(err){
    console.error('Erreur du planificateur de sauvegarde :', err);
  }
}
setInterval(checkScheduledBackup, 60000);

// Planificateur du rapport par e-mail (quotidien/hebdomadaire) — voir reportEmail.js/CLAUDE.md
// « Alertes e-mail ». Même structure que checkScheduledBackup ci-dessus (relecture/réécriture
// synchrones via better-sqlite3, marquage de dernierEnvoi dans tous les cas pour ne pas boucler
// toutes les minutes sur une configuration invalide).
async function checkScheduledEmailReport(){
  try{
    const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
    const data = JSON.parse(row.data);
    const cfg = data.config && data.config.emailReport;
    if(!cfg || !cfg.actif || !cfg.destinataires) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if(hhmm !== cfg.heure) return;
    const isHebdo = cfg.frequence === 'hebdomadaire';
    if(isHebdo && now.getDay() !== Number(cfg.jourSemaine)) return; // pas le bon jour de la semaine
    if(cfg.dernierEnvoi === todayStr()) return; // déjà envoyé aujourd'hui

    console.log('Rapport automatique programmé : envoi en cours...');
    const since = new Date(now.getTime() - (isHebdo ? 7 : 1) * 86400000);
    const text = reportEmail.buildReportText(data, now, since, isHebdo ? 'hebdomadaire' : 'quotidien');
    const result = await sendNotificationEmail(cfg.destinataires, `Rapport Planning Atelier — ${now.toLocaleDateString('fr-FR')}`, text);
    if(result.ok){
      console.log('Rapport automatique envoyé avec succès à', cfg.destinataires);
    } else {
      console.error('Échec du rapport automatique :', result.error);
    }
    const current = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
    const currentData = JSON.parse(current.data);
    if(currentData.config && currentData.config.emailReport){
      currentData.config.emailReport.dernierEnvoi = todayStr();
      db.prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(currentData), current.version + 1, nowIso());
    }
  }catch(err){
    console.error('Erreur du planificateur de rapport par e-mail :', err);
  }
}
setInterval(checkScheduledEmailReport, 60000);

// Reprise automatique de pause déjeuner, même sans personne devant l'appli dans un navigateur (voir
// autoPauseResume.js, portage volontairement dupliqué de la même logique côté client). Jusqu'ici,
// ce contrôle ne s'exécutait que dans la boucle de 60s du client (public/index.html, startApp) : une
// pause commencée en fin de journée, sans personne connectée ensuite, n'était constatée reprise qu'à
// la prochaine connexion — potentiellement des heures plus tard, avec un horaire de reprise trompeur
// avant le correctif `autoPausedUntil` déjà en place (voir CLAUDE.md). Ce job tourne indépendamment
// de tout onglet ouvert, avec le même calcul horaire par personne (userLunch : horaire de début/fin
// et pause(s) propres à chacun).
function checkAutoPauseResume(){
  try{
    const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
    const data = JSON.parse(row.data);
    const now = new Date();
    // Départs pointés (module Pointage présentiel actif) : dernier pointage retenu d'hier/aujourd'hui, seulement
    // s'il s'agit d'un départ — voir autoPauseResume.applyDepartPause. Exécuté AVANT la pause « hors horaires »
    // pour que les séances soient fermées à l'heure réelle du départ plutôt qu'à celle du contrôle.
    let departs = null;
    if(data.config && data.config.modules && data.config.modules.presence){
      const today = localDateKey(now);
      const all = presence.getPunchesBetween(db, addDaysKey(today, -1) + 'T00:00:00', today + 'T99');
      const lastBy = {};
      presence.effectivePunches(all).forEach(p => { lastBy[p.userId] = p; });
      departs = {};
      Object.keys(lastBy).forEach(u => { if(lastBy[u].type === 'out') departs[u] = lastBy[u].ts.slice(0, 16); });
    }
    const c1 = autoPauseResume.applyDepartPause(data, now, departs);
    const c2 = autoPauseResume.applyAutoPauseResume(data, now);
    const changed = c1 || c2;
    if(!changed) return;
    // Entièrement synchrone (better-sqlite3) : aucune requête client ne peut s'intercaler entre
    // cette lecture et cette écriture, donc jamais de conflit de version pour CE job lui-même. Un
    // PUT client concurrent, lui, verra son expectedVersion périmé et recevra un 409 — déjà géré
    // côté client par silentSave()/saveStateWithReapply() (rechargement silencieux de la version
    // fraîche, jamais de perte de données), exactement comme pour la sauvegarde programmée ci-dessus.
    db.prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(data), row.version + 1, nowIso());
  }catch(err){
    console.error('Erreur du contrôle automatique de pause/reprise :', err);
  }
}
setInterval(checkAutoPauseResume, 60000);

// Pointage présentiel : purge de conservation (Paramètres → Pointage présentiel, 3 ans par défaut),
// vérifiée toutes les heures et au démarrage.
function checkPresencePurge(){
  try{
    const n = presence.purgeOlderThan(db, (readConfigFromState().presence || {}).conservationAns || 3);
    if(n > 0) console.log(`Pointage présentiel : ${n} pointage(s) au-delà de la durée de conservation supprimé(s).`);
  }catch(e){ console.error('Purge du pointage présentiel impossible :', e.message); }
}
setInterval(checkPresencePurge, 3600 * 1000);
checkPresencePurge();

// Pas d'import TimeMoto automatique : la connexion au site passe par un reCAPTCHA que seul un humain
// franchit (voir timemotoSync.js). L'import est déclenché à la main par l'administrateur, avec un
// jeton qu'il récupère lui-même dans sa session TimeMoto — jamais un job de fond.

checkAutoPauseResume(); // vérifie aussi tout de suite au démarrage (redémarrage du conteneur), sans attendre 60s

// index.html jamais mis en cache sans revalidation : sans ça, un rechargement (manuel ou déclenché
// automatiquement par checkAppVersion() côté client) pourrait resservir la MÊME page déjà en cache
// du navigateur au lieu de récupérer le nouveau code déployé — exactement le piège qui obligeait
// jusqu'ici à un Ctrl+Maj+R (vidage forcé du cache) après chaque déploiement, voir CLAUDE.md.
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
function sendIndexHtmlNoCache(req, res){
  res.set('Cache-Control', 'no-cache');
  res.sendFile(INDEX_HTML_PATH);
}
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if(path.basename(filePath) === 'index.html') res.set('Cache-Control', 'no-cache');
  }
}));
app.get('*', sendIndexHtmlNoCache);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Planning atelier — serveur démarré sur http://0.0.0.0:${PORT}`);
  console.log(`Base de données : ${DB_PATH}`);
});
