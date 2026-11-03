// Reads export files from other apps (Account page → Import), entirely on the device:
//   TV Time   — its data export (.zip of .csv files, or the .csv files): followed shows and seen episodes
//   Trakt     — its export (.zip of .json files, or the .json files): watched/watchlist shows (with episodes) and movies
//   Letterboxd — its export (.zip of .csv files): watched.csv / diary.csv / ratings.csv → seen, watchlist.csv → to watch
//   anything else — a .csv with a title (or name) column, or a .txt list with one title per line
// Gives back what it found; app.js matches it to TVmaze shows and TMDB movies and adds them.
//   shows:  [{ name, year, tvdb, imdb, tmdb, watched: ['s:e', …], later }]   later: on a watchlist only, not started
//   movies: [{ name, year, imdb, tmdb, seen }]

/* ---------- .zip ---------- */
// Just enough of the zip format for app exports: stored or deflated files, read with the browser's own decompressor.
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That .zip file looks damaged.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !/\.(csv|json|txt)$/i.test(name) || /(^|\/)(__MACOSX|\.)/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else continue;
    out.push({ name: name.split('/').pop(), text: new TextDecoder().decode(bytes) });
  }
  return out;
}

// Files picked on the page → [{ name, text }] (each .zip opened up).
export async function readFiles(files) {
  const out = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === 'application/zip') out.push(...await unzip(await f.arrayBuffer()));
    else out.push({ name: f.name, text: await f.text() });
  }
  return out;
}

/* ---------- .csv ---------- */
export function csv(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  return rows.filter(r => r.some(x => x.trim())).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
const col = (row, ...names) => { for (const n of names) if (row[n] != null && row[n] !== '') return row[n]; return ''; };
const yearOf = v => (String(v || '').match(/\b(19|20)\d{2}\b/) || [''])[0];
const num = v => /^\d+$/.test(String(v || '').trim()) ? +v : 0;
const tt = v => (String(v || '').match(/tt\d{5,}/) || [''])[0];

/* ---------- collecting ---------- */
function collector() {
  const shows = new Map(), movies = new Map();
  const key = (o, type) => o.tvdb ? `tvdb:${o.tvdb}` : o.imdb ? `imdb:${o.imdb}` : o.tmdb ? `tmdb:${type}${o.tmdb}` : `name:${o.name.toLowerCase().trim()}|${type === 'm' ? o.year || '' : ''}`;
  return {
    show(o, eps = [], later = false) {
      if (!o.name && !o.tvdb && !o.imdb && !o.tmdb) return;
      const k = key(o, 's');
      const s = shows.get(k) || { name: o.name || '', year: o.year || '', tvdb: o.tvdb || 0, imdb: o.imdb || '', tmdb: o.tmdb || 0, watched: new Set(), later: true };
      for (const e of eps) if (e[0] > 0 && e[1] > 0) s.watched.add(`${e[0]}:${e[1]}`);
      if (!later) s.later = false;
      if (!s.name && o.name) s.name = o.name;
      shows.set(k, s);
    },
    movie(o, seen) {
      if (!o.name && !o.imdb && !o.tmdb) return;
      const k = key(o, 'm'), m = movies.get(k) || { name: o.name || '', year: o.year || '', imdb: o.imdb || '', tmdb: o.tmdb || 0, seen: false };
      if (seen) m.seen = true;
      movies.set(k, m);
    },
    done(sources) {
      const list = [...shows.values()].map(s => ({ ...s, watched: [...s.watched], later: s.later && !s.watched.size }));
      return { shows: list, movies: [...movies.values()], sources: [...sources] };
    }
  };
}

/* ---------- each app's files ---------- */
// Trakt: its own API's shapes — [{ show, seasons }], [{ type, show|movie|episode }], [{ movie }].
function trakt(data, file, c) {
  const watchlist = /watchlist|list/i.test(file) && !/watched|history/i.test(file);
  const ids = x => ({ name: x.title || '', year: x.year ? String(x.year) : '', tvdb: num(x.ids?.tvdb), imdb: tt(x.ids?.imdb), tmdb: num(x.ids?.tmdb) });
  for (const it of data) {
    if (!it || typeof it !== 'object') continue;
    if (it.movie) { c.movie(ids(it.movie), !watchlist); continue; }
    if (!it.show) continue;
    const eps = [];
    for (const s of it.seasons || []) for (const e of s.episodes || []) eps.push([s.number, e.number]);
    if (it.episode) eps.push([it.episode.season, it.episode.number]);
    c.show(ids(it.show), eps, watchlist && !eps.length);
  }
}
// TV Time: older exports name columns tv_show_name / episode_season_number…, newer ones series_name / season_number….
function tvtime(rows, file, c) {
  for (const r of rows) {
    const type = col(r, 'entity_type', 'type', 'object_type').toLowerCase();
    const movie = /movie/.test(type) || (/movie/i.test(file) && !/show|series|episode/i.test(file)) || (!!col(r, 'movie_name') && !col(r, 'tv_show_name', 'series_name'));
    if (movie) {
      c.movie({ name: col(r, 'movie_name', 'title', 'name'), year: yearOf(col(r, 'release_date', 'year')), imdb: tt(col(r, 'imdb_id', 'imdb')) },
        !/watchlist|want/i.test(file + ' ' + col(r, 'status', 'list')));
      continue;
    }
    const name = col(r, 'tv_show_name', 'series_name', 'show_name', 'tvshow_name', 'name', 'title');
    const tvdb = num(col(r, 'tv_show_id', 'series_id', 's_id', 'show_id', 'tvdb_id', 'tvdb'));
    const s = num(col(r, 'episode_season_number', 'season_number', 'season')), e = num(col(r, 'episode_number', 'number', 'episode'));
    const followOnly = /follow/i.test(file) || !(s && e);
    c.show({ name, tvdb }, s && e ? [[s, e]] : [], followOnly && /watchlist|want|later/i.test(file + ' ' + col(r, 'status')));
  }
}
function letterboxd(rows, file, c) {
  const seen = !/watchlist/i.test(file);
  for (const r of rows) c.movie({ name: col(r, 'name', 'title'), year: yearOf(col(r, 'year')) }, seen);
}
function genericCsv(rows, file, c, kind) {
  for (const r of rows) {
    const name = col(r, 'title', 'name', 'show', 'series', 'movie');
    const type = col(r, 'type', 'kind', 'media_type').toLowerCase();
    const year = yearOf(col(r, 'year', 'release_year', 'release_date')), imdb = tt(col(r, 'imdb_id', 'imdb', 'const', 'url'));
    const isMovie = /movie|film/.test(type) || (!type && kind === 'movies');
    if (isMovie) c.movie({ name, year, imdb }, !/watchlist|to.?watch/i.test(file + ' ' + col(r, 'status', 'list')));
    else c.show({ name, year, imdb }, [], false);
  }
}

// files: [{ name, text }]. kind: 'shows' or 'movies' — what a plain list of titles is.
export function parse(files, kind = 'shows') {
  const c = collector(), sources = new Set();
  for (const { name, text } of files) {
    const t = text.trim(); if (!t) continue;
    if (/\.json$/i.test(name) || /^[[{]/.test(t)) {
      let data; try { data = JSON.parse(t); } catch { continue; }
      if (!Array.isArray(data)) data = Object.values(data).find(Array.isArray) || [];
      if (data.some(x => x && (x.show || x.movie))) { trakt(data, name, c); sources.add('Trakt'); }
      continue;
    }
    if (/\.txt$/i.test(name) || !/[,\n]/.test(t) || !t.split(/\r?\n/)[0].includes(',')) {   // one title per line
      for (const line of t.split(/\r?\n/)) {
        const m = line.trim().replace(/^[-*•\d.)\s]+/, '').match(/^(.*?)(?:\s*\((\d{4})\))?$/);
        if (m && m[1] && !/^(title|name|shows?|movies?)$/i.test(m[1])) kind === 'movies' ? c.movie({ name: m[1], year: m[2] || '' }, false) : c.show({ name: m[1], year: m[2] || '' }, [], false);
      }
      sources.add('your list');
      continue;
    }
    const rows = csv(t); if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    if (cols.includes('letterboxd_uri')) { letterboxd(rows, name, c); sources.add('Letterboxd'); }
    else if (cols.some(k => /^(tv_show_(name|id)|series_name|episode_season_number|s_id|movie_name|entity_type)$/.test(k))) { tvtime(rows, name, c); sources.add('TV Time'); }
    else if (cols.some(k => /^(title|name|show|series|movie)$/.test(k))) { genericCsv(rows, name, c, kind); sources.add('your file'); }
  }
  return c.done(sources);
}
