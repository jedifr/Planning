const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const yaml = require('js-yaml');

// Nombre d'itérations de hachage — 10 est un bon compromis sécurité/performance pour bcrypt.
const SALT_ROUNDS = 10;
const ADMIN_CONFIG_PATH = process.env.ADMIN_CONFIG_PATH || path.join(__dirname, 'Cfg_admin.yml');

function initUsersTable(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employe',
      email TEXT
    );
  `);
  // Migration légère pour les bases créées avant l'ajout de ces colonnes.
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if(!cols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'employe'");
  if(!cols.includes('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT");
  if(!cols.includes('reset_token')) db.exec("ALTER TABLE users ADD COLUMN reset_token TEXT");
  if(!cols.includes('reset_token_expiry')) db.exec("ALTER TABLE users ADD COLUMN reset_token_expiry TEXT");

  // Garantit qu'il existe toujours au moins un administrateur. S'exécute à chaque démarrage (pas
  // seulement lors de l'ajout de la colonne) pour corriger aussi une base déjà migrée où personne
  // n'a encore ce rôle — le tout premier compte créé (le plus ancien) est alors promu.
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if(total > 0){
    const anyAdmin = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
    if(anyAdmin === 0){
      const first = db.prepare('SELECT id, username FROM users ORDER BY id ASC LIMIT 1').get();
      if(first){
        db.prepare("UPDATE users SET role='admin' WHERE id=?").run(first.id);
        console.log(`Aucun administrateur trouvé — le compte "${first.username}" (le plus ancien) a été promu Administrateur automatiquement.`);
      }
    }
  }
}

function randomPassword(len){
  // Alphabet sans caractères ambigus (0/O, 1/l/I) pour une saisie plus facile depuis un post-it.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for(let i=0;i<len;i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function loadAdminConfig(){
  try{
    const raw = fs.readFileSync(ADMIN_CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw) || {};
    const a = parsed.admin || {};
    return { username: String(a.username||'').trim(), password: String(a.password||'') };
  }catch(e){
    return { username:'', password:'' };
  }
}

// Crée le tout premier compte si la table est vide.
// Priorité 1 : identifiant/mot de passe choisis dans Cfg_admin.yml (si renseigné correctement).
// Priorité 2 (par défaut) : mot de passe généré aléatoirement, écrit une seule fois dans un fichier.
function bootstrapFirstUser(db, dataDir){
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if(count > 0) return null;

  const fromFile = loadAdminConfig();
  let username = 'admin';
  let password = null;
  let fromConfigFile = false;

  if(fromFile.password && fromFile.password.length >= 8 && fromFile.password.toLowerCase() !== 'changez-moi'){
    username = fromFile.username || 'admin';
    password = fromFile.password;
    fromConfigFile = true;
  } else {
    password = randomPassword(14);
  }

  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  db.prepare('INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)')
    .run(username, hash, new Date().toISOString(), 'admin');

  if(fromConfigFile){
    console.log('========================================================');
    console.log(` Premier compte créé depuis Cfg_admin.yml : ${username}`);
    console.log(' Pensez à remettre le mot de passe de Cfg_admin.yml à "changez-moi"');
    console.log(' une fois connecté, pour ne pas le laisser en clair sur le disque.');
    console.log('========================================================');
    return { username, password, source: 'fichier' };
  }

  const filePath = path.join(dataDir, 'PREMIER-MOT-DE-PASSE.txt');
  const content =
`Compte créé automatiquement au premier démarrage :

  Identifiant : ${username}
  Mot de passe : ${password}

Connectez-vous puis changez ce mot de passe (ou créez votre propre compte et
supprimez celui-ci) dans la pop-up Paramètres > Utilisateurs.

Astuce : pour choisir vous-même cet identifiant/mot de passe au lieu d'un mot de
passe généré, remplissez Cfg_admin.yml AVANT le premier démarrage.

Par sécurité, supprimez ce fichier une fois le mot de passe récupéré :
${filePath}
`;
  try{ fs.writeFileSync(filePath, content, 'utf8'); }catch(e){ /* non bloquant */ }
  console.log('========================================================');
  console.log(' Premier compte créé : ' + username + ' / ' + password);
  console.log(' (également écrit dans ' + filePath + ')');
  console.log('========================================================');
  return { username, password, source: 'genere' };
}

function findUserByUsername(db, username){
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}
function listUsers(db){
  return db.prepare('SELECT id, username, created_at, role, email FROM users ORDER BY username COLLATE NOCASE').all();
}
const VALID_ROLES = ['admin', 'superviseur', 'employe'];
function normalizeRole(role){ return VALID_ROLES.includes(role) ? role : 'employe'; }
function createUser(db, username, password, role){
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  db.prepare('INSERT INTO users (username, password_hash, created_at, role) VALUES (?, ?, ?, ?)')
    .run(username, hash, new Date().toISOString(), normalizeRole(role));
}
function deleteUser(db, id){
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if(target && target.role === 'admin' && countAdmins(db) <= 1){
    return { ok:false, error:'Impossible de supprimer le dernier compte administrateur restant.' };
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok:true };
}
function updateUserPassword(db, id, password){
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
}
function countAdmins(db){
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}
function updateUserRole(db, id, role){
  const nextRole = normalizeRole(role);
  const current = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if(!current) return { ok:false, error:'Compte introuvable.' };
  // Le rôle Superviseur n'est pas compté comme Administrateur : le retirer du dernier admin, même
  // pour le passer Superviseur, doit être bloqué comme n'importe quelle autre rétrogradation.
  if(current.role === 'admin' && nextRole !== 'admin' && countAdmins(db) <= 1){
    return { ok:false, error:"Impossible de retirer le rôle Administrateur au dernier compte administrateur restant." };
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextRole, id);
  return { ok:true };
}
function updateUserEmail(db, id, email){
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email ? email.trim() : null, id);
}
const RESET_TOKEN_MS = 60 * 60 * 1000; // 1 heure de validité
function createResetToken(db, userId){
  const token = crypto.randomBytes(32).toString('hex'); // 256 bits — impossible à deviner par force brute
  const expiry = new Date(Date.now() + RESET_TOKEN_MS).toISOString();
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?').run(token, expiry, userId);
  return token;
}
function findUserByResetToken(db, token){
  if(!token) return null;
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if(!user) return null;
  if(!user.reset_token_expiry || new Date(user.reset_token_expiry) < new Date()) return null; // expiré
  return user;
}
function clearResetToken(db, userId){
  db.prepare('UPDATE users SET reset_token = NULL, reset_token_expiry = NULL WHERE id = ?').run(userId);
}
function verifyPassword(user, password){
  if(!user) return false;
  return bcrypt.compareSync(password, user.password_hash);
}

// Limitation simple des tentatives de connexion, en mémoire, par IP + identifiant.
const attempts = new Map(); // clé -> { count, lockedUntil }
const MAX_ATTEMPTS = 6;
const LOCK_MS = 5 * 60 * 1000; // 5 minutes

function attemptKey(ip, username){ return ip + '|' + String(username||'').toLowerCase(); }

function isLocked(ip, username){
  const rec = attempts.get(attemptKey(ip, username));
  if(!rec) return false;
  if(rec.lockedUntil && rec.lockedUntil > Date.now()) return true;
  if(rec.lockedUntil && rec.lockedUntil <= Date.now()){ attempts.delete(attemptKey(ip, username)); return false; }
  return false;
}
function registerFailure(ip, username){
  const key = attemptKey(ip, username);
  const rec = attempts.get(key) || { count: 0, lockedUntil: null };
  rec.count += 1;
  if(rec.count >= MAX_ATTEMPTS) rec.lockedUntil = Date.now() + LOCK_MS;
  attempts.set(key, rec);
}
function registerSuccess(ip, username){
  attempts.delete(attemptKey(ip, username));
}

module.exports = {
  initUsersTable, bootstrapFirstUser, findUserByUsername, listUsers,
  createUser, deleteUser, updateUserPassword, verifyPassword,
  updateUserRole, updateUserEmail, countAdmins,
  createResetToken, findUserByResetToken, clearResetToken,
  isLocked, registerFailure, registerSuccess, LOCK_MS
};
