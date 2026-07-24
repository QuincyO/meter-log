# Route tuning — Plan 4: start pin + drive-out line Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw a distinct start-location pin and a faint drive-out line from the crew start to each day's first order — on the phone route view **and** the planner map — following the real road when we have OSRM geometry and a straight line when we don't.

**Architecture:** A new per-variant column pair `homeLegGeometry{Road,Straight}` on `Worklist`, stored on each day's first stop (parallel to `homeLegMeters*`). The desktop planner fills it in `fetchVariantGeometry`: OSRM `/route` road polyline when the server is up, else a straight two-point polyline encoded with a new `encodePolyline` (the inverse of the existing `decodePolyline`), else empty (no crew start). Both maps decode it, draw it as a separate faint dashed segment, and place a start pin at its first point. It rides the worklist sync verbatim like `legGeometry*` and is blanked on any reorder.

**Tech Stack:** Vanilla ES modules; Apps Script `Code.gs`; vendored Leaflet; `node --test`.

## Global Constraints

- No build step; native ES modules. Full suite: `node --test "tests/*.test.mjs"` — green before any push.
- **Schema rule:** append new `Worklist` columns at the END of `WORKLIST_HEADERS`; `saveWorklist` is a positional append, so add exactly one row cell per new header (guarded by `tests/worklist-sheet-schema.test.mjs`).
- **Geometry is drawn only while `variantMatchesLive` holds** (a manual drag drops it) — the same rule the between-stop `legGeometry*` already follows. The drive-out geometry is blanked on every reorder.
- The drive-out is **never** charged to any stop's distance — this plan only draws it. `homeLegMeters*` (the reference number) is unchanged.
- `homeLegGeometry` is a polyline5 string (OSRM road path, or a straight 2-point line). Empty ⇒ no crew start on file ⇒ nothing drawn.
- **Deploy note:** after this ships, run `setupSheets()` once (pins the two new geometry columns to text `@`, like `legGeometry*`). The `Worklist` header cells themselves migrate on the next upload via `ensureTab()`.

---

### Task 1: `encodePolyline` — the straight-line drive-out encoder

**Files:**
- Modify: `js/route.js` (add + export `encodePolyline`, next to `decodePolyline` ~line 487)
- Test: `tests/route.test.mjs`

**Interfaces:**
- Produces: `export function encodePolyline(points, precision = 5)` → polyline5 string; `decodePolyline(encodePolyline(pts)) ≈ pts`. Inverse of `decodePolyline`.

- [ ] **Step 1: Write the failing test**

Add to `tests/route.test.mjs` (extend the line-3 import to include `encodePolyline`):

```js
import { legMetersFor, homeLegMetersFor, travelLookup, optimizeRoute, routeOrderFromMatrix, solveAnchoredPath, solveVariant, encodePolyline, decodePolyline, osrmLegGeometry } from '../js/route.js';
```

Add these tests near the other polyline cases:

```js
test('encodePolyline matches the canonical polyline5 vector', () => {
  const pts = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
  assert.equal(encodePolyline(pts), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
});

test('encode/decode round-trips a straight two-point drive-out', () => {
  const pts = [[45.4215, -75.6972], [45.4001, -75.6500]];
  const back = decodePolyline(encodePolyline(pts));
  assert.equal(back.length, 2);
  for(let i = 0; i < 2; i++){
    assert.ok(Math.abs(back[i][0] - pts[i][0]) < 1e-5);
    assert.ok(Math.abs(back[i][1] - pts[i][1]) < 1e-5);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/route.test.mjs`
Expected: FAIL — `encodePolyline` is not exported (module load error).

- [ ] **Step 3: Implement `encodePolyline`**

In `js/route.js`, immediately after `decodePolyline` (after its closing `}` ~line 504):

```js
// Encode [[lat,lng], …] to an OSRM/Google polyline5 string — the inverse of
// decodePolyline. Used to store a straight-line drive-out (crew start → first
// stop) as geometry when OSRM has no road path, so both maps draw it the same
// way they draw a real road leg.
export function encodePolyline(points, precision = 5){
  const factor = Math.pow(10, precision);
  const chunk = num => {
    let v = num < 0 ? ~(num << 1) : (num << 1);
    let s = '';
    while(v >= 0x20){ s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  let out = '', prevLat = 0, prevLng = 0;
  for(const [lat, lng] of (points || [])){
    const la = Math.round(lat * factor), ln = Math.round(lng * factor);
    out += chunk(la - prevLat) + chunk(ln - prevLng);
    prevLat = la; prevLng = ln;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/route.test.mjs`
Expected: PASS (including the two new cases).

- [ ] **Step 5: Commit**

```bash
git add js/route.js tests/route.test.mjs
git commit -m "Route tuning: encodePolyline (inverse of decodePolyline) for straight drive-outs"
```

---

### Task 2: `homeLegGeometry` columns + sync passthrough

**Files:**
- Modify: `Code.gs` — `WORKLIST_HEADERS` (~206), `saveWorklist` row (~1211), `setupSheets` (~299)
- Modify: `js/route-variants.js` — `VARIANT_FIELDS` (~19)
- Modify: `js/worklist.js` — `wireShape` (~197) and the Download hydration (~274)
- Modify: `js/pages/planner.js` — `wireShape` (~297) and the paste/import shaper (~336)
- Test: `tests/worklist-sheet-schema.test.mjs`

**Interfaces:**
- Produces: `VARIANT_FIELDS[v].homeLegGeometry` (`'homeLegGeometryRoad'|'homeLegGeometryStraight'`). The two columns ride the sync verbatim on both clients.

- [ ] **Step 1: Update the schema test to expect the new tail**

In `tests/worklist-sheet-schema.test.mjs`, replace the `WORKLIST_HEADERS` layout assertions (the three lines under `'the route-variant and set-aside columns are appended, never inserted'`, currently checking `homeLegMetersRoad/Straight` as the tail):

```js
  const wl = headers('WORKLIST_HEADERS');
  assert.deepEqual(wl.slice(-2), ['homeLegGeometryRoad', 'homeLegGeometryStraight'],
    'the drive-out geometry columns are the new tail');
  assert.deepEqual(wl.slice(-4, -2), ['homeLegMetersRoad', 'homeLegMetersStraight']);
  assert.deepEqual(wl.slice(-13, -4), ['ignored', 'orderRoad', 'dayRoad', 'legMetersRoad',
    'orderStraight', 'dayStraight', 'legMetersStraight',
    'legGeometryRoad', 'legGeometryStraight']);
  assert.equal(wl.indexOf('scheduledWaitMin'), wl.length - 14, 'the pre-existing tail must not move');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worklist-sheet-schema.test.mjs`
Expected: FAIL — the current tail is `homeLegMetersRoad/Straight`.

- [ ] **Step 3: Append the two columns + row cells + `@` format in `Code.gs`**

`WORKLIST_HEADERS` (~217) — append after `homeLegMetersStraight`:

```js
  'homeLegMetersRoad','homeLegMetersStraight',
  // The crew-start → first-stop drive-out path per variant (OSRM road polyline,
  // or a straight two-point line when OSRM has none). Drawn faintly on both maps;
  // never in any distance total. Opaque text → setupSheets pins these to '@'.
  'homeLegGeometryRoad','homeLegGeometryStraight'];
```

`saveWorklist` row (~1232) — add two cells at the end of the `pad([...])` array, after `homeLegMetersStraight`:

```js
    numOrBlank(o.homeLegMetersRoad), numOrBlank(o.homeLegMetersStraight),
    String(o.homeLegGeometryRoad || ''), String(o.homeLegGeometryStraight || '') ]));
```

`setupSheets` (~299) — add the text-format pin for the new columns (they are columns 34–35 → **AH:AI**):

```js
  ss.getSheetByName('Worklist').getRange('AD2:AE').setNumberFormat('@'); // legGeometry road/straight (encoded polyline)
  ss.getSheetByName('Worklist').getRange('AH2:AI').setNumberFormat('@'); // homeLegGeometry road/straight (encoded polyline)
```

- [ ] **Step 4: Add `homeLegGeometry` to `VARIANT_FIELDS`**

In `js/route-variants.js` (~19):

```js
export const VARIANT_FIELDS = {
  road:     { order:'orderRoad',     day:'dayRoad',     legMeters:'legMetersRoad',     homeLegMeters:'homeLegMetersRoad',     geometry:'legGeometryRoad',     homeLegGeometry:'homeLegGeometryRoad' },
  straight: { order:'orderStraight', day:'dayStraight', legMeters:'legMetersStraight', homeLegMeters:'homeLegMetersStraight', geometry:'legGeometryStraight', homeLegGeometry:'homeLegGeometryStraight' },
```

- [ ] **Step 5: Carry the fields through the phone sync (`js/worklist.js`)**

In `wireShape` (~197), extend the geometry passthrough line:

```js
    legGeometryRoad:String(x.legGeometryRoad || ''), legGeometryStraight:String(x.legGeometryStraight || ''),
    homeLegGeometryRoad:String(x.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(x.homeLegGeometryStraight || '') };
```

In the Download hydration object (~274), extend the same way:

```js
        legGeometryRoad:String(o.legGeometryRoad || ''), legGeometryStraight:String(o.legGeometryStraight || ''),
        homeLegGeometryRoad:String(o.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(o.homeLegGeometryStraight || '') });
```

- [ ] **Step 6: Carry the fields through the planner sync (`js/pages/planner.js`)**

In `wireShape` (~297):

```js
      legGeometryRoad:String(x.legGeometryRoad || ''), legGeometryStraight:String(x.legGeometryStraight || ''),
      homeLegGeometryRoad:String(x.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(x.homeLegGeometryStraight || '') };
```

In the paste/import shaper (~336):

```js
      legGeometryRoad:String(o.legGeometryRoad || ''), legGeometryStraight:String(o.legGeometryStraight || ''),
      homeLegGeometryRoad:String(o.homeLegGeometryRoad || ''), homeLegGeometryStraight:String(o.homeLegGeometryStraight || '') })));
```

- [ ] **Step 7: Run the schema test + full suite**

Run: `node --test tests/worklist-sheet-schema.test.mjs`
Expected: PASS (row-cell count still equals header count; tail matches).
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add Code.gs js/route-variants.js js/worklist.js js/pages/planner.js tests/worklist-sheet-schema.test.mjs
git commit -m "Route tuning: homeLegGeometry columns + verbatim sync passthrough"
```

---

### Task 3: Planner fetches the drive-out geometry; reorders clear it

**Files:**
- Modify: `js/pages/planner.js` — import `encodePolyline` (~21); `fetchVariantGeometry` (~576) takes `start` and fills `homeLegGeometry`; its two call sites (~537 auto, ~615 on-demand); the reorder geometry-clear (~849)
- Modify: `js/worklist.js` — the Optimize geometry-clear (the `patch[f.geometry] = ''` line ~388)

**Interfaces:**
- Consumes: `encodePolyline` (Task 1), `VARIANT_FIELDS[v].homeLegGeometry` (Task 2), `coordsOf`/`osrmLegGeometry` (existing).
- Produces: on a fetch, each day's **first** stop gets `homeLegGeometry` = OSRM road polyline (server up), else a straight two-point line, else `''` (no start). Every reorder blanks it.

- [ ] **Step 1: Write the failing test (source assertions — the fetch/draw are browser/OSRM paths)**

Add a new file `tests/worklist-driveout.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const planner = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');
const worklist = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

test('the planner fetch fills the drive-out geometry for a day first stop', () => {
  assert.match(planner, /import\s*\{[^}]*\bencodePolyline\b[^}]*\}\s*from\s*'\.\.\/route\.js'/);
  // road path when OSRM has one, else a straight two-point line.
  assert.match(planner, /f\.homeLegGeometry\s*\]\s*=\s*road\s*\|\|\s*encodePolyline/s);
  // fetchVariantGeometry now takes the crew start.
  assert.match(planner, /async function fetchVariantGeometry\(osrmUrl,\s*start\)/);
});

test('a reorder blanks the drive-out geometry on both clients', () => {
  assert.match(planner, /homeLegGeometryRoad\s*=\s*''/);
  assert.match(worklist, /patch\[f\.homeLegGeometry\]\s*=\s*''/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worklist-driveout.test.mjs`
Expected: FAIL — none of that wiring exists.

- [ ] **Step 3: Import `encodePolyline` in the planner**

`js/pages/planner.js` line ~21 — add `encodePolyline` to the `route.js` import:

```js
import { optimizeRoute, geocodeOne, coordsOf, isParked, legMetersFor, homeLegMetersFor, travelLookup, osrmLegGeometry, encodePolyline, decodePolyline } from '../route.js';
```

- [ ] **Step 4: Fill the drive-out geometry in `fetchVariantGeometry`**

Change the signature (~576) and the first-stop branch (~593). Replace the whole `for(const x of routed){ … }` body's else-branch:

```js
async function fetchVariantGeometry(osrmUrl, start){
```

and the per-stop block:

```js
      if(prev){
        total++;
        if(prog) prog.textContent = `Fetching directions… ${total}`;
        const g = await osrmLegGeometry(prev, coordsOf(x), osrmUrl);
        if(g){ x[f.geometry] = g; fetched++; } else { x[f.geometry] = ''; missed++; }
      } else {
        x[f.geometry] = '';   // a day's first stop has no incoming between-stops leg
        // Draw the drive out from the crew start: OSRM road path when the server
        // has one, else a straight two-point line, else nothing (no crew start).
        const sc = coordsOf(start), fc = coordsOf(x);
        if(sc && fc){
          const road = await osrmLegGeometry(start, x, osrmUrl);
          x[f.homeLegGeometry] = road || encodePolyline([[sc.lat, sc.lng], [fc.lat, fc.lng]]);
        } else {
          x[f.homeLegGeometry] = '';
        }
      }
```

- [ ] **Step 5: Pass `start` at both call sites**

Auto-call after optimize (~537) — `start` is already in scope from `planAnchors`:

```js
    if(health.osrm.online && !usedFallback) await fetchVariantGeometry(osrmUrl, start);
```

On-demand `requestDirections` (~606–619) — resolve the anchors first, then pass `start`:

```js
    const health = await checkServices();
    if(!health.osrm.online){ toast('OSRM offline — start the local server (DEPLOY.md)'); return; }
    const urls = providerUrls();
    const { start } = await planAnchors(urls.geocode);
    const { fetched, missed } = await fetchVariantGeometry(urls.osrm, start);
```

- [ ] **Step 6: Blank the drive-out geometry on reorder (both clients)**

Planner reorder clear (~849) — beside the existing `legGeometry*` reset:

```js
          item.legGeometryRoad = ''; item.legGeometryStraight = '';
          item.homeLegGeometryRoad = ''; item.homeLegGeometryStraight = '';
```

Phone Optimize clear in `js/worklist.js` (the `patch[f.geometry] = '';` line ~388) — add right after it:

```js
        patch[f.geometry] = '';
        patch[f.homeLegGeometry] = '';
```

- [ ] **Step 7: Run the tests + full suite**

Run: `node --test tests/worklist-driveout.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add js/pages/planner.js js/worklist.js tests/worklist-driveout.test.mjs
git commit -m "Route tuning: planner fills drive-out geometry; reorders blank it"
```

---

### Task 4: Draw the start pin + faint drive-out line (both maps)

**Files:**
- Modify: `js/worklist-route-view.js` — `buildRouteMapModel` (~77) returns `driveOut`/`start`; the renderer (~206–226) passes `homeGeomField` and draws them
- Modify: `js/pages/planner.js` — `renderMap` (~894–925) draws the drive-out + start pin
- Modify: `css/capture.css` — a start-pin style
- Test: `tests/worklist-route-view.test.mjs`

**Interfaces:**
- Consumes: `VARIANT_FIELDS[v].homeLegGeometry`, `decodePolyline`.
- Produces: `buildRouteMapModel(items, geomField, homeGeomField)` → `{ markers, line, path, missing, parked, driveOut, start }`. `driveOut` is the decoded crew-start→first-stop polyline (`[]` when none); `start` is its first `[lat,lng]` or `null`. `path` is unchanged (still starts at the first stop) — the drive-out is a separate faint segment.

- [ ] **Step 1: Write the failing test**

Add to `tests/worklist-route-view.test.mjs` (extend its import to include `encodePolyline` from `../js/route.js` if not present):

```js
import { encodePolyline } from '../js/route.js';
import { VARIANT_FIELDS } from '../js/route-variants.js';

test('a first stop with drive-out geometry yields a separate faint segment + start', () => {
  const homeField = VARIANT_FIELDS.road.homeLegGeometry;   // 'homeLegGeometryRoad'
  const first = { id:'a', lat:45.40, lng:-75.65,
    [homeField]: encodePolyline([[45.42, -75.70], [45.40, -75.65]]) };
  const second = { id:'b', lat:45.39, lng:-75.60 };
  const model = buildRouteMapModel([first, second], null, homeField);
  assert.equal(model.driveOut.length, 2);
  assert.deepEqual(model.start.map(n => Math.round(n * 100) / 100), [45.42, -75.70]);
  // path still begins at the first stop, not the crew start.
  assert.deepEqual(model.path[0].map(n => Math.round(n * 100) / 100), [45.40, -75.65]);
});

test('no drive-out geometry means no start and an empty driveOut', () => {
  const model = buildRouteMapModel([{ id:'a', lat:45.4, lng:-75.6 }], null, 'homeLegGeometryRoad');
  assert.equal(model.start, null);
  assert.deepEqual(model.driveOut, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/worklist-route-view.test.mjs`
Expected: FAIL — `buildRouteMapModel` ignores the 3rd arg and returns no `driveOut`/`start`.

- [ ] **Step 3: Extend `buildRouteMapModel`**

In `js/worklist-route-view.js`, replace the function (~77–103):

```js
export function buildRouteMapModel(items, geomField, homeGeomField){
  const markers = [];
  const line = [];
  const path = [];
  let driveOut = [];    // crew-start → first-stop path, drawn faintly & separately
  let missing = 0;
  let parked = 0;
  let prev = null;
  (items || []).forEach((item, index) => {
    const c = coordsOf(item);
    if(!c){ missing++; return; }
    const stopped = isParked(item);
    if(stopped){ parked++; }
    else {
      line.push([c.lat, c.lng]);
      if(prev == null){
        path.push([c.lat, c.lng]);
        // The day's first stop may carry a saved drive-out from the crew start —
        // decode it as its own faint segment (its first point is the start pin).
        const home = homeGeomField ? decodePolyline(item[homeGeomField]) : [];
        if(home.length) driveOut = home;
      } else {
        const leg = geomField ? decodePolyline(item[geomField]) : [];
        if(leg.length) path.push(...leg);
        else path.push([prev.lat, prev.lng], [c.lat, c.lng]);
      }
      prev = c;
    }
    markers.push({ item, position:index + 1, parked:stopped, point:[c.lat, c.lng] });
  });
  const start = driveOut.length ? driveOut[0] : null;
  return { markers, line, path, missing, parked, driveOut, start };
}
```

- [ ] **Step 4: Draw it in the phone renderer**

In `js/worklist-route-view.js`, where `geomField` is computed (~206) add the home field and pass it:

```js
    const geomField = variantMatchesLive(snapshot, variant)
      ? (VARIANT_FIELDS[variant] || VARIANT_FIELDS.road).geometry : null;
    const homeGeomField = variantMatchesLive(snapshot, variant)
      ? (VARIANT_FIELDS[variant] || VARIANT_FIELDS.road).homeLegGeometry : null;
    const model = buildRouteMapModel(group ? group.items : [], geomField, homeGeomField);
```

After the between-stops polyline is drawn (~226, after the `L.polyline(route, …)` line), add the faint drive-out + the start pin:

```js
    if(route.length > 1) L.polyline(route, { color, weight:4, opacity:.78 }).addTo(layer);
    if(model.driveOut.length > 1)
      L.polyline(model.driveOut, { color, weight:3, opacity:.35, dashArray:'6 6' }).addTo(layer);
    if(model.start){
      bounds.push(model.start);
      L.marker(model.start, { icon:L.divIcon({ className:'wl-route-pin wl-route-start',
        html:'<span>▶</span>', iconSize:[26,26], iconAnchor:[13,13] }) })
        .bindTooltip('Start — drive out to the first stop').addTo(layer);
    }
```

- [ ] **Step 5: Draw it on the planner map**

In `js/pages/planner.js` `renderMap` (~894), add the home geometry field beside `geomField`:

```js
  const geomField = variantMatchesLive(items, activeVariant())
    ? VARIANT_FIELDS[activeVariant()].geometry : null;
  const homeGeomField = variantMatchesLive(items, activeVariant())
    ? VARIANT_FIELDS[activeVariant()].homeLegGeometry : null;
```

Add a `driveOuts` collector before the `pendingItems().forEach` (~896):

```js
  const prevByDay = {};      // last routed coord seen per day (nothing before the first)
  const driveOuts = [];      // faint crew-start → first-stop segments + start point
```

In the routed branch, when it's the day's first stop (`!prev`), decode the drive-out (~904–909):

```js
    if(!parked){                                  // polyline + numbering: routed only
      const prev = prevByDay[day];
      if(!prev && homeGeomField){
        const home = decodePolyline(item[homeGeomField]);
        if(home.length) driveOuts.push(home);
      }
      const leg = decodePolyline(item[geomField]);
      const pts = leg.length ? leg
        : (prev ? [[prev.lat, prev.lng], [c.lat, c.lng]] : [[c.lat, c.lng]]);
      (segs[day] = segs[day] || []).push(...pts);
      prevByDay[day] = c;
    }
```

After the per-day segment polylines are drawn (~925, after the `Object.keys(segs).forEach` block), draw the faint drive-outs + one start marker:

```js
  driveOuts.forEach(seg => {
    if(seg.length > 1) L.polyline(seg, { weight:3, opacity:.35, dashArray:'6 6', color:'#64748b' }).addTo(mapLayer);
  });
  if(driveOuts.length){
    const s = driveOuts[0][0];
    L.marker(s, { icon:L.divIcon({ className:'plpin plpin-start', html:'<span>▶</span>',
      iconSize:[24,24], iconAnchor:[12,12] }) }).bindTooltip('Crew start').addTo(mapLayer);
    all.push(s);
  }
```

- [ ] **Step 6: Style the start pin**

Append to `css/capture.css`:

```css
/* Route drive-out start pin */
.wl-route-pin.wl-route-start { background: #475569; color: #fff; }
```

(The planner's `.plpin-start` reuses the existing `.plpin` base — add a matching rule to `css/planner.css`:)

```css
.plpin.plpin-start { background: #475569; }
```

- [ ] **Step 7: Run the tests + full suite**

Run: `node --test tests/worklist-route-view.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 8: Manually verify (VERIFY.md + planner)**

With the local OSRM up (DEPLOY.md), open `planner.html`, pick an installer whose team has a start address, Optimize on the road matrix, and confirm: a `▶` crew-start pin + a faint dashed line into each day's first stop; drag a first stop and confirm the dashed line disappears (stale geometry dropped). Download to the phone, open the route map, confirm the same pin + faint line; with OSRM off, re-Optimize and confirm the drive-out falls back to a straight dashed line (not absent, unless the team has no start).

- [ ] **Step 9: Commit**

```bash
git add js/worklist-route-view.js js/pages/planner.js css/capture.css css/planner.css tests/worklist-route-view.test.mjs
git commit -m "Route tuning: draw the crew-start pin + faint drive-out line on both maps"
```

---

## After this plan

- Full suite green, then `git push origin main`.
- Run `setupSheets()` once from the editor (pins the two new geometry columns to `@`).
- Update **AGENTS.md / ARCHITECTURE.md**: the "no drive-out line" rule now has an exception — the crew-start drive-out is drawn (faint, dashed) from `homeLegGeometry*`, road when OSRM has it and straight otherwise. (Do this as a final docs commit; several assertions in `tests/*` read those files, so keep the phrasing consistent.)

## Self-review notes

- **Spec coverage:** §4 start pin + drive-out line on both maps (Task 4), road geometry when available / straight fallback (Task 3 fetch + Task 1 encoder), synced verbatim (Task 2). The drive-out is drawn but never added to any distance total (unchanged `homeLegMeters*`).
- **No placeholder:** the encoder is verified against the canonical polyline5 vector; `buildRouteMapModel` has concrete expected `driveOut`/`start`/`path` values; the fetch/draw browser paths are covered by source assertions + a manual VERIFY step, consistent with how the existing `legGeometry*` paths are tested.
- **Type consistency:** `homeLegGeometry` field names match across `VARIANT_FIELDS`, `Code.gs`, both `wireShape`s, and both renderers; `encodePolyline`/`decodePolyline` are exact inverses; the drive-out is gated by `variantMatchesLive` exactly like `legGeometry*`.
- **Back-compat:** `buildRouteMapModel`'s 3rd arg defaults to `undefined` ⇒ no `driveOut`/`start` ⇒ existing 2-arg callers and tests are unchanged.
