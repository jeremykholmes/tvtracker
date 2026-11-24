// Sends the "it's been a while" email (email/away.mjs) to accounts that haven't been on TV Tracker in 30 days: no opening the
// site signed in, no show or movie added and no episode checked off. Run daily by .github/workflows/away-email.yml.
// Only accounts with shows on their list get it (an empty list gets the one-time reminder from reminder-send.mjs instead).
// At most once per stretch away: emailPrefs/{uid}.awaySent records when it went out, and nobody gets another until they've
// been back since then and stayed away for 30 days again.
// Skips logins made for someone else (and anyone using another person's list), disabled and removed accounts, and anyone who
// switched it off (emailPrefs.awayOff, from its unsubscribe link) or switched the weekly email off (emailPrefs.off).
// The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { SITE, airTime, mergeWatched } from './digest.mjs';
import { awayEmail, SAMPLE_SHOWS } from './away.mjs';

const FROM = 'TV Tracker <updates@tvtracker.us>';
const LOGIN_DOMAIN = '@members.tvtracker.us';
const AWAY = 30 * 864e5;
const MODE = process.env.MODE || 'send';   // test = send the site owner a sample; dry-run = count who'd get one, send nothing
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (MODE !== 'dry-run' && !process.env.RESEND_API_KEY) { console.log('RESEND_API_KEY is not set yet, so nothing is sent.'); process.exit(0); }
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
    if (r.status !== 429 && r.status < 500) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await sleep(2000 * (attempt + 1));
  }
  throw new Error('Resend kept failing');
}

// TVmaze episodes, fetched once per show for the whole run (TVmaze allows about 20 requests per 10 seconds).
const episodes = new Map();
async function episodesOf(id) {
  if (episodes.has(id)) return episodes.get(id);
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(600);
    const r = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`);
    if (r.status === 429) { await sleep(5000); continue; }
    if (r.status === 404) { episodes.set(id, []); return []; }
    if (!r.ok) throw new Error(`TVmaze ${r.status} for show ${id}`);
    const eps = await r.json(); episodes.set(id, eps); return eps;
  }
  throw new Error(`TVmaze kept refusing show ${id}`);
}

const unsubLink = async (uid, prefs) => {
  const token = prefs.token || randomBytes(16).toString('hex');
  if (!prefs.token) await db.doc(`emailPrefs/${uid}`).set({ token }, { merge: true });   // before sending, so the link works
  return `${SITE}/unsubscribe.html?u=${encodeURIComponent(uid)}&k=${token}&e=away`;
};

// MODE=test (Run workflow → test): emails TEST_TO a sample with made-up shows.
if (MODE === 'test') {
  const user = await auth.getUserByEmail((process.env.TEST_TO || '').toLowerCase());
  const unsubscribeUrl = await unsubLink(user.uid, (await db.doc(`emailPrefs/${user.uid}`).get()).data() || {});
  const mail = awayEmail({ name: user.displayName || '', shows: SAMPLE_SHOWS, unsubscribeUrl });
  await send(user.email, { ...mail, subject: '[Test] ' + mail.subject }, unsubscribeUrl);
  console.log('Test email sent to the site owner.');
  process.exit(0);
}

const users = [];
let page;
do { page = await auth.listUsers(1000, page?.pageToken); users.push(...page.users); } while (page.pageToken);

const now = Date.now(), times = o => Object.values(o || {}).map(x => x?.t || 0);
let sent = 0, recent = 0, skipped = 0, failed = 0;
for (const u of users) {
  const email = (u.email || '').toLowerCase(), who = u.uid.slice(0, 6);
  if (!email || u.disabled || email.endsWith(LOGIN_DOMAIN)) continue;
  const signIns = [u.metadata.creationTime, u.metadata.lastSignInTime, u.metadata.lastRefreshTime].map(t => Date.parse(t) || 0);
  if (Math.max(...signIns) > now - AWAY) { recent++; continue; }   // signed up or used the site in the last 30 days
  try {
    const prefsRef = db.doc(`emailPrefs/${u.uid}`), prefs = (await prefsRef.get()).data() || {};
    if (prefs.off || prefs.awayOff || (await db.doc(`removals/${u.uid}`).get()).exists) { skipped++; continue; }
    const doc = (await db.doc(`users/${u.uid}`).get()).data() || {};
    if (doc.listOf) { skipped++; continue; }   // uses someone else's list
    const shows = Object.entries(doc.shows || {}).filter(([, s]) => s && !s.removed);
    if (!shows.length) { skipped++; continue; }   // empty list: the one-time reminder covers it
    const watched = mergeWatched(doc.watched, (await db.collection(`users/${u.uid}/watched`).get()).docs.map(d => d.data()));
    // Last time they did anything: opened the site signed in, signed in, added a show or movie, or checked off an episode.
    const last = Math.max(...signIns, doc.lastLogin || 0, ...times(doc.shows), ...times(doc.movies), ...times(watched));
    if (last > now - AWAY) { recent++; continue; }
    if ((prefs.awaySent || 0) > last) { skipped++; continue; }   // already sent one for this stretch away
    // Episodes of their shows (not the Future watch list) that aired since they were last on and aren't checked off.
    const list = [];
    for (const [id, s] of shows.filter(([, s]) => !s.later)) {
      const count = (await episodesOf(+id)).filter(e => e.number != null && !watched[e.id]?.w && airTime(e) > last && airTime(e) <= now).length;
      list.push({ id: +id, name: s.name || 'Untitled', image: s.image || '', network: s.network || '', count, t: s.t || 0 });
    }
    if (!list.some(s => s.count)) list.sort((a, b) => b.t - a.t);   // nothing new: their most recently added shows first
    if (!list.length) { skipped++; continue; }   // only Future watch list shows
    if (MODE === 'dry-run') { sent++; console.log(`${who}: would email (${list.reduce((n, s) => n + s.count, 0)} new episodes)`); continue; }
    const unsubscribeUrl = await unsubLink(u.uid, prefs);
    const mail = awayEmail({ name: u.displayName || doc.profile?.name || '', shows: list, unsubscribeUrl });
    await prefsRef.set({ awaySent: now }, { merge: true });   // marked first: a failed send is never repeated as a duplicate later
    await send(email, mail, unsubscribeUrl);
    sent++; console.log(`${who}: emailed`);
    await sleep(600);
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}
console.log(`${sent} ${MODE === 'dry-run' ? 'would be emailed' : 'emailed'}, ${recent} active in the last 30 days, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);
