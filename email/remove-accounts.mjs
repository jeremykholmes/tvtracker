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
