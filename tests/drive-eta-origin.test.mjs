// ── The ETA is measured from where the truck actually is ────────────────────
// The day's remaining ETAs used to be anchored on `lastDonePin` — the pin of the
// last order the crew COMPLETED — falling back to the muster point. That is a good
// answer standing in a driveway and a bad one in the two cases that matter most in
// a truck: mid-drive between two houses, and after a walk-up or any stop that never
// matched a worklist order (markWorklistDone never sees those). The phone was
// already streaming GPS the whole time — js/drive-recorder.js watchPosition — and
// simply never let the coordinates out of the module.
//
// These are the wiring assertions for that origin, the age bound that keeps it
// honest, and the arrival line the Drive card now shows off the back of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const driveJs = readFileSync(new URL('../js/drive.js', import.meta.url), 'utf8');
const recorderJs = readFileSync(new URL('../js/drive-recorder.js', import.meta.url), 'utf8');
const routeJs = readFileSync(new URL('../js/route.js', import.meta.url), 'utf8');
const driveCss = readFileSync(new URL('../css/drive.css', import.meta.url), 'utf8');

// ── the recorder hands out its newest fix ───────────────────────────────────
test('the recorder exposes its newest fix, and nothing more', () => {
  assert.match(recorderJs, /export function lastFix\(\)/);
  // The newest point of the LIVE segment — null when `seg` is absent, which is
  // exactly the not-recording case the fallback ladder is for.
  assert.match(recorderJs,
    /const last = seg && seg\.points\.length \? seg\.points\[seg\.points\.length - 1\] : null;/);
  assert.match(recorderJs, /return last \? \{ lat: last\.lat, lng: last\.lng, t: last\.t \} : null;/);
  // liveMetrics stays a metrics contract: drive.js paintMetrics and worklist.js
  // routeTravel both destructure it, and a position is not a metric. Widening it
  // instead of adding a sibling is the change that breaks those quietly. Assert on
  // the returned literal alone — the surrounding prose talks about coordinates.
  const start = recorderJs.indexOf('export function liveMetrics()');
  const metrics = recorderJs.slice(start, recorderJs.indexOf('\n}\n', start));
  const returned = metrics.slice(metrics.indexOf('return {'));
  assert.doesNotMatch(returned, /\blat\b|\blng\b/);
});

// ── the age bound is the whole safety margin ────────────────────────────────
test('a stale fix is rejected rather than read as "here"', () => {
  // A web app gets NO GPS in the background, so a Google-Maps hand-off freezes the
  // newest point at the driveway the crew pulled out of — and it stays there,
  // looking like a perfectly good fix, for the whole leg. Unbounded, the "current
  // location" origin would be most wrong exactly while the driver is driving.
  assert.match(worklistJs, /const LIVE_FIX_MAX_AGE_MS = 2 \* 60 \* 1000/);
  assert.match(worklistJs, /function livePin\(\)/);
  assert.match(worklistJs, /const age = Date\.now\(\) - Number\(fix\.t \|\| 0\);/);
  // Bounded at BOTH ends: a negative age is a clock skew or a bad device timestamp,
  // not a fix from the future, and `!(…)` also rejects a NaN age.
  assert.match(worklistJs, /if\(!\(age >= 0 && age <= LIVE_FIX_MAX_AGE_MS\)\) return null;/);
});

// ── the ladder ──────────────────────────────────────────────────────────────
test('the origin is live fix → last completed pin → muster point', () => {
  // Each rung is reached only when the one above has nothing to say, so a phone
  // that is not the day's armed recorder behaves exactly as it did before: no
  // location prompt, no GPS wakeup of its own, nothing on screen.
  assert.match(worklistJs,
    /planDay\(\) === localDate\(\) \? \(livePin\(\) \|\| lastDonePin\(all\)\) : null/);
  assert.match(worklistJs, /here \|\| cachedCoord\('crewStartLat', 'crewStartLng'\)/);
  // Still inside the today-vs-plan-day guard. An evening plan for tomorrow starts
  // at the depot like any morning does — the couch the phone is sitting on is no
  // better an origin for it than yesterday's last driveway was.
  const est = worklistJs.slice(worklistJs.indexOf('function estimateTravel(items, all)'),
                               worklistJs.indexOf('async function crewStartPin()'));
  assert.ok(est.indexOf('planDay() === localDate()') < est.indexOf('livePin()'),
    'the live fix must sit inside the plan-day guard, not beside it');
});

// ── one model of the day, not two ───────────────────────────────────────────
test('the finish clock re-prices its first leg from the same fix', () => {
  // The first pending leg's saved legMeters is the drive from the PREVIOUS STOP IN
  // ROUTE ORDER. Anchor the ETAs on the live fix and leave this alone, and the same
  // screen carries an arrival time measured from the truck beside a "Route done ~"
  // clock whose first leg starts somewhere else (AGENTS.md §"never model the day
  // twice"). They disagree most on the long legs — where the driver is looking.
  assert.match(worklistJs, /async function firstLegMetres\(pending, f\)/);
  // The leg is measured on the ROAD GRAPH when a pack covers both ends — the same
  // measurement the arrival clock is built from, which is what makes the two cards
  // one model instead of two that agree on a good day. Crow-flies survives only as
  // the fallback, and only for a fix the pack cannot reach.
  assert.match(worklistJs, /const road = await roadLegMetres\(fix, to\);/);
  assert.match(worklistJs,
    /return road != null \? road : haversine\(fix, to\) \* ROAD_DETOUR_FACTOR;/);
  // No fix, or no pin on the next stop, still leaves the sum exactly as it was.
  assert.match(worklistJs, /if\(!\(fix && to\)\) return saved;/);
  assert.match(worklistJs,
    /a \+ \(i === 0 \? first : \(Number\(p\[f\.legMeters\]\) \|\| 0\)\)/);
  // ONLY the first leg: every later one really is stop-to-stop, and its saved road
  // distance beats anything crow-flies can offer.
  const fn = worklistJs.slice(worklistJs.indexOf('async function firstLegMetres'),
                              worklistJs.indexOf('const speed = liveMetrics().avgMovingSpeed'));
  assert.doesNotMatch(fn, /pending\[1\]|pending\.map/);
  // The detour allowance is imported, never re-declared — a second copy is a
  // constant that drifts from the one estimateDurations prices the matrix with.
  assert.match(routeJs, /export const ROAD_DETOUR_FACTOR = 1\.3;/);
  assert.match(worklistJs, /import \{[^}]*\bROAD_DETOUR_FACTOR\b[^}]*\} from '\.\/route\.js'/);
  assert.match(worklistJs, /import \{ liveMetrics, lastFix \} from '\.\/drive-recorder\.js'/);
});

// ── the arrival line ────────────────────────────────────────────────────────
test('the Drive card shows the order\'s own scheduled ETA, not a second estimate', () => {
  assert.match(driveJs, /function etaLine\(item, meta\)/);
  // The persisted field applyTodayAnchor writes — the same one the worklist badges
  // and the route view render. Computing a fresh drive time here would be a second
  // model of the day that can disagree with the first.
  assert.match(driveJs, /if\(!item \|\| !item\.scheduledEta\) return '';/);
  // No distance or travel arithmetic in the builder itself — the only sum it is
  // allowed is `eta − now`, which is the same stored number read two ways.
  const fn = driveJs.slice(driveJs.indexOf('function etaLine(item, meta)'),
                           driveJs.indexOf('export function initDrive'));
  assert.doesNotMatch(fn, /haversine|estimateTravel|legMeters|coordsOf/);
  // Both cards carry it: the current-order card and the locked "Driving to" one.
  assert.match(driveJs, /\$\{etaLine\(item, etaMeta\(\)\)\}/);
  assert.match(driveJs, /if\(eta\) eta\.innerHTML = etaLine\(live, etaMeta\(\)\);/);
  // The dest card reads the LIVE order, matched back out of `pending` by destKey —
  // the saved dest is a snapshot from the Navigate press and its own scheduledEta
  // would sit frozen for the whole drive.
  assert.match(driveJs, /const live = pending\.find\(p => destKey\(p\) === destKey\(d\)\);/);
});

test('the arrival line consults both staleness flags', () => {
  // A surface that shows a scheduled* field without checking wlPlanIssue is how
  // "the map says 09:55 but the warning says 10:13" happens — and this is the
  // screen the crew actually navigates by, so it is the last place a stale time
  // may look current. wlTimesEstimated keeps the existing ~ marker.
  assert.match(driveJs, /const tilde = meta\.estimated \? '~' : '';/);
  assert.match(driveJs, /drive-eta\$\{meta\.stale \? ' stale' : ''\}/);
  assert.match(driveJs, /\$\{meta\.stale \? ' \(stale\)' : ''\}/);
  assert.match(driveCss, /\.drive-eta\.stale\{/);
  // Both flags arrive through the opts, like everything else this screen knows
  // about the route — drive.js must never import worklist.js back (circular).
  assert.match(worklistJs, /getEtaMeta: \(\) => \(\{/);
  assert.match(worklistJs, /estimated: store\.get\('wlTimesEstimated'\) === '1',/);
  assert.match(worklistJs, /stale: planStale\(\),/);
  assert.doesNotMatch(driveJs, /from '\.\/worklist\.js'/);
});

test('the relative half is only shown when it means something', () => {
  // "in N min" needs the ETA to be on today's date and still ahead. A scheduledEta
  // already in the past means the re-time has not caught up (it clocks day 1 from
  // `now`), and an overdue count would read as lateness — which scheduledLateMin
  // already means something specific and different by.
  assert.match(driveJs, /const onToday = !item\.scheduledDate \|\| String\(item\.scheduledDate\) === localDate\(\);/);
  assert.match(driveJs, /delta != null && delta > 0 && delta <= MAX_AHEAD_MIN/);
  // hhmmMin returns null on an unparseable string rather than NaN arithmetic.
  assert.match(driveJs, /const eta = hhmmMin\(item\.scheduledEta\);/);
  assert.match(driveJs, /import \{ localDate, hhmmMin, clockOf, stamp \} from '\.\/time\.js'/);
});

test('"now" is Toronto-pinned, like every other clock here', () => {
  // scheduledEta is a Toronto clock string (route-constraints.js builds it from
  // Toronto-local minutes). Comparing it against the DEVICE's `new Date()
  // .getHours()` is two different zones, and it fails in the quietest possible
  // way — the relative half just never appears on a phone set to anything else.
  // Caught driving the real screen in a UTC container. Same expression
  // day1DepartTime uses.
  assert.match(driveJs, /const nowMin = hhmmMin\(clockOf\(stamp\(\)\)\);/);
  // Comments stripped — the prose above this assertion names the very thing it
  // forbids, and a test that fails on its own explanation teaches nothing.
  const fn = driveJs.slice(driveJs.indexOf('function etaLine(item, meta)'),
                           driveJs.indexOf('export function initDrive'))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(fn, /getHours\(\)|getMinutes\(\)/);
});

test('the arrival line is a span, because the dest card is a button', () => {
  // A <div> inside a <button> is invalid markup and browsers reparse it out of the
  // element, which drops the line from the card the driver reads while navigating.
  assert.match(driveJs, /return `<span class="drive-eta/);
  assert.doesNotMatch(driveJs, /<div class="drive-eta/);
  assert.match(driveCss, /\.drive-eta\{[\s\S]*?display:block;/);
});
