# Usual Start, Day End Time and Flat-Out Number — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route ETAs start from when each installer usually reaches their first stop, each day card on the route map's All tab shows an honest estimated end time, and the All tab shows how many meters a flat-out day could hold.

**Architecture:** The spine measures two numbers per installer from land `Stops` rows and stores them on `InstallerMetrics`: the usual first-log time and the usual delay per stop. The phone and the planner read them through the existing `installerMetrics` read and feed the first into the one scheduler (`scheduleRouteConstraints`) as an arrival clock, so every ETA moves together. The end time and the flat-out number are pure functions over the schedule that already exists; they are display only.

**Tech Stack:** Native ES modules, no build step, `node --test`. Google Apps Script (`Code.gs`) for the spine. Leaflet for the route map.

**Spec:** §"Design" below. It was agreed in chat on 2026-11-18; there is no separate spec file.

## Design

Decisions the owner made (2026-11-18):

1. **Start time is per installer, with a fixed fallback.** Each installer's own usual first-stop time, from **land work only**. Anyone without enough land days gets **09:30**.
2. **The start time moves every ETA**, not only the end time. And **once the first order of the day is logged, that time is the day's start.**
3. **The end time on a day card counts work, breaks and usual delays.**
4. **Breaks are 60 minutes: two 15-minute breaks and one 30-minute lunch.**
5. **The flat-out number assumes the last meter is done by 15:30**, and factors the usual start, the breaks and the usual delays.

Calls made while planning. These are the planner's, not the owner's. Change any of them before Task 1 starts.

| Call | Why |
| --- | --- |
| "Usual" is the **median** of the most recent 30 qualifying land days, not the average of all days. | One 13:15 start drags an average. On the 2026-10-14 export the last 10 days and all days agree within 15 minutes for every installer, so the window costs nothing. |
| A qualifying day has **5 or more** printable logs. An installer needs **10** such days, else blank. | Mirrors the dwell model's evidence gates. Blank means "no evidence" and the phone falls back to 09:30. |
| The sheet stores the first **log** time. The phone subtracts one on-site time to get the first **arrival**. | A log is written when the job is finished. An ETA is an arrival. |
| The morning start is an **arrival** clock: the drive out is not added on top. A "start from here" run and every re-time after a logged stop stay **departure** clocks from now. | The measured start already contains the morning drive. A run from where the truck is standing really does leave now. |
| An appointment before the usual start **pulls that day's start earlier**. | Otherwise a 08:30 appointment is shown as an hour late on a day the crew would simply start early. |
| Breaks sit at **10:00 (15 min), 12:00 (30 min), 14:00 (15 min)** and count only when they fall inside the day. | A route re-planned at 14:30 has one break left, not three. A day that ends at 11:00 has one. |
| Delays are **per stop**, and the stored figure is **net of the 60 break minutes**. | Measured on the export, the crew's logged gap delays already contain their breaks: one installer logs 137 min a day of gap delays, and that installer's whole day has only about 123 min that is not stop-to-stop work. Adding 60 on top would count the breaks twice. |
| The delay is measured from the **stop times themselves**, not from Downtime rows. | Gap allocation is a habit. One installer allocates 130 min a day and another allocates none, on days that look the same. |
| Stop ETAs stay **work only**. Breaks and delays are added to the **day's end**, and the card says so. | Putting them inside the scheduler changes appointment placement. That is a separate decision. |
| The day buttons above the map keep their first-to-last ETA window. Only the day **cards** get the end time. | The buttons are already too wide for the screen. |

Non-goals: changing how many orders a day holds, changing the Optimize solve, breaks inside per-stop ETAs, a per-installer quitting time.

## Global Constraints

- **Nothing in this plan may size a day.** The meters/day target is the only day-sizing input (`AGENTS.md` §"The meters/day target is the ONLY thing that sizes a day"). `scheduleRouteConstraints`' `counts[]`/`capFor`, `js/route.js` and `js/route-today.js` must not read the usual start, the breaks, the delays, `ROUTE_FLAT_OUT_END` or the flat-out number.
- **Never bump the `sw.js` `CACHE` version.** No new JS files: new pure functions go in `js/route-constraints.js`, which is already in `SHELL`.
- **New exports are reached through a namespace import with a `typeof` check** (`routeConstraints.x`, `routeLib.x`), never a new named import. A phone can run new `worklist.js` against an older cached module until ⟳ Force update.
- **No new ids in `index.html` and no new CSS classes.** A phone can run new JS against older markup and CSS.
- **`InstallerMetrics` columns are appended at the end, in all three mode groups** (unprefixed, `boat*`, `land*`), and are added to the projection in `installerMetricsRead`. A field left out of the projection never reaches the phone.
- **Sheet values are plain numbers.** A time of day is stored as minutes after midnight (`587`), never `'09:47'`: Sheets turns a time string into a 1899 date. The new columns must not be in `INSTALLER_METRICS_DATE_HEADERS`.
- **Land only on the phone and the planner:** read with `workType:'land'`, as `refreshAvgDay` already does.
- Constants, exact values: fallback start `'09:30'`; breaks `[{at:'10:00',min:15},{at:'12:00',min:30},{at:'14:00',min:15}]`; flat-out cut-off `'15:30'`; window 30 days; minimum 10 days; minimum 5 logs a day.
- Each task's commit carries its `changelog/YYYY-MM-DD.md` section and `CHANGELOG.md` row, and updates `AGENTS.md`, `ARCHITECTURE.md` and `USER-GUIDE.md` where the task changes what they describe. Run `node --test "tests/*.test.mjs"` before every push. Commit to `main` and push (a push deploys).
- Follow `VERIFY.md` for anything driven in a browser. Never write to the production Sheet.

## Review Focus

1. **A brand-new installer, or a phone that has never been online.** No metrics at all: every ETA starts at 09:30, the end time adds breaks and no delays, and nothing throws.
2. **The spine is not deployed yet, or `backfillInstallerMetrics()` has not been run.** The read returns rows without the new fields. The phone must behave exactly as in 1.
3. **A route re-planned in the afternoon ("start from here" at 17:14, as in the owner's screenshot).** Day 1 starts from now, takes no breaks that are already past, and its card must not show a morning start.
4. **An appointment before the usual start.** It is on time, with no late badge, and the day starts early.
5. **A day with one order, or a list that was never optimized.** No ETAs to read: the card shows no end time and the flat-out line is hidden, rather than showing `NaN` or `00:00`.

---

### Task 1: The spine measures the usual first log and the delay per stop

**Files:**
- Modify: `Code.gs` — `INSTALLER_METRICS_HEADERS` (~line 215), `refreshInstallerMetrics` (~2966), `installerMetricsRead` (~3545), a new function beside `dwellSamples` (~3295)
- Test: `tests/installer-day-shape.test.mjs` (new), `tests/installer-metrics-dwell-schema.test.mjs` (extend)

**Interfaces:**
- Produces: `installerDayShape(name, workType, workdays) -> { usualFirstLogMin, delayPerStopMin, days }`. Both numbers are `''` when `days < 10`.
- Produces: columns `usualFirstLogMin`, `delayPerStopMin`, each ×3 modes, and both fields on every row the `installerMetrics` read returns for `workType=land|boat`.

Definition, per installer and mode:

- A day qualifies when it has 5 or more rows whose status is INSTALLED, UTI, VISITED or UNACCOUNTED and whose `workType` matches the mode (`normWorkType`, as `dwellSamples` does).
- Take the most recent `workdays` qualifying days.
- `usualFirstLogMin` = the median of each day's first log, as whole minutes after midnight.
- Per day: `overhead = (last − first) − (n − 1) × that day's median gap`, in minutes. `delayPerStop = max(0, overhead − 60) / n`. `delayPerStopMin` = the median of those, rounded to one decimal.
- The 60 is `DAY_BREAK_MIN`, a new constant in `Code.gs`.

- [ ] **Step 1: Write the failing tests** in `tests/installer-day-shape.test.mjs`. Load `Code.gs` the way `tests/dwell-measure.test.mjs` does (its `spine(tables)` helper), returning `installerDayShape`. Fixture helpers to write in the test file: `landDays(count, firstClock, { gaps })` returns `Stops` rows for `count` consecutive weekdays ending 2026-09-29, installer `'Pat Example'`, `workType:'land'`, status `INSTALLED`, the first log at `firstClock` and the rest spaced by `gaps` (default: ten gaps of 10 minutes, so 11 logs). `landDay(date, firstClock)` is one such day. `boatDays` is the same with `workType:''`.

```js
test('the usual first log is the median of land days, in minutes after midnight', () => {
  // 12 land days first-logging at 09:40, except one at 13:15.
  const s = spine({ Stops: [...landDays(11, '09:40'), ...landDay('2026-09-30', '13:15')] });
  assert.equal(s.installerDayShape('Pat Example', 'land', 30).usualFirstLogMin, 580);
});
test('boat days do not move the land figure', () => {
  const s = spine({ Stops: [...landDays(12, '09:40'), ...boatDays(20, '07:10')] });
  assert.equal(s.installerDayShape('Pat Example', 'land', 30).usualFirstLogMin, 580);
});
test('fewer than 10 qualifying days is no evidence', () => {
  const r = spine({ Stops: landDays(9, '09:40') }).installerDayShape('Pat Example', 'land', 30);
  assert.deepEqual([r.usualFirstLogMin, r.delayPerStopMin, r.days], ['', '', 9]);
});
test('a day of four logs does not count', () => { /* 10 full days + 5 four-log days at 06:00 → 580, days 10 */ });
test('only the most recent 30 days are read', () => { /* 30 days at 09:40 after 30 older days at 08:00 → 580 */ });
test('the delay per stop is what is left after stop-to-stop work and the 60 break minutes', () => {
  // Each day: 11 logs, nine gaps of 10 min and one of 100. Span 190, median gap 10,
  // overhead 190 − 10×10 = 90, less 60 = 30, over 11 logs = 2.7.
  const r = spine({ Stops: landDays(12, '09:40', { gaps:[10,10,10,10,100,10,10,10,10,10] }) })
    .installerDayShape('Pat Example', 'land', 30);
  assert.equal(r.delayPerStopMin, 2.7);
});
test('a day with less overhead than the breaks has no delay, never a negative one', () => { /* all gaps 10 → 0 */ });
```

- [ ] **Step 2: Run** `node --test tests/installer-day-shape.test.mjs`. Expected: FAIL, `installerDayShape is not defined`.
- [ ] **Step 3: Implement** `installerDayShape` and `DAY_BREAK_MIN = 60` in `Code.gs`. Reuse `dateOf`, `secOfDay`, `sameName`, `normWorkType`, `dwellMedian`.
- [ ] **Step 4: Add the columns.** Append to `INSTALLER_METRICS_HEADERS`: `['usualFirstLogMin','boatUsualFirstLogMin','landUsualFirstLogMin','delayPerStopMin','boatDelayPerStopMin','landDelayPerStopMin']`. Fill them in `refreshInstallerMetrics` beside `applyOnSiteMetrics` (window 30). Add both names to the projection list in `installerMetricsRead`.
- [ ] **Step 5: Extend** `tests/installer-metrics-dwell-schema.test.mjs`: both fields exist in all three groups, both are in the `installerMetricsRead` projection, neither is in `INSTALLER_METRICS_DATE_HEADERS`, and the six new headers are the **last** six.
- [ ] **Step 6: Run** `node --test "tests/*.test.mjs"`. Expected: all pass.
- [ ] **Step 7: Docs and commit.** `AGENTS.md` §"Architecture in one paragraph" (the `InstallerMetrics` sentence) and `ARCHITECTURE.md` §"On-site time (dwell)" gain the two fields and the rule that the delay is net of 60 break minutes. Changelog section. Commit and push.
- [ ] **Step 8: Owner step, not the agent's.** After CI deploys `Code.gs`, the owner runs `backfillInstallerMetrics()` once from the Apps Script editor. Until then every installer reads blank and gets 09:30. Say this in the hand-off message.

### Task 2: The scheduler takes an arrival clock, and an early appointment pulls it earlier

**Files:**
- Modify: `js/route-constraints.js` — `simulateDay` (~146), `placeAppointments` (~210), `scheduleRouteConstraints` (~302), `dayDurationMin` comment (~55)
- Test: `tests/route-constraints.test.mjs`

**Interfaces:**
- Produces: `opts.firstStopArrival` (boolean) on `scheduleRouteConstraints`. When true, `opts.firstStopTime` is the time the crew **arrives** at a day's first stop: `travel.fromStart` is not added. `opts.day1FirstStopTime` keeps its meaning (a **departure** from where the crew is), on Day 1 only.
- Omitted or false is byte-identical to today.

- [ ] **Step 1: Write the failing tests.**

```js
test('an arrival clock puts the first stop on it, with no drive out added', () => {
  const travel = { fromStart: () => 25, between: () => 10 };
  const r = scheduleRouteConstraints([item('a'), item('b')], ['a','b'],
    opts({ firstStopTime:'09:30', firstStopArrival:true, travel }));
  assert.equal(r.scheduleById.a.eta, '09:30');
});
test('without the flag the drive out is still added', () => { /* same inputs, no flag → a.eta '09:55' */ });
test('a from-here Day 1 is still a departure, even with the flag', () => {
  /* day1FirstStopTime:'11:40', flag on → day 1 first eta '12:05'; day 2 first eta '09:30' */
});
test('an appointment before the usual start pulls that day earlier and is not late', () => {
  const items = [item('a'), item('appt', { appointmentDate:'2026-07-24', appointmentTime:'08:30' }), item('b')];
  const r = scheduleRouteConstraints(items, ['a','appt','b'], opts({ firstStopTime:'09:30', firstStopArrival:true }));
  assert.equal(r.scheduleById.appt.slot, 1);
  assert.equal(r.scheduleById.appt.eta, '08:10');     // the 20-minute window opens
  assert.equal(r.scheduleById.appt.lateMin, 0);
});
test('the early start is for that day only', () => { /* a second day with no appointment starts 09:30 */ });
test('the arrival clock changes no day size', () => {
  /* 9 items, target 4: orderedIds and every date/slot are deep-equal with and without the flag */
});
```

- [ ] **Step 2: Run** `node --test tests/route-constraints.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** `simulateDay` gains a last parameter `arrive`: when true the first stop's `raw` is `firstMin`. In `scheduleRouteConstraints`, a day is arrival-anchored when `opts.firstStopArrival` is set and it is not Day 1 running on `day1FirstStopTime`. For an arrival-anchored day, its clock is `min(firstMin, earliest appointment that day − 20)`. Pass the same clock and flag to `placeAppointments` and to both `simulateDay` calls for that day, so the search and the final walk price the same day.
- [ ] **Step 4: Run** `node --test tests/route-constraints.test.mjs`. Expected: PASS, all 35 existing tests included.
- [ ] **Step 5: Docs and commit.** Fix the `dayDurationMin` comment: under an arrival clock the drive out is no longer inside the span. `AGENTS.md` gains one bullet beside §"Never schedule a late arrival, and never model the day twice". Changelog section. Commit and push. No phone passes the flag yet, so nothing changes in the field.

### Task 3: The day's end time and the flat-out number, as pure functions

**Files:**
- Modify: `js/route-constraints.js` (append), `js/config.js`
- Test: `tests/route-day-end.test.mjs` (new)

**Interfaces:**
- Produces, in `js/config.js`: `ROUTE_USUAL_START = '09:30'`, `ROUTE_BREAKS = [{at:'10:00',min:15},{at:'12:00',min:30},{at:'14:00',min:15}]`, `ROUTE_FLAT_OUT_END = '15:30'`.
- Produces, in `js/route-constraints.js`:
  - `usualStartClock(usualFirstLogMin, onSiteMin, fallback) -> 'HH:MM'` — the first-arrival clock: `usualFirstLogMin − round(onSiteMin)`, or `fallback` when the measurement is blank, not finite, or not between 05:00 and 14:00.
  - `dayEndEstimate(items, o) -> { startMin, workEndMin, breakMin, delayMin, endMin } | null` with `o = { fallbackOnSiteMin, delayPerStopMin, breaks, startedMin }`.
  - `flatOutPerDay(days, o) -> { perDay, workPerStopMin } | null` with `days` an array of item arrays and `o = { startMin, endMin, delayPerStopMin, breaks }`.

Rules:

- `dayEndEstimate`: `startMin` is the earliest `scheduledEta`, or `o.startedMin` when given (today's first log). `workEndMin` is the latest `scheduledEta + scheduledOnSiteMin` (fallback on-site when blank, as `dayDurationMin` does). `delayMin = round(delayPerStopMin × stops with an ETA)`. Walk `breaks` in clock order: a break counts when its `at` is at or after the earliest `scheduledEta` and before the running end (`workEndMin + delayMin + breaks counted so far`). `endMin` is the sum. Null when no item has an ETA.
- `flatOutPerDay`: `workPerStopMin` = total of each day's (`workEndMin` − earliest ETA) over the total stops, across days with 2 or more ETAs. `perDay` is the largest `n` with `startMin + n × (workPerStopMin + delayPerStopMin) + breaks inside that span ≤ endMin`. Null when no day qualifies or `workPerStopMin` is not positive.

- [ ] **Step 1: Write the failing tests.**

```js
const stop = (eta, onSite = 10) => ({ scheduledEta: eta, scheduledOnSiteMin: onSite });
const BREAKS = [{ at:'10:00', min:15 }, { at:'12:00', min:30 }, { at:'14:00', min:15 }];

test('the usual start is the usual first log less one job', () => {
  assert.equal(usualStartClock(597, 12, '09:30'), '09:45');
});
test('no measurement, or a nonsense one, is the fallback', () => {
  for(const v of ['', null, undefined, NaN, 0, 120, 900]) assert.equal(usualStartClock(v, 12, '09:30'), '09:30');
});
test('a full day ends after its work, its breaks and its delays', () => {
  // 09:30 first arrival, last stop arrives 14:40 and takes 10 → work ends 14:50.
  const day = [stop('09:30'), ...Array(23).fill(stop('11:00')), stop('14:40')];
  const e = dayEndEstimate(day, { delayPerStopMin: 2, breaks: BREAKS });
  assert.deepEqual([e.startMin, e.workEndMin, e.delayMin, e.breakMin, e.endMin],
    [570, 890, 50, 60, 1000]);                         // 16:40
});
test('a break already past when the day starts is not counted', () => {
  const e = dayEndEstimate([stop('12:30'), stop('13:00')], { delayPerStopMin: 0, breaks: BREAKS });
  assert.equal(e.breakMin, 0);                         // ends 13:10, before the 14:00 break
});
test('a break the delays push the day into is counted', () => { /* work ends 13:55, delays 20 → the 14:00 break counts */ });
test('an evening re-plan takes no breaks at all', () => { /* etas 17:14 … 22:26 → breakMin 0 */ });
test('the first log of the day is the start once there is one', () => {
  assert.equal(dayEndEstimate([stop('11:00')], { breaks: BREAKS, startedMin: 552 }).startMin, 552);
});
test('no ETAs, no estimate', () => {
  assert.equal(dayEndEstimate([{ id:'a' }], { breaks: BREAKS }), null);
  assert.equal(dayEndEstimate([], { breaks: BREAKS }), null);
});
test('flat out is how many stops fit between the start and the cut-off', () => {
  // Two days of 10 stops, each spanning 120 min of work → 12 min a stop.
  // 09:30 → 15:30 is 360 min, less 60 of breaks = 300, over (12 + 3) = 20.
  const days = [tenStopsOver120(), tenStopsOver120()];
  assert.equal(flatOutPerDay(days, { startMin: 570, endMin: 930, delayPerStopMin: 3, breaks: BREAKS }).perDay, 20);
});
test('a late start loses the breaks it starts after as well as the time', () => { /* startMin 13:00 → only the 14:00 break */ });
test('nothing optimized, nothing to say', () => { assert.equal(flatOutPerDay([[{ id:'a' }]], { startMin:570, endMin:930, breaks:BREAKS }), null); });
```

- [ ] **Step 2: Run** `node --test tests/route-day-end.test.mjs`. Expected: FAIL, the exports do not exist.
- [ ] **Step 3: Implement** the three functions and the three constants.
- [ ] **Step 4: Add the guard test** to the same file: `js/route.js` and `js/route-today.js` contain none of `flatOutPerDay`, `dayEndEstimate`, `ROUTE_FLAT_OUT_END`, `ROUTE_BREAKS`, and `scheduleRouteConstraints`' source does not either.
- [ ] **Step 5: Run** `node --test "tests/*.test.mjs"`. Expected: all pass.
- [ ] **Step 6: Commit and push** with the changelog section. Nothing calls these yet.

### Task 4: The phone's ETAs start from the usual start

**Files:**
- Modify: `js/worklist.js` — `planShape` (~250), `day1DepartTime` (~281), `refreshAvgDay` (~1689), `wlDayEta` (~1677), the four scheduler call sites (~968, ~1561, ~2037, ~2679)
- Test: `tests/worklist-usual-start.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's `usualFirstLogMin` / `delayPerStopMin` on the land metrics row; Task 2's `firstStopArrival`; Task 3's `usualStartClock`, `ROUTE_USUAL_START`.
- Produces, exported from `js/worklist.js`: `usualStart() -> 'HH:MM'`, `delayPerStop() -> number` (0 when blank), `todayFirstLog() -> 'HH:MM' | ''` (sync, from a module variable), `refreshTodayFirstLog() -> Promise<void>`.
- localStorage keys: `wlUsualFirstLogMin`, `wlDelayPerStopMin`, written with the existing `storeNum`.

- [ ] **Step 1: Write the failing tests.** `worklist.js` needs a DOM, so follow the existing worklist tests' approach of asserting on source (`tests/worklist-optimize-gate.test.mjs`):

```js
test('the metrics read stores the usual first log and the delay per stop', () => {
  assert.match(js, /storeNum\('wlUsualFirstLogMin', m\.usualFirstLogMin\)/);
  assert.match(js, /storeNum\('wlDelayPerStopMin', m\.delayPerStopMin\)/);
});
test('the plan starts on the usual start, as an arrival', () => {
  assert.match(js, /firstStopTime:\s*usualStart\(\)/);
  assert.match(js, /firstStopArrival:\s*true/);
  assert.doesNotMatch(sourceOf('planShape'), /ROUTE_DEPART_TIME/);   // the function's own text
});
test('every scheduler call on the phone spreads planShape, so none can miss the flag', () => {
  // every scheduleRouteConstraints( and applyVariant( call in worklist.js has `...planShape()` in its
  // options, directly or through a `planOpts` object built from it in the same function
});
test('new scheduler exports are reached through the namespace, never a named import', () => {
  assert.doesNotMatch(js, /import \{[^}]*usualStartClock[^}]*\} from '\.\/route-constraints\.js'/);
});
```

- [ ] **Step 2: Run** `node --test tests/worklist-usual-start.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `refreshAvgDay` stores both fields.
  - `usualStart()` returns `routeConstraints.usualStartClock(readNum('wlUsualFirstLogMin'), dwellShape().base, ROUTE_USUAL_START)` when that export exists, else `ROUTE_USUAL_START`. Mind the cycle: `dwellShape` calls `planShape`, so `usualStart` must not be reached from inside `dwellShape`.
  - `planShape` returns `firstStopTime: usualStart()` and `firstStopArrival: true`. Confirm `applyVariant` (`js/route-variants.js:114`) hands its options to the scheduler unchanged, so the flag arrives. The implicit plan push that omits `routeStartDate` must also omit `firstStopArrival` (it is not a sheet field).
  - `refreshTodayFirstLog()` reads `dayCache` for `${name}|${localDate()}`, takes the earliest timestamp among INSTALLED and UTI stops, and stores its clock in a module variable. Call it at the top of `applyTodayAnchor` and after a stop is logged.
  - `day1DepartTime(fromCurrent)`: still `''` unless `fromCurrent` and the plan day is today. Then return now when `todayFirstLog()` is set, **or** now is past `usualStart()`. Otherwise `''`. This is the owner's rule 2: after the first log of the day the clock is real, however early it was.
  - `wlDayEta`'s tooltip drops "the drive out," for a morning-anchored day.
- [ ] **Step 4: Run** `node --test "tests/*.test.mjs"`. Expected: all pass. Fix any test that pinned `firstStopTime:ROUTE_DEPART_TIME` on the phone.
- [ ] **Step 5: Verify in headless Edge** (`VERIFY.md` §3–4, spine stubbed with `Fetch.fulfillRequest`). Seed a three-day optimized worklist, stub `action=installerMetrics` three ways, and re-time by toggling the route variant:

| Stub | Expect |
| --- | --- |
| `usualFirstLogMin: 597`, `onSiteMin: 12` | Day 2's first ETA is `09:45` |
| fields absent (old spine) | Day 2's first ETA is `09:30` |
| blank, plus an appointment at `08:30` on Day 2 | that stop is first, ETA `08:10`, no late badge |

  Then seed a `dayCache` stop logged today at 08:50 with the clock pinned to 09:00: Day 1's ETAs run from 09:00, not from the usual start.
- [ ] **Step 6: Docs and commit.** `AGENTS.md`: the `ROUTE_DEPART_TIME` and `day1DepartTime` passages now describe the usual start, and the planner is named as still on 08:15 until Task 6. `USER-GUIDE.md`: where ETAs start. Changelog section. Commit and push.

### Task 5: The All tab shows each day's end time and the flat-out number

**Files:**
- Modify: `js/worklist-route-view.js` — `dayRow`, `render`; `js/worklist.js` — the `initWorklistRouteView({...})` options (~3077)
- Test: `tests/worklist-route-view.test.mjs`

**Interfaces:**
- Consumes: Task 3's `dayEndEstimate`, `flatOutPerDay`, `ROUTE_BREAKS`, `ROUTE_FLAT_OUT_END`; Task 4's `usualStart`, `delayPerStop`, `todayFirstLog`.
- Produces: a new option `opts.dayPlan() -> { usualStart:'HH:MM', delayPerStopMin:number, fallbackOnSiteMin:number, todayFirstLog:'HH:MM'|'', planIsToday:boolean }`.
- Produces, exported from `js/worklist-route-view.js`: `dayEndText(group, plan) -> string` and `flatOutText(groups, plan) -> string`. Both return `''` when there is nothing to say, when `opts.dayPlan` is missing, or when the scheduler exports are missing.

Exact copy:

- Card, a day not yet started: `09:45 → ends about 15:55 · 60 min breaks · 50 min delays · tap to open`. Leave out a part that is zero.
- Card, Day 1 once today has a first log and the plan day is today: `started 08:50 → ends about 15:10 · …`.
- Flat-out line, under the day rows, in the existing `.muted` paragraph style: `Flat out: about 22 a day by 15:30 — all 113 in 6 days. Planned at 25 a day.` The day count is `ceil(total / perDay)`. The last sentence reads `opts.weights().target`.

- [ ] **Step 1: Write the failing tests** for `dayEndText` and `flatOutText` with literal expected strings: a full day; a day with no delays; Day 1 started; an evening Day 1 (no breaks, no "started" unless there is a log); a group with no ETAs (`''`); `plan` undefined (`''`); and `flatOutText` for 113 orders at 22 a day (`6 days`) and for a never-optimized list (`''`).
- [ ] **Step 2: Run** `node --test tests/worklist-route-view.test.mjs`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Import the scheduler as `import * as sched from './route-constraints.js'` and the constants as `import * as conf from './config.js'`, each use behind a `typeof`/existence check. `dayRow` replaces its first-to-last window with `dayEndText`, and keeps the window when that is `''`. `render` appends the flat-out paragraph after the rows on the All tab only. `worklist.js` passes `dayPlan`.
- [ ] **Step 4: Run** `node --test "tests/*.test.mjs"`. Expected: all pass.
- [ ] **Step 5: Verify in headless Edge**, reusing Task 4's seed. Read the All tab's rows and the flat-out line from the DOM for: metrics present, metrics absent, a never-optimized list, and a Day 1 re-planned at 17:14. Take one screenshot in its own browser.
- [ ] **Step 6: Sanity-check the number against real days.** Run the formula with each installer's own figures from the newest sheet export and compare with their real best and average day. Report the table in the hand-off. On the 2026-10-14 export a 15:30 cut-off gives roughly 17 to 22 a day for a 09:50 start, which is **at or below what the crew already averages** (19.6 to 23.1) and below a target of 25. If that still holds, say so plainly: the number is limited by the start time, and the owner may want a different cut-off or to drop the delays from this one figure.
- [ ] **Step 7: Docs and commit.** `USER-GUIDE.md` §"View and adjust the route": what the end time counts and what flat-out means. `AGENTS.md`: the All-tab bullet gains "display only; never a sizing input". Changelog section. Commit and push.

### Task 6: The planner uses the same start

**Files:**
- Modify: `js/pages/planner.js` — `planShape` (~116), the metrics read (~735), the `scheduleRouteConstraints` call (~1037)
- Test: `tests/planner-usual-start.test.mjs` (new)

**Interfaces:**
- Consumes: Task 1's fields on the `workType:'land'` read the planner already makes; Task 2's flag; Task 3's `usualStartClock` and `ROUTE_USUAL_START`.

- [ ] **Step 1: Write the failing tests** (source assertions, as in Task 4): the planner's `planShape` returns `firstStopArrival: true` and a `firstStopTime` from `usualStartClock`; the metrics read keeps `usualFirstLogMin` per installer; `ROUTE_DEPART_TIME` is no longer the schedule's clock.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the picked installer's `usualFirstLogMin` beside the cadence the planner already stores from that read. `planShape` uses it. `departMinutes` and its 08:00–08:30 clamp stay only where `optimizeRoute`'s `departMin` is passed; it is not a scheduling input.
- [ ] **Step 4: Run** `node --test "tests/*.test.mjs"`. Expected: all pass.
- [ ] **Step 5: Verify in headless Edge** behind the admin login with the spine stubbed (`VERIFY.md` §4): load a fixture worklist for an installer whose stub carries `usualFirstLogMin: 547`, Optimize against a stubbed OSRM table, and read the first ETA of Day 2. It must equal what the phone shows for the same list.
- [ ] **Step 6: Docs and commit.** `ARCHITECTURE.md` §"Route timing has two sheet-backed references" is rewritten for the one clock. If `ROUTE_DEPART_TIME` now has no reader that schedules anything, say so in `config.js`'s comment rather than deleting it: `optimizeRoute`'s `departMin` still names it. Changelog section. Commit and push.
