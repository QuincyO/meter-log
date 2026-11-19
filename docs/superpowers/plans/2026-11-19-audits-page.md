# Audits Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Audits page that shows, for one installer, where the day goes, the logged delays and the unlogged pause time, over a period and for a single day, for the office (`audits.html`) and for the installer themselves (`my-audit.html`).

**Architecture:** One new token-only spine read (`audit`) returns one installer's logs, `Downtime` rows and `Days` bookends for all dates. Every number is computed in the browser by a pure module (`js/compute/audit.js`), so range, mode and day changes need no second request. Two thin page entries share one view module; the office entry alone fetches drive logs, through the existing admin-gated read.

**Tech Stack:** Static HTML + native ES modules + plain CSS, no build step. Apps Script (`Code.gs`). Vendored Leaflet. `node --test` for tests. Charts are HTML/SVG strings.

**Spec:** `docs/superpowers/specs/2026-11-19-audits-page-design.md` — read it first. `AGENTS.md` is the repo's rule book and wins over this plan.

## Global Constraints

- **Never edit `sw.js`.** No new file goes in `SHELL`; `CACHE` is never bumped.
- **No personal figures in the repo.** Tests use made-up data and the installer name `Pat Example`. The reference check (Task 4) lives and runs outside the repo.
- **Never write to the production sheet.** The page makes no POST at all.
- The words "drive back" and "return to the yard" appear nowhere in the new files.
- Labels, exactly: "Drive to the first order", "Close-out and drive home", "Unlogged pauses (breaks included)", "Before the first meter, not logged".
- Values, exactly: shift start 07:30 (450 min); default end 16:00 (960); statistics use days with 8+ orders; pause threshold 10 min; long-gap flag 45 min; break allowance 60 min; baseline 30 worked days; a distance kind with fewer than 5 gaps uses the all-gap median; kind bounds in km `[0.06, 0.5, 1, 2, 5, 10, Infinity]`.
- Land or boat is decided by `workTypeOn(date, installer)` from `js/compute/installer-lifetime.js`. A row's `workType` tag is never read. `Downtime` rows are never filtered by mode.
- Timestamps may have a one-digit hour. Parse with `\d{1,2}`; never slice or string-compare them.
- Skew rule: new modules import long-standing exports by name; anything added to a `SHELL` module after 2026-10-01 is reached through `import * as x` plus a `typeof` check. `capture.js` gains no binding for a new id.
- `driveTracks` and `downtime` stay in `ADMIN_GET`. No file under `js/` other than `js/pages/audits.js` may contain `apiGet('driveTracks'` (`tests/admin-gate.test.mjs` scans for it).
- Commits go on `main` locally. Each commit that changes behaviour carries its lines in `changelog/2026-11-19.md` (use the real date of the commit; create the page from the shape of `changelog/2026-11-18.md`) and the `CHANGELOG.md` row. **Push once, in Task 9**, after the full suite and the headless check pass. A push to `main` is a production deploy.
- Run `node --test "tests/*.test.mjs"` before every commit. `python` on this machine hangs; use node.

## Review Focus

Inputs the spec implies but does not spell out. Each has a test in the task named.

1. An installer with no logs at all, or none in the chosen mode: the page shows an empty state, never an exception or `NaN` (Task 2, Task 3).
2. A day with a single log: it opens, with no gaps, no pause and a timeline of three blocks (Task 3).
3. A `Downtime` row whose gap note matches no gap (a stop was removed since): it counts in the category totals by where it falls and takes nothing off any pause (Task 2).
4. A range with `from` after `to`, or with no day of 8+ orders: statistics are `null`, the day list is still correct, and the view says how many days the figures rest on (Task 3).
5. A `Days` row whose `returned` is blank or unreadable, and a day with no `Days` row: both use 16:00 and report `closed: false` (Task 2).

---

### Task 1: The `audit` read on the spine

**Files:**
- Modify: `Code.gs` (new `auditRead` beside `driveTracksRead` near line 2710; one line in `doGet` beside the `driveTracks` line)
- Modify: `tests/admin-gate.test.mjs`
- Create: `tests/audit-read.test.mjs`

**Interfaces:**
- Produces: `GET ?action=audit&installer=<name>` →
  `{ ok:true, installer, stops:[{id,timestamp,status,workOrderId,address,lat,lng}], downtime:[{id,timestamp,category,minutes,workOrderId,note}], days:[{date,departure,returned}] }`.
  `lat`/`lng` are numbers or `null`. `days[].date` is `yyyy-MM-dd`; `departure`/`returned` are `HH:mm` or `''`. A blank installer → `{ ok:false, error:'installer required' }`.

- [ ] **Step 1: Write the failing tests** in `tests/audit-read.test.mjs`, evaluating the real `Code.gs` the way `tests/installer-day-shape.test.mjs` does (its `spine(tables)` harness, returning `{ auditRead }`).

```js
test('auditRead returns one installer\'s printable logs, delays and bookends', () => {
  const { auditRead } = spine({
    Stops: [
      { id:'a', timestamp:'2026-09-01 9:05:00', installer:'Pat Example', status:'INSTALLED', workOrderId:'900001', address:'1 Main St', lat:44.1, lng:-79.1, workType:'land' },
      { id:'b', timestamp:'2026-09-01 09:20:00', installer:'Pat Example ', status:'DONE', lat:44.1, lng:-79.1 },
      { id:'c', timestamp:'2026-09-01 09:30:00', installer:'Pat Example', status:'UTI', workOrderId:'900002', lat:'', lng:'' },
      { id:'d', timestamp:'2026-09-01 09:40:00', installer:'Sam Other', status:'INSTALLED', lat:44.2, lng:-79.2 },
    ],
    Downtime: [
      { id:'x', timestamp:'2026-09-01 16:00:00', installer:'Pat Example', category:'WAREHOUSE', minutes:20, workOrderId:'', note:'gap 09:05–09:30', workType:'' },
      { id:'y', timestamp:'2026-09-01 16:00:00', installer:'Sam Other', category:'DISPATCH', minutes:30, note:'' },
    ],
    Days: [
      { date:'2026-09-01', installer:'Pat Example', departure:'07:30', returned:'16:00' },
      { date:'2026-09-01', installer:'Sam Other', departure:'07:30', returned:'17:00' },
    ],
  });
  const r = auditRead('Pat Example');
  assert.equal(r.ok, true);
  assert.deepEqual(r.stops.map(s => s.id), ['a', 'c']);            // DONE and other installers dropped
  assert.deepEqual([r.stops[1].lat, r.stops[1].lng], [null, null]);
  assert.deepEqual(Object.keys(r.stops[0]).sort(), ['address','id','lat','lng','status','timestamp','workOrderId']);
  assert.deepEqual(r.downtime.map(d => d.id), ['x']);              // blank workType kept
  assert.deepEqual(r.days, [{ date:'2026-09-01', departure:'07:30', returned:'16:00' }]);
});
test('auditRead refuses a blank installer', () => {
  const { auditRead } = spine({});
  assert.deepEqual(auditRead('  '), { ok:false, error:'installer required' });
});
test('auditRead tolerates a sheet with no Days tab', () => {
  const { auditRead } = spine({ Stops: [] });
  assert.deepEqual(auditRead('Pat Example').days, []);
});
```

The harness's `Utilities.formatDate` throws, so `dateOf` and `clockHHMM` must be fed plain strings, as above.

Add to `tests/admin-gate.test.mjs`:

```js
test('the audit read is token-only for a named installer and never crew-wide', () => {
  const { getNeedsAdmin } = harness('k');
  assert.equal(getNeedsAdmin({ action: 'audit', installer: 'Pat Example' }), false);
  assert.ok(!ADMIN_GET.audit, 'audit must not be in ADMIN_GET: the phone calls it');
  assert.match(fnSrc('auditRead'), /installer required/);
  assert.match(fnSrc('doGet'), /p\.action === 'audit'\)\s*return json\(auditRead\(p\.installer\)\)/);
});
```

- [ ] **Step 2: Run** `node --test tests/audit-read.test.mjs tests/admin-gate.test.mjs` — expected: FAIL, `auditRead is not defined` / `function auditRead not found`.

- [ ] **Step 3: Implement `auditRead(installer)` in `Code.gs`** and its `doGet` line. Match names with `sameName`; keep statuses `INSTALLED`, `UTI`, `VISITED`, `UNACCOUNTED` (case-insensitive); dates through `dateOf`, clocks through `clockHHMM`; guard a missing `Days` tab the way `dayMeta` does. Do not filter `Downtime` by `workType`. A doc comment states the owner's decision (2026-11-18): a named installer's logged delays and close-out times are readable with the public token, as their stops already are; drive logs are not.

- [ ] **Step 4: Run** the two test files — expected: PASS. Then the full suite.

- [ ] **Step 5: Commit** `Code.gs`, both tests, the changelog page and row. Message: `A read that returns one installer's logs, delays and day times`.

---

### Task 2: `js/compute/audit.js` — days, gaps, pauses, delays

**Files:**
- Create: `js/compute/audit.js`
- Create: `tests/audit-compute.test.mjs`

**Interfaces:**
- Consumes: the `audit` read's `{ stops, downtime, days }`; `workTypeOn` (namespace import + `typeof` check; if missing, treat every date as `land`); `gapNoteTimes` from `./gaps.js`; `CAT_LABEL` from `./categories.js`.
- Produces:

```js
export const AUDIT = { SHIFT_START_MIN:450, DEFAULT_END_MIN:960, MIN_ORDERS:8, PAUSE_OVER_MIN:10,
  FLAG_MIN:45, BREAK_ALLOWANCE_MIN:60, BASELINE_DAYS:30, MIN_KIND_GAPS:5,
  KIND_KM:[0.06,0.5,1,2,5,10,Infinity],
  KIND_LABELS:['Next door (under 60 m)','60 m to 0.5 km','0.5 to 1 km','1 to 2 km','2 to 5 km','5 to 10 km','Over 10 km'],
  PAUSE_BINS:[[0,15],[15,30],[30,45],[45,60],[60,75],[75,90],[90,105],[105,120],[120,150],[150,Infinity]] };
export function pct(list, p)            // sorted[min(n-1, floor(n*p))]; null when empty
export function mean(list)              // null when empty
export function prepareAudit(raw, { installer, mode })   // mode: 'land' | 'boat' | 'all'
```

`prepareAudit` returns `{ installer, mode, days: DayRec[] (oldest first), usual: number[7], usualAny, kindCounts: number[7], gapsCount, orders, status:{installed,uti,other}, unpinned, skippedOtherMode }`.

`DayRec`:

```
{ date, n, qualifies, startMin, endMin, endSource:'closeout'|'default'|'lastMeter', closed, pastEnd,
  firstMin, lastMin, spanMin,
  logs:  [{ id, min, clock:'HH:MM', workOrderId, status, address, lat, lng, pin }],
  gaps:  [{ i, atMin, min, km, kind, usual, over, isPause, loggedMin, unloggedMin, flagged }],
  workMin, pauseAllMin, pauseUnMin, pauseLoggedMin, pauses, longestMin, longestAtMin, flags,
  log:   { before, between, after, untimed, total, dispatchBefore, otherBefore, breaks, travel },
  delays:[{ category, label, minutes, where:'before'|'between'|'after'|'untimed', fromMin, toMin, driveToFirst }],
  beforeUnloggedMin, closeoutMin }
```

Rules the tests do not fully determine:
- `min` is minutes after midnight with the seconds as a fraction. `gaps[i]` runs from `logs[i]` to `logs[i+1]`; `atMin` is its start.
- `pin` is false when `lat`/`lng` is `null`, non-finite or `0`. `km` is `null` unless both ends are pinned; then `kind` is `-1` and `usual` is `usualAny`.
- `usual[k]` is `pct(gaps of kind k, .5)` over **every day in the mode**, or `usualAny` when the kind has fewer than `MIN_KIND_GAPS` gaps.
- `over = min − usual`. `isPause` when `over >= 10`. `loggedMin` is the sum of deductible `Downtime` minutes keyed `date|floor(from.min)|floor(to.min)`, where the row's key comes from `gapNoteTimes(note)`. Not deductible: `BREAK`, `LUNCH`, `MISC_TRAVEL`, `TRAVEL_TIME`. `unloggedMin = isPause ? max(0, over − loggedMin) : 0`. `flagged` when `unloggedMin >= 45`.
- `workMin` = sum over gaps of `isPause ? usual : min`. `pauseAllMin` = sum of `over` on pauses. `pauseLoggedMin = pauseAllMin − pauseUnMin`. `longestMin`/`longestAtMin` are the largest `unloggedMin` and its `atMin` (`0`/`null` when none).
- A delay's `where`: no gap note → `untimed`; `to <= floor(firstMin)` → `before`; `from >= floor(lastMin)` → `after`; else `between`. `driveToFirst` is `category === 'DISPATCH' && where === 'before'`.
- `log.breaks` takes `BREAK`/`LUNCH` minutes, `log.travel` takes `MISC_TRAVEL`/`TRAVEL_TIME`; neither enters `before/between/after/untimed/total`. `log.dispatchBefore + log.otherBefore = log.before`. `delays` omits travel, break and lunch rows. Rows with `minutes` of 0 are skipped. `Downtime` rows on a date with no logs in the mode are skipped.
- `startMin = min(450, firstMin)`. `returned` parsed → `endMin`; blank or unreadable, or no `Days` row → `960`, `endSource:'default'`, `closed:false`. If `lastMin > endMin` → `endMin = lastMin`, `endSource:'lastMeter'`, `pastEnd:true`.
- `beforeUnloggedMin = firstMin − startMin − log.before` (may be negative; display clamps). `closeoutMin = endMin − lastMin`.
- `status.other` counts `VISITED` + `UNACCOUNTED`. `skippedOtherMode` counts printable logs left out by the mode.

- [ ] **Step 1: Write the failing tests.** Build fixtures with two helpers in the test file: `stopsOn(date, clocks, { km = 0.01 } = {})` (one `INSTALLED` stop per `'HH:MM[:SS]'` clock, each pin `km` north of the last, installer `Pat Example`) and `history(n)` (n September-2026 weekdays of nine logs six minutes apart, so `usual[0] === 6` and `usualAny === 6`). Tests, each with `prepareAudit({stops, downtime, days}, { installer:'Pat Example', mode:'land' })`:

```js
test('a 9-minute overrun is work and a 10-minute overrun is a pause', …)
  // gaps of 15 and 16 next door over usual 6
  assert.deepEqual(day.gaps.map(g => [g.isPause, g.over]), [[false, 9], [true, 10]]);
  assert.equal(day.pauseUnMin, 10); assert.equal(day.workMin, 15 + 6);
test('a logged delay comes off its gap, keyed on floored minutes, whatever its workType', …)
  // stops 10:00:45 and 10:40:30; Downtime WAREHOUSE 20, note 'gap 10:00–10:40', workType ''
  assert.equal(gap.loggedMin, 20); assert.equal(gap.unloggedMin, gap.over - 20);
test('break, lunch and travel rows are never taken off', …)      // BREAK 30 on the same gap → loggedMin 0, log.breaks 30, log.total 0
test('a delay bigger than the pause leaves zero, not a negative', …)
test('a gap note that matches no gap counts by where it falls and deducts nothing', …)   // Review Focus 3
  assert.equal(day.log.between, 25); assert.equal(day.pauseUnMin, day.pauseAllMin);
test('a 45-minute unlogged pause is flagged and a 44-minute one is not', …)
test('delays are placed before, between, after and untimed', …)
  assert.deepEqual(day.delays.map(d => d.where), ['before', 'before', 'between', 'after', 'untimed']);
test('dispatch before the first meter is the drive to the first order', …)
  assert.equal(day.log.dispatchBefore, 30); assert.equal(day.log.otherBefore, 70);
  assert.equal(day.delays.find(d => d.category === 'DISPATCH').driveToFirst, true);
test('a missing pin measures the gap against every gap', …)       // lat '' and lat 0 → kind -1, usual === usualAny, unpinned counted
test('a kind with fewer than five gaps uses the all-gap median', …)
test('each distance kind is binned on its bound', …)              // 0.059→0, 0.06→1, 0.5→2, 10→6
test('a one-digit hour parses', …)                                // '2026-09-01 9:05:00' → firstMin 545
test('land and boat follow the date, not the tag', …)
  // a '2026-07-01' day is boat; a September stop tagged workType:'boat' is still land
test('the day ends at close-out, at 16:00 without one, and at the last meter when that is later', …)   // Review Focus 5
  assert.deepEqual([d1.endMin, d1.endSource, d1.closed, d1.pastEnd], [1020, 'closeout', true, false]);
  assert.deepEqual([d2.endMin, d2.endSource, d2.closed], [960, 'default', false]);      // no Days row
  assert.deepEqual([d3.endMin, d3.endSource, d3.closed], [960, 'default', false]);      // returned '—'
  assert.deepEqual([d4.endMin, d4.endSource, d4.pastEnd, d4.closeoutMin], [980, 'lastMeter', true, 0]);
test('a day under 8 orders is kept but does not qualify', …)
test('no logs, or none in the mode, is an empty model', …)        // Review Focus 1
  assert.deepEqual(prepareAudit({ stops:[], downtime:[], days:[] }, { installer:'Pat Example', mode:'land' }).days, []);
  assert.equal(empty.usualAny, null); assert.equal(empty.orders, 0);
test('pct takes the value at floor(n × p)', …)
  assert.equal(pct([1, 2, 3, 4], .5), 3); assert.equal(pct([], .5), null);
```

- [ ] **Step 2: Run** `node --test tests/audit-compute.test.mjs` — expected: FAIL, cannot find module.
- [ ] **Step 3: Implement `js/compute/audit.js`** to the interface and rules above. `Documents\audits-page-context\reference-scripts\report-data.mjs` (outside the repo) is the reference for the walk; this module differs from it in four declared ways: the tag is not read, the 5-gap rule, the late-day rule, and `usual` over all days in the mode.
- [ ] **Step 4: Run** the test file — expected: PASS. Then the full suite.
- [ ] **Step 5: Commit.** Message: `The audit's per-day numbers, worked out in the browser`.

---

### Task 3: Period statistics, the single day and its baselines

**Files:**
- Modify: `js/compute/audit.js`
- Modify: `tests/audit-compute.test.mjs`

**Interfaces:**
- Consumes: `prepareAudit`'s return value (`prep`).
- Produces:

```js
export function periodStats(prep, { from, to })   // 'yyyy-MM-dd' or '' for open-ended
export function dayDetail(prep, date)             // null when the date has no logs in the mode
export function driveStats(legs)                  // legs = rows of the driveTracks read
```

`periodStats` → `{ from, to, mode, orders, days, fullDays, status, unpinned, gapsCount, nextDoorShare, headline, bar, pause, months, categories, loggedPerDay, output, usual, daily }` where:

- `orders`, `status` and `unpinned` are recounted over every day in range (from each day's `logs`); `gapsCount` is `prep`'s.
- `days` counts every day in range; `fullDays` those that qualify. Every statistic below is over qualifying days in range unless it says otherwise. With `fullDays === 0` each statistic is `null` and `bar` is `null`.
- `headline: { orders, days, ordersAvg, ordersBest, pauseMedian, loggedAvg, loggedBeforeShare }`.
- `bar: { startMin, endMin, firstMin, lastMin, segments:[{ key, minutes }] }` — averages; keys in order `delayBefore` (`log.otherBefore`), `driveToFirst` (`log.dispatchBefore`), `beforeUnlogged` (mean of `beforeUnloggedMin`, floored at 0), `work`, `pauseUnlogged`, `pauseLogged`, `closeout`.
- `pause: { median, avg, p25, p75, p10, p90, perDay, longestMedian, longestAtMedian, allMedian, allAvg, bins:[{lo,hi,days}], under60, over90, flags, flagDays }` — `longestMedian` over days whose longest is above 0; `flags`/`flagDays` over qualifying days.
- `months: [{ month:'yyyy-MM', days, ordersAvg, firstAvg, lastAvg, perOrder, pauseMedian, loggedAvg }]` — `perOrder` = sum of `spanMin` ÷ sum of `(n − 1)`.
- `categories: [{ category, label, minutes, share, days, before, between, beforeShare, betweenShare }]`, largest first, over **every** day in range, short days included; no travel, break or lunch.
- `loggedPerDay: { dispatchBefore, otherBefore, before, between, untimed, total }` — averages.
- `output: { ordersAvg, ordersMedian, ordersP10, ordersP90, ordersBest, firstAvg, firstMedian, firstP25, firstP75, lastAvg, lastMedian, spanAvg, workAvg, perOrder }` — this `perOrder` is over every day in range, as in the reference script.
- `usual: [{ label, median, count }]` from `prep` (not range-dependent). `nextDoorShare` = kind-0 gaps ÷ pinned gaps in `prep`.
- `daily: [{ date, n, qualifies, firstMin, lastMin, loggedBefore, loggedBetween, pauseUn, longest, longestAt, flags, pastEnd, closed }]`, every day in range, oldest first.

`dayDetail` → `{ day: DayRec, prevDate, nextDate, baselines: { last30, all } }`. Each baseline is `{ days, ordersAvg, firstAvg, lastAvg, loggedBeforeAvg, loggedBetweenAvg, pauseMedian, longestMedian }`. `last30` is the up-to-30 most recent qualifying days strictly before `date`; `all` is every qualifying day in `prep`. `prevDate`/`nextDate` are the neighbouring dates in `prep.days` (any length), or `null`.

`driveStats` → `{ legs, km, driveMin, avgKmh, topKmh, gaps }` or `null` for an empty list. `avgKmh = km ÷ (driveMin ÷ 60)`; `topKmh = max(maxSpeed) × 3.6` (`maxSpeed` is m/s).

- [ ] **Step 1: Write the failing tests.**

```js
test('the average-day bar adds up to the average day', …)
  const sum = p.bar.segments.reduce((s, x) => s + x.minutes, 0);
  assert.ok(Math.abs(sum - (p.bar.endMin - p.bar.startMin)) < 1e-6);
  assert.deepEqual(p.bar.segments.map(s => s.key),
    ['delayBefore','driveToFirst','beforeUnlogged','work','pauseUnlogged','pauseLogged','closeout']);
test('statistics skip short days and the day list keeps them', …)
test('the range limits the days and leaves the usual times alone', …)
  assert.deepEqual(periodStats(prep, { from:'2026-09-08', to:'2026-09-12' }).usual, periodStats(prep, { from:'', to:'' }).usual);
test('the histogram bins on [lo, hi)', …)                         // daily pauses 0, 14.9, 15, 60, 150 → bins 0,0,1,4,9
test('category totals cover short days and leave out travel and breaks', …)
test('a range with no qualifying day has null statistics and a correct day list', …)   // Review Focus 4
  assert.equal(p.fullDays, 0); assert.equal(p.headline.pauseMedian, null); assert.equal(p.bar, null);
  assert.equal(periodStats(prep, { from:'2026-10-01', to:'2026-09-01' }).days, 0);
test('an empty model gives empty statistics', …)                  // Review Focus 1
test('the 30-day baseline is the 30 qualifying days before the day', …)
  // 40 qualifying days; the 36th → last30.days 30 and excludes itself; the 5th → 4; the 1st → 0 with null values
test('a one-log day opens with no gaps', …)                       // Review Focus 2
  assert.deepEqual(d.day.gaps, []); assert.equal(d.day.pauseUnMin, 0); assert.equal(d.day.spanMin, 0);
test('dayDetail is null for a date with no logs', …)
test('driveStats totals the legs', …)
  // two legs: 30 km in 40 min max 25 m/s, 10 km in 20 min max 20 m/s, one gap
  assert.deepEqual(driveStats(legs), { legs:2, km:40, driveMin:60, avgKmh:40, topKmh:90, gaps:1 });
```

- [ ] **Step 2: Run** — expected: FAIL, `periodStats is not a function`.
- [ ] **Step 3: Implement** the three functions. One internal `summarize(days)` feeds both the baselines and the matching period figures.
- [ ] **Step 4: Run** the test file, then the full suite — expected: PASS.
- [ ] **Step 5: Commit.** Message: `Period statistics, the single day and its two baselines`.

---

### Task 4: Check the numbers against the PDF (outside the repo)

**Files:**
- Create (outside the repo, never committed): `C:\Users\Quincy\OneDrive\Documents\audits-page-context\check-audit.mjs`

**Interfaces:**
- Consumes: `prepareAudit`, `periodStats`; `readSheet` from `reference-scripts\xlsx-read.mjs`; the unpacked export at `audits-page-context\export-2026-11-18\x`; the PDF's own numbers at `audits-page-context\report-data-2026-11-18.json`.

- [ ] **Step 1: Write `check-audit.mjs`.** It reads `Stops`, `Downtime` and `Days` from the export, shapes them like the `audit` read for the owner's name (taken from `report-data-2026-11-18.json`'s `name`), runs `prepareAudit(..., { mode:'land' })` and `periodStats(prep, { from:'', to:'2026-11-18' })`, and prints one line per figure: name, page value, PDF value, `OK` or `DIFF`. Cover: orders, days, fullDays, status, unpinned, gapsCount, the seven usual times, orders a day (avg, median, p10, p90, best), first and last meter, span and work averages, minutes per order, pause (median, avg, p25, p75, p10, p90, under60, over90, perDay, longestMedian, allMedian, allAvg, every bin), logged per day (total, before, dispatch before, between, untimed), each month's row, and each category's minutes / before / between.
- [ ] **Step 2: Run** `node "C:\Users\Quincy\OneDrive\Documents\audits-page-context\check-audit.mjs"` from the repo root. Expected: every line `OK` to the PDF's printed rounding.
- [ ] **Step 3: Resolve any `DIFF`.** A `DIFF` explained by one of the four declared differences in Task 2 is expected only where that difference applies (the 2026-11-18 data has 19+ gaps in every kind, so the 5-gap rule should change nothing; the late-day rule changes only the close-out segment). **If orders, days or pause figures differ because the PDF script dropped rows tagged `boat` on land dates, stop and tell the owner the size of the difference. Do not add a tag rule.** Any other `DIFF` is a bug in `js/compute/audit.js`: fix it with a made-up-data test in `tests/audit-compute.test.mjs` first.
- [ ] **Step 4: Confirm nothing from this task is staged:** `git status --short` shows no file under `audits-page-context` and no figure in any tracked file.

---

### Task 5: Charts and formatting as strings

**Files:**
- Create: `js/audit-charts.js`
- Create: `tests/audit-charts.test.mjs`

**Interfaces:**
- Consumes: `periodStats().bar`, `.pause.bins`, a `DayRec`; `esc`/`attr` from `./dom.js`.
- Produces:

```js
export const SEGMENTS = [   // order is the drawing order
  { key:'delayBefore',    label:'Logged delays before the first meter',                             color:'#F59E0B' },
  { key:'driveToFirst',   label:'Drive to the first order (dispatch logged before the first meter)', color:'#2563EB' },
  { key:'beforeUnlogged', label:'Before the first meter, not logged',                               color:'#94A3B8' },
  { key:'work',           label:'Working',                                                          color:'#1E8E5A' },
  { key:'pauseUnlogged',  label:'Unlogged pauses (breaks included)',                                color:'#D64500' },
  { key:'pauseLogged',    label:'Pause time logged as a delay',                                     color:'#FCD34D' },
  { key:'closeout',       label:'Close-out and drive home',                                         color:'#64748B' } ];
export function fmtClock(min)      // 605.4 → '10:05'; null → '—'
export function fmtMin(min)        // 69.6 → '70'; null → '—'
export function fmtDate(dateKey)   // '2026-11-16' → 'Mon Nov 16, 2026'
export function dayBarHtml(bar)                    // '' when bar is null
export function pauseHistogramHtml(bins, allowanceMin)
export function timelineHtml(day)                  // DayRec → blocks; each gap block carries data-gap="<i>"
export function legendHtml(keys)                   // keys = SEGMENTS keys to show
```

`timelineHtml` draws, left to right: the three before-first-meter blocks from that day's `log.otherBefore`, `log.dispatchBefore` and `max(0, beforeUnloggedMin)`; then per gap a `work` block of `isPause ? usual : min`, a `pauseLogged` block of `over − unloggedMin` and a `pauseUnlogged` block of `unloggedMin` (zero-width blocks omitted; a flagged gap's unlogged block has class `flag`); then `closeout`. Widths are percentages of `endMin − startMin`. All output is plain HTML with inline `width`, no canvas, and prints as drawn.

- [ ] **Step 1: Write the failing tests.**

```js
test('fmtClock and fmtMin round and tolerate null', …)
  assert.equal(fmtClock(605.4), '10:05'); assert.equal(fmtClock(null), '—'); assert.equal(fmtMin(69.6), '70');
test('the bar draws seven segments whose widths total 100%', …)
test('a null bar draws nothing', () => assert.equal(dayBarHtml(null), ''));
test('the timeline splits a long gap into work, logged delay and unlogged pause, in that order', …)
test('a flagged gap is marked and an unflagged one is not', …)
test('a one-log day draws only the before-first-meter and close-out blocks', …)
test('labels never say drive back', …)
  assert.doesNotMatch(JSON.stringify(SEGMENTS), /drive back|return to the yard/i);
```

- [ ] **Step 2: Run** — expected: FAIL. **Step 3: Implement.** **Step 4: Run**, then the full suite — PASS.
- [ ] **Step 5: Commit.** Message: `The audit's bar, histogram and timeline as plain HTML`.

---

### Task 6: The office page and the period view

**Files:**
- Create: `audits.html`, `css/audits.css`, `js/audit-view.js`, `js/pages/audits.js`
- Create: `tests/audit-pages.test.mjs`
- Modify: `tests/admin-gate.test.mjs` (add `audits` to the "every office page waits for the login gate" list and `audits.js` to the `OFFICE` set)

**Interfaces:**
- Consumes: Tasks 1–3 and 5; `apiGet`, `$`, `esc`, `attr`, `toast`, `requireAdmin`; the `roster` read (`employees[].firstName/lastName`).
- Produces:

```js
// js/audit-view.js
export function initAuditView({ installers, fixedInstaller, loadDriveLegs })
//   installers: string[] | null        office: display names for the picker
//   fixedInstaller: string | null      phone: the one name; hides the picker
//   loadDriveLegs: ((installer, date) => Promise<object[]>) | null   office only
```

Element ids both HTML pages share (the view binds each with a null guard): `status`, `statusText`, `auWho`, `auMode` (three buttons with `data-mode`), `auFrom`, `auTo`, `auDay`, `auPrint`, `auBack`, `auPrev`, `auNext`, `auNote`, `auPeriod`, `auDayView`, `auMap`, `toast`.

Behaviour:
- `audits.html` copies the head, `.bar`, status pill and `navSel` of `reports.html`; its `navSel` lists every office view plus `<option value="audits" selected>Audits</option>`. It loads `css/vendor/leaflet.css`, `css/audits.css`, the vendored `js/vendor/leaflet.js` (classic `defer` script) and the module `js/pages/audits.js`.
- `js/pages/audits.js`: imports, then `await requireAdmin();`, then loads `roster`, builds the name list (`firstName + ' ' + lastName`, trimmed, sorted), and calls `initAuditView({ installers, fixedInstaller:null, loadDriveLegs })`. `loadDriveLegs(installer, date)` is `apiGet('driveTracks', { installer, from:date, to:date })` → `res.driveTracks || []`. It also owns the `navSel` handler, in the shape of `reports.js`.
- State lives in the query string: `who`, `mode` (`land` default), `from`, `to`, `day`. Changing a control calls `history.pushState` and re-renders; `popstate` re-renders. With `day` set the day view shows and the period view hides.
- One `apiGet('audit', { installer })` per installer, kept in memory. `prepareAudit` re-runs on a mode change; `periodStats` on a range change.
- The period view renders the spec's eight sections in order, into `auPeriod`. Above them `auNote` carries, when they apply: the Boat/All note ("The pause figures were checked against land work only."), "Statistics use the N days with 8 or more orders, of M days.", and the empty state ("No logs for <name> in this view.").
- Day-by-day rows are buttons that set `day`. A day with flags shows a tag "N long gap(s)". A short day shows "under 8 orders".
- Method and limits is a `<details>`; its text is the spec's Method and Limits sections in plain words, with the values from `AUDIT`.
- Print: `auPrint` calls `window.print()`. `css/audits.css` has an `@media print` block: hide `.bar`, the controls and the toast; open `details` content; `break-inside: avoid` on each section; a print-only heading with installer, mode, period or day, and the date printed.
- Styling follows `css/reports.css` tokens; the page is wider than reports (`max-width: 980px`) and tables scroll sideways inside their card on a narrow screen.

- [ ] **Step 1: Write the failing static tests** in `tests/audit-pages.test.mjs`:

```js
test('the office page waits for the login gate and the shared view never does', …)
  assert.match(read('js/pages/audits.js'), /\nawait requireAdmin\(\);/);
  assert.doesNotMatch(read('js/audit-view.js'), /admin-auth|driveTracks/);
test('the audit files stay out of the service worker', …)
  assert.doesNotMatch(read('sw.js'), /audit/i);
test('audits.html uses the vendored Leaflet and no CDN', …)
  assert.match(html, /js\/vendor\/leaflet\.js/); assert.doesNotMatch(html, /https?:\/\//);
test('the view guards every id it binds', …)
  // every $('au…') in js/audit-view.js is assigned to a const and tested before use: no `$('au\w+')\.` member access
  assert.doesNotMatch(read('js/audit-view.js'), /\$\('au\w+'\)\./);
test('nothing in the audit files says drive back', …)   // audits.html, css/audits.css, js/audit-*.js, js/pages/audits.js, js/compute/audit.js
```

- [ ] **Step 2: Run** — FAIL (files missing). **Step 3: Build** the four files to the behaviour above. **Step 4: Run** the suite — PASS.
- [ ] **Step 5: Drive it** per `VERIFY.md` §2–§4: serve the repo with the node server from `AGENTS.md`, open `audits.html` in headless Edge with the spine stubbed over CDP (`adminCheck` ok, `roster` with `Pat Example`, `audit` returning `history(40)`-style made-up rows built by a small script in the scratchpad). Unregister any service worker and clear `caches` first. Screenshot the period view at 1280 px and 390 px wide; check all eight sections render, the bar's segments total the bar, switching to Boat shows the note and the empty state, and a range change does not issue a second `audit` request.
- [ ] **Step 6: Commit.** Message: `The Audits office page: one installer's work over a period`.

---

### Task 7: The day view and the route map

**Files:**
- Create: `js/audit-map.js`
- Modify: `js/audit-view.js`, `css/audits.css`, `tests/audit-pages.test.mjs`, `tests/audit-charts.test.mjs` (only if a chart helper changes)

**Interfaces:**
- Consumes: `dayDetail`, `driveStats`, `timelineHtml`; `decodeTrack` from `./drive-track.js`; the global `L`.
- Produces:

```js
// js/audit-map.js
export function createRouteMap(el)   // → { show(day), setDriveLegs(legs | null), destroy() }
```

Behaviour:
- `show(day)` clears the map, draws each pinned log as a numbered `L.divIcon` pin (number = its place in the day's logs; inline styles, no dependency on `css/capture.css`), joins them in order with one polyline (`weight:4, opacity:.78`), binds a popup (time, order number, status, address), and fits the bounds. Logs without a pin are listed under the map as "Not on the map: #n <order> (no pin)". Use one shared `L.popup`, as `worklist-route-view.js` does.
- `setDriveLegs(legs)` draws the drive log the way `js/pages/map.js drawDrives` does: `decodeTrack(leg.encoded, leg.startTime)`, a new run after a 60-second jump between points, each recorded gap as a dashed line. `null` removes it.
- Day view, into `auDayView`, in the spec's order: timeline (with legend); "This day, and how it compares" (three columns; heads "This day", "30 worked days before (N days)", "All to date (N days)"; row labels say "average" or "median" as the spec states); "Delays logged this day" (a `driveToFirst` row is labelled "Dispatch (drive to the first order)"; the "logged against" cell reads `HH:MM–HH:MM` plus "before the first meter" / "after the last meter", or "no time of day"); "Route worked"; "Every log, in order".
- Tapping a timeline gap block or a log row opens that gap's detail in place: the two orders, distance (or "no pin"), usual time for its kind, overrun, logged against it, unlogged.
- Day notes in `auNote`: "Worked past the set end time" when `pastEnd`; "Not closed out: 16:00 is assumed" when `!closed`; "Left out of the statistics (under 8 orders)" when `!qualifies`.
- Drive log, only when `loadDriveLegs` was given: fetch on opening a day; no legs → "No drive log was recorded this day"; legs → a checkbox "Show drive log" (off by default) and one line "Top N km/h · average N km/h · N km · H h M min driving · N legs". A failed fetch shows "Could not load the drive log" and leaves the rest of the day view intact. With `loadDriveLegs` null none of this is rendered.
- `auBack` clears `day`; `auPrev`/`auNext` step to `prevDate`/`nextDate` and are disabled at the ends.
- Print: the day view prints with the map as shown on screen.

- [ ] **Step 1: Add failing static tests:** `js/audit-map.js` contains no `apiGet(`; `js/audit-view.js` renders the drive-log block only inside a `loadDriveLegs` check (`assert.match(src, /if\s*\(\s*loadDriveLegs\s*\)/)`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the suite — PASS.
- [ ] **Step 5: Drive it** with the stub from Task 6 plus a made-up `driveTracks` leg (encode a short track with `encodeTrack` from `js/drive-track.js`): open a day from the table; check the timeline's flagged block, the comparison columns' day counts, the numbered pins in logged order, the drive overlay toggling, the speeds line, Back/‹/› and the browser Back button; open a one-log day and a day with no drive log. Screenshot at 1280 px and 390 px, and with print media emulated.
- [ ] **Step 6: Commit.** Message: `The audit of a single day: timeline, comparison, delays and the route worked`.

---

### Task 8: The installer's page and the menu entries

**Files:**
- Create: `my-audit.html`, `js/pages/my-audit.js`
- Modify: `index.html` (the `#navMenu` block, lines 30–36), `map.html`, `teams.html`, `edit.html`, `reports.html`, `planner.html`, `js/pages/map.js:679`, `js/pages/teams.js:432`, `js/pages/edit.js:502`, `js/pages/reports.js:247`, `js/pages/planner.js:1673`, `tests/audit-pages.test.mjs`

**Interfaces:**
- Consumes: `initAuditView`; `cfg` from `../store.js`.

Behaviour:
- `my-audit.html` has the same ids as `audits.html` minus `auWho` and `navSel`; its bar reads "My audit" and holds `<a href="./index.html">← Back to the log</a>`. Same stylesheets and Leaflet script.
- `js/pages/my-audit.js` never imports `admin-auth.js`. It reads `cfg().name`; blank → the page says "Set your name in Settings on the log page first." and stops; otherwise `initAuditView({ installers:null, fixedInstaller:name, loadDriveLegs:null })`.
- `index.html`: add, after the Help button, `<button type="button" onclick="location.href='my-audit.html'">📊 My audit</button>`. No id. `js/pages/capture.js` is not touched.
- Each of the five office pages gets `<option value="audits">Audits</option>` after Reports (after Route Planner where the page lists it), and its handler gets the `audits.html` branch.

- [ ] **Step 1: Add failing static tests:**

```js
test('the installer page is never gated and never asks for a gated read', …)
  assert.doesNotMatch(read('js/pages/my-audit.js'), /admin-auth|requireAdmin|driveTracks|apiGet\('downtime'/);
test('every office page lists Audits and knows where it goes', …)
  for (const p of ['map', 'teams', 'edit', 'reports', 'planner']) {
    assert.match(read(`${p}.html`), /<option value="audits">Audits<\/option>/);
    assert.match(read(`js/pages/${p}.js`), /audits\.html/);
  }
test('the log page menu opens My audit without help from capture.js', …)
  assert.match(read('index.html'), /<button type="button" onclick="location\.href='my-audit\.html'">/);
  assert.doesNotMatch(read('js/pages/capture.js'), /my-audit|navAudit/);
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the full suite, including `tests/admin-gate.test.mjs` (its scanner now reads `my-audit.js`, `audit-view.js` and `audit-map.js` as capture-side and must find no gated action) and `tests/shell-skew-survivable.test.mjs` — PASS.
- [ ] **Step 5: Drive it:** `my-audit.html` at 390 px with `localStorage.name = 'Pat Example'` and the `audit` stub: no picker, no drive-log block, no `adminCheck` or `driveTracks` request in the network log; with no name set, the Settings message. On `index.html`, ☰ ▸ My audit lands on the page; on each office page the dropdown reaches Audits and `audits.html`'s dropdown reaches each of them.
- [ ] **Step 6: Commit.** Message: `My audit on the phone, and Audits in the office menu`.

---

### Task 9: Docs, the full check, and shipping

**Files:**
- Modify: `USER-GUIDE.md`, `AGENTS.md`, `ARCHITECTURE.md`, `changelog/<date>.md`, `CHANGELOG.md`

- [ ] **Step 1: `USER-GUIDE.md`** — add "Audits (office)" after "Map & Analytics (office)" and "My audit" after "Checking and fixing your logs", plus both pages in "The pages at a glance". Say what each number means in the spec's words, the 07:30 / 8-order / 45-minute / 60-minute rules, that the installer view needs signal, and that it shows whoever's name is in Settings. Stay inside the markdown subset `js/pages/help.js` renders; open `help.html` and read the two sections.
- [ ] **Step 2: `AGENTS.md`** — "Seven pages" becomes nine; add `audits` to the office-page lists (§Running locally, §Security note: six office pages); add `audit` to the Reads list with its shape; add one bullet under "Things that are easy to get wrong": the audit computes in the browser from one read; `usual` is over all days in the mode, not the range; its percentile is `floor(n × p)` and deliberately not the spine's `dwellMedian`; the drive-log fetch must stay in `js/pages/audits.js` because the gate test scans every other file as capture-side; the audit files stay out of `sw.js`; no personal figures in tests.
- [ ] **Step 3: `ARCHITECTURE.md`** — an "Audits" section (the two pages, the read's shape, the method in brief with a pointer to the spec) and the six-office-pages line near 2884.
- [ ] **Step 4: Changelog** — finish the day page's section (what shipped, the problem, the traps: the blank-`workType` rows, the gate scanner, why `sw.js` was left alone) and the `CHANGELOG.md` row.
- [ ] **Step 5: Run** `node --test "tests/*.test.mjs"` — every test passes. Re-run Task 4's check — every line `OK` or an explained difference.
- [ ] **Step 6: Search the diff for figures and names:** `git diff origin/main --stat`, then search `git diff origin/main` for the owner's surname and for the headline values in section 7 of the context file (read them from the file at run time; do not write them here) — expected: no match outside pre-existing lines.
- [ ] **Step 7: Commit** the docs. Message: `Docs for the Audits pages`.
- [ ] **Step 8: Push** `git push`. Then confirm the deploy: wait for the Apps Script workflow (`gh run watch` on the latest run), and make one read against production with a made-up name — `?action=audit&installer=Nobody%20Here` returns `{ ok:true, stops:[], downtime:[], days:[] }` and a blank installer returns `installer required`. No other production request is needed.
- [ ] **Step 9: Tell the owner** what shipped, that phones get "My audit" after Settings ▸ ⟳ Force update (the menu entry is in `index.html`), and ask him to open `audits.html`, pick himself, and compare the headline with his PDF.
