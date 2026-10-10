# TV Tracker

A website for tracking the TV shows you're watching, with accounts so anyone can sign up and keep their own private list. Hosted on GitHub Pages; accounts and data run on a free Firebase project.

Live site: https://jeremykholmes.github.io/tvtracker/

## Features
- **Landing page** — signed-out visitors see a welcome page with Continue with Google, Create free account and Sign in.
- **Accounts** — sign up with email/password or Google. Each person's shows and checkmarks are private and sync to every device they sign in on. Visitors can browse and search shows, but need to sign in (email or Google) to add shows or check off episodes.
- **Add any show** from any broadcast network or streaming service (Netflix, HBO/Max, Hulu, Disney+, Apple TV+, Prime Video, NBC, CBS…), powered by the free [TVmaze](https://www.tvmaze.com) API.
- **My Shows** — what's up next for each show, episodes left, and a one-tap **✓ Watched** button.
- **Episode checklist** per season: check single episodes, **Mark all**, or **Watched Up To Here** to mark everything up to an episode watched.
- **New episodes pulled automatically** once a day.
- **Upcoming** air dates for your shows, and **Discover** for this week's premieres.

## Switching on accounts (one-time, ~10 minutes)
1. Go to https://console.firebase.google.com → **Create a project** (e.g. `tvtracker`). Google Analytics is optional — you can turn it off.
2. **Build → Authentication → Get started.** Under *Sign-in method*, enable **Email/Password** and **Google**.
3. Authentication → **Settings → Authorized domains → Add domain** → `jeremykholmes.github.io`.
4. **Build → Firestore Database → Create database** → pick a location near you → start in **production mode**.
5. Firestore → **Rules** tab → replace everything with the contents of `firestore.rules` from this repo → **Publish**.
6. **Project settings** (gear icon) → *Your apps* → click the **`</>`** (Web) icon → register an app (any nickname, no Hosting needed) → copy the `firebaseConfig` values.
7. Paste those values into `firebase-config.js` in this repo and commit. The site picks it up within a minute or two.

The Firebase config values are designed to be public; `firestore.rules` is what keeps each user's data private (users can only read and write their own document). The free Spark plan covers a household and well beyond.

## Email when someone signs up (optional)
1. Go to https://web3forms.com, enter the email address you want notifications sent to, and copy the access key they email you.
2. Paste it into `signupEmailKey` in `firebase-config.js` and commit.

You'll then get an email with the new person's name, email and sign-up method each time an account is created. The key is meant to be public; it can only send email to you.

## Files
- `index.html` — page shell
- `app.js` — the app (shows, episodes, views)
- `cloud.js` — accounts and per-user storage (Firebase)
- `firebase-config.js` — your Firebase project's web config
- `firestore.rules` — database security rules to paste into Firebase
- `styles.css` — styles (dark/light automatic, mobile bottom tab bar)
