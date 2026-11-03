// Pages Google can read, served by the Worker (worker.js): one per show and movie, at real addresses
//   /show/<TVmaze id>-<name>   e.g. /show/44778-severance
//   /movie/<TMDB id>-<name>    e.g. /movie/693134-dune-part-two
// The app's own pages live after a # (#/show/44778), which Google ignores, so these give every show and movie a page
// Google can list. Each has the details people search for (seasons, episodes and air dates, where to watch) and
// sends visitors into the app to track it. Shared links add ?r=<name>: link previews show the poster, and people
// who open it go straight to the app's page with "<name> recommends this show".
// Also the sitemaps that list them: /sitemaps/shows-<n>.xml (popular TVmaze shows) and /sitemaps/movies-<n>.xml.

const SITE = 'https://tvtracker.us';
const TVMAZE = 'https://api.tvmaze.com';
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_KEY = 'ee8ab7c29b7aa9166f87292204ab04ba';   // the same public key as tmdbKey in firebase-config.js
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; TVTracker/1.0; +https://tvtracker.us)' };
const HOUR = 3600, DAY = 86400;

export const slugify = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'title';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plain = html => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
const year = d => (d || '').slice(0, 4);
const longDate = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
const shortDate = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'TBA';

async function getJson(url, ttl) {
  const r = await fetch(url, { headers: { ...UA, accept: 'application/json' }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(url.split('?')[0] + ' ' + r.status);
  return r.json();
}
const html = (body, status = 200, maxAge = HOUR) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` } });
const xml = body => new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=86400' } });

// The page around the content: the site's look, Google Analytics (skipped on the owner's devices, as in index.html),
// link-preview tags and Google's structured data.
function page({ title, description, path, image, imageAlt, jsonLd, body, appHash, rec }) {
  const url = SITE + path;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${rec ? `<script>location.replace('/#/${appHash}/' + encodeURIComponent(${JSON.stringify(rec)}));</script>` : ''}
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-7SHW9HZXCV"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    try { if (localStorage.getItem('tvt.noga')) window['ga-disable-G-7SHW9HZXCV'] = true; } catch (e) { }
    gtag('config', 'G-7SHW9HZXCV');
    gtag('event', 'page_open', { page_location: location.origin + location.pathname, page_title: document.title });
  </script>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="video.${appHash.startsWith('movie') ? 'movie' : 'tv_show'}">
  <meta property="og:site_name" content="TV Tracker">
  <meta property="og:title" content="${esc(rec ? `${rec} recommends ${title.split(' – ')[0]}` : title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(image || SITE + '/icons/icon-512.png')}">
  <meta property="og:image:alt" content="${esc(imageAlt || 'TV Tracker')}">
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
  <meta name="theme-color" content="#0e1014">
  <link rel="icon" href="/icons/logo.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="stylesheet" href="/styles.css">
  <style>
    .seo { max-width: 960px; margin: 0 auto; padding: 24px 20px 40px; }
    .seo-hero { display: grid; grid-template-columns: 220px 1fr; gap: 24px; align-items: start; }
    .seo-hero img { width: 100%; border-radius: 12px; aspect-ratio: 2 / 3; object-fit: cover; background: var(--panel2); }
    .seo h1 { margin: 0 0 6px; font-size: 32px; line-height: 1.15; letter-spacing: -.01em; }
    .seo .facts { color: var(--muted); margin: 0 0 12px; }
    .seo .summary { margin: 0 0 16px; max-width: 65ch; }
    .seo .cta { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 8px; }
    .seo h2 { font-size: 20px; margin: 28px 0 10px; text-transform: none; letter-spacing: -.01em; color: var(--text); }
    .seo details { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 8px; }
    .seo summary { cursor: pointer; padding: 12px 16px; font-weight: 600; }
    .seo summary span { color: var(--muted); font-weight: 400; }
    .seo ol { margin: 0; padding: 0 16px 12px 40px; }
    .seo li { padding: 4px 0; }
    .seo li time { color: var(--muted); font-size: 14px; white-space: nowrap; }
    .seo .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 12px; padding: 0; list-style: none; }
    .seo .chips li { background: var(--panel2); border-radius: 999px; padding: 4px 12px; font-size: 14px; }
    .seo .note { color: var(--muted); font-size: 13px; }
    @media (max-width: 640px) { .seo-hero { grid-template-columns: 110px 1fr; gap: 14px; } .seo h1 { font-size: 24px; } }
  </style>
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
  <header class="top"><a href="/" class="brand"><img src="/icons/logo.svg" alt="" class="brandlogo"> TV Tracker</a></header>
  <main class="seo">${body}</main>
  <footer class="foot"><a href="/">TV Tracker</a> · <a href="/privacy.html">Privacy</a> · Show &amp; episode data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA) · Movies from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a> · Streaming info from <a href="https://www.justwatch.com" target="_blank" rel="noopener">JustWatch</a>.<br>This product uses the TMDB API but is not endorsed or certified by TMDB.</footer>
</body>
</html>`;
}

const notFound = what => html(page({ title: `${what} not found – TV Tracker`, description: 'Track the TV shows and movies you watch with TV Tracker.', path: '/',
  appHash: 'search', jsonLd: {}, body: `<h1>${what} not found</h1><p>It may have been removed. <a href="/#/search">Search for a show</a> or <a href="/">go to TV Tracker</a>.</p>` }), 404, 600);

/* ---------- show pages ---------- */
async function showPage(id, slug, rec) {
  const s = await getJson(`${TVMAZE}/shows/${id}?embed[]=episodes&embed[]=seasons&embed[]=nextepisode`, 6 * HOUR);
  if (!s) return notFound('Show');
  const want = slugify(s.name);
  if (slug !== want) return Response.redirect(`${SITE}/show/${id}-${want}${rec ? '?r=' + encodeURIComponent(rec) : ''}`, 301);
  const eps = (s._embedded?.episodes || []).filter(e => e.season && e.number != null);
  const seasons = (s._embedded?.seasons || []).filter(x => x.number && eps.some(e => e.season === x.number));
  const next = s._embedded?.nextepisode;
  const where = s.webChannel?.name || s.network?.name || '';
  const years = s.premiered ? year(s.premiered) + (s.status === 'Ended' ? (s.ended && year(s.ended) !== year(s.premiered) ? '–' + year(s.ended) : '') : '–') : '';
  const summary = plain(s.summary);
  const nSeasons = seasons.length, nEps = eps.length;
  const description = clip(`${s.name}${where ? ` (${where}${years ? ', ' + years : ''})` : ''}: ${nSeasons ? `${nSeasons} season${nSeasons === 1 ? '' : 's'}, ${nEps} episodes. ` : ''}${next ? `Next episode ${shortDate(next.airdate)}. ` : ''}${summary || 'Episode guide, air dates and where to watch.'}`, 160);
  const facts = [where, years, s.status === 'Running' ? 'Airing now' : s.status === 'Ended' ? 'Ended' : s.status === 'To Be Determined' ? 'Status TBD' : s.status,
    ...(s.genres || []).slice(0, 3), s.rating?.average ? `★ ${s.rating.average}/10` : ''].filter(Boolean);
  const latest = seasons.length ? seasons[seasons.length - 1].number : 0;
  const seasonList = seasons.map(x => {
    const list = eps.filter(e => e.season === x.number);
    const range = list[0]?.airdate ? `${shortDate(list[0].airdate)}${list.length > 1 && list[list.length - 1].airdate ? ' – ' + shortDate(list[list.length - 1].airdate) : ''}` : '';
    return `<details${x.number === latest ? ' open' : ''}><summary>Season ${x.number} <span>· ${list.length} episode${list.length === 1 ? '' : 's'}${range ? ' · ' + range : ''}</span></summary>
      <ol>${list.map(e => `<li value="${e.number}">${esc(e.name || `Episode ${e.number}`)} <time datetime="${esc(e.airdate || '')}">${shortDate(e.airdate)}</time></li>`).join('')}</ol></details>`;
  }).join('');
  const image = s.image?.original || s.image?.medium || '';
  const title = `${s.name} – Episodes, Seasons & Air Dates | TV Tracker`;
  const body = `<div class="seo-hero">${image ? `<img src="${esc(s.image.medium || image)}" alt="${esc(s.name)} poster" width="210" height="295">` : '<div></div>'}
    <div><h1>${esc(s.name)}</h1><p class="facts">${facts.map(esc).join(' · ')}</p>
      ${summary ? `<p class="summary">${esc(summary)}</p>` : ''}
      ${next ? `<p><b>Next episode:</b> S${next.season} E${next.number}${next.name ? ` “${esc(next.name)}”` : ''} — ${longDate(next.airdate)}${where ? ` on ${esc(where)}` : ''}</p>` : ''}
      <div class="cta"><a class="btn primary" href="/#/show/${id}">＋ Track ${esc(s.name)} free</a><a class="btn" href="/#/show/${id}">See episodes in the app</a></div>
      <p class="note">Check off episodes as you watch, see what's airing next, and share your list. Free, no ads.</p></div></div>
    ${seasonList ? `<h2>${esc(s.name)} episode guide</h2>${seasonList}` : ''}
    ${where ? `<h2>Where to watch ${esc(s.name)}</h2><p>${esc(s.name)} ${s.status === 'Ended' ? 'aired' : 'airs'} on <b>${esc(where)}</b>${s.network?.country?.name ? ` (${esc(s.network.country.name)})` : ''}.${s.officialSite ? ` <a href="${esc(s.officialSite)}" rel="nofollow noopener" target="_blank">Official site</a>.` : ''} Open it in TV Tracker to see every streaming service it's on in the US.</p>` : ''}`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'TVSeries', name: s.name, url: `${SITE}/show/${id}-${want}`, ...(image ? { image } : {}),
    ...(summary ? { description: clip(summary, 500) } : {}), ...(s.premiered ? { startDate: s.premiered } : {}), ...(s.ended ? { endDate: s.ended } : {}),
    ...(s.genres?.length ? { genre: s.genres } : {}), numberOfSeasons: nSeasons, numberOfEpisodes: nEps,
    ...(where ? { productionCompany: { '@type': 'Organization', name: where } } : {}) };
  return html(page({ title, description, path: `/show/${id}-${want}`, image, imageAlt: `${s.name} poster`, jsonLd, body, appHash: `show/${id}`, rec }), 200, rec ? 600 : 6 * HOUR);
}

/* ---------- movie pages ---------- */
async function moviePage(id, slug, rec) {
  const m = await getJson(`${TMDB}/movie/${id}?api_key=${TMDB_KEY}&append_to_response=release_dates,credits,watch/providers`, 6 * HOUR);
  if (!m || m.adult) return notFound('Movie');
  const want = slugify(m.title);
  if (slug !== want) return Response.redirect(`${SITE}/movie/${id}-${want}${rec ? '?r=' + encodeURIComponent(rec) : ''}`, 301);
  const us = m['watch/providers']?.results?.US || {};
  const streaming = [...new Set((us.flatrate || []).map(p => p.provider_name))];
  const rentBuy = [...new Set([...(us.rent || []), ...(us.buy || [])].map(p => p.provider_name))].slice(0, 6);
  const cert = (m.release_dates?.results || []).find(r => r.iso_3166_1 === 'US')?.release_dates?.map(r => r.certification).find(Boolean) || '';
  const cast = (m.credits?.cast || []).slice(0, 8).map(c => c.name);
  const director = (m.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name);
  const runtime = m.runtime ? `${Math.floor(m.runtime / 60) ? Math.floor(m.runtime / 60) + 'h ' : ''}${m.runtime % 60}m` : '';
  const yr = year(m.release_date);
  const description = clip(`${m.title}${yr ? ` (${yr})` : ''}${streaming.length ? ` is streaming on ${streaming.slice(0, 3).join(', ')}` : ''}. ${m.overview || 'Where to watch, runtime, rating and cast.'}`, 160);
  const facts = [yr, cert, runtime, ...(m.genres || []).slice(0, 3).map(g => g.name), m.vote_average ? `★ ${m.vote_average.toFixed(1)}/10` : ''].filter(Boolean);
  const poster = m.poster_path ? 'https://image.tmdb.org/t/p/w342' + m.poster_path : '';
  const image = m.poster_path ? 'https://image.tmdb.org/t/p/w780' + m.poster_path : '';
  const title = `${m.title}${yr ? ` (${yr})` : ''} – Where to Watch & Streaming | TV Tracker`;
  const body = `<div class="seo-hero">${poster ? `<img src="${esc(poster)}" alt="${esc(m.title)} poster" width="210" height="315">` : '<div></div>'}
    <div><h1>${esc(m.title)}${yr ? ` <span class="sub">(${yr})</span>` : ''}</h1><p class="facts">${facts.map(esc).join(' · ')}</p>
      ${m.tagline ? `<p><i>${esc(m.tagline)}</i></p>` : ''}${m.overview ? `<p class="summary">${esc(m.overview)}</p>` : ''}
      <div class="cta"><a class="btn primary" href="/#/movie/${id}">＋ Add ${esc(m.title)} to my list</a></div>
      <p class="note">Keep a list of movies to watch, mark them watched, and see where each one is streaming. Free, no ads.</p></div></div>
    <h2>Where to watch ${esc(m.title)}</h2>
    ${streaming.length ? `<p>Streaming in the US on:</p><ul class="chips">${streaming.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : `<p>Not on a US streaming subscription right now.</p>`}
    ${rentBuy.length ? `<p>Rent or buy:</p><ul class="chips">${rentBuy.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${director.length || cast.length ? `<h2>Cast &amp; crew</h2>${director.length ? `<p><b>Directed by</b> ${director.map(esc).join(', ')}</p>` : ''}${cast.length ? `<p><b>Starring</b> ${cast.map(esc).join(', ')}</p>` : ''}` : ''}`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'Movie', name: m.title, url: `${SITE}/movie/${id}-${want}`, ...(image ? { image } : {}),
    ...(m.overview ? { description: m.overview } : {}), ...(m.release_date ? { datePublished: m.release_date } : {}), ...(cert ? { contentRating: cert } : {}),
    ...(m.runtime ? { duration: `PT${m.runtime}M` } : {}), ...(m.genres?.length ? { genre: m.genres.map(g => g.name) } : {}),
    ...(director.length ? { director: director.map(name => ({ '@type': 'Person', name })) } : {}), ...(cast.length ? { actor: cast.map(name => ({ '@type': 'Person', name })) } : {}) };
  return html(page({ title, description, path: `/movie/${id}-${want}`, image, imageAlt: `${m.title} poster`, jsonLd, body, appHash: `movie/${id}`, rec }), 200, rec ? 600 : 6 * HOUR);
}

/* ---------- sitemaps ---------- */
// TVmaze lists every show 250 at a time (page n = show ids 250n…). Only popular ones (weight ≥ 80) go in, so Google
// spends its time on shows people search for. 400 pages covers ids up to 100,000 (TVmaze is near 85,000 in 2026).
const SHOW_PAGES = 400, MOVIE_PAGES = 25;
function sitemapIndex() {
  const at = n => `<sitemap><loc>${SITE}${n}</loc></sitemap>`;
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${at('/sitemaps/site.xml')}
${Array.from({ length: SHOW_PAGES }, (_, i) => at(`/sitemaps/shows-${i}.xml`)).join('\n')}
${Array.from({ length: MOVIE_PAGES }, (_, i) => at(`/sitemaps/movies-${i + 1}.xml`)).join('\n')}
</sitemapindex>`);
}
const urlset = urls => xml(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`);
async function showSitemap(n) {
  const list = n < SHOW_PAGES ? await getJson(`${TVMAZE}/shows?page=${n}`, DAY).catch(() => null) || [] : [];
  return urlset(list.filter(s => (s.weight || 0) >= 80 && s.name)
    .map(s => ({ loc: `${SITE}/show/${s.id}-${slugify(s.name)}`, lastmod: s.updated ? new Date(s.updated * 1000).toISOString().slice(0, 10) : '' })));
}
// TMDB's most popular movies, 20 a page (25 pages = the top 500), plus the current top-rated ones on the first page.
async function movieSitemap(n) {
  if (n < 1 || n > MOVIE_PAGES) return urlset([]);
  const lists = await Promise.all([getJson(`${TMDB}/movie/popular?api_key=${TMDB_KEY}&region=US&page=${n}`, DAY),
    getJson(`${TMDB}/movie/top_rated?api_key=${TMDB_KEY}&region=US&page=${n}`, DAY)].map(p => p.catch(() => null)));
  const seen = new Set(), urls = [];
  for (const m of lists.flatMap(l => l?.results || [])) {
    if (m.adult || !m.title || seen.has(m.id)) continue;
    seen.add(m.id); urls.push({ loc: `${SITE}/movie/${m.id}-${slugify(m.title)}` });
  }
  return urlset(urls);
}

/* ---------- routing (called from worker.js) ---------- */
// Answers the addresses above, or null for anything else. Pages are kept in Cloudflare's cache for a while so
// TVmaze and TMDB aren't asked again on every visit.
export async function seo(request, ctx) {
  const url = new URL(request.url);
  let m;
  const rec = (url.searchParams.get('r') || '').trim().slice(0, 40);
  let make;
  if ((m = url.pathname.match(/^\/show\/(\d+)(?:-([a-z0-9-]*))?\/?$/))) make = () => showPage(m[1], m[2] || '', rec);
  else if ((m = url.pathname.match(/^\/movie\/(\d+)(?:-([a-z0-9-]*))?\/?$/))) make = () => moviePage(m[1], m[2] || '', rec);
  else if (url.pathname === '/sitemap.xml') return sitemapIndex();
  else if (url.pathname === '/sitemaps/site.xml') return urlset([{ loc: SITE + '/' }, { loc: SITE + '/privacy.html' }]);
  else if ((m = url.pathname.match(/^\/sitemaps\/shows-(\d+)\.xml$/))) make = () => showSitemap(+m[1]);
  else if ((m = url.pathname.match(/^\/sitemaps\/movies-(\d+)\.xml$/))) make = () => movieSitemap(+m[1]);
  else return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const cache = caches.default, key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try { res = await make(); }
  catch (e) { return html(page({ title: 'TV Tracker', description: 'Track the TV shows and movies you watch.', path: url.pathname, appHash: 'search', jsonLd: {},
    body: `<h1>Couldn't load this page</h1><p>Please try again in a moment, or <a href="/">open TV Tracker</a>.</p>` }), 503, 60); }
  if (res.status === 200 && ctx?.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
