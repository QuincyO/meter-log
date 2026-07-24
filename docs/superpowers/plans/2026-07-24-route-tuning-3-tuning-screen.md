# Route tuning — Plan 3: the tuning screen + live readout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give installers a capture-only `🎛 Route tuning` screen with a **commute pull** slider and a **target finish time** — the two dials Plan 2 wired in — plus a live "expected stops/day" readout that updates as the finish time moves.

**Architecture:** A new hash-routed sibling screen (`#tuning`) modelled on the existing worklist sub-screens: a self-contained controller module `js/worklist-tuning.js` exposing `{ open, close }`, driven by `worklist.js`'s central `showHashScreen` popstate handler; opened from the capture `☰` nav. The screen reads/writes the `store` keys Plan 2 consumes (`wlCommutePull`/`wlFinishBy`) and rides the existing worklist Upload to sync. The live readout is a pure function over the installer's 30-day pace (`installerMetrics`) using the same `onSiteMinutes`/`NOMINAL_TRAVEL_MIN` model as `route.js`'s `timeCapacity`.

**Tech Stack:** Vanilla ES modules; `node --test`; service worker app-shell cache.

## Global Constraints

- No build step; native ES modules. Full suite: `node --test "tests/*.test.mjs"` — green before any push.
- **New module ⇒ register it:** add `./js/worklist-tuning.js` to `sw.js` `SHELL` and bump `CACHE` (`meterlog-v30` → `meterlog-v31`), or phones won't fetch it offline.
- Screen is reachable **only from the capture page** — a nav entry in `#navMenu`, no back-office page links it.
- Dials: `commutePull` integer 0–100 (default 70), `finishBy` 'HH:MM' (default '14:00'). Store keys: `wlCommutePull`, `wlFinishBy` (the same keys Plan 2's `planShape` reads).
- Departure clock is `ROUTE_DEPART_TIME` ('08:15', global); the screen shows it as read-only text.
- Live readout is **finish-time driven only** — commute pull does not move it (deferred; see `docs/backlog/live-expected-meters-preview.md`).
- The screen only persists to local `store`; values sync to the office on the next worklist **Upload** (no new endpoint).

---

### Task 1: The tuning controller module + live-estimate function

**Files:**
- Create: `js/worklist-tuning.js`
- Create: `tests/worklist-tuning.test.mjs`
- Modify: `sw.js` (`SHELL` list ~line 31, `CACHE` ~line 13)

**Interfaces:**
- Produces:
  - `export function expectedDailyStops({ departMin, finishMin, pace, breakMin })` → integer ≥ 0, or `null` when inputs are unusable. Pure.
  - `export function initWorklistTuning()` → `{ open: () => Promise<void>, close: () => void }`. `open()` shows `#tuningScreen` (hiding `captureMain`/`worklistScreen`), loads the dials from `store`, best-effort fetches `installerMetrics`, and renders the readout. `close()` only hides `#tuningScreen`.
- Consumes (Task 3): `worklist.js` creates the handle and routes `#tuning` to it; `capture.js` nav calls the exported `openTuning`.

- [ ] **Step 1: Write the failing test for the pure estimate**

Create `tests/worklist-tuning.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedDailyStops } from '../js/worklist-tuning.js';

// 08:15 depart, 14:00 finish, 60-min break, 24 min/stop pace.
test('expected stops at the 14:00 default', () => {
  assert.equal(expectedDailyStops({ departMin:495, finishMin:840, pace:24 }), 11);
});

test('an earlier finish fits fewer stops', () => {
  assert.equal(expectedDailyStops({ departMin:495, finishMin:780, pace:24 }), 8);
});

test('null when the finish time is unusable or pace is missing', () => {
  assert.equal(expectedDailyStops({ departMin:495, finishMin:null, pace:24 }), null);
  assert.equal(expectedDailyStops({ departMin:495, finishMin:840, pace:0 }), null);
  assert.equal(expectedDailyStops({ departMin:495, finishMin:520, pace:24 }), null); // break eats the day
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worklist-tuning.test.mjs`
Expected: FAIL — `js/worklist-tuning.js` does not exist (module resolution error).

- [ ] **Step 3: Create the module**

Create `js/worklist-tuning.js`:

```js
// ── Route tuning screen (#tuning) ─────────────────────────────────────────────
// A capture-only settings screen for the installer's two route dials — commute
// pull (how hard each day heads home) and target finish time (finish-early vs
// more stops). Values live in localStorage (store keys wlCommutePull / wlFinishBy)
// and are read by worklist.js planShape; they ride the worklist Upload to the
// office. A live "expected stops/day" readout is driven by the finish time only
// (commute pull's true cost needs a real route — deferred, see docs/backlog).
import { $, esc, toast } from './dom.js';
import { store, cfg } from './store.js';
import { apiGet } from './api.js';
import { hhmmMin } from './time.js';
import { ROUTE_DEPART_TIME } from './config.js';
import { onSiteMinutes, NOMINAL_TRAVEL_MIN } from './route-constraints.js';

// A commute-pull dial value clamped to 0–100; blank/garbage ⇒ the 70 default.
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}

// How many stops a day fits by `finishMin`, from the installer's pace — the same
// per-stop model route.js timeCapacity uses (pace-derived on-site + a nominal
// between-stop drive), minus one nominal morning drive-out. Minutes-of-day in;
// null when the finish time or pace is unusable, or the break eats the day.
export function expectedDailyStops({ departMin, finishMin, pace, breakMin = 60 }){
  if(!isFinite(finishMin) || !isFinite(departMin) || !(pace > 0)) return null;
  const available = finishMin - departMin - breakMin;
  const perStop = onSiteMinutes(pace) + NOMINAL_TRAVEL_MIN;
  if(!(available > 0) || !(perStop > 0)) return null;
  return Math.max(0, Math.floor((available - NOMINAL_TRAVEL_MIN) / perStop));
}

let pace = null, avgPerDay = null, metricsLoaded = false;

async function loadMetrics(){
  const c = cfg();
  if(metricsLoaded || !c.hNumber || !navigator.onLine) return;
  try{
    const r = await apiGet('installerMetrics', { hNumber:c.hNumber, workType:'land' });
    const m = (r && r.ok && r.metrics && r.metrics[0]) || null;
    if(m){
      pace = (m.recent30AvgLogMin === '' || m.recent30AvgLogMin == null)
        ? ((m.avgLogMin === '' || m.avgLogMin == null) ? null : Number(m.avgLogMin))
        : Number(m.recent30AvgLogMin);
      avgPerDay = (m.avgPerDay === '' || m.avgPerDay == null) ? null : Number(m.avgPerDay);
      metricsLoaded = true;
    }
  } catch {}
}

function render(){
  const finishStr = $('tuneFinishBy').value;
  const p = pace || Number(store.get('wlPaceMin')) || 30;
  const n = expectedDailyStops({ departMin:hhmmMin(ROUTE_DEPART_TIME), finishMin:hhmmMin(finishStr), pace:p });
  const lines = [
    n == null ? 'Set a finish time to see expected stops' : `At ${finishStr} finish → ~${n} stops/day`,
    `Your 30-day pace: ${pace ? pace + ' min/stop' : '—'}`
  ];
  if(avgPerDay) lines.push(`Recent avg: ${avgPerDay} meters/day`);
  $('tuneReadout').innerHTML = lines.map(esc).join('<br>');
}

function loadControls(){
  const pull = $('tuneCommutePull');
  pull.value = String(pullVal(store.get('wlCommutePull')));
  $('tuneCommutePullVal').textContent = pull.value + '%';
  $('tuneFinishBy').value = store.get('wlFinishBy') || '14:00';
}

function save(){
  store.set('wlCommutePull', String(pullVal($('tuneCommutePull').value)));
  const f = $('tuneFinishBy').value;
  if(/^\d{1,2}:\d{2}$/.test(f)) store.set('wlFinishBy', f);
  toast('Saved — Upload your list to sync these to the office');
}

async function open(){
  $('captureMain').classList.add('hide');
  $('worklistScreen').classList.add('hide');
  $('tuningScreen').classList.remove('hide');
  loadControls();
  render();
  window.scrollTo(0, 0);
  await loadMetrics();
  render();
}
function close(){ $('tuningScreen').classList.add('hide'); }

export function initWorklistTuning(){
  $('tuneCommutePull').oninput = () => { $('tuneCommutePullVal').textContent = $('tuneCommutePull').value + '%'; };
  $('tuneFinishBy').oninput = render;
  $('tuneSave').onclick = save;
  $('tuneBack').onclick = () => location.hash === '#tuning' ? history.back() : close();
  return { open, close };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/worklist-tuning.test.mjs`
Expected: PASS (3 tests). The controller half isn't exercised by node (no DOM) — the pure `expectedDailyStops` is the tested unit; the wiring is covered by the markup/source assertions in Tasks 2–3.

- [ ] **Step 5: Register the module in the service worker**

In `sw.js`, bump `CACHE` (~line 13):

```js
const CACHE = 'meterlog-v31';
```

Add the module to the `SHELL` worklist group (~line 31–32):

```js
  './js/worklist.js', './js/worklist-route-view.js', './js/worklist-address-fill.js',
  './js/worklist-dedup.js', './js/worklist-tuning.js',
```

- [ ] **Step 6: Run the full suite**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add js/worklist-tuning.js tests/worklist-tuning.test.mjs sw.js
git commit -m "Route tuning: tuning-screen controller + live stops/day estimate"
```

---

### Task 2: The screen markup + nav entry + styles

**Files:**
- Modify: `index.html` (nav button in `#navMenu` ~line 36; new `#tuningScreen` section after the worklist sub-screens)
- Modify: `css/capture.css` (append tuning-screen styles)
- Test: `tests/worklist-tuning.test.mjs` (add markup assertions)

**Interfaces:**
- Produces the DOM the controller binds: `#navTuning`, `#tuningScreen`, `#tuneBack`, `#tuneCommutePull`, `#tuneCommutePullVal`, `#tuneFinishBy`, `#tuneReadout`, `#tuneSave`.

- [ ] **Step 1: Write the failing markup assertions**

Add to `tests/worklist-tuning.test.mjs`:

```js
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the capture nav offers a route-tuning entry', () => {
  assert.match(html, /<button id="navTuning">[^<]*Route tuning<\/button>/);
});

test('the tuning screen has both dials, a readout and a save', () => {
  assert.match(html, /id="tuningScreen"/);
  assert.match(html, /id="tuneCommutePull"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  assert.match(html, /id="tuneFinishBy"[^>]*type="time"/);
  assert.match(html, /id="tuneReadout"/);
  assert.match(html, /id="tuneSave"/);
  // the org-wide leave time is shown as read-only context, not an input
  assert.match(html, /08:15/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worklist-tuning.test.mjs`
Expected: FAIL — none of that markup exists yet.

- [ ] **Step 3: Add the nav button**

In `index.html` `#navMenu` (~line 33–37), add the entry after `navRecent` (capture-only — this menu is the only place it appears):

```html
        <button id="navWorklist">📋 Worklist</button>
        <button id="navRecent">🗓 Recent days</button>
        <button id="navTuning">🎛 Route tuning</button>
        <button id="navSettings">⚙︎ Settings</button>
        <button id="navHelp">❓ Help</button>
```

- [ ] **Step 4: Add the `#tuningScreen` section**

In `index.html`, add this section immediately after the worklist Drive sub-screen's closing tag (after the `driveBack` screen block, alongside the other `wlscreen` sections). Match the existing `wlscreen`/`wl-head`/`wl-back` structure:

```html
  <!-- Route tuning (installer-only dials; opened from the capture ☰ nav) -->
  <section class="wlscreen hide" id="tuningScreen">
    <div class="wl-head">
      <button class="wl-back" id="tuneBack" type="button" aria-label="Back to capture">‹ Back</button>
      <h2>Route tuning</h2>
    </div>
    <p class="muted" style="margin:2px 2px 14px">These tune your own route. Upload your list to send them to the office.</p>

    <div class="tune-row">
      <label for="tuneCommutePull">Commute pull <span id="tuneCommutePullVal" class="tune-val">70%</span></label>
      <input id="tuneCommutePull" type="range" min="0" max="100" step="5" value="70">
      <p class="muted tune-hint">Low = most meters · High = shortest drive home</p>
    </div>

    <div class="tune-row">
      <label for="tuneFinishBy">Target finish time</label>
      <input id="tuneFinishBy" type="time" value="14:00">
      <p class="muted tune-hint">Earlier = fewer stops, home sooner</p>
    </div>

    <div class="tune-readout" id="tuneReadout"></div>
    <p class="muted tune-hint">Leave-start time is set for everyone: 08:15</p>

    <button class="primary" id="tuneSave" type="button" style="width:100%;margin-top:14px">Save</button>
  </section>
```

- [ ] **Step 5: Add styles**

Append to `css/capture.css`:

```css
/* Route tuning screen */
.tune-row { margin: 16px 2px; }
.tune-row > label { display: flex; justify-content: space-between; align-items: baseline;
  font-weight: 600; margin-bottom: 8px; }
.tune-row > input[type="range"] { width: 100%; }
.tune-row > input[type="time"] { font-size: 18px; padding: 8px; }
.tune-val { font-variant-numeric: tabular-nums; color: var(--accent); }
.tune-hint { margin: 6px 0 0; }
.tune-readout { margin: 18px 2px 4px; padding: 12px 14px; border-radius: 10px;
  background: var(--card, rgba(127,127,127,.08)); line-height: 1.6; }
```

- [ ] **Step 6: Run the tests + full suite**

Run: `node --test tests/worklist-tuning.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add index.html css/capture.css tests/worklist-tuning.test.mjs
git commit -m "Route tuning: #tuning screen markup, nav entry and styles"
```

---

### Task 3: Wire the screen into routing + the nav

**Files:**
- Modify: `js/worklist.js` (import + create the handle in `initWorklist`; `#tuning` branch in `showHashScreen`; export `openTuning`)
- Modify: `js/pages/capture.js` (import `openTuning`; wire `#navTuning`)
- Test: `tests/worklist-tuning.test.mjs` (add source assertions)

**Interfaces:**
- Consumes: `initWorklistTuning()` (Task 1).
- Produces: `export function openTuning()` in `worklist.js` (pushes `#tuning` and opens the screen); `capture.js` calls it from the nav.

- [ ] **Step 1: Write the failing source assertions**

Add to `tests/worklist-tuning.test.mjs`:

```js
const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const captureJs = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');

test('worklist routes #tuning and exports an opener', () => {
  assert.match(worklistJs, /import\s*\{\s*initWorklistTuning\s*\}\s*from\s*'\.\/worklist-tuning\.js'/);
  assert.match(worklistJs, /location\.hash === '#tuning'/);
  assert.match(worklistJs, /export function openTuning\(/);
});

test('the capture nav opens the tuning screen', () => {
  assert.match(captureJs, /openTuning/);
  assert.match(captureJs, /\$\('navTuning'\)\.onclick/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worklist-tuning.test.mjs`
Expected: FAIL — the wiring doesn't exist.

- [ ] **Step 3: Import + create the handle in `worklist.js`**

Add the import near the other worklist sub-module imports (~line 18):

```js
import { initWorklistTuning } from './worklist-tuning.js';
```

Declare a module-level handle near the other screen handles (e.g. alongside `let routeView`/`addrFill` declarations — search for `let routeView`):

```js
let tuning = null;
```

In `initWorklist` (where `routeView`/`addrFill` are created), create it:

```js
  tuning = initWorklistTuning();
```

- [ ] **Step 4: Add the `#tuning` route + opener in `worklist.js`**

Add the opener (near `openWorklist`, ~line 505):

```js
export function openTuning(){
  if(location.hash !== '#tuning') history.pushState({ tuning:1 }, '', '#tuning');
  return tuning.open();
}
```

In `showHashScreen` (~line 578), handle `#tuning` first and make every other path close it. Add at the very top of the function body:

```js
  if(location.hash === '#tuning'){
    routeView.close();
    await addrFill.close();
    return tuning.open();
  }
  tuning.close();
```

(The leading `tuning.close()` runs on every non-`#tuning` popstate — including Back out of the screen — after which the existing chain shows the right screen, e.g. the final `else` restores `captureMain` via `hideScreen()`.)

- [ ] **Step 5: Wire the nav in `capture.js`**

Extend the `worklist.js` import (~line 19) to include `openTuning`:

```js
import { initWorklist, openWorklist, openTuning, markWorklistDone, planAdvance, syncWorklist, planActive } from '../worklist.js';
```

Add the nav handler next to the others (~line 1483):

```js
$('navTuning').onclick    = () => { $('navMenu').classList.add('hide'); openTuning(); };
```

- [ ] **Step 6: Run the tests + full suite**

Run: `node --test tests/worklist-tuning.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 7: Manually verify the screen drives (VERIFY.md)**

Serve the repo (`node serve.mjs .`), open `http://localhost:8731/index.html`, unregister the SW + clear caches (VERIFY.md), then: `☰ → 🎛 Route tuning` opens the screen; moving **Target finish time** changes the "~N stops/day" line; **Save** toasts; hardware/`‹ Back` returns to capture. (Metrics context needs a live spine; the finish-time math works offline from the 30-min fallback.)

- [ ] **Step 8: Commit**

```bash
git add js/worklist.js js/pages/capture.js tests/worklist-tuning.test.mjs
git commit -m "Route tuning: route #tuning + open it from the capture nav"
```

---

## After this plan

- Full suite green, then this is the point to **ship Plans 2 + 3 together**: `git push origin main`.
- After the push, run `setupSheets()` once from the Apps Script editor (pins the `finishBy` column to text — carried over from Plan 2).
- Plan 4 (start pin + drive-out road geometry) follows.

## Self-review notes

- **Spec coverage:** §6 tuning screen `#tuning`, capture-nav only (Tasks 2–3); §5 dial controls writing the Plan-2 store keys (Task 1 `save`); §7 live finish-time readout as a pure, tested function (Task 1), with commute-pull explicitly excluded and deferred.
- **No placeholder:** `expectedDailyStops` has concrete expected values (11 / 8 / null) verified against the `onSiteMinutes` model; the DOM ids in the module exactly match the markup in Task 2 and the assertions in Task 3.
- **Type consistency:** store keys `wlCommutePull`/`wlFinishBy` match Plan 2's `planShape`; `pullVal` clamps identically; `hhmmMin`/`ROUTE_DEPART_TIME`/`onSiteMinutes`/`NOMINAL_TRAVEL_MIN` are all existing exports.
- **SW:** new module added to `SHELL` + `CACHE` bumped, per the app-shell rule.
