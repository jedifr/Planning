const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');
const nodemailer = require('nodemailer');

const SMTP_CONFIG_PATH = process.env.SMTP_CONFIG_PATH || path.join(__dirname, 'Cfg_backup.yml');

// Relit le fichier à chaque appel : un changement dans Cfg_backup.yml prend effet
// sans avoir besoin de redémarrer le conteneur.
function loadSmtpConfig(){
  try{
    const raw = fs.readFileSync(SMTP_CONFIG_PATH, 'utf8');
    const parsed = yaml.load(raw) || {};
    const smtp = parsed.smtp || {};
    return {
      host: smtp.host || '',
      port: Number(smtp.port || 587),
      secure: !!smtp.secure,
      requireTLS: !!smtp.requireTLS,
      user: smtp.user || '',
      pass: smtp.pass || '',
      from: smtp.from || smtp.user || ''
    };
  }catch(e){
    return { host:'', port:587, secure:false, requireTLS:false, user:'', pass:'', from:'' };
  }
}

function hasSmtpConfig(){
  const smtp = loadSmtpConfig();
  return !!(smtp.host && smtp.user && smtp.pass);
}

function buildTransport(smtp){
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,       // true = TLS chiffré dès la connexion (implicite)
    requireTLS: smtp.requireTLS, // true = connexion en clair puis STARTTLS obligatoire (refuse d'envoyer sinon)
    auth: { user: smtp.user, pass: smtp.pass }
  });
}

// Crée un zip (protégé par mot de passe si fourni) contenant le JSON de sauvegarde, via l'utilitaire système `zip`.
function createBackupZip(jsonData, password){
  return new Promise((resolve, reject) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-backup-'));
    const jsonPath = path.join(tmpDir, `planning-${stamp}.json`);
    const zipPath = path.join(tmpDir, `planning-${stamp}.zip`);
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf8');

    const args = ['-j']; // -j : ne pas conserver l'arborescence de dossiers dans le zip
    if(password && password.trim()){ args.push('-P', password); }
    args.push(zipPath, jsonPath);

    execFile('zip', args, (err) => {
      if(err){ reject(err); return; }
      resolve({ zipPath, tmpDir, filename: path.basename(zipPath) });
    });
  });
}

function cleanupTmp(tmpDir){
  try{ fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e){ /* silencieux */ }
}

// Effectue la sauvegarde complète : zip + envoi e-mail. Retourne { ok, error }.
async function runBackup(stateData, backupConfig){
  const smtp = loadSmtpConfig();
  if(!smtp.host || !smtp.user || !smtp.pass){
    return { ok: false, error: `Le serveur SMTP n'est pas configuré dans ${path.basename(SMTP_CONFIG_PATH)} (host / user / pass manquants).` };
  }
  if(!backupConfig || !backupConfig.destinataire){
    return { ok: false, error: 'Aucune adresse destinataire configurée.' };
  }
  let tmp;
  try{
    tmp = await createBackupZip(stateData, backupConfig.motDePasse);
    const transport = buildTransport(smtp);
    await transport.sendMail({
      from: smtp.from,
      to: backupConfig.destinataire,
      subject: `Sauvegarde Planning Atelier — ${new Date().toLocaleDateString('fr-FR')}`,
      text: backupConfig.motDePasse
        ? 'Sauvegarde automatique en pièce jointe (zip protégé par mot de passe).'
        : 'Sauvegarde automatique en pièce jointe.',
      attachments: [{ filename: tmp.filename, path: tmp.zipPath }]
    });
    return { ok: true };
  }catch(err){
    return { ok: false, error: err.message || String(err) };
  }finally{
    if(tmp) cleanupTmp(tmp.tmpDir);
  }
}

// Envoi générique d'e-mail simple (pas de pièce jointe), réutilisé pour les notifications
// (ex : demande de congé à valider) — même configuration SMTP que la sauvegarde automatique.
async function sendNotificationEmail(to, subject, text){
  const smtp = loadSmtpConfig();
  if(!smtp.host || !smtp.user || !smtp.pass || !to) return { ok:false, error:'SMTP non configuré ou destinataire manquant.' };
  try{
    const transport = buildTransport(smtp);
    await transport.sendMail({ from: smtp.from, to, subject, text });
    return { ok:true };
  }catch(err){
    return { ok:false, error: err.message || String(err) };
  }
}

module.exports = { runBackup, hasSmtpConfig, sendNotificationEmail };
