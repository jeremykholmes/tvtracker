// Sends the "new season starting" email (email/seasons.mjs), run daily by .github/workflows/season-email.yml.
// For each account: shows on its list with at least one episode checked off whose next episode (from TVmaze) is the first
// episode of a later season, airing in the next 7 days. Several in one email. Each show's season is emailed once:
// emailPrefs/{uid}.seasonsSent = { showId: season } is updated before the email goes out, so nobody gets it twice.
// Skips logins made for someone else (and anyone using another person's list), disabled and removed accounts, and anyone who
// switched it off (emailPrefs.seasonsOff, from its unsubscribe link) or switched the weekly email off (emailPrefs.off).
// The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { SITE, airTime, mergeWatched } from './digest.mjs';
import { seasonsEmail, sampleShows, easternToday } from './seasons.mjs';

const FROM = 'TV Tracker <updates@tvtracker.us>';
const LOGIN_DOMAIN = '@members.tvtracker.us';
const AHEAD = 7 * 864e5;
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

// Each show's details and next episode from TVmaze, fetched once per show for the whole run (about 20 requests per 10 seconds allowed).
const shows = new Map();
async function showInfo(id) {
  if (shows.has(id)) return shows.get(id);
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(600);
    const r = await fetch(`https://api.tvmaze.com/shows/${id}?embed=nextepisode`);
    if (r.status === 429) { await sleep(5000); continue; }
    if (r.status === 404) { shows.set(id, null); return null; }
    if (!r.ok) throw new Error(`TVmaze ${r.status} for show ${id}`);
    const j = await r.json(); shows.set(id, j); return j;
  }
  throw new Error(`TVmaze kept refusing show ${id}`);
}

// A show's full episode list, also fetched once per show, only for shows with a premiere coming up.
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

// A premiere worth emailing about: the show's next episode is episode 1 of season 2 or later, airing in the next 7 days.
function premiere(info, now) {
  const e = info?._embedded?.nextepisode;
  if (!e || e.number !== 1 || !(e.season > 1)) return null;
  const t = airTime(e);
  return t >= now - 864e5 && t <= now + AHEAD ? e : null;   // a day back, in case it aired just before today's run
}

const unsubLink = async (uid, prefs) => {
  const token = prefs.token || randomBytes(16).toString('hex');
  if (!prefs.token) await db.doc(`emailPrefs/${uid}`).set({ token }, { merge: true });   // before sending, so the link works
  return `${SITE}/unsubscribe.html?u=${encodeURIComponent(uid)}&k=${token}&e=seasons`;
};

// MODE=test (Run workflow → test): emails TEST_TO a sample with made-up premieres.
if (MODE === 'test') {
  const user = await auth.getUserByEmail((process.env.TEST_TO || '').toLowerCase());
  const unsubscribeUrl = await unsubLink(user.uid, (await db.doc(`emailPrefs/${user.uid}`).get()).data() || {});
  const mail = seasonsEmail({ name: user.displayName || '', shows: sampleShows(), unsubscribeUrl });
  await send(user.email, { ...mail, subject: '[Test] ' + mail.subject }, unsubscribeUrl);
  console.log('Test email sent to the site owner.');
  process.exit(0);
}

const users = [];
let page;
do { page = await auth.listUsers(1000, page?.pageToken); users.push(...page.users); } while (page.pageToken);

const now = Date.now(), today = easternToday(now);
let sent = 0, nothing = 0, skipped = 0, failed = 0;
for (const u of users) {
  const email = (u.email || '').toLowerCase(), who = u.uid.slice(0, 6);
  if (!email || u.disabled || email.endsWith(LOGIN_DOMAIN)) continue;
  try {
    const prefsRef = db.doc(`emailPrefs/${u.uid}`), prefs = (await prefsRef.get()).data() || {};
    if (prefs.off || prefs.seasonsOff || (await db.doc(`removals/${u.uid}`).get()).exists) { skipped++; continue; }
    const doc = (await db.doc(`users/${u.uid}`).get()).data() || {};
    if (doc.listOf) { skipped++; continue; }   // uses someone else's list
    const onList = Object.entries(doc.shows || {}).filter(([, s]) => s && !s.removed && !s.later);
    if (!onList.length) { nothing++; continue; }
    // First the shows with a premiere coming up (one small TVmaze call per show), then, for just those, whether they've
    // checked off any of its episodes (that needs the show's full episode list).
    const found = [];
    for (const [id, s] of onList) {
      const info = await showInfo(+id), e = premiere(info, now);
      if (!e || (prefs.seasonsSent?.[id] || 0) >= e.season) continue;
      found.push({ id: +id, name: s.name || info.name, image: s.image || info.image?.medium || '', network: info.webChannel?.name || info.network?.name || s.network || '', season: e.season, airdate: e.airdate || '' });
    }
    if (!found.length) { nothing++; continue; }
    const watched = mergeWatched(doc.watched, (await db.collection(`users/${u.uid}/watched`).get()).docs.map(d => d.data()));
    const watchedShows = [];
    for (const s of found) if ((await episodesOf(s.id)).some(e => watched[e.id]?.w)) watchedShows.push(s);
    if (!watchedShows.length) { nothing++; continue; }
    watchedShows.sort((a, b) => a.airdate.localeCompare(b.airdate));
    if (MODE === 'dry-run') { sent++; console.log(`${who}: would email (${watchedShows.length} show(s))`); continue; }
    const unsubscribeUrl = await unsubLink(u.uid, prefs);
    const mail = seasonsEmail({ name: u.displayName || doc.profile?.name || '', shows: watchedShows, unsubscribeUrl, today });
    await prefsRef.set({ seasonsSent: Object.fromEntries(watchedShows.map(s => [String(s.id), s.season])) }, { merge: true });   // marked first: never a duplicate
    await send(email, mail, unsubscribeUrl);
    sent++; console.log(`${who}: emailed (${watchedShows.length} show(s))`);
    await sleep(600);
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}
console.log(`${sent} ${MODE === 'dry-run' ? 'would be emailed' : 'emailed'}, ${nothing} with no new seasons, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);
