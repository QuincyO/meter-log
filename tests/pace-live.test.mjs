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
  assert.match(worklistJs, /const PACE_REFRESH_MS = 3 \* 60 \* 1000/);
  assert.match(worklistJs, /async function drivePace\(\)\{\s*await refreshPaceCache\(\);/);
  // Stamped before the await, or a slow call stacks up behind itself.
  assert.match(worklistJs, /paceCacheAt = now;[\s\S]{0,200}?await cacheRecentDays\(1\)/);
});

// ── the target is the denominator ───────────────────────────────────────────
test('paceContext carries the meters/day target into the projection', () => {
  assert.match(worklistJs, /target:\s*targetVal\(\),\s*\n\s*dayClosed:/);
});

test('the gauge reads short-of-target, and keeps the route shortfall as a footnote', () => {
  // est.target (meters/day) — never pace.target, which would collide with
  // est.paces.target, the finish-by horizon.
  assert.match(driveJs, /const target = est\.target \|\| 0/);
  assert.doesNotMatch(driveJs, /pace\.target\b/);
  assert.match(driveJs, /short of \$\{target\}/);
  assert.match(driveJs, /\$\{done\} of \$\{target\} installs/);
  assert.match(driveJs, /won.t fit/);
  // A day that beats its target must not run the bar off the end of the track.
  assert.match(driveJs, /Math\.min\(100, \(v \/ total\) \* 100\)/);
  // The renamed field: `delta` meant the route, and nothing may still read it.
  assert.doesNotMatch(driveJs, /pace\.delta/);
  assert.doesNotMatch(tuningJs, /\bt\.delta\b/);
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
