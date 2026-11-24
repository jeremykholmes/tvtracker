// The "new season starting" email: a show someone has been watching (at least one episode checked off) has its next season
// premiering in the coming week. Sent by email/seasons-send.mjs. Content only (like welcome.mjs), so it can be previewed:
//   node email/seasons.mjs > seasons-preview.html          (several shows)
//   node email/seasons.mjs one > seasons-preview.html      (one show)
import { SITE } from './digest.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// When a premiere airs, from TVmaze's air date (the network's own date): "today", "tomorrow", or "Thursday, Dec 4".
// today: the date (YYYY-MM-DD) to count from, US Eastern time like most premieres.
export function premiereDay(airdate, today) {
  if (!airdate) return 'soon';
  const days = Math.round((Date.parse(airdate + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return new Date(airdate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export const easternToday = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// name: the person's name. shows: [{ id, name, image, network, season, airdate }], soonest first.
// logoSrc: where the logo image loads from. Emails use the live site's PNG; the preview can pass a data: URL.
export function seasonsEmail({ name, shows, unsubscribeUrl, today = easternToday(), logoSrc = `${SITE}/icons/logo-120.png` }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const one = shows.length === 1, s0 = shows[0];
  const day = s => premiereDay(s.airdate, today);
  const on = s => ['today', 'tomorrow', 'soon'].includes(day(s)) ? day(s) : `on ${day(s)}`;
  const subject = one
    ? `${s0.name} Season ${s0.season} starts ${on(s0)}`
    : `New seasons of ${shows.slice(0, 2).map(s => s.name).join(' and ')}${shows.length > 2 ? ` and ${plural(shows.length - 2, 'more show')}` : ''} start this week`;
  const heading = one ? `${s0.name} is back` : 'New seasons this week';
  const sub = one ? `Season ${s0.season} starts ${on(s0)}` : `${plural(shows.length, 'show')} you've been watching ${shows.length === 1 ? 'is' : 'are'} coming back`;
  const intro = one
    ? `A show you've been watching is coming back. Season ${s0.season} of ${s0.name} starts ${on(s0)}:`
    : "Shows you've been watching are starting new seasons in the next few days:";
  const line = s => `Season ${s.season} starts ${on(s)}${s.network ? ' · ' + s.network : ''}`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141821">
<div style="display:none;max-height:0;overflow:hidden">${esc(sub)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #dfe3e8">
<tr><td style="height:6px;line-height:6px;font-size:0;background:#e89a1c;border-radius:14px 14px 0 0">&nbsp;</td></tr>
<tr><td align="center" style="padding:24px 24px 4px"><a href="${SITE}/" style="text-decoration:none"><img src="${esc(logoSrc)}" width="96" height="96" alt="TV Tracker" style="display:block;border:0;margin:0 auto"></a></td></tr>
<tr><td align="center" style="padding:4px 24px 20px;border-bottom:1px solid #eef0f3"><h1 style="margin:0;font-size:26px;line-height:1.25;color:#141821">${esc(heading)}</h1><div style="margin-top:4px;font-size:15px;color:#5b6474">${esc(sub)}</div></td></tr>
<tr><td style="height:16px;line-height:16px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:0 24px 4px;font-size:16px;line-height:1.5"><p style="margin:0 0 8px">${esc(hi)}</p><p style="margin:0 0 8px">${esc(intro)}</p></td></tr>
${shows.map(s => `<tr><td style="padding:4px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0f3"><tr>
  ${s.image ? `<td width="${one ? 96 : 56}" valign="top" style="padding:12px 14px 10px 0"><a href="${SITE}/#/show/${+s.id}"><img src="${esc(s.image)}" width="${one ? 96 : 56}" alt="" style="display:block;border:0;border-radius:6px"></a></td>` : ''}
  <td valign="middle" style="padding:12px 0 10px;font-size:15px;line-height:1.45"><a href="${SITE}/#/show/${+s.id}" style="font-size:${one ? 19 : 16}px;font-weight:700;color:#141821;text-decoration:none">${esc(s.name)}</a><br><span style="color:#b06d00;font-weight:600">${esc(line(s))}</span></td>
  </tr></table></td></tr>`).join('\n')}
<tr><td align="center" style="padding:20px 24px 28px"><a href="${one ? `${SITE}/#/show/${+s0.id}` : `${SITE}/#/shows`}" style="display:inline-block;background:#e89a1c;color:#231500;font-weight:700;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:10px">${one ? `See Season ${s0.season}` : 'Open My Shows'}</a></td></tr>
</table>
<p style="max-width:560px;font-size:12px;line-height:1.5;color:#5b6474;margin:16px auto 0;padding:0 12px">You're getting this because you've watched ${one ? 'this show' : 'these shows'} on TV Tracker. We send one email per new season. <a href="${esc(unsubscribeUrl || SITE + '/#/account')}" style="color:#5b6474">Unsubscribe</a> from new-season emails.</p>
</td></tr></table></body></html>`;

  const text = `${hi}\n\n${intro}\n\n${shows.map(s => `• ${s.name} — ${line(s)}\n  ${SITE}/#/show/${+s.id}`).join('\n')}\n\n${one ? '' : `Open My Shows: ${SITE}/#/shows\n\n`}You're getting this because you've watched ${one ? 'this show' : 'these shows'} on TV Tracker. We send one email per new season. Unsubscribe: ${unsubscribeUrl || SITE + '/#/account'}`;
  return { subject, html, text };
}

// Sample data for the preview and for test runs: premieres 0, 2 and 5 days from today.
export function sampleShows(today = easternToday()) {
  const plus = n => new Date(Date.parse(today + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  return [
    { id: 44933, name: 'Severance', network: 'Apple TV', season: 3, airdate: plus(2), image: 'https://static.tvmaze.com/uploads/images/medium_portrait/548/1371406.jpg' },
    { id: 2993, name: 'Stranger Things', network: 'Netflix', season: 6, airdate: plus(5), image: 'https://static.tvmaze.com/uploads/images/medium_portrait/595/1489169.jpg' },
    { id: 1371, name: 'Westworld', network: 'HBO', season: 5, airdate: plus(0), image: 'https://static.tvmaze.com/uploads/images/medium_portrait/445/1113927.jpg' },
  ].sort((a, b) => a.airdate.localeCompare(b.airdate));
}

// Preview: the logo is embedded so it shows even offline.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const logo = 'data:image/png;base64,' + readFileSync(new URL('../icons/logo-120.png', import.meta.url)).toString('base64');
  const shows = sampleShows();
  process.stdout.write(seasonsEmail({ name: process.argv[3] || 'Christie Holmes', shows: process.argv[2] === 'one' ? shows.filter(s => s.id === 44933) : shows, unsubscribeUrl: `${SITE}/unsubscribe.html`, logoSrc: logo }).html);
}
