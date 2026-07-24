# Route tuning — Plan 1: departure constant + dead-field removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the inert "Route starts" / "First stop at" inputs from the phone worklist, and anchor every ETA to a single org-wide departure time set in `js/config.js`.

**Architecture:** The ETA model in `js/route-constraints.js` already computes the first stop's arrival as `departure-clock + drive-out`. We stop feeding it a UI field and feed it a new constant `ROUTE_DEPART_TIME` instead; the phone derives the (now hidden) route start date as the next weekday. The desktop planner points its own departure base at the same constant.

**Tech Stack:** Vanilla ES modules, no build step. Tests are `node --test` over pure modules plus `readFileSync` assertions on HTML/JS source. Deploy = commit + push to `main` (GitHub Pages + Apps Script CI).

## Global Constraints

- No build step, no framework, no package manager — native ES modules loaded as-is.
- Full suite command: `node --test "tests/*.test.mjs"`. Must be green before any push.
- A push to `main` is a production deploy. Commit per task; push only when the plan is complete and green.
- Schema rule (not exercised in this plan, but do not violate): never remove or reorder existing sheet columns. This plan removes only HTML inputs and JS, never sheet columns.
- The departure time is **global**, stored once in `js/config.js` — never a per-installer field.
- Departure value for this plan: **`'08:15'`**.

---

### Task 1: Add the org-wide departure constant

**Files:**
- Modify: `js/config.js` (append one export)
- Test: `tests/route-depart.test.mjs` (create)

**Interfaces:**
- Produces: `export const ROUTE_DEPART_TIME` (string `'HH:MM'`, value `'08:15'`), imported by `js/worklist.js` and `js/pages/planner.js` in later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/route-depart.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_DEPART_TIME } from '../js/config.js';

test('config exposes the org-wide departure time', () => {
  assert.equal(ROUTE_DEPART_TIME, '08:15');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/route-depart.test.mjs`
Expected: FAIL — `ROUTE_DEPART_TIME` is `undefined`, so the equality assertion fails.

- [ ] **Step 3: Add the constant**

Append to `js/config.js` (after the `ORS_API_KEY` export, at end of file):

```js

// When the crew leaves the start location each morning ('HH:MM', 24h). Global,
// not per-installer: the ETA model anchors the first stop to this clock plus the
// real drive out to it. Change it with a commit — GitHub Pages ships it. The
// desktop planner still clamps it into its [08:00, 08:30] muster window.
export const ROUTE_DEPART_TIME = '08:15';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/route-depart.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add js/config.js tests/route-depart.test.mjs
git commit -m "Route tuning: add org-wide ROUTE_DEPART_TIME constant"
```

---

### Task 2: Anchor the phone worklist ETAs to the constant; remove its two inputs

**Files:**
- Modify: `index.html` (delete two `<label>` inputs in `.wl-schedule-settings`, ~lines 189–190)
- Modify: `js/worklist.js` (import the constant; rewrite `planShape`/`savePlanLocal`/`loadPlanFields`; drop two `onchange` handlers)
- Test: `tests/route-depart.test.mjs` (extend), `tests/route-constraints.test.mjs` (extend)

**Interfaces:**
- Consumes: `ROUTE_DEPART_TIME` from Task 1.
- Produces: `planShape()` returns `{ routeStartDate, firstStopTime, paceMin, paceSource, routeVariant, straightDistanceSource }` where `firstStopTime === ROUTE_DEPART_TIME` and `routeStartDate === nextWeekday(localDate())`. Same shape as before, so all existing callers (`optimizeRouteHandler`, `savePlanLocal`, sheet upload) are unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `tests/route-depart.test.mjs`:

```js
import { readFileSync } from 'node:fs';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('the phone worklist no longer renders the route-start / first-stop inputs', () => {
  assert.doesNotMatch(indexHtml, /id="wlRouteDate"/);
  assert.doesNotMatch(indexHtml, /id="wlRouteTime"/);
});

test('the phone plan anchors first-stop time to the departure constant', () => {
  assert.match(worklistJs, /import\s*\{[^}]*\bROUTE_DEPART_TIME\b[^}]*\}\s*from\s*'\.\/config\.js'/);
  assert.match(worklistJs, /firstStopTime:\s*ROUTE_DEPART_TIME/);
  assert.doesNotMatch(worklistJs, /\$\('wlRouteDate'\)/);
  assert.doesNotMatch(worklistJs, /\$\('wlRouteTime'\)/);
});
```

Add to `tests/route-constraints.test.mjs` (pins the ETA-anchoring contract the constant feeds):

```js
test('first-stop ETA is the departure clock plus the drive out from the start', () => {
  const items = [item('a'), item('b')];
  const travel = { fromStart:() => 17, between:() => 12 };
  const r = scheduleRouteConstraints(items, ['a','b'], opts({ firstStopTime:'08:15', travel }));
  assert.equal(r.scheduleById.a.eta, '08:32'); // 08:15 + 17 min drive out
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/route-depart.test.mjs`
Expected: FAIL — `index.html` still contains `id="wlRouteDate"`/`id="wlRouteTime"`, and `js/worklist.js` still reads `$('wlRouteDate')`.

Run: `node --test tests/route-constraints.test.mjs`
Expected: PASS immediately — this is a characterization test that pins the existing travel-model anchoring (the model already does `departClock + fromStart`). If it does not pass, the anchoring is wrong and must be fixed before proceeding.

- [ ] **Step 3: Remove the two inputs from `index.html`**

In the `.wl-schedule-settings` block, delete these two lines (keep the `Pace (min/stop)` label):

```html
      <label>Route starts<input id="wlRouteDate" type="date"></label>
      <label>First stop at<input id="wlRouteTime" type="time"></label>
```

The block becomes:

```html
    <div class="wl-schedule-settings">
      <label>Pace (min/stop)<input id="wlPace" type="number" min="1" step="1" inputmode="numeric"></label>
    </div>
```

- [ ] **Step 4: Rewrite the plan helpers in `js/worklist.js`**

Add the import to the existing config-less import block (top of file, near the other `./` imports):

```js
import { ROUTE_DEPART_TIME } from './config.js';
```

Replace `planShape` (currently ~lines 49–58) with:

```js
function planShape(){
  return {
    routeStartDate:nextWeekday(localDate()),
    firstStopTime:ROUTE_DEPART_TIME,
    paceMin:Math.max(1, Math.round(Number($('wlPace').value) || 30)),
    paceSource:store.get('wlPaceSource') || 'fallback',
    routeVariant:activeVariant(),
    straightDistanceSource:store.get('wlStraightDistanceSource') || ''
  };
}
```

Replace `savePlanLocal` (currently ~lines 66–71) with (drops the two removed `store` writes):

```js
function savePlanLocal(){
  const p = planShape();
  store.set('wlPaceMin', String(p.paceMin));
  return p;
}
```

Replace `loadPlanFields` (currently ~lines 72–81) with (drops the two removed field assignments):

```js
function loadPlanFields(plan){
  const p = plan || {};
  $('wlPace').value = String(Math.max(1, Number(p.paceMin || store.get('wlPaceMin')) || 30));
  store.set('wlPaceSource', p.paceSource || store.get('wlPaceSource') || 'fallback');
  if(p.routeVariant) store.set('wlRouteVariant', p.routeVariant === 'straight' ? 'straight' : 'road');
  if(p.straightDistanceSource) store.set('wlStraightDistanceSource', p.straightDistanceSource);
  savePlanLocal();
}
```

Remove the two now-dangling `onchange` handlers in `initWorklist` (currently ~lines 1327–1328):

```js
  $('wlRouteDate').onchange = savePlanLocal;
  $('wlRouteTime').onchange = savePlanLocal;
```

Delete both lines. Leave the surrounding `loadPlanFields();` (line 1326) and the `$('wlPace').onchange` handler (1329–1333) intact.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/route-depart.test.mjs tests/route-constraints.test.mjs`
Expected: PASS (all).

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS — 155 existing + the new assertions.

- [ ] **Step 7: Commit**

```bash
git add index.html js/worklist.js tests/route-depart.test.mjs tests/route-constraints.test.mjs
git commit -m "Route tuning: drop dead worklist date/time fields, anchor ETA to ROUTE_DEPART_TIME"
```

---

### Task 3: Point the desktop planner's departure base at the constant

**Files:**
- Modify: `planner.html` (delete the `plRouteTime` `<label>`, ~line 47; keep `plRouteDate`)
- Modify: `js/pages/planner.js` (import the constant; `planShape` first-stop from constant; drop the `plRouteTime` load)
- Test: `tests/route-depart.test.mjs` (extend)

**Interfaces:**
- Consumes: `ROUTE_DEPART_TIME` from Task 1.
- Produces: the planner's `planShape().firstStopTime === ROUTE_DEPART_TIME`; `departMinutes()` still clamps it into `[08:00, 08:30]`, so the office sees the same 08:15 anchor as the phone.

- [ ] **Step 1: Write the failing test**

Add to `tests/route-depart.test.mjs`:

```js
const plannerJs = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');
const plannerHtml = readFileSync(new URL('../planner.html', import.meta.url), 'utf8');

test('the planner drops its first-stop input and uses the departure constant', () => {
  assert.doesNotMatch(plannerHtml, /id="plRouteTime"/);
  assert.match(plannerHtml, /id="plRouteDate"/); // the office still picks a start date
  assert.match(plannerJs, /import\s*\{[^}]*\bROUTE_DEPART_TIME\b[^}]*\}\s*from\s*'\.\.\/config\.js'/);
  assert.match(plannerJs, /firstStopTime:\s*ROUTE_DEPART_TIME/);
  assert.doesNotMatch(plannerJs, /\$\('plRouteTime'\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/route-depart.test.mjs`
Expected: FAIL — `planner.html` still has `id="plRouteTime"` and `planner.js` still reads `$('plRouteTime')`.

- [ ] **Step 3: Remove the `plRouteTime` input from `planner.html`**

Delete this line (~47):

```html
          <label for="plRouteTime">First stop at<input id="plRouteTime" type="time" value="08:00"></label>
```

Leave the `plRouteDate` label (~46) in place.

- [ ] **Step 4: Wire the planner to the constant**

Add the import near the top of `js/pages/planner.js` (with the other `../` imports, ~lines 16–22):

```js
import { ROUTE_DEPART_TIME } from '../config.js';
```

In `planShape` (~lines 69–73), change the first-stop line:

```js
    firstStopTime:ROUTE_DEPART_TIME,
```

(Leave `routeStartDate:$('plRouteDate').value || nextWeekday(localDate())` unchanged.)

In `loadPlanFields` (~lines 86–87), delete the `plRouteTime` assignment line:

```js
  $('plRouteTime').value = p.firstStopTime || '08:00';
```

(Keep the `$('plRouteDate').value = ...` line.)

- [ ] **Step 5: Verify no other `plRouteTime` references remain**

Run: `grep -n "plRouteTime" js/pages/planner.js planner.html`
Expected: no output (all references removed). If any remain (e.g. an `onchange`), delete them too.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/route-depart.test.mjs`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `node --test "tests/*.test.mjs"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add planner.html js/pages/planner.js tests/route-depart.test.mjs
git commit -m "Route tuning: planner departure base uses ROUTE_DEPART_TIME"
```

---

## After this plan

Do **not** push until you have run `node --test "tests/*.test.mjs"` and it is green (a push to `main` is a production deploy). Push is deferred to the end of the four-plan sequence unless the reviewer says otherwise.

Plans 2–4 (dials + `WorklistPlans` sync + weighted home bias; tuning screen + live readout; start pin + drive-out geometry) will be written next, each against the code as it stands after the prior plan lands.

## Self-review notes

- **Spec coverage:** §1 field removal (Tasks 2–3), §2 ETA anchoring (Task 2 constraints test + wiring), §3 `config.js` constant (Task 1). §4–7 are out of scope for Plan 1 by design.
- **No sheet-column change** here — `WorklistPlans` still receives `routeStartDate`/`firstStopTime` from the derived `planShape`, so `Code.gs` is untouched and old readers keep working.
- **Type consistency:** `planShape()` keeps its exact return shape; only two field *values* become derived. `ROUTE_DEPART_TIME` name is identical across `config.js`, `worklist.js`, `planner.js`.
