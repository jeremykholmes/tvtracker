// Sends the welcome email (email/welcome.mjs) once to each new account, run every 15 minutes by .github/workflows/welcome-email.yml.
// Each account is marked emailPrefs/{uid}.welcomed before its email goes out, so nobody gets it twice.
// Only accounts created in the last 2 days are emailed, so accounts from before this was switched on never get one.
// Skips logins made for someone else (made-up @members.tvtracker.us addresses), disabled and removed accounts.
// The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { welcomeEmail } from './welcome.mjs';

const FROM = 'TV Tracker <updates@tvtracker.us>';
const LOGIN_DOMAIN = '@members.tvtracker.us';
const RECENT = 2 * 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!process.env.RESEND_API_KEY) { console.log('RESEND_API_KEY is not set yet, so nothing is sent.'); process.exit(0); }
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const auth = getAuth(), db = getFirestore();

async function send(to, mail) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: mail.subject, html: mail.html, text: mail.text })
    });
    if (r.ok) return;
    if (r.status !== 429 && r.status < 500) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await sleep(2000 * (attempt + 1));
  }
  throw new Error('Resend kept failing');
}

const nameOf = async u => u.displayName || (await db.doc(`users/${u.uid}`).get()).data()?.profile?.name || '';

// MODE=test (Run workflow → test): emails TEST_TO a sample, whether or not it's a new account.
if (process.env.MODE === 'test') {
  const user = await auth.getUserByEmail((process.env.TEST_TO || '').toLowerCase());
  const mail = welcomeEmail(await nameOf(user));
  await send(user.email, { ...mail, subject: '[Test] ' + mail.subject });
  console.log('Test email sent to the site owner.');
  process.exit(0);
}

const fresh = [];
let page;
do {
  page = await auth.listUsers(1000, page?.pageToken);
  for (const u of page.users) if (Date.parse(u.metadata.creationTime) > Date.now() - RECENT) fresh.push(u);
} while (page.pageToken);

let sent = 0, skipped = 0, failed = 0;
for (const u of fresh) {
  const who = u.uid.slice(0, 6), email = (u.email || '').toLowerCase();
  try {
    const prefsRef = db.doc(`emailPrefs/${u.uid}`);
    if ((await prefsRef.get()).data()?.welcomed) continue;
    const removed = (await db.doc(`removals/${u.uid}`).get()).exists;
    if (!email || email.endsWith(LOGIN_DOMAIN) || u.disabled || removed) { skipped++; await prefsRef.set({ welcomed: true }, { merge: true }); continue; }
    const mail = welcomeEmail(await nameOf(u));
    await prefsRef.set({ welcomed: true }, { merge: true });   // marked first: a failed send is never repeated as a duplicate later
    await send(email, mail);
    sent++; console.log(`${who}: welcomed`);
    await sleep(600);
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}
console.log(`${sent} welcomed, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);
