// Publishes firestore.rules to the live database, run by .github/workflows/firestore-rules.yml.
// Uses the Firebase Admin SDK with the FIREBASE_SERVICE_ACCOUNT key (the same one the weekly email uses).
import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';
import { readFileSync } from 'node:fs';

let key;
try { key = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ''); }
catch { throw new Error("FIREBASE_SERVICE_ACCOUNT isn't valid JSON: paste the whole key file, from the first { to the last }."); }
if (key.type !== 'service_account' || !key.private_key) throw new Error("FIREBASE_SERVICE_ACCOUNT isn't a service account key file.");

initializeApp({ credential: cert(key) });
const source = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const ruleset = await getSecurityRules().releaseFirestoreRulesetFromSource(source);
console.log(`Published ruleset ${ruleset.name} to project ${key.project_id}`);
