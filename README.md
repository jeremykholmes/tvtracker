# TV Tracker

A website for tracking the TV shows you're watching, with accounts so anyone can sign up and keep their own private list. Hosted on GitHub Pages; accounts and data run on a free Firebase project.

Live site: https://tvtracker.us

## Features
- **Landing page** — signed-out visitors see a welcome page with Continue with Google, Create free account and Sign in.
- **Accounts** — sign up with email/password or Google. Each person's shows and checkmarks are private and sync to every device they sign in on. Visitors can browse and search shows, but need to sign in (email or Google) to add shows or check off episodes.
- **Shared access** — from the Account page, make a login for someone (their name, a username and a password) as **Can view** (see what you're watching and where you're up to) or **Can edit** (also add/remove shows and check off episodes). They sign in with that username and password and go straight to your list. Change their access or remove the login any time. Only the owner can change who has access or delete the account.
- **Add any show** from any broadcast network or streaming service (Netflix, HBO/Max, Hulu, Disney+, Apple TV+, Prime Video, NBC, CBS…), powered by the free [TVmaze](https://www.tvmaze.com) API.
- **My Shows** — what's up next for each show, episodes left, and a one-tap **✓ Watched** button.
- **Recommend to a friend** — a button on every show page shares a link (phone share sheet, or copied on a computer). The friend lands on the show with a "<your name> recommends this show" banner and an Add button; if they sign up first, the show is added once they're in.
- **Contact us** — a footer link opens a short form (name, email, message). Messages are saved in Firestore and listed on the owner's Admin page; set `contactEmailKey` (a free Web3Forms key) in `firebase-config.js` to also get each one by email.
- **Episode checklist** per season: check single episodes, **Mark all**, or **Watched Up To Here** to mark everything up to an episode watched.
- **New episodes pulled automatically** once a day. On a phone, **pull down** on My Shows to check right away.
- **Weekly email** *(built, not switched on yet)* — on Sundays, everyone with new episodes from the past week that they haven't checked off gets a short list of them by email. Unsubscribe link in every email; on/off switch on the Account page. See [Weekly email](#weekly-email) below.
- **Get the app** — install TV Tracker with its own icon on a phone (iPhone or Android) or computer. Chrome and Edge show their install prompt; other browsers get step-by-step instructions.
- **Upcoming** air dates for your shows, and **Discover** for this week's premieres.
- **Recommended for you** — Discover opens with Top picks for you and a "Because you watch …" row of posters for each show on your list (from TMDB's "people who liked this also liked" data), each with a ＋ Add button; this week's premieres follow below. Uses the free TMDB API key in `firebase-config.js`.

## Switching on accounts (one-time, ~10 minutes)
1. Go to https://console.firebase.google.com → **Create a project** (e.g. `tvtracker`). Google Analytics is optional — you can turn it off.
2. **Build → Authentication → Get started.** Under *Sign-in method*, enable **Email/Password** and **Google**.
3. Authentication → **Settings → Authorized domains → Add domain** → `tvtracker.us` and `www.tvtracker.us`.
4. **Build → Firestore Database → Create database** → pick a location near you → start in **production mode**.
5. Firestore → **Rules** tab → replace everything with the contents of `firestore.rules` from this repo → **Publish**.
6. **Project settings** (gear icon) → *Your apps* → click the **`</>`** (Web) icon → register an app (any nickname, no Hosting needed) → copy the `firebaseConfig` values.
7. Paste those values into `firebase-config.js` in this repo and commit. The site picks it up within a minute or two.

The Firebase config values are designed to be public; `firestore.rules` is what keeps each user's data private (users can only read and write their own document, plus the lists of the owners who made a login for them). The free Spark plan covers a household and well beyond.

## Weekly email
**Status: built but paused.** Nothing is sent and users don't see it until the steps below are done.

`.github/workflows/weekly-email.yml` runs `email/weekly.mjs` every Sunday at 14:07 UTC. For each account with a real email address (not logins made for others), it reads their shows and checkmarks from Firestore, gets each show's episodes from TVmaze, and if any episode aired in the past 7 days and isn't checked off, emails them a list through [Resend](https://resend.com). Each person gets it at most once every 6 days. `emailPrefs/{uid}` in Firestore holds each person's on/off setting, their unsubscribe token and when they were last emailed. The unsubscribe link goes to `unsubscribe.html`, which switches the email off without signing in.

One-time setup:
1. **Resend**: create a free account (100 emails a day, 3,000 a month), then **Domains → Add domain** → `tvtracker.us`, and add the DNS records it shows in Cloudflare (DNS only). Once it says *Verified*, **API Keys → Create API key** (sending access).
2. **Firebase service account**: Firebase console → **Project settings → Service accounts → Generate new private key**. This downloads a JSON file; it gives full access to the project, so keep it private and delete the file once it's saved in GitHub.
3. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**: `RESEND_API_KEY` (the Resend key) and `FIREBASE_SERVICE_ACCOUNT` (the whole JSON file's contents).
4. Publish the latest `firestore.rules` (it adds the rules for `emailPrefs`).
5. Actions → **Weekly new-episodes email → Run workflow** with mode **test**: it emails only the site owner's own list (if they have something new from the past week). **dry-run** reports how many people would get an email, without sending.
6. Switch it on for everyone:
   - `firebase-config.js`: set `weeklyEmail = true` (shows the on/off switch on the Account page).
   - GitHub repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**: `WEEKLY_EMAIL` = `on` (lets the Sunday run go ahead; without it, only manual runs do anything).
   - `privacy.html`: add back the section below, after "What we keep"; add `<li><b>Resend</b> delivers the weekly email, so it receives your email address and that email's contents.</li>` to "Other services"; add `<li><b>Stop the weekly email</b> with the unsubscribe link in any of them, or from the Account page.</li>` to "Your choices"; and update the date.
     ```html
     <h2>Weekly email</h2>
     <p>If shows on your list had new episodes in the past week that you haven't checked off, we email you a short list of them once a week, on Sundays. It goes to your account's email address and is sent through <b>Resend</b>, an email delivery service. We keep a record of when we last emailed you and whether you've switched the email off. Every email has an unsubscribe link, and you can switch it off or back on from your Account page.</p>
     ```

The repo is public, so its Actions logs are too: the job never prints anyone's email address.

## Custom domain
The site is served at **tvtracker.us** through GitHub Pages (the `CNAME` file holds the domain). DNS is on Cloudflare: four `A` records on `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and a `CNAME` on `www` → `jeremykholmes.github.io`, all set to **DNS only** (grey cloud) so GitHub can issue the HTTPS certificate.

## Files
- `index.html` — page shell
- `app.js` — the app (shows, episodes, views)
- `cloud.js` — accounts and per-user storage (Firebase)
- `CNAME` — the custom domain GitHub Pages serves the site on
- `firebase-config.js` — your Firebase project's web config
- `firestore.rules` — database security rules to paste into Firebase
- `email/` — the weekly email job (`weekly.mjs`; `digest.mjs` picks the episodes and writes the email), run by `.github/workflows/weekly-email.yml`
- `privacy.html`, `unsubscribe.html` — the privacy policy, and where the weekly email's unsubscribe link lands
- `manifest.webmanifest`, `icons/`, `sw.js` — what lets the site be installed as an app
- `styles.css` — styles (dark/light automatic, mobile bottom tab bar)
