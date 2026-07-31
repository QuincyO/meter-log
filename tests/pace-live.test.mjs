// ── The pace gauge and the ETAs must both track a day that is being WORKED ──
// Two devices: the crew logs on a work phone and drives by a second one. The
// drive phone logs nothing itself, so nothing on it ever invalidates the day
// cache the whole pace projection is read from — it believed all day that zero
// meters had been installed, and reported "0 of N · on pace" no matter what.
// These are the wiring assertions; the arithmetic lives in estimate.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const driveJs = readFileSync(new URL('../js/drive.js', import.meta.url), 'utf8');
const tuningJs = readFileSync(new URL('../js/worklist-tuning.js', import.meta.url), 'utf8');

// ── the second device's stale day cache ─────────────────────────────────────
test('Download pulls today down before the day is re-anchored', () => {
  assert.match(worklistJs, /import\s*\{[^}]*\bcacheRecentDays\b[^}]*\}\s*from\s*'\.\/daycache\.js'/);
  // Order matters: dayCapacity and the pace projection both read the cache, so a
  // refresh AFTER applyTodayAnchor would size the day off the stale copy.
  const dl = worklistJs.slice(worklistJs.indexOf('async function wlDownload'));
  const refresh = dl.indexOf('cacheRecentDays(1)');
  const anchor = dl.indexOf('await applyTodayAnchor()');
  assert.ok(refresh > -1, 'wlDownload must refresh the day cache');
  assert.ok(refresh < anchor, 'the refresh must land before applyTodayAnchor');
});

test('the drive-mode pace refreshes the cache on its own slow clock', () => {
  // drive.js repaints every few seconds; re-reading the same stale cache that
  // often is free and useless, and re-fetching it that often is neither.
  // Five minutes, matching drive.js AUTO_SYNC_MS — the Drive screen's automatic
  // refresh is the one on a real clock, and two periods would be two clocks
  // disagreeing about how fresh "fresh" is (tests/drive-auto-refresh.test.mjs).
  assert.match(worklistJs, /const PACE_REFRESH_MS = 5 \* 60 \* 1000/);
  assert.match(worklistJs, /async function drivePace\(\)\{\s*await refreshPaceCache\(\);/);
  // Stamped before the await, or a slow call stacks up behind itself.
  assert.match(worklistJs, /paceCacheAt = now;[\s\S]{0,200}?await cacheRecentDays\(1\)/);
});

// ── the route is the denominator ────────────────────────────────────────────
test('paceContext carries the meters/day target into the projection', () => {
  assert.match(worklistJs, /target:\s*targetVal\(\),\s*\n\s*dayClosed:/);
});

test('the gauge reads short-of-route, and keeps the target as a footnote', () => {
  // est.target (meters/day) — never pace.target, which would collide with
  // est.paces.target, the finish-by horizon.
  assert.match(driveJs, /const target = est\.target \|\| 0/);
  assert.doesNotMatch(driveJs, /pace\.target\b/);
  // The route is the denominator AND the verdict; the target only ever appears as
  // the caption's second half. "N of <target> installs" is the shape that was wrong.
  assert.match(driveJs, /const total = done \+ \(est\.pendingCount \|\| 0\)/);
  assert.match(driveJs, /\$\{done\} of \$\{total\} stops/);
  assert.doesNotMatch(driveJs, /of \$\{target\} installs/);
  assert.doesNotMatch(driveJs, /short of \$\{target\}/);
  assert.match(driveJs, /under your \$\{target\}/);
  // Walk-ups can carry `done` past the route without the bar leaving the track.
  assert.match(driveJs, /Math\.min\(100, \(v \/ total\) \* 100\)/);
  // The tuning what-if reads the same shortfall, or the two screens disagree about
  // what "short" counts.
  assert.match(tuningJs, /\$\{t\.routeShort\} short/);
  // The renamed field: `delta` meant the route, and nothing may still read it.
  assert.doesNotMatch(driveJs, /pace\.delta/);
  assert.doesNotMatch(tuningJs, /\bt\.delta\b/);
});

test('onPace is the route shortfall, unconditionally', () => {
  const estimateJs = readFileSync(new URL('../js/compute/estimate.js', import.meta.url), 'utf8');
  assert.match(estimateJs, /onPace: routeShort <= 0/);
  // The branch that made a set target change the MEANING of on pace, not just the
  // footnote. Its return is why "4 orders left, all of them landing" read as behind.
  assert.doesNotMatch(estimateJs, /onPace: target > 0/);
});

test('today’s route is day 1 strictly, not the lowest day present', () => {
  // A finished day leaves Day 1 empty with days 2+ still full. A min-day read would
  // hand the gauge tomorrow's chunk and clock a "Route done ~" for a route nobody is
  // driving today. (It used to arrive the other way too — target met ⇒ capacity 0 ⇒
  // everything stamped day 2+ — which no longer happens; see the next test.)
  assert.match(worklistJs, /return pending\.filter\(p => dayOf\(p\) === 1\);/);
  assert.doesNotMatch(worklistJs, /const minDay = Math\.min/);
});

test('meeting the target does not take the card off the screen', () => {
  // The card is fed by todayPending, i.e. by whatever Day 1 holds — and Day 1 is now
  // the LOCKED set entire, never `min(dayCapacity + extend, …)`. Installing past the
  // meters/day target used to zero capacity, zero day1Count, stamp every remaining
  // order day 2+, and so empty todayPending mid-afternoon with work still in front of
  // the crew. Pin the arithmetic that made that possible as gone.
  assert.match(worklistJs, /return day1Count\(anchorDay1Ids\(a, pending\)\);/);
  assert.doesNotMatch(worklistJs, /day1Count\(anchor,/);
  assert.doesNotMatch(worklistJs, /\bdayCapacity\(/);
  // `anchor.extend` is gone with the clamp it existed to buy room back from. The one
  // surviving mention is the header explaining why — it is spelled `anchor.extend`,
  // so a bare `extend:` write would still fail here.
  assert.doesNotMatch(worklistJs, /\bextend\s*:/);
  assert.doesNotMatch(worklistJs, /anchorExtend/);
});

// ── the gauge says AHEAD, not just short ────────────────────────────────────
test('a day past the meters/day target reads as over it, not as a blank footnote', () => {
  const estimateJs = readFileSync(new URL('../js/compute/estimate.js', import.meta.url), 'utf8');
  assert.match(estimateJs, /const targetOver = target > 0 \? Math\.max\(0, projected - target\) : null;/);
  assert.match(driveJs, /\$\{over\} over your \$\{target\}/);
  // Both halves of the footnote, or the card goes quiet on one side of the line.
  assert.match(driveJs, /\$\{under\} under your \$\{target\}/);
});

// ── one card on the Drive screen, and it says when the route is done ────────
test('the Drive screen paints one pace card, not two', () => {
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // The Target card measured against ROUTE_DAY_END (4:00) — fifteen minutes from
  // the 3:45 working-hours horizon, so it read as the same card twice.
  assert.doesNotMatch(driveJs, /dpTarget/);
  assert.doesNotMatch(indexHtml, /dpTarget/);
  assert.match(driveJs, /fillPaceRow\('dpWork', est\.paces\.work, 'Day', est\)/);
  // The model still returns paces.target — the plan banner and the tuning what-if
  // are the callers, and removing it there was NOT part of this change.
  assert.match(tuningJs, /est\.paces\.target/);
});

test('the finish clock is derived from the same inputs as the projection', () => {
  const estimateJs = readFileSync(new URL('../js/compute/estimate.js', import.meta.url), 'utf8');
  // now + remaining travel + stops × on-site — paceFor's arithmetic read forward.
  // A separately-sourced clock could disagree with the ~N installs above it.
  assert.match(estimateJs, /routeFinishMin = pend > 0 \? Math\.round\(now \+ travel \+ pend \* onsitePerStop\) : null/);
  assert.match(driveJs, /Route done ~\$\{label\}/);
  // Late is late for THIS card's horizon, not for a wall clock.
  assert.match(driveJs, /est\.routeFinishMin > pace\.horizonMin/);
  // The DERIVED clock is unbounded and must carry am/pm. clockLabel is the bare
  // 12-hour readout and belongs to the fixed horizons alone — through it, a real
  // 23:29 printed "11:29" on a card being read at 11:36 in the morning.
  assert.match(estimateJs, /routeFinishLabel: finishLabel\(routeFinishMin\)/);
  assert.doesNotMatch(estimateJs, /routeFinishLabel:.*clockLabel/);
});

// ── the inputs the projection is built from ─────────────────────────────────
test('the observed cadence is a median, and logged delay is netted out of it', () => {
  // A day is a handful of gaps and a hold-up is one of them, so the MEAN let a
  // single wait stand in for every stop — and it never washed out, because every
  // later projection re-read the same day. The arithmetic is unit-tested in
  // tests/cadence.test.mjs; this is the wiring.
  assert.match(worklistJs, /import \{ observedOnSiteMin \} from '\.\/compute\/cadence\.js'/);
  assert.match(worklistJs, /observedOnSiteMin\(\s*computeGapsLocal\(printable, downtime \|\| \[\], pending, false\)\)/);
  // The gap model must receive the day's downtime. `[]` here charged a delay the
  // crew had logged as time spent installing.
  assert.doesNotMatch(worklistJs, /computeGapsLocal\(printable, \[\]/);
  assert.match(worklistJs, /onsitePerStopReal\(stops, \(cached && cached\.downtime\)/);
  // No measurement yet ⇒ the modelled dwell, not a zero.
  assert.match(worklistJs, /if\(observed == null\) return dwellShape\(\)\.base;/);
});

test('a day-average too slow to be driving does not price the route', () => {
  // avgMovingSpeed counts anything over 1.8 km/h as moving, and the recorder runs
  // while the crew is on foot at a meter — so a real rural day reported 18 km/h and
  // priced 18 remaining legs at 2¼ hours. The old guard was 1 m/s (3.6 km/h).
  assert.match(worklistJs, /const MIN_BELIEVABLE_SPEED_MPS = 25 \/ 3\.6/);
  assert.match(worklistJs, /speed >= MIN_BELIEVABLE_SPEED_MPS \? speed : FALLBACK_SPEED_MPS/);
  assert.doesNotMatch(worklistJs, /speed > 1 \? speed/);
});

// ── the ETAs move as the day is worked ──────────────────────────────────────
test('a changed ETA is written even when nothing moved position', () => {
  // The skip guard was keyed on position + date, which was safe only while the
  // day's clock was a constant. With a clock that moves, a stop can sit still and
  // still be due at a different time.
  assert.match(worklistJs,
    /item\.order === order && item\.day === day\s*\n\s*&& String\(item\.scheduledDate \|\| ''\) === String\(s\.date \|\| ''\)\s*\n\s*&& String\(item\.scheduledEta \|\| ''\) === String\(s\.eta \|\| ''\)\) continue;/);
});

test('the on-device estimate starts from where the crew is, not the depot', () => {
  assert.match(worklistJs, /function lastDonePin\(items\)/);
  // Latest completion wins — `updatedAt` is the stamp markWorklistDone writes.
  assert.match(worklistJs, /String\(b\.updatedAt \|\| ''\) > String\(a\.updatedAt \|\| ''\) \? b : a/);
  // Today only: an evening plan for tomorrow starts at the depot like any morning.
  assert.match(worklistJs, /planDay\(\) === localDate\(\) \? lastDonePin\(all\) : null/);
  assert.match(worklistJs, /here \|\| cachedCoord\('crewStartLat', 'crewStartLng'\)/);
  // Every caller hands over the FULL list, or the done orders it needs to locate
  // the crew are invisible to it — a one-argument call is the silent regression.
  const calls = [...worklistJs.matchAll(/(?<!function )estimateTravel\(/g)]
    .map(m => worklistJs.slice(m.index, m.index + 60));
  assert.ok(calls.length >= 3, `expected every estimateTravel call site, saw ${calls.length}`);
  for(const call of calls)
    assert.ok(call.includes(', items'), `${call.split('\n')[0]} must pass the full list too`);
});
