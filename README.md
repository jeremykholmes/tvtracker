# TV Tracker

A static website for tracking the TV shows we're watching — no server, no build step. Hosted on GitHub Pages.

## Features
- **Add any show** from any broadcast network or streaming service (Netflix, HBO/Max, Hulu, Disney+, Apple TV+, Prime Video, NBC, CBS…), powered by the free [TVmaze](https://www.tvmaze.com) API.
- **My Shows** — what's up next for each show, how many episodes are left, and a one-tap **✓ Watched** button for the next episode.
- **Episode checklist** per season: check off single episodes, **Mark all** for a season, or **↑ Up to here** to catch up to where you are.
- **New episodes pulled automatically** — the app checks TVmaze for updated shows every few hours (or tap *Check for new episodes*), and flags shows with episodes that aired this week.
- **Upcoming** — air dates for the next 45 days across all your shows.
- **Discover** — series and season premieres in the next 7 days across US networks and streaming.
- **Sync across devices** via a JSON file committed to this repo (optional), plus export/import backups.

## Turn on the website
Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main`, folder `/ (root)` → Save.
The site appears at `https://<owner>.github.io/<repo>/` within a minute or two.

## Turn on syncing (so checkmarks follow you between phone, laptop, etc.)
1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Repository access: *Only select repositories* → this repo. Permissions: **Contents: Read and write**.
3. Open the site → **Settings** → paste the token → **Save & connect**. Repeat on each device.

Progress is stored in `data/tracker.json` on a separate `tracker-data` branch, so checkmarks don't trigger a site rebuild.
The token stays in that browser only. If this repo is public, the watch list file is public too.

## Files
- `index.html` — page shell
- `styles.css` — styles (dark/light automatic, mobile bottom tab bar)
- `app.js` — everything else
