// Sends the welcome email (email/welcome.mjs) once to each new account, and a "new sign-up" note to the site owner (TEST_TO),
// run every 15 minutes by .github/workflows/welcome-email.yml.
// Each account is marked emailPrefs/{uid}.welcomed before its email goes out, so nobody gets it twice.
// Only accounts created in the last 2 days are emailed, so accounts from before this was switched on never get one.
// Skips logins made for someone else (made-up @members.tvtracker.us addresses), disabled and removed accounts.
// The repo is public, so its Actions logs are too: the log never shows anyone's email address.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { welcomeEmail } from './welcome.mjs';
import { SITE } from './digest.mjs';

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

// "New sign-up" note to the site owner (TEST_TO), sent alongside each new account's welcome email.
const OWNER = (process.env.TEST_TO || '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function signupNote(u, name, total) {
  const how = (u.providerData || []).some(p => p.providerId === 'google.com') ? 'Google' : 'Email and password';
  const when = new Date(u.metadata.creationTime).toLocaleString('en-US', { timeZone: 'America/Phoenix', dateStyle: 'medium', timeStyle: 'short' });
  const rows = [['Name', name || '(no name given)'], ['Email', u.email], ['Signed up with', how], ['When', when + ' Arizona time'], ['Accounts now', String(total)]];
  return {
    subject: `New TV Tracker sign-up: ${name || u.email}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nAdmin page: ${SITE}/#/admin`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#141821">
<p style="margin:0 0 12px"><b>Someone new signed up for TV Tracker.</b></p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#5b6474">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('')}</table>
<p style="margin:16px 0 0"><a href="${SITE}/#/admin">Open the Admin page</a></p></div>`
  };
}

const realAccount = u => !!u.email && !u.email.toLowerCase().endsWith(LOGIN_DOMAIN);

// MODE=test (Run workflow → test): emails TEST_TO a sample welcome and a sample sign-up note, whether or not it's a new account.
if (process.env.MODE === 'test') {
  const user = await auth.getUserByEmail(OWNER);
  const mail = welcomeEmail(await nameOf(user));
  await send(user.email, { ...mail, subject: '[Test] ' + mail.subject });
  const note = signupNote(user, await nameOf(user), 0);
  await send(OWNER, { ...note, subject: '[Test] ' + note.subject });
  console.log('Test emails sent to the site owner.');
  process.exit(0);
}

const fresh = [];
let page, total = 0;
do {
  page = await auth.listUsers(1000, page?.pageToken);
  for (const u of page.users) {
    if (realAccount(u)) total++;
    if (Date.parse(u.metadata.creationTime) > Date.now() - RECENT) fresh.push(u);
  }
} while (page.pageToken);

let sent = 0, skipped = 0, failed = 0;
for (const u of fresh) {
  const who = u.uid.slice(0, 6), email = (u.email || '').toLowerCase();
  try {
    const prefsRef = db.doc(`emailPrefs/${u.uid}`);
    if ((await prefsRef.get()).data()?.welcomed) continue;
    const removed = (await db.doc(`removals/${u.uid}`).get()).exists;
    if (!email || email.endsWith(LOGIN_DOMAIN) || u.disabled || removed) { skipped++; await prefsRef.set({ welcomed: true }, { merge: true }); continue; }
    const name = await nameOf(u), mail = welcomeEmail(name);
    await prefsRef.set({ welcomed: true }, { merge: true });   // marked first: a failed send is never repeated as a duplicate later
    if (OWNER) await send(OWNER, signupNote(u, name, total)).then(() => console.log(`${who}: owner told`), e => console.error(`${who}: owner note FAILED - ${e.message}`));
    await send(email, mail);
    sent++; console.log(`${who}: welcomed`);
    await sleep(600);
  } catch (e) {
    failed++; console.error(`${who}: FAILED - ${e.message}`);
  }
}
console.log(`${sent} welcomed, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);
