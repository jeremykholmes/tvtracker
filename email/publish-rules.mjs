// Publishes firestore.rules to the live database, run by .github/workflows/firestore-rules.yml.
// Uses the Firebase Admin SDK with the FIREBASE_SERVICE_ACCOUNT key (the same one the weekly email uses).
import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';
import { readFileSync } from 'node:fs';

// Reads the key, repairing common copy-paste damage (curly quotes, stray spaces, a pasted base64 copy).
// If it still isn't a key, says what's wrong without printing any of it (the repo's Actions logs are public).
function readKey(raw) {
  let t = raw.replace(/^﻿/, '').trim().replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'");
  if (t && !t.startsWith('{') && /^[A-Za-z0-9+/=\s]+$/.test(t)) t = Buffer.from(t, 'base64').toString('utf8').trim();
  try { return JSON.parse(t); }
  catch (e) {
    const opens = (t.match(/{/g) || []).length, closes = (t.match(/}/g) || []).length, hints = [];
    if (!t) hints.push('the secret is empty');
    else {
      if (!t.startsWith('{')) hints.push('it does not start with {');
      if (!t.endsWith('}')) hints.push('it does not end with } (it was probably cut off)');
      if (opens !== closes) hints.push(`it has ${opens} { but ${closes} }`);
      if (!t.includes('"private_key"')) hints.push('there is no "private_key" in it');
      else if (!t.includes('-----END PRIVATE KEY-----')) hints.push('the private key is cut short');
    }
    console.log(`Secret check: ${t.length} characters, ${t.split('\n').length} lines (a key file is about 2,300 characters).`);
    throw new Error(`FIREBASE_SERVICE_ACCOUNT isn't a valid key file: ${hints.join('; ') || 'its text is garbled'}. Paste the whole downloaded .json file again.`);
  }
}
const key = readKey(process.env.FIREBASE_SERVICE_ACCOUNT || '');
if (key.type !== 'service_account' || !key.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT is JSON but not a service account key file (it should contain "type": "service_account").');

initializeApp({ credential: cert(key) });
const source = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const ruleset = await getSecurityRules().releaseFirestoreRulesetFromSource(source);
console.log(`Published ruleset ${ruleset.name} to project ${key.project_id}`);
