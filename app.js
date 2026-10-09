'use strict';
/* TV Tracker — static site. Show data: TVmaze API (all broadcast networks + streaming services).
   Watch progress: localStorage, optionally synced to a JSON file in a GitHub repo. */

const API = 'https://api.tvmaze.com';
const K = { state: 'tvt.state.v1', cache: 'tvt.cache.v1', sync: 'tvt.sync.v1', meta: 'tvt.meta.v1' };
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
let state = norm(load(K.state, null));
let cache = load(K.cache, {});           // showId -> { t, show, episodes }
let meta = load(K.meta, { lastRefresh: 0 });
let sync = Object.assign(defaultSync(), load(K.sync, {}));
const openSeasons = {};                  // showId -> Set of open season numbers

function defaultSync() {
  const d = { owner: '', repo: '', branch: 'tracker-data', path: 'data/tracker.json', token: '' };
  if (location.hostname.endsWith('.github.io')) {
    d.owner = location.hostname.split('.')[0];
    d.repo = location.pathname.split('/').filter(Boolean)[0] || location.hostname;
  }
  return d;
}

const followed = () => Object.values(state.shows).filter(s => !s.removed);
const isFollowed = id => !!(state.shows[id] && !state.shows[id].removed);
const isWatched = id => !!(state.watched[id] && state.watched[id].w);

function persist() { save(K.state, state); scheduleSync(); }
function setWatched(ids, w) { const t = now(); ids.forEach(id => { state.watched[id] = { w, t }; }); persist(); }
function follow(s) {
  state.shows[s.id] = { id: s.id, name: s.name, image: s.image || '', network: s.network || '', removed: false, t: now() };
  persist();
}
function unfollow(id) { const s = state.shows[id]; if (s) { s.removed = true; s.t = now(); persist(); } }
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

views.shows = () => {
  const list = followed();
  if (!list.length) {
    app.innerHTML = `<div class="empty"><h1>Start your watchlist</h1>
      <p>Add the shows you're watching from any network or streaming service, then check off episodes as you go.</p>
      <a class="btn primary" href="#/search">＋ Add a show</a> <a class="btn" href="#/discover">See what's premiering</a></div>`;
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

let lastResults = [], searchTimer = null, searchSeq = 0;
const showLookup = {};   // id -> trimmed show from search/discover, used when following
views.search = () => {
  app.innerHTML = `<h1>Add a show</h1>
    <form class="search" id="searchForm"><input id="q" type="search" placeholder="Search any show — Netflix, HBO, NBC, Hulu, Apple TV+…" autocomplete="off" autofocus>
    <button class="btn primary">Search</button></form><div id="results" class="rows"></div>`;
  const q = $('#q');
  q.value = sessionStorage.getItem('tvt.q') || '';
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(q.value), 350); });
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); doSearch(q.value); });
  if (q.value) doSearch(q.value); else drawResults();
};
async function doSearch(q) {
  q = q.trim(); sessionStorage.setItem('tvt.q', q);
  if (!q) { lastResults = []; return drawResults(); }
  const seq = ++searchSeq;
  try {
    const r = await api(`/search/shows?q=${encodeURIComponent(q)}`) || [];
    if (seq !== searchSeq) return;
    lastResults = r.map(x => trimShow(x.show));
    drawResults();
  } catch (e) { toast(e.message); }
}
function drawResults() {
  const box = $('#results'); if (!box) return;
  if (!lastResults.length) { box.innerHTML = `<p class="muted">${$('#q')?.value ? 'No matches.' : 'Type a show name to search across every network and streaming service.'}</p>`; return; }
  box.innerHTML = lastResults.map(s => `<div class="row">${poster(s, '#/show/' + s.id)}
    <div class="info"><a href="#/show/${s.id}">${esc(s.name)}</a>
      <div class="sub">${[s.network, s.premiered && s.premiered.slice(0, 4), s.status].filter(Boolean).map(esc).join(' · ')}</div>
      <div class="sub">${esc(s.summary.slice(0, 140))}${s.summary.length > 140 ? '…' : ''}</div></div>
    ${followBtn(s)}</div>`).join('');
}

views.settings = () => {
  const watchedCount = Object.values(state.watched).filter(w => w.w).length;
  app.innerHTML = `<h1>Settings</h1>
  <div class="panel"><h3>Sync across devices (GitHub)</h3>
    <p>Your shows and checkmarks save in this browser automatically. To share them across phones, laptops and everyone in the house,
    connect a GitHub token — progress is saved to <code>${esc(sync.path)}</code> on the <code>${esc(sync.branch)}</code> branch of your repo
    (a separate branch, so it won't rebuild your site on every checkmark).</p>
    <form id="syncForm"><div class="form">
      ${['owner', 'repo', 'branch', 'path'].map(k => `<div class="field"><label>${k === 'owner' ? 'GitHub owner' : k[0].toUpperCase() + k.slice(1)}</label><input name="${k}" value="${esc(sync[k])}" required></div>`).join('')}
      <div class="field" style="grid-column:1/-1"><label>Personal access token (fine-grained, this repo only, Contents: Read &amp; write)</label>
        <input name="token" type="password" value="${esc(sync.token)}" placeholder="github_pat_…" autocomplete="off"></div></div>
      <div class="actions"><button class="btn primary">Save &amp; connect</button>
        ${gh.ok() ? `<button type="button" class="btn" data-act="sync-now">↻ Sync now</button>
        <button type="button" class="btn danger" data-act="disconnect">Disconnect this device</button>` : ''}</div></form>
    <p class="sub" style="margin-top:12px">Create a token at github.com → Settings → Developer settings → Fine-grained tokens. It's stored only in this browser.
    If the repo is public, your watch list file is public too.</p></div>
  <div class="panel"><h3>Your data</h3>
    <p>${followed().length} shows · ${watchedCount} episodes watched · episode data refreshed ${ago(meta.lastRefresh)}</p>
    <div class="actions"><button class="btn" data-act="export">⬇ Export backup</button>
      <label class="btn">⬆ Import backup<input type="file" id="importFile" accept="application/json" hidden></label>
      <button class="btn" data-act="clear-cache">Re-download all episode data</button></div></div>`;
  $('#syncForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    for (const k of ['owner', 'repo', 'branch', 'path', 'token']) sync[k] = String(fd.get(k) || '').trim();
    save(K.sync, sync);
    if (!gh.ok()) { toast('Saved — add a token to turn on sync'); return; }
    try { syncStatus('Connecting…'); await gh.ensureBranch(); await syncNow(true); toast('Connected — syncing to GitHub'); render(true); }
    catch (err) { syncStatus('Sync error', true); toast('GitHub: ' + err.message); }
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try { state = merge(state, norm(JSON.parse(await file.text()))); persist(); toast('Backup imported'); refreshAll(false); }
    catch { toast('That file is not a TV Tracker backup'); }
  });
};

/* ---------- GitHub sync ---------- */
const enc = encodeURIComponent;
const b64enc = str => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function mergeMap(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) { const c = o[k]; if (!c || (v.t || 0) > (c.t || 0)) o[k] = v; } return o; }
function merge(a, b) { return norm({ shows: mergeMap(a.shows, b.shows), watched: mergeMap(a.watched, b.watched) }); }
async function ghErr(r) { let m = ''; try { m = (await r.json()).message; } catch { } return new Error(`${r.status} ${m || r.statusText}`); }

const gh = {
  ok: () => !!(sync.owner && sync.repo && sync.token && sync.branch && sync.path),
  base: () => `https://api.github.com/repos/${enc(sync.owner)}/${enc(sync.repo)}`,
  headers: () => ({ Authorization: 'Bearer ' + sync.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
  fileUrl() { return `${this.base()}/contents/${sync.path.split('/').map(enc).join('/')}`; },
  async ensureBranch() {
    const h = this.headers();
    const r = await fetch(`${this.base()}/branches/${enc(sync.branch)}`, { headers: h, cache: 'no-store' });
    if (r.ok) return; if (r.status !== 404) throw await ghErr(r);
    const repo = await fetch(this.base(), { headers: h }); if (!repo.ok) throw await ghErr(repo);
    const def = (await repo.json()).default_branch;
    const ref = await fetch(`${this.base()}/git/ref/heads/${enc(def)}`, { headers: h }); if (!ref.ok) throw await ghErr(ref);
    const sha = (await ref.json()).object.sha;
    const c = await fetch(`${this.base()}/git/refs`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'refs/heads/' + sync.branch, sha }) });
    if (!c.ok) throw await ghErr(c);
  },
  async pull() {
    const r = await fetch(`${this.fileUrl()}?ref=${enc(sync.branch)}`, { headers: this.headers(), cache: 'no-store' });
    if (r.status === 404) return { data: null, sha: null };
    if (!r.ok) throw await ghErr(r);
    const j = await r.json();
    return { data: norm(JSON.parse(b64dec(j.content))), sha: j.sha };
  },
  async push(data, sha) {
    const body = { message: 'Update TV watch progress', content: b64enc(JSON.stringify(data, null, 1)), branch: sync.branch };
    if (sha) body.sha = sha;
    const r = await fetch(this.fileUrl(), { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) return false;   // someone else saved first; re-merge
    if (!r.ok) throw await ghErr(r);
    return true;
  }
};

let syncing = false, syncTimer = null, dirty = false, lastSync = 0;
function scheduleSync() { if (!gh.ok()) return; dirty = true; syncStatus('Saving…'); clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), 2500); }
async function syncNow(throwErr) {
  if (!gh.ok()) { syncStatus(); return; }
  if (syncing) { dirty = true; return; }
  syncing = true; dirty = false; syncStatus('Syncing…');
  try {
    for (let i = 0; i < 4; i++) {
      const { data, sha } = await gh.pull();
      const merged = data ? merge(state, data) : state;
      const localChanged = canon(merged) !== canon(state);
      state = merged; save(K.state, state);
      if (localChanged) { render(); refreshMissing(); }
      if (data && canon(data) === canon(merged)) break;
      if (await gh.push(merged, sha)) break;
      await sleep(400);
    }
    lastSync = now(); syncStatus();
  } catch (e) {
    syncStatus('Sync error', true); console.warn(e);
    if (throwErr) throw e;
  } finally {
    syncing = false;
    if (dirty) scheduleSync();
  }
}
function refreshMissing() { if (followed().some(f => !cache[f.id])) refreshAll(false); }

/* ---------- UI helpers ---------- */
function syncStatus(text, err) {
  const el = $('#sync');
  el.className = 'sync' + (err ? ' err' : !text && gh.ok() ? ' ok' : '');
  el.textContent = text || (gh.ok() ? (lastSync ? 'Synced' : 'Sync on') : 'Saved on this device');
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
    const id = +b.dataset.ep, f = findEp(id);
    markWithUndo([id], true, f ? `${f.c.show.name} ${code(f.e)} watched` : 'Marked watched');
  },
  season(b, e) {
    e.preventDefault(); e.stopPropagation();
    const sid = +b.dataset.show, n = +b.dataset.season, val = b.dataset.val === '1';
    const eps = cache[sid].episodes.filter(x => x.s === n && (!val || aired(x)));
    if (val && !isFollowed(sid)) follow(cache[sid].show);
    markWithUndo(eps.map(x => x.id), val, `Season ${n} ${val ? 'marked watched' : 'unmarked'}`);
  },
  upto(b) {
    const sid = +b.dataset.show, id = +b.dataset.ep, eps = cache[sid].episodes;
    const idx = eps.findIndex(x => x.id === id);
    const ids = eps.slice(0, idx + 1).filter(x => aired(x) && !isWatched(x.id)).map(x => x.id);
    if (!isFollowed(sid)) follow(cache[sid].show);
    markWithUndo(ids, true, `Marked ${ids.length} episode${ids.length === 1 ? '' : 's'} watched`);
  },
  async follow(b) {
    const id = +b.dataset.show;
    const s = cache[id]?.show || showLookup[id] || lastResults.find(x => x.id === id) || meta.discover?.items.find(x => x.show.id === id)?.show;
    if (!s) return;
    follow(s); render(); toast(`Added ${s.name}`);
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
  'sync-now'() { syncNow().then(() => toast(gh.ok() ? 'Synced' : 'Not connected')); },
  disconnect() { sync.token = ''; save(K.sync, sync); syncStatus(); render(true); toast('Sync turned off on this device'); },
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
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === (r.name === 'show' ? 'shows' : r.name)));
  // Don't wipe forms the user is typing in on background updates.
  if (!fromRoute && r.name === 'search') return drawResults();
  if (!fromRoute && r.name === 'settings') return;
  const y = scrollY;
  (views[r.name] || views.shows)(r.arg);
  if (!fromRoute) scrollTo(0, y);
}
window.addEventListener('hashchange', () => { render(true); scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (gh.ok() && !syncing) syncNow();
  if (now() - (meta.lastRefresh || 0) > STALE) refreshAll(false);
});
setInterval(() => { if (document.visibilityState === 'visible' && gh.ok() && !dirty) syncNow(); }, 120e3);

syncStatus();
render(true);
if (gh.ok()) syncNow();
if (followed().length && now() - (meta.lastRefresh || 0) > STALE) refreshAll(false);
