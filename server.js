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

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'planning.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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
  res.json({ data: JSON.parse(row.data), version: row.version });
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
  const backupConfig = (data.config && data.config.backup) || {};
  const result = await runBackup(data, backupConfig);
  if(result.ok) return res.json({ ok: true });
  res.status(500).json({ ok: false, error: result.error });
});

app.get('/api/backup/status', requireAuth, requireLicense, (req, res) => {
  res.json({ smtpConfigured: hasSmtpConfig() });
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Planning atelier — serveur démarré sur http://0.0.0.0:${PORT}`);
  console.log(`Base de données : ${DB_PATH}`);
});
