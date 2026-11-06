# TV Tracker

A website for tracking the TV shows you're watching, with accounts so anyone can sign up and keep their own private list. Hosted as a Cloudflare Worker; accounts and data run on a free Firebase project.

Live site: https://tvtracker.us

## Features
- **Star ratings** on each show's page, 1 to 5. They're kept in the signed-in person's own account (`users/{uid}.ratings`), so people sharing a list each keep their own. The page also links to the show's Rotten Tomatoes search results; it doesn't show their score, because Rotten Tomatoes data is only licensed and OMDb doesn't return it for TV series. The page shows TVmaze's public score instead, when a show has one, with TVmaze's logo (loaded from their site) linking to the show there. A **Watch on Netflix** button appears when TVmaze's official link for the show goes to its Netflix title page (other services aren't linked yet). It also shows the **TV Tracker rating**: the logo and the average of everyone's stars. Individual ratings stay private; `email/rating-totals.mjs` runs hourly (`.github/workflows/rating-totals.yml`) and writes only a count and a sum to `showRatings/{showId}`, which anyone can read one show at a time and only that job can write.
- **Landing page** — signed-out visitors see a welcome page with Continue with Google, Create free account and Sign in.
- **Accounts** — sign up with email/password or Google. Each person's shows and checkmarks are private and sync to every device they sign in on. Visitors can browse and search shows, but need to sign in (email or Google) to add shows or check off episodes.
- **Shared access** — from the Account page, make a login for someone (their name, a username and a password) as **Can view** (see what you're watching and where you're up to) or **Can edit** (also add/remove shows and check off episodes), or **Kid**. They sign in with that username and password and go straight to your list. Change their access or remove the login any time. Only the owner can change who has access or delete the account.
- **Kid logins** — a login with **Kid** access sees only the shows the owner allows: up to a highest US TV rating (TV-Y … TV-14, from TMDB; default TV-PG). A show with no US rating uses the UK's, Canada's, Australia's or Germany's, converted to the closest US level (the strictest if several). Shows the limit hides — including any still without a rating — can be let through with **Allow**, and the owner can tick any show to hide (**What they see** on the Account page). Kids keep their own checkmarks but can't add or remove shows. They don't get Discover, and Add Show becomes **Search**: it lists only shows within their rating limit (leaving out any the owner hid), and they can open those shows' pages but not add them. The allowed shows are written to a separate copy (`users/{owner}/kids/{kid}`), and `firestore.rules` stops a kid login reading the owner's full list, so hidden shows never reach the kid's device. The owner's (or an editor's) app keeps the copy up to date as the list changes. Needs the latest `firestore.rules` published.
- **Add any show** from any broadcast network or streaming service (Netflix, HBO/Max, Hulu, Disney+, Apple TV+, Prime Video, NBC, CBS…), powered by the free [TVmaze](https://www.tvmaze.com) API.
- **My Shows** — what's up next for each show, episodes left, and a one-tap **✓ Watched** button.
- **Recommend to a friend** — a button on every show page shares a link (phone share sheet, or copied on a computer). The friend lands on the show with a "<your name> recommends this show" banner and an Add button; if they sign up first, the show is added once they're in.
- **Send a show in the app** — signed in, Recommend first offers to send the show straight to another TV Tracker account, found by their exact sign-in email or exact full name (no partial search; anyone can switch name search off on the Account page). It appears under **Shows recommended by friends** at the top of their My Shows (with a count on the My Shows tab), with Add, No thanks and Block. An added recommendation waits in its own **Recommended by friends** section (badged with who sent it) until you check off an episode, then moves to Up next; watching an episode straight from a recommendation adds it directly. Kid logins can't send or receive. A login made for someone else receives once you give it their real email (Account → Share your list → **＋ Email** on the login): it's then found by its full name or that email, gets the recommendations at the top of its My Shows (view-only logins can't add them), and gets the recommendation email at that address. Uses `directory/{email}`, `byName/{name}/people/{uid}` and `users/{uid}/inbox` — **needs the latest `firestore.rules` published**. Accounts appear once they next open the site; opening the Admin page also adds everyone at once.
- **Contact us** — a footer link opens a short form (name, email, message). Messages are saved in Firestore and listed on the owner's Admin page; set `contactEmailKey` (a free Web3Forms key) in `firebase-config.js` to also get each one by email. The owner answers from the Admin page with **Reply** (see [Replying to messages](#replying-to-messages)).
- **Future watch list** — add a show with **🕒 Watch later** (on search results, Discover and show pages) to save it for later. It sits in its own section at the bottom of My Shows and stays out of Up next, Upcoming and the weekly email. Check off any episode and it moves to Up next automatically (Undo puts it back). A show page also has **Start watching now** and **Move to Future watch list**.
- **Episode checklist** per season: check single episodes, **Mark all**, or **Watched Up To Here** to mark everything up to an episode watched.
- **New episodes pulled automatically** once a day. On a phone, **pull down** on My Shows to check right away.
- **Weekly email** *(built, not switched on yet)* — on Sundays, everyone with new episodes from the past week that they haven't checked off gets a short list of them by email. Unsubscribe link in every email; on/off switch on the Account page. See [Weekly email](#weekly-email) below.
- **Get the app** — install TV Tracker with its own icon on a phone (iPhone or Android) or computer. Chrome and Edge show their install prompt; other browsers get step-by-step instructions.
- **Upcoming** air dates for your shows, and **Discover** for this week's premieres.
- **Movies** — Add Show has a **TV shows / Movies** switch (kid logins search shows only). Movie results come from TMDB, each with ＋ Add or ✓ Seen it. Added movies appear on **My Movies**, its own page (`#/movies`), opened from the folder tabs at the top of My Shows (with a **＋ Add a Movie** button; My Shows has a matching **＋ Add a Show**): **To watch** with a Watched button, and watched ones folded into **Watched**. A movie page (`#/movie/<TMDB id>`) shows runtime, US rating, genres and where it's streaming in the US. A movie page also has **↗ Recommend to a friend**, which works like a show's: send it to someone's account (it lands in their Recommended by friends at the top of My Shows, ready to add to My Movies, and they get the recommendation email) or text/email a link (`#/movie/<id>/<your name>`, which greets them with who recommended it). Sent movies are inbox items with `kind: 'movie'` (needs the latest `firestore.rules`, published automatically). Saved in the account's `movies` field; hidden from kid logins. Movie search also finds streaming services: type one's name (Angel Studios, Netflix, Tubi…) to list the movies streaming on it in the US, most popular first, with **Show more**; every movie result says where it's streaming. Movies streaming on Angel Studios also come up in a normal title search, listed first (its whole catalog is kept on the device for a day). A movie that isn't on TMDB yet (a brand-new release) can be added by hand from the bottom of the results (**＋ Add “…” yourself**: title, year, where it's streaming); it has no movie page, and its card has a Remove button. Movie search also checks IMDb (its title suggestions, fetched by the Worker in `worker.js` at `/api/imdb`) and mixes any matches TMDB doesn't have into the same results list (where IMDb ranks them; a movie on both, same title and year, shows once); adding one uses TMDB's entry if TMDB has it by then, otherwise saves IMDb's title, year and poster (its card links to IMDb). A movie TMDB has no streaming info for is checked against Angel Studios' own site (`/api/angel`); if it's there, it shows as streaming on Angel Studios with a **▶ Watch on Angel** link. My Movies has its own **Where to watch** filter (same buttons and icons as My Shows', separate from it): each streaming service your movies are on, with how many (TMDB's service names are matched to TVmaze's, e.g. Amazon Prime Video → Prime Video).
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

## Recommendation emails
**Status: on.** `.github/workflows/rec-email.yml` runs `email/recs.mjs` every 15 minutes. When someone recommends a show or movie to an account with a real email address, it emails them (several waiting at once go in one email) and marks each recommendation `emailed`. Each email has a link to switch these emails off (`unsubscribe.html?…&e=recs`), and there's a switch on the Account page. Recommendations more than 2 days old are never emailed.

To switch it on: do steps 1–3 of [Weekly email](#weekly-email) (Resend and the two secrets), then set `recEmail = true` in `firebase-config.js` (shows the Account page switch), and add a line about Resend to `privacy.html`. Actions → **Recommendation emails → Run workflow** checks it right away.

## Removing accounts
The Admin page has a **Remove** button on every account and every login made for others (not your own). It locks the account out straight away (the database rules refuse any account listed in `removals/{uid}`), and `.github/workflows/remove-accounts.yml` runs `email/remove-accounts.mjs` hourly to delete its sign-in and data, then marks it done. Needs the `FIREBASE_SERVICE_ACCOUNT` secret (see Weekly email) and the latest `firestore.rules` published. To finish a removal right away: Actions → **Remove accounts → Run workflow**.

## Replying to messages
Each Contact us message on the Admin page has a **Reply** button. The Worker (`/api/reply`, site owner only) emails the reply through Resend from `updates@tvtracker.us`, with the person's message quoted underneath. If they answer it, their email goes to the owner's address (`ADMIN_EMAIL` in `worker.js`), which they can see. Sent replies are saved on the message and shown under it.

One-time setup: in **Resend → API Keys**, create a key with sending access. In the **Cloudflare dashboard → Workers & Pages → tvtracker → Settings → Variables and Secrets → Add**, choose type **Secret**, name it `RESEND_API_KEY` and paste the key. (The GitHub secret with the same name is only for the GitHub Actions emails; the Worker can't read it.)

## Website traffic
The Admin page has a **Website traffic** panel from Google Analytics (property with tag `G-7SHW9HZXCV`, set up in `index.html`): visitors on the site right now, visitors and page views for today / last 7 days / last 30 days / all time, and a bar chart of visitors per day for the last 30 days. The Worker (`worker.js`, `/api/traffic`) fetches the numbers with Google's Analytics Data API, and only answers the site owner's signed-in account. Until the setup below is done the panel says it isn't connected yet.

One-time setup:
1. **Google Cloud** (https://console.cloud.google.com, project `tv-tracker-6135d` or any other): **APIs & Services → Library** → search **Google Analytics Data API** → **Enable**.
2. **IAM & Admin → Service accounts → Create service account** (any name, e.g. `analytics-reader`; skip the optional roles) → open it → **Keys → Add key → Create new key → JSON**. This downloads a JSON file. Copy the account's email (`…@….iam.gserviceaccount.com`).
3. **Google Analytics** (https://analytics.google.com) → **Admin** (gear) → **Property access management** → **＋ → Add users** → paste the service account's email, role **Viewer**, uncheck "Notify", **Add**.
4. Analytics **Admin → Property details**: copy the **Property ID** (a number like `456789012` — not the `G-…` ID).
5. **Cloudflare dashboard → Workers & Pages → tvtracker → Settings → Variables and Secrets → Add**, type **Secret**:
   - `GA_PROPERTY_ID` = the Property ID
   - `GA_SERVICE_ACCOUNT` = the whole JSON file's contents
   Then **Deploy**. Delete the downloaded JSON file afterwards. Secrets stay put across the automatic deploys from `main`.
   Add them under **Variables and Secrets** at the top of Settings — **not** under *Build → Variables and secrets*, which the live site can't see.

Below it, **More analytics** (since Nov 5, 2026, then the last 30 days) shows:
- **What people did** — sign-ups, shows and movies added, episode check-offs, recommendations sent (in the app or by link) and app installs. `app.js` sends these to Google Analytics as events (`sign_up`, `add_show`, `add_movie`, `episode_watched`, `recommend`, `app_install`), recorded from Nov 2, 2026. The whole section counts from Nov 5, 2026 until the normal 30 days is shorter (`MORE_FROM` in `worker.js`, `COUNTS_FROM` in `app.js`).
- Where visitors come from, referring sites, devices, new vs. returning, countries and cities.
- **Most-viewed pages** — from a `page_open` event sent on every page change in the app (its address includes the `#/…` page).
- **Clicks out to other sites** — Google Analytics' automatic outbound-click events (Admin → Data streams → Enhanced measurement → Outbound clicks must be on, which it is by default).
- **Google search** (Search Console) — clicks from Google, times shown in results, click-through rate, average position, top searches and pages. Runs 2–3 days behind. One-time setup: in Google Cloud (same project as the service account) enable the **Google Search Console API**; in Search Console → **Settings → Users and permissions → Add user**, add the service account's email with **Restricted** permission.

Tapping any of the **What people did** numbers lists the accounts behind it (name, email, count and last date). Analytics can't say who, so this comes from Firestore: `activity/{uid}` holds per-day counts for each action, written by the account's own app (`cloud.js`, `noteAction`; counts only, never titles), readable only by the admin (`firestore.rules`). `email/remove-accounts.mjs` (hourly) fills in `created` from Firebase sign-in and clears days older than 40. Sign-ups are exact. Shows and movies before recording began are estimates from the dates on each list, marked ≈. Check-offs, recommendations and app use only exist from then on, and the panel says so.

The site owner's own devices aren't counted: once the admin account signs in on a device, `app.js` turns Google Analytics off there (remembered as `tvt.noga`, checked in `index.html`).

## Show and movie pages for Google
The app's pages live after a `#` (`#/show/44778`), which Google ignores, so `seo.js` (run by the Worker) gives every show and movie a real page Google can list: `/show/<TVmaze id>-<name>` and `/movie/<TMDB id>-<name>` (e.g. `/show/44778-severance`). Each has the title, description, poster, seasons with every episode's name and air date, the next episode, where it airs or streams, cast (movies), link-preview tags and Google structured data (`TVSeries` / `Movie`), plus buttons into the app. A wrong or missing name in the address redirects to the right one. Pages are cached by Cloudflare for 6 hours.

**Recommend → share a link** now sends these addresses with `?r=<your name>`, so text and social previews show the show's poster; opening one goes straight to the app with the "recommends" banner.

**Sitemaps**: `/sitemap.xml` (made by the Worker) lists `/sitemaps/site.xml`, `/sitemaps/shows-0.xml` … `shows-399.xml` (TVmaze's shows, 250 per file, only popular ones — weight 80+) and `/sitemaps/movies-1.xml` … `movies-25.xml` (TMDB's popular and top-rated movies). In Search Console → **Sitemaps**, submit `sitemap.xml` once.

## Import from other apps
Account page → **Import from another app**. Upload an export from **Simkl** (its free .zip backup from Apps → Export → Backup, or its .csv backup), **Trakt** (.zip or .json files) or **Letterboxd** (.zip) — TV Time's old export still works for anyone who saved one before it closed in July 2026, or a .csv with a Title column, or type a list of titles. `importer.js` reads the files on the device (it opens .zip files itself); `app.js` (`runImport`) matches shows to TVmaze by TVDB/IMDb id or name and movies to TMDB by id, IMDb id or title + year, then adds shows (watchlist-only ones go to the Future watch list), checks off watched episodes, and adds movies as seen or to watch. Anything it can't find is listed at the end. Counted in Google Analytics as an `import` event.

## New this week pages
`/new` and `/new/<service>` (netflix, hulu, disney-plus, max, prime-video, apple-tv, peacock, paramount-plus), made by `seo.js` from TVmaze's schedules for this week (Monday–Sunday, New York time) and TMDB's newest movies on each service: new series, season premieres and new episodes, each linking to its show page. Cached 3 hours, listed in the sitemap, and linked from every show/movie page's footer, the home page and Discover.

## Hosting
The site is a Cloudflare Worker named `tvtracker` that serves the repo's files as a static site, at **tvtracker.us** (and tvtracker.jeremykholmes.workers.dev). `wrangler.jsonc` sets it up; `.assetsignore` lists the repo files that aren't part of the website (workflows, email jobs, docs, `firestore.rules`) so they're never served.

Deploys are automatic: the Worker is connected to this repo (Cloudflare dashboard → **Workers & Pages → tvtracker → Settings → Build**), so every push to `main` runs `npx wrangler deploy` and goes live within a minute or two. Build logs are on the Worker's **Deployments** tab. To deploy by hand instead, run `npx wrangler deploy` in the repo folder.

## Files
- `index.html` — page shell
- `app.js` — the app (shows, episodes, views)
- `cloud.js` — accounts and per-user storage (Firebase)
- `wrangler.jsonc`, `.assetsignore`, `worker.js` — the Cloudflare Worker that serves the site, the files it leaves out, and its `/api/imdb` IMDb search and `/api/angel` Angel Studios check
- `firebase-config.js` — your Firebase project's web config
- `firestore.rules` — database security rules to paste into Firebase
- `email/` — the weekly email job (`weekly.mjs`; `digest.mjs` picks the episodes and writes the email), run by `.github/workflows/weekly-email.yml`
- `sitemap.xml`, `robots.txt` — tell search engines about the site's real pages (the homepage and the privacy policy; `#/…` views aren't separate pages to Google)
- `privacy.html`, `unsubscribe.html` — the privacy policy, and where the weekly email's unsubscribe link lands
- `manifest.webmanifest`, `icons/`, `sw.js` — what lets the site be installed as an app
- `styles.css` — styles (dark/light automatic, mobile bottom tab bar)
