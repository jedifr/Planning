#!/usr/bin/env node
// Outil HORS-LIGNE de génération de clés de licence — usage strictement local (jamais côté client,
// jamais dans le conteneur Docker déployé). Il produit :
//   - au tout premier lancement, une paire de clés Ed25519 (license-private-key.pem, dans ce même
//     dossier, ignorée par git — voir .gitignore). C'est la seule chose au monde qui permette de
//     fabriquer une licence valide pour ce logiciel : à sauvegarder en lieu sûr, jamais à partager.
//   - à chaque lancement, une clé de licence signée pour un client et une durée donnés.
//
// Usage :
//   node tools/generate-license.js --client "Découpe H2O" --days 365
//   node tools/generate-license.js --client "Atelier Dupont" --expires 2027-01-01
//
// La clé produite se colle dans Planning Atelier > ⚙ Paramétrer > Licence (côté client).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRIVATE_KEY_PATH = path.join(__dirname, 'license-private-key.pem');

function ensurePrivateKeyPem(){
  if(fs.existsSync(PRIVATE_KEY_PATH)){
    return fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  }
  console.log("Aucune paire de clés trouvée — génération d'une nouvelle paire Ed25519...");
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type:'pkcs8', format:'pem' });
  const publicPem = publicKey.export({ type:'spki', format:'pem' });
  fs.writeFileSync(PRIVATE_KEY_PATH, privatePem, { mode: 0o600 });
  console.log('========================================================');
  console.log(' Nouvelle paire de clés générée.');
  console.log(` Clé privée écrite dans : ${PRIVATE_KEY_PATH}`);
  console.log(' ⚠ Sauvegardez ce fichier en lieu sûr (hors de ce dépôt) — sans lui, impossible de');
  console.log('   générer de nouvelles licences. Ne le committez jamais, ne le partagez jamais.');
  console.log(' La clé PUBLIQUE correspondante (déjà intégrée dans license.js) :');
  console.log('');
  console.log(publicPem);
  console.log('========================================================');
  return privatePem;
}

function parseArgs(argv){
  const out = {};
  for(let i=0; i<argv.length; i++){
    if(argv[i].startsWith('--')){
      const key = argv[i].slice(2);
      const hasValue = argv[i+1] !== undefined && !argv[i+1].startsWith('--');
      out[key] = hasValue ? argv[++i] : true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if(!args.client){
  console.error('Usage : node tools/generate-license.js --client "Nom du client" --days 365');
  console.error('    ou : node tools/generate-license.js --client "Nom du client" --expires AAAA-MM-JJ');
  process.exit(1);
}

let expiresAt;
if(args.expires){
  expiresAt = new Date(args.expires + 'T23:59:59');
} else if(args.days){
  expiresAt = new Date(Date.now() + Number(args.days) * 86400000);
} else {
  console.error('Précisez --days N (ex. --days 365) ou --expires AAAA-MM-JJ.');
  process.exit(1);
}
if(isNaN(expiresAt.getTime())){
  console.error("Date d'expiration invalide.");
  process.exit(1);
}

const privatePem = ensurePrivateKeyPem();
const privateKey = crypto.createPrivateKey(privatePem);

const payload = {
  client: args.client,
  issuedAt: new Date().toISOString(),
  expiresAt: expiresAt.toISOString()
};
const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = crypto.sign(null, payloadBuf, privateKey);
const licenseKey = `${payloadBuf.toString('base64url')}.${signature.toString('base64url')}`;

console.log('');
console.log(`Licence pour "${payload.client}", valable jusqu'au ${expiresAt.toLocaleDateString('fr-FR')} :`);
console.log('');
console.log(licenseKey);
console.log('');
