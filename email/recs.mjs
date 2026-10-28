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

// The inbox shows who it's from: "Sarah via TV Tracker" (one sender), or just "TV Tracker" for several.
function fromLine(senders = []) {
  const name = senders.length === 1 ? senders[0].replace(/["<>\\,;:@\r\n]/g, '').trim().slice(0, 60) : '';
  return name ? `"${name} via TV Tracker" <updates@tvtracker.us>` : FROM;
}
async function send(to, mail, unsubscribeUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(mail.senders), to, subject: mail.subject, html: mail.html, text: mail.text, headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } })
    });
    if (r.ok) return;
    if (r.status === 429) { await sleep(2000); continue; }
    throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  throw new Error('Resend kept refusing (rate limit)');
}

// The recommender's full name: the name saved with the recommendation, or their sign-in name (e.g. from Google)
// when that has more to it, so a recommendation saved as just "Sarah" still shows "Sarah Johnson".
const fullNames = new Map();
async function fullName(m) {
  if (!m.from) return m.fromName;
  if (!fullNames.has(m.from)) fullNames.set(m.from, (await auth.getUser(m.from).catch(() => null))?.displayName || '');
  const saved = (m.fromName || '').trim(), signIn = fullNames.get(m.from).trim();
  return signIn.split(/\s+/).length > saved.split(/\s+/).length && signIn.toLowerCase().startsWith(saved.toLowerCase().split(/\s+/)[0]) ? signIn : saved;
}

// MODE=test (Run workflow → test): emails TEST_TO a sample, built from that account's latest recommendation if it has one.
if (process.env.MODE === 'test') {
  const to = (process.env.TEST_TO || '').toLowerCase(), user = await auth.getUserByEmail(to);
  const latest = (await db.collection(`users/${user.uid}/inbox`).orderBy('t', 'desc').limit(1).get()).docs[0]?.data();
  if (latest) latest.fromName = await fullName(latest);
  const item = latest || { fromName: 'Sarah Johnson', note: 'This is a sample: real ones show the name of whoever recommended the show.', show: { id: 44933, name: 'Severance', image: 'https://static.tvmaze.com/uploads/images/medium_portrait/545/1364564.jpg', network: 'Apple TV+' } };
  const prefs = (await db.doc(`emailPrefs/${user.uid}`).get()).data() || {};
  const token = prefs.token || randomBytes(16).toString('hex');
  if (!prefs.token) await db.doc(`emailPrefs/${user.uid}`).set({ token }, { merge: true });
  const unsubscribeUrl = `${SITE}/unsubscribe.html?u=${encodeURIComponent(user.uid)}&k=${token}&e=recs`;
  const mail = buildRecEmail({ name: user.displayName || '', items: [item], unsubscribeUrl });
  await send(user.email, { ...mail, subject: '[Test] ' + mail.subject }, unsubscribeUrl);
  console.log('Test email sent to the site owner.');
  process.exit(0);
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
    const mail = buildRecEmail({ name: user.displayName || profile.name || '', items: await Promise.all(fresh.map(async d => ({ ...d.data(), fromName: await fullName(d.data()) }))), unsubscribeUrl });
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
