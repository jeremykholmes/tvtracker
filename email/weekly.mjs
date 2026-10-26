// Weekly "new episodes to watch" email, run by .github/workflows/weekly-email.yml.
// For every account with an email address: finds episodes of their shows that aired in the past week and
// aren't checked off, and if there are any, emails them a list (sent through Resend).
//
// MODE: 'dry-run' sends nothing and writes nothing; 'test' emails only TEST_TO their own list;
//       'send' emails everyone (at most once every 6 days each).
// The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { SITE, mergeWatched, newEpisodes, buildEmail } from './digest.mjs';

const MODE = process.env.MODE || 'dry-run';
const TEST_TO = (process.env.TEST_TO || '').toLowerCase();
const FROM = 'TV Tracker <updates@tvtracker.us>';
const LOGIN_DOMAIN = '@members.tvtracker.us';   // made-up addresses of logins people make for others: can't receive mail
const DAY = 864e5;
if (!['dry-run', 'test', 'send'].includes(MODE)) throw new Error(`Unknown MODE ${MODE}`);
if (MODE === 'test' && !TEST_TO) throw new Error('MODE test needs TEST_TO');
if (MODE !== 'dry-run' && !process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const auth = getAuth(), db = getFirestore();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mask = email => email.replace(/^(.).*(@.*)$/, '$1***$2');

// TVmaze episodes, fetched once per show for the whole run. TVmaze allows about 20 requests per 10 seconds.
const episodes = new Map();
async function loadEpisodes(id) {
  if (episodes.has(id)) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(600);
    const r = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`);
    if (r.status === 429) { await sleep(5000); continue; }
    if (r.status === 404) { episodes.set(id, []); return; }
    if (!r.ok) throw new Error(`TVmaze ${r.status} for show ${id}`);
    episodes.set(id, await r.json()); return;
  }
  throw new Error(`TVmaze kept refusing show ${id}`);
}

async function send(to, mail, unsubscribeUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject: mail.subject, html: mail.html, text: mail.text,
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } })
    });
    if (r.ok) return;
    if (r.status === 429) { await sleep(2000); continue; }   // over Resend's rate limit
    throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  throw new Error('Resend kept refusing (rate limit)');
}

const users = [];
for (let page; ;) {
  const r = await auth.listUsers(1000, page);
  users.push(...r.users);
  if (!(page = r.pageToken)) break;
}

let sent = 0, skipped = 0, failed = 0, nothingNew = 0;
for (const u of users) {
  const email = (u.email || '').toLowerCase();
  if (!email || u.disabled || email.endsWith(LOGIN_DOMAIN)) continue;
  if (MODE === 'test' && email !== TEST_TO) continue;
  const who = `${mask(email)} (${u.uid.slice(0, 6)})`;
  try {
    const prefsRef = db.doc(`emailPrefs/${u.uid}`);
    const prefs = (await prefsRef.get()).data() || {};
    if (prefs.off) { skipped++; console.log(`${who}: switched off`); continue; }
    if (MODE === 'send' && prefs.lastSent > Date.now() - 6 * DAY) { skipped++; console.log(`${who}: already emailed this week`); continue; }

    const doc = (await db.doc(`users/${u.uid}`).get()).data();
    if (!doc || doc.listOf) continue;
    const shows = Object.entries(doc.shows || {}).filter(([, s]) => !s.removed && !s.later).map(([id, s]) => ({ id: +id, name: s.name || 'Untitled' }));
    if (!shows.length) { nothingNew++; continue; }
    const buckets = (await db.collection(`users/${u.uid}/watched`).get()).docs.map(d => d.data());
    const watched = mergeWatched(doc.watched, buckets);
    for (const s of shows) await loadEpisodes(s.id);
    const groups = newEpisodes(shows, id => episodes.get(id), watched);
    if (!groups.length) { nothingNew++; console.log(`${who}: nothing new`); continue; }

    const token = prefs.token || randomBytes(16).toString('hex');
    const unsubscribeUrl = `${SITE}/unsubscribe.html?u=${encodeURIComponent(u.uid)}&k=${token}`;
    const mail = buildEmail({ name: u.displayName || doc.profile?.name || '', groups, unsubscribeUrl });
    if (MODE === 'dry-run') { console.log(`${who}: would email ${mail.total} episode(s) from ${groups.length} show(s)`); continue; }

    if (!prefs.token) await prefsRef.set({ token }, { merge: true });   // before sending, so the link works
    await send(u.email, mail, unsubscribeUrl);
    if (MODE === 'send') await prefsRef.set({ lastSent: Date.now() }, { merge: true });
    sent++; console.log(`${who}: emailed ${mail.total} episode(s) from ${groups.length} show(s)`);
    await sleep(600);   // Resend allows 2 emails a second
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}

console.log(`\n${MODE}: ${sent} emailed, ${nothingNew} with nothing new, ${skipped} skipped, ${failed} failed, ${episodes.size} shows checked`);
if (MODE === 'test' && !sent && !failed) console.log(`No email went to ${mask(TEST_TO)}: that account has nothing new from the past week (or has the email switched off).`);
if (failed) process.exit(1);   // GitHub emails the repo owner when a scheduled run fails
