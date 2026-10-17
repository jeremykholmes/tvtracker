// Accounts + per-user storage via Firebase (Auth + Firestore), loaded from Google's CDN.
// users/{uid}            — profile + followed shows (small)
// users/{uid}/watched/bN — episode checkmarks, spread over BUCKETS small documents so no single
//                          document grows huge (big documents make every save slow).
const { firebaseConfig, adminUid, contactEmailKey } = await import('./firebase-config.js' + new URL(import.meta.url).search);   // same fresh version as the app

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const configured = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

const BUCKETS = 32;
const bucketOf = epId => 'b' + (Math.abs(parseInt(epId, 10) || 0) % BUCKETS);

let A, F, appMod, auth, db, unsubs = [];
let active = null, handlers = null;   // active: uid of the account whose list is open (yours, or the owner's for a login they made)
export const activeUid = () => active;

export async function start({ onUser, onData, onError }) {
  handlers = { onData, onError };
  if (!configured) { onUser(null); return; }
  let authMod, fsMod;
  [appMod, authMod, fsMod] = await Promise.all([
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
  A.getRedirectResult(auth).catch(e => onError(rememberPending(e)));
  A.onAuthStateChanged(auth, async user => {
    unsubs.forEach(u => u()); unsubs = [];
    const u = user ? toUser(user) : null;
    if (u) u.linked = await linkedList(user.uid);   // a login made by a list's owner opens that list
    if ((auth.currentUser?.uid || null) !== (user?.uid || null)) return;   // signed in/out again meanwhile
    active = u ? u.linked?.uid || u.uid : null;
    onUser(u);
    if (u) listen(active, onData, onError);
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

const toUser = u => ({ uid: u.uid, email: u.email || '', name: u.displayName || (u.email || '').split('@')[0] });

// Switches the open list (yours, or the owner's for a login they made).
export function openAccount(uid) {
  unsubs.forEach(u => u()); unsubs = [];
  active = uid;
  listen(uid, handlers.onData, handlers.onError);
}
/* ---------- logins for other people ----------
   An owner can create a login (name, username, password) for someone else. It's a normal account with the
   made-up email <username>@members.tvtracker.us. Its own document says which list it belongs to (listOf),
   and the owner's document lists it under logins with a role: 'view' (look only) or 'edit'. */
const LOGIN_DOMAIN = 'members.tvtracker.us';
export const loginEmail = s => (s = String(s || '').trim(), s.includes('@') ? s : `${s.toLowerCase()}@${LOGIN_DOMAIN}`);
export const isLogin = email => String(email || '').toLowerCase().endsWith('@' + LOGIN_DOMAIN);
export const loginName = email => isLogin(email) ? email.split('@')[0] : email;

// { uid, name, role } of the owner's list, for a login someone made; null for everyone else (or if the owner removed it).
async function linkedList(uid) {
  try {
    const me = await F.getDoc(F.doc(db, 'users', uid));
    const owner = me.exists() && me.data().listOf; if (!owner) return null;
    const o = await F.getDoc(F.doc(db, 'users', owner));
    const l = o.exists() && (o.data().logins || {})[uid]; if (!l) return null;
    return { uid: owner, name: o.data().profile?.name || me.data().ownerName || 'Shared', role: l.role === 'view' ? 'view' : 'edit' };
  } catch (e) { console.warn('linked list', e); return null; }   // removed, or offline before it was ever loaded
}
export const relink = () => linkedList(auth.currentUser.uid);   // re-reads it, e.g. after the owner changed this login's access
// [{ uid, name, username, role }] for the logins the signed-in user has made.
export async function logins() {
  const snap = await F.getDoc(F.doc(db, 'users', auth.currentUser.uid));
  const m = (snap.exists() && snap.data().logins) || {};
  return Object.entries(m).map(([uid, l]) => ({ uid, name: l.name || l.username, username: l.username, role: l.role === 'view' ? 'view' : 'edit' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function addLogin(name, username, password, role) {
  const owner = auth.currentUser;
  // Created in a separate, throwaway Firebase instance so the owner stays signed in here.
  const helper = appMod.initializeApp(firebaseConfig, 'login-' + Date.now());
  try {
    const a2 = A.initializeAuth(helper, { persistence: A.inMemoryPersistence });
    const cred = await A.createUserWithEmailAndPassword(a2, loginEmail(username), password);
    await A.updateProfile(cred.user, { displayName: name });
    await F.setDoc(F.doc(F.getFirestore(helper), 'users', cred.user.uid), {
      profile: { name, email: cred.user.email }, listOf: owner.uid, ownerName: owner.displayName || (owner.email || '').split('@')[0], updated: Date.now()
    });
    await F.setDoc(F.doc(db, 'users', owner.uid), { logins: { [cred.user.uid]: { name, username: username.toLowerCase(), role, t: Date.now() } } }, { merge: true });
  } finally { appMod.deleteApp(helper).catch(() => {}); }
}
export const setLoginRole = (uid, role) => F.updateDoc(F.doc(db, 'users', auth.currentUser.uid), new F.FieldPath('logins', uid, 'role'), role);
export const removeLogin = uid => F.updateDoc(F.doc(db, 'users', auth.currentUser.uid), new F.FieldPath('logins', uid), F.deleteField());

/* ---------- contact form ---------- */
// Saves a Contact us message (anyone can send one; only the admin can read them), and emails a copy if set up.
export async function sendMessage({ name, email, message }) {
  const m = { name: name.slice(0, 100), email: email.slice(0, 200), message: message.slice(0, 5000), t: Date.now(), uid: auth?.currentUser?.uid || '' };
  await F.addDoc(F.collection(db, 'messages'), m);
  if (contactEmailKey) fetch('https://api.web3forms.com/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ access_key: contactEmailKey, subject: 'TV Tracker contact form', from_name: 'TV Tracker', name: m.name, email: m.email, message: m.message })
  }).catch(e => console.warn('contact email', e));
}
export async function messages() {
  const snap = await F.getDocs(F.query(F.collection(db, 'messages'), F.orderBy('t', 'desc'), F.limit(200)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export const deleteMessage = id => F.deleteDoc(F.doc(db, 'messages', id));

/* ---------- admin ---------- */
export const isAdmin = () => !!adminUid && auth?.currentUser?.uid === adminUid;
// Every account's stored profile and list size (only the admin's account is allowed to read these).
export async function allAccounts() {
  const snap = await F.getDocs(F.collection(db, 'users'));
  return snap.docs.map(d => {
    const x = d.data();
    return { uid: d.id, name: x.profile?.name || '', email: x.profile?.email || '', listOf: x.listOf || null,
      shows: Object.values(x.shows || {}).filter(s => !s.removed).length, logins: Object.keys(x.logins || {}).length, updated: x.updated || 0 };
  });
}

export async function signUp(name, email, password) {
  const cred = await A.createUserWithEmailAndPassword(auth, email, password);
  if (name) await A.updateProfile(cred.user, { displayName: name });
  return toUser(cred.user);
}

export const signIn = (emailOrUsername, password) => A.signInWithEmailAndPassword(auth, loginEmail(emailOrUsername), password);
export async function google() {
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });   // always ask which Google account, so nobody lands in the wrong one
  try { await A.signInWithPopup(auth, provider); }
  catch (e) {
    if (/popup-blocked|operation-not-supported/.test(e.code || '')) return A.signInWithRedirect(auth, provider);
    throw rememberPending(e);
  }
}

/* ---------- one account per email: Google + password ----------
   Firebase keeps one account per email address. Google sign-in on an email that already has a password
   account usually just opens that account, but for some addresses (e.g. work emails) Firebase refuses until
   the password proves it's the same person — then the Google sign-in is added to it. */
let pendingGoogle = null;   // { email, cred } from the refused Google sign-in
function rememberPending(e) {
  if (e?.code === 'auth/account-exists-with-different-credential')
    pendingGoogle = { email: e.customData?.email || '', cred: A.GoogleAuthProvider.credentialFromError(e) };
  return e;
}
export const pendingGoogleEmail = () => pendingGoogle?.email || '';
export async function linkPendingGoogle(password) {
  const p = pendingGoogle; if (!p?.cred) throw new Error('Please start again with "Continue with Google".');
  const { user: u } = await A.signInWithEmailAndPassword(auth, p.email, password);
  pendingGoogle = null;
  await A.linkWithCredential(u, p.cred);
}
// Adds an email + password sign-in to a Google account, so either one opens the same list.
export async function addPassword(password) {
  const u = auth.currentUser; if (!u) throw new Error('Not signed in.');
  const cred = A.EmailAuthProvider.credential(u.email, password);
  try { await A.linkWithCredential(u, cred); }
  catch (e) {
    if (e?.code !== 'auth/requires-recent-login') throw e;
    await A.reauthenticateWithPopup(u, new A.GoogleAuthProvider());
    await A.linkWithCredential(u, cred);
  }
}
// "Create account" with an email that already has a Google account: sign in with Google, then add the password to it.
// Resolves false if that account already had a password (nothing added).
export async function googleThenAddPassword(email, password) {
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account', login_hint: email });
  let u;
  try { ({ user: u } = await A.signInWithPopup(auth, provider)); } catch (e) { throw rememberPending(e); }
  if ((u.email || '').toLowerCase() !== email.toLowerCase()) {
    await A.signOut(auth);
    throw new Error(`That Google account is ${u.email}, not ${email}. Try again and choose ${email}.`);
  }
  if (usesPassword()) return false;
  await A.linkWithCredential(u, A.EmailAuthProvider.credential(u.email, password));
  return true;
}
export const resetPassword = email => A.sendPasswordResetEmail(auth, email);
export const usesPassword = () => !!auth?.currentUser?.providerData.some(p => p.providerId === 'password');

// Firebase only lets someone change a password they've just proved they know, so this re-checks the current one first.
export async function changePassword(current, next) {
  const u = auth.currentUser; if (!u) throw new Error('Not signed in.');
  await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, current));
  await A.updatePassword(u, next);
}

// Permanently deletes the signed-in account and everything stored for it. Firebase only lets
// someone delete an account they've just proved is theirs, so this re-checks the password
// (or Google) first, then removes their data, then the account itself.
export async function deleteAccount(password) {
  const u = auth.currentUser; if (!u) throw new Error('Not signed in.');
  if (usesPassword()) await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, password));
  else await A.reauthenticateWithPopup(u, new A.GoogleAuthProvider());
  unsubs.forEach(x => x()); unsubs = [];        // stop listening, or the empty document would be recreated
  const b = F.writeBatch(db);
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
    'auth/email-already-in-use': 'An account with that email (or username) already exists.',
    'auth/invalid-credential': 'Email (or username) or password is incorrect.',
    'auth/wrong-password': 'Email (or username) or password is incorrect.',
    'auth/user-not-found': 'No account with that email or username.',
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/weak-password': 'Password needs at least 6 characters.',
    'auth/missing-password': 'Enter a password.',
    'auth/too-many-requests': 'Too many attempts — wait a minute and try again.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
    'auth/user-mismatch': 'That\'s a different Google account — choose the one you\'re signed in with.',
    'auth/requires-recent-login': 'Please sign out, sign back in, then try again.',
    'auth/account-exists-with-different-credential': 'You already have an account with this email. Sign in with its password to add Google to it.',
    'auth/provider-already-linked': 'This account already has that sign-in.',
    'auth/credential-already-in-use': 'That sign-in already belongs to a different account.',
    'auth/unauthorized-domain': 'This website isn\'t on Firebase\'s authorized domains list yet.',
    'auth/operation-not-allowed': 'That sign-in method isn\'t turned on in Firebase yet.',
    'auth/network-request-failed': 'Network problem — check your connection.',
    'permission-denied': 'The database refused access — check the Firestore rules.'
  })[c] || e?.message || String(e);
}
