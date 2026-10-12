// Firebase web app config (Firebase console → Project settings → Your apps → Web app).
// These values are meant to be public; your data is protected by firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyCtO6bU0TCjV_zcTTw41CzdcBz63SSXrys',
  authDomain: 'tvtracker.us',   // sign-in helper pages are self-hosted at /__/auth/ (see .github/workflows/firebase-auth-helpers.yml)
  projectId: 'tv-tracker-6135d',
  storageBucket: 'tv-tracker-6135d.firebasestorage.app',
  messagingSenderId: '507132660816',
  appId: '1:507132660816:web:da6b530f6da246c4a59555'
};

// TMDB (https://www.themoviedb.org) API key, used for show recommendations on the Discover page. Meant to be public.
// Optional: a Web3Forms access key (free, https://web3forms.com) to also get each Contact us message by email.
// Messages always appear on the Admin page; leave this empty to skip the emails.
export const contactEmailKey = '';

export const tmdbKey = 'ee8ab7c29b7aa9166f87292204ab04ba';

// Firebase account ID (Authentication → Users → User UID) of the site owner, who gets the Admin page.
// It must match the ID in firestore.rules, which is what actually grants access.
export const adminUid = 'EU3VXDDYuYa5gymkINeUNPxsEem1';
