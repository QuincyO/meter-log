/* Meter Log service worker — makes the app open with no signal.
 *
 * Strategy: stale-while-revalidate for the app's OWN files. The phone serves
 * the cached copy instantly (so the app opens at zero bars), and quietly
 * fetches a fresh copy in the background for next time — so when you change
 * index.html on the host, the app picks up the new version on the next open.
 * No version bumping needed for normal edits.
 *
 * It deliberately ignores the POST to the Apps Script URL: those requests go
 * straight to the network and, when there's no signal, fail — so the app's own
 * offline queue holds the record on the phone until it can send.
 */
const CACHE = 'meterlog-v5';
const SHELL = [
  './', './index.html', './teams.html', './edit.html', './manifest.json',
  './icon-192.png', './icon-512.png',
  // shared CSS
  './css/tokens.css', './css/base.css', './css/capture.css',
  // shared JS modules + the capture page entry point
  './js/config.js', './js/dom.js', './js/time.js', './js/store.js', './js/idb.js',
  './js/api.js', './js/daycache.js', './js/queue.js', './js/geocode.js',
  './js/compute/gaps.js', './js/compute/tally.js', './js/compute/dispatch.js',
  './js/pages/capture.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Only handle this app's own GET requests. Everything else — above all the
  // POST to the Google Apps Script endpoint — is left to the network so the
  // page's queue can catch failures when offline.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      return cached || (await network) || cache.match('./index.html');
    })
  );
});
