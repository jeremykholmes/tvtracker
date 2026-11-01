// The Cloudflare Worker for tvtracker.us. Website files are served straight from the repo (see wrangler.jsonc);
// this only runs for addresses that aren't a file, i.e. /api/… below.
//   /api/imdb?q=<title>  IMDb's title search (the suggestions its own search box uses), movies only. Lets the app
//                        find brand-new movies TMDB doesn't list yet. Fetched here because browsers can't call IMDb.
//   /api/angel?title=<title>&year=<year>  Whether a movie streams on Angel Studios (its page at angel.com/watch/<name>),
//                        for movies TMDB/JustWatch has no streaming info for yet. Answers { url } ('' when not found).
const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache } });

const MOVIE_KINDS = new Set(['movie', 'tvMovie', 'video', 'feature', 'TV movie']);

async function imdb(q) {
  q = q.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  if (!q) return json({ d: [] });
  const first = /^[a-z0-9]/.test(q) ? q[0] : 'x';
  const r = await fetch(`https://v3.sg.media-imdb.com/suggestion/${first}/${encodeURIComponent(q)}.json`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; TVTracker/1.0; +https://tvtracker.us)', accept: 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  if (!r.ok) return json({ d: [], error: 'IMDb ' + r.status }, 502);
  const j = await r.json().catch(() => ({}));
  const d = (j.d || [])
    .filter(x => /^tt\d+$/.test(x.id || '') && (MOVIE_KINDS.has(x.qid) || MOVIE_KINDS.has(x.q) || (!x.q && !x.qid)))
    .map(x => ({ id: x.id, title: x.l || '', year: x.y ? String(x.y) : '', stars: x.s || '', image: x.i?.imageUrl || '' }))
    .filter(x => x.title);
  return json({ d }, 200, 'public, max-age=3600');
}

const plainTitle = t => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

async function angel(title, year) {
  title = title.trim().slice(0, 120); year = /^\d{4}$/.test(year) ? year : '';
  if (!title) return json({ url: '' });
  // Angel's addresses are the title in lowercase with dashes, usually without a leading "The" (angel.com/watch/space-between-us).
  const base = plainTitle(title).replace(/ /g, '-');
  for (const slug of [...new Set([base.replace(/^the-/, ''), base])]) {
    const r = await fetch(`https://www.angel.com/watch/${slug}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; TVTracker/1.0; +https://tvtracker.us)', accept: 'text/html' },
      cf: { cacheTtl: 86400, cacheEverything: true }
    });
    if (!r.ok || !new URL(r.url).pathname.startsWith('/watch/' + slug)) continue;
    const html = await r.text();
    const name = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    if (plainTitle(name).includes(plainTitle(title)) && (!year || html.includes(year))) {
      return json({ url: `https://www.angel.com/watch/${slug}` }, 200, 'public, max-age=86400');
    }
  }
  return json({ url: '' }, 200, 'public, max-age=86400');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/imdb') {
      try { return await imdb(url.searchParams.get('q') || ''); }
      catch (e) { return json({ d: [], error: String(e?.message || e) }, 502); }
    }
    if (url.pathname === '/api/angel') {
      try { return await angel(url.searchParams.get('title') || '', url.searchParams.get('year') || ''); }
      catch (e) { return json({ url: '', error: String(e?.message || e) }, 502); }
    }
    return env.ASSETS.fetch(request);
  }
};
