// Firebase web app config (Firebase console → Project settings → Your apps → Web app).
// These values are meant to be public; your data is protected by firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyCtO6bU0TCjV_zcTTw41CzdcBz63SSXrys',
  authDomain: 'tvtracker.us'   // sign-in helper pages are self-hosted at /__/auth/ (see .github/workflows/firebase-auth-helpers.yml),
  projectId: 'tv-tracker-6135d',
  storageBucket: 'tv-tracker-6135d.firebasestorage.app',
  messagingSenderId: '507132660816',
  appId: '1:507132660816:web:da6b530f6da246c4a59555'
};

// Web3Forms access key (free, from https://web3forms.com) — when set, you get an email each time
// someone creates an account. Leave empty to turn the emails off.
export const signupEmailKey = '';
