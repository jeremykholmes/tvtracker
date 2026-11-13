// Works out each show's and movie's combined star rating for its page (showRatings/{showId} = { n, sum }; a movie's is
// showRatings/m{tmdbId}), run hourly by
// .github/workflows/rating-totals.yml. Each person's rating stays private in their own document; only these totals are
// public, and only this job can write them, so a rating counts once and nobody can alter the result.
// The repo is public, so its Actions logs are too: the log shows counts only.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

const removed = new Set((await db.collection('removals').get()).docs.map(d => d.id));
const totals = new Map();
for (const u of (await db.collection('users').select('ratings').get()).docs) {
  if (removed.has(u.id)) continue;
  for (const [id, stars] of Object.entries(u.data().ratings || {})) {
    if (!/^m?\d+$/.test(id) || ![1, 2, 3, 4, 5].includes(stars)) continue;   // people can write anything to their own document
    const t = totals.get(id) || { n: 0, sum: 0 };
    t.n++; t.sum += stars;
    totals.set(id, t);
  }
}

let changed = 0, cleared = 0;
const saved = (await db.collection('showRatings').get()).docs;
for (const d of saved) if (!totals.has(d.id)) { await d.ref.delete(); cleared++; }
const before = new Map(saved.map(d => [d.id, d.data()]));
for (const [id, t] of totals) {
  const was = before.get(id);
  if (was?.n === t.n && was?.sum === t.sum) continue;
  await db.doc(`showRatings/${id}`).set(t);
  changed++;
}
console.log(`${totals.size} rated show(s) and movie(s): ${changed} updated, ${cleared} cleared`);
