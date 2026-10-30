// The weekly email's content: which episodes count as new, and the email itself. Kept apart from
// weekly.mjs (which talks to Firebase, TVmaze and Resend) so it can be tried out with sample data.

export const SITE = 'https://tvtracker.us';
const DAY = 864e5;

// Same rule as the site (app.js airTime): the exact air time if TVmaze has it, else 8pm on the air date.
export function airTime(e) {
  if (e.airstamp) return Date.parse(e.airstamp);
  if (e.airdate) return Date.parse(e.airdate + 'T20:00:00');
  return Infinity;
}

// Checkmarks live in users/{uid}.watched (older accounts) and users/{uid}/watched/bN buckets ({ e: { epId: { w, t } } }).
// Like the site, the newest change for an episode wins.
export function mergeWatched(legacy, buckets) {
  const all = { ...(legacy || {}) };
  for (const b of buckets) for (const [k, v] of Object.entries(b.e || {})) if (!all[k] || (v.t || 0) >= (all[k].t || 0)) all[k] = v;
  return all;
}

// Episodes that aired in the past week and aren't checked off, grouped by show (the site's "new" count uses the same 7 days).
// shows: [{ id, name }], episodesOf: id -> TVmaze episodes, watched: epId -> { w }.
export function newEpisodes(shows, episodesOf, watched, now = Date.now()) {
  const out = [];
  for (const s of shows) {
    const eps = (episodesOf(s.id) || []).filter(e => e.number != null && !watched[e.id]?.w && airTime(e) <= now && airTime(e) > now - 7 * DAY);
    if (eps.length) out.push({ show: s, eps: eps.sort((a, b) => airTime(a) - airTime(b)) });
  }
  return out.sort((a, b) => a.show.name.localeCompare(b.show.name));
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = e => e.airdate ? new Date(e.airdate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function buildEmail({ name, groups, unsubscribeUrl }) {
  const total = groups.reduce((n, g) => n + g.eps.length, 0);
  const names = groups.map(g => g.show.name);
  const subject = groups.length === 1
    ? (total === 1 ? `New episode of ${names[0]} to watch` : `${total} new episodes of ${names[0]} to watch`)
    : `${plural(total, 'new episode')} to watch: ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${plural(names.length - 2, 'more show')}` : ''}`;
  const hi = name ? `Hi ${name.split(/\s+/)[0]},` : 'Hi,';
  const intro = `Here's what aired this past week from your shows that you haven't checked off yet.`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141821">
<div style="display:none;max-height:0;overflow:hidden">${esc(plural(total, 'new episode'))} waiting on TV Tracker</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #dfe3e8">
<tr><td style="padding:24px 24px 8px"><a href="${SITE}/" style="text-decoration:none"><img src="${SITE}/icons/logo-120.png" width="56" height="56" alt="TV Tracker" style="display:block;border:0"></a></td></tr>
<tr><td style="padding:8px 24px 0;font-size:16px;line-height:1.5"><p style="margin:0 0 8px">${esc(hi)}</p><p style="margin:0 0 16px">${esc(intro)}</p></td></tr>
${groups.map(g => `<tr><td style="padding:4px 24px 12px">
  <div style="font-size:17px;font-weight:700;margin:0 0 6px">${esc(g.show.name)}</div>
  ${g.eps.map(e => `<div style="font-size:15px;line-height:1.45;padding:6px 0;border-top:1px solid #eef0f3">
    <b>Season ${e.season}, Episode ${e.number}</b>${e.name ? ` · ${esc(e.name)}` : ''}<br><span style="color:#5b6474;font-size:13px">Aired ${esc(when(e))}</span></div>`).join('')}
</td></tr>`).join('')}
<tr><td align="center" style="padding:12px 24px 28px"><a href="${SITE}/" style="display:inline-block;background:#e89a1c;color:#231500;font-weight:700;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:10px">Open TV Tracker</a></td></tr>
</table>
<p style="max-width:560px;font-size:12px;line-height:1.5;color:#5b6474;margin:16px auto 0;padding:0 12px">You're getting this weekly email because you have a TV Tracker account. <a href="${esc(unsubscribeUrl)}" style="color:#5b6474">Unsubscribe</a> · you can also switch it off on your <a href="${SITE}/#/account" style="color:#5b6474">Account page</a>.</p>
</td></tr></table></body></html>`;

  const text = [hi, '', intro, '',
    ...groups.flatMap(g => [g.show.name, ...g.eps.map(e => `  Season ${e.season}, Episode ${e.number}${e.name ? ` - ${e.name}` : ''} (aired ${when(e)})`), '']),
    `Open TV Tracker: ${SITE}/`, '', `Unsubscribe: ${unsubscribeUrl}`].join('\n');

  return { subject, html, text, total };
}

// "A friend recommended a show" email (email/recs.mjs). items: [{ fromName, note, show: { id, name, image, network } }], newest first.
export function buildRecEmail({ name, items, unsubscribeUrl }) {
  const senders = [...new Set(items.map(m => m.fromName || 'A friend'))];
  // Shows, movies (kind: 'movie'), or a mix of both.
  const isMovie = m => m.kind === 'movie', what = items.every(isMovie) ? 'movie' : items.some(isMovie) ? 'mix' : 'show';
  const count = n => what === 'mix' ? `${n} shows and movies` : plural(n, what);
  const subject = items.length === 1 ? `${senders[0]} recommended ${items[0].show.name} to you`
    : senders.length === 1 ? `${senders[0]} recommended ${count(items.length)} to you`
    : `${count(items.length)} recommended to you by ${senders.slice(0, 2).join(' and ')}${senders.length > 2 ? ' and others' : ''}`;
  const hi = name ? `Hi ${name.split(/\s+/)[0]},` : 'Hi,';
  const who = senders.length === 1 ? senders[0] : `${senders.slice(0, -1).join(', ')} and ${senders.at(-1)}`;
  const these = items.length === 1 ? `this ${what}` : what === 'mix' ? 'these shows and movies' : `these ${what}s`;
  const intro = senders.length === 1 ? `${who} thinks you'd like ${these}:` : `${who} think you'd like ${these}:`;
  // Plain ?show= / ?movie= addresses (index.html turns them into #/show/<id>/<who>): survive email apps and link redirects that drop #.
  const link = m => `${SITE}/?${isMovie(m) ? 'movie' : 'show'}=${m.show.id}&from=${encodeURIComponent(m.fromName || '')}`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141821">
<div style="display:none;max-height:0;overflow:hidden">${esc(subject)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #dfe3e8">
<tr><td style="padding:24px 24px 8px"><a href="${SITE}/" style="text-decoration:none"><img src="${SITE}/icons/logo-120.png" width="56" height="56" alt="TV Tracker" style="display:block;border:0"></a></td></tr>
<tr><td style="padding:8px 24px 4px;font-size:16px;line-height:1.5"><p style="margin:0 0 8px">${esc(hi)}</p><p style="margin:0 0 8px">${esc(intro)}</p></td></tr>
${items.map(m => `<tr><td style="padding:8px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0f3"><tr>
  ${m.show.image ? `<td width="72" valign="top" style="padding:12px 14px 0 0"><a href="${esc(link(m))}"><img src="${esc(m.show.image)}" width="72" alt="" style="display:block;border:0;border-radius:6px"></a></td>` : ''}
  <td valign="top" style="padding-top:12px;font-size:15px;line-height:1.45">
    <a href="${esc(link(m))}" style="font-size:17px;font-weight:700;color:#141821;text-decoration:none">${esc(m.show.name)}</a>${m.show.network ? `<br><span style="color:#5b6474;font-size:13px">${esc(m.show.network)}</span>` : ''}
    <br><span style="color:#5b6474">From ${esc(m.fromName || 'a friend')}</span>
    ${m.note ? `<div style="margin-top:6px;padding:8px 10px;background:#f4f5f7;border-radius:8px">&ldquo;${esc(m.note)}&rdquo;</div>` : ''}
  </td></tr></table></td></tr>`).join('')}
<tr><td align="center" style="padding:16px 24px 28px"><a href="${items.length === 1 ? esc(link(items[0])) : `${SITE}/`}" style="display:inline-block;background:#e89a1c;color:#231500;font-weight:700;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:10px">${items.length === 1 ? `See the ${what}` : 'Open TV Tracker'}</a></td></tr>
</table>
<p style="max-width:560px;font-size:12px;line-height:1.5;color:#5b6474;margin:16px auto 0;padding:0 12px">You're getting this because someone recommended a show or movie to your TV Tracker account. <a href="${esc(unsubscribeUrl)}" style="color:#5b6474">Stop these emails</a> · you can also switch them off on your <a href="${SITE}/#/account" style="color:#5b6474">Account page</a>.</p>
</td></tr></table></body></html>`;
  const text = [hi, '', intro, '',
    ...items.flatMap(m => [`${m.show.name}${m.show.network ? ` (${m.show.network})` : ''} - from ${m.fromName || 'a friend'}`, ...(m.note ? [`  "${m.note}"`] : []), `  ${link(m)}`, '']),
    `Stop these emails: ${unsubscribeUrl}`].join('\n');
  return { subject, html, text, senders };
}
