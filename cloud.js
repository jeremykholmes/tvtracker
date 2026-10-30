// Accounts + per-user storage via Firebase (Auth + Firestore), loaded from Google's CDN.
// users/{uid}            — profile + followed shows (small)
// users/{uid}/watched/bN — episode checkmarks, spread over BUCKETS small documents so no single
//                          document grows huge (big documents make every save slow).
const { firebaseConfig, adminEmail, contactEmailKey, weeklyEmail, recEmail } = await import('./firebase-config.js' + new URL(import.meta.url).search);   // same fresh version as the app

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const configured = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

const BUCKETS = 32;
const bucketOf = epId => 'b' + (Math.abs(parseInt(epId, 10) || 0) % BUCKETS);

let A, F, appMod, auth, db, unsubs = [], inboxUnsub = null;
let active = null, handlers = null;   // active: uid of the account whose list is open (yours, or the owner's for a login they made)
let kid = false;                      // a kid login: the owner's shows come from its filtered copy, checkmarks from its own account
export const activeUid = () => active;

export async function start({ onUser, onData, onError, onInbox }) {
  handlers = { onData, onError, onInbox };
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
    inboxUnsub?.(); inboxUnsub = null; handlers.onInbox?.([]);
    const u = user ? toUser(user) : null;
    if (u) u.linked = await linkedList(user.uid);   // a login made by a list's owner opens that list
    if ((auth.currentUser?.uid || null) !== (user?.uid || null)) return;   // signed in/out again meanwhile
    active = u ? u.linked?.uid || u.uid : null;
    kid = u?.linked?.role === 'kid';
    onUser(u);
    if (u) { listen(active, onData, onError); noteLogin(user); }
    if (u && !u.linked && !isLogin(u.email)) watchInbox(user.uid);   // logins use someone else's list, so they don't get shows sent to them
  });
}

// Records when this account last opened the site signed in, for the Admin page's "Last login".
// At most once an hour per device; only on an account that already has a document (so it never creates one).
function noteLogin(user) {
  const key = 'tvt-lastlogin-' + user.uid, now = Date.now();
  try { if (now - (+localStorage.getItem(key) || 0) < 3600e3) return; localStorage.setItem(key, String(now)); } catch (e) {}
  F.updateDoc(F.doc(db, 'users', user.uid), { lastLogin: now }).catch(() => {});
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
  const opts = { includeMetadataChanges: true }, me = auth.currentUser.uid;
  unsubs.push(F.onSnapshot(kid ? F.doc(db, 'users', uid, 'kids', me) : F.doc(db, 'users', uid), opts, snap => {
    main = snap.exists() ? snap.data() : null; mainSrv = !snap.metadata.fromCache; mainPend = snap.metadata.hasPendingWrites; emit();
  }, onError));
  unsubs.push(F.onSnapshot(F.collection(db, 'users', kid ? me : uid, 'watched'), opts, snap => {
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

// Switches the open list (yours, or the owner's for a login they made; asKid: through that login's filtered copy).
export function openAccount(uid, asKid = false) {
  unsubs.forEach(u => u()); unsubs = [];
  active = uid; kid = asKid;
  listen(uid, handlers.onData, handlers.onError);
}
/* ---------- logins for other people ----------
   An owner can create a login (name, username, password) for someone else. It's a normal account with the
   made-up email <username>@members.tvtracker.us. Its own document says which list it belongs to (listOf),
   and the owner's document lists it under logins with a role: 'view' (look only), 'edit', or 'kid'.
   A kid login can't read the owner's document; it reads users/{owner}/kids/{kidUid} instead, which holds only the
   shows allowed for it (the owner's maxRating, hide and allow settings, applied by the owner's or an editor's app). */
const LOGIN_DOMAIN = 'members.tvtracker.us';
export const loginEmail = s => (s = String(s || '').trim(), s.includes('@') ? s : `${s.toLowerCase()}@${LOGIN_DOMAIN}`);
export const isLogin = email => String(email || '').toLowerCase().endsWith('@' + LOGIN_DOMAIN);
export const loginName = email => isLogin(email) ? email.split('@')[0] : email;

// { uid, name, role } of the owner's list, for a login someone made; null for everyone else (or if the owner removed it).
async function linkedList(uid) {
  try {
    const me = await F.getDoc(F.doc(db, 'users', uid));
    const owner = me.exists() && me.data().listOf; if (!owner) return null;
    let o;
    try { o = await F.getDoc(F.doc(db, 'users', owner)); }
    catch (e) {   // a kid login isn't allowed to read the owner's list, only its own filtered copy
      if (e?.code !== 'permission-denied') throw e;
      const k = await F.getDoc(F.doc(db, 'users', owner, 'kids', uid));
      return k.exists() ? { uid: owner, name: k.data().ownerName || me.data().ownerName || 'Shared', role: 'kid' } : null;
    }
    const l = o.exists() && (o.data().logins || {})[uid]; if (!l) return null;
    return { uid: owner, name: o.data().profile?.name || me.data().ownerName || 'Shared', role: ['view', 'kid'].includes(l.role) ? l.role : 'edit' };
  } catch (e) { console.warn('linked list', e); return null; }   // removed, or offline before it was ever loaded
}
export const relink = () => linkedList(auth.currentUser.uid);   // re-reads it, e.g. after the owner changed this login's access
// [{ uid, name, username, role, maxRating, hide, allow }] for the logins the signed-in user has made.
export async function logins() {
  const snap = await F.getDoc(F.doc(db, 'users', auth.currentUser.uid));
  const m = (snap.exists() && snap.data().logins) || {};
  return Object.entries(m).map(([uid, l]) => ({ uid, name: l.name || l.username, username: l.username, role: ['view', 'kid'].includes(l.role) ? l.role : 'edit',
    maxRating: l.maxRating || '', hide: l.hide || {}, allow: l.allow || {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function addLogin(name, username, password, role, kidCopy) {
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
    const b = F.writeBatch(db);
    b.set(F.doc(db, 'users', owner.uid), { logins: { [cred.user.uid]: { name, username: username.toLowerCase(), role, t: Date.now(),
      ...(role === 'kid' ? { maxRating: kidCopy.maxRating, hide: {}, allow: {} } : {}) } } }, { merge: true });
    if (role === 'kid') b.set(F.doc(db, 'users', owner.uid, 'kids', cred.user.uid), kidCopy);
    await b.commit();
  } finally { appMod.deleteApp(helper).catch(() => {}); }
}
// Changes a login's access. A kid login also gets its settings ({ maxRating, hide, allow }) and its filtered copy (kidCopy) in the
// same write, so it never sees more than it should; any other role has the copy removed.
export function setLogin(uid, role, settings, kidCopy) {
  const me = auth.currentUser.uid, b = F.writeBatch(db);
  b.update(F.doc(db, 'users', me), new F.FieldPath('logins', uid, 'role'), role,
    ...(role === 'kid' ? [new F.FieldPath('logins', uid, 'maxRating'), settings.maxRating, new F.FieldPath('logins', uid, 'hide'), settings.hide,
      new F.FieldPath('logins', uid, 'allow'), settings.allow || {}] : []));
  if (role === 'kid') b.set(F.doc(db, 'users', me, 'kids', uid), kidCopy); else b.delete(F.doc(db, 'users', me, 'kids', uid));
  return b.commit();
}
// Rewrites a kid login's filtered copy of the open list (the owner's or an editor's app does this whenever the list changes).
export const writeKidCopy = (uid, kidCopy) => F.setDoc(F.doc(db, 'users', active, 'kids', uid), kidCopy);
export function removeLogin(uid) {
  const me = auth.currentUser.uid, b = F.writeBatch(db);
  b.update(F.doc(db, 'users', me), new F.FieldPath('logins', uid), F.deleteField());
  b.delete(F.doc(db, 'users', me, 'kids', uid));
  return b.commit();
}

/* ---------- sending a show to another account ----------
   directory/{email}: { uid, name, key } — finds an account from the exact email it signs in with (no listing).
   byName/{key}/people/{uid}: { name, hint } — finds accounts by their exact full name (key: the name in lower case,
   spaces tidied). Only someone who types the whole name reaches it; nothing can be listed or searched by part of a name.
   hint is a masked email to tell people with the same name apart. Leaving name search (users/{uid}.findable false)
   removes the entry. users/{uid}/inbox/{id}: a show (or movie, kind: 'movie') someone sent; only the recipient can read or delete it, and anyone
   they block (users/{uid}.blocked) can't send. Logins made for others aren't listed and can't receive. */
const dirId = email => String(email || '').trim().toLowerCase();
const maskEmail = email => { const [a, d] = dirId(email).split('@'); return a && d ? `${a[0]}•••@${d}` : ''; };
// Must match nameKey() in firestore.rules.
export const nameKey = name => String(name || '').toLowerCase().replace(/\//g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '').slice(0, 100);
const cleanName = name => String(name || '').replace(/[\t\n\f\r\v]/g, ' ').trim().slice(0, 100);
// Keeps the signed-in account findable (its own list only). At most once a day per device unless forced.
export async function listInDirectory(name, findable, force) {
  const u = auth?.currentUser; if (!u?.email || isLogin(u.email)) return;
  name = cleanName(name);
  const store = 'tvt-dir-' + u.uid, now = Date.now(), mark = `${findable ? 1 : 0}|${name}`;
  try { const v = JSON.parse(localStorage.getItem(store) || 'null'); if (!force && v && v.m === mark && now - v.t < 864e5) return; } catch (e) {}
  const dir = F.doc(db, 'directory', dirId(u.email)), key = nameKey(name);
  const old = await F.getDoc(dir).then(d => d.exists() ? d.data().key || '' : '', () => '');
  await F.setDoc(dir, { uid: u.uid, name, key: findable ? key : '' });   // on its own, so email lookup works whatever happens to the name entry
  const b = F.writeBatch(db);
  if (old && old !== key) b.delete(F.doc(db, 'byName', old, 'people', u.uid));   // renamed: the old name no longer finds them
  if (key) findable ? b.set(F.doc(db, 'byName', key, 'people', u.uid), { name, hint: maskEmail(u.email) }) : b.delete(F.doc(db, 'byName', key, 'people', u.uid));
  await b.commit();
  try { localStorage.setItem(store, JSON.stringify({ t: now, m: mark })); } catch (e) {}
}
// Switches name search on or off for the signed-in account.
export async function setFindable(on, name) {
  await F.updateDoc(F.doc(db, 'users', auth.currentUser.uid), { findable: on });
  await listInDirectory(name, on, true);
}
// [{ uid, name, hint }] for accounts whose full name is exactly this (ignoring capitals and extra spaces).
export async function findPeople(name) {
  const key = nameKey(name); if (!key) return [];
  const snap = await F.getDocs(F.query(F.collection(db, 'byName', key, 'people'), F.limit(10)));
  return snap.docs.filter(d => d.id !== auth.currentUser.uid).map(d => ({ uid: d.id, name: d.data().name, hint: d.data().hint || '' }));
}
// { uid, name, hint } for the account with this exact email; errors with a code the app explains.
export async function findByEmail(email) {
  const fail = c => Object.assign(new Error(c), { code: c });
  if (isLogin(email) || !dirId(email).includes('@')) throw fail('tvt/no-account');
  const d = await F.getDoc(F.doc(db, 'directory', dirId(email)));
  if (!d.exists()) throw fail('tvt/no-account');
  if (d.data().uid === auth.currentUser.uid) throw fail('tvt/self');
  return { uid: d.data().uid, name: d.data().name || email, hint: maskEmail(email) };
}
// movie: it's a movie (show.id is its TMDB id), marked kind: 'movie'; network then says "Movie · <year>".
export async function sendShow(to, show, note, fromName, movie) {
  const u = auth.currentUser;
  if (to === u.uid) throw Object.assign(new Error('tvt/self'), { code: 'tvt/self' });
  const network = movie ? ['Movie', show.year].filter(Boolean).join(' · ') : show.network;
  await F.addDoc(F.collection(db, 'users', to, 'inbox'), {
    from: u.uid, fromName: String(fromName || '').trim().slice(0, 100) || loginName(u.email), fromEmail: u.email,
    show: { id: +show.id, name: String(show.name).slice(0, 200), image: String(show.image || '').slice(0, 500), network: String(network || '').slice(0, 100) },
    note: String(note || '').trim().slice(0, 300), t: Date.now(), ...(movie ? { kind: 'movie' } : {}) });
}
function watchInbox(uid) {
  inboxUnsub = F.onSnapshot(F.query(F.collection(db, 'users', uid, 'inbox'), F.orderBy('t', 'desc'), F.limit(50)),
    snap => handlers.onInbox?.(snap.docs.map(d => ({ id: d.id, ...d.data() }))), e => console.warn('inbox', e));
}
export const dismissShow = id => F.deleteDoc(F.doc(db, 'users', auth.currentUser.uid, 'inbox', id));
// Blocks the sender of an inbox item: they can't send any more, and everything they sent is removed.
export async function blockSender(m, all) {
  const me = auth.currentUser.uid, b = F.writeBatch(db);
  b.update(F.doc(db, 'users', me), new F.FieldPath('blocked', m.from), { name: m.fromName || '', email: m.fromEmail || '', t: Date.now() });
  for (const x of all) if (x.from === m.from) b.delete(F.doc(db, 'users', me, 'inbox', x.id));
  await b.commit();
}
export const unblock = uid => F.updateDoc(F.doc(db, 'users', auth.currentUser.uid), new F.FieldPath('blocked', uid), F.deleteField());

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
// Verified email only: Google confirms it on Google sign-in, so nobody can claim the address with a password sign-up.
export const isAdmin = () => !!adminEmail && !!auth?.currentUser?.emailVerified && (auth.currentUser.email || '').toLowerCase() === adminEmail.toLowerCase();
// Every account's stored profile and list size (only the admin's account is allowed to read these).
// Lists accounts that haven't opened the site since sending shows arrived, so people can find them.
export async function backfillDirectory(accounts) {
  const b = F.writeBatch(db); let n = 0;
  for (const a of accounts) {
    if (a.listOf || !a.email || isLogin(a.email)) continue;
    const name = cleanName(a.name || a.email.split('@')[0]), key = a.findable ? nameKey(name) : '';
    b.set(F.doc(db, 'directory', dirId(a.email)), { uid: a.uid, name, key }, { merge: true });
    if (key) b.set(F.doc(db, 'byName', key, 'people', a.uid), { name, hint: maskEmail(a.email) });
    if (++n >= 200) break;
  }
  if (n) await b.commit();
  return n;
}
// Removes name-search entries left by accounts that no longer exist (e.g. deleted outside the Admin page), which
// showed up as a second person with the same name who couldn't be sent anything. Checks the names of current accounts.
export async function pruneByName(accounts) {
  const uids = new Set(accounts.map(a => a.uid)), b = F.writeBatch(db); let n = 0;
  const keys = new Set(accounts.filter(a => a.email && !isLogin(a.email)).map(a => nameKey(cleanName(a.name || a.email.split('@')[0]))).filter(Boolean));
  for (const key of keys) {
    const snap = await F.getDocs(F.query(F.collection(db, 'byName', key, 'people'), F.limit(10)));
    for (const d of snap.docs) if (!uids.has(d.id)) { b.delete(d.ref); n++; }
  }
  if (n) await b.commit();
  return n;
}
export async function allAccounts() {
  const snap = await F.getDocs(F.collection(db, 'users'));
  const access = Object.fromEntries(snap.docs.map(d => [d.id, d.data().logins || {}]));   // owner -> logins they still allow
  return snap.docs.map(d => {
    const x = d.data();
    return { uid: d.id, name: x.profile?.name || '', email: x.profile?.email || '', listOf: x.listOf || null,
      removed: !!x.listOf && !access[x.listOf]?.[d.id],   // a login whose owner took its access away (or deleted their account)
      shows: Object.values(x.shows || {}).filter(s => !s.removed).length, logins: Object.keys(x.logins || {}).length, updated: x.updated || 0, lastLogin: x.lastLogin || 0, findable: x.findable !== false };
  });
}

// Accounts removed on the Admin page: { uid: { t, name, email, done } }. done is set once the sign-in and data are deleted.
export async function removals() {
  const snap = await F.getDocs(F.collection(db, 'removals'));
  return Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
}
// Locks the account out right away (the database rules refuse it from now on) and queues the full deletion,
// which .github/workflows/remove-accounts.yml carries out (a web page can't delete someone else's sign-in).
export function removeAccount(a) {
  if (a.uid === auth.currentUser?.uid) throw new Error("You can't remove your own account here.");
  return F.setDoc(F.doc(db, 'removals', a.uid), { t: Date.now(), name: (a.name || '').slice(0, 100), email: (a.email || '').slice(0, 200) });
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
  inboxUnsub?.(); inboxUnsub = null;
  const mine = await F.getDoc(F.doc(db, 'users', u.uid)).catch(() => null);
  const inbox = await F.getDocs(F.collection(db, 'users', u.uid, 'inbox')).catch(() => null);
  const dir = u.email ? await F.getDoc(F.doc(db, 'directory', dirId(u.email))).catch(() => null) : null;
  const b = F.writeBatch(db);
  inbox?.forEach(d => b.delete(d.ref));
  if (dir?.exists() && dir.data().uid === u.uid) {
    b.delete(dir.ref);
    if (dir.data().key) b.delete(F.doc(db, 'byName', dir.data().key, 'people', u.uid));
  }
  for (const k of Object.keys((mine?.exists() && mine.data().logins) || {})) b.delete(F.doc(db, 'users', u.uid, 'kids', k));
  for (let i = 0; i < BUCKETS; i++) b.delete(F.doc(db, 'users', u.uid, 'watched', 'b' + i));
  b.delete(F.doc(db, 'users', u.uid));
  b.delete(F.doc(db, 'emailPrefs', u.uid));
  await Promise.race([b.commit(), new Promise((_, no) => setTimeout(() => no({ code: 'auth/network-request-failed' }), 15000))]);
  await A.deleteUser(u);
}
export const signOut = () => A.signOut(auth);

// The weekly "new episodes to watch" email (sent by email/weekly.mjs). On unless switched off.
export const weeklyEmailEnabled = !!weeklyEmail;   // the site offers the switch only once the email is set up
export async function weeklyEmailOn() {
  const snap = await F.getDoc(F.doc(db, 'emailPrefs', auth.currentUser.uid));
  return !(snap.exists() && snap.data().off);
}
export const setWeeklyEmail = on => F.setDoc(F.doc(db, 'emailPrefs', auth.currentUser.uid), { off: !on }, { merge: true });
// Emails when a friend recommends a show (sent by email/recs.mjs). On unless switched off.
export const recEmailEnabled = !!recEmail;
export async function recEmailOn() {
  const snap = await F.getDoc(F.doc(db, 'emailPrefs', auth.currentUser.uid));
  return !(snap.exists() && snap.data().recsOff);
}
export const setRecEmail = on => F.setDoc(F.doc(db, 'emailPrefs', auth.currentUser.uid), { recsOff: !on }, { merge: true });

// Saves only what changed, in one batch: shows/profile go to the main document,
// checkmarks go to their bucket documents. Stored on the device immediately;
// the returned promise resolves once the server confirms it.
// A kid login only saves its own checkmarks, to its own account.
export function save(partial) {
  const u = auth?.currentUser; if (!u || !active) return Promise.resolve();
  const uid = kid ? u.uid : active;
  const { watched, ...rest } = partial;
  const b = F.writeBatch(db);
  if (!kid && Object.keys(rest).length && !(Object.keys(rest).length === 1 && rest.shows && !Object.keys(rest.shows).length))
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
