// Sauvegarde COMPLÈTE et restauration (migration vers un nouveau NAS, reprise après sinistre).
//
// Pourquoi un format à part : l'export .json de l'application et la sauvegarde par e-mail ne contiennent
// que le planning (`app_state`) et ses historiques — jamais les comptes utilisateurs, alors que le
// planning les référence par leur numéro interne (`operatorUserId`, séances, pointages…). Restaurer
// un planning sans ses comptes casserait donc les attributions par salarié. Ce format ajoute les comptes
// (identifiants, mots de passe DÉJÀ chiffrés bcrypt, rôles, e-mails, codes de borne chiffrés) avec leurs
// numéros d'origine, la licence, et les tables de pointage/pointeuse en lignes brutes (ids conservés :
// `cancels_id` et `timemoto_punch_refs.punch_id` s'y réfèrent).
//
// ⚠ Le fichier produit est sensible (hachages de mots de passe, clé de licence) : seul un administrateur
// qui ressaisit son mot de passe peut l'obtenir (voir server.js).

const license = require('./license');

const FORMAT = 'planning-atelier-full';
const FORMAT_VERSION = 1;

// Tables restaurées en lignes brutes, dans l'ordre. Les colonnes sont celles de la table (PRAGMA) :
// jamais une clé venue du fichier n'est injectée dans une requête.
const RAW_TABLES = ['session_history', 'prevision_history', 'presence_punches', 'timemoto_punch_refs', 'timemoto_meta'];
const USER_COLUMNS = ['id', 'username', 'password_hash', 'created_at', 'role', 'email', 'presence_pin_hash'];

function tableColumns(db, table){
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}
function tableExists(db, table){
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function buildFullBackup(db, appVersion){
  const stateRow = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
  const userCols = USER_COLUMNS.filter(c => tableColumns(db, 'users').includes(c));
  const pkg = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: appVersion || null,
    exportedAt: new Date().toISOString(),
    state: JSON.parse(stateRow.data),
    stateVersion: stateRow.version,
    users: db.prepare(`SELECT ${userCols.join(', ')} FROM users ORDER BY id`).all(),
    license: null,
    tables: {}
  };
  try{ pkg.license = license.getStoredLicenseString(db) || null; }catch(e){ pkg.license = null; }
  RAW_TABLES.forEach(t => {
    pkg.tables[t] = tableExists(db, t) ? db.prepare(`SELECT * FROM ${t}`).all() : [];
  });
  return pkg;
}

// Installation « vierge » : personne n'a encore enregistré quoi que ce soit (la version de l'état n'a pas
// bougé depuis la création de la base), aucune commande, aucun historique, au plus le compte de départ.
// C'est la SEULE condition qui autorise un import sans être connecté (écran de connexion).
function isFreshInstall(db){
  try{
    const row = db.prepare('SELECT data, version FROM app_state WHERE id = 1').get();
    if(!row || row.version > 1) return false;
    const st = JSON.parse(row.data);
    if(Array.isArray(st.commandes) && st.commandes.length) return false;
    if(Array.isArray(st.commandesArchivees) && st.commandesArchivees.length) return false;
    if(db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 1) return false;
    for(const t of ['session_history', 'prevision_history', 'presence_punches']){
      if(tableExists(db, t) && db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n > 0) return false;
    }
    return true;
  }catch(e){ return false; }
}

function isPlanningState(st){
  return !!st && typeof st === 'object' && Array.isArray(st.machines) && Array.isArray(st.commandes);
}

// Reconnaît le format et renvoie une description sans rien écrire (aperçu côté client et validation).
// 'full'   : sauvegarde complète (comptes, licence, tables brutes).
// 'legacy' : export .json de l'appli ou sauvegarde par e-mail — planning (+ historiques) seulement.
function inspectBackup(parsed){
  if(!parsed || typeof parsed !== 'object') return { ok: false, error: 'Fichier illisible.' };
  if(parsed.format === FORMAT){
    if(!isPlanningState(parsed.state)) return { ok: false, error: 'Sauvegarde invalide : planning absent ou incomplet.' };
    if(!Array.isArray(parsed.users) || !parsed.users.length) return { ok: false, error: 'Sauvegarde invalide : aucun compte utilisateur.' };
    if(!parsed.users.some(u => u && u.role === 'admin')) return { ok: false, error: 'Sauvegarde invalide : aucun compte administrateur (la restauration vous enfermerait dehors).' };
    for(const u of parsed.users){
      if(!u || !Number.isInteger(Number(u.id)) || !u.username || !u.password_hash) return { ok: false, error: 'Sauvegarde invalide : compte utilisateur incomplet.' };
    }
    return { ok: true, kind: 'full', nbUsers: parsed.users.length, nbCommandes: parsed.state.commandes.length,
      hasLicense: !!parsed.license, exportedAt: parsed.exportedAt || null, appVersion: parsed.appVersion || null };
  }
  if(isPlanningState(parsed)){
    return { ok: true, kind: 'legacy', nbUsers: 0, nbCommandes: parsed.commandes.length, hasLicense: false, exportedAt: null, appVersion: null };
  }
  return { ok: false, error: 'Fichier invalide : ce n\'est ni une sauvegarde complète ni un export de planning.' };
}

function insertRows(db, table, rows){
  if(!Array.isArray(rows) || !rows.length) return 0;
  const cols = tableColumns(db, table);
  let n = 0;
  rows.forEach(r => {
    if(!r || typeof r !== 'object') return;
    const keys = cols.filter(c => Object.prototype.hasOwnProperty.call(r, c));
    if(!keys.length) return;
    const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`);
    stmt.run(...keys.map(k => {
      const v = r[k];
      return (v !== null && typeof v === 'object') ? JSON.stringify(v) : (v === undefined ? null : v);
    }));
    n++;
  });
  return n;
}

// Remplace TOUT le contenu par celui de la sauvegarde, en une seule transaction (tout ou rien).
// `nowIso` injecté pour rester testable. Ne touche jamais aux sessions HTTP (voir `epoch` dans server.js).
function restoreBackup(db, parsed, nowIso){
  const info = inspectBackup(parsed);
  if(!info.ok) return info;
  const now = nowIso || new Date().toISOString();
  const cur = db.prepare('SELECT version FROM app_state WHERE id = 1').get();
  const tx = db.transaction(() => {
    let state, histories = {};
    if(info.kind === 'full'){
      state = parsed.state;
      histories = parsed.tables || {};
    } else {
      // Export .json / e-mail : l'état et, pour l'e-mail, ses historiques, ajoutés à côté de l'état.
      state = { ...parsed };
      const sh = state.sessionHistory, ph = state.previsionHistory;
      delete state.sessionHistory; delete state.previsionHistory; delete state.presencePunches;
      histories = { session_history: Array.isArray(sh) ? sh : [], prevision_history: Array.isArray(ph) ? ph : [] };
    }
    // Version strictement supérieure à toute version déjà vue : un onglet encore ouvert reçoit un 409 et recharge.
    const baseVersion = info.kind === 'full' ? Number(parsed.stateVersion) || 0 : 0;
    const version = Math.max(cur ? cur.version : 0, baseVersion) + 1;
    db.prepare('UPDATE app_state SET data = ?, version = ?, updated_at = ? WHERE id = 1').run(JSON.stringify(state), version, now);

    if(info.kind === 'full'){
      db.prepare('DELETE FROM users').run();
      const userCols = tableColumns(db, 'users');
      parsed.users.forEach(u => {
        const keys = USER_COLUMNS.filter(c => userCols.includes(c) && Object.prototype.hasOwnProperty.call(u, c));
        const row = { ...u, created_at: u.created_at || now, role: u.role || 'employe' };
        db.prepare(`INSERT INTO users (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
          .run(...keys.map(k => (row[k] === undefined ? null : row[k])));
      });
      RAW_TABLES.forEach(t => { if(tableExists(db, t)) db.prepare(`DELETE FROM ${t}`).run(); });
      RAW_TABLES.forEach(t => { if(tableExists(db, t)) insertRows(db, t, histories[t]); });
      if(parsed.license){
        const v = license.verifyLicenseString(parsed.license);
        if(v.ok && !v.expired) license.setStoredLicenseString(db, parsed.license);
      }
    } else {
      ['session_history', 'prevision_history'].forEach(t => {
        if(!tableExists(db, t) || !histories[t].length) return;
        db.prepare(`DELETE FROM ${t}`).run();
        insertRows(db, t, histories[t].map(r => { const c = { ...r }; delete c.id; return c; }));
      });
    }
  });
  tx();
  return { ok: true, kind: info.kind, nbUsers: info.nbUsers, nbCommandes: info.nbCommandes, licenseRestored: info.kind === 'full' && info.hasLicense };
}

module.exports = { FORMAT, buildFullBackup, isFreshInstall, inspectBackup, restoreBackup };
