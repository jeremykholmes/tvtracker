// Lets browsers offer "Install app", and makes sure updates show up on the next visit:
// the site's own files are always re-checked with the server (a quick "not modified" when
// nothing changed) instead of being reused from the browser's cache for up to 10 minutes.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;   // TVmaze, Firebase etc. untouched
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache' }) : fetch(req, { cache: 'no-cache' });
  e.respondWith(fresh.catch(() => fetch(req)));
});
