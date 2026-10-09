// Accounts + per-user storage via Firebase (Auth + Firestore), loaded from Google's CDN.
// Each user's data lives in one private document: users/{uid}.
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
export const configured = !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

let A, F, auth, db, unsubDoc = null;

export async function start({ onUser, onData, onError }) {
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
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    onUser(user ? toUser(user) : null);
    if (user) {
      // includeMetadataChanges: also hear when data cached offline is confirmed by the server
      unsubDoc = F.onSnapshot(F.doc(db, 'users', user.uid), { includeMetadataChanges: true },
        snap => onData(snap.exists() ? snap.data() : null, !snap.metadata.fromCache, snap.metadata.hasPendingWrites),
        onError);
    }
  });
}

const toUser = u => ({ uid: u.uid, email: u.email || '', name: u.displayName || (u.email || '').split('@')[0] });

export async function signUp(name, email, password) {
  const cred = await A.createUserWithEmailAndPassword(auth, email, password);
  if (name) await A.updateProfile(cred.user, { displayName: name });
  return toUser(cred.user);
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
export const signOut = () => A.signOut(auth);

// Deep-merges into users/{uid}: only the episodes/shows that changed are sent.
// The write is stored on the device immediately; the returned promise resolves once the server confirms it.
export function save(partial) {
  const u = auth?.currentUser; if (!u) return Promise.resolve();
  return F.setDoc(F.doc(db, 'users', u.uid), partial, { merge: true });
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
    'auth/unauthorized-domain': 'This website isn\'t on Firebase\'s authorized domains list yet.',
    'auth/operation-not-allowed': 'That sign-in method isn\'t turned on in Firebase yet.',
    'auth/network-request-failed': 'Network problem — check your connection.',
    'permission-denied': 'The database refused access — check the Firestore rules.'
  })[c] || e?.message || String(e);
}
