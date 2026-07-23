# VERIFY.md

How to actually run this thing and watch a change work. For **any** agent — nothing here
is tool-specific. See `AGENTS.md` §"Working in this repo" for why this lives in the repo
rather than in one agent's private skill store.

There is no build step. The surface is seven static pages served over HTTP, talking to
the **live production** Apps Script spine (URL + token in `js/config.js`). That last word
is why the safety section below exists.

## 1. Unit tests

```
node --test "tests/*.test.mjs"
```

No install, no package.json — `node:test` over the pure modules (`js/route.js`,
`js/route-variants.js`, `js/route-constraints.js`, `js/compute/*`) plus assertions about
doc, CSS, and `Code.gs` schema content. Run this before every push.

Note the glob is quoted. `node --test tests/` treats the directory as a CommonJS entry
and fails with `MODULE_NOT_FOUND`.

## 2. Serve the pages

A `file://` open breaks the service worker, the ES-module imports, and every fetch, so
it must be HTTP.

**`python` on this machine is the Windows Store stub and never serves anything** — don't
reach for `python -m http.server`. Use node, and set `Content-Type` explicitly: browsers
refuse to execute ES modules served as `application/octet-stream`.

```js
// serve.mjs — run: node serve.mjs <repo-root>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const ROOT = process.argv[2];
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png', '.md':'text/markdown',
  '.svg':'image/svg+xml' };
createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^[\\/]+/, '');
  try {
    const buf = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8731, () => console.log('serving on 8731'));
```

Remember to stop it when you're done — a backgrounded server runs until killed.

## 3. Drive a page (headless Edge + CDP)

No Playwright installed. Headless Edge works.

**Quick smoke** — post-JS DOM in one shot:

```
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  --disable-gpu --user-data-dir=<tmp> --virtual-time-budget=20000 \
  --dump-dom http://localhost:8731/<page>.html
```

The budget lets the module + spine fetches finish. The `msedge` process lingers after the
dump — run it backgrounded and kill `msedge.exe` afterwards.

**Full drive** — launch Edge with `--remote-debugging-port=9333 --headless=new
--user-data-dir=<fresh tmp>`, then talk CDP over the global `WebSocket` (node ≥ 22):
`PUT /json/new?<url>` to open a target, then `Runtime.evaluate` to click/fill/read the
DOM and `Page.captureScreenshot` for evidence. `Emulation.setDeviceMetricsOverride` sets
a phone viewport — worth doing, since the capture page is phone-first and the worklist
card action row is tight at 320 px.

## 4. Safety — this is production data

- GET actions (`roster`, `pins`, `tracker`, `day`, …) are read-only → safe.
- **Never click Save / Close / log buttons against the real spine.** They write to the
  production Sheet: Close day posts `endOfDay`, Settings Save enqueues `saveEmployee`,
  the worklist Upload posts `saveWorklist`.
- To exercise a write path, intercept it. Enable CDP `Fetch.enable` on
  `*script.google.com*` **and** `*googleusercontent.com*` (GETs 302-redirect to the
  latter) and answer every request with `Fetch.fulfillRequest`:

  ```js
  await page.send('Fetch.enable', { patterns:[
    { urlPattern:'*script.google.com*' }, { urlPattern:'*googleusercontent.com*' } ] });
  // …on each Fetch.requestPaused: capture request.postData, then fulfill with
  // {ok:true} plus an Access-Control-Allow-Origin:* header.
  ```

  This also lets you stub *reads* to force UI states — `action=tracker` → empty makes a
  day render as "open", `action=worklist` → a fixture exercises the download normalizer.
  Capturing `request.postData` on the POST is how you check an upload payload without
  ever sending one.
- A fresh Edge profile has empty `localStorage`, so `index.html` auto-opens the settings
  sheet after ~400 ms. Seed `localStorage` (`name`, `hNumber`) via `Runtime.evaluate` to
  simulate a configured installer.

## 5. Gotchas that cost real time

- **The service worker will serve you stale code.** Any profile that loaded a page
  earlier keeps returning the old module/CSS from the SW cache, so a fix you just made
  looks like it did nothing — and a bug you just fixed looks like it's still there. Clear
  it before re-measuring:

  ```js
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  for(const k of await caches.keys()) await caches.delete(k);
  ```

  Then reload. A fresh `--user-data-dir` works too. (The crew's version of this is
  Settings ▸ **⟳ Force update from GitHub** — see below.)
- **Verifying the force update needs a server that sends `Cache-Control`.** The button's
  whole job is bypassing the *browser HTTP cache* with `cache: 'reload'`, and the bare
  `serve.mjs` above sends no cache headers — so the bypass is untestable against it and
  the button looks like it works even if the flag were dropped. Add
  `'Cache-Control': 'public, max-age=600'` to the response headers (that's roughly what
  GitHub Pages sends), then: load the page, change a served file, confirm a plain
  `fetch()` still returns the **old** bytes, press the button, and confirm
  `caches.open('meterlog-v27').match('./js/dom.js')` now holds the **new** ones. Check at
  the same time that `localStorage` still has `name`/`hNumber` and the IndexedDB
  `worklist` row survived — preserving those is the point of the in-place design.
- **Spine changes in `Code.gs` are not live until pushed** (CI deploys from `main`). New
  GET actions error against prod during verification — check the frontend degrades
  sensibly rather than assuming the code is wrong. (`driveTracks` is gentle here: the
  spine's `doGet` fallback returns `{ok:true}` for an unknown action, so `map.js` reads
  it as an empty list and the viewer keeps working before the deploy.)
- **Driving the Drive screen (`#drive`).** It's reachable only via the worklist's 🚗 Drive
  button; `document.getElementById('wlDrive').click()` opens it. Headless has **no
  geolocation**, so the leg records no points and `finalizeAndEnqueue` drops it — nothing
  is written, which is what you want against prod. Verify the driver-facing behavior: the
  card shows only the current order, **Advance/Back move the display without changing an
  order's `wlStatus`** (read the `worklist` IndexedDB store before/after to confirm), and
  the per-day tracking toggle flips the "🛰 Location on / Location off" chip and writes
  `localStorage['driveTrack']` = `{on, date}`. To exercise `saveDriveTrack`/`driveTracks`
  end-to-end, intercept the spine (§4) and either inject fixes via
  `Emulation.setGeolocationOverride` or seed the `driveTracks` IndexedDB store directly.
- Find dates that actually have data via `action=pins&from=&to=` before driving date
  pickers.
- `status:"DONE"` stops never render anywhere — a day holding only DONE markers
  legitimately shows empty.
- IndexedDB is easy to seed directly for worklist work: `indexedDB.open('meterlog')`,
  then `put` into the `worklist` store. Faster and more controllable than driving the UI
  to build a list.
