# TV Tracker

A website for tracking the TV shows you're watching, with accounts so anyone can sign up and keep their own private list. Hosted on GitHub Pages; accounts and data run on a free Firebase project.

Live site: https://tvtracker.us

## Features
- **Landing page** — signed-out visitors see a welcome page with Continue with Google, Create free account and Sign in.
- **Accounts** — sign up with email/password or Google. Each person's shows and checkmarks are private and sync to every device they sign in on. Visitors can browse and search shows, but need to sign in (email or Google) to add shows or check off episodes.
- **Shared access** — from the Account page, share your list with someone by email as **Can view** (see what you're watching and where you're up to) or **Can edit** (also add/remove shows and check off episodes), and switch between the two or remove them any time. When they sign in with that email (Google, or an email account after confirming the address), they open your list from their Account page. Only the owner can change who has access or delete the account. With EmailJS set up (below), the person gets an invitation email and the owner is emailed when they join.
- **Add any show** from any broadcast network or streaming service (Netflix, HBO/Max, Hulu, Disney+, Apple TV+, Prime Video, NBC, CBS…), powered by the free [TVmaze](https://www.tvmaze.com) API.
- **My Shows** — what's up next for each show, episodes left, and a one-tap **✓ Watched** button.
- **Episode checklist** per season: check single episodes, **Mark all**, or **Watched Up To Here** to mark everything up to an episode watched.
- **New episodes pulled automatically** once a day.
- **Get the app** — install TV Tracker with its own icon on a phone (iPhone or Android) or computer. Chrome and Edge show their install prompt; other browsers get step-by-step instructions.
- **Upcoming** air dates for your shows, and **Discover** for this week's premieres.

## Switching on accounts (one-time, ~10 minutes)
1. Go to https://console.firebase.google.com → **Create a project** (e.g. `tvtracker`). Google Analytics is optional — you can turn it off.
2. **Build → Authentication → Get started.** Under *Sign-in method*, enable **Email/Password** and **Google**.
3. Authentication → **Settings → Authorized domains → Add domain** → `tvtracker.us` and `www.tvtracker.us`.
4. **Build → Firestore Database → Create database** → pick a location near you → start in **production mode**.
5. Firestore → **Rules** tab → replace everything with the contents of `firestore.rules` from this repo → **Publish**.
6. **Project settings** (gear icon) → *Your apps* → click the **`</>`** (Web) icon → register an app (any nickname, no Hosting needed) → copy the `firebaseConfig` values.
7. Paste those values into `firebase-config.js` in this repo and commit. The site picks it up within a minute or two.

The Firebase config values are designed to be public; `firestore.rules` is what keeps each user's data private (users can only read and write their own document, plus lists their owners have shared with them). The free Spark plan covers a household and well beyond.

## Email when someone signs up (optional)
1. Go to https://web3forms.com, enter the email address you want notifications sent to, and copy the access key they email you.
2. Paste it into `signupEmailKey` in `firebase-config.js` and commit.

You'll then get an email with the new person's name, email and sign-up method each time an account is created. The key is meant to be public; it can only send email to you.

## Sharing emails (optional)
Two emails go out through EmailJS (free tier: 200 emails/month):
- **Invitation** — the person you give access to gets an email right away, saying whose list it is and how to open it.
- **Joined** — you get an email the first time that person signs in with the shared email.

Setup:
1. Sign up at https://www.emailjs.com → **Email Services → Add New Service** → connect an email account (e.g. Gmail) → note the **Service ID**.
2. **Email Templates → Create New Template** for the invitation. Set **To Email** to `{{to_email}}`, a subject like `{{owner_name}} shared their TV Tracker list with you`, and a body such as:
   `{{owner_name}} ({{owner_email}}) gave you access to {{access}} their TV Tracker list. Sign in or create a free account at {{site}} with this email address, then open Account → Lists shared with you.` → save and note the **Template ID**.
3. Create a second template for the joined email. **To Email** `{{to_email}}`, a subject like `{{member_name}} joined your TV Tracker list`, and a body such as:
   `Hi {{to_name}}, {{member_name}} ({{member_email}}) just signed in and can now use your TV Tracker list. Manage access from your Account page at {{site}}.` → save and note its **Template ID**.
4. **Account → General** → copy your **Public Key**. Under **Account → Security**, add `tvtracker.us` to the allowed domains.
5. Fill in `shareEmail` in `firebase-config.js`: `serviceId`, `inviteTemplateId` (step 2), `templateId` (step 3) and `publicKey`, then commit.
6. Publish the latest `firestore.rules` in Firebase (the invited person needs permission to mark the share as joined).

## Custom domain
The site is served at **tvtracker.us** through GitHub Pages (the `CNAME` file holds the domain). DNS is on Cloudflare: four `A` records on `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`, and a `CNAME` on `www` → `jeremykholmes.github.io`, all set to **DNS only** (grey cloud) so GitHub can issue the HTTPS certificate.

## Files
- `index.html` — page shell
- `app.js` — the app (shows, episodes, views)
- `cloud.js` — accounts and per-user storage (Firebase)
- `CNAME` — the custom domain GitHub Pages serves the site on
- `firebase-config.js` — your Firebase project's web config
- `firestore.rules` — database security rules to paste into Firebase
- `manifest.webmanifest`, `icons/`, `sw.js` — what lets the site be installed as an app
- `styles.css` — styles (dark/light automatic, mobile bottom tab bar)
