# Route tuning — Plan 2: installer dials + weighted home bias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two installer-set route dials — **commute pull** (how hard each day curls back toward home) and **target finish time** (finish-early vs more stops) — that sync via `WorklistPlans`, are silently consumed by both the phone and the office planner, and drive a new *weighted* home bias plus per-day 14:00 sizing on the phone.

**Architecture:** Two new synced fields on the `WorklistPlans` row. The phone reads them from `localStorage` (the Plan 3 tuning screen writes them) and passes them into `optimizeRoute`; the planner hydrates them from the downloaded plan and passes them too. In `route.js`, `commutePull` scales the home node's sub-matrix edges in the per-day chunk re-solve (`orderChunkHome`/`orderChunkStartHome`) — `100` = today's full home pin, `0` = ignore home — and `finishBy` feeds the existing `dayFinishBy`/`timeCapacity` day-sizing, now also passed by the phone.

**Tech Stack:** Vanilla ES modules; Apps Script `Code.gs`; `node --test`.

## Global Constraints

- No build step; native ES modules. Full suite: `node --test "tests/*.test.mjs"` — green before any push.
- **Schema rule:** append new sheet columns at the END of the `*_HEADERS` array, never insert. `ensureTab()` only fills blank header cells by position.
- Dials are **installer-set on the phone**. The office planner **silently consumes** the synced values (no dial UI); the only route setting the office edits is the meters/day **target**.
- Dial defaults: **commutePull = 70** (0–100 integer), **finishBy = '14:00'** ('HH:MM').
- Back-compat: an absent `commutePull` must reproduce today's behavior (full home pin, weight = 1).
- `ROUTE_DEPART_TIME` (from Plan 1) is the departure clock; `hhmmMin(t)` (`js/time.js`) converts 'HH:MM' → minutes-of-day (null on bad input).
- **Deploy note:** after this ships, run `setupSheets()` once from the Apps Script editor so the new `finishBy` column is pinned to text (`@`) — otherwise Sheets coerces `"14:00"` into a time serial. `commutePull` is numeric and needs no format.

---

### Task 1: `WorklistPlans` gains `commutePull` + `finishBy` (Code.gs)

**Files:**
- Modify: `Code.gs` — `WORKLIST_PLANS_HEADERS` (~line 229), `saveWorklistPlan` (~1264), `setupSheets` number-format block (~300)
- Test: `tests/worklist-sheet-schema.test.mjs` (update the tail assertion)

**Interfaces:**
- Produces: `WorklistPlans` rows carry `commutePull` (integer 0–100 or `''`) and `finishBy` ('HH:MM' or `''`). `worklistPlanFor(h)` returns them on the row object (it already returns the whole header-keyed row), so the `worklist` GET surfaces them in `plan` with no further change.

- [ ] **Step 1: Update the schema test to expect the new tail**

In `tests/worklist-sheet-schema.test.mjs`, replace the `WORKLIST_PLANS_HEADERS` assertions inside the `'the route-variant and set-aside columns are appended, never inserted'` test (currently lines ~46–48):

```js
  const wp = headers('WORKLIST_PLANS_HEADERS');
  assert.deepEqual(wp.slice(-2), ['commutePull', 'finishBy'], 'the dial columns are the new tail');
  assert.deepEqual(wp.slice(-4, -2), ['routeVariant', 'straightDistanceSource'],
    'the variant columns keep their positions ahead of the dials');
  assert.equal(wp[wp.length - 5], 'updated', 'updated keeps its original position');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/worklist-sheet-schema.test.mjs`
Expected: FAIL — current tail is `['routeVariant', 'straightDistanceSource']`, so `slice(-2)` mismatches.

- [ ] **Step 3: Append the two columns to the header array**

In `Code.gs`, replace the `WORKLIST_PLANS_HEADERS` definition (~lines 229–230):

```js
const WORKLIST_PLANS_HEADERS = ['hNumber','routeStartDate','firstStopTime','paceMin','paceSource',
  'updated','routeVariant','straightDistanceSource','commutePull','finishBy'];
```

- [ ] **Step 4: Persist the two fields in `saveWorklistPlan`**

In `Code.gs` `saveWorklistPlan` (~1264), inside the `upsertByHeader('WorklistPlans', ...)` object, add the two fields (after `straightDistanceSource`, before `updated`):

```js
    straightDistanceSource: plan.straightDistanceSource === 'road' ? 'road'
      : (plan.straightDistanceSource ? 'straight-line' : ''),
    commutePull: (() => {
      const n = Math.round(Number(plan.commutePull));
      return isFinite(n) ? Math.max(0, Math.min(100, n)) : '';
    })(),
    finishBy: /^\d{1,2}:\d{2}$/.test(String(plan.finishBy || '')) ? String(plan.finishBy) : '',
    updated: now()
```

- [ ] **Step 5: Pin the `finishBy` column to text in `setupSheets`**

`finishBy` is the 10th column → **J**. In `Code.gs` `setupSheets`, right after the existing `WorklistPlans` format line (~300):

```js
  ss.getSheetByName('WorklistPlans').getRange('B2:C').setNumberFormat('@');
  ss.getSheetByName('WorklistPlans').getRange('J2:J').setNumberFormat('@'); // finishBy 'HH:MM' — keep as literal text
```

- [ ] **Step 6: Run the schema test + full suite**

Run: `node --test tests/worklist-sheet-schema.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Code.gs tests/worklist-sheet-schema.test.mjs
git commit -m "Route tuning: WorklistPlans carries commutePull + finishBy dials"
```

---

### Task 2: Weighted home bias in `route.js`

**Files:**
- Modify: `js/route.js` — `orderChunkHome` (~788), `orderChunkStartHome` (~799), `solveVariant` (~814), the `shape` literal (~1153), and the export list
- Test: `tests/route.test.mjs` (add cases; extend the import)

**Interfaces:**
- Consumes: `commutePull` on the `solveVariant` shape and on `optimizeRoute` opts (Tasks 3–4 pass it).
- Produces: `export function solveVariant(M, located, { startC, homeC, target, commutePull })` — `commutePull` in [0,100] (default/undefined ⇒ full home pin, weight 1); scales the home node's sub-matrix edges by `commutePull/100` in the per-day re-solve. Returns `{ orderedIds, dayOf, dayFallback }` unchanged in shape.

- [ ] **Step 1: Write the failing tests**

In `tests/route.test.mjs`, extend the import on line 3 to include `solveVariant`:

```js
import { legMetersFor, homeLegMetersFor, travelLookup, optimizeRoute, routeOrderFromMatrix, solveAnchoredPath, solveVariant, decodePolyline, osrmLegGeometry } from '../js/route.js';
```

Add these tests (after the existing `routeOrderFromMatrix` cases):

```js
// A one-day chunk of four stops on a line (s1..s4) with home far beyond s4.
// Node 0 = home; nodes 1..4 = the stops. Ending "near home" means ending at s4.
const HOME_CHUNK = matrix([
  [0, 8, 7, 6, 5],
  [8, 0, 1, 2, 3],
  [7, 1, 0, 1, 2],
  [6, 2, 1, 0, 1],
  [5, 3, 2, 1, 0]
]);
const HOME_LOCATED = [{ id:'s1' }, { id:'s2' }, { id:'s3' }, { id:'s4' }];
const homeShape = extra => ({ startC:null, homeC:{ lat:0, lng:0 }, target:4, ...extra });

test('full commute pull ends the day at the stop nearest home', () => {
  const r = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:100 }));
  assert.equal(r.orderedIds[r.orderedIds.length - 1], 's4');
});

test('zero commute pull drops the homeward endpoint constraint', () => {
  const pull0 = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:0 }));
  const pull100 = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:100 }));
  assert.notDeepEqual(pull0.orderedIds, pull100.orderedIds);
});

test('an absent commute pull reproduces the full-home-pin behavior', () => {
  const def = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape());
  const pull100 = solveVariant(HOME_CHUNK, HOME_LOCATED, homeShape({ commutePull:100 }));
  assert.deepEqual(def.orderedIds, pull100.orderedIds);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/route.test.mjs`
Expected: FAIL — `solveVariant` is not exported (import is `undefined`), so the calls throw.

> Note during execution: after Step 3 makes them run, confirm the exact `orderedIds` arrays empirically. The endpoint assertion (`s4` last at pull 100) and the back-compat equality are the load-bearing contracts; if the `notDeepEqual` at pull 0 happens to coincide, tighten the fixture (e.g. move `home` further, to `12`) until pull-0 and pull-100 differ. Do not weaken the endpoint/back-compat assertions.

- [ ] **Step 3: Implement the weighting and export**

In `js/route.js`, add a helper just above `orderChunkHome` (~line 786):

```js
// Scale one node's edges (both directions) by w in [0,1] — used to weight the
// home node in a day-cluster re-solve. w=1 leaves the matrix untouched (the full
// home pin); w=0 makes home equidistant from everything, so the solver stops
// bending the day's endpoint toward it and orders purely for production. The
// single home edge an open path actually uses is what w trades against internal
// driving, so intermediate w blends smoothly.
function withHomeWeight(S, homeNode, w){
  if(!(w < 1)) return S;
  const M = S.map(r => Float64Array.from(r));
  for(let i = 0; i < M.length; i++){
    if(i === homeNode) continue;
    M[homeNode][i] *= w; M[i][homeNode] *= w;
  }
  return M;
}
```

Replace `orderChunkHome` (~788–794) with:

```js
function orderChunkHome(D, locIdxChunk, homeWeight=1){
  if(locIdxChunk.length <= 1) return locIdxChunk.slice();
  const nodes = [0, ...locIdxChunk.map(k => k + 1)];   // home + each order's D node
  const t = solve(withHomeWeight(subMatrix(D, nodes), 0, homeWeight), true); // pinned AT home
  // reverse + drop the home node → sub-positions 1..m, mapped back to the chunk.
  return t.slice().reverse().slice(0, -1).map(p => locIdxChunk[p - 1]);
}
```

Replace `orderChunkStartHome` (~799–806) with:

```js
function orderChunkStartHome(D, locIdxChunk, homeWeight=1){
  if(locIdxChunk.length <= 1) return locIdxChunk.slice();
  const home = D.length - 1;
  const nodes = [0, ...locIdxChunk.map(k => k + 1), home];  // start + chunk + home
  const t = solveAnchoredPath(withHomeWeight(subMatrix(D, nodes), nodes.length - 1, homeWeight), { pinEnd:true });
  // drop start (first) and home (last); middle positions map back to the chunk.
  return t.slice(1, -1).map(p => locIdxChunk[p - 1]);
}
```

Replace the `solveVariant` signature line and its two `orderChunk*` calls. Change the signature (~814):

```js
export function solveVariant(M, located, { startC, homeC, target, commutePull }){
  const homeWeight = commutePull == null ? 1 : Math.max(0, Math.min(1, Number(commutePull) / 100));
  const masterSeq = routeOrderFromMatrix(M, located.length, {
    hasStart:!!startC, hasHome:!!homeC
  });
```

In the `startC && homeC` branch, change the `orderChunkStartHome` call (~828):

```js
        const ordered = orderChunkStartHome(M, masterSeq.slice(s, s + target), homeWeight);
```

In the `homeC && !startC` branch, change the `orderChunkHome` call (~836):

```js
        const ordered = orderChunkHome(M, masterSeq.slice(s, s + target), homeWeight);
```

Finally, thread `commutePull` into the `shape` literal (~1153):

```js
  const shape = { startC, homeC, target, commutePull: opts.commutePull };
```

(`solveVariant` is now `export`ed at its definition; no separate export-list edit is needed. If a bottom-of-file `export { ... }` block also lists solve helpers, leave it untouched.)

- [ ] **Step 4: Run the route tests + full suite**

Run: `node --test tests/route.test.mjs`
Expected: PASS (including the three new cases; confirm the empirical arrays per the Step 2 note).
Run: `node --test "tests/*.test.mjs"`
Expected: PASS — existing `solveVariant` callers pass `commutePull:undefined` ⇒ weight 1 ⇒ identical output.

- [ ] **Step 5: Commit**

```bash
git add js/route.js tests/route.test.mjs
git commit -m "Route tuning: commutePull weights the per-day home bias in solveVariant"
```

---

### Task 3: Phone reads the dials and feeds its optimize

**Files:**
- Modify: `js/worklist.js` — imports (~15), `planShape` (~49), `loadPlanFields` (~72), the `optimizeRoute` call + `planOpts` (~316, ~326)
- Test: `tests/route-depart.test.mjs` (extend — source assertions, consistent with the repo's markup-test idiom)

**Interfaces:**
- Consumes: `ROUTE_DEPART_TIME` (Plan 1), `hhmmMin` (`js/time.js`), `solveVariant`'s `commutePull` contract (Task 2).
- Produces: `planShape()` now also returns `commutePull` (int, default 70) and `finishBy` ('HH:MM', default '14:00'), read from `store` keys `wlCommutePull` / `wlFinishBy`. The phone's `optimizeRoute` call passes `target`, `dayFinishBy`, `departMin`, `paceMin`, `commutePull`.

- [ ] **Step 1: Write the failing test**

Add to `tests/route-depart.test.mjs`:

```js
test('the phone reads dials and feeds them into optimize', () => {
  // planShape surfaces both dials with the agreed defaults.
  assert.match(worklistJs, /commutePull:\s*pullVal\(store\.get\('wlCommutePull'\)\)/);
  assert.match(worklistJs, /finishBy:\s*store\.get\('wlFinishBy'\)\s*\|\|\s*'14:00'/);
  // the optimize call now carries the day-sizing + weight inputs.
  assert.match(worklistJs, /optimizeRoute\([^;]*\bdayFinishBy:\s*hhmmMin\(planShape\(\)\.finishBy\)/s);
  assert.match(worklistJs, /optimizeRoute\([^;]*\bcommutePull:\s*planShape\(\)\.commutePull/s);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/route-depart.test.mjs`
Expected: FAIL — none of those source patterns exist yet.

- [ ] **Step 3: Add the import and a pull clamp helper**

In `js/worklist.js`, extend the `time.js` import (~line 15) to include `hhmmMin`:

```js
import { stamp, localDate, hhmmMin } from './time.js';
```

Add a small clamp helper next to `nextWeekday` (~line 44), before `planShape`:

```js
// A commute-pull dial value clamped to the 0–100 integer range; blank/garbage
// falls back to the 70 default (the tuning screen is the only writer).
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}
```

- [ ] **Step 4: Surface both dials in `planShape` and hydrate them on download**

In `planShape` (~49), add the two fields to the returned object (after `straightDistanceSource`):

```js
    straightDistanceSource:store.get('wlStraightDistanceSource') || '',
    commutePull:pullVal(store.get('wlCommutePull')),
    finishBy:store.get('wlFinishBy') || '14:00'
```

In `loadPlanFields` (~72), after the existing `straightDistanceSource` hydration line, adopt a downloaded plan's dials into local `store`:

```js
  if(p.straightDistanceSource) store.set('wlStraightDistanceSource', p.straightDistanceSource);
  if(p.commutePull !== '' && p.commutePull != null) store.set('wlCommutePull', String(p.commutePull));
  if(p.finishBy) store.set('wlFinishBy', p.finishBy);
```

- [ ] **Step 5: Feed the dials into the phone's `optimizeRoute` and day-sizing**

In `optimizeRouteHandler` (~316), replace the `optimizeRoute` opts object:

```js
    const base = await optimizeRoute(pending, updateRouteProgress, home, {
      straightLine, startFromCurrent, compareVariants: !straightLine,
      target, dayFinishBy: hhmmMin(planShape().finishBy), departMin: hhmmMin(ROUTE_DEPART_TIME),
      paceMin: planShape().paceMin, commutePull: planShape().commutePull
    });
```

Then change `planOpts` (~326) to use the time-shrunk day target the run computed (matching the planner):

```js
    const planOpts = { ...planShape(), target: base.dayTarget || target };
```

- [ ] **Step 6: Run the tests + full suite**

Run: `node --test tests/route-depart.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add js/worklist.js tests/route-depart.test.mjs
git commit -m "Route tuning: phone optimize consumes commutePull + finishBy dials"
```

---

### Task 4: Planner silently consumes the synced dials

**Files:**
- Modify: `js/pages/planner.js` — imports (~20), `planShape` (~69), `loadPlan` (~84), the `optimizeRoute` opts (~455)
- Test: `tests/route-depart.test.mjs` (extend)

**Interfaces:**
- Consumes: the downloaded plan's `commutePull` / `finishBy` (Task 1 surfaces them via the `worklist` GET).
- Produces: the planner's `optimizeRoute` opts carry `commutePull` (from the synced dial) and `dayFinishBy` derived from the synced `finishBy`. **No dial UI is added** — the office edits only the target.

- [ ] **Step 1: Write the failing test**

Add to `tests/route-depart.test.mjs`:

```js
test('the planner silently consumes the synced dials without adding UI', () => {
  assert.match(plannerJs, /commutePull:\s*pullVal\(store\.get\('plannerCommutePull:'\s*\+\s*hNumber\(\)\)\)/);
  assert.match(plannerJs, /dayFinishBy:\s*hhmmMin\(planShape\(\)\.finishBy\)\s*\|\|\s*DAY_FINISH_MIN/);
  assert.match(plannerJs, /optimizeRoute\([^;]*\bcommutePull:\s*planShape\(\)\.commutePull/s);
  // no dial inputs leak into the office UI
  assert.doesNotMatch(plannerHtml, /id="plCommutePull"/);
  assert.doesNotMatch(plannerHtml, /id="plFinishBy"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/route-depart.test.mjs`
Expected: FAIL — the planner doesn't reference the dials yet.

- [ ] **Step 3: Add the import + pull clamp helper**

In `js/pages/planner.js`, extend the `time.js` import (~line 20) to include `hhmmMin`:

```js
import { stamp, localDate, hhmmMin } from '../time.js';
```

Add a clamp helper near `departMinutes` (~line 57):

```js
// Commute-pull dial value (synced from the installer's phone), clamped to 0–100;
// blank/garbage ⇒ the 70 default. The office never edits this — it only reads it.
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}
```

- [ ] **Step 4: Surface the dials in the planner's per-installer `planShape` + hydrate on load**

In `planShape` (~69), add the two fields (after `straightDistanceSource`), keyed per installer like the other planner settings:

```js
    straightDistanceSource:store.get('plannerStraightSource:' + hNumber()) || '',
    commutePull:pullVal(store.get('plannerCommutePull:' + hNumber())),
    finishBy:store.get('plannerFinishBy:' + hNumber()) || '14:00'
```

In `loadPlan` (~84), adopt the downloaded plan's dials into the per-installer store keys (add after the existing plan-field hydration, e.g. after the `plPace` line):

```js
  if(p.commutePull !== '' && p.commutePull != null) store.set('plannerCommutePull:' + hNumber(), String(p.commutePull));
  if(p.finishBy) store.set('plannerFinishBy:' + hNumber(), p.finishBy);
```

- [ ] **Step 5: Feed the dials into the planner's `optimizeRoute`**

In the planner optimize opts (~455–458), use the synced finish time and pass the pull:

```js
    const base = await optimizeRoute(pending, progress, home,
      { osrmUrl, geocodeUrl, osrmReady:health.osrm.online, compareVariants:true,
        start, target, dayFinishBy:hhmmMin(planShape().finishBy) || DAY_FINISH_MIN, breakMin:DAY_BREAK_MIN,
        departMin:departMinutes(planShape().firstStopTime), paceMin:planShape().paceMin,
        commutePull:planShape().commutePull });
```

- [ ] **Step 6: Run the tests + full suite**

Run: `node --test tests/route-depart.test.mjs`
Expected: PASS.
Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add js/pages/planner.js tests/route-depart.test.mjs
git commit -m "Route tuning: planner silently consumes synced commutePull + finishBy"
```

---

## After this plan

- Do **not** push until `node --test "tests/*.test.mjs"` is green.
- **Hold the push for Plan 2 until Plan 3 (the tuning screen) is ready, and ship them together.** Plan 2 changes default behavior (weighted home bias at 70, phone day-sizing to 14:00) but adds no UI to change it; Plan 3 gives installers the controls. Shipping them together avoids a window where phones have new defaults and no dial. Confirm this with the reviewer at completion.
- After deploy, run `setupSheets()` once from the editor (pins the `finishBy` column to text).

## Self-review notes

- **Spec coverage:** §5 dials (Tasks 1–4), §5A weighted home bias (Task 2), §5B finish-time day-sizing wired into the phone (Task 3), sync via `WorklistPlans` (Task 1), office silently consumes / installer-set (Task 4, no UI). §6–7 (tuning screen + live readout) are Plan 3. §4 (geometry drive-out) is Plan 4.
- **Type consistency:** `commutePull` is an integer 0–100 everywhere; `pullVal()` clamps identically in `worklist.js` and `planner.js`; `finishBy` is 'HH:MM' everywhere and converted with `hhmmMin`. `solveVariant`'s shape gains `commutePull`, threaded from `optimizeRoute` opts through the `shape` literal.
- **Back-compat:** `withHomeWeight` returns the matrix unchanged when `w >= 1`, and `commutePull == null ⇒ w = 1`, so every existing `solveVariant` path and test is byte-identical.
- **No placeholder:** the one empirical unknown (exact `orderedIds` arrays at pull 0 vs 100) is called out in Task 2 Step 2 with a concrete fixture and a concrete tightening move; the load-bearing assertions (endpoint at pull 100, back-compat equality) are deterministic.
