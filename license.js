const crypto = require('crypto');

// Clé PUBLIQUE Ed25519 : peut être diffusée sans risque, y compris dans ce dépôt — elle ne permet
// que de VÉRIFIER une licence, jamais d'en fabriquer une nouvelle. La clé PRIVÉE correspondante
// n'est connue que de l'éditeur (générée et conservée hors de ce dépôt par tools/generate-license.js,
// jamais committée). Sans cette clé privée, personne — y compris un client ayant un accès complet
// au NAS et au code source — ne peut créer une licence valide ou en prolonger une expirée.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAsbLuiKPAnFqpPJix+Na03MbBo6X+aHWX0X07gZLWYyk=
-----END PUBLIC KEY-----
`;

function initLicenseTable(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS license (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      key_string TEXT,
      updated_at TEXT
    );
  `);
}

function getStoredLicenseString(db){
  const row = db.prepare('SELECT key_string FROM license WHERE id = 1').get();
  return row ? row.key_string : null;
}

function setStoredLicenseString(db, keyString){
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO license (id, key_string, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET key_string = excluded.key_string, updated_at = excluded.updated_at
  `).run(keyString, now);
}

// Format d'une clé de licence : "<payload en base64url>.<signature en base64url>"
// payload JSON : { client, issuedAt, expiresAt } — signé par la clé privée de l'éditeur.
function verifyLicenseString(licenseStr){
  if(!licenseStr || typeof licenseStr !== 'string') return { ok:false, error:"Aucune licence installée." };
  const parts = licenseStr.trim().split('.');
  if(parts.length !== 2) return { ok:false, error:'Format de clé invalide.' };
  let payloadBuf, sigBuf;
  try{
    payloadBuf = Buffer.from(parts[0], 'base64url');
    sigBuf = Buffer.from(parts[1], 'base64url');
  }catch(e){
    return { ok:false, error:'Format de clé invalide.' };
  }
  let publicKey;
  try{
    publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
  }catch(e){
    return { ok:false, error:'Clé publique de vérification invalide (problème serveur).' };
  }
  let signatureValid = false;
  try{
    signatureValid = crypto.verify(null, payloadBuf, publicKey, sigBuf);
  }catch(e){
    return { ok:false, error:'Signature illisible.' };
  }
  if(!signatureValid) return { ok:false, error:"Signature invalide — cette clé a été altérée ou ne correspond pas à ce logiciel." };
  let payload;
  try{ payload = JSON.parse(payloadBuf.toString('utf8')); }catch(e){ return { ok:false, error:'Contenu de la clé illisible.' }; }
  const expiresAt = new Date(payload.expiresAt);
  if(!payload.expiresAt || isNaN(expiresAt.getTime())) return { ok:false, error:"Date d'expiration invalide." };
  return { ok:true, expired: expiresAt.getTime() < Date.now(), payload, expiresAt };
}

// État complet à afficher/exploiter côté appli — jamais d'exception, toujours un objet exploitable.
function getLicenseStatus(db){
  const stored = getStoredLicenseString(db);
  if(!stored){
    return { installed:false, valid:false, client:null, expiresAt:null, error:"Aucune licence installée." };
  }
  const result = verifyLicenseString(stored);
  if(!result.ok){
    return { installed:true, valid:false, client:null, expiresAt:null, error: result.error };
  }
  return {
    installed:true,
    valid: !result.expired,
    client: result.payload.client || null,
    expiresAt: result.payload.expiresAt,
    error: result.expired ? 'Cette licence a expiré.' : null
  };
}

// Middleware Express : bloque la route si aucune licence valide n'est installée.
function requireLicense(db){
  return (req, res, next) => {
    const status = getLicenseStatus(db);
    if(!status.valid){
      return res.status(403).json({ error: status.error || 'Licence invalide ou expirée.', licenseInvalid: true, licenseStatus: status });
    }
    next();
  };
}

module.exports = {
  initLicenseTable, getStoredLicenseString, setStoredLicenseString,
  verifyLicenseString, getLicenseStatus, requireLicense
};
