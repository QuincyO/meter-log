// ── The Drive screen refreshes itself while the crew is driving ─────────────
// Nothing on that screen was ever on a clock: the only repaint driver is the GPS
// recorder's subscribe(), so the card and the ETAs froze the moment fixes stopped
// (a Google-Maps hand-off, GPS denied, a phone not recording) and only a trip back
// to the worklist to tap ⇩ Download would unfreeze them. These are the wiring
// assertions for the 3-minute automatic refresh that replaces that tap — the gate
// it runs behind, the clock, and the four things it must never do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const driveJs = readFileSync(new URL('../js/drive.js', import.meta.url), 'utf8');
const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

// The autoSync body, for the assertions that are about what it does NOT contain.
const autoSyncBody = (() => {
  const start = worklistJs.indexOf('export async function autoSync()');
  assert.ok(start > -1, 'worklist.js must export autoSync');
  const end = worklistJs.indexOf('\n}\n', start);
  return worklistJs.slice(start, end);
})();

// ── the gate ────────────────────────────────────────────────────────────────
test('the refresh runs only while driving, opted in, and on the Drive screen', () => {
  const gate = driveJs.slice(driveJs.indexOf('const autoSyncOn ='),
                             driveJs.indexOf('async function tickAutoSync'));
  // All three the driver asked for. isRecording() is the per-day per-device arm
  // state; showMetricsPref() is the #tuning opt-in that already gates the stats
  // HUD — consenting to see live driving numbers is what consents to fetching
  // them; openState is the screen actually being in front.
  assert.match(gate, /openState/);
  assert.match(gate, /isRecording\(\)/);
  assert.match(gate, /showMetricsPref\(\)/);
  // Plus the two the network demands: a backgrounded tab's timers are unreliable
  // and its fetch is wasted, and an offline fetch is a guaranteed failure.
  assert.match(gate, /document\.visibilityState === 'visible'/);
  assert.match(gate, /navigator\.onLine/);
  // The gate is re-read on every tick, never captured once at open().
  assert.match(driveJs, /if\(!opts\.autoSync \|\| !autoSyncOn\(\)\) return;/);
});

// ── the clock ───────────────────────────────────────────────────────────────
test('three minutes is the period, and a slow refresh cannot stack up', () => {
  assert.match(driveJs, /const AUTO_SYNC_MS = 3 \* 60 \* 1000/);
  // The tick cadence is retry granularity, NOT the period — a tick that lands
  // while the driver is in Maps must cost seconds of staleness, not a whole
  // further period. The three minutes live in the timestamp throttle.
  assert.match(driveJs, /const AUTO_SYNC_TICK_MS = 30 \* 1000/);
  assert.match(driveJs, /if\(syncBusy \|\| now - syncAt < AUTO_SYNC_MS\) return;/);
  // Stamped BEFORE the await, or a refresh on a weak signal queues behind itself
  // — the same trap refreshPaceCache carries (tests/pace-live.test.mjs).
  assert.match(driveJs, /syncAt = now;[\s\S]{0,300}?await opts\.autoSync\(\)/);
});

test('the interval never outlives the screen', () => {
  // drive.js already leaks one listener (`unsub`, never released); a timer that
  // survives the screen would fetch on behalf of a screen nobody is looking at.
  const close = driveJs.slice(driveJs.indexOf('async function close()'),
                              driveJs.indexOf('async function teardown()'));
  const teardown = driveJs.slice(driveJs.indexOf('async function teardown()'));
  assert.match(close, /stopAutoSync\(\)/);
  assert.match(teardown, /stopAutoSync\(\)/);
  assert.match(driveJs, /clearInterval\(syncTimer\); syncTimer = null;/);
  assert.match(driveJs, /if\(!syncTimer\) syncTimer = setInterval\(tickAutoSync, AUTO_SYNC_TICK_MS\)/);
});

// ── what the refresh must not do ────────────────────────────────────────────
test('a timer never talks to the driver and never touches the capture form', () => {
  // A "Download failed — check signal" popping every few minutes through a dead
  // zone is worse than the staleness it reports, and there is nobody to answer a
  // confirm() at 80 km/h. Every failure path here keeps the last good copy silently.
  assert.doesNotMatch(autoSyncBody, /\btoast\(/);
  assert.doesNotMatch(autoSyncBody, /\bconfirm\(/);
  // planAdvance ends in fillCapture — a background timer must never overwrite a
  // half-typed capture form. Plan mode re-advances on the next logged stop.
  assert.doesNotMatch(autoSyncBody, /planAdvance\(/);
  // Nothing changed locally, and this runs all day: no write back up to the sheet.
  assert.doesNotMatch(autoSyncBody, /savePlan/);
});

test('an order finished on this phone is never resurrected by the pull', () => {
  // syncWorklist() pushes the phone's list up only right after a log and no-ops
  // offline, and nothing re-runs it on reconnect — so a stop logged in a dead zone
  // leaves the sheet saying `pending` long after the meter reached the Stops tab.
  // Unguarded, the automatic pull sends the driver back to a house they already did.
  assert.match(autoSyncBody, /applyDownloadedList\(r\.orders \|\| \[\], \{ preserveDone: true \}\)/);
  // The manual Download keeps taking the sheet verbatim — the installer asked for
  // it, was warned by the confirm, and can see what landed.
  assert.match(worklistJs, /applyDownloadedList\(r\.orders \|\| \[\], \{ preserveDone: false \}\)/);
  const apply = worklistJs.slice(worklistJs.indexOf('async function applyDownloadedList'),
                                 worklistJs.indexOf('async function wlDownload'));
  // Read before the store is wiped, or there is nothing left to preserve.
  const read = apply.indexOf('doneIds.add');
  const wipe = apply.indexOf("idb.del('worklist', k)");
  assert.ok(read > -1 && wipe > -1 && read < wipe,
    'the done ids must be collected before the local store is cleared');
  assert.match(apply, /wlStatus: \(o\.wlStatus === 'done' \|\| doneIds\.has\(String\(o\.id\)\)\) \? 'done' : 'pending'/);
});

test('the pull is skipped while this phone is ahead of the sheet', () => {
  // An un-drained queue means logs that have not landed: the Worklist rows up
  // there describe a day that has moved on. The stops + re-anchor half still runs.
  assert.match(autoSyncBody, /const queued = \(\(await idb\.all\('queue'\)\) \|\| \[\]\)\.length;/);
  assert.match(autoSyncBody, /if\(!queued\)\{/);
  const guard = autoSyncBody.indexOf('if(!queued)');
  const anchor = autoSyncBody.indexOf('await applyTodayAnchor()');
  assert.ok(anchor > guard, 'the re-anchor must run whether or not the pull did');
});

// ── the half that actually fixes the times ──────────────────────────────────
test('the refresh re-anchors, and pulls today down before it does', () => {
  // applyTodayAnchor is what re-runs scheduleRouteConstraints and rewrites
  // order/day/scheduledEta — it is why a manual Download "fixes the times" while a
  // plain day-cache refresh does not. Pulling the list alone would fix nothing.
  const refresh = autoSyncBody.indexOf('cacheRecentDays(1)');
  const anchor = autoSyncBody.indexOf('await applyTodayAnchor()');
  assert.ok(refresh > -1, 'autoSync must refresh the day cache');
  assert.ok(anchor > -1, 'autoSync must re-anchor, or the ETAs never move');
  // Same ordering wlDownload is pinned to: the pace projection and the re-plan bound
  // both read the cache, so anchoring first would work off a stale copy.
  assert.ok(refresh < anchor, 'the refresh must land before applyTodayAnchor');
});

// ── the tick RE-TIMES the day; it must never RE-SIZE it ─────────────────────
// The installer works two devices: a work phone that logs each install and pushes the
// completed work order to the sheet, and this one, which pulls a refreshed list every
// few minutes and re-prices the rest of the day off the real finish times. That is
// the feature. What it must not do is move work between days — and it used to, on
// every tick, because Day 1 was re-sized to `min(dayCapacity + extend, |set|)` and the
// meters the work phone logged kept shrinking the capacity half. Reported as *"the
// next day's work orders are shuffling up every time"*.
test('a tick re-times the day without re-sizing it', () => {
  // Locked, Day 1 is the frozen set entire — nothing capacity-shaped reaches it.
  assert.match(worklistJs, /return day1Count\(anchorDay1Ids\(a, pending\)\);/);
  assert.doesNotMatch(worklistJs, /day1Count\(anchor,/);
  // …and UNLOCKED it holds the day as tagged rather than re-chunking from the front
  // of pending. That is the case this tick actually lands in most often: a crew that
  // simply has not pressed 🔒 must not watch tomorrow's orders climb into today on a
  // three-minute timer. Only a deliberate act re-chunks, and this is not one — autoSync
  // passes no opts at all.
  assert.match(worklistJs,
    /const fits = \(!locked && opts && opts\.rechunk\) \? null : currentDay1Count\(pending\);/);
  assert.doesNotMatch(autoSyncBody, /applyTodayAnchor\(\s*\{/);
});

test('a tick still learns what the work phone finished', () => {
  // The one shrink that stays: an order logged on the OTHER phone comes back
  // `wlStatus:'done'` and drops out of anchorDay1Ids, so Day 1 gets shorter by
  // completion. Without preserveDone the replace would also have to not lose the
  // completions this phone already knew about.
  assert.match(autoSyncBody, /applyDownloadedList\(r\.orders \|\| \[\], \{ preserveDone: true \}\)/);
  assert.match(worklistJs, /wlStatus: \(o\.wlStatus === 'done' \|\| doneIds\.has\(String\(o\.id\)\)\) \? 'done' : 'pending'/);
  // The anchor holds ids and lives in localStorage, so it survives the wholesale
  // rewrite of the worklist store that the pull performs. If ids stopped round-
  // tripping verbatim, today's set would be lost on the first tick of every day.
  assert.match(worklistJs, /idb\.put\('worklist', \{\s*\n\s*id:String\(o\.id\)/);
});

test('the two refresh clocks agree', () => {
  // PACE_REFRESH_MS is the GPS-fix-driven pull — a side effect of a repaint, so it
  // stalls exactly when autoSync is needed most. Two periods would be two clocks
  // disagreeing about how fresh "fresh" is.
  assert.match(worklistJs, /const PACE_REFRESH_MS = 3 \* 60 \* 1000/);
});

// ── the card holds still ────────────────────────────────────────────────────
test('a background refresh cannot swap the card under the driver', () => {
  // `idx` is a bare position and the list is re-ordered by every re-anchor, so
  // without matching the same order back the card silently becomes a different
  // house mid-drive. destKey is the existing WO#-else-address identity.
  assert.match(driveJs, /const was = pending\[idx\];/);
  assert.match(driveJs, /const again = was \? pending\.findIndex\(p => destKey\(p\) === destKey\(was\)\) : -1;/);
  assert.match(driveJs, /if\(again >= 0\) idx = again;/);
  // The positional clamp stays as the fallback for an order that is gone (logged
  // or archived) — which is what the post-log refresh wants anyway.
  assert.match(driveJs, /if\(idx >= pending\.length\) idx = Math\.max\(0, pending\.length - 1\);/);
});

test('opening the screen still starts at the top of the route', () => {
  // `idx = 0` and the card-holding match in refresh() pull opposite ways: left
  // holding the previous session's snapshot, re-entering Drive would restore the
  // last-viewed order over the reset. open() drops the snapshot first.
  const open = driveJs.slice(driveJs.indexOf('async function open()'),
                             driveJs.indexOf('async function close()'));
  const reset = open.indexOf('idx = 0;');
  const drop = open.indexOf('pending = [];');
  const refresh = open.indexOf('await refresh()');
  assert.ok(reset > -1 && drop > -1 && refresh > -1, 'open() must reset idx, drop pending, then refresh');
  assert.ok(drop > reset && drop < refresh, 'the snapshot must be dropped before refresh() reads it');
});
