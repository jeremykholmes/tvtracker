// The Cloudflare Worker for tvtracker.us. Website files are served straight from the repo (see wrangler.jsonc);
// this only runs for addresses that aren't a file, i.e. /api/… below.
//   /api/imdb?q=<title>  IMDb's title search (the suggestions its own search box uses), movies only. Lets the app
//                        find brand-new movies TMDB doesn't list yet. Fetched here because browsers can't call IMDb.
//   /api/angel?title=<title>&year=<year>  Whether a movie streams on Angel Studios (its page at angel.com/watch/<name>),
//                        for movies TMDB/JustWatch has no streaming info for yet. Answers { url } ('' when not found).
//   /api/traffic         Website traffic from Google Analytics for the Admin page (site owner only: send the Firebase
//                        ID token as "Authorization: Bearer …"). Needs two Worker secrets, set in the Cloudflare
//                        dashboard: GA_PROPERTY_ID and GA_SERVICE_ACCOUNT (see "Website traffic" in README.md).
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

/* ---------- /api/traffic ---------- */
const FIREBASE_PROJECT = 'tv-tracker-6135d';   // matches firebase-config.js
const ADMIN_EMAIL = 'jeremykholmes@gmail.com';   // matches adminEmail in firebase-config.js and firestore.rules

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const toB64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// Checks a Firebase sign-in token (signed by Google) and that it's the site owner's verified email.
let firebaseKeys = { keys: null, until: 0 };
async function isOwner(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const [h, p, sig] = token.split('.'); if (!sig) return false;
  const head = JSON.parse(new TextDecoder().decode(b64url(h))), claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  if (head.alg !== 'RS256') return false;
  if (!firebaseKeys.keys || Date.now() > firebaseKeys.until) {
    const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    firebaseKeys = { keys: (await r.json()).keys || [], until: Date.now() + 3600e3 };
  }
  const jwk = firebaseKeys.keys.find(k => k.kid === head.kid); if (!jwk) return false;
  const key = await crypto.subtle.importKey('jwk', jwk, RS256, false, ['verify']);
  if (!await crypto.subtle.verify(RS256, key, b64url(sig), new TextEncoder().encode(h + '.' + p))) return false;
  const now = Date.now() / 1000;
  return claims.aud === FIREBASE_PROJECT && claims.iss === 'https://securetoken.google.com/' + FIREBASE_PROJECT &&
    claims.exp > now && claims.iat < now + 300 && claims.email_verified === true && String(claims.email || '').toLowerCase() === ADMIN_EMAIL;
}

// A Google access token for the service account (read-only Analytics), reused until shortly before it expires.
let gaToken = { token: '', until: 0 };
async function googleToken(sa) {
  if (gaToken.token && Date.now() < gaToken.until) return gaToken.token;
  const now = Math.floor(Date.now() / 1000), enc = o => toB64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), RS256, false, ['sign']);
  const jwt = unsigned + '.' + toB64url(await crypto.subtle.sign(RS256, key, new TextEncoder().encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google sign-in for the service account failed: ' + (j.error_description || j.error || r.status));
  gaToken = { token: j.access_token, until: Date.now() + (j.expires_in - 120) * 1000 };
  return gaToken.token;
}

async function traffic(request, env) {
  if (!await isOwner(request).catch(() => false)) return json({ error: 'Only the site owner can see this.' }, 403);
  if (!env.GA_PROPERTY_ID || !env.GA_SERVICE_ACCOUNT) return json({ setup: true });
  const token = await googleToken(JSON.parse(env.GA_SERVICE_ACCOUNT));
  const ga = async (method, body) => {
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${String(env.GA_PROPERTY_ID).replace(/\D/g, '')}:${method}`,
      { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Google Analytics ' + r.status);
    return j;
  };
  const metrics = [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }];
  const ranges = { today: ['today', 'today'], week: ['6daysAgo', 'today'], month: ['29daysAgo', 'today'], all: ['2015-08-14', 'today'] };
  const [live, totals, daily] = await Promise.all([
    ga('runRealtimeReport', { metrics: [{ name: 'activeUsers' }] }),
    ga('runReport', { dateRanges: Object.entries(ranges).map(([name, [startDate, endDate]]) => ({ name, startDate, endDate })), metrics }),
    ga('runReport', { dateRanges: [{ startDate: '29daysAgo', endDate: 'today' }], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }] })
  ]);
  const num = v => +(v?.value || 0);
  const out = { now: num(live.rows?.[0]?.metricValues?.[0]) };
  for (const name of Object.keys(ranges)) {
    const row = (totals.rows || []).find(r => r.dimensionValues?.some(d => d.value === name));
    out[name] = { users: num(row?.metricValues?.[0]), sessions: num(row?.metricValues?.[1]), views: num(row?.metricValues?.[2]) };
  }
  out.days = (daily.rows || []).map(r => ({ date: r.dimensionValues[0].value, users: num(r.metricValues[0]), views: num(r.metricValues[1]) }));
  return json(out);
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
    if (url.pathname === '/api/traffic') {
      try { return await traffic(request, env); }
      catch (e) { return json({ error: String(e?.message || e) }, 502); }
    }
    return env.ASSETS.fetch(request);
  }
};
