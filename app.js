/* TV Tracker — static site. Show data: TVmaze API (all broadcast networks + streaming services).
   Accounts + per-user watch progress: Firebase (see cloud.js). Guests save on the device only. */
import * as cloud from './cloud.js';

const API = 'https://api.tvmaze.com';
const K = { state: 'tvt.state.v1', cache: 'tvt.cache.v1', meta: 'tvt.meta.v1' };
const DAY = 864e5, HOUR = 36e5, STALE = 6 * HOUR;

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const strip = h => h ? (new DOMParser().parseFromString(h, 'text/html').body.textContent || '').trim() : '';
const pad = n => String(n ?? 0).padStart(2, '0');
const code = e => `S${pad(e.s)}E${pad(e.n)}`;

function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage', e); } }

/* ---------- state ---------- */
// state.shows[id]   = { id, name, image, network, removed, t }
// state.watched[ep] = { w: bool, t }      (last-write-wins per key, so devices merge cleanly)
function norm(s) { s = s && typeof s === 'object' ? s : {}; return { v: 1, shows: s.shows || {}, watched: s.watched || {} }; }
let user = null;                        // { uid, email, name } when signed in
let authReady = !cloud.configured;       // false until Firebase reports who's signed in
const stateKey = () => user ? `${K.state}.${user.uid}` : K.state;
let state = norm(load(K.state, null));
let cache = load(K.cache, {});           // showId -> { t, show, episodes }  (shared TVmaze data, not per user)
let meta = load(K.meta, { lastRefresh: 0 });
const openSeasons = {};                  // showId -> Set of open season numbers

const followed = () => Object.values(state.shows).filter(s => !s.removed);
const isFollowed = id => !!(state.shows[id] && !state.shows[id].removed);
const isWatched = id => !!(state.watched[id] && state.watched[id].w);

function persist() { save(stateKey(), state); }
function setWatched(ids, w) {
  const t = now();
  ids.forEach(id => { state.watched[id] = { w, t }; queue('watched', id, state.watched[id]); });
  persist();
}
function follow(s) {
  state.shows[s.id] = { id: s.id, name: s.name, image: s.image || '', network: s.network || '', removed: false, t: now() };
  queue('shows', s.id, state.shows[s.id]); persist();
}
function unfollow(id) {
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
    summary: strip(s.summary).slice(0, 700), updated: s.updated || 0, url: s.url || ''
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

let refreshing = null;
function refreshAll(manual) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let n = 0;
    try {
      busy('Checking for new episodes…');
      const ids = followed().map(s => s.id);
      const age = now() - (meta.lastRefresh || 0);
      let todo = ids.filter(id => !cache[id]);
      if (ids.length) {
        if (!meta.lastRefresh || age > 27 * DAY) todo = ids;
        else {
          const since = age > 6 * DAY ? 'month' : age > 20 * HOUR ? 'week' : 'day';
          const upd = await api(`/updates/shows?since=${since}`) || {};
          for (const id of ids) if (upd[id] && (!cache[id] || upd[id] > (cache[id].show.updated || 0))) todo.push(id);
        }
      }
      todo = [...new Set(todo)];
      for (const id of todo) { busy(`Updating shows ${++n}/${todo.length}…`); await fetchShow(id); await sleep(120); }
      meta.lastRefresh = now(); save(K.meta, meta);
      if (manual) toast(n ? `Updated ${n} show${n > 1 ? 's' : ''}` : 'Everything is up to date');
    } catch (e) { toast('Refresh failed: ' + e.message); }
    finally { busy(false); refreshing = null; render(); }
  })();
  return refreshing;
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
  const upcoming = c.episodes.find(e => !aired(e) && e.airdate) || null;
  const fresh = airedEps.filter(e => !isWatched(e.id) && now() - airTime(e) < 7 * DAY).length;
  let last = state.shows[id]?.t || 0;
  for (const e of c.episodes) { const w = state.watched[e.id]; if (w && w.t > last) last = w.t; }
  return { total: airedEps.length, watched, unwatched: airedEps.length - watched, next, upcoming, fresh, last };
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
function requireAccount() {
  if (!needsAccount()) return true;
  if (!authReady) { toast('One moment — checking your sign-in…'); return false; }
  try { sessionStorage.setItem('tvt.return', location.hash || '#/'); } catch { }
  toast('Sign in or create a free account to add shows');
  location.hash = '#/login/create';
  return false;
}
const GOOGLE_G = `<svg class="gsvg" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

function signInWall(title) {
  if (!authReady) { app.innerHTML = '<p class="loading">Loading…</p>'; return; }
  app.innerHTML = `<div class="empty"><h1>${title}</h1>
    <p>Create a free account or sign in with Google to add shows and check off episodes. Your list stays private and follows you to every device.</p>
    <div class="actions" style="justify-content:center">
      <button class="btn gbtn" data-act="google">${GOOGLE_G} Continue with Google</button>
      <a class="btn primary" href="#/login/create">Create account</a></div>
    <p class="sub" style="margin-top:18px">Already have an account? <a href="#/login">Sign in</a> · or <a href="#/search">browse shows</a> first</p></div>`;
}

// Signed-out home page: a marketing-style landing page with sign-in / sign-up.
views.landing = () => {
  if (!authReady) { app.innerHTML = '<p class="loading">Loading…</p>'; return; }
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
  const mock = (cls, name, ep, pct, badge) => `<div class="mk-card"><div class="mk-poster ${cls}">${badge ? `<span class="badge">${badge}</span>` : ''}</div>
    <div class="mk-body"><b>${name}</b><span><span class="code">${ep}</span> Next episode</span>
    <div class="bar"><i style="width:${pct}%"></i></div><span class="mk-btn">✓ Watched ${ep}</span></div></div>`;
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
        <div class="mk-head">Up next · 3</div>
        ${mock('p1', 'The Night Shift', 'S02E05', 62, '2 new')}
        ${mock('p2', 'Coastline', 'S01E08', 88, '')}
        ${mock('p3', 'Northern Lights', 'S04E01', 24, '1 new')}
      </div>
    </div>
  </section>
  <section class="lp-nets"><p>Track shows from every network and streamer</p>
    <div class="lp-netlist">${nets.map(n => `<span>${n}</span>`).join('')}</div></section>
  <section class="lp-sec"><span class="eyebrow">Features</span><h2 class="lp-h2">Everything you need to keep up</h2>
    <div class="lp-feats">${feats.map(([i, t, d]) => `<div class="lp-feat"><span class="lp-ico">${i}</span><h3>${t}</h3><p>${d}</p></div>`).join('')}</div></section>
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
};

views.shows = () => {
  if (needsAccount()) return views.landing();
  const list = followed();
  if (!list.length) {
    app.innerHTML = `<div class="empty"><h1>Start your watchlist</h1>
      <p>Add the shows you're watching from any network or streaming service, then check off episodes as you go.</p>
      <a class="btn primary" href="#/search">＋ Add a show</a> <a class="btn" href="#/discover">See what's premiering</a>
</div>`;
    return;
  }
  const rows = list.map(s => ({ s: showInfo(s.id), p: progress(s.id) }));
  const watching = rows.filter(r => r.p?.next).sort((a, b) =>
    (b.p.fresh > 0) - (a.p.fresh > 0) || b.p.last - a.p.last);
  const caught = rows.filter(r => r.p && !r.p.next && (r.p.upcoming || !/ended/i.test(r.s.status || '')))
    .sort((a, b) => (a.p.upcoming ? airTime(a.p.upcoming) : Infinity) - (b.p.upcoming ? airTime(b.p.upcoming) : Infinity));
  const done = rows.filter(r => r.p && !r.p.next && !r.p.upcoming && /ended/i.test(r.s.status || ''));
  const loading = rows.filter(r => !r.p);
  const sec = (title, arr) => arr.length ? `<h2>${title} · ${arr.length}</h2><div class="grid">${arr.map(r => card(r.s, r.p)).join('')}</div>` : '';
  app.innerHTML = `<div class="toolbar"><h1>My Shows</h1>
      <span class="sub">Updated ${ago(meta.lastRefresh)}</span>
      <button class="btn sm" data-act="refresh-all">↻ Check for new episodes</button></div>
    ${sec('Up next', watching)}${sec('Caught up — waiting for new episodes', caught)}
    ${sec('Finished', done)}${sec('Loading', loading)}`;
  if (loading.length) refreshAll(false);
};

function card(s, p) {
  const id = s.id, pct = p && p.total ? Math.round(p.watched / p.total * 100) : 0;
  let foot = '';
  if (p?.next) foot = `<div class="next"><span class="code">${code(p.next)}</span> ${esc(p.next.name)}</div>
    <button class="btn primary sm" data-act="watch" data-ep="${p.next.id}">✓ Watched ${code(p.next)}</button>`;
  else if (p?.upcoming) foot = `<div class="next muted">Next: <span class="code">${code(p.upcoming)}</span> · ${fmtDate(p.upcoming)}</div>`;
  else if (p) foot = `<div class="next muted">${/ended/i.test(s.status || '') ? 'Series finished' : 'No new episodes scheduled'}</div>`;
  return `<article class="card">
    <div style="position:relative">${poster(s, '#/show/' + id)}${p?.fresh ? `<span class="badge">${p.fresh} new</span>` : ''}</div>
    <div class="body"><a class="title" href="#/show/${id}">${esc(s.name)}</a>
      <div class="sub">${esc(s.network || '')}${s.status ? ' · ' + esc(s.status) : ''}</div>
      ${p ? `<div class="bar"><i style="width:${pct}%"></i></div>
      <div class="sub">${p.watched}/${p.total} watched${p.unwatched ? ` · <b>${p.unwatched} left</b>` : ''}</div>` : '<div class="sub">Loading episodes…</div>'}
      ${foot}</div></article>`;
}

views.show = arg => {
  const id = +arg, c = cache[id];
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
  const seasonHtml = [...seasons].map(([n, eps]) => {
    const av = eps.filter(aired), w = av.filter(e => isWatched(e.id)).length, all = av.length && w === av.length;
    return `<details class="season" data-show="${id}" data-season="${n}" ${openSeasons[id].has(n) ? 'open' : ''}>
      <summary><span class="grow">Season ${n}</span>
        <span class="mini"><div class="bar"><i style="width:${av.length ? w / av.length * 100 : 0}%"></i></div></span>
        <span class="sub">${w}/${av.length}${eps.length > av.length ? ` (+${eps.length - av.length})` : ''}</span>
        ${av.length ? `<button class="btn xs" data-act="season" data-show="${id}" data-season="${n}" data-val="${all ? 0 : 1}">${all ? 'Unmark all' : 'Mark all'}</button>` : ''}
      </summary>
      <ol class="eps">${eps.map(e => epRow(id, e)).join('')}</ol></details>`;
  }).join('');
  app.innerHTML = `<section class="hero">${poster(s)}
    <div class="meta"><h1>${esc(s.name)}</h1>
      <div class="sub">${[s.network, s.status, s.premiered && s.premiered.slice(0, 4), sched].filter(Boolean).map(esc).join(' · ')}</div>
      ${s.genres.length ? `<div class="chips">${s.genres.map(g => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
      ${p ? `<div class="stats"><div><b>${p.watched}/${p.total}</b><span>watched</span></div>
        <div><b>${p.unwatched}</b><span>left to watch</span></div>
        ${p.upcoming ? `<div><b>${code(p.upcoming)}</b><span>${fmtDate(p.upcoming, true)}</span></div>` : ''}</div>` : ''}
      ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ''}
      <div class="actions">
        ${f ? `<button class="btn" data-act="unfollow" data-show="${id}">Remove from my shows</button>`
            : `<button class="btn primary" data-act="follow" data-show="${id}">＋ Add to my shows</button>`}
        <button class="btn" data-act="refresh-show" data-show="${id}">↻ Refresh episodes</button>
        ${s.url ? `<a class="btn ghost" href="${esc(s.url)}" target="_blank" rel="noopener">TVmaze ↗</a>` : ''}
      </div></div></section>
    <h2>Episodes</h2>
    ${seasonHtml || '<p class="muted">No episodes listed yet.</p>'}
    <p class="sub">Tip: tap <b>↑ Up to here</b> on an episode to mark it and everything before it as watched.</p>`;
};

function epRow(sid, e) {
  const w = isWatched(e.id), a = aired(e);
  return `<li class="ep ${w ? 'done' : ''} ${a ? '' : 'future'}">
    <label class="chk" title="${w ? 'Mark unwatched' : 'Mark watched'}"><input type="checkbox" data-act="toggle" data-show="${sid}" data-ep="${e.id}" ${w ? 'checked' : ''}><span></span></label>
    <div class="epbody"><div class="name"><span class="code">${e.n}.</span> ${esc(e.name)}</div>
      <div class="sub">${fmtDate(e, !a)}${e.runtime ? ` · ${e.runtime} min` : ''}</div>
      ${e.summary ? `<details class="syn"><summary>Synopsis</summary><p>${esc(e.summary)}</p></details>` : ''}</div>
    ${a && !w ? `<button class="btn ghost xs" data-act="upto" data-show="${sid}" data-ep="${e.id}" title="Mark this and every earlier episode watched">↑ Up to here</button>` : ''}
  </li>`;
}

views.upcoming = () => {
  if (needsAccount()) return signInWall('See when your shows air');
  const list = followed();
  const recent = [], soon = [];
  for (const f of list) {
    const c = cache[f.id]; if (!c) continue;
    for (const e of c.episodes) {
      const t = airTime(e); if (!isFinite(t)) continue;
      if (t <= now() && now() - t < 7 * DAY) recent.push({ s: c.show, e, t });
      else if (t > now() && t - now() < 45 * DAY) soon.push({ s: c.show, e, t });
    }
  }
  recent.sort((a, b) => b.t - a.t); soon.sort((a, b) => a.t - b.t);
  const row = ({ s, e }, check) => `<div class="row">${poster(s, '#/show/' + s.id)}
    <div class="info"><a href="#/show/${s.id}">${esc(s.name)}</a>
      <div class="sub"><span class="code">${code(e)}</span> ${esc(e.name)}</div></div>
    <div class="when">${fmtDate(e, true)}<br>${esc(s.network || '')}</div>
    ${check ? `<label class="chk"><input type="checkbox" data-act="toggle" data-show="${s.id}" data-ep="${e.id}" ${isWatched(e.id) ? 'checked' : ''}><span></span></label>` : ''}</div>`;
  let days = '', cur = '';
  for (const it of soon) {
    const d = new Date(it.t).toDateString();
    if (d !== cur) { cur = d; days += `<div class="dayhead">${fmtDate(it.e)}</div>`; }
    days += row(it, false);
  }
  app.innerHTML = `<div class="toolbar"><h1>Upcoming</h1><span class="sub">Your shows · next 45 days</span>
      <button class="btn sm" data-act="refresh-all">↻ Refresh</button></div>
    ${!list.length ? `<div class="empty"><p>Add some shows to see their schedule here.</p><a class="btn primary" href="#/search">＋ Add a show</a></div>` : ''}
    ${recent.length ? `<h2>Aired this week</h2><div class="rows">${recent.map(r => row(r, true)).join('')}</div>` : ''}
    ${list.length ? `<h2>Coming up</h2>${soon.length ? `<div class="rows">${days}</div>` : '<p class="muted">Nothing scheduled yet for your shows.</p>'}` : ''}`;
  if (list.some(f => !cache[f.id])) refreshAll(false);
};

views.discover = () => {
  const d = meta.discover;
  if (!d || now() - d.t > STALE) {
    app.innerHTML = '<p class="loading">Pulling this week\'s premieres across networks &amp; streaming…</p>';
    loadDiscover().then(render).catch(e => { app.innerHTML = `<p class="loading">Couldn't load: ${esc(e.message)}</p>`; });
    return;
  }
  const item = it => `<div class="row">${poster(it.show, '#/show/' + it.show.id)}
    <div class="info"><a href="#/show/${it.show.id}">${esc(it.show.name)}</a>
      <div class="sub">${esc(it.show.network)}${it.season > 1 ? ` · Season ${it.season}` : ''}${it.show.genres?.length ? ' · ' + esc(it.show.genres.slice(0, 2).join(', ')) : ''}</div></div>
    <div class="when">${fmtDate({ airstamp: it.airstamp, airdate: it.airdate })}</div>
    ${followBtn(it.show)}</div>`;
  const fresh = d.items.filter(i => i.season === 1), back = d.items.filter(i => i.season > 1);
  app.innerHTML = `<div class="toolbar"><h1>Discover</h1><span class="sub">Premieres in the next 7 days · US networks + streaming</span>
      <button class="btn sm" data-act="discover-refresh">↻ Refresh</button></div>
    <h2>New series · ${fresh.length}</h2><div class="rows">${fresh.map(item).join('') || '<p class="muted">None found.</p>'}</div>
    <h2>Returning seasons · ${back.length}</h2><div class="rows">${back.map(item).join('') || '<p class="muted">None found.</p>'}</div>`;
};

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
  return isFollowed(s.id)
    ? `<button class="btn sm" data-act="unfollow" data-show="${s.id}">✓ Added</button>`
    : `<button class="btn primary sm" data-act="follow" data-show="${s.id}">＋ Add</button>`;
}

let lastResults = [], lastQuery = '', searchTimer = null, searchSeq = 0;
const showLookup = {};   // id -> trimmed show from search/discover, used when following
views.search = () => {
  app.innerHTML = `<h1>Add a show</h1>
    <form class="search" id="searchForm"><input id="q" type="search" placeholder="Search any show — Netflix, HBO, NBC, Hulu, Apple TV+…" autocomplete="off" autofocus>
    <button class="btn primary">Search</button></form><div id="results" class="rows"></div>`;
  const q = $('#q');
  q.value = sessionStorage.getItem('tvt.q') || '';
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(q.value), 350); });
  // Pressing Search/Enter, or clicking anywhere off the box, runs the search and then empties the box.
  const finish = async () => {
    clearTimeout(searchTimer);
    const text = q.value.trim(); q.value = '';
    if (text && text !== lastQuery) await doSearch(text);
    try { sessionStorage.removeItem('tvt.q'); } catch { }
  };
  q.addEventListener('blur', () => { if (document.hasFocus()) finish(); });   // not when switching apps/tabs
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); finish(); q.blur(); });
  if (q.value) doSearch(q.value); else drawResults();
};
async function doSearch(q) {
  q = q.trim(); sessionStorage.setItem('tvt.q', q);
  if (!q) { lastResults = []; lastQuery = ''; return drawResults(); }
  const seq = ++searchSeq;
  try {
    const r = await api(`/search/shows?q=${encodeURIComponent(q)}`) || [];
    if (seq !== searchSeq) return;
    lastResults = r.map(x => trimShow(x.show)); lastQuery = q;
    drawResults();
  } catch (e) { toast(e.message); }
}
// Once a show is added, empty the search box and results, ready for the next search.
function clearSearch() {
  clearTimeout(searchTimer); searchSeq++; lastResults = []; lastQuery = '';
  try { sessionStorage.removeItem('tvt.q'); } catch { }
  const q = $('#q'); if (q) q.value = '';
}
function drawResults() {
  const box = $('#results'); if (!box) return;
  if (!lastResults.length) { box.innerHTML = `<p class="muted">${lastQuery ? `No matches for “${esc(lastQuery)}”.` : 'Type a show name to search across every network and streaming service.'}</p>`; return; }
  box.innerHTML = `<p class="sub">Results for “${esc(lastQuery)}”</p>` + lastResults.map(s => `<div class="row">${poster(s, '#/show/' + s.id)}
    <div class="info"><a href="#/show/${s.id}">${esc(s.name)}</a>
      <div class="sub">${[s.network, s.premiered && s.premiered.slice(0, 4), s.status].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="sub">${esc(s.summary.slice(0, 140))}${s.summary.length > 140 ? '…' : ''}</div></div>
    ${followBtn(s)}</div>`).join('');
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
      <div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required></div>
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
    } catch (ex) { err.textContent = cloud.friendlyError(ex); err.hidden = false; btn.disabled = false; }
  });
};

views.account = () => {
  if (!user) {
    if (cloud.configured && !authReady) { app.innerHTML = '<p class="loading">Loading…</p>'; return; }
    location.hash = '#/login'; return;
  }
  const watchedCount = Object.values(state.watched).filter(w => w.w).length;
  app.innerHTML = `<h1>Account</h1>
  <div class="panel"><h3>${esc(user.name)}</h3><p>${esc(user.email)}</p>
    <p>Your shows and checkmarks are private to this account and sync automatically to every device you sign in on.</p>
    <div class="actions"><button class="btn" data-act="signout">Sign out</button></div></div>
  <div class="panel"><h3>Your data</h3>
    <p>${followed().length} shows · ${watchedCount} episodes watched · episode data refreshed ${ago(meta.lastRefresh)}</p>
    <div class="actions"><button class="btn" data-act="export">⬇ Export backup</button>
      <label class="btn">⬆ Import backup<input type="file" id="importFile" accept="application/json" hidden></label>
      <button class="btn" data-act="clear-cache">Re-download all episode data</button></div></div>`;
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { absorb(norm(JSON.parse(await file.text()))); toast('Backup imported'); refreshAll(false); render(true); }
    catch { toast('That file is not a TV Tracker backup'); }
  });
};

/* ---------- merging + cloud sync ---------- */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
// last-write-wins per show / per episode, so edits from several devices combine cleanly
function mergeMap(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) { const c = o[k]; if (!c || (v.t || 0) > (c.t || 0)) o[k] = v; } return o; }
function merge(a, b) { return norm({ shows: mergeMap(a.shows, b.shows), watched: mergeMap(a.watched, b.watched) }); }

// Merge another state (backup, guest list) into the current one and upload what's new.
function absorb(other) {
  const merged = merge(state, other);
  for (const kind of ['shows', 'watched'])
    for (const [k, v] of Object.entries(merged[kind])) if (canon(v) !== canon(state[kind][k])) queue(kind, k, v);
  state = merged; persist();
}

let pending = null, flushTimer = null, saving = false;
function queue(kind, id, val) {
  if (!user) return;
  pending = pending || { shows: {}, watched: {} };
  pending[kind][id] = val;
  syncStatus('Saving…');
  clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1000);
}
async function flush() {
  flushTimer = null;
  if (!pending || !user || saving) return;
  const batch = pending; pending = null; saving = true;
  try {
    await cloud.save({ ...batch, profile: { name: user.name, email: user.email }, updated: now() });
    syncStatus();
  } catch (e) {
    console.warn(e);
    pending = { shows: { ...batch.shows, ...(pending?.shows || {}) }, watched: { ...batch.watched, ...(pending?.watched || {}) } };
    syncStatus('Not saved — retrying', true);
    flushTimer = setTimeout(flush, 5000);
  } finally {
    saving = false;
    if (pending && !flushTimer) flushTimer = setTimeout(flush, 1000);
  }
}

let firstSnapshot = true;
function onUser(u) {
  const prevUid = user?.uid;
  if (!u && prevUid) { try { localStorage.removeItem(`${K.state}.${prevUid}`); } catch { } }
  if (u) save(K.state, norm(null));              // shows added before signing in are cleared, not carried over
  user = u; authReady = true; firstSnapshot = true; pending = null;
  state = norm(load(stateKey(), null));
  accountChip(); syncStatus();
  const r = route().name;
  if (u && r === 'login') {
    let back = '#/'; try { back = sessionStorage.getItem('tvt.return') || '#/'; sessionStorage.removeItem('tvt.return'); } catch { }
    location.hash = /login/.test(back) ? '#/' : back;
  }
  else if (!(r === 'login' && !u)) render(true);   // don't wipe a sign-in form someone is typing in
  refreshMissing();
}
function onData(data) {
  if (!user) return;
  if (!data) {                                   // brand-new account: starts empty
    if (firstSnapshot) {
      cloud.save({ profile: { name: user.name, email: user.email }, updated: now() }).catch(onCloudError);
    }
    firstSnapshot = false; render(); return;
  }
  const remote = norm(data);
  // Anything this device changed that the server hasn't seen yet (e.g. edits made offline) gets uploaded.
  for (const kind of ['shows', 'watched'])
    for (const [k, v] of Object.entries(state[kind])) { const r = remote[kind][k]; if (!r || (v.t || 0) > (r.t || 0)) queue(kind, k, v); }
  const merged = merge(state, remote);
  const changed = canon(merged) !== canon(state);
  state = merged; persist();
  firstSnapshot = false;
  if (changed) { render(); refreshMissing(); }
}
function onCloudError(e) { console.warn(e); syncStatus(cloud.friendlyError(e), true); }
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
  if (!cloud.configured) { el.hidden = true; return; }
  el.hidden = false;
  if (user) { el.href = '#/account'; el.className = 'acct on'; el.innerHTML = `<span class="av">${esc((user.name || user.email || '?')[0].toUpperCase())}</span><span class="nm">${esc(user.name)}</span>`; }
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
  setWatched(ids, w);
  render();
  toast(label, () => {
    const t = now();
    prev.forEach(([id, old]) => { state.watched[id] = { w: !!(old && old.w), t }; });
    persist();
  });
}
const actions = {
  watch(b) {
    if (!requireAccount()) return;
    const id = +b.dataset.ep, f = findEp(id);
    markWithUndo([id], true, f ? `${f.c.show.name} ${code(f.e)} watched` : 'Marked watched');
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
  async follow(b) {
    if (!requireAccount()) return;
    const id = +b.dataset.show;
    const s = cache[id]?.show || showLookup[id] || lastResults.find(x => x.id === id) || meta.discover?.items.find(x => x.show.id === id)?.show;
    if (!s) return;
    follow(s); clearSearch(); render(); toast(`Added ${s.name}`);
    if (!cache[id]) { try { await fetchShow(id); render(); } catch { } }
  },
  unfollow(b) {
    const id = +b.dataset.show, name = showInfo(id)?.name || 'show';
    unfollow(id); render();
    toast(`Removed ${name}`, () => { const s = state.shows[id]; s.removed = false; s.t = now(); persist(); });
  },
  'refresh-all'() { meta.lastRefresh = Math.min(meta.lastRefresh || 0, now() - 21 * HOUR); refreshAll(true); },
  async 'refresh-show'(b) {
    const id = +b.dataset.show; busy('Refreshing…');
    try { await fetchShow(id); toast('Episodes updated'); } catch (e) { toast(e.message); }
    busy(false); render();
  },
  'discover-refresh'() { delete meta.discover; render(); },
  async google() {
    try { await cloud.google(); } catch (e) { const el = $('#authErr'); if (el) { el.textContent = cloud.friendlyError(e); el.hidden = false; } else toast(cloud.friendlyError(e)); }
  },
  async forgot() {
    const email = $('#authForm input[name=email]')?.value.trim(), el = $('#authErr');
    if (!email) { el.textContent = 'Type your email above first, then tap "Forgot password?"'; el.hidden = false; return; }
    try { await cloud.resetPassword(email); toast('Password reset email sent'); } catch (e) { el.textContent = cloud.friendlyError(e); el.hidden = false; }
  },
  async signout() { await flush(); await cloud.signOut(); location.hash = '#/'; toast('Signed out'); },
  export() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
    a.download = `tv-tracker-backup-${ymd(new Date())}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  'clear-cache'() { cache = {}; save(K.cache, cache); meta.lastRefresh = 0; save(K.meta, meta); refreshAll(true); }
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
  if (t.checked && !isFollowed(sid) && cache[sid]) follow(cache[sid].show);
  setWatched([id], t.checked);
  render();
});
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches || !d.matches('details.season')) return;
  const set = openSeasons[d.dataset.show] || (openSeasons[d.dataset.show] = new Set());
  d.open ? set.add(+d.dataset.season) : set.delete(+d.dataset.season);
}, true);

/* ---------- router ---------- */
function route() { const [name, arg] = location.hash.replace(/^#\/?/, '').split('/'); return { name: name || 'shows', arg }; }
function render(fromRoute) {
  const r = route();
  const tab = r.name === 'show' ? 'shows' : r.name === 'login' ? 'account' : r.name;
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  document.body.classList.remove('landing');
  // Don't wipe forms the user is typing in on background updates.
  if (!fromRoute && r.name === 'search') return drawResults();
  if (!fromRoute && (r.name === 'login' || r.name === 'account') && document.activeElement?.tagName === 'INPUT') return;
  const y = scrollY;
  (views[r.name] || views.shows)(r.arg);
  if (!fromRoute) scrollTo(0, y);
}
window.addEventListener('hashchange', () => { render(true); scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (now() - (meta.lastRefresh || 0) > STALE) refreshAll(false);
});
window.addEventListener('pagehide', () => { flush(); });

accountChip(); syncStatus();
render(true);
cloud.start({ onUser, onData, onError: onCloudError })
  .catch(e => { authReady = true; accountChip(); onCloudError(e); render(true); });
if (followed().length && now() - (meta.lastRefresh || 0) > STALE) refreshAll(false);
