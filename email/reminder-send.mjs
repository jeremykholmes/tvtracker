// Sends the one-time reminder (email/reminder.mjs) to accounts at least 2 weeks old that still haven't added a show or movie
// or checked off an episode. Run daily by .github/workflows/reminder-email.yml. Includes accounts from before this was switched on.
// Each account is marked emailPrefs/{uid}.reminded before its email goes out, so nobody gets it twice.
// Skips logins made for someone else (and anyone using another person's list), disabled and removed accounts, and anyone who
// switched emails off. The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { reminderEmail } from './reminder.mjs';

const FROM = 'TV Tracker <updates@tvtracker.us>';
const LOGIN_DOMAIN = '@members.tvtracker.us';
const AGE = 14 * 864e5;
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

// True once the account has a show or movie on its list (removed ones don't count) or any episode checked off.
async function active(uid, doc) {
  if (Object.values(doc.shows || {}).some(s => !s?.removed)) return true;
  if (Object.values(doc.movies || {}).some(m => !m?.removed)) return true;
  if (Object.values(doc.watched || {}).some(w => w?.w)) return true;
  for (const b of (await db.collection(`users/${uid}/watched`).get()).docs)
    if (Object.values(b.data().e || {}).some(w => w?.w)) return true;
  return false;
}

// MODE=test (Run workflow → test): emails TEST_TO a sample, whatever that account's list looks like.
if (process.env.MODE === 'test') {
  const user = await auth.getUserByEmail((process.env.TEST_TO || '').toLowerCase());
  const mail = reminderEmail(user.displayName || '');
  await send(user.email, { ...mail, subject: '[Test] ' + mail.subject });
  console.log('Test email sent to the site owner.');
  process.exit(0);
}

const users = [];
let page;
do { page = await auth.listUsers(1000, page?.pageToken); users.push(...page.users); } while (page.pageToken);

let sent = 0, skipped = 0, activeCount = 0, failed = 0;
for (const u of users) {
  const email = (u.email || '').toLowerCase(), who = u.uid.slice(0, 6);
  if (!email || u.disabled || email.endsWith(LOGIN_DOMAIN)) continue;
  if (Date.parse(u.metadata.creationTime) > Date.now() - AGE) continue;   // not two weeks old yet
  try {
    const prefsRef = db.doc(`emailPrefs/${u.uid}`), prefs = (await prefsRef.get()).data() || {};
    if (prefs.reminded) continue;
    if (prefs.off || (await db.doc(`removals/${u.uid}`).get()).exists) { skipped++; continue; }
    const doc = (await db.doc(`users/${u.uid}`).get()).data() || {};
    if (doc.listOf) { skipped++; continue; }   // uses someone else's list
    if (await active(u.uid, doc)) { activeCount++; await prefsRef.set({ reminded: true }, { merge: true }); continue; }   // never needs one
    const mail = reminderEmail(u.displayName || doc.profile?.name || '');
    await prefsRef.set({ reminded: true }, { merge: true });   // marked first: a failed send is never repeated as a duplicate later
    await send(email, mail);
    sent++; console.log(`${who}: reminded`);
    await sleep(600);
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}
console.log(`${sent} reminded, ${activeCount} already using it, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);
