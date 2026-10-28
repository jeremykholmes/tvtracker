// Emails people when a friend recommends a show to them, run every 15 minutes by .github/workflows/rec-email.yml.
// Recommendations live in users/{uid}/inbox/{id}; each one is emailed once and then marked emailed: true.
// Several waiting for the same person go in one email. Skips logins made for others (no real email address),
// anyone who switched these emails off (emailPrefs/{uid}.recsOff), and removed accounts.
// The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { SITE, buildRecEmail } from './digest.mjs';

const FROM = 'TV Tracker <updates@tvtracker.us>';
const LOGIN_DOMAIN = '@members.tvtracker.us';
const RECENT = 2 * 864e5;   // older recommendations are marked without emailing (e.g. ones from before this was switched on)
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!process.env.RESEND_API_KEY) { console.log('RESEND_API_KEY is not set yet, so nothing is sent (see "Recommendation emails" in README.md).'); process.exit(0); }
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const auth = getAuth(), db = getFirestore();

async function send(to, mail, unsubscribeUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: mail.subject, html: mail.html, text: mail.text, headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } })
    });
    if (r.ok) return;
    if (r.status === 429) { await sleep(2000); continue; }
    throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  throw new Error('Resend kept refusing (rate limit)');
}

const waiting = new Map();   // recipient uid -> inbox docs not emailed yet
for (const d of (await db.collectionGroup('inbox').get()).docs) {
  if (d.data().emailed || d.ref.parent.parent?.parent.id !== 'users') continue;
  const uid = d.ref.parent.parent.id;
  if (!waiting.has(uid)) waiting.set(uid, []);
  waiting.get(uid).push(d);
}

let sent = 0, skipped = 0, failed = 0;
for (const [uid, docs] of waiting) {
  const who = uid.slice(0, 6);
  const markAll = () => Promise.all(docs.map(d => d.ref.update({ emailed: true })));
  try {
    const fresh = docs.filter(d => (d.data().t || 0) > Date.now() - RECENT).sort((a, b) => b.data().t - a.data().t);
    const user = await auth.getUser(uid).catch(() => null);
    const email = (user?.email || '').toLowerCase();
    const prefsRef = db.doc(`emailPrefs/${uid}`), prefs = (await prefsRef.get()).data() || {};
    const removed = (await db.doc(`removals/${uid}`).get()).exists;
    if (!fresh.length || !email || user.disabled || email.endsWith(LOGIN_DOMAIN) || prefs.recsOff || removed) {
      skipped++; await markAll(); continue;
    }
    const token = prefs.token || randomBytes(16).toString('hex');
    if (!prefs.token) await prefsRef.set({ token }, { merge: true });   // before sending, so the link works
    const unsubscribeUrl = `${SITE}/unsubscribe.html?u=${encodeURIComponent(uid)}&k=${token}&e=recs`;
    const profile = (await db.doc(`users/${uid}`).get()).data()?.profile || {};
    const mail = buildRecEmail({ name: user.displayName || profile.name || '', items: fresh.map(d => d.data()), unsubscribeUrl });
    await markAll();   // marked first: a failed send is never repeated as a duplicate later
    await send(user.email, mail, unsubscribeUrl);
    sent++; console.log(`${who}: emailed ${fresh.length} recommendation(s)`);
    await sleep(600);
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}
console.log(`${sent} emailed, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);
