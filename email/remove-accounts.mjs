// Finishes removing accounts the site owner removed on the Admin page (removals/{uid} in Firestore), run by
// .github/workflows/remove-accounts.yml. The database rules already lock a removed account out; this deletes its
// sign-in (which a web page can't do for someone else) and everything stored for it, then marks the removal done.
// The entry itself stays, so a sign-in token issued before the deletion still can't reach anything.
// The repo is public, so its Actions logs are too: the log shows account ids only, never names or emails.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldPath, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const auth = getAuth(), db = getFirestore();

const todo = (await db.collection('removals').get()).docs.filter(d => !d.data().done);
console.log(`${todo.length} account(s) to remove`);

if (todo.length) {
  const users = (await db.collection('users').get()).docs;
  for (const r of todo) {
    const uid = r.id;
    try {
      await auth.deleteUser(uid).catch(e => { if (e.code !== 'auth/user-not-found') throw e; });
      // Their entries for being found when someone sends a show.
      for (const d of (await db.collection('directory').where('uid', '==', uid).get()).docs) {
        if (d.data().key) await db.doc(`byName/${d.data().key}/people/${uid}`).delete();
        await d.ref.delete();
      }
      // Any list that had given them a login.
      for (const o of users) {
        if (o.id !== uid && (o.data().logins || {})[uid]) {
          await o.ref.update(new FieldPath('logins', uid), FieldValue.delete());
          await db.doc(`users/${o.id}/kids/${uid}`).delete();
        }
      }
      await db.recursiveDelete(db.doc(`users/${uid}`));   // their list, checkmarks, shows sent to them, kid copies
      await db.doc(`emailPrefs/${uid}`).delete();
      await r.ref.update({ done: true, doneAt: Date.now() });
      console.log(`removed ${uid}`);
    } catch (e) {
      console.error(`could not finish removing ${uid}: ${e.code || e.message}`);
      process.exitCode = 1;   // the others still go ahead; this one is retried next run
    }
  }
}

// Name and email search entries (byName/{key}/people/{uid}, directory/{email}) for accounts that have no list any
// more, e.g. deleted outside the Admin page. They showed up as a second person with the same name who couldn't be
// sent anything (the rules only deliver to existing accounts). A sign-in newer than a day is left alone: its list
// may not be saved yet.
const exists = new Map();
async function gone(uid) {
  if (!exists.has(uid)) exists.set(uid, (await db.doc(`users/${uid}`).get()).exists
    || (await auth.getUser(uid).then(u => Date.now() - Date.parse(u.metadata.creationTime) < 864e5, () => false)));
  return !exists.get(uid);
}
let stale = 0;
for (const d of (await db.collectionGroup('people').get()).docs) {
  if (d.ref.parent.parent?.parent.id !== 'byName' || !(await gone(d.id))) continue;
  await d.ref.delete(); stale++;
}
for (const d of (await db.collection('directory').get()).docs) {
  if (!d.data().uid || !(await gone(d.data().uid))) continue;
  await d.ref.delete(); stale++;
}
console.log(`removed ${stale} search entr${stale === 1 ? 'y' : 'ies'} for accounts that no longer exist`);
