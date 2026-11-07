// The welcome email sent once to each new account. Content only (like digest.mjs), so it can be previewed:
//   node email/welcome.mjs > welcome-preview.html
import { SITE } from './digest.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEPS = [
  ['➕', 'Add your shows', 'Search any network or streaming service — Netflix, HBO Max, Hulu, Disney+, Apple TV+, NBC and more.', `${SITE}/#/search`],
  ['✓', 'Check off episodes', 'Tap Watched as you go. My Shows always knows what\'s up next, and new episodes show up automatically.', `${SITE}/`],
  ['🎬', 'Track movies too', 'Switch Add Show to Movies to build your My Movies list. Mark them Seen it, and see where each one is streaming.', `${SITE}/#/movies`],
  ['🕒', 'Save shows for later', 'Put any show you want to start someday on your Future watch list.', `${SITE}/`],
  ['✨', 'Discover something new', 'Get picks based on what you watch, plus this week\'s premieres and movies in theaters now.', `${SITE}/#/discover`],
  ['↗', 'Recommend to friends', 'Send a show or movie straight to a friend\'s TV Tracker, or share a link.', `${SITE}/`],
  ['📱', 'Get the app', 'Install TV Tracker on your phone or computer with its own icon.', `${SITE}/`],
];

// logoSrc: where the logo image loads from. Emails use the live site's PNG; the preview can pass a data: URL.
export function welcomeEmail(name, logoSrc = `${SITE}/icons/logo-120.png`) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const hi = first ? `Hi ${first},` : 'Hi there,';
  const subject = first ? `Welcome to TV Tracker, ${first}!` : 'Welcome to TV Tracker!';
  const intro = "Thanks for signing up! TV Tracker keeps track of every show and movie you're watching, so you never lose your place. Here's how to get started:";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#141821">
<div style="display:none;max-height:0;overflow:hidden">Your shows and movies, all in one place. Here's how to get started.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #dfe3e8">
<tr><td style="height:6px;line-height:6px;font-size:0;background:#e89a1c;border-radius:14px 14px 0 0">&nbsp;</td></tr>
<tr><td align="center" style="padding:24px 24px 4px"><a href="${SITE}/" style="text-decoration:none"><img src="${esc(logoSrc)}" width="96" height="96" alt="TV Tracker" style="display:block;border:0;margin:0 auto"></a></td></tr>
<tr><td align="center" style="padding:4px 24px 20px;border-bottom:1px solid #eef0f3"><h1 style="margin:0;font-size:26px;line-height:1.25;color:#141821">Welcome to TV Tracker</h1><div style="margin-top:4px;font-size:15px;color:#5b6474">Your shows and movies, all in one place</div></td></tr>
<tr><td style="height:16px;line-height:16px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:0 24px 4px;font-size:16px;line-height:1.5"><p style="margin:0 0 8px">${esc(hi)}</p><p style="margin:0 0 8px">${esc(intro)}</p></td></tr>
${STEPS.map(([icon, title, text, href]) => `<tr><td style="padding:4px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eef0f3"><tr>
  <td width="44" valign="top" style="padding:14px 12px 10px 0"><div style="width:40px;height:40px;line-height:40px;text-align:center;font-size:20px;background:#fdf1dc;color:#b06d00;border-radius:10px">${icon}</div></td>
  <td valign="top" style="padding:12px 0 10px;font-size:15px;line-height:1.45"><a href="${esc(href)}" style="font-size:16px;font-weight:700;color:#141821;text-decoration:none">${esc(title)}</a><br><span style="color:#5b6474">${esc(text)}</span></td>
  </tr></table></td></tr>`).join('\n')}
<tr><td align="center" style="padding:16px 24px 28px"><a href="${SITE}/#/search" style="display:inline-block;background:#e89a1c;color:#231500;font-weight:700;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:10px">Add your first show or movie</a></td></tr>
</table>
<p style="max-width:560px;font-size:12px;line-height:1.5;color:#5b6474;margin:16px auto 0;padding:0 12px">You're getting this one-time email because you just created a TV Tracker account. Questions? Use <b>Contact us</b> at the bottom of any page on <a href="${SITE}/" style="color:#5b6474">tvtracker.us</a>.</p>
</td></tr></table></body></html>`;

  const text = `${hi}\n\n${intro}\n\n${STEPS.map(([, t, d]) => `• ${t} — ${d}`).join('\n')}\n\nAdd your first show or movie: ${SITE}/#/search\n\nYou're getting this one-time email because you just created a TV Tracker account.`;
  return { subject, html, text };
}

// Preview: the logo is embedded so it shows even offline.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const logo = 'data:image/png;base64,' + readFileSync(new URL('../icons/logo-120.png', import.meta.url)).toString('base64');
  process.stdout.write(welcomeEmail(process.argv[2] || 'Christie Holmes', logo).html);
}
