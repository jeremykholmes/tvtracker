/* TV Tracker — static site. Show data: TVmaze API (all broadcast networks + streaming services).
   Accounts + per-user watch progress: Firebase (see cloud.js). Guests save on the device only. */
const cloud = await import('./cloud.js' + new URL(import.meta.url).search);   // same fresh version as app.js
const config = await import('./firebase-config.js' + new URL(import.meta.url).search);

const API = 'https://api.tvmaze.com';
const K = { state: 'tvt.state.v1', cache: 'tvt.cache.v1', meta: 'tvt.meta.v1' };
const DAY = 864e5, HOUR = 36e5, STALE = 6 * HOUR, CHECK_EVERY = DAY;   // new episodes are checked for once a day

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const strip = h => h ? (new DOMParser().parseFromString(h, 'text/html').body.textContent || '').trim() : '';
const pad = n => String(n ?? 0).padStart(2, '0');
const code = e => `Season ${e.s}, Episode ${e.n}`;
const twoLines = e => `<span class="code">Season ${e.s}</span><br><span class="code">Episode ${e.n}</span>`;   // season, then episode below
const STREAMS_ON = { CBS: 'Paramount+', NBC: 'Peacock', ABC: 'Hulu', FOX: 'Hulu', Fox: 'Hulu' };   // network -> streaming service that also carries its shows
const STREAMS_SHOW = { 'FOX:Doc': 'Hulu / Netflix' };   // per-show exceptions, keyed "network:show name"
const channel = (n, name) => { const x = STREAMS_SHOW[`${(n || '').toUpperCase()}:${name}`] || STREAMS_ON[n]; return n && x ? `${n} / ${x}` : (n || ''); };
const SAME_SERVICE = { HBO: 'HBO Max', Max: 'HBO Max' };   // names grouped together in the My Shows filter
const services = s => [...new Set(channel(s?.network, s?.name).split(' / ').filter(Boolean).map(n => SAME_SERVICE[n] || n))];   // every network/streamer a show is on

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } }

/* ---------- state ---------- */
// state.shows[id]   = { id, name, image, network, removed, later, t }   later: on the Future watch list (not started yet)
// state.watched[ep] = { w: bool, t }      (last-write-wins per key, so devices merge cleanly)
// state.movies[id]  = { id, name, image, year, w, removed, t }   id: TMDB movie id; w: watched
function norm(s) { s = s && typeof s === 'object' ? s : {}; return { v: 1, shows: s.shows || {}, watched: s.watched || {}, movies: s.movies || {} }; }
let user = null;                        // { uid, email, name } when signed in
let inbox = [];                         // shows other accounts sent you, newest first: { id, from, fromName, fromEmail, show, note, t }
let blocked = {};                       // accounts you blocked from sending you shows: uid -> { name, email }
let findable = true;                    // others can find you by name when sending a show
// Same logo + text as the splash in index.html, shown while the sign-in check finishes.
const SPLASH = '<div class="splash"><img src="icons/logo.svg" alt=""><p>Loading your shows…</p></div>';
let authReady = !cloud.configured;       // false until Firebase reports who's signed in
const stateKey = () => user ? `${K.state}.${cloud.activeUid() || user.uid}${isKid() ? '.kid.' + user.uid : ''}` : K.state;
// For a login someone made for you: their list ({ uid, name, role }) while it's the one open.
const sharedOpen = () => user?.linked && cloud.activeUid() === user.linked.uid ? user.linked : null;
// A kid login: sees only the shows the list's owner allows for it, can't add or remove shows, and keeps its own checkmarks.
const isKid = () => sharedOpen()?.role === 'kid';
let state = norm(load(K.state, null));
let cache = load(K.cache, {});           // showId -> { t, show, episodes }  (shared TVmaze data, not per user)
let meta = load(K.meta, { lastRefresh: 0 });
const openSeasons = {};                  // showId -> Set of open season numbers
const showOldSeasons = new Set();        // showIds whose earlier fully-watched seasons are expanded

const followed = () => Object.values(state.shows).filter(s => !s.removed);
const isFollowed = id => !!(state.shows[id] && !state.shows[id].removed);
const isWatched = id => !!(state.watched[id] && state.watched[id].w);
// Future watch list: shows added to watch later. They stay out of Up next and Upcoming until an episode is checked off,
// which moves them onto the main list for good.
const started = id => !!cache[id]?.episodes.some(e => isWatched(e.id));
const isLater = id => isFollowed(id) && !!state.shows[id].later && !started(id);
const current = () => followed().filter(s => !isLater(s.id));   // the shows being watched: everything but the Future watch list

function persist() { save(stateKey(), state); }
function setWatched(ids, w) {
  const t = now();
  ids.forEach(id => { state.watched[id] = { w, t }; queue('watched', id, state.watched[id]); });
  const moved = w ? startShows(ids) : [];
  if (w) startRecommended(ids);
  persist();
  if (w) collapseFinished(ids);
  return moved;   // ids of shows that just left the Future watch list
}
const movedNote = moved => moved.length ? ` — ${moved.map(id => showInfo(id)?.name || 'show').join(', ')} moved to Up next` : '';
// Checking off an episode of a show on the Future watch list moves it onto the main list (Up next, Upcoming).
function startShows(ids) {
  const moved = new Set();
  for (const id of ids) {
    const sid = findEp(id)?.sid, s = state.shows[sid];
    if (!s || !s.later || s.removed || moved.has(sid)) continue;
    s.later = false; s.t = now(); queue('shows', sid, s); moved.add(sid);
  }
  return [...moved];
}
// Checking off an episode of a show a friend recommended puts it on My Shows (Up next) and takes it out of
// Shows recommended by friends.
function startRecommended(epIds) {
  if (!inbox.length) return;
  const sids = new Set(epIds.map(id => findEp(id)?.sid).filter(Boolean));
  for (const m of inbox) {
    if (!sids.has(m.show.id)) continue;
    if (!isFollowed(m.show.id)) follow(cache[m.show.id]?.show || m.show);
    cloud.dismissShow(m.id).catch(x => console.warn('inbox', x));
  }
}
// A season whose aired episodes are now all watched folds shut on the show page.
function collapseFinished(ids) {
  for (const id of ids) {
    const f = findEp(id), open = f && openSeasons[f.sid];
    if (!open || !open.has(f.e.s)) continue;
    if (f.c.episodes.filter(e => e.s === f.e.s && aired(e)).every(e => isWatched(e.id))) open.delete(f.e.s);
  }
}
// rec: name of the friend who recommended it; with later, it waits under Recommended by friends until an episode is checked off.
function follow(s, later, rec) {
  if (isKid()) return;
  state.shows[s.id] = { id: s.id, name: s.name, image: s.image || '', network: s.network || '', removed: false, later: !!later, t: now(),
    ...(rec ? { rec: String(rec).slice(0, 100) } : {}) };
  queue('shows', s.id, state.shows[s.id]); persist();
}
function unfollow(id) {
  if (isKid()) return;
  const s = state.shows[id];
  if (s) { s.removed = true; s.t = now(); queue('shows', id, s); persist(); }
}
function showInfo(id) { return cache[id]?.show || state.shows[id] || null; }

/* ---------- TVmaze ---------- */
async function api(path) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + path);
    if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('TVmaze error ' + r.status);
    return r.json();
  }
  throw new Error('TVmaze is busy, try again in a moment');
}
function trimShow(s) {
  return {
    id: s.id, name: s.name, image: s.image?.medium || s.image?.original || '',
    network: s.network?.name || s.webChannel?.name || '', status: s.status || '',
    premiered: s.premiered || '', schedule: s.schedule || null, genres: s.genres || [],
    summary: strip(s.summary).slice(0, 700), updated: s.updated || 0, url: s.url || '',
    imdb: s.externals?.imdb || '', tvdb: s.externals?.thetvdb || null
  };
}
function trimEp(e) {
  return { id: e.id, s: e.season, n: e.number, name: e.name || 'TBA', airdate: e.airdate || '',
    airstamp: e.airstamp || '', runtime: e.runtime || null, summary: strip(e.summary).slice(0, 450) };
}
async function fetchShow(id) {
  const j = await api(`/shows/${id}?embed=episodes`);
  if (!j) return null;
  const episodes = (j._embedded?.episodes || []).filter(e => e.number != null).map(trimEp);
  cache[id] = { t: now(), show: trimShow(j), episodes };
  save(K.cache, cache);
  return cache[id];
}

let refreshing = null, refreshFailedAt = 0, redrawTimer = null;
const redrawSoon = () => { clearTimeout(redrawTimer); redrawTimer = setTimeout(() => render(), 150); };
function refreshAll(manual, quiet) {   // quiet: no toast at the end (the opening refresh shows its own bubble)
  if (refreshing) return refreshing;
  if (!manual && now() - refreshFailedAt < 30e3) return Promise.resolve();   // don't hammer TVmaze after a failure
  refreshing = (async () => {
    let n = 0, total = 0, failed = 0;
    try {
      busy('Checking for new episodes…');
      const ids = followed().map(s => s.id);
      const age = now() - (meta.lastRefresh || 0);
      let todo = ids.filter(id => !cache[id] || recheck(id));
      if (ids.length) {
        if (!meta.lastRefresh || age > 27 * DAY) todo = ids;
        else {
          const since = age > 6 * DAY ? 'month' : age > 20 * HOUR ? 'week' : 'day';
          const upd = await api(`/updates/shows?since=${since}`) || {};
          for (const id of ids) if (upd[id] && (!cache[id] || upd[id] > (cache[id].show.updated || 0))) todo.push(id);
        }
      }
      // Shows without episodes first, so My Shows fills in quickly; 4 downloads at a time, each shown as soon as it lands.
      const tried = new Set(), queue = [...new Set(todo)].sort((a, b) => !!cache[a] - !!cache[b]);
      while (queue.length) {
        total += queue.length;
        await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let id; (id = queue.shift()) !== undefined;) {
            tried.add(id);
            try { await fetchShow(id); } catch { failed++; }
            busy(`Updating shows ${++n}/${total}…`); redrawSoon();
          }
        }));
        queue.push(...followed().map(s => s.id).filter(id => !cache[id] && !tried.has(id)));   // shows that arrived meanwhile
      }
      if (failed) { refreshFailedAt = now(); toast(`Couldn't update ${failed} show${failed > 1 ? 's' : ''} — will try again shortly`); }
      else { meta.lastRefresh = now(); save(K.meta, meta); }
      if (manual && !quiet && !failed) toast(n ? `Updated ${n} show${n > 1 ? 's' : ''}` : 'Everything is up to date');
    } catch (e) { refreshFailedAt = now(); toast('Refresh failed: ' + e.message); }
    finally { busy(false); refreshing = null; clearTimeout(redrawTimer); render(); }
    return { n, failed };
  })();
  return refreshing;
}

// Running shows with nothing scheduled are re-downloaded once a day, so a newly announced season shows up.
function recheck(id) {
  const c = cache[id];
  return !!c && now() - c.t > DAY && !/ended/i.test(c.show.status || '') && !c.episodes.some(e => !aired(e) && e.airdate);
}

/* ---------- progress ---------- */
function airTime(e) {
  if (e.airstamp) return Date.parse(e.airstamp);
  if (e.airdate) return Date.parse(e.airdate + 'T20:00:00');
  return Infinity;
}
const aired = e => airTime(e) <= now();
function progress(id) {
  const c = cache[id]; if (!c) return null;
  const airedEps = c.episodes.filter(aired);
  const watched = airedEps.filter(e => isWatched(e.id)).length;
  const next = airedEps.find(e => !isWatched(e.id)) || null;
  let upcoming = c.episodes.find(e => !aired(e) && e.airdate && !isWatched(e.id)) || null;   // skips one checked off early on its air day
  // A new season: that season's first episode airs later or aired within the last 2 weeks.
  if (upcoming) upcoming = { ...upcoming, newSeason: Math.min(...c.episodes.filter(e => e.s === upcoming.s).map(airTime)) > now() - 14 * DAY };
  const fresh = airedEps.filter(e => !isWatched(e.id) && now() - airTime(e) < 7 * DAY).length;
  let last = state.shows[id]?.t || 0;
  for (const e of c.episodes) { const w = state.watched[e.id]; if (w && w.t > last) last = w.t; }
  const latest = airedEps.length ? airTime(airedEps[airedEps.length - 1]) : 0;   // when the newest episode aired
  return { total: airedEps.length, watched, unwatched: airedEps.length - watched, next, upcoming, fresh, last, latest };
}
function findEp(epId) {
  for (const [sid, c] of Object.entries(cache)) { const e = c.episodes.find(x => x.id === epId); if (e) return { sid: +sid, e, c }; }
  return null;
}

/* ---------- formatting ---------- */
function fmtDate(e, withTime) {
  const t = airTime(e); if (!isFinite(t)) return 'TBA';
  const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / DAY);
  let s = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
  if (diff > 1 && diff < 7) s = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (withTime && e.airstamp) s += ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return s;
}
function ago(t) {
  if (!t) return 'never'; const m = Math.round((now() - t) / 6e4);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
function poster(s, href) {
  const inner = s?.image ? `<img src="${esc(s.image)}" alt="" loading="lazy">`
    : `<div class="noimg">${esc((s?.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2))}</div>`;
  return href ? `<a class="poster" href="${href}">${inner}</a>` : `<div class="poster">${inner}</div>`;
}

/* ---------- views ---------- */
const views = {};

// Adding shows and checking episodes requires an account.
const needsAccount = () => cloud.configured && !user;
// changesList: adding or removing shows, which a kid login can't do (it can still check off episodes).
function requireAccount(changesList) {
  if (!needsAccount()) {
    const sh = sharedOpen();
    if (sh?.role === 'view') { toast(`You can view ${sh.name}'s list but not change it`); return false; }
    if (changesList && sh?.role === 'kid') { toast(`${sh.name} chooses the shows on your list`); return false; }
    return true;
  }
  if (!authReady) { toast('One moment — checking your sign-in…'); return false; }
  try { sessionStorage.setItem('tvt.return', location.hash || '#/'); } catch { }
  toast('Sign in or create a free account to add shows');
  location.hash = '#/login/create';
  return false;
}
const GOOGLE_G = `<svg class="gsvg" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function signInWall(title) {
  if (!authReady) { app.innerHTML = SPLASH; return; }
  app.innerHTML = `<div class="empty"><h1>${title}</h1>
    <p>Create a free account or sign in with Google to add shows and check off episodes. Your list stays private and follows you to every device.</p>
    <div class="actions" style="justify-content:center">
      <button class="btn gbtn" data-act="google">${GOOGLE_G} Continue with Google</button>
      <a class="btn primary" href="#/login/create">Create account</a></div>
    <p class="sub" style="margin-top:18px">Already have an account? <a href="#/login">Sign in</a> · or <a href="#/search">browse shows</a> first</p></div>`;
}

// Signed-out home page: a marketing-style landing page with sign-in / sign-up.
views.landing = () => {
  if (!authReady) { app.innerHTML = SPLASH; return; }
  document.body.classList.add('landing');
  const cta = `<div class="lp-cta">
      <button class="btn gbtn lg" data-act="google">${GOOGLE_G} Continue with Google</button>
      <a class="btn primary lg" href="#/login/create">Create free account</a></div>`;
  const nets = ['Netflix', 'HBO Max', 'Hulu', 'Disney+', 'Apple TV+', 'Prime Video', 'Peacock', 'Paramount+', 'NBC', 'CBS', 'ABC', 'FX'];
  const feats = [
    ['▤', 'One list for everything', 'Every show you watch, from every network and streaming service, together in one place.'],
    ['✓', 'One-tap progress', 'Mark the next episode watched, check off a whole season, or catch up to any point instantly.'],
    ['◷', 'Never miss an air date', 'See exactly when new episodes drop, with fresh episodes pulled in automatically.'],
    ['✦', 'Discover what\'s new', 'Browse this week\'s premieres and returning seasons across broadcast and streaming.'],
    ['⇄', 'Synced everywhere', 'Start on your phone, pick up on your laptop. Your list follows you to every device.'],
    ['◉', 'Private by design', 'Your watch history belongs to you. Only you can see your shows and checkmarks.']
  ];
  const mock = (m, i) => { const [pct, badge] = LP_DECOR[i]; return `<div class="mk-card"><div class="mk-poster p${i + 1}"${m.img ? '' : ` data-lp="${esc(m.name)}"`}>${m.img ? `<img src="${esc(m.img)}" alt="">` : ''}${badge ? `<span class="badge">${badge}</span>` : ''}</div>
    <div class="mk-body"><b>${esc(m.name)}</b><span>${esc(m.net)}${m.ep ? ' · ' + esc(m.ep) : ''}</span>
    <div class="bar"><i style="width:${pct}%"></i></div><span class="mk-btn"><span class="wbox"></span>Watched</span></div></div>`; };
  const upnext = top => `<div class="mk-head">Up next · 3</div>${weekPicks(top).map(mock).join('')}`;
  app.innerHTML = `<div class="lp">
  <section class="lp-hero">
    <div class="lp-copy">
      <span class="eyebrow">Your personal TV guide</span>
      <h1>Never lose your place in a show again.</h1>
      <p class="lead">TV Tracker keeps every series you watch organized — what's next, what's new, and when it airs — across every network and streaming service.</p>
      ${cta}
      <p class="lp-signin">Already have an account? <a href="#/login">Sign in</a></p>
    </div>
    <div class="lp-visual" aria-hidden="true">
      <div class="mk-window"><div class="mk-dots"><i></i><i></i><i></i></div>
        <div id="lpUpnext">${upnext(lpTopCached() || LP_TOP_FALLBACK)}</div>
      </div>
    </div>
  </section>
  <section class="lp-nets"><p>Track shows from every network and streamer</p>
    <div class="lp-netlist">${nets.map(n => `<span>${n}</span>`).join('')}</div></section>
  <section class="lp-sec"><span class="eyebrow">Popular shows</span><h2 class="lp-h2">Keep up with the shows everyone's watching</h2>
    <div class="lp-posters">${LP_SHOWS.map(n => `<a class="lp-pc" href="#/search"><span class="lp-pimg" data-lp="${esc(n)}"><span class="noimg">${esc(n.split(/\s+/).map(w => w[0]).join('').slice(0, 2))}</span></span><b>${esc(n)}</b></a>`).join('')}</div></section>
  <section class="lp-sec"><span class="eyebrow">Features</span><h2 class="lp-h2">Everything you need to keep up</h2>
    <div class="lp-feats">${feats.map(([i, t, d]) => `<div class="lp-feat"><span class="lp-ico">${i}</span><h3>${t}</h3><p>${d}</p></div>`).join('')}</div></section>
  <section class="lp-sec lp-share">
    <div class="lp-share-copy"><span class="eyebrow">Share with friends &amp; family</span>
      <h2 class="lp-h2">See what the people you know are watching</h2>
      <p class="lead">Make a login for anyone in a few seconds — just a name, username and password. Give them <b>view-only</b> access so they can see what you're watching and where you're up to, or let them <b>edit</b> so you can keep a household list together. You decide, and you can change it or remove access any time.</p>
      <ul class="lp-checks"><li>View-only or edit access, per person</li><li>Great for households, couples and watch-alongs</li><li>Your list stays private to the people you choose</li></ul></div>
    <div class="lp-visual" aria-hidden="true"><div class="mk-window lp-share-mk"><div class="mk-dots"><i></i><i></i><i></i></div>
      <div class="mk-head">Logins for your list</div>
      ${[['Sam', 'Username: sam', 'Can view'], ['Jordan', 'Username: jordan', 'Can edit'], ['Riley', 'Username: riley', 'Can view']].map(([n, e, r]) =>
        `<div class="mk-mem"><span class="av">${n[0]}</span><span><b>${n}</b><br><small>${e}</small></span><span class="mk-role${r === 'Can edit' ? ' on' : ''}">${r}</span></div>`).join('')}
    </div></div></section>
  <section class="lp-sec"><span class="eyebrow">How it works</span><h2 class="lp-h2">Up and running in a minute</h2>
    <ol class="lp-steps">
      <li><b>Create your account</b><p>Sign up with Google in one click, or use your email.</p></li>
      <li><b>Add your shows</b><p>Search any series and add it to your list.</p></li>
      <li><b>Check off as you watch</b><p>We'll keep track of what's next and what's new.</p></li>
    </ol></section>
  <section class="lp-band"><h2 class="lp-h2">Start tracking your shows today</h2>
    <p>Free to use. No credit card required.</p>${cta}
    <p class="lp-signin">Already have an account? <a href="#/login">Sign in</a> · or <a href="#/search">browse shows</a> first</p></section>
</div>`;
  lpPosters();
  if (!lpTopCached()) lpTop().then(top => {
    const box = document.querySelector('#lpUpnext');
    if (top && box && document.body.classList.contains('landing')) { box.innerHTML = upnext(top); lpPosters(); }
  });
};

// Real shows for the landing page. Posters come from TVmaze and are cached on the device for a week.
// "Up next" shows 3 of this week's top 10 (the most popular shows TVmaze has airing lately), a different 3 each week.
const LP_DECOR = [[62, '2 new'], [88, ''], [24, '1 new']];
const LP_TOP_FALLBACK = [['Severance', 'Apple TV+'], ['The Last of Us', 'HBO'], ['Abbott Elementary', 'ABC'], ['The Bear', 'FX'], ['Stranger Things', 'Netflix'],
  ['The White Lotus', 'HBO'], ['Only Murders in the Building', 'Hulu'], ['Slow Horses', 'Apple TV+'], ['Squid Game', 'Netflix'], ['Andor', 'Disney+']].map(([name, net]) => ({ name, net }));
const K_TOP = 'tvt.lptop.v1';
const weekNo = () => Math.floor((now() + 3 * DAY) / (7 * DAY));   // weeks start on Monday
const weekPicks = top => { const o = (weekNo() * 3) % top.length; return [0, 1, 2].map(i => top[(o + i) % top.length]); };
function lpTopCached() { const c = load(K_TOP, null); return c && c.week === weekNo() && c.shows.length >= 3 ? c.shows : null; }
async function lpTop() {
  const days = [0, 1, 2].map(d => new Date(now() - d * DAY).toLocaleDateString('en-CA'));   // YYYY-MM-DD
  const lists = await Promise.all(days.flatMap(d => [`/schedule?country=US&date=${d}`, `/schedule/web?date=${d}`])
    .map(path => api(path).catch(() => null)));
  const best = {};
  for (const e of lists.flat()) {
    const s = e?.show || e?._embedded?.show;
    if (!s?.image || e.number == null || !['Scripted', 'Animation', 'Reality', 'Documentary'].includes(s.type)) continue;
    if (!best[s.id] || e.airstamp > best[s.id].e.airstamp) best[s.id] = { s, e };
  }
  const top = Object.values(best).sort((a, b) => (b.s.weight || 0) - (a.s.weight || 0)).slice(0, 10).map(({ s, e }) => ({
    id: s.id, name: s.name, net: s.network?.name || s.webChannel?.name || '', ep: `S${e.season} · E${e.number}`, img: s.image.medium || s.image.original
  }));
  if (top.length < 3) return null;
  save(K_TOP, { week: weekNo(), shows: top });
  return top;
}
const LP_SHOWS = ['Stranger Things', 'The White Lotus', 'Ted Lasso', 'Wednesday', 'Only Murders in the Building', 'Squid Game', 'Slow Horses', 'Andor', 'Yellowjackets', 'The Boys', 'Reacher', 'Shrinking'];
const K_LP = 'tvt.lp.v2';
const lpImgs = load(K_LP, {});
let lpLoading = null;
function lpPosters() {
  const imgs = lpImgs;
  const paint = () => document.querySelectorAll('[data-lp]').forEach(el => {
    const { img: src, id } = imgs[el.dataset.lp] || {};
    if (id && el.parentElement.matches('a.lp-pc')) el.parentElement.href = '#/show/' + id;
    if (!src || el.dataset.src === src) return;
    el.dataset.src = src;
    const im = new Image();
    im.alt = ''; im.src = src;
    im.onload = () => { el.querySelector('.noimg')?.remove(); el.prepend(im); };
  });
  paint();
  if (lpLoading) return lpLoading.then(paint);
  const todo = [...new Set([...document.querySelectorAll('[data-lp]')].map(el => el.dataset.lp))].filter(n => !imgs[n]?.img || now() - imgs[n].t > 7 * DAY);
  // A few at a time keeps well under TVmaze's rate limit; failures aren't saved, so they're retried next visit.
  lpLoading = (async () => {
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map(async n => {
        try {
          const r = await api('/search/shows?q=' + encodeURIComponent(n));
          const hit = (r || []).map(x => x.show).find(x => x.image) || null;
          if (hit) imgs[n] = { id: hit.id, img: hit.image.medium || hit.image.original, t: now() };
        } catch (e) { console.warn('poster', n, e); }
      }));
      save(K_LP, imgs);
      paint();
    }
  })().finally(() => { lpLoading = null; });
  return lpLoading;
}

const K_NET = 'tvt.net', K_DAY = 'tvt.day', DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// 0–6 (Sunday–Saturday, local time) for when a show's next episode airs, or its latest one aired; null if unknown.
function airDay(r) {
  const t = r.p?.upcoming ? airTime(r.p.upcoming) : r.p?.latest;
  if (t && isFinite(t)) return new Date(t).getDay();
  const d = DAYS.findIndex(x => (r.s?.schedule?.days || [])[0]?.startsWith(x));   // TVmaze's schedule, while episodes load
  return d < 0 ? null : d;
}
// Mid-season: the show's next episode is listed and airs within the coming week, so it isn't waiting for a new season.
const inSeason = r => !!(r.p?.upcoming && airTime(r.p.upcoming) < new Date().setHours(0, 0, 0, 0) + 8 * DAY);
// The day a show is filed under on the "Airs on" filter. Today only lists shows that are mid-season; one between
// seasons (or that has finished) whose last or next episode falls on today's weekday is left out of it.
function filterDay(r) {
  const d = airDay(r);
  return d === new Date().getDay() && !inSeason(r) ? null : d;
}
// Website of each network/streamer, used to show its app icon on the My Shows filter (or our own icon file). Others show their name.
const NET_SITES = {
  'netflix': 'icons/netflix.svg', 'hbo max': 'icons/hbomax.svg', 'hulu': 'icons/hulu.svg', 'disney+': 'disneyplus.com', 'apple tv+': 'icons/appletv.svg',
  'apple tv': 'icons/appletv.svg', 'prime video': 'icons/primevideo.svg', 'amazon prime video': 'icons/primevideo.svg', 'peacock': 'peacocktv.com',
  'paramount+': 'icons/paramountplus.svg', 'nbc': 'icons/nbc.svg', 'cbs': 'icons/cbs.svg', 'abc': 'abc.com', 'fox': 'icons/fox.svg', 'fx': 'fxnetworks.com',
  'fxx': 'fxnetworks.com', 'amc': 'amc.com', 'amc+': 'amcplus.com', 'showtime': 'sho.com', 'starz': 'starz.com', 'bravo': 'bravotv.com',
  'usa network': 'usanetwork.com', 'syfy': 'syfy.com', 'tbs': 'tbs.com', 'tnt': 'tntdrama.com', 'the cw': 'cwtv.com', 'pbs': 'pbs.org',
  'comedy central': 'cc.com', 'mtv': 'mtv.com', 'adult swim': 'adultswim.com', 'cartoon network': 'cartoonnetwork.com',
  'nickelodeon': 'nick.com', 'disney channel': 'disneynow.com', 'freeform': 'freeform.com', 'national geographic': 'nationalgeographic.com',
  'discovery': 'discovery.com', 'discovery+': 'discoveryplus.com', 'hgtv': 'hgtv.com', 'food network': 'foodnetwork.com',
  'history': 'history.com', 'a&e': 'aetv.com', 'lifetime': 'mylifetime.com', 'tlc': 'tlc.com', 'bbc one': 'bbc.co.uk', 'bbc two': 'bbc.co.uk',
  'itv1': 'itv.com', 'itvx': 'itv.com', 'channel 4': 'channel4.com', 'britbox': 'britbox.com', 'acorn tv': 'acorn.tv', 'mgm+': 'mgmplus.com',
  'crunchyroll': 'crunchyroll.com', 'youtube': 'youtube.com', 'youtube premium': 'youtube.com', 'tubi': 'tubitv.com', 'roku channel': 'therokuchannel.com',
  'reelz': 'icons/reelz.svg', 'reelzchannel': 'icons/reelz.svg', 'reelz channel': 'icons/reelz.svg'
};
const netIcon = n => { const d = NET_SITES[n.toLowerCase()]; return !d ? '' : d.startsWith('icons/') ? d + new URL(import.meta.url).search : `https://www.google.com/s2/favicons?domain=${d}&sz=128`; };
views.shows = () => {
  if (needsAccount()) return views.landing();
  const list = followed(), movies = myMovies();
  if (!list.length && !movies.length && user && !serverSynced) {
    // Nothing on this device yet and the account hasn't answered: don't claim the list is empty.
    app.innerHTML = slowServer
      ? `<div class="empty"><h1>Can't reach your account</h1>
      <p>Your shows are saved in your account, but this browser can't connect to it right now. If you use an ad blocker or privacy extension, allow this site and reload. Otherwise check your connection and reload.</p>
      <p class="sub">Signed in as ${esc(user.email)}</p></div>`
      : SPLASH;
    return;
  }
  if (!list.length && isKid()) {
    app.innerHTML = `<div class="empty"><h1>No shows yet</h1><p>${esc(sharedOpen().name)} hasn't added any shows for you yet.</p></div>`;
    return;
  }
  if (!list.length && !movies.length) {
    app.innerHTML = `${inboxSection()}<div class="empty"><h1>Start your watchlist</h1>
      <p>Add the shows you're watching from any network or streaming service, then check off episodes as you go.</p>
      <a class="btn primary" href="#/search">＋ Add a show</a> <a class="btn" href="#/discover">See what's premiering</a>
      ${user ? `<p class="sub" style="margin-top:18px">Signed in as ${esc(cloud.loginName(user.email))}${sharedOpen() ? ` · viewing ${esc(sharedOpen().name)}'s list` : ''}</p>` : ''}
</div>`;
    return;
  }
  const all = list.map(s => ({ s: showInfo(s.id), p: progress(s.id) }));
  // Filter by network or streaming service, remembered on this device. Only offered when shows span 2+ services.
  const counts = {};
  for (const r of all) for (const n of new Set(services(r.s))) counts[n] = (counts[n] || 0) + 1;
  const nets = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  let net = load(K_NET, '');
  if (net && !counts[net]) net = '';
  const byNet = net ? all.filter(r => services(r.s).includes(net)) : all;
  // Day filter: the weekday (your time) the show's next episode airs, or its latest one did. Remembered on this device.
  const dc = {};
  for (const r of byNet) { const d = filterDay(r); if (d != null) dc[d] = (dc[d] || 0) + 1; }
  let day = load(K_DAY, '');
  if (day !== '' && !dc[day]) day = '';
  const shown = day !== '' ? byNet.filter(r => filterDay(r) === +day) : byNet;
  // Future watch list shows get their own section; everything else is sorted into the usual ones.
  const later = shown.filter(r => isLater(r.s.id)).sort((a, b) => (state.shows[b.s.id]?.t || 0) - (state.shows[a.s.id]?.t || 0));
  // Recommendations you added wait in their own section (Recommended by friends) until an episode is checked off.
  const fromFriends = later.filter(r => state.shows[r.s.id]?.rec), future = later.filter(r => !state.shows[r.s.id]?.rec);
  const rows = shown.filter(r => !isLater(r.s.id));
  // Two lines: the day, then how many shows air on it. The days run from today, so the first two say Today and Tomorrow.
  const dayChip = (d, label, c, full) => `<button type="button" class="nchip daychip${String(d) === String(day) ? ' on' : ''}" data-act="day" data-day="${d}" aria-pressed="${String(d) === String(day)}" aria-label="${full}, ${c} show${c === 1 ? '' : 's'}">${label}<span>${c} show${c === 1 ? '' : 's'}</span></button>`;
  const dayName = i => { const d = (new Date().getDay() + i) % 7; return i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAYS[d]; };
  const dayBar = Object.keys(dc).length > 1 ? `<div class="flabel" id="fl-day">Airs on</div><div class="netfilter" role="group" aria-labelledby="fl-day">
    ${dayChip('', 'Any day', byNet.length, 'Any day')}${[0, 1, 2, 3, 4, 5, 6].map(i => [i, (new Date().getDay() + i) % 7]).filter(([, d]) => dc[d])
      .map(([i, d]) => dayChip(d, dayName(i), dc[d], i < 2 ? dayName(i) : new Date(2026, 0, 4 + d).toLocaleDateString('en-US', { weekday: 'long' }))).join('')}</div>` : '';
  // Like the day buttons: the service (its logo, or its name over the count) and how many of your shows are on it.
  const netChip = (n, label, c) => { const ic = n && netIcon(n), shows = `${c} show${c === 1 ? '' : 's'}`;
    return `<button type="button" class="nchip${ic ? ' logo' : ' stack'}${n ? '' : ' allchip'}${n === net ? ' on' : ''}" data-act="net" data-net="${esc(n)}" aria-pressed="${n === net}" title="${esc(label)}" aria-label="${esc(label)}, ${shows}">${ic
      ? `<img src="${esc(ic)}" alt="${esc(label)}" data-name="${esc(label)}">` : esc(label)}<span>${shows}</span></button>`; };
  const filterBar = nets.length > 1 ? `<div class="flabel" id="fl-net">Where to watch</div><div class="netfilter" role="group" aria-labelledby="fl-net">
    ${netChip('', 'All', all.length)}${nets.map(n => netChip(n, n, counts[n])).join('')}</div>` : '';
  // Up next order: every show with aired episodes not checked off yet comes first — shows not started at all, then one
  // with an episode out today, then the rest, newest episode first. After them come caught-up shows whose next episode
  // airs within the week, soonest first.
  const today = new Date().toDateString(), outToday = p => new Date(p.latest).toDateString() === today;
  const starting = rows.filter(r => airingSoon(r.p)).sort((a, b) => airTime(a.p.upcoming) - airTime(b.p.upcoming));
  const ready = rows.filter(r => r.p?.next).sort((a, b) => (!b.p.watched - !a.p.watched) || (outToday(b.p) - outToday(a.p))
    || b.p.latest - a.p.latest || b.p.last - a.p.last);
  const watching = ready.concat(starting);
  const caught = rows.filter(r => r.p && !r.p.next && !airingSoon(r.p) && (r.p.upcoming || !/ended/i.test(r.s.status || '')))
    .sort((a, b) => (a.p.upcoming ? airTime(a.p.upcoming) : Infinity) - (b.p.upcoming ? airTime(b.p.upcoming) : Infinity));
  const done = rows.filter(r => r.p && !r.p.next && !r.p.upcoming && /ended/i.test(r.s.status || ''));
  const loading = rows.filter(r => !r.p);
  const futureSec = future.length ? `<h2>Future watch list · ${future.length}</h2>
    <p class="sub futurehint">Shows you plan to watch. Check off the first episode and the show moves to Up next.</p>
    <div class="grid">${future.map(r => futureCard(r.s, r.p)).join('')}</div>` : '';
  const friendsSec = fromFriends.length ? `<h2>Recommended by friends · ${fromFriends.length}</h2>
    <p class="sub futurehint">Recommendations you added. Check off the first episode and the show moves to Up next.</p>
    <div class="grid">${fromFriends.map(r => futureCard(r.s, r.p, (state.shows[r.s.id].rec || '').trim().split(/\s+/)[0] || 'Friend')).join('')}</div>` : '';
  const sec = (title, arr) => arr.length ? `<h2>${title} · ${arr.length}</h2><div class="grid">${arr.map(r => card(r.s, r.p)).join('')}</div>` : '';
  app.innerHTML = `<div class="toolbar"><h1>My Shows</h1>
      <span class="sub">Updated ${ago(meta.lastRefresh)}</span></div>
    ${inboxSection()}${filterBar}${dayBar}
    ${sec('Up next', watching)}${sec('Caught up — waiting for new episodes', caught)}
    ${futureSec}${friendsSec}${net || day !== '' ? '' : moviesSection()}${sec('Loading', loading)}${sec('Finished', done)}`;
  if (loading.length || list.some(s => recheck(s.id))) refreshAll(false);
};

// Shows other people sent to this account, at the top of My Shows until added or dismissed.
function inboxSection() {
  if (!inbox.length || sharedOpen()) return '';
  const row = m => { const on = isFollowed(m.show.id), first = (m.fromName || '').trim().split(/\s+/)[0];
    const href = `#/show/${m.show.id}${first ? '/' + encodeURIComponent(first) : ''}`;
    return `<div class="inboxrow">${poster(m.show, href)}<div class="grow">
      <p><b>${esc(m.fromName)}</b> recommends <a href="${href}">${esc(m.show.name)}</a></p>
      ${m.note ? `<p class="inboxnote">“${esc(m.note)}”</p>` : ''}
      <p class="sub">${esc(cloud.loginName(m.fromEmail))} · ${ago(m.t)}</p>
      <div class="actions">${on ? '<span class="sub">Already on your list</span>'
        : `<button class="btn primary sm" data-act="inbox-accept" data-id="${esc(m.id)}">＋ Add to my shows</button>`}
        <button class="btn ghost sm" data-act="inbox-dismiss" data-id="${esc(m.id)}">${on ? 'OK' : 'No thanks'}</button>
        <button class="btn ghost sm" data-act="inbox-block" data-id="${esc(m.id)}">Block</button></div></div></div>`; };
  return `<section class="inbox"><h2>Shows recommended by friends · ${inbox.length}</h2>
    <p class="sub futurehint">Add one and it waits under Recommended by friends until you watch the first episode, then moves to Up next.</p>${inbox.map(row).join('')}</section>`;
}
function onInbox(items) {
  inbox = items.filter(m => {   // already on your list and started: nothing to recommend
    if (!(isFollowed(m.show.id) && started(m.show.id))) return true;
    cloud.dismissShow(m.id).catch(x => console.warn('inbox', x)); return false;
  });
  const tab = $('#tabs a[data-tab="shows"]'); let dot = tab.querySelector('.tabcount');
  if (!inbox.length) dot?.remove();
  else { if (!dot) { dot = document.createElement('span'); dot.className = 'tabcount'; tab.append(dot); } dot.textContent = inbox.length; dot.title = `${inbox.length} show${inbox.length === 1 ? '' : 's'} recommended by friends`; }
  if (route().name === 'shows') render();
}

// Recommend: send the show to someone's TV Tracker account (find them by name or email), or share a link by text or email.
const K_SENT = 'tvt.sentTo';   // people you sent shows to recently, on this device: [{ uid, name, hint }]
function sendShowDialog(s) {
  const d = $('#appDialog'), recent = load(K_SENT, []);
  let pick = null;
  const person = p => `<button type="button" class="pickrow" data-uid="${esc(p.uid)}"><b>${esc(p.name)}</b>${p.hint ? `<span class="sub">${esc(p.hint)}</span>` : ''}</button>`;
  d.innerHTML = `<form class="stack" id="sendForm" autocomplete="off"><h2>Recommend ${esc(s.name)}</h2>
    <p class="sub">Send it to someone's TV Tracker account — it shows up at the top of their My Shows, ready to add.</p>
    ${recent.length ? `<div><div class="flabel">Recent</div><div class="picklist" id="recent">${recent.map(person).join('')}</div></div>` : ''}
    <div class="field"><label for="sendTo">Their full name or email</label><input id="sendTo" name="to" autocapitalize="none" spellcheck="false" placeholder="Exactly as on their account, e.g. Jane Smith"></div>
    <div class="picklist" id="found"></div>
    <div class="field"><label for="sendNote">Note (optional)</label><input id="sendNote" name="note" maxlength="300" placeholder="You'd love this one"></div>
    <p class="formerr" id="sendErr" hidden></p>
    <div class="actions"><button type="button" class="btn" data-share>Text or email a link instead</button><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary">Send</button></div></form>`;
  const f = $('#sendForm'), input = f.to, found = $('#found'), err = $('#sendErr'), btn = f.querySelector('.primary');
  const showErr = t => { err.textContent = t; err.hidden = !t; };
  const choose = p => { pick = p; input.value = p.name; btn.textContent = `Send to ${p.name.split(/\s+/)[0]}`;
    found.innerHTML = `<div class="picked">Sending to <b>${esc(p.name)}</b>${p.hint ? ` <span class="sub">${esc(p.hint)}</span>` : ''}</div>`; showErr(''); };
  const people = {}; for (const p of recent) people[p.uid] = p;
  f.addEventListener('click', e => { const b = e.target.closest('.pickrow'); if (b && people[b.dataset.uid]) choose(people[b.dataset.uid]); });
  input.oninput = () => { if (pick) { pick = null; found.innerHTML = ''; btn.textContent = 'Send'; } showErr(''); };
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-share]').onclick = () => { d.close(); shareLink(s); };
  f.onsubmit = async e => {
    e.preventDefault(); showErr('');
    const q = input.value.trim();
    if (!q) return showErr('Type their full name or email.');
    btn.disabled = true; btn.textContent = pick ? 'Sending…' : 'Looking…';
    try {
      // A name is looked up first and shown, so you can check it's the right person before it's sent.
      if (!pick && !q.includes('@')) {
        const r = await cloud.findPeople(q).catch(x => { throw x?.code === 'permission-denied' ? { code: 'tvt/lookup-denied' } : x; });
        for (const p of r) people[p.uid] = p;
        btn.disabled = false; btn.textContent = 'Send';
        if (r.length === 1) return choose(r[0]);
        found.innerHTML = r.length ? `<p class="sub">${r.length} people have that name — tap the one you mean:</p>${r.map(person).join('')}` : '';
        return showErr(r.length ? '' : `No one goes by exactly “${q}”. Check the spelling (it needs their full name), or use their email.`);
      }
      const to = pick || await cloud.findByEmail(q).catch(x => { throw x?.code === 'permission-denied' ? { code: 'tvt/lookup-denied' } : x; });
      await cloud.sendShow(to.uid, s, f.note.value, user.name);
      save(K_SENT, [to, ...recent.filter(p => p.uid !== to.uid)].slice(0, 6));
      d.close(); toast(`Sent ${s.name} to ${to.name}`);
    } catch (x) {
      console.warn('send show', x);
      showErr(({ 'tvt/lookup-denied': 'Couldn\'t look them up — the database refused (step 1: lookup). The latest Firestore rules may not be published.',
        'tvt/no-account': 'No TV Tracker account uses that email. Check it, or text them a link instead.',
        'tvt/self': 'That\'s you! Pick someone else.',
        'permission-denied': 'Couldn\'t send — the database refused (step 2: sending). They may have blocked you, or the latest Firestore rules aren\'t published.' })[x?.code] || cloud.friendlyError(x));
      btn.disabled = false; btn.textContent = pick ? `Send to ${pick.name.split(/\s+/)[0]}` : 'Send';
    }
  };
  d.showModal(); input.focus();
}
// Shares a link to the show page that greets the friend with "<your name> recommends this show".
async function shareLink(s) {
  const name = (user?.name || '').trim().split(/\s+/)[0];
  const url = `${location.origin}${location.pathname}#/show/${s.id}${name ? '/' + encodeURIComponent(name) : ''}`;
  const text = name ? `${name} recommends ${s.name} — check it out on TV Tracker` : `Check out ${s.name} on TV Tracker`;
  if (navigator.share) {
    try { await navigator.share({ title: s.name, text, url }); } catch (e) { if (e?.name !== 'AbortError') toast('Couldn\'t open sharing'); }
    return;
  }
  try { await navigator.clipboard.writeText(`${text}: ${url}`); toast('Link copied — paste it in a message to your friend'); }
  catch { prompt('Copy this and send it to your friend:', `${text}: ${url}`); }
}

// Caught up, with the next episode airing today or within the next 7 days.
const airingSoon = p => !!(p && !p.next && p.upcoming && airTime(p.upcoming) < new Date().setHours(0, 0, 0, 0) + 8 * DAY);
const airsToday = e => new Date(airTime(e)).toDateString() === new Date().toDateString();
function card(s, p) {
  const id = s.id, pct = p && p.total ? Math.round(p.watched / p.total * 100) : 0;
  let foot = '';
  if (p?.next) foot = `<div class="next">Next: ${twoLines(p.next)} · ${fmtDate(p.next)}</div>
    <button class="btn primary sm watchbtn" data-act="watch" data-ep="${p.next.id}"><span class="wbox"></span>Watched</button>`;
  else if (airingSoon(p)) foot = `<div class="next">Next: ${twoLines(p.upcoming)} · ${fmtDate(p.upcoming, true)}</div>${airsToday(p.upcoming)   // it can be watched on its air day
    ? `<button class="btn primary sm watchbtn" data-act="watch" data-ep="${p.upcoming.id}"><span class="wbox"></span>Watched</button>` : ''}`;
  else if (p?.upcoming) foot = `<div class="next muted">Next: ${twoLines(p.upcoming)} · ${fmtDate(p.upcoming)}</div>`;
  else if (p) foot = `<div class="next muted">${/ended/i.test(s.status || '') ? 'Series finished' : 'No new episodes scheduled'}</div>`;
  return `<article class="card">
    <div style="position:relative">${poster(s, '#/show/' + id)}${p?.fresh ? `<span class="badge">${p.fresh} new</span>` : airingSoon(p) && p.upcoming.newSeason ? '<span class="badge">New season</span>' : ''}</div>
    <div class="body"><a class="title" href="#/show/${id}">${esc(s.name)}</a>
      <div class="sub">${esc(channel(s.network, s.name))}</div>
      ${p ? `<div class="bar"><i style="width:${pct}%"></i></div>
      <div class="sub">${p.watched}/${p.total} watched${p.unwatched ? ` · <b>${p.unwatched} left</b>` : ''}</div>` : '<div class="sub">Loading episodes…</div>'}
      ${foot}</div></article>`;
}

// A show on the Future watch list: where it starts, and a Watched button for its first episode once that's out.
function futureCard(s, p, from) {   // from: the friend who recommended it (Recommended by friends section)
  const id = s.id, seasons = p ? new Set((cache[id]?.episodes || []).filter(aired).map(e => e.s)).size : 0;
  let info = '<div class="sub">Loading episodes…</div>', foot = '';
  if (p) {
    info = `<div class="sub">${p.total ? `${p.total} episode${p.total === 1 ? '' : 's'} out${seasons > 1 ? ` · ${seasons} seasons` : ''}` : 'Not out yet'}</div>`;
    if (p.next) foot = `<div class="next">Start with: ${twoLines(p.next)}</div>
      <button class="btn primary sm watchbtn" data-act="watch" data-ep="${p.next.id}"><span class="wbox"></span>Watched</button>`;
    else if (p.upcoming) foot = `<div class="next">${p.upcoming.s === 1 && p.upcoming.n === 1 ? 'Premieres' : 'Starts'}: ${fmtDate(p.upcoming, true)}</div>`;
    else foot = '<div class="next muted">No episodes scheduled yet</div>';
  }
  return `<article class="card later">
    <div style="position:relative">${poster(s, '#/show/' + id)}<span class="badge later">${from ? `From ${esc(from)}` : 'Later'}</span></div>
    <div class="body"><a class="title" href="#/show/${id}">${esc(s.name)}</a>
      <div class="sub">${esc(channel(s.network, s.name))}</div>${info}${foot}</div></article>`;
}

views.show = arg => {
  const id = +arg, c = cache[id];
  if (isKid()) {   // a kid only sees shows on its list, or within its rating limit
    const ok = kidCanSee(id);
    if (ok === null && !kidTried.has(id)) {
      kidTried.add(id); app.innerHTML = '<p class="loading">Checking rating…</p>';
      ratingOf(id).catch(() => {}).finally(() => { if (route().name === 'show' && route().arg == id) render(); });
      return;
    }
    if (!ok) {
      app.innerHTML = `<button type="button" class="backbtn" data-act="back" aria-label="Back"><span aria-hidden="true">←</span> Back</button>
        <div class="empty"><h1>Not available</h1><p>${esc(sharedOpen().name)} hasn't allowed this show.</p><a class="btn primary" href="#/">Back to my shows</a></div>`;
      return;
    }
  }
  if (!c) {
    app.innerHTML = '<p class="loading">Loading show…</p>';
    fetchShow(id).then(r => { if (route().arg == id) r ? render() : (app.innerHTML = '<p class="loading">Show not found.</p>'); })
      .catch(e => { app.innerHTML = `<p class="loading">Couldn't load: ${esc(e.message)}</p>`; });
    return;
  }
  if (now() - c.t > STALE) fetchShow(id).then(() => { if (route().arg == id) render(); }).catch(() => {});
  const s = c.show, f = isFollowed(id), p = progress(id);
  const seasons = new Map();
  for (const e of c.episodes) { if (!seasons.has(e.s)) seasons.set(e.s, []); seasons.get(e.s).push(e); }
  if (!openSeasons[id]) {
    const last = [...seasons.keys()].pop();
    openSeasons[id] = new Set([p?.next?.s ?? p?.upcoming?.s ?? last]);
  }
  const sched = s.schedule?.days?.length ? `${s.schedule.days.join(', ')}${s.schedule.time ? ' ' + s.schedule.time : ''}` : '';
  // Only the most recent fully-watched season stays in the list; earlier ones collapse behind a button.
  const done = [...seasons].filter(([, eps]) => { const av = eps.filter(aired); return av.length && av.every(e => isWatched(e.id)); }).map(([n]) => n);
  const hidden = showOldSeasons.has(id) ? new Set() : new Set(done.slice(0, -1));
  const seasonHtml = (hidden.size ? `<button class="btn ghost sm older" data-act="older-seasons" data-show="${id}">Show ${hidden.size} earlier watched season${hidden.size > 1 ? 's' : ''}</button>` : '') +
    [...seasons].filter(([n]) => !hidden.has(n)).map(([n, eps]) => {
    const av = eps.filter(aired), w = av.filter(e => isWatched(e.id)).length, all = av.length && w === av.length;
    return `<details class="season" data-show="${id}" data-season="${n}" ${openSeasons[id].has(n) ? 'open' : ''}>
      <summary><span class="grow">Season ${n}</span>
        <span class="mini"><div class="bar"><i style="width:${av.length ? w / av.length * 100 : 0}%"></i></div></span>
        <span class="sub">${w}/${av.length}${eps.length > av.length ? ` (+${eps.length - av.length})` : ''}</span>
        ${av.length ? `<button class="btn xs" data-act="season" data-show="${id}" data-season="${n}" data-val="${all ? 0 : 1}">${all ? 'Unmark all' : 'Mark all'}</button>` : ''}
      </summary>
      <ol class="eps">${eps.map(e => epRow(id, e)).join('')}</ol></details>`;
  }).join('');
  // Opened from a friend's recommendation link (#/show/<id>/<their name>).
  const from = linkFrom(id);
  const banner = from ? `<div class="recbanner"><span aria-hidden="true">★</span><span><b>${esc(from)}</b> recommends this show${f ? ' — it\'s already on your list'
    : needsAccount() ? '. Create a free account to add it to your list and track episodes.' : '.'}</span></div>` : '';
  app.innerHTML = `<button type="button" class="backbtn" data-act="back" aria-label="Back"><span aria-hidden="true">←</span> Back</button>
    ${banner}<section class="hero">${poster(s)}
    <div class="meta"><h1>${esc(s.name)}</h1>
      <div class="sub">${[channel(s.network, s.name), s.premiered && s.premiered.slice(0, 4), sched].filter(Boolean).map(esc).join(' · ')}</div>
      ${s.genres.length ? `<div class="chips">${s.genres.map(g => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
      ${p ? `<div class="stats"><div><b>${p.watched}/${p.total}</b><span>watched</span></div>
        <div><b>${p.unwatched}</b><span>left to watch</span></div>
        ${p.upcoming ? `<div><b>${code(p.upcoming)}</b><span>${fmtDate(p.upcoming, true)}</span></div>` : ''}</div>` : ''}
      ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ''}
      <div class="actions">
        ${f || isKid() ? '' : `<button class="btn primary" data-act="follow" data-show="${id}">＋ Add to my shows</button>
          <button class="btn" data-act="follow-later" data-show="${id}" title="Save it for later — it moves to Up next when you check off an episode">🕒 Watch later</button>`}
        <button class="btn" data-act="recommend" data-show="${id}">↗ Recommend to a friend</button>
        ${s.url ? `<a class="btn ghost" href="${esc(s.url)}" target="_blank" rel="noopener" title="Cast, crew and full details — opens TVmaze in a new tab">ⓘ More info on this show ↗</a>` : ''}
      </div>
      ${f && isLater(id) ? `<p class="laternote"><span aria-hidden="true">🕒</span> ${state.shows[id]?.rec ? `Recommended by ${esc(state.shows[id].rec)} — waiting under Recommended by friends` : 'On your Future watch list'} — check off an episode and it moves to Up next.</p>` : ''}
      ${f && !isKid() ? `<div class="actions">${isLater(id) ? `<button class="btn" data-act="later-off" data-show="${id}">▶ Start watching now</button>`
        : !started(id) && cache[id] ? `<button class="btn" data-act="later-on" data-show="${id}">🕒 Move to Future watch list</button>` : ''}
        ${!started(id) && cache[id] && !state.shows[id]?.rec ? `<button class="btn" data-act="to-friends" data-show="${id}">👥 Move to Recommended by friends</button>` : ''}
        <button class="btn danger" data-act="unfollow" data-show="${id}"><span aria-hidden="true">🗑️</span> Remove from my shows</button></div>` : ''}</div></section>
    <h2>Episodes</h2>
    ${seasonHtml || '<p class="muted">No episodes listed yet.</p>'}
    <p class="sub">Tip: tap <b>Watched Up To Here</b> on an episode to mark it and everything before it as watched.</p>`;
};

function epRow(sid, e) {
  const w = isWatched(e.id), a = aired(e);
  return `<li class="ep ${w ? 'done' : ''} ${a ? '' : 'future'}">
    <label class="chk" title="${w ? 'Mark unwatched' : 'Mark watched'}"><input type="checkbox" data-act="toggle" data-show="${sid}" data-ep="${e.id}" ${w ? 'checked' : ''}><span></span></label>
    <div class="epbody"><div class="name"><span class="code">${e.n}.</span> ${esc(e.name)}</div>
      <div class="sub">${fmtDate(e, !a)}${e.runtime ? ` · ${e.runtime} min` : ''}</div>
      ${e.summary ? `<details class="syn"><summary>Synopsis</summary><p>${esc(e.summary)}</p></details>` : ''}</div>
    ${a && !w ? `<button class="btn ghost xs" data-act="upto" data-show="${sid}" data-ep="${e.id}" title="Mark this and every earlier episode watched">Watched Up To Here</button>` : ''}
  </li>`;
}

views.upcoming = () => {
  if (needsAccount()) return signInWall('See when your shows air');
  const list = current(), later = followed().length - list.length;   // Future watch list shows join once started
  const recent = [], soon = [];
  for (const f of list) {
    const c = cache[f.id]; if (!c) continue;
    for (const e of c.episodes) {
      const t = airTime(e); if (!isFinite(t)) continue;
      if (t <= now() && now() - t < 7 * DAY) { if (!isWatched(e.id)) recent.push({ s: c.show, e, t }); }   // already-watched episodes are left out
      else if (t > now() && t - now() < 45 * DAY) soon.push({ s: c.show, e, t });
    }
  }
  recent.sort((a, b) => a.t - b.t); soon.sort((a, b) => a.t - b.t);   // both oldest first
  const row = ({ s, e }, check) => `<div class="row">${poster(s, '#/show/' + s.id)}
    <div class="info"><a href="#/show/${s.id}">${esc(s.name)}</a>
      <div class="sub"><span class="code">${code(e)}</span> ${esc(e.name)}</div>
      <div class="when">${fmtDate(e, true)} · ${esc(channel(s.network, s.name))}</div>
      ${check ? `<button class="btn primary sm watchbtn${isWatched(e.id) ? ' on' : ''}" data-act="watch" data-ep="${e.id}"><span class="wbox"></span>Watched</button>` : ''}</div></div>`;
  let days = '', cur = '';
  for (const it of soon) {
    const d = new Date(it.t).toDateString();
    if (d !== cur) { cur = d; days += `<div class="dayhead">${fmtDate(it.e)}</div>`; }
    days += row(it, airsToday(it.e));   // an episode out today can be checked off
  }
  app.innerHTML = `<div class="toolbar"><h1>Upcoming</h1><span class="sub">Your shows · next 45 days</span></div>
    ${!list.length ? (isKid() ? `<div class="empty"><p>${esc(sharedOpen().name)} hasn't added any shows for you yet.</p></div>`
      : later ? `<div class="empty"><p>Shows on your Future watch list appear here once you check off their first episode.</p><a class="btn primary" href="#/">See My Shows</a></div>`
      : `<div class="empty"><p>Add some shows to see their schedule here.</p><a class="btn primary" href="#/search">＋ Add a show</a></div>`) : ''}
    ${recent.length ? `<h2>Airing this week</h2><div class="rows urows">${recent.map(r => row(r, true)).join('')}</div>` : ''}
    ${list.length ? `<h2>Coming up</h2>${soon.length ? `<div class="rows urows">${days}</div>` : '<p class="muted">Nothing scheduled yet for your shows.</p>'}` : ''}`;
  if (followed().some(f => !cache[f.id])) refreshAll(false);
};

// Discover: rows of recommendations from what you watch, then this week's premieres.
let discoverLoading = null;
views.discover = () => {
  const d = meta.discover, stale = !d || now() - d.t > STALE;
  if (stale && !discoverLoading) discoverLoading = loadDiscover().catch(e => toast('Couldn\'t load premieres: ' + e.message)).finally(() => { discoverLoading = null; if (route().name === 'discover') render(); });
  const item = it => `<div class="row">${poster(it.show, '#/show/' + it.show.id)}
    <div class="info"><a href="#/show/${it.show.id}">${esc(it.show.name)}</a>
      <div class="sub">${esc(channel(it.show.network, it.show.name))}${it.season > 1 ? ` · Season ${it.season}` : ''}${it.show.genres?.length ? ' · ' + esc(it.show.genres.slice(0, 2).join(', ')) : ''}</div></div>
    <div class="when">${fmtDate({ airstamp: it.airstamp, airdate: it.airdate })}</div>
    ${followBtn(it.show)}</div>`;
  const fresh = d ? d.items.filter(i => i.season === 1) : [], back = d ? d.items.filter(i => i.season > 1) : [];
  const premieres = !d ? '<p class="loading">Pulling this week\'s premieres across networks &amp; streaming…</p>'
    : `<h3 class="dsub">New series · ${fresh.length}</h3><div class="rows drows">${fresh.map(item).join('') || '<p class="muted">None found.</p>'}</div>
       <h3 class="dsub">Returning seasons · ${back.length}</h3><div class="rows drows">${back.map(item).join('') || '<p class="muted">None found.</p>'}</div>`;
  app.innerHTML = `<div class="toolbar"><h1>Discover</h1><span class="sub">Shows picked for you from what you watch</span>
      <button class="btn sm" data-act="discover-refresh">↻ Refresh</button></div>
    ${recsSection()}
    <h2 class="dhead">Premiering this week</h2>
    ${premieres}`;
};

/* ---------- recommendations (TMDB) ----------
   For each followed show, TMDB's "people who liked this also liked" list, shown as a row of posters. "Top picks"
   ranks shows that come up for several of your shows, and near the top of those lists. A pick is matched to
   TVmaze only when it's opened or added. Kept on the device: show matches for good, recommendation lists for a week. */
const TMDB = 'https://api.themoviedb.org/3', TMDB_IMG = 'https://image.tmdb.org/t/p/w342', K_TMDB = 'tvt.tmdb.v2';
const tm = Object.assign({ map: {}, recs: {}, tvm: {}, rate: {} }, load(K_TMDB, {}));   // map: TVmaze id -> TMDB id; recs: TMDB id -> { t, list }; tvm: TMDB id -> TVmaze show (0 = none); rate: TVmaze id -> { r: US TV rating ('' = none), t }
let recsLoading = null, recsError = '', recsAt = 0;   // recsAt: last load, so lookups that failed aren't retried in a loop
async function tmdb(path) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${TMDB}${path}${path.includes('?') ? '&' : '?'}api_key=${config.tmdbKey}`);
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('TMDB error ' + r.status);
    return r.json();
  }
  throw new Error('TMDB is busy, try again in a moment');
}
async function tmdbId(s) {
  const find = async (id, src) => (await tmdb(`/find/${encodeURIComponent(id)}?external_source=${src}`))?.tv_results?.[0]?.id;
  let id = (s.imdb && await find(s.imdb, 'imdb_id')) || (s.tvdb && await find(s.tvdb, 'tvdb_id'));
  if (!id) {
    const y = (s.premiered || '').slice(0, 4);
    id = (await tmdb(`/search/tv?query=${encodeURIComponent(s.name)}${y ? '&first_air_date_year=' + y : ''}`))?.results?.[0]?.id;
  }
  return id || 0;
}
async function tvmazeFor(id) {
  if (tm.tvm[id] !== undefined) return tm.tvm[id];
  const ex = await tmdb(`/tv/${id}/external_ids`);
  let s = ex?.imdb_id ? await api(`/lookup/shows?imdb=${ex.imdb_id}`) : null;
  if (!s && ex?.tvdb_id) s = await api(`/lookup/shows?thetvdb=${ex.tvdb_id}`);
  tm.tvm[id] = s ? trimShow(s) : 0;
  if (s) tm.tvm[id].summary = tm.tvm[id].summary.slice(0, 200);
  save(K_TMDB, tm);
  return tm.tvm[id];
}
async function inFours(items, fn) {   // 4 at a time, which keeps well under TMDB's rate limit
  for (let i = 0; i < items.length; i += 4) await Promise.all(items.slice(i, i + 4).map(x => fn(x).catch(e => console.warn('recs', e))));
}
// Shows already on the list, by TMDB id and TVmaze id, so they're never recommended.
function mineIds() {
  const mine = followed();
  return { t: new Set(mine.map(f => tm.map[f.id]).filter(Boolean)), v: new Set(mine.map(f => f.id)) };
}
const recOk = (r, ids) => !ids.t.has(r.id) && (!r.lang || r.lang === 'en') && !(tm.tvm[r.id] && ids.v.has(tm.tvm[r.id].id)) && tm.tvm[r.id] !== 0;
function rankRecs() {
  const ids = mineIds(), score = {};
  for (const f of followed()) {
    const list = tm.recs[tm.map[f.id]]?.list || [];
    list.forEach((r, i) => {
      if (!recOk(r, ids)) return;
      const x = score[r.id] || (score[r.id] = { ...r, score: 0, because: [] });
      x.score += 1 + (list.length - i) / list.length;
      x.because.push(showInfo(f.id)?.name || f.name);
    });
  }
  return Object.values(score).sort((a, b) => b.score - a.score || b.pop - a.pop);
}
function loadRecs() {
  if (recsLoading) return recsLoading;
  recsAt = now();
  recsLoading = (async () => {
    recsError = '';
    try {
      busy('Finding shows you might like…');
      const mine = followed().map(f => showInfo(f.id)).filter(Boolean);
      await inFours(mine.filter(s => tm.map[s.id] === undefined), async s => { tm.map[s.id] = await tmdbId(s); });
      const ids = [...new Set(mine.map(s => tm.map[s.id]).filter(Boolean))].filter(id => !tm.recs[id] || now() - tm.recs[id].t > 7 * DAY);
      await inFours(ids, async id => {
        const j = await tmdb(`/tv/${id}/recommendations?language=en-US&page=1`);
        tm.recs[id] = { t: now(), list: (j?.results || []).map(r => ({ id: r.id, name: r.name, poster: r.poster_path || '', year: (r.first_air_date || '').slice(0, 4), lang: r.original_language, pop: r.popularity })) };
        if (route().name === 'discover') redrawSoon();   // rows fill in as they arrive
      });
      save(K_TMDB, tm);
    } catch (e) { recsError = e.message; console.warn('recs', e); }
    finally { busy(false); recsLoading = null; if (route().name === 'discover') render(); }
  })();
  return recsLoading;
}
function recCard(r) {
  const s = tm.tvm[r.id], added = s && isFollowed(s.id);
  return `<div class="rcard"><button type="button" class="rposter" data-act="rec-open" data-tmdb="${r.id}" title="${esc(r.name)}">${r.poster
      ? `<img src="${TMDB_IMG}${esc(r.poster)}" alt="" loading="lazy">` : `<span class="noimg">${esc(r.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2))}</span>`}</button>
    <button type="button" class="rname" data-act="rec-open" data-tmdb="${r.id}">${esc(r.name)}</button><span class="sub">${esc([r.year, r.because?.slice(0, 2).join(', ')].filter(Boolean).join(' · ')) || '&nbsp;'}</span>
    ${added ? '<span class="btn xs">✓ Added</span>' : `<button type="button" class="btn primary xs" data-act="rec-add" data-tmdb="${r.id}">＋ Add</button>`}</div>`;
}
function recsSection() {
  if (!config.tmdbKey) return '';
  if (!user || !followed().length) return `<div class="empty"><p>Add a few shows you watch and we'll recommend more like them here.</p><a class="btn primary" href="#/search">＋ Add a show</a></div>`;
  const mine = followed(), ids = mineIds();
  const ready = mine.every(f => tm.map[f.id] !== undefined && (!tm.map[f.id] || (tm.recs[tm.map[f.id]] && now() - tm.recs[tm.map[f.id]].t < 7 * DAY)));
  if (!ready && now() - recsAt > 5 * 60e3) loadRecs();
  const top = rankRecs().slice(0, 15);
  // One row per show you watch, most recently active first.
  const rows = mine.map(f => ({ f, s: showInfo(f.id), p: progress(f.id), list: (tm.recs[tm.map[f.id]]?.list || []).filter(r => recOk(r, ids)).slice(0, 12) }))
    .filter(x => x.list.length).sort((a, b) => (b.p?.last || 0) - (a.p?.last || 0));
  const row = (title, list) => `<h2 class="dhead">${title}</h2><div class="rrow">${list.map(recCard).join('')}</div>`;
  if (!top.length) return `<p class="muted">${recsError ? `Couldn't load recommendations: ${esc(recsError)}` : 'Finding shows you might like…'}</p>`;
  return row('Top picks for you', top) + rows.map(x => row(`Because you watch ${esc(x.s?.name || x.f.name)}`, x.list.map(r => ({ ...r, because: null })))).join('');
}
async function recShow(b) {
  const id = +b.dataset.tmdb;
  b.disabled = true; busy('Finding show…');
  try { return await tvmazeFor(id) || (toast('Couldn\'t find that show\'s details'), null); }
  catch (e) { toast(e.message); return null; }
  finally { busy(false); b.disabled = false; }
}

/* ---------- movies (TMDB) ----------
   Search can switch to Movies. A movie can be added to My Shows (Movies to watch) and checked off once it's watched,
   which moves it to Watched movies. Kept in state.movies, keyed by TMDB id. Kid logins don't see movies. */
const movieCache = {};   // TMDB id -> full details for the movie page, this visit only
const myMovies = () => isKid() ? [] : Object.values(state.movies).filter(m => !m.removed);
const hasMovie = id => !isKid() && !!(state.movies[id] && !state.movies[id].removed);
const movieSeen = id => hasMovie(id) && !!state.movies[id].w;
function trimMovie(m) {
  return { id: m.id, name: m.title || m.name || '', image: m.poster_path ? TMDB_IMG + m.poster_path : '',
    year: (m.release_date || '').slice(0, 4), date: m.release_date || '', summary: (m.overview || '').slice(0, 700), pop: m.popularity || 0 };
}
async function fetchMovie(id) {
  const j = await tmdb(`/movie/${id}?language=en-US&append_to_response=watch/providers,release_dates`);
  if (!j) return null;
  const us = j.release_dates?.results?.find(r => r.iso_3166_1 === 'US');
  const prov = j['watch/providers']?.results?.US || {};
  return movieCache[id] = { ...trimMovie(j), runtime: j.runtime || 0, genres: (j.genres || []).map(g => g.name),
    rating: us?.release_dates?.map(d => d.certification).find(Boolean) || '', tagline: j.tagline || '',
    stream: (prov.flatrate || []).map(x => x.provider_name), rent: (prov.rent || prov.buy || []).map(x => x.provider_name).slice(0, 4), link: prov.link || '' };
}
function addMovie(m, seen) {
  if (isKid()) return;
  const t = now();
  state.movies[m.id] = { id: m.id, name: m.name, image: m.image || '', year: m.year || '', w: !!seen, removed: false, t };
  queue('movies', m.id, state.movies[m.id]); persist();
}
function setMovie(id, fields) {
  const m = state.movies[id]; if (!m) return;
  Object.assign(m, fields, { t: now() }); queue('movies', id, m); persist();
}
function movieBtn(m) {
  if (isKid()) return '';
  if (hasMovie(m.id)) return movieSeen(m.id)
    ? `<button class="btn sm" data-act="movie-remove" data-movie="${m.id}" title="You've watched it — tap to remove">✓ Watched</button>`
    : `<button class="btn sm" data-act="movie-remove" data-movie="${m.id}" title="On your Movies to watch — tap to remove">✓ Added</button>`;
  return `<span class="addbtns"><button class="btn primary sm" data-act="movie-add" data-movie="${m.id}">＋ Add</button>
    <button class="btn sm" data-act="movie-seen" data-movie="${m.id}" title="Already watched it">✓ Seen it</button></span>`;
}
function movieCard(m) {
  const seen = !!m.w;
  return `<article class="card movie${seen ? ' seen' : ''}">
    <div style="position:relative">${poster(m, '#/movie/' + m.id)}<span class="badge movie">Movie</span></div>
    <div class="body"><a class="title" href="#/movie/${m.id}">${esc(m.name)}</a>
      <div class="sub">${esc(m.year || 'Movie')}</div>
      ${seen ? `<div class="next muted">Watched</div><button class="btn ghost sm" data-act="movie-unwatch" data-movie="${m.id}">Mark unwatched</button>`
        : `<button class="btn primary sm watchbtn" data-act="movie-watch" data-movie="${m.id}"><span class="wbox"></span>Watched</button>`}</div></article>`;
}
function moviesSection() {
  const all = myMovies().sort((a, b) => (b.t || 0) - (a.t || 0));
  const toWatch = all.filter(m => !m.w), seen = all.filter(m => m.w);
  return (toWatch.length ? `<h2>Movies to watch · ${toWatch.length}</h2><div class="grid">${toWatch.map(movieCard).join('')}</div>` : '')
    + (seen.length ? `<details class="moviesdone"><summary><h2>Watched movies · ${seen.length}</h2></summary><div class="grid">${seen.map(movieCard).join('')}</div></details>` : '');
}
views.movie = arg => {
  const id = +arg;
  if (isKid()) { location.hash = '#/'; return; }
  const m = movieCache[id];
  if (!m) {
    app.innerHTML = '<p class="loading">Loading movie…</p>';
    fetchMovie(id).then(r => { if (route().name === 'movie' && +route().arg === id) r ? render() : (app.innerHTML = '<p class="loading">Movie not found.</p>'); })
      .catch(e => { app.innerHTML = `<p class="loading">Couldn't load: ${esc(e.message)}</p>`; });
    return;
  }
  const on = hasMovie(id), seen = movieSeen(id);
  const hrs = m.runtime ? `${m.runtime >= 60 ? Math.floor(m.runtime / 60) + 'h ' : ''}${m.runtime % 60 ? (m.runtime % 60) + 'm' : ''}`.trim() : '';
  const where = m.stream.length ? `<p class="where"><b>Streaming on:</b> ${m.stream.map(esc).join(', ')}</p>`
    : m.rent.length ? `<p class="where"><b>Rent or buy:</b> ${m.rent.map(esc).join(', ')}</p>` : '';
  app.innerHTML = `<button type="button" class="backbtn" data-act="back" aria-label="Back"><span aria-hidden="true">←</span> Back</button>
    <section class="hero">${poster(m)}
    <div class="meta"><h1>${esc(m.name)}</h1>
      <div class="sub">${['Movie', m.year, hrs, m.rating].filter(Boolean).map(esc).join(' · ')}</div>
      ${m.genres.length ? `<div class="chips">${m.genres.map(g => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
      ${m.tagline ? `<p class="sub"><i>${esc(m.tagline)}</i></p>` : ''}
      ${m.summary ? `<p class="summary">${esc(m.summary)}</p>` : ''}
      ${where}
      <div class="actions">
        ${!on ? `<button class="btn primary" data-act="movie-add" data-movie="${id}">＋ Add to my movies</button>
          <button class="btn" data-act="movie-seen" data-movie="${id}">✓ I've seen it</button>`
        : seen ? `<button class="btn" data-act="movie-unwatch" data-movie="${id}">↺ Mark unwatched</button>`
        : `<button class="btn primary" data-act="movie-watch" data-movie="${id}">✓ Mark watched</button>`}
        <a class="btn ghost" href="https://www.themoviedb.org/movie/${id}" target="_blank" rel="noopener" title="Cast, crew and full details — opens TMDB in a new tab">ⓘ More info on this movie ↗</a>
      </div>
      ${on ? `<p class="laternote"><span aria-hidden="true">${seen ? '✓' : '🎬'}</span> ${seen ? 'You\'ve watched this — it\'s under Watched movies on My Shows.' : 'On your Movies to watch list on My Shows.'}</p>
        <div class="actions"><button class="btn danger" data-act="movie-remove" data-movie="${id}"><span aria-hidden="true">🗑️</span> Remove from my movies</button></div>` : ''}
    </div></section>`;
};

/* ---------- kid logins ----------
   An owner can make a login with Kid access: it sees only the shows the owner allows (up to a highest US TV rating, from
   TMDB, plus any they allow anyway, minus any they pick to hide), can't add or remove shows, and keeps its own checkmarks. The allowed shows are
   written to a separate copy (users/{owner}/kids/{kid}) that's all the kid's login can read, so hidden shows never reach
   its device. The owner's app — or an editor's — rewrites the copy whenever the list or the settings change.
   A kid can also search for shows and open their pages, but only ones within its rating limit that the owner hasn't
   hidden (the copy carries the limit, and the ids of hidden shows the limit would otherwise let through). */
const RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const RATING_NAMES = { 'TV-Y': 'All children', 'TV-Y7': 'Age 7 and up', 'TV-G': 'General audience', 'TV-PG': 'Parental guidance', 'TV-14': 'Age 14 and up', 'TV-MA': 'Mature audience' };
const KID_DEFAULT_RATING = 'TV-PG';
const ratingOk = (r, max) => !max || (RATINGS.includes(r) && RATINGS.indexOf(r) <= RATINGS.indexOf(max));   // no rating: hidden while there's a limit
// With no US rating, another country's is used instead, as the closest US level — on the strict side where they differ.
const ABROAD = {
  GB: { U: 'TV-G', PG: 'TV-PG', '12': 'TV-14', '12A': 'TV-14', '15': 'TV-MA', '18': 'TV-MA' },
  CA: { C: 'TV-Y', C8: 'TV-Y7', G: 'TV-G', PG: 'TV-PG', '14+': 'TV-14', '18+': 'TV-MA' },
  AU: { P: 'TV-Y', C: 'TV-Y7', G: 'TV-G', PG: 'TV-PG', M: 'TV-14', 'MA15+': 'TV-MA', 'AV15+': 'TV-MA', 'R18+': 'TV-MA' },
  DE: { '0': 'TV-G', '6': 'TV-PG', '12': 'TV-14', '16': 'TV-MA', '18': 'TV-MA' }
};
const COUNTRY = { GB: 'UK', CA: 'Canada', AU: 'Australia', DE: 'Germany' };
// A show's US TV rating ({ r, from }: r is '' when it has none; from is the country it came from, '' for the US), from TMDB.
// Kept on the device for a month. show: the show's details, if already at hand (e.g. a search result).
const rated = id => { const c = tm.rate[id]; return !!(c && c.v === 2 && now() - c.t < 30 * DAY); };
async function ratingOf(id, show) {
  if (rated(id)) return tm.rate[id].r;
  if (!config.tmdbKey) return '';
  const s = show || cache[id]?.show || (await fetchShow(id))?.show; if (!s) return '';
  if (tm.map[id] === undefined) tm.map[id] = await tmdbId(s);
  const list = (tm.map[id] && (await tmdb(`/tv/${tm.map[id]}/content_ratings`))?.results) || [];
  const of = cc => String(list.find(x => x.iso_3166_1 === cc)?.rating || '').toUpperCase().trim();
  let r = of('US').replace(/-FV$/, ''), from = '';
  if (!RATINGS.includes(r)) {   // the strictest of the other countries' ratings
    r = ''; for (const cc in ABROAD) { const x = ABROAD[cc][of(cc)]; if (x && RATINGS.indexOf(x) > RATINGS.indexOf(r)) { r = x; from = cc; } }
  }
  tm.rate[id] = { r, from, t: now(), v: 2 }; save(K_TMDB, tm);
  return r;
}
// The copy a kid login reads: the open list's shows, minus hidden ones and any over the highest rating that aren't allowed anyway.
// block: hidden shows the limit would let through, so the kid's search leaves them out too.
async function kidCopyFor({ maxRating = '', hide = {}, allow = {} }) {
  const all = followed(), passes = s => allow[s.id] || ratingOk(tm.rate[s.id]?.r, maxRating);
  if (maxRating) await inFours(all.filter(s => !allow[s.id]), s => ratingOf(s.id));   // one that can't be looked up stays hidden until it can
  const shows = {};
  for (const s of all) if (!hide[s.id] && passes(s)) shows[s.id] = { id: s.id, name: s.name, image: s.image || '', network: s.network || '', removed: false, later: !!s.later, t: s.t || 0 };
  const block = all.filter(s => hide[s.id] && passes(s)).map(s => s.id).sort((a, b) => a - b);
  return { ownerName: sharedOpen()?.name || user.name, maxRating, shows, block, updated: now() };
}
let kidLogins = {}, kidSent = {}, kidTimer = null, kidSyncing = false;   // kidSent: what each kid's copy was last written with
const kidSig = c => JSON.stringify([c.ownerName, c.maxRating, c.shows, c.block]);
// On a kid's device: the limit from its copy, for search and show pages. kidTried: shows whose rating was already looked
// up (so a failed lookup isn't retried in a loop); kidPending: ones still being looked up.
let kidLimit = { maxRating: '', block: [] };
const kidTried = new Set(), kidPending = new Set();
// Whether a kid may see a show: on its list, or within its rating limit and not hidden. null while the rating isn't known.
function kidCanSee(id) {
  if (isFollowed(id)) return true;
  if (kidLimit.block.includes(id)) return false;
  if (!kidLimit.maxRating) return true;
  return rated(id) ? ratingOk(tm.rate[id].r, kidLimit.maxRating) : null;
}
function syncKidsSoon() { clearTimeout(kidTimer); kidTimer = setTimeout(syncKids, 1500); }
async function syncKids() {
  if (kidSyncing) return syncKidsSoon();
  kidSyncing = true;
  try {
    for (const [uid, l] of Object.entries(kidLogins)) {
      if (l.role !== 'kid' || !user || (sharedOpen() && sharedOpen().role !== 'edit')) continue;
      const copy = await kidCopyFor(l), sig = kidSig(copy);
      if (kidSent[uid] === sig) continue;
      try { await cloud.writeKidCopy(uid, copy); kidSent[uid] = sig; } catch (e) { console.warn('kid copy', e); }
    }
  } finally { kidSyncing = false; }
}
// A kid's device keeps no copy of the owner's full list (e.g. saved before the login was changed to Kid).
function forgetFullList() { if (isKid()) try { localStorage.removeItem(`${K.state}.${user.linked.uid}`); } catch { } }

// The owner picks the highest rating, any shows to allow anyway (ones the limit would hide) and any shows to hide for a kid
// login. Resolves the settings, or null if cancelled.
function kidSettingsDialog(name, settings) {
  const d = $('#appDialog'), hide = { ...(settings.hide || {}) }, allow = { ...(settings.allow || {}) };
  const list = followed().map(f => showInfo(f.id) || f).sort((a, b) => a.name.localeCompare(b.name));
  const label = id => { const r = tm.rate[id]; return !config.tmdbKey ? '' : !r || r.v !== 2 ? 'Checking rating…' : r.r ? r.r + (r.from ? ` (${COUNTRY[r.from]})` : '') : 'No rating'; };
  d.innerHTML = `<form class="stack kidform" id="kidForm"><h2>What ${esc(name)} can see</h2>
    ${config.tmdbKey ? `<div class="field"><label for="kidMax">Highest rating</label><select id="kidMax" name="max" class="rolesel">
      <option value="">Any rating — no limit</option>${RATINGS.slice(0, -1).map(r => `<option value="${r}">${r} · ${RATING_NAMES[r]}</option>`).join('')}</select>
      <p class="sub">US TV ratings, from TMDB; when a show has no US rating, the UK's, Canada's, Australia's or Germany's is used
        instead. While a limit is set, shows it hides — and any still without a rating — can be let through with <b>Allow</b>.</p></div>` : ''}
    <div><div class="kidhead">Hide these shows</div>
      ${list.length ? `<div class="kidshows">${list.map(s => `<div class="kidrow" data-id="${s.id}">
        <label class="checkrow"><input type="checkbox" class="hidebox" value="${s.id}"${hide[s.id] ? ' checked' : ''}><span class="kidname">${esc(s.name)}</span></label>
        <span class="kidmeta"><span class="sub kidrate"></span>
        <label class="allowbtn" hidden><input type="checkbox" class="allowbox" value="${s.id}"${allow[s.id] ? ' checked' : ''}>Allow</label></span></div>`).join('')}</div>`
        : '<p class="sub">Shows you add to your list will appear here.</p>'}</div>
    <p class="sub">${esc(name)} sees only the shows within the rating or allowed, minus any you hide. They can't add or remove shows, and keep their own checkmarks.</p>
    <div class="actions"><button class="btn primary">Save</button><button type="button" class="btn" id="kidCancel">Cancel</button></div></form>`;
  const max = $('#kidMax', d);
  if (max) max.value = settings.maxRating || '';
  // Each show's rating. One the chosen limit hides is crossed out, with an Allow tick to let it through anyway.
  const marks = () => d.querySelectorAll('.kidrow').forEach(row => {
    const id = +row.dataset.id, r = tm.rate[id], over = !!(max?.value && r && r.v === 2 && !ratingOk(r.r, max.value));
    const allowed = row.querySelector('.allowbox').checked;
    row.querySelector('.kidrate').textContent = label(id);
    row.querySelector('.allowbtn').hidden = !over;
    row.classList.toggle('overlimit', over && !allowed);
    row.classList.toggle('allowed', over && allowed);
  });
  marks(); max?.addEventListener('change', marks);
  d.querySelectorAll('.allowbox').forEach(b => b.addEventListener('change', marks));
  if (config.tmdbKey) inFours(list, async s => { await ratingOf(s.id); if (d.open) marks(); });
  d.showModal();
  return new Promise(done => {
    const finish = v => { d.close(); done(v); };
    $('#kidCancel', d).onclick = () => finish(null);
    d.addEventListener('close', () => done(null), { once: true });
    $('#kidForm', d).onsubmit = e => {
      e.preventDefault();
      const h = {}, a = {};
      d.querySelectorAll('.hidebox:checked').forEach(i => { h[i.value] = true; });
      d.querySelectorAll('.allowbtn:not([hidden]) .allowbox:checked').forEach(i => { a[i.value] = true; });   // only for shows the limit hides
      finish({ maxRating: max?.value || '', hide: h, allow: a });
    };
  });
}
// Saves a login's access, with its settings and filtered copy when it's a kid.
async function saveLogin(uid, role, settings) {
  const copy = role === 'kid' ? await kidCopyFor(settings) : null;
  await cloud.setLogin(uid, role, settings, copy);
  if (copy) kidSent[uid] = kidSig(copy);
}

function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
async function loadDiscover() {
  const items = new Map();
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    busy(`Loading schedule ${i + 1}/7…`);
    for (const path of [`/schedule?country=US&date=${ymd(d)}`, `/schedule/web?date=${ymd(d)}`]) {
      const eps = await api(path) || [];
      for (const ep of eps) {
        const sh = ep.show || ep._embedded?.show;
        if (!sh || ep.number !== 1 || items.has(sh.id)) continue;
        if (sh.language && sh.language !== 'English') continue;
        if (/news|talk show|sports/i.test(sh.type || '')) continue;
        items.set(sh.id, { show: trimShow(sh), season: ep.season, airstamp: ep.airstamp || '', airdate: ep.airdate || '' });
      }
      await sleep(150);
    }
  }
  busy(false);
  const arr = [...items.values()].sort((a, b) => airTime(a) - airTime(b));
  arr.forEach(i => { i.show.summary = i.show.summary.slice(0, 200); });
  meta.discover = { t: now(), items: arr }; save(K.meta, meta);
}

function followBtn(s) {
  if (isKid()) return isFollowed(s.id) ? '<span class="btn sm">✓ On your list</span>' : '';   // a kid can look, not add
  if (isFollowed(s.id)) return isLater(s.id)
    ? `<button class="btn sm" data-act="unfollow" data-show="${s.id}" title="On your Future watch list — tap to remove">✓ Later</button>`
    : `<button class="btn sm" data-act="unfollow" data-show="${s.id}">✓ Added</button>`;
  return `<span class="addbtns"><button class="btn primary sm" data-act="follow" data-show="${s.id}">＋ Add</button>
    <button class="btn sm" data-act="follow-later" data-show="${s.id}" title="Add to your Future watch list">🕒 Later</button></span>`;
}

let lastResults = [], lastQuery = '', searchTimer = null, searchSeq = 0;
let lastMovies = [], lastMovieQuery = '';
// Search TV shows or movies (kid logins: shows only). Remembered for this visit.
const searchMode = () => { if (isKid()) return 'tv'; try { return sessionStorage.getItem('tvt.qmode') === 'movie' ? 'movie' : 'tv'; } catch { return 'tv'; } };
const showLookup = {};   // id -> trimmed show from search/discover, used when following
views.search = () => {
  const kid = isKid();
  const mv = searchMode() === 'movie';
  app.innerHTML = `${kid ? `<h1>Search shows</h1><p class="sub">${kidLimit.maxRating ? `Shows rated up to ${esc(kidLimit.maxRating)}` : 'Any show'} — ask ${esc(sharedOpen().name)} to add one to your list.</p>` : `<h1>${mv ? 'Add a movie' : 'Add a show'}</h1>`}
    ${kid || !config.tmdbKey ? '' : `<div class="seg qmode" role="group" aria-label="Search for"><button type="button" data-act="qmode" data-mode="tv" class="${mv ? '' : 'on'}" aria-pressed="${!mv}">📺 TV shows</button><button type="button" data-act="qmode" data-mode="movie" class="${mv ? 'on' : ''}" aria-pressed="${mv}">🎬 Movies</button></div>`}
    <form class="search" id="searchForm"><input id="q" type="search" placeholder="${kid ? 'Search for a show…' : mv ? 'Search any movie…' : 'Search any show — Netflix, HBO, NBC, Hulu, Apple TV+…'}" autocomplete="off" autofocus>
    <button class="btn primary">Search</button></form><div id="results" class="rows"></div>`;
  const q = $('#q');
  q.value = sessionStorage.getItem('tvt.q') || '';
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(q.value), 350); });
  // Pressing Search/Enter, or clicking anywhere off the box, runs the search and then empties the box.
  const finish = async () => {
    clearTimeout(searchTimer);
    const text = q.value.trim(); q.value = '';
    if (text && text !== (searchMode() === 'movie' ? lastMovieQuery : lastQuery)) await doSearch(text);
    try { sessionStorage.removeItem('tvt.q'); } catch { }
  };
  q.addEventListener('blur', () => { if (document.hasFocus()) finish(); });   // not when switching apps/tabs
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); finish(); q.blur(); });
  if (q.value) doSearch(q.value); else drawResults();
};
async function doSearch(q) {
  q = q.trim(); sessionStorage.setItem('tvt.q', q);
  if (!q) { lastResults = []; lastQuery = ''; lastMovies = []; lastMovieQuery = ''; return drawResults(); }
  const seq = ++searchSeq;
  if (searchMode() === 'movie') {
    try {
      const r = (await tmdb(`/search/movie?query=${encodeURIComponent(q)}&include_adult=false&language=en-US&page=1`))?.results || [];
      if (seq !== searchSeq) return;
      lastMovies = r.map(trimMovie).filter(m => m.name); lastMovieQuery = q;
      drawResults();
    } catch (e) { toast(e.message); }
    return;
  }
  try {
    const r = await api(`/search/shows?q=${encodeURIComponent(q)}`) || [];
    if (seq !== searchSeq) return;
    lastResults = r.map(x => trimShow(x.show)); lastQuery = q;
    drawResults();
  } catch (e) { toast(e.message); }
}
function drawResults() {
  const box = $('#results'); if (!box) return;
  if (searchMode() === 'movie') return drawMovieResults(box);
  let list = lastResults, checking = false;
  if (isKid()) {   // only shows within the kid's limit; ratings are looked up once, then the results redraw
    const todo = list.filter(s => kidCanSee(s.id) === null && !kidTried.has(s.id));
    todo.forEach(s => { kidTried.add(s.id); kidPending.add(s.id); });
    if (todo.length) inFours(todo, s => ratingOf(s.id, s).finally(() => kidPending.delete(s.id))).finally(drawResults);
    checking = list.some(s => kidPending.has(s.id));
    list = list.filter(s => kidCanSee(s.id) === true);
  }
  if (!list.length) {
    box.innerHTML = `<p class="muted">${checking ? 'Checking ratings…' : !lastQuery ? 'Type a show name to search across every network and streaming service.'
      : isKid() && lastResults.length ? `No matches for “${esc(lastQuery)}” that ${esc(sharedOpen().name)} allows.` : `No matches for “${esc(lastQuery)}”.`}</p>`;
    return;
  }
  box.innerHTML = `<p class="sub">Results for “${esc(lastQuery)}”${checking ? ' · checking ratings…' : ''}</p>` + list.map(s => `<div class="row">${poster(s, '#/show/' + s.id)}
    <div class="info"><a href="#/show/${s.id}">${esc(s.name)}</a>
      <div class="sub">${[channel(s.network, s.name), s.premiered && s.premiered.slice(0, 4)].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="sub">${esc(s.summary.slice(0, 140))}${s.summary.length > 140 ? '…' : ''}</div></div>
    ${followBtn(s)}</div>`).join('');
}

function drawMovieResults(box) {
  if (!lastMovies.length) {
    box.innerHTML = `<p class="muted">${!lastMovieQuery ? 'Type a movie title to search.' : `No movies match “${esc(lastMovieQuery)}”.`}</p>`;
    return;
  }
  box.innerHTML = `<p class="sub">Movies matching “${esc(lastMovieQuery)}”</p>` + lastMovies.map(m => `<div class="row">${poster(m, '#/movie/' + m.id)}
    <div class="info"><a href="#/movie/${m.id}">${esc(m.name)}</a>
      <div class="sub">${['Movie', m.year].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="sub">${esc(m.summary.slice(0, 140))}${m.summary.length > 140 ? '…' : ''}</div></div>
    ${movieBtn(m)}</div>`).join('');
}

views.login = mode => {
  if (user) { location.hash = '#/account'; return; }
  const create = mode === 'create';
  if (!cloud.configured) {
    app.innerHTML = `<div class="empty"><h1>Accounts aren't switched on yet</h1>
      <p>The site owner still needs to connect a Firebase project (see the README). Until then everything saves on this device.</p>
      <a class="btn primary" href="#/">Back to my shows</a></div>`;
    return;
  }
  app.innerHTML = `<div class="auth">
    <h1>${create ? 'Create your account' : 'Welcome back'}</h1>
    <p class="sub">${create ? 'Your shows and checkmarks stay private to you and follow you to every device.' : 'Sign in to see your shows on this device.'}</p>
    <div class="seg"><a href="#/login" class="${create ? '' : 'on'}">Sign in</a><a href="#/login/create" class="${create ? 'on' : ''}">Create account</a></div>
    <button type="button" class="btn wide gbtn" data-act="google">${GOOGLE_G} Continue with Google</button>
    <div class="or"><span>or use email</span></div>
    <form id="authForm" class="stack">
      ${create ? '<div class="field"><label>Your name</label><input name="name" autocomplete="name" required></div>' : ''}
      <div class="field"><label>${create ? 'Email' : 'Email or username'}</label><input name="email" ${create ? 'type="email" autocomplete="email"' : 'autocomplete="username" autocapitalize="none" spellcheck="false"'} required></div>
      <div class="field"><label>Password${create ? ' (6+ characters)' : ''}</label><input name="password" type="password" minlength="6" autocomplete="${create ? 'new-password' : 'current-password'}" required></div>
      ${create ? '<div class="field"><label>Repeat password</label><input name="password2" type="password" minlength="6" autocomplete="new-password" required></div>' : ''}
      <p class="formerr" id="authErr" hidden></p>
      <button class="btn primary wide">${create ? 'Create account' : 'Sign in'}</button>
      ${create ? '' : '<button type="button" class="linkbtn" data-act="forgot">Forgot password?</button>'}
    </form></div>`;
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target), btn = e.target.querySelector('.primary'), err = $('#authErr');
    if (create && fd.get('password') !== fd.get('password2')) {
      err.textContent = 'Passwords don\'t match — please type the same password in both boxes.'; err.hidden = false;
      e.target.password2.focus(); return;
    }
    btn.disabled = true; err.hidden = true;
    try {
      if (create) {
        const u = await cloud.signUp(String(fd.get('name')).trim(), String(fd.get('email')).trim(), String(fd.get('password')));
        if (user && user.uid === u.uid) { user.name = u.name; accountChip(); }
      } else await cloud.signIn(String(fd.get('email')).trim(), String(fd.get('password')));
    } catch (ex) {
      if (create && ex?.code === 'auth/email-already-in-use')   // maybe a Google account: offer to add this password to it
        err.innerHTML = `That email already has an account. If you signed up with Google, continue with Google and we'll add this password to that account.
          <button type="button" class="btn wide gbtn" data-act="google-add-password" style="margin-top:10px">${GOOGLE_G} Continue with Google</button>
          If you signed up with a password and don't remember it, <button type="button" class="linkbtn" data-act="forgot">email me a reset link</button>.`;
      else err.textContent = cloud.friendlyError(ex) +
        (!create && /invalid-credential|wrong-password/.test(ex?.code || '') && String(fd.get('email')).includes('@') ? ' If you signed up with Google, use Continue with Google.' : '');
      err.hidden = false; btn.disabled = false;
    }
  });
};

// Site owner only: every account, its type and list size.
// Contact us: a short form that lands on the Admin page.
views.contact = arg => {
  if (arg === 'sent') {
    app.innerHTML = `<div class="empty"><h1>Thanks — message sent</h1><p>We've got your message and will get back to you at the email you gave.</p><a class="btn primary" href="#/">Back to TV Tracker</a></div>`;
    return;
  }
  const email = user && !cloud.isLogin(user.email) ? user.email : '';
  app.innerHTML = `<div class="auth"><h1>Contact us</h1>
    <p class="sub">Questions, ideas, or something not working? Send a note and we'll reply by email.</p>
    <form id="contactForm" class="stack">
      <div class="field"><label>Your name</label><input name="name" autocomplete="name" required value="${esc(user?.name || '')}"></div>
      <div class="field"><label>Your email</label><input name="email" type="email" autocomplete="email" required value="${esc(email)}"></div>
      <div class="field"><label>Message</label><textarea name="message" rows="6" maxlength="5000" required></textarea></div>
      <p class="formerr" id="contactErr" hidden></p>
      <button class="btn primary wide">Send message</button></form></div>`;
  $('#contactForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('.primary'), err = $('#contactErr');
    btn.disabled = true; btn.textContent = 'Sending…'; err.hidden = true;
    try { await cloud.sendMessage({ name: f.name.value.trim(), email: f.email.value.trim(), message: f.message.value.trim() }); location.hash = '#/contact/sent'; }
    catch (x) { err.textContent = cloud.friendlyError(x); err.hidden = false; btn.disabled = false; btn.textContent = 'Send message'; }
  });
};

let adminAccounts = {};   // uid -> account, from the last Admin page load (for its Remove buttons)
views.admin = async (arg, quiet) => {   // quiet: pull-to-refresh keeps the page up while it reloads
  if (!user) { if (cloud.configured && !authReady) { app.innerHTML = SPLASH; return; } location.hash = '#/login'; return; }
  if (!cloud.isAdmin()) {
    app.innerHTML = `<div class="empty"><h1>Admin</h1><p>This page is only for the site owner.</p>
      <p class="sub">Your account ID: <code>${esc(user.uid)}</code></p></div>`;
    return;
  }
  if (!quiet) app.innerHTML = '<h1>Admin</h1><p class="loading">Loading accounts…</p>';
  let list, msgs = [], msgErr = '', gone = {};
  try { [list, msgs, gone] = await Promise.all([cloud.allAccounts(), cloud.messages().catch(x => { msgErr = cloud.friendlyError(x); return []; }),
    cloud.removals().catch(() => ({}))]); }
  catch (x) { if (route().name === 'admin') app.innerHTML = `<h1>Admin</h1><p class="formerr">${esc(cloud.friendlyError(x))}</p>`; return; }
  if (route().name !== 'admin') return;
  try { if (now() - (+localStorage.getItem('tvt.dirfill') || 0) > DAY) cloud.backfillDirectory(list).then(() => localStorage.setItem('tvt.dirfill', now())).catch(x => console.warn('directory backfill', x)); } catch { }
  const names = Object.fromEntries(list.map(a => [a.uid, a.name || a.email]));
  const removing = list.filter(a => gone[a.uid]);   // removed on this page; the hourly job finishes deleting them
  list = list.filter(a => !gone[a.uid]);
  const owners = list.filter(a => !a.listOf), logins = list.filter(a => a.listOf && !a.removed), removed = list.filter(a => a.removed);
  // Last login with its time, always in Arizona time (the site owner's), e.g. "Oct 27, 9:33 PM MST".
  const whenAz = t => t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }) : '—';   // year only if not this year, to fit on a phone
  const row = a => `<div class="memrow"><span><b>${esc(a.name || '(no name)')}</b>${a.uid === user.uid ? ' <span class="sub">(you)</span>' : ''}<br>
      <span class="sub">${esc(a.listOf ? 'Username: ' + cloud.loginName(a.email) + (a.removed ? ' · was a login for ' : ' · login for ') + (names[a.listOf] || 'a deleted account') : a.email || 'no email saved')}</span></span>
    <span class="sub admeta">${a.listOf ? '' : `<span>${a.shows} show${a.shows === 1 ? '' : 's'}</span>${a.logins ? ` · <span>${a.logins} login${a.logins === 1 ? '' : 's'}</span>` : ''}<br>`}<span>Last login</span> <span>${whenAz(a.lastLogin)}</span>${a.uid !== user.uid && !a.removed && !gone[a.uid] ? `<br><button class="btn xs danger" data-act="admin-remove" data-uid="${esc(a.uid)}">Remove</button>` : ''}</span></div>`;
  const byRecent = (a, b) => (b.lastLogin || b.updated) - (a.lastLogin || a.updated);   // most recently logged in first
  adminAccounts = Object.fromEntries(list.map(a => [a.uid, a]));
  const msgRow = m => `<div class="msg"><div class="msghead"><span><b>${esc(m.name || '(no name)')}</b> ${m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : '<span class="sub">no email</span>'}</span>
      <span class="sub">${esc(new Date(m.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}
      <button class="btn xs" data-act="del-msg" data-id="${esc(m.id)}">Delete</button></span></div><p>${esc(m.message)}</p></div>`;
  app.innerHTML = `<div class="toolbar"><h1>Admin</h1><span class="sub">${list.length} account${list.length === 1 ? '' : 's'} · ${owners.length} with their own list · ${logins.length} login${logins.length === 1 ? '' : 's'} made for others${removed.length ? ` · ${removed.length} removed` : ''}</span></div>
    <div class="panel"><h3>Contact us messages · ${msgs.length}</h3>${msgErr ? `<p class="formerr">${esc(msgErr)}</p>` : msgs.map(msgRow).join('') || '<p>No messages yet.</p>'}</div>
    <div class="panel"><h3>Accounts · ${owners.length}</h3>${owners.sort(byRecent).map(row).join('') || '<p>None yet.</p>'}</div>
    ${logins.length ? `<div class="panel"><h3>Logins made for others · ${logins.length}</h3>${logins.sort(byRecent).map(row).join('')}</div>` : ''}
    ${removed.length ? `<div class="panel"><h3>Removed logins · ${removed.length}</h3><p>Their owner took away their access, so they can't see any list. The sign-in itself still exists — delete it in the Firebase console under Authentication → Users if it isn't needed.</p>${removed.sort(byRecent).map(row).join('')}</div>` : ''}
    ${removing.length ? `<div class="panel"><h3>Being removed · ${removing.length}</h3><p>Locked out already. Their sign-in and data are deleted within the hour.</p>${removing.sort(byRecent).map(row).join('')}</div>` : ''}
    <p class="sub">Counts accounts that have saved anything. Last login is the last time someone opened the site signed in (Arizona time); it shows — until their next visit. Newest logins are listed first. Every sign-up is in the Firebase console under Authentication → Users.</p>`;
};

views.account = () => {
  if (!user) {
    if (cloud.configured && !authReady) { app.innerHTML = SPLASH; return; }
    location.hash = '#/login'; return;
  }
  const sh = sharedOpen();
  const pwBtn = cloud.usesPassword() ? '<button class="btn" data-act="change-password">Change password</button>'
    : '<button class="btn" data-act="add-password">Add a password</button>';   // Google-only: lets them also sign in with email + password
  if (cloud.isLogin(user.email)) {   // a login someone made: it only opens their list
    app.innerHTML = `<h1>Account</h1>
    <div class="panel"><h3>${esc(user.name)}</h3><p>Username: <b>${esc(cloud.loginName(user.email))}</b></p>
      <p>${sh ? `You're using <b>${esc(sh.name)}'s</b> list${sh.role === 'view' ? ' (view only)' : sh.role === 'kid' ? `. ${esc(sh.name)} chooses which shows you see, and your checkmarks are your own`
        : ' and can make changes'}. ${esc(sh.name)} made this login and can change or remove it.`
        : 'This login no longer has access to a list. Ask the person who made it to add you again.'}</p>
      <div class="actions">${pwBtn}<button class="btn" data-act="signout">Sign out</button></div></div>`;
    return;
  }
  app.innerHTML = `<h1>Account</h1>
  <div class="panel"><h3>${esc(user.name)}</h3><p>${esc(user.email)}</p>
    <p>Your shows and checkmarks are private to you (and anyone you make a login for) and sync automatically to every device you sign in on.</p>
    <div class="actions">${pwBtn}<button class="btn" data-act="signout">Sign out</button></div></div>
  <div class="panel"><h3>Share your list</h3>
    <p>Make a login for someone so they can use your list. They sign in with the username and password you choose here. <b>Can view</b> lets them see what you're watching and where you're up to. <b>Can edit</b> also lets them add and remove shows and check off episodes, just like you. <b>Kid</b> shows only the shows you allow — up to a rating you pick, minus any you hide — and they keep their own checkmarks but can't add or remove shows.</p>
    <form class="stack" id="loginForm" autocomplete="off">
      <div class="lgrid">
        <div class="field"><label>Their name</label><input name="name" required></div>
        <div class="field"><label>Username</label><input name="username" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,29}" title="3–30 letters, numbers, dots, dashes or underscores" autocapitalize="none" spellcheck="false"></div>
        <div class="field"><label>Password (6+ characters)</label><input name="password" type="text" minlength="6" required autocomplete="new-password"></div>
        <div class="field"><label>Access</label><select name="role" class="rolesel"><option value="edit">Can edit</option><option value="view">Can view</option><option value="kid">Kid</option></select></div>
      </div>
      <p class="formerr" id="loginErr" hidden></p>
      <div class="actions"><button class="btn primary">Create login</button></div></form>
    <div id="loginList"></div></div>
  <div class="panel"><h3>Recommending shows</h3>
    <label class="checkrow"><input type="checkbox" id="findable" ${findable ? 'checked' : ''}> Let people find me by my exact full name when they send a show</label>
    <p class="sub">Only someone who types your whole name (${esc(user.name)}) finds you — there's no browsing or partial search. Anyone with your email can still send you a show. Shows people send appear at the top of My Shows.</p>
    ${cloud.recEmailEnabled ? `<label class="checkrow"><input type="checkbox" id="recEmail" disabled> Email me when someone recommends a show to me</label>` : ''}
    ${Object.keys(blocked).length ? `<p>Blocked from sending you shows:</p>${Object.entries(blocked).map(([uid, b]) => `<div class="memrow"><span><b>${esc(b.name || '(no name)')}</b><br><span class="sub">${esc(cloud.loginName(b.email))}</span></span>
      <button class="btn xs" data-act="unblock" data-uid="${esc(uid)}" data-name="${esc(b.name || 'them')}">Unblock</button></div>`).join('')}` : ''}</div>
  ${cloud.weeklyEmailEnabled ? `<div class="panel"><h3>Weekly email</h3>
    <label class="checkrow"><input type="checkbox" id="weeklyEmail" disabled> Email me once a week when new episodes of my shows are out</label>
    <p class="sub">Sent on Sundays to ${esc(user.email)}, only when there's something new you haven't checked off.</p></div>` : ''}
  <div class="panel"><h3>Questions or feedback?</h3><p>Send a note and we'll reply by email.</p><div class="actions"><a class="btn" href="#/contact">✉ Contact us</a></div></div>
  <div class="panel"><h3>Delete account</h3>
    <p>Permanently delete your account and all of your data.</p>
    <div class="actions"><button class="btn danger" data-act="delete-account">Delete account</button></div></div>
  ${cloud.isAdmin() ? '<div class="panel"><h3>Site admin</h3><p>See every account on the site.</p><div class="actions"><a class="btn" href="#/admin">Open admin page</a></div></div>' : ''}`;
  drawLogins();
  $('#findable').onchange = async e => {
    const on = e.target.checked; e.target.disabled = true;
    try { await cloud.setFindable(on, user.name); findable = on; toast(on ? 'People can find you by name' : 'You\'re hidden from name search'); }
    catch (x) { e.target.checked = !on; toast(cloud.friendlyError(x)); }
    e.target.disabled = false;
  };
  const we = $('#weeklyEmail');
  if (we) cloud.weeklyEmailOn().then(on => { we.checked = on; we.disabled = false; }).catch(x => console.warn('weekly email setting', x));
  if (we) we.onchange = async () => {
    we.disabled = true;
    try { await cloud.setWeeklyEmail(we.checked); toast(we.checked ? 'Weekly email switched on' : 'Weekly email switched off'); }
    catch (x) { we.checked = !we.checked; toast(cloud.friendlyError(x)); }
    we.disabled = false;
  };
  const re = $('#recEmail');
  if (re) cloud.recEmailOn().then(on => { re.checked = on; re.disabled = false; }).catch(x => console.warn('recommendation email setting', x));
  if (re) re.onchange = async () => {
    re.disabled = true;
    try { await cloud.setRecEmail(re.checked); toast(re.checked ? 'You\'ll get an email when someone recommends a show' : 'Recommendation emails switched off'); }
    catch (x) { re.checked = !re.checked; toast(cloud.friendlyError(x)); }
    re.disabled = false;
  };
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = $('#loginErr'), btn = f.querySelector('.primary');
    const name = f.name.value.trim(), username = f.username.value.trim(), password = f.password.value, role = f.role.value;
    err.hidden = true; btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const copy = role === 'kid' ? await kidCopyFor({ maxRating: config.tmdbKey ? KID_DEFAULT_RATING : '', hide: {} }) : null;
      await cloud.addLogin(name, username, password, role, copy);
      f.reset(); drawLogins();
      toast(`Login created — ${name} can sign in with username ${username.toLowerCase()}${role === 'kid' ? '. Tap What they see to choose their shows' : ''}`);
    } catch (x) { err.textContent = cloud.friendlyError(x); err.hidden = false; }
    btn.disabled = false; btn.textContent = 'Create login';
  });
};
async function drawLogins() {
  const box = $('#loginList'); if (!box) return;
  try {
    const list = await cloud.logins(), byUid = Object.fromEntries(list.map(l => [l.uid, l]));
    const opt = (l, v, t) => `<option value="${v}"${l.role === v ? ' selected' : ''}>${t}</option>`;
    box.innerHTML = list.length ? '<p class="sub" style="margin-top:12px">Logins for your list</p>' + list.map(l => `<div class="memrow"><span><b>${esc(l.name)}</b><br><span class="sub">Username: ${esc(l.username)}${l.role === 'kid'
        ? ` · ${l.maxRating ? 'up to ' + esc(l.maxRating) : 'any rating'}${l.maxRating && Object.keys(l.allow).length ? ` · ${Object.keys(l.allow).length} allowed` : ''}${Object.keys(l.hide).length ? ` · ${Object.keys(l.hide).length} hidden` : ''}` : ''}</span></span>
      <span class="actions">${l.role === 'kid' ? `<button class="btn sm" data-act="kid-settings" data-uid="${esc(l.uid)}">What they see</button>` : ''}
      <select class="rolesel" data-uid="${esc(l.uid)}" aria-label="Access for ${esc(l.name)}">${opt(l, 'view', 'Can view')}${opt(l, 'edit', 'Can edit')}${opt(l, 'kid', 'Kid')}</select>
      <button class="btn sm" data-act="remove-login" data-uid="${esc(l.uid)}" data-name="${esc(l.name)}">Remove</button></span></div>`).join('') : '';
    box.querySelectorAll('select.rolesel').forEach(sel => sel.onchange = async () => {
      const l = byUid[sel.dataset.uid], role = sel.value;
      try {
        // Switching to Kid: choose what they'll see first, so the login never sees more than it should.
        const settings = role === 'kid' ? await kidSettingsDialog(l.name, { maxRating: config.tmdbKey ? KID_DEFAULT_RATING : '', hide: {}, allow: {} }) : null;
        if (role === 'kid' && !settings) { sel.value = l.role; return; }
        await saveLogin(l.uid, role, settings);
        toast(`Access changed to ${role === 'view' ? 'view only' : role === 'kid' ? 'kid' : 'can edit'}`); drawLogins();
      } catch (x) { toast(cloud.friendlyError(x)); drawLogins(); }
    });
    box.querySelectorAll('[data-act="kid-settings"]').forEach(b => b.onclick = async () => {
      const l = byUid[b.dataset.uid], settings = await kidSettingsDialog(l.name, l);
      if (!settings) return;
      try { await saveLogin(l.uid, 'kid', settings); toast(`Saved what ${l.name} can see`); drawLogins(); }
      catch (x) { toast(cloud.friendlyError(x)); }
    });
  } catch (x) { box.innerHTML = `<p class="formerr">${esc(cloud.friendlyError(x))}</p>`; }
}
function changePasswordDialog() {
  const d = $('#appDialog');
  d.innerHTML = `<form class="stack" id="pwForm"><h2>Change password</h2>
    <div class="field"><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div>
    <div class="field"><label>New password (6+ characters)</label><input name="password" type="password" minlength="6" autocomplete="new-password" required></div>
    <div class="field"><label>Repeat new password</label><input name="password2" type="password" minlength="6" autocomplete="new-password" required></div>
    <p class="formerr" id="pwErr" hidden></p>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Change password</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  $('#pwForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('.primary'), err = $('#pwErr');
    err.hidden = true;
    if (f.password.value !== f.password2.value) {
      err.textContent = 'New passwords don\'t match — please type the same password in both boxes.'; err.hidden = false;
      f.password2.focus(); return;
    }
    btn.disabled = true; btn.textContent = 'Changing…';
    try {
      await cloud.changePassword(f.current.value, f.password.value);
      d.close(); toast('Password changed');
    } catch (x) {
      err.textContent = /invalid-credential|wrong-password/.test(x?.code || '') ? 'Current password is incorrect.' : cloud.friendlyError(x);
      err.hidden = false; btn.disabled = false; btn.textContent = 'Change password';
    }
  };
  d.showModal();
}
// Google-only account: add a password so the same email + password also opens this list.
function addPasswordDialog() {
  const d = $('#appDialog');
  d.innerHTML = `<form class="stack" id="addPwForm"><h2>Add a password</h2>
    <p>You'll be able to sign in with <b>${esc(user.email)}</b> and this password, as well as with Google. Both open the same list.</p>
    <div class="field"><label>Password (6+ characters)</label><input name="password" type="password" minlength="6" autocomplete="new-password" required></div>
    <div class="field"><label>Repeat password</label><input name="password2" type="password" minlength="6" autocomplete="new-password" required></div>
    <p class="formerr" id="addPwErr" hidden></p>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Add password</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  $('#addPwForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('.primary'), err = $('#addPwErr');
    err.hidden = true;
    if (f.password.value !== f.password2.value) {
      err.textContent = 'Passwords don\'t match — please type the same password in both boxes.'; err.hidden = false;
      f.password2.focus(); return;
    }
    btn.disabled = true; btn.textContent = 'Adding…';
    try { await cloud.addPassword(f.password.value); d.close(); toast('Password added'); render(); }
    catch (x) { err.textContent = cloud.friendlyError(x); err.hidden = false; btn.disabled = false; btn.textContent = 'Add password'; }
  };
  d.showModal();
}
// Google sign-in refused because the email already has a password account: prove it with the password, then add Google to it.
function linkGoogleDialog() {
  const d = $('#appDialog'), email = cloud.pendingGoogleEmail();
  d.innerHTML = `<form class="stack" id="linkForm"><h2>You already have an account</h2>
    <p>There's already an account for <b>${esc(email || 'this email')}</b> with a password. Enter that password to sign in, and Google sign-in will be added to the same account.</p>
    <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    <p class="formerr" id="linkErr" hidden></p><p class="sub" id="linkMsg" hidden></p>
    <button type="button" class="linkbtn" data-reset>Forgot password? Email me a reset link</button>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Sign in and add Google</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  d.querySelector('[data-reset]').onclick = async () => {   // they can set a new one from the email, then enter it here
    const err = $('#linkErr'), msg = $('#linkMsg');
    err.hidden = msg.hidden = true;
    try { await cloud.resetPassword(email); msg.textContent = `Reset email sent to ${email}. Set a new password from it, then enter that password here.`; msg.hidden = false; }
    catch (x) { err.textContent = cloud.friendlyError(x); err.hidden = false; }
  };
  $('#linkForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('.primary'), err = $('#linkErr');
    btn.disabled = true; err.hidden = true;
    try { await cloud.linkPendingGoogle(e.target.password.value); d.close(); toast('Signed in — you can now also use Continue with Google'); }
    catch (x) { err.textContent = cloud.friendlyError(x); err.hidden = false; btn.disabled = false; }
  };
  d.showModal();
}
function deleteAccountDialog() {
  const pw = cloud.usesPassword(), d = $('#appDialog');
  d.innerHTML = `<form class="stack" id="delForm"><h2>Delete your account?</h2>
    <p>This permanently deletes your account and <b>all of your data</b> — your shows and every episode you've checked off. This can't be undone.</p>
    ${pw ? '<div class="field"><label>Enter your password to confirm</label><input name="password" type="password" autocomplete="current-password" required></div>'
         : '<p class="sub">You\'ll be asked to confirm with Google.</p>'}
    <p class="formerr" id="delErr" hidden></p>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn danger solid">Delete account</button></div></form>`;
  d.querySelector('[data-close]').onclick = () => d.close();
  $('#delForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('.danger'), err = $('#delErr');
    btn.disabled = true; btn.textContent = 'Deleting…'; err.hidden = true;
    try {
      clearTimeout(flushTimer); pending = null;     // nothing left to save
      await cloud.deleteAccount(pw ? e.target.password.value : null);
      d.close(); location.hash = '#/'; toast('Your account and data have been deleted');
    } catch (x) {
      err.textContent = cloud.friendlyError(x); err.hidden = false;
      btn.disabled = false; btn.textContent = 'Delete account';
    }
  };
  d.showModal();
}

/* ---------- merging + cloud sync ---------- */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
// last-write-wins per show / per episode, so edits from several devices combine cleanly
function mergeMap(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) { const c = o[k]; if (!c || (v.t || 0) > (c.t || 0)) o[k] = v; } return o; }
function merge(a, b) { return norm({ shows: mergeMap(a.shows, b.shows), watched: mergeMap(a.watched, b.watched), movies: mergeMap(a.movies, b.movies) }); }

let pending = null, flushTimer = null, inFlight = 0;
const saving = () => inFlight > 0;
function queue(kind, id, val) {
  if (!user || sharedOpen()?.role === 'view' || (kind !== 'watched' && isKid())) return;
  pending = pending || { shows: {}, watched: {}, movies: {} };
  pending[kind][id] = val;
  syncStatus('Syncing…');
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1000);  // pause so quick clicks and "Mark all" go up as one write
}
// Hands the batch to Firestore's on-device database (instant) without waiting for the server,
// so the next change never queues behind a slow network round trip.
function flush() {
  clearTimeout(flushTimer); flushTimer = null;
  if (!pending || !user) return;
  const batch = pending; pending = null; inFlight++;
  // Writes don't fail outright when the database is unreachable (e.g. blocked by an ad blocker) — they just wait.
  const slow = setTimeout(() => {
    syncStatus('Saved on this device — can\'t reach your account', true);
    toast('Your changes are saved on this device but aren\'t reaching your account. If you use an ad blocker or privacy extension, allow this site and reload.');
  }, 10000);
  // Empty maps are left out: merging an empty map would wipe that field on the server.
  const out = { watched: batch.watched };
  for (const k of ['shows', 'movies']) if (Object.keys(batch[k]).length) out[k] = batch[k];
  if (out.shows || out.movies) out.updated = now();
  return cloud.save(out)
    .then(() => { if (!--inFlight && !pending) syncStatus(); })
    .catch(e => {
      inFlight--; console.warn(e);
      if (e?.code === 'permission-denied' && sharedOpen()) { syncStatus(); onCloudError(e); return; }   // access changed: drop the change
      pending = { shows: { ...batch.shows, ...(pending?.shows || {}) }, watched: { ...batch.watched, ...(pending?.watched || {}) }, movies: { ...batch.movies, ...(pending?.movies || {}) } };
      syncStatus(cloud.friendlyError(e), true);
      flushTimer = setTimeout(flush, 5000);
    })
    .finally(() => clearTimeout(slow));
}

let firstSnapshot = true, serverSynced = false;   // serverSynced: the account's data has been confirmed by the server
let slowServer = false, slowTimer = null;          // slowServer: no answer from the server 10s after opening a list
function waitForServer() {
  slowServer = false; clearTimeout(slowTimer);
  slowTimer = setTimeout(() => { if (user && !serverSynced) { slowServer = true; render(); } }, 10000);
}
function onUser(u) {
  if (!u && user) {
    try {
      localStorage.removeItem(`${K.state}.${user.uid}`);
      if (user.linked) { localStorage.removeItem(`${K.state}.${user.linked.uid}`); localStorage.removeItem(`${K.state}.${user.linked.uid}.kid.${user.uid}`); }
    } catch { }
  }
  if (u) save(K.state, norm(null));              // shows added before signing in are cleared, not carried over
  user = u; authReady = true; firstSnapshot = true; serverSynced = false; pending = null; kidLogins = {}; kidSent = {}; kidLimit = { maxRating: '', block: [] };
  if (u) waitForServer();
  forgetFullList();
  state = norm(load(stateKey(), null));
  accountChip(); syncStatus();
  const r = route().name;
  if (u && r === 'login') {
    let back = '#/'; try { back = sessionStorage.getItem('tvt.return') || '#/'; sessionStorage.removeItem('tvt.return'); } catch { }
    location.hash = /login/.test(back) ? '#/' : back;
    addAfterSignIn();
  }
  else if (!(r === 'login' && !u)) render(true);   // don't wipe a sign-in form someone is typing in
  if (!openRefreshed) openRefresh();   // the list only just arrived, so do the opening refresh now
  refreshMissing();
}
// A show someone tapped Add on before they had an account (e.g. from a recommendation) is added once they're in.
// The friend's name on a recommendation link (#/show/<id>/<name>) while that show's page is open.
function linkFrom(id) {
  const r = route(); if (r.name !== 'show' || +r.arg !== id) return '';
  try { return decodeURIComponent(r.extra || '').trim().slice(0, 40); } catch { return ''; }
}
function addAfterSignIn() {
  let id = 0, from = ''; try { id = +sessionStorage.getItem('tvt.addAfter') || 0; from = sessionStorage.getItem('tvt.addFrom') || '';
    sessionStorage.removeItem('tvt.addAfter'); sessionStorage.removeItem('tvt.addFrom'); } catch { }
  if (!id || isFollowed(id) || !requireAccount(true)) return;
  (cache[id] ? Promise.resolve(cache[id]) : fetchShow(id)).then(c => {
    if (!c || !user || isFollowed(id)) return;
    follow(c.show, !!from, from); render(); toast(from ? `Added ${c.show.name} — it's under Recommended by friends until you start it` : `Added ${c.show.name} to your shows`);
  }).catch(() => {});
}
function onData(data, fromServer) {
  if (!user) return;
  const confirmed = fromServer && !serverSynced;
  if (fromServer) { serverSynced = true; slowServer = false; }
  if (!data && fromServer && cloud.activeUid() === user.uid) {   // brand-new account: create its document
    cloud.save({ profile: { name: user.name, email: user.email }, updated: now() }).catch(onCloudError);
  }
  const first = firstSnapshot;
  const remote = norm(data);
  if (isKid()) {   // exactly the shows allowed for this kid, never ones left on this device
    state.shows = remote.shows; state.movies = {};
    kidLimit = { maxRating: data?.maxRating || '', block: data?.block || [] };
  }
  // Anything this device changed that the server hasn't seen yet (e.g. edits made offline) gets uploaded.
  for (const kind of ['shows', 'watched', 'movies'])
    for (const [k, v] of Object.entries(state[kind])) { const r = remote[kind][k]; if (!r || (v.t || 0) > (r.t || 0)) queue(kind, k, v); }
  const merged = merge(state, remote);
  const changed = canon(merged) !== canon(state);
  state = merged; persist();
  firstSnapshot = false;
  if (changed || first || confirmed) { render(); refreshMissing(); }
  if (serverSynced && (!sharedOpen() || sharedOpen().role === 'edit')) { kidLogins = data?.logins || {}; syncKidsSoon(); }
  if (serverSynced && !sharedOpen() && cloud.activeUid() === user.uid) {   // your own list: who you blocked, and keep you findable
    const was = canon(blocked) + findable;
    blocked = data?.blocked || {}; findable = data?.findable !== false;
    if (was !== canon(blocked) + findable && route().name === 'account') render();
    if (data && !cloud.isLogin(user.email)) cloud.listInDirectory(user.name, findable).catch(x => console.warn('directory', x));
  }
}
function onCloudError(e) {
  console.warn(e);
  if (e?.code === 'auth/account-exists-with-different-credential') { linkGoogleDialog(); return; }   // after a Google redirect sign-in
  if (e?.code === 'permission-denied' && sharedOpen()) {   // the owner changed or removed this login
    const name = sharedOpen().name;
    const wasKid = isKid();
    cloud.relink().then(l => {
      if (l && (l.role === 'kid') !== wasKid) { user.linked = l; openList(); toast(`${name} changed what you can see`); return; }   // kid ↔ adult: reopen the list the other way
      if (l) { user.linked = l; accountChip(); toast(l.role === 'view' ? `${name} changed your access to view only` : 'Couldn\'t save that change — try again'); return; }
      user.linked = null; openList(); toast(`You no longer have access to ${name}'s list`);
    });
    return;
  }
  syncStatus(cloud.friendlyError(e), true);
}
// Re-opens the list after the owner of a shared list changed this login: the shared list again (user.linked, as a kid or
// not), or the signed-in user's own list if the login was removed.
function openList() {
  flush();
  cloud.openAccount(user.linked?.uid || user.uid, user.linked?.role === 'kid');
  firstSnapshot = true; serverSynced = false; pending = null; waitForServer();
  forgetFullList();
  state = norm(load(stateKey(), null));
  accountChip(); syncStatus(); render(true); refreshMissing();
}
function refreshMissing() { if (followed().some(f => !cache[f.id])) refreshAll(false); }

/* ---------- UI helpers ---------- */
function syncStatus(text, err) {
  const el = $('#sync');
  el.className = 'sync' + (err ? ' err' : !text && user ? ' ok' : '');
  el.textContent = text || (user ? 'Saved to account' : cloud.configured ? '' : 'Saved on this device');
  el.title = text || '';
}
function accountChip() {
  const el = $('#acct');
  $('#topout').hidden = !user;
  if (!cloud.configured) { el.hidden = true; return; }
  el.hidden = false;
  const sh = sharedOpen();
  if (user) { el.href = '#/account'; el.className = 'acct on'; el.innerHTML = `<span class="av">${esc((user.name || user.email || '?')[0].toUpperCase())}</span><span class="nm">${esc(sh ? `${sh.name}'s list${sh.role === 'view' ? ' (view only)' : ''}` : user.name)}</span>`; }
  else { el.href = '#/login'; el.className = 'acct'; el.textContent = authReady ? 'Sign in' : ''; }
}
function busy(text) { const b = $('#busy'); if (text) { b.textContent = text; b.hidden = false; } else b.hidden = true; }
let toastTimer = null;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
  t.hidden = false;
  if (undo) t.querySelector('button').onclick = () => { undo(); t.hidden = true; render(); };
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, undo ? 6000 : 3200);
}

/* ---------- actions ---------- */
function markWithUndo(ids, w, label) {
  const prev = ids.map(id => [id, state.watched[id]]);
  const moved = setWatched(ids, w);
  render();
  toast(label + movedNote(moved), () => {
    const t = now();
    prev.forEach(([id, old]) => { state.watched[id] = { w: !!(old && old.w), t }; queue('watched', id, state.watched[id]); });
    moved.forEach(sid => { const s = state.shows[sid]; if (s) { s.later = true; s.t = t; queue('shows', sid, s); } });   // back to the Future watch list
    persist();
  });
}
// Moves a followed show onto (true) or off (false) the Future watch list.
function setLater(id, later) {
  if (!requireAccount(true)) return;
  const s = state.shows[id]; if (!s || s.removed) return;
  s.later = later; s.t = now(); queue('shows', id, s); persist(); render();
  toast(later ? `${s.name} moved to your Future watch list` : `${s.name} moved to Up next`, () => { s.later = !later; s.t = now(); queue('shows', id, s); persist(); });
}
const actions = {
  getapp() { getApp(); },
  'change-password'() { changePasswordDialog(); },
  'delete-account'() { deleteAccountDialog(); },
  async 'del-msg'(b) {
    if (!confirm('Delete this message?')) return;
    try { await cloud.deleteMessage(b.dataset.id); b.closest('.msg').remove(); } catch (x) { toast(cloud.friendlyError(x)); }
  },
  async 'admin-remove'(b) {
    const a = adminAccounts[b.dataset.uid]; if (!a) return;
    const who = a.name || (a.listOf ? cloud.loginName(a.email) : a.email) || 'this account';
    const extra = a.listOf ? 'This login will stop working right away.'
      : `They'll be locked out right away, and their list${a.logins ? ` and the ${a.logins} login${a.logins === 1 ? '' : 's'} they made for others` : ''} will stop working.`;
    if (!confirm(`Remove ${who}?\n\n${extra} Their sign-in and all their data are then permanently deleted within the hour. This can't be undone.`)) return;
    b.disabled = true;
    try { await cloud.removeAccount(a); toast(`${who} removed`); views.admin(null, true); }
    catch (x) { b.disabled = false; toast(cloud.friendlyError(x)); }
  },
  async 'remove-login'(b) {
    if (!confirm(`Remove ${b.dataset.name}'s login? They won't be able to see or change your list any more.`)) return;
    try { await cloud.removeLogin(b.dataset.uid); toast(`${b.dataset.name} no longer has access`); drawLogins(); } catch (x) { toast(cloud.friendlyError(x)); }
  },
  watch(b) {
    if (!requireAccount() || b.classList.contains('on')) return;
    const id = +b.dataset.ep, f = findEp(id);
    b.classList.add('on');   // tick the box first, then move the card on to the next episode
    setTimeout(() => markWithUndo([id], true, f ? `${f.c.show.name} ${code(f.e)} watched` : 'Marked watched'), 550);
  },
  season(b, e) {
    if (!requireAccount()) { e.preventDefault(); e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
    const sid = +b.dataset.show, n = +b.dataset.season, val = b.dataset.val === '1';
    const eps = cache[sid].episodes.filter(x => x.s === n && (!val || aired(x)));
    if (val && !isFollowed(sid)) follow(cache[sid].show);
    markWithUndo(eps.map(x => x.id), val, `Season ${n} ${val ? 'marked watched' : 'unmarked'}`);
  },
  upto(b) {
    if (!requireAccount()) return;
    const sid = +b.dataset.show, id = +b.dataset.ep, eps = cache[sid].episodes;
    const idx = eps.findIndex(x => x.id === id);
    const ids = eps.slice(0, idx + 1).filter(x => aired(x) && !isWatched(x.id)).map(x => x.id);
    if (!isFollowed(sid)) follow(cache[sid].show);
    markWithUndo(ids, true, `Marked ${ids.length} episode${ids.length === 1 ? '' : 's'} watched`);
  },
  'follow-later'(b) { return actions.follow(b, null, true); },
  'later-on'(b) { setLater(+b.dataset.show, true); },
  // A show a friend recommended outside the app (or before Recommended by friends existed): waits there until it's started.
  'to-friends'(b) {
    if (!requireAccount(true)) return;
    const id = +b.dataset.show, s = state.shows[id]; if (!s || s.removed) return;
    const who = (prompt(`Who recommended ${s.name}?`) || '').trim().slice(0, 100); if (!who) return;
    s.rec = who; s.later = true; s.t = now(); queue('shows', id, s); persist(); render();
    toast(`${s.name} moved to Recommended by friends`);
  },
  'later-off'(b) { setLater(+b.dataset.show, false); },
  async follow(b, e, later) {
    const id = +b.dataset.show;
    const from = later ? '' : linkFrom(id);   // opened from a friend's recommendation link: remember who
    if (needsAccount() && authReady) try { sessionStorage.setItem('tvt.addAfter', id); sessionStorage.setItem('tvt.addFrom', from); } catch { }   // added once they've signed up
    if (!requireAccount(true)) return;
    const s = cache[id]?.show || showLookup[id] || lastResults.find(x => x.id === id) || meta.discover?.items.find(x => x.show.id === id)?.show;
    if (!s) return;
    follow(s, later || !!from, from); render();   // search results stay put so you can add more
    toast(from ? `${s.name} added — it's under Recommended by friends until you start it` : later ? `${s.name} added to your Future watch list` : `Added ${s.name}`);
    if (!cache[id]) { try { await fetchShow(id); render(); } catch { } }
  },
  unfollow(b) {
    if (!requireAccount(true)) return;
    const id = +b.dataset.show, name = showInfo(id)?.name || 'show';
    unfollow(id); render();
    toast(`Removed ${name}`, () => { const s = state.shows[id]; s.removed = false; s.t = now(); persist(); });
  },
  qmode(b) {
    const q = $('#q')?.value.trim() || (searchMode() === 'movie' ? lastMovieQuery : lastQuery);
    try { sessionStorage.setItem('tvt.qmode', b.dataset.mode); } catch { }
    render(true);
    const done = b.dataset.mode === 'movie' ? lastMovieQuery : lastQuery;
    if (q && q !== done) doSearch(q);   // same words, now searched in the other mode
  },
  'movie-add'(b, e, seen) {
    if (!requireAccount(true)) return;
    const id = +b.dataset.movie, m = movieCache[id] || lastMovies.find(x => x.id === id) || state.movies[id];
    if (!m) return;
    if (state.movies[id]) setMovie(id, { removed: false, w: !!seen }); else addMovie(m, seen);
    render(); toast(seen ? `${m.name} added to Watched movies` : `Added ${m.name} to Movies to watch`);
  },
  'movie-seen'(b, e) { return actions['movie-add'](b, e, true); },
  'movie-watch'(b) {
    if (!requireAccount() || b.classList.contains('on')) return;
    const id = +b.dataset.movie, m = state.movies[id]; if (!m) return;
    b.classList.add('on');
    setTimeout(() => { setMovie(id, { w: true }); render(); toast(`${m.name} watched`, () => { setMovie(id, { w: false }); render(); }); }, b.classList.contains('watchbtn') ? 550 : 0);
  },
  'movie-unwatch'(b) {
    if (!requireAccount()) return;
    const id = +b.dataset.movie; if (!state.movies[id]) return;
    setMovie(id, { w: false }); render(); toast(`${state.movies[id].name} moved back to Movies to watch`);
  },
  'movie-remove'(b) {
    if (!requireAccount(true)) return;
    const id = +b.dataset.movie, m = state.movies[id]; if (!m) return;
    setMovie(id, { removed: true }); render();
    toast(`Removed ${m.name}`, () => { setMovie(id, { removed: false }); render(); });
  },
  net(b) { save(K_NET, b.dataset.net); render(); },
  day(b) { save(K_DAY, b.dataset.day); render(); },
  // Signed in (not a kid): send it to someone's account or share a link; otherwise just share a link.
  recommend(b) {
    const id = +b.dataset.show, s = showInfo(id) || cache[id]?.show; if (!s) return;
    user && !isKid() ? sendShowDialog(s) : shareLink(s);
  },
  async 'inbox-accept'(b) {
    const m = inbox.find(x => x.id === b.dataset.id); if (!m || !requireAccount(true)) return;
    follow(m.show, true, m.fromName); cloud.dismissShow(m.id).catch(x => console.warn('inbox', x));
    render(); toast(`${m.show.name} added — it's under Recommended by friends until you start it`);
    if (!cache[m.show.id]) { try { await fetchShow(m.show.id); render(); } catch { } }
  },
  'inbox-dismiss'(b) { cloud.dismissShow(b.dataset.id).catch(x => toast(cloud.friendlyError(x))); },
  async 'inbox-block'(b) {
    const m = inbox.find(x => x.id === b.dataset.id); if (!m) return;
    if (!confirm(`Block ${m.fromName}? They won't be able to send you shows any more. You can unblock them on the Account page.`)) return;
    try { await cloud.blockSender(m, inbox); toast(`Blocked ${m.fromName}`); } catch (x) { toast(cloud.friendlyError(x)); }
  },
  async unblock(b) {
    try { await cloud.unblock(b.dataset.uid); toast(`Unblocked ${b.dataset.name}`); } catch (x) { toast(cloud.friendlyError(x)); }
  },
  // Back to the page this show was opened from; opened straight from a link, go to My Shows.
  back() { if (navDepth > 0) { restoreScroll = true; history.back(); } else location.hash = '#/'; },
  'older-seasons'(b) { showOldSeasons.add(+b.dataset.show); render(); },
  'discover-refresh'() { delete meta.discover; for (const id in tm.recs) tm.recs[id].t = 0; recsAt = 0; render(); },
  async 'rec-open'(b) { const s = await recShow(b); if (s) { showLookup[s.id] = s; location.hash = '#/show/' + s.id; } },
  async 'rec-add'(b) {
    if (!requireAccount(true)) return;
    const s = await recShow(b); if (!s) return;
    showLookup[s.id] = s; tm.map[s.id] = +b.dataset.tmdb; save(K_TMDB, tm);
    follow(s); render(); toast(`Added ${s.name}`);
    if (!cache[s.id]) { try { await fetchShow(s.id); render(); } catch { } }
  },
  async google() {
    try { await cloud.google(); } catch (e) {
      if (e?.code === 'auth/account-exists-with-different-credential') { linkGoogleDialog(); return; }
      const el = $('#authErr'); if (el) { el.textContent = cloud.friendlyError(e); el.hidden = false; } else toast(cloud.friendlyError(e));
    }
  },
  async 'google-add-password'() {
    const f = $('#authForm');
    try {
      const added = await cloud.googleThenAddPassword(f.email.value.trim(), f.password.value);
      toast(added ? 'Signed in — you can now also sign in with your email and password' : 'Signed in with Google');
    } catch (e) {
      if (e?.code === 'auth/account-exists-with-different-credential') { linkGoogleDialog(); return; }
      const el = $('#authErr');   // gone if the Google sign-in already went through
      if (el) { el.textContent = cloud.friendlyError(e); el.hidden = false; } else toast(cloud.friendlyError(e));
    }
  },
  'add-password'() { addPasswordDialog(); },
  async forgot() {
    const email = $('#authForm input[name=email]')?.value.trim(), el = $('#authErr');
    if (!email) { el.textContent = 'Type your email above first, then tap "Forgot password?"'; el.hidden = false; return; }
    if (!email.includes('@')) { el.textContent = 'Logins with a username can\'t reset their password by email. Ask the person who made your login to remove it and make a new one.'; el.hidden = false; return; }
    try { await cloud.resetPassword(email); toast('Password reset email sent'); } catch (e) { el.textContent = cloud.friendlyError(e); el.hidden = false; }
  },
  async signout() {
    // Signing out clears this device's copy, so make sure every change has reached the account first.
    const deadline = now() + 8000;
    flush();
    while (!serverSynced && now() < deadline) await sleep(100);
    await Promise.race([cloud.waitForPendingWrites(), sleep(Math.max(0, deadline - now()))]);
    await sleep(50);                              // let the save callbacks settle
    if ((pending || saving() || !serverSynced) && !confirm('Your shows haven\'t been saved to your account — the site can\'t reach it right now (an ad blocker or privacy extension can cause this).\n\nIf you sign out, the shows on this computer will be deleted.\n\nSign out anyway?')) return;
    await cloud.signOut(); location.hash = '#/'; toast('Signed out');
  },
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return;
  const fn = actions[b.dataset.act]; if (fn) fn(b, e);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (!t.matches('input[data-act="toggle"]')) return;
  if (!requireAccount()) { t.checked = !t.checked; return; }
  const sid = +t.dataset.show, id = +t.dataset.ep;
  if (t.checked && !isFollowed(sid) && cache[sid] && !isKid()) follow(cache[sid].show);
  const moved = setWatched([id], t.checked);
  render();
  if (moved.length) toast(movedNote(moved).slice(3).replace(/^./, c => c.toUpperCase()));
});
// A filter logo that won't load falls back to the network's name.
document.addEventListener('error', e => {
  const im = e.target;
  if (!im.matches?.('.nchip img')) return;
  im.closest('.nchip').classList.replace('logo', 'stack');   // name over the count, like other services
  im.replaceWith(im.dataset.name);
}, true);
/* ---------- pull to refresh (My Shows and Admin, touch screens) ----------
   Swipe down from the top of the page: a bubble follows the finger, and letting go past the mark reloads that page's data. */
const PTR_PAGES = {
  shows: { busy: () => refreshing, msg: 'Checking for new episodes…', run: () => refreshAll(true) },
  admin: { busy: () => false, msg: 'Refreshing…', run: () => cloud.isAdmin() && views.admin(null, true) }
};
const ptr = document.createElement('div');
ptr.className = 'ptr'; ptr.setAttribute('aria-hidden', 'true');
ptr.innerHTML = '<span class="ptr-ico">↻</span><span class="ptr-txt"></span>';
document.body.append(ptr);
const PTR_GO = 64;
let ptrStart = null, ptrPull = 0;
const ptrHide = () => { ptr.classList.remove('show', 'spin'); ptr.style.transform = ''; };
document.addEventListener('touchstart', e => {
  ptrStart = null;
  const pg = PTR_PAGES[route().name];
  if (!pg || pg.busy() || ptr.classList.contains('spin') || scrollY > 0 || e.touches.length > 1 || document.body.classList.contains('landing')) return;
  ptrStart = e.touches[0].clientY; ptrPull = 0;
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (ptrStart == null) return;
  const d = Math.min(Math.max(0, e.touches[0].clientY - ptrStart) * .5, 90);   // resistance, like native pull-to-refresh
  ptrPull = scrollY > 0 ? 0 : d;
  if (!ptrPull) return ptrHide();
  ptr.classList.add('show');
  ptr.style.transform = `translateY(${ptrPull}px)`;
  ptr.querySelector('.ptr-ico').style.transform = `rotate(${ptrPull * 4}deg)`;
  ptr.querySelector('.ptr-txt').textContent = ptrPull >= PTR_GO ? 'Release to refresh' : 'Pull to refresh';
}, { passive: true });
document.addEventListener('touchend', () => {
  if (ptrStart == null) return;
  ptrStart = null;
  if (ptrPull < PTR_GO) return ptrHide();
  ptr.classList.add('spin'); ptr.style.transform = '';
  ptr.querySelector('.ptr-ico').style.transform = '';
  const pg = PTR_PAGES[route().name];
  ptr.querySelector('.ptr-txt').textContent = pg.msg;
  Promise.resolve(pg.run()).finally(() => setTimeout(ptrHide, 300));
});
document.addEventListener('touchcancel', () => { ptrStart = null; if (!ptr.classList.contains('spin')) ptrHide(); });

document.addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches || !d.matches('details.season')) return;
  const set = openSeasons[d.dataset.show] || (openSeasons[d.dataset.show] = new Set());
  d.open ? set.add(+d.dataset.season) : set.delete(+d.dataset.season);
}, true);

/* ---------- router ---------- */
function route() { const [name, arg, extra] = location.hash.replace(/^#\/?/, '').split('/'); return { name: name || 'shows', arg, extra }; }
function render(fromRoute) {
  const r = route();
  // A kid can't add shows: no Discover, and Add Show becomes Search (within the kid's rating limit).
  $('#tabs a[data-tab="discover"]').style.display = isKid() ? 'none' : '';
  const st = $('#tabs a[data-tab="search"]'); st.dataset.label ||= st.innerHTML;
  const label = isKid() ? '<span class="ico">⌕</span>Search' : st.dataset.label;
  if (st.innerHTML !== label) st.innerHTML = label;
  if (isKid() && r.name === 'discover') { location.hash = '#/'; return; }
  const tab = r.name === 'show' || r.name === 'movie' ? 'shows' : r.name === 'login' ? 'account' : r.name;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  document.body.classList.remove('landing');
  document.documentElement.classList.toggle('ptr-on', r.name in PTR_PAGES);   // our pull-to-refresh replaces the browser's here
  // Don't wipe forms the user is typing in on background updates.
  if (!fromRoute && r.name === 'search') return drawResults();
  if (!fromRoute && (r.name === 'login' || r.name === 'account') && document.activeElement?.tagName === 'INPUT') return;
  const y = scrollY;
  (views[r.name] || views.shows)(r.arg);
  if (!fromRoute) scrollTo(0, y);
}
// navDepth: pages visited inside the app this visit, so Back never leaves the site. Each page's scroll spot is kept
// so going back returns to where you were instead of the top.
let navDepth = 0, restoreScroll = false;
const scrollSpots = {};
window.addEventListener('scroll', () => { scrollSpots[location.hash] = scrollY; }, { passive: true });
window.addEventListener('hashchange', () => {
  const back = restoreScroll; restoreScroll = false;
  navDepth = back ? Math.max(0, navDepth - 1) : navDepth + 1;
  render(true); scrollTo(0, back ? scrollSpots[location.hash] || 0 : 0);
});
/* ---------- refresh on open ----------
   Every time the app is opened (launched, or switched back to after a few minutes away) it checks for new episodes,
   with the same spinning bubble as pull-to-refresh on My Shows so you can see it happening. */
const REOPEN_AFTER = 5 * 60e3;
let openRefreshed = false, hiddenAt = 0;
function openRefresh() {
  if (!followed().length) return;   // nothing to check yet (e.g. the signed-in list hasn't loaded)
  openRefreshed = true;
  if (refreshing) return;
  const show = route().name === 'shows' && !ptr.classList.contains('spin');
  if (show) { ptr.querySelector('.ptr-txt').textContent = 'Checking for new episodes…'; ptr.classList.add('spin'); }
  refreshAll(true, true).then(r => {
    if (!show) return;
    if (r && !r.failed) ptr.querySelector('.ptr-txt').textContent = r.n ? `Updated ${r.n} show${r.n > 1 ? 's' : ''}` : 'Up to date';
    setTimeout(ptrHide, r && !r.failed ? 900 : 0);
  }, () => show && ptrHide());
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { hiddenAt = now(); return; }
  if (hiddenAt && now() - hiddenAt > REOPEN_AFTER) openRefresh();
  else if (now() - (meta.lastRefresh || 0) > CHECK_EVERY) refreshAll(false);
});
window.addEventListener('pagehide', () => { flush(); });

/* ---------- install as an app ---------- */
let installPrompt = null;
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function appButton() { $('#getapp').hidden = installed(); }
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; appButton(); });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#appDialog').close?.(); $('#getapp').hidden = true; toast('TV Tracker added to your device'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
function installSteps() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) return ['On iPhone or iPad',
    ['Tap the <b>Share</b> button <span class="key">□↑</span> — in Safari it\'s in the toolbar (if you don\'t see it, tap <b>⋯</b> first); in Chrome it\'s at the top right.',
     'Scroll down and tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>. TV Tracker now opens from its own icon, like an app.']];
  if (/Android/.test(ua)) return ['On Android',
    ['Open the browser menu <span class="key">⋮</span> (top right in Chrome).', 'Tap <b>Add to Home screen</b> or <b>Install app</b>.', 'Tap <b>Install</b> or <b>Add</b>.']];
  if (/Firefox\//.test(ua)) return ['In Firefox',
    ['Firefox on computers can\'t install websites as apps.', 'Open this site in <b>Chrome</b>, <b>Edge</b> or <b>Safari</b> and tap <b>Get the app</b> there.']];
  if (/Edg\//.test(ua)) return ['In Edge',
    ['Click the <b>App available</b> icon at the right of the address bar,', 'or open the menu <span class="key">⋯</span> → <b>Apps</b> → <b>Install this site as an app</b>.']];
  if (/Chrome\//.test(ua)) return ['In Chrome',
    ['Click the <b>Install</b> icon <span class="key">⤓</span> at the right of the address bar,', 'or open the menu <span class="key">⋮</span> → <b>Cast, save, and share</b> → <b>Install page as app</b>.']];
  if (/Safari\//.test(ua)) return ['In Safari on a Mac',
    ['Choose <b>File → Add to Dock</b> (or click the <b>Share</b> button <span class="key">□↑</span> → <b>Add to Dock</b>).', 'Click <b>Add</b>. TV Tracker now opens from the Dock like an app.']];
  return ['Add TV Tracker to your device', ['Open your browser\'s menu and look for <b>Install app</b> or <b>Add to Home Screen</b>.']];
}
async function getApp() {
  if (installPrompt) {
    const p = installPrompt; installPrompt = null;
    p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === 'accepted') $('#getapp').hidden = true;
    return;
  }
  const [title, steps] = installSteps(), d = $('#appDialog');
  d.innerHTML = `<img src="icons/icon-192.png" alt="" class="appico"><h2>${title}</h2>
    <ol>${steps.map(x => `<li>${x}</li>`).join('')}</ol>
    <form method="dialog"><button class="btn primary">Got it</button></form>`;
  d.showModal();
}
$('#appDialog').addEventListener('click', e => { if (e.target.id === 'appDialog') e.target.close(); });   // tap outside to close

// The footer is drawn here (app.js always loads fresh) so changes to it show up even if index.html is cached.
$('footer.foot').innerHTML = `<a href="#/contact" class="contactlink">✉ Contact us</a>
  <span><a href="privacy.html">Privacy policy</a> · Show &amp; episode data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA) · Movies and recommendations from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>.<br>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>`;
accountChip(); syncStatus(); appButton();
render(true);
cloud.start({ onUser, onData, onError: onCloudError, onInbox })
  .catch(e => { authReady = true; accountChip(); onCloudError(e); render(true); });
openRefresh();
