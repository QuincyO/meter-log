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
const CACHE = 'meterlog-v21';
const SHELL = [
  './', './index.html', './teams.html', './edit.html', './map.html', './reports.html',
  './help.html', './planner.html', './USER-GUIDE.md',
  './manifest.json',
  './icon-192.png', './icon-512.png',
  // CSS (capture page shares tokens+base; map/teams/edit/reports are self-contained)
  './css/tokens.css', './css/base.css', './css/capture.css',
  './css/map.css', './css/teams.css', './css/edit.css', './css/reports.css',
  './css/help.css', './css/planner.css',
  // vendored Leaflet CSS + its sprite images (map.html)
  './css/vendor/leaflet.css',
  './css/vendor/images/marker-icon.png', './css/vendor/images/marker-icon-2x.png',
  './css/vendor/images/marker-shadow.png',
  './css/vendor/images/layers.png', './css/vendor/images/layers-2x.png',
  // shared JS modules
  './js/config.js', './js/dom.js', './js/time.js', './js/store.js', './js/idb.js',
  './js/api.js', './js/daycache.js', './js/queue.js', './js/geocode.js',
  './js/worklist.js', './js/route.js', './js/utiReasons.js',
  './js/compute/gaps.js', './js/compute/tally.js', './js/compute/categories.js',
  './js/compute/summary.js', './js/compute/estimate.js',
  // on-device daily-log PDF: renderer + vendored jsPDF (UMD)
  './js/dailylog.js', './js/vendor/jspdf.umd.min.js',
  // vendored Leaflet + Chart.js (map.html — no more CDN, so the map shell
  // opens offline too; the OSM tiles themselves still need a connection)
  './js/vendor/leaflet.js', './js/vendor/chart.umd.min.js',
  // per-page entry points
  './js/pages/capture.js', './js/pages/teams.js', './js/pages/edit.js',
  './js/pages/map.js', './js/pages/reports.js', './js/pages/help.js',
  './js/pages/planner.js',
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

  // map.js used to be network-first because it depended on CDN Leaflet/Chart;
  // those are vendored + cached now, so it rides the same stale-while-revalidate
  // as the rest of the shell.
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
