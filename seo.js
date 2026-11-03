// Pages Google can read, served by the Worker (worker.js): one per show and movie, at real addresses
//   /show/<TVmaze id>-<name>   e.g. /show/44778-severance
//   /movie/<TMDB id>-<name>    e.g. /movie/693134-dune-part-two
// The app's own pages live after a # (#/show/44778), which Google ignores, so these give every show and movie a page
// Google can list. Each has the details people search for (seasons, episodes and air dates, where to watch) and
// sends visitors into the app to track it. Shared links add ?r=<name>: link previews show the poster, and people
// who open it go straight to the app's page with "<name> recommends this show".
// Also "New this week on <service>" pages (/new and /new/netflix …) from TVmaze's schedule and TMDB, and
// the sitemaps that list them: /sitemaps/shows-<n>.xml (popular TVmaze shows) and /sitemaps/movies-<n>.xml.

const SITE = 'https://tvtracker.us';
const TVMAZE = 'https://api.tvmaze.com';
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_KEY = 'ee8ab7c29b7aa9166f87292204ab04ba';   // the same public key as tmdbKey in firebase-config.js
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; TVTracker/1.0; +https://tvtracker.us)' };
const HOUR = 3600, DAY = 86400;
const PAGE_VERSION = 4;

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
function page({ title, description, path, image, imageAlt, jsonLd, body, appHash, rec, noindex }) {
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
  ${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`}
  <meta property="og:type" content="${appHash.startsWith('movie') ? 'video.movie' : appHash.startsWith('show') ? 'video.tv_show' : 'website'}">
  <meta property="og:site_name" content="TV Tracker">
  <meta property="og:title" content="${esc(rec ? `${rec} recommends ${title.split(' – ')[0].replace(/ Season \d+$/, '')}` : title)}">
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
    .seo .backbtn { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 14px; padding: 6px 14px 6px 10px; border-radius: 999px; border: 1px solid var(--line);
      background: var(--panel2); text-decoration: none; font-weight: 600; font-size: 14px; }
    .seo .backbtn:hover { border-color: var(--muted); }
    .seo .lead { color: var(--muted); max-width: 70ch; margin: 0 0 16px; }
    .seo .svcs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 8px; }
    .seo .svcs a { text-decoration: none; background: var(--panel2); border: 1px solid var(--line); border-radius: 999px; padding: 6px 14px; font-weight: 600; font-size: 14px; }
    .seo .svcs a.on { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
    .seo .nwgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
    .seo .nwc { text-decoration: none; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .seo .nwc img, .seo .nwc .noimg { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 10px; background: var(--panel2); }
    .seo .nwc b { font-size: 15px; line-height: 1.25; }
    .seo .nwc span { color: var(--muted); font-size: 13px; line-height: 1.3; }
    .seo .nwc .tag { align-self: flex-start; background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 11px; border-radius: 6px; padding: 2px 7px; }
    .newlinks { margin-top: 6px; }
    @media (max-width: 640px) { .seo .nwgrid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 640px) { .seo-hero { grid-template-columns: 110px 1fr; gap: 14px; } .seo h1 { font-size: 24px; } }
  </style>
  <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
  <header class="top"><a href="/" class="brand"><img src="/icons/logo.svg" alt="" class="brandlogo"> TV Tracker</a></header>
  <main class="seo"><a class="backbtn" href="${appHash === 'discover' ? '/#/discover' : '/'}" onclick="try { if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) { history.back(); return false; } } catch (e) { }">‹ Back</a>
  ${body}</main>
  <footer class="foot"><div class="newlinks">New this week: ${SERVICES.map(s => `<a href="/new/${s.slug}">${esc(s.name)}</a>`).join(' · ')} · <a href="/new">All streaming</a></div>
  <a href="/">TV Tracker</a> · <a href="/privacy.html">Privacy</a> · Show &amp; episode data from <a href="https://www.tvmaze.com" target="_blank" rel="noopener">TVmaze</a> (CC BY-SA) · Movies from <a href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a> · Streaming info from <a href="https://www.justwatch.com" target="_blank" rel="noopener">JustWatch</a>.<br>This product uses the TMDB API but is not endorsed or certified by TMDB.</footer>
</body>
</html>`;
}

const notFound = what => html(page({ title: `${what} not found – TV Tracker`, description: 'Track the TV shows and movies you watch with TV Tracker.', path: '/', noindex: true,
  appHash: 'search', jsonLd: {}, body: `<h1>${what} not found</h1><p>It may have been removed. <a href="/#/search">Search for a show</a> or <a href="/">go to TV Tracker</a>.</p>` }), 404, 600);

/* ---------- show pages ---------- */
// "Shows like …": TMDB's recommendations for the show, matched back to TVmaze (whose ids the show pages use) by name
// and premiere year. Links between show pages help Google find and rank them. Never holds up or breaks the page.
async function similarShows(s) {
  const work = (async () => {
    const ex = s.externals || {};
    const find = async (id, src) => id ? (await getJson(`${TMDB}/find/${encodeURIComponent(id)}?api_key=${TMDB_KEY}&external_source=${src}`, 7 * DAY).catch(() => null))?.tv_results?.[0]?.id : null;
    const tid = await find(ex.imdb, 'imdb_id') || await find(ex.thetvdb, 'tvdb_id');
    if (!tid) return [];
    const recs = (await getJson(`${TMDB}/tv/${tid}/recommendations?api_key=${TMDB_KEY}&language=en-US&page=1`, 7 * DAY))?.results || [];
    const hits = await Promise.all(recs.filter(r => r.name).slice(0, 10).map(r => getJson(`${TVMAZE}/singlesearch/shows?q=${encodeURIComponent(r.name)}`, 7 * DAY)
      .then(t => t && t.id !== s.id && (!r.first_air_date || !t.premiered || Math.abs(year(t.premiered) - year(r.first_air_date)) <= 1) ? t : null).catch(() => null)));
    const seen = new Set();
    return hits.filter(t => t && !seen.has(t.id) && seen.add(t.id)).slice(0, 8);
  })().catch(() => []);
  return Promise.race([work, new Promise(r => setTimeout(() => r([]), 4000))]);
}
const similarCard = t => `<a class="nwc" href="/show/${t.id}-${slugify(t.name)}">${t.image?.medium ? `<img src="${esc(t.image.medium)}" alt="${esc(t.name)} poster" loading="lazy" width="210" height="295">` : '<span class="noimg"></span>'}
  <b>${esc(t.name)}</b><span>${esc([serviceOf(t), year(t.premiered)].filter(Boolean).join(' · '))}</span></a>`;
async function showPage(id, slug, rec) {
  const s = await getJson(`${TVMAZE}/shows/${id}?embed[]=episodes&embed[]=seasons&embed[]=nextepisode`, 6 * HOUR);
  if (!s) return notFound('Show');
  const want = slugify(s.name);
  if (slug !== want) return Response.redirect(`${SITE}/show/${id}-${want}${rec ? '?r=' + encodeURIComponent(rec) : ''}`, 301);
  const similar = await similarShows(s);
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
  // People search for the season they're on ("severance season 2 release date"), so shows still airing name the
  // newest season. Ended shows with several seasons say how many; one-season and other shows keep the general title.
  const airing = ['Running', 'To Be Determined', 'In Development'].includes(s.status);
  const title = airing && latest ? `${s.name} Season ${latest} – Episodes & Release Dates | TV Tracker`
    : s.status === 'Ended' && nSeasons > 1 ? `${s.name} – All ${nSeasons} Seasons, Episodes & Air Dates | TV Tracker`
    : `${s.name} – Episodes, Seasons & Air Dates | TV Tracker`;
  const body = `<div class="seo-hero">${image ? `<img src="${esc(s.image.medium || image)}" alt="${esc(s.name)} poster" width="210" height="295">` : '<div></div>'}
    <div><h1>${esc(s.name)}</h1><p class="facts">${facts.map(esc).join(' · ')}</p>
      ${summary ? `<p class="summary">${esc(summary)}</p>` : ''}
      ${next ? `<p><b>Next episode:</b> S${next.season} E${next.number}${next.name ? ` “${esc(next.name)}”` : ''} — ${longDate(next.airdate)}${where ? ` on ${esc(where)}` : ''}</p>` : ''}
      <div class="cta"><a class="btn primary" href="/#/show/${id}">＋ Track ${esc(s.name)} free</a><a class="btn" href="/#/show/${id}">See episodes in the app</a></div>
      <p class="note">Check off episodes as you watch, see what's airing next, and share your list. Free, no ads.</p></div></div>
    ${seasonList ? `<h2>${esc(s.name)} episode guide</h2>${seasonList}` : ''}
    ${where ? `<h2>Where to watch ${esc(s.name)}</h2><p>${esc(s.name)} ${s.status === 'Ended' ? 'aired' : 'airs'} on <b>${esc(where)}</b>${s.network?.country?.name ? ` (${esc(s.network.country.name)})` : ''}.${s.officialSite ? ` <a href="${esc(s.officialSite)}" rel="nofollow noopener" target="_blank">Official site</a>.` : ''} Open it in TV Tracker to see every streaming service it's on in the US.</p>` : ''}
    ${similar.length ? `<h2>Shows like ${esc(s.name)}</h2><div class="nwgrid">${similar.map(similarCard).join('')}</div>` : ''}`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'TVSeries', name: s.name, url: `${SITE}/show/${id}-${want}`, ...(image ? { image } : {}),
    ...(summary ? { description: clip(summary, 500) } : {}), ...(s.premiered ? { startDate: s.premiered } : {}), ...(s.ended ? { endDate: s.ended } : {}),
    ...(s.genres?.length ? { genre: s.genres } : {}), numberOfSeasons: nSeasons, numberOfEpisodes: nEps,
    // The network or streamer isn't the production company, and schema.org has no field for it, so it's left out here.
    ...(s.externals?.imdb ? { sameAs: [`https://www.imdb.com/title/${s.externals.imdb}/`] } : {}),
    ...(seasons.length ? { containsSeason: seasons.map(x => { const list = eps.filter(e => e.season === x.number);
      return { '@type': 'TVSeason', seasonNumber: x.number, name: `Season ${x.number}`, numberOfEpisodes: list.length, ...(list[0]?.airdate ? { startDate: list[0].airdate } : {}) }; }) } : {}) };
  return html(page({ title, description, path: `/show/${id}-${want}`, image, imageAlt: `${s.name} poster`, jsonLd, body, appHash: `show/${id}`, rec }), 200, rec ? 600 : 6 * HOUR);
}

/* ---------- movie pages ---------- */
async function moviePage(id, slug, rec) {
  const m = await getJson(`${TMDB}/movie/${id}?api_key=${TMDB_KEY}&append_to_response=release_dates,credits,watch/providers,recommendations`, 6 * HOUR);
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
  const similar = (m.recommendations?.results || []).filter(r => r.title && !r.adult && r.id !== m.id).slice(0, 8);
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
    ${director.length || cast.length ? `<h2>Cast &amp; crew</h2>${director.length ? `<p><b>Directed by</b> ${director.map(esc).join(', ')}</p>` : ''}${cast.length ? `<p><b>Starring</b> ${cast.map(esc).join(', ')}</p>` : ''}` : ''}
    ${similar.length ? `<h2>Movies like ${esc(m.title)}</h2><div class="nwgrid">${similar.map(movieCardHtml).join('')}</div>` : ''}`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'Movie', name: m.title, url: `${SITE}/movie/${id}-${want}`, ...(image ? { image } : {}),
    ...(m.overview ? { description: m.overview } : {}), ...(m.release_date ? { datePublished: m.release_date } : {}), ...(cert ? { contentRating: cert } : {}),
    ...(m.runtime ? { duration: `PT${m.runtime}M` } : {}), ...(m.genres?.length ? { genre: m.genres.map(g => g.name) } : {}),
    ...(director.length ? { director: director.map(name => ({ '@type': 'Person', name })) } : {}), ...(cast.length ? { actor: cast.map(name => ({ '@type': 'Person', name })) } : {}) };
  return html(page({ title, description, path: `/movie/${id}-${want}`, image, imageAlt: `${m.title} poster`, jsonLd, body, appHash: `movie/${id}`, rec }), 200, rec ? 600 : 6 * HOUR);
}

/* ---------- new this week ---------- */
// tv: the names TVmaze gives the service (as a streaming channel, or a TV network whose shows stream there);
// prov: TMDB's ids for the service in the US (several where it has more than one, e.g. with/without ads).
export const SERVICES = [
  { slug: 'netflix', name: 'Netflix', tv: /^Netflix$/i, prov: '8' },
  { slug: 'hulu', name: 'Hulu', tv: /^Hulu$/i, prov: '15' },
  { slug: 'disney-plus', name: 'Disney+', tv: /^Disney\+$/i, prov: '337' },
  { slug: 'max', name: 'HBO Max', tv: /^(HBO Max|Max|HBO)$/i, prov: '1899|384' },
  { slug: 'prime-video', name: 'Prime Video', tv: /^(Prime Video|Amazon Prime Video|Amazon Freevee)$/i, prov: '9' },
  { slug: 'apple-tv', name: 'Apple TV+', tv: /^Apple TV\+?$/i, prov: '350' },
  { slug: 'peacock', name: 'Peacock', tv: /^Peacock$/i, prov: '386|387' },
  { slug: 'paramount-plus', name: 'Paramount+', tv: /^Paramount\+/i, prov: '531|2303|2616' }
];
// This week, Monday to Sunday, by the date in New York (when US streaming releases are dated).
function thisWeek() {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mon = new Date(today); mon.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return iso(d); });
  return { days, today: iso(today) };
}
const dayName = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
const rangeText = days => {
  const a = new Date(days[0] + 'T12:00:00Z'), b = new Date(days[6] + 'T12:00:00Z'), o = { timeZone: 'UTC' };
  return a.getUTCMonth() === b.getUTCMonth() ? `${a.toLocaleDateString('en-US', { month: 'long', ...o })} ${a.getUTCDate()}–${b.getUTCDate()}, ${b.getUTCFullYear()}`
    : `${a.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...o })} – ${b.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...o })}`;
};
// Every episode released this week (streaming, plus US TV for services that carry a network's shows), grouped by show.
async function weekShows(days) {
  const lists = await Promise.all(days.flatMap(d => [getJson(`${TVMAZE}/schedule/web?date=${d}`, 6 * HOUR), getJson(`${TVMAZE}/schedule?country=US&date=${d}`, 6 * HOUR)].map(p => p.catch(() => []))));
  const shows = new Map();
  for (const e of lists.flat()) {
    const s = e?._embedded?.show || e?.show; if (!s || !e.airdate || e.number == null) continue;
    if (s.language && s.language !== 'English' && !(s.webChannel?.name || '').match(/Netflix|Prime|Apple|Disney/)) continue;
    const g = shows.get(s.id) || { s, eps: [] };
    if (!g.eps.some(x => x.id === e.id)) g.eps.push({ id: e.id, season: e.season, number: e.number, airdate: e.airdate });
    shows.set(s.id, g);
  }
  return [...shows.values()];
}
const serviceOf = s => s.webChannel?.name || s.network?.name || '';
function showCard(g, today) {
  const s = g.s, eps = g.eps.sort((a, b) => a.season - b.season || a.number - b.number);
  const first = eps[0], last = eps[eps.length - 1], same = eps.every(e => e.airdate === first.airdate);
  const premiere = eps.some(e => e.number === 1);
  const tag = premiere ? (first.season === 1 ? 'New series' : `Season ${first.season} premiere`) : '';
  const what = eps.length > 1 && same ? `All ${eps.length} episodes of season ${first.season}` : eps.length > 1 ? `Episodes ${first.number}–${last.number} of season ${first.season}` : `Season ${first.season}, episode ${first.number}`;
  const when = first.airdate <= today ? (same ? `Out ${dayName(first.airdate)}` : `From ${dayName(first.airdate)}`) : `Coming ${dayName(first.airdate)}`;
  const img = s.image?.medium || '';
  return `<a class="nwc" href="/show/${s.id}-${slugify(s.name)}">${img ? `<img src="${esc(img)}" alt="${esc(s.name)} poster" loading="lazy" width="210" height="295">` : '<span class="noimg"></span>'}
    ${tag ? `<span class="tag">${esc(tag)}</span>` : ''}<b>${esc(s.name)}</b><span>${esc(what)}</span><span>${esc(when)}${serviceOf(s) ? ' · ' + esc(serviceOf(s)) : ''}</span></a>`;
}
const movieCardHtml = m => `<a class="nwc" href="/movie/${m.id}-${slugify(m.title)}">${m.poster_path ? `<img src="https://image.tmdb.org/t/p/w342${esc(m.poster_path)}" alt="${esc(m.title)} poster" loading="lazy" width="210" height="315">` : '<span class="noimg"></span>'}
  <b>${esc(m.title)}</b><span>${esc(year(m.release_date))}</span></a>`;

async function newPage(slug) {
  const svc = slug ? SERVICES.find(s => s.slug === slug) : null;
  if (slug && !svc) return notFound('Page');
  const { days, today } = thisWeek(), range = rangeText(days);
  const all = await weekShows(days);
  const rank = g => (g.eps.some(e => e.number === 1) ? 1000 : 0) + (g.s.weight || 0);
  const pick = svc ? all.filter(g => svc.tv.test(serviceOf(g.s))) : all.filter(g => SERVICES.some(x => x.tv.test(serviceOf(g.s))) && (g.eps.some(e => e.number === 1) || (g.s.weight || 0) >= 90));
  pick.sort((a, b) => rank(b) - rank(a));
  const out = pick.filter(g => g.eps[0].airdate <= today).slice(0, 48), soon = pick.filter(g => g.eps[0].airdate > today).slice(0, 36);
  let movies = [];
  if (svc) {
    const d = await getJson(`${TMDB}/discover/movie?api_key=${TMDB_KEY}&watch_region=US&with_watch_providers=${encodeURIComponent(svc.prov)}&with_watch_monetization_types=flatrate&sort_by=primary_release_date.desc&primary_release_date.lte=${today}&vote_count.gte=10&include_adult=false&language=en-US`, 6 * HOUR).catch(() => null);
    movies = (d?.results || []).filter(m => m.title).slice(0, 12);
  }
  const name = svc ? svc.name : 'streaming';
  const title = svc ? `New on ${svc.name} This Week (${range}) – Shows & Movies | TV Tracker` : `New on Streaming This Week (${range}) – Netflix, Hulu, Max & More | TV Tracker`;
  const top = pick.slice(0, 4).map(g => g.s.name);
  const description = clip(`What's new on ${name} this week, ${range}: ${top.length ? top.join(', ') + (pick.length > 4 ? ` and ${pick.length - 4} more` : '') + '. ' : ''}New series, season premieres and episodes${svc ? ', plus the newest movies' : ''}, updated daily.`, 160);
  const svcLinks = `<nav class="svcs" aria-label="Streaming services"><a href="/new"${svc ? '' : ' class="on"'}>All</a>${SERVICES.map(s => `<a href="/new/${s.slug}"${svc === s ? ' class="on"' : ''}>${esc(s.name)}</a>`).join('')}</nav>`;
  const body = `<h1>New on ${esc(name)} this week</h1>
    <p class="lead">${esc(range)} · New series, season premieres and new episodes${svc ? ` on ${esc(svc.name)}` : ' across Netflix, Hulu, Disney+, HBO Max, Prime Video, Apple TV+, Peacock and Paramount+'}. Updated every day.</p>
    ${svcLinks}
    <div class="cta"><a class="btn primary" href="/#/login/create">＋ Track new episodes free</a></div>
    <h2>Out now</h2>${out.length ? `<div class="nwgrid">${out.map(g => showCard(g, today)).join('')}</div>` : '<p>Nothing yet this week — check back soon.</p>'}
    ${soon.length ? `<h2>Coming later this week</h2><div class="nwgrid">${soon.map(g => showCard(g, today)).join('')}</div>` : ''}
    ${movies.length ? `<h2>Newest movies on ${esc(svc.name)}</h2><div class="nwgrid">${movies.map(movieCardHtml).join('')}</div>` : ''}
    <p class="note">Release dates from TVmaze and TMDB; what's on each service can change. Track the shows you watch with TV Tracker and see new episodes as soon as they're out.</p>`;
  const jsonLd = { '@context': 'https://schema.org', '@type': 'ItemList', name: `New on ${name} this week`, itemListElement: pick.slice(0, 20).map((g, i) =>
    ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/show/${g.s.id}-${slugify(g.s.name)}`, name: g.s.name })) };
  return html(page({ title, description, path: svc ? `/new/${svc.slug}` : '/new', image: pick[0]?.s.image?.original || '', imageAlt: pick[0] ? `${pick[0].s.name} poster` : '',
    jsonLd, body, appHash: 'discover' }), 200, 3 * HOUR);
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
  else if ((m = url.pathname.match(/^\/new(?:\/([a-z0-9-]+))?\/?$/))) make = () => newPage(m[1] || '');
  else if (url.pathname === '/sitemap.xml') return sitemapIndex();
  else if (url.pathname === '/sitemaps/site.xml') return urlset([{ loc: SITE + '/' }, { loc: SITE + '/privacy.html' }, { loc: SITE + '/new' }, ...SERVICES.map(s => ({ loc: `${SITE}/new/${s.slug}` }))]);
  else if ((m = url.pathname.match(/^\/sitemaps\/shows-(\d+)\.xml$/))) make = () => showSitemap(+m[1]);
  else if ((m = url.pathname.match(/^\/sitemaps\/movies-(\d+)\.xml$/))) make = () => movieSitemap(+m[1]);
  else return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  // PAGE_VERSION is part of the cache key: raise it when the pages' design changes so cached copies aren't reused.
  const cache = caches.default, key = new Request(url.toString() + (url.search ? '&' : '?') + '__v=' + PAGE_VERSION, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try { res = await make(); }
  catch (e) { return html(page({ title: 'TV Tracker', description: 'Track the TV shows and movies you watch.', path: url.pathname, appHash: 'search', jsonLd: {},
    noindex: true,
    body: `<h1>Couldn't load this page</h1><p>Please try again in a moment, or <a href="/">open TV Tracker</a>.</p>` }), 503, 60); }
  if (res.status === 200 && ctx?.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
