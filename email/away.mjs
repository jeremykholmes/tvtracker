// The "it's been a while" email, for an account with shows on its list that hasn't opened TV Tracker, added a show or movie,
// or checked off an episode in 30 days. Sent by email/away-send.mjs.
// Content only (like welcome.mjs), so it can be previewed:  node email/away.mjs > away-preview.html   (add "none" for the
// version with no new episodes:  node email/away.mjs none > away-preview.html)
import { SITE } from './digest.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const SHOWN = 4;   // shows listed in the email; the rest are summed up in one line

// name: the person's name. shows: [{ id, name, image, network, count }], count = episodes that aired since they were last on
// and aren't checked off (0 for all of them if nothing new aired; then their list's shows are listed instead).
// logoSrc: where the logo image loads from. Emails use the live site's PNG; the preview can pass a data: URL.
export function awayEmail({ name, shows = [], unsubscribeUrl, logoSrc = `${SITE}/icons/logo-120.png` }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const withNew = shows.filter(s => s.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = withNew.reduce((n, s) => n + s.count, 0);
  const list = (withNew.length ? withNew : shows).slice(0, SHOWN), more = (withNew.length ? withNew : shows).length - list.length;

  const subject = total
    ? `${first ? first + ', ' : ''}${plural(total, 'new episode')} ${total === 1 ? 'is' : 'are'} waiting for you`
    : `${first ? first + ', your' : 'Your'} TV Tracker list is right where you left it`;
  const heading = total ? 'New episodes are waiting' : 'We saved your spot';
  const sub = total ? `${plural(total, 'episode')} of your shows aired while you were away` : 'Your list is right where you left it';
  const intro = total
    ? "It's been about a month since you last stopped by TV Tracker. Your shows kept going while you were away, and none of these new episodes are checked off yet:"
    : "It's been about a month since you last stopped by TV Tracker. Your list and checkmarks are just as you left them, so you can pick up right where you stopped:";
  const line = s => total ? plural(s.count, 'new episode') : (s.network || 'Up next on your list');
  const moreLine = more > 0 ? (total ? `…and ${plural(more, 'more show')} with new episodes.` : `…and ${plural(more, 'more show')} on your list.`) : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141821">
<div style="display:none;max-height:0;overflow:hidden">${esc(sub)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #dfe3e8">
<tr><td style="height:6px;line-height:6px;font-size:0;background:#e89a1c;border-radius:14px 14px 0 0">&nbsp;</td></tr>
<tr><td align="center" style="padding:24px 24px 4px"><a href="${SITE}/" style="text-decoration:none"><img src="${esc(logoSrc)}" width="96" height="96" alt="TV Tracker" style="display:block;border:0;margin:0 auto"></a></td></tr>
<tr><td align="center" style="padding:4px 24px 20px;border-bottom:1px solid #eef0f3"><h1 style="margin:0;font-size:26px;line-height:1.25;color:#141821">${esc(heading)}</h1><div style="margin-top:4px;font-size:15px;color:#5b6474">${esc(sub)}</div></td></tr>
<tr><td style="height:16px;line-height:16px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:0 24px 4px;font-size:16px;line-height:1.5"><p style="margin:0 0 8px">${esc(hi)}</p><p style="margin:0 0 8px">${esc(intro)}</p></td></tr>
${list.map(s => `<tr><td style="padding:4px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0f3"><tr>
  ${s.image ? `<td width="56" valign="top" style="padding:12px 14px 10px 0"><a href="${SITE}/#/show/${+s.id}"><img src="${esc(s.image)}" width="56" alt="" style="display:block;border:0;border-radius:6px"></a></td>` : ''}
  <td valign="middle" style="padding:12px 0 10px;font-size:15px;line-height:1.45"><a href="${SITE}/#/show/${+s.id}" style="font-size:16px;font-weight:700;color:#141821;text-decoration:none">${esc(s.name)}</a><br><span style="color:${total ? '#b06d00;font-weight:600' : '#5b6474'}">${esc(line(s))}</span></td>
  </tr></table></td></tr>`).join('\n')}
${moreLine ? `<tr><td style="padding:4px 24px 0;font-size:14px;color:#5b6474">${esc(moreLine)}</td></tr>` : ''}
<tr><td align="center" style="padding:20px 24px 8px"><a href="${SITE}/#/shows" style="display:inline-block;background:#e89a1c;color:#231500;font-weight:700;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:10px">${total ? "See what's up next" : 'Open My Shows'}</a></td></tr>
<tr><td align="center" style="padding:4px 24px 28px;font-size:14px;color:#5b6474">Looking for something new? See <a href="${SITE}/new" style="color:#b06d00;font-weight:600">what's new this week</a> on Netflix, Hulu, Max and more.</td></tr>
</table>
<p style="max-width:560px;font-size:12px;line-height:1.5;color:#5b6474;margin:16px auto 0;padding:0 12px">You're getting this because you haven't been on TV Tracker in about a month. We won't send another unless you come back and then stay away for a month again. <a href="${esc(unsubscribeUrl || SITE + '/#/account')}" style="color:#5b6474">Unsubscribe</a> from these reminders.</p>
</td></tr></table></body></html>`;

  const text = `${hi}\n\n${intro}\n\n${list.map(s => `• ${s.name} — ${line(s)}`).join('\n')}${moreLine ? '\n' + moreLine : ''}\n\n${total ? "See what's up next" : 'Open My Shows'}: ${SITE}/#/shows\nWhat's new this week: ${SITE}/new\n\nYou're getting this because you haven't been on TV Tracker in about a month. We won't send another unless you come back and then stay away for a month again. Unsubscribe: ${unsubscribeUrl || SITE + '/#/account'}`;
  return { subject, html, text };
}

// Sample data for the preview and for test runs.
export const SAMPLE_SHOWS = [
  { id: 44933, name: 'Severance', network: 'Apple TV', image: 'https://static.tvmaze.com/uploads/images/medium_portrait/548/1371406.jpg', count: 4 },
  { id: 82, name: 'Game of Thrones', network: 'HBO', image: 'https://static.tvmaze.com/uploads/images/medium_portrait/498/1245274.jpg', count: 0 },
  { id: 2993, name: 'Stranger Things', network: 'Netflix', image: 'https://static.tvmaze.com/uploads/images/medium_portrait/595/1489169.jpg', count: 3 },
  { id: 1371, name: 'Westworld', network: 'HBO', image: 'https://static.tvmaze.com/uploads/images/medium_portrait/445/1113927.jpg', count: 1 },
];

// Preview: the logo is embedded so it shows even offline.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const logo = 'data:image/png;base64,' + readFileSync(new URL('../icons/logo-120.png', import.meta.url)).toString('base64');
  const shows = process.argv[2] === 'none' ? SAMPLE_SHOWS.map(s => ({ ...s, count: 0 })) : SAMPLE_SHOWS;
  process.stdout.write(awayEmail({ name: process.argv[3] || 'Christie Holmes', shows, unsubscribeUrl: `${SITE}/unsubscribe.html`, logoSrc: logo }).html);
}
