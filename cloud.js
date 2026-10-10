// Accounts + per-user storage via Firebase (Auth + Firestore), loaded from Google's CDN.
// users/{uid}            — profile + followed shows (small)
// users/{uid}/watched/bN — episode checkmarks, spread over BUCKETS small documents so no single
//                          document grows huge (big documents make every save slow).
import { firebaseConfig, signupEmailKey, shareEmail } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const configured = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

const BUCKETS = 32;
const bucketOf = epId => 'b' + (Math.abs(parseInt(epId, 10) || 0) % BUCKETS);

let A, F, auth, db, unsubs = [];
let active = null, handlers = null;   // active: uid of the account whose list is open (yours, or one shared with you)
export const activeUid = () => active;

// pick(user) returns the uid of the list to open after sign-in (the user's own, or one shared with them).
export async function start({ onUser, onData, onError, pick }) {
  handlers = { onData, onError };
  if (!configured) { onUser(null); return; }
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)
  ]);
  A = authMod; F = fsMod;
  const app = appMod.initializeApp(firebaseConfig);
  auth = A.getAuth(app);
  // Keep a copy of the database on the device (IndexedDB). Saves land there instantly and
  // are queued to upload in the background — they survive closing the tab or going offline.
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch (e) { console.warn('Offline cache unavailable, using memory', e); db = F.getFirestore(app); }
  A.getRedirectResult(auth).catch(onError);
  A.onAuthStateChanged(auth, user => {
    unsubs.forEach(u => u()); unsubs = [];
    active = user ? (pick && pick(toUser(user))) || user.uid : null;
    onUser(user ? toUser(user) : null);
    if (user) { listen(active, onData, onError); notifyOwners(); }
    // Google sign-ups are spotted here; email sign-ups are reported from signUp() once the name is set.
    if (user && !user.providerData.some(p => p.providerId === 'password')) notifyIfNew(user);
  });
}

// Two listeners (main doc + checkmark buckets) combined into one view for the app.
function listen(uid, onData, onError) {
  let main, mainSrv = false, mainPend = false, watched = null, wSrv = false, wPend = false, migrating = false;
  const emit = () => {
    if (main === undefined || watched === null) return;
    const legacy = (main && main.watched) || {};
    const all = { ...legacy };
    for (const [k, v] of Object.entries(watched)) if (!all[k] || (v.t || 0) >= (all[k].t || 0)) all[k] = v;
    const data = main || Object.keys(all).length ? { ...(main || {}), watched: all } : null;
    onData(data, mainSrv && wSrv, mainPend || wPend);
    // One-time move of checkmarks out of the old single big document.
    if (!migrating && mainSrv && wSrv && main && main.watched) { migrating = true; migrate(uid, legacy, watched).catch(e => { migrating = false; onError(e); }); }
  };
  const opts = { includeMetadataChanges: true };
  unsubs.push(F.onSnapshot(F.doc(db, 'users', uid), opts, snap => {
    main = snap.exists() ? snap.data() : null; mainSrv = !snap.metadata.fromCache; mainPend = snap.metadata.hasPendingWrites; emit();
  }, onError));
  unsubs.push(F.onSnapshot(F.collection(db, 'users', uid, 'watched'), opts, snap => {
    const w = {}; snap.forEach(d => Object.assign(w, d.data().e || {}));
    watched = w; wSrv = !snap.metadata.fromCache; wPend = snap.metadata.hasPendingWrites; emit();
  }, onError));
}

async function migrate(uid, legacy, current) {
  const groups = {};
  for (const [k, v] of Object.entries(legacy)) {
    const c = current[k]; if (c && (c.t || 0) >= (v.t || 0)) continue;
    (groups[bucketOf(k)] ||= {})[k] = v;
  }
  const b = F.writeBatch(db);
  for (const [bk, e] of Object.entries(groups)) b.set(F.doc(db, 'users', uid, 'watched', bk), { e }, { merge: true });
  b.update(F.doc(db, 'users', uid), { watched: F.deleteField() });
  await b.commit();
}

const toUser = u => ({ uid: u.uid, email: u.email || '', name: u.displayName || (u.email || '').split('@')[0], verified: !!u.emailVerified });

/* ---------- shared access ----------
   The owner lists people by email in users/{uid}.members, each with a role: 'view' (look only) or
   'edit' (add/remove shows, check off episodes). Nobody but the owner can change who has access. shares/{owner}_{email} lets the
   person find lists shared with them. */
const lc = e => String(e || '').trim().toLowerCase();
export function openAccount(uid) {
  unsubs.forEach(u => u()); unsubs = [];
  active = uid;
  listen(uid, handlers.onData, handlers.onError);
}
// [{ email, role }] for everyone the signed-in user has shared their list with.
export async function members() {
  const snap = await F.getDoc(F.doc(db, 'users', auth.currentUser.uid));
  const m = (snap.exists() && snap.data().members) || {};
  return Object.keys(m).sort().map(email => ({ email, role: m[email].role || 'edit' }));
}
// Adds someone, or changes their role if they already have access.
export async function addMember(email, role = 'view') {
  const u = auth.currentUser, e = lc(email);
  const b = F.writeBatch(db);
  b.set(F.doc(db, 'users', u.uid), { members: { [e]: { t: Date.now(), role } } }, { merge: true });
  b.set(F.doc(db, 'shares', `${u.uid}_${e}`), { owner: u.uid, ownerName: u.displayName || (u.email || '').split('@')[0], ownerEmail: u.email || '', email: e, role, t: Date.now() }, { merge: true });
  await b.commit();
}
export async function removeMember(email) {
  const u = auth.currentUser, e = lc(email);
  const b = F.writeBatch(db);
  b.update(F.doc(db, 'users', u.uid), new F.FieldPath('members', e), F.deleteField());
  b.delete(F.doc(db, 'shares', `${u.uid}_${e}`));
  await b.commit();
}
// Lists other people have shared with the signed-in user (needs a verified email).
export async function sharedWithMe() {
  const u = auth.currentUser; if (!u?.emailVerified) return [];
  const snap = await F.getDocs(F.query(F.collection(db, 'shares'), F.where('email', '==', lc(u.email))));
  return snap.docs.map(d => d.data());
}
// The first time someone signs in with an email that was given access, mark the share as joined
// and email the account owner (once — whichever device marks it first sends the email).
async function notifyOwners() {
  try {
    const u = auth.currentUser;
    for (const s of await sharedWithMe()) {
      if (s.joined) continue;
      const name = u.displayName || (u.email || '').split('@')[0];
      await F.updateDoc(F.doc(db, 'shares', `${s.owner}_${s.email}`), { joined: { t: Date.now(), name } });
      if (!shareEmail?.serviceId || !s.ownerEmail) continue;
      fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: shareEmail.serviceId, template_id: shareEmail.templateId, user_id: shareEmail.publicKey,
          template_params: { to_email: s.ownerEmail, to_name: s.ownerName, member_name: name, member_email: u.email, site: location.origin }
        })
      }).catch(e => console.warn('share email', e));
    }
  } catch (e) { console.warn('share notify', e); }
}
export const sendVerification = () => A.sendEmailVerification(auth.currentUser);
// After clicking the link in the email: refresh so the new "verified" status reaches the database rules.
export async function refreshVerified() {
  const u = auth.currentUser; await u.reload(); await u.getIdToken(true);
  if (u.emailVerified) notifyOwners();
  return u.emailVerified;
}

export async function signUp(name, email, password) {
  const cred = await A.createUserWithEmailAndPassword(auth, email, password);
  if (name) await A.updateProfile(cred.user, { displayName: name });
  notifyIfNew(cred.user);
  return toUser(cred.user);
}

// Emails the site owner (via Web3Forms) the first time a brand-new account signs in.
function notifyIfNew(u) {
  const m = u.metadata, created = Date.parse(m.creationTime);
  if (!signupEmailKey || m.creationTime !== m.lastSignInTime || Date.now() - created > 10 * 60e3) return;
  const flag = 'tvt.notified.' + u.uid;
  try { if (localStorage.getItem(flag)) return; localStorage.setItem(flag, '1'); } catch { }
  fetch('https://api.web3forms.com/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      access_key: signupEmailKey, subject: 'New TV Tracker sign-up', from_name: 'TV Tracker',
      name: u.displayName || '(no name)', email: u.email || '',
      'signed up with': u.providerData.map(p => p.providerId === 'password' ? 'email' : 'Google').join(', '),
      when: new Date(created).toString()
    })
  }).catch(e => console.warn('sign-up email', e));
}
export const signIn = (email, password) => A.signInWithEmailAndPassword(auth, email, password);
export async function google() {
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });   // always ask which Google account, so nobody lands in the wrong one
  try { await A.signInWithPopup(auth, provider); }
  catch (e) {
    if (/popup-blocked|operation-not-supported/.test(e.code || '')) return A.signInWithRedirect(auth, provider);
    throw e;
  }
}
export const resetPassword = email => A.sendPasswordResetEmail(auth, email);
export const usesPassword = () => !!auth?.currentUser?.providerData.some(p => p.providerId === 'password');

// Permanently deletes the signed-in account and everything stored for it. Firebase only lets
// someone delete an account they've just proved is theirs, so this re-checks the password
// (or Google) first, then removes their data, then the account itself.
export async function deleteAccount(password) {
  const u = auth.currentUser; if (!u) throw new Error('Not signed in.');
  if (usesPassword()) await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, password));
  else await A.reauthenticateWithPopup(u, new A.GoogleAuthProvider());
  unsubs.forEach(x => x()); unsubs = [];        // stop listening, or the empty document would be recreated
  const b = F.writeBatch(db);
  try { (await F.getDocs(F.query(F.collection(db, 'shares'), F.where('owner', '==', u.uid)))).forEach(d => b.delete(d.ref)); } catch { }
  for (let i = 0; i < BUCKETS; i++) b.delete(F.doc(db, 'users', u.uid, 'watched', 'b' + i));
  b.delete(F.doc(db, 'users', u.uid));
  await Promise.race([b.commit(), new Promise((_, no) => setTimeout(() => no({ code: 'auth/network-request-failed' }), 15000))]);
  await A.deleteUser(u);
}
export const signOut = () => A.signOut(auth);

// Saves only what changed, in one batch: shows/profile go to the main document,
// checkmarks go to their bucket documents. Stored on the device immediately;
// the returned promise resolves once the server confirms it.
export function save(partial) {
  const u = auth?.currentUser; if (!u || !active) return Promise.resolve();
  const uid = active;
  const { watched, ...rest } = partial;
  const b = F.writeBatch(db);
  if (Object.keys(rest).length && !(Object.keys(rest).length === 1 && rest.shows && !Object.keys(rest.shows).length))
    b.set(F.doc(db, 'users', uid), rest, { merge: true });
  const groups = {};
  for (const [k, v] of Object.entries(watched || {})) (groups[bucketOf(k)] ||= {})[k] = v;
  for (const [bk, e] of Object.entries(groups)) b.set(F.doc(db, 'users', uid, 'watched', bk), { e }, { merge: true });
  return b.commit();
}
// Resolves when every queued write has reached the server.
export const waitForPendingWrites = () => db ? F.waitForPendingWrites(db) : Promise.resolve();

export function friendlyError(e) {
  const c = e?.code || '';
  return ({
    'auth/email-already-in-use': 'An account with that email already exists — try signing in.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'No account with that email.',
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/weak-password': 'Password needs at least 6 characters.',
    'auth/missing-password': 'Enter a password.',
    'auth/too-many-requests': 'Too many attempts — wait a minute and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
    'auth/user-mismatch': 'That\'s a different Google account — choose the one you\'re signed in with.',
    'auth/requires-recent-login': 'Please sign out, sign back in, then try again.',
    'auth/unauthorized-domain': 'This website isn\'t on Firebase\'s authorized domains list yet.',
    'auth/operation-not-allowed': 'That sign-in method isn\'t turned on in Firebase yet.',
    'auth/network-request-failed': 'Network problem — check your connection.',
    'permission-denied': 'The database refused access — check the Firestore rules.'
  })[c] || e?.message || String(e);
}
