// ── The day the installer LOCKED is the day they get ────────────────────────
// *"I download the WORK list when I start my day, I say that I'm going to do X …
//  I would like the WORK list to stay at that unless I manually add more for the
//  same day. I don't want to shuffle the tail down to the next day, and I don't want
//  to shuffle the next day into the end of today. I only want to manually add days or
//  work orders to today's day, not automatically."*
//
// That was answered first by a today anchor that tried to INFER when the installer
// meant to re-plan — from a target change, an Optimize press, a day roll and an
// exhausted set, with a `dayCapacity` bound and a `fromTags` flag holding the
// inference together. Every piece of it was a correct fix to a real report and the
// installer still could not answer "is my day settled right now, and what do I press
// to change it?" It is a 🔓/🔒 toggle now:
//
//   🔓 the meters/day target sizes every day — but only when a DELIBERATE act asks;
//   🔒 day 1 is frozen exactly as it stands, and only "Add to today" grows it.
//
// The arithmetic lives in tests/route-today.test.mjs. These are the wiring
// assertions — the call sites that are, and are not, allowed to move the day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const routeTodayJs = readFileSync(new URL('../js/route-today.js', import.meta.url), 'utf8');
const plannerJs = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const plannerHtml = readFileSync(new URL('../planner.html', import.meta.url), 'utf8');

// ── the inference is gone, not renamed ──────────────────────────────────────
test('nothing infers when to re-freeze the day any more', () => {
  // `needsCommit`, `dayCapacity`, `opts.replan`, `opts.resize` and `freshAnchorIds`'
  // `opts.max`/`opts.fromTags` were all one mechanism: guessing intent. If any of
  // them comes back, so does the question the toggle exists to answer.
  for(const gone of ['needsCommit', 'dayCapacity', 'fromTags', 'anchorExtend']){
    assert.doesNotMatch(routeTodayJs, new RegExp(`export function ${gone}\\b`), gone);
  }
  assert.doesNotMatch(worklistJs, /\bdayCapacity\(/);
  assert.doesNotMatch(worklistJs, /\bneedsCommit\(/);
  // The prose still names them (that history is why the toggle exists); the CODE
  // must not read them.
  assert.doesNotMatch(worklistJs, /opts && opts\.(replan|resize)/);
  assert.doesNotMatch(worklistJs, /\b(replan|resize): true/);
  assert.doesNotMatch(worklistJs, /\bextend\s*:/);
});

// ── who may re-size the day ─────────────────────────────────────────────────
test('exactly one call site asks applyTodayAnchor to re-chunk', () => {
  // Nothing has re-solved the route when the meters/day box changes, so the `day`
  // tags still describe the OLD number — holding them (what every other caller does)
  // would make a changed target do nothing at all, in either direction. Optimize
  // rewrites every tag at the new target moments before it calls, so holding them
  // there IS the fresh split and it must NOT pass this.
  const calls = worklistJs.match(/applyTodayAnchor\(\{[^}]*\}\)/g) || [];
  const rechunk = calls.filter(c => /rechunk/.test(c));
  assert.equal(rechunk.length, 1, `only the meters/day box may re-chunk; found ${calls}`);
  const optimize = calls.filter(c => /travel/.test(c) && !/rechunk/.test(c));
  assert.equal(optimize.length, 1, 'the Optimize press passes travel and nothing else');
});

test('a passive re-schedule holds the day it found — unlocked included', () => {
  // applyTodayAnchor runs after EVERY logged stop (planAdvance), on the Drive
  // screen's 3-minute autoSync, on Download and at boot. If those re-chunked from
  // the front of `pending`, an installer who simply had not pressed 🔒 would watch
  // tomorrow's orders climb into today as they worked — the original report, back
  // again, and on a timer.
  assert.match(worklistJs,
    /const fits = \(!locked && opts && opts\.rechunk\) \? null : currentDay1Count\(pending\);/);
  const fn = worklistJs.slice(worklistJs.indexOf('function currentDay1Count'));
  assert.match(fn.slice(0, 900), /const tagged = taggedDay1Ids\(pending\);/);
  assert.match(fn.slice(0, 900), /if\(!dayLocked\(\)\) return fallback;/);
});

test('every path that re-schedules the pending list carries day1Count', () => {
  // The variant switch and the drag write-back both call scheduleRouteConstraints on
  // their own. While they omitted it the lock leaked: flipping road↔straight, or
  // dragging one card, silently re-chunked day 1 back to a full target.
  const uses = worklistJs.match(/day1Count: currentDay1Count\(/g) || [];
  assert.equal(uses.length, 2, `switchVariant + persistOrderIds; found ${uses.length}`);
  assert.match(plannerJs, /day1Count: plDay1Count\(\)/);
});

// ── the frozen set ──────────────────────────────────────────────────────────
test('Day 1 is the locked set entire — no capacity, no extend', () => {
  assert.match(worklistJs, /return day1Count\(anchorDay1Ids\(a, pending\)\);/);
  assert.match(routeTodayJs, /export function day1Count\(day1Ids\)\{\s*\n\s*return \(day1Ids \|\| \[\]\)\.length;/);
});

test('the lock is one date, and a new plan day releases it', () => {
  assert.match(worklistJs, /function dayLocked\(\)\{[\s\S]{0,200}?=== planDay\(\);/);
  // The leftovers are cleared too, so nothing downstream can find a lock date and a
  // frozen set describing a day nobody is driving any more.
  assert.match(worklistJs, /function releaseStaleDayLock\(planDay\)\{/);
  assert.match(worklistJs, /releaseStaleDayLock\(_planDay\.date\);/);
});

test('the press is the only commit, and it snapshots what is on screen', () => {
  const set = worklistJs.slice(worklistJs.indexOf('async function setDayLocked'));
  assert.match(set.slice(0, 700), /saveAnchor\(\{ date: day, ids: freshAnchorIds\(pending, target\), target \}\)/);
  assert.match(set.slice(0, 700), /store\.set\('wlDayLock', day\)/);
});

test('a phone that was mid-day when this shipped keeps its day', () => {
  // Before the toggle, a committed anchor for the plan day WAS the frozen day. Without
  // the carry-across, the deploy itself would soften a day the crew was driving.
  // Keyed on a one-shot marker, never on "wlDayLock is blank" — blank is the real
  // unlocked state, so migrating off it would re-lock on every reload after an unlock.
  assert.match(worklistJs, /function migrateLegacyLock\(\)\{/);
  assert.match(worklistJs, /if\(store\.get\('wlDayLockMigrated'\)\) return;/);
  assert.match(worklistJs, /await refreshPlanDay\(\);\n\s*migrateLegacyLock\(\);/);
});

test('finishing the locked day’s last order does not pull tomorrow’s work up', () => {
  // markWorklistDone is the path that used to trip it — every logged stop lands here,
  // and it must pass nothing.
  const done = worklistJs.slice(worklistJs.indexOf('export async function markWorklistDone'));
  assert.match(done.slice(0, 900), /await applyTodayAnchor\(\);/);
});

// ── the toggle itself ───────────────────────────────────────────────────────
test('both surfaces carry a day-lock control, distinct from the per-order lock', () => {
  // The per-order 🔒 (lockedDate/lockedSlot) pins ONE stop to a date and slot. Same
  // glyph, entirely different job — so the day lock never borrows its class.
  assert.match(indexHtml, /id="wlDayLock"[^>]*aria-pressed/);
  assert.match(indexHtml, /class="[^"]*\bwl-daylock\b/);
  assert.doesNotMatch(indexHtml, /class="[^"]*\bwl-lock\b[^"]*"[^>]*id="wlDayLock"/);
  assert.match(plannerHtml, /id="plDayLock"[^>]*aria-pressed/);
  assert.match(plannerHtml, /class="[^"]*\bpldaylock-btn\b/);
});

test('the locked states name themselves in words, not just a glyph', () => {
  assert.match(worklistJs, /🔒 Work list locked/);
  assert.match(worklistJs, /🔓 Work list unlocked/);
  assert.match(plannerJs, /🔒 Day 1 locked/);
  assert.match(plannerJs, /🔓 Day 1 is open/);
});

test('the target and the plan day go read-only under the lock — and are enforced', () => {
  // `readOnly` is the affordance; a number input's spinner and a date input's picker
  // both ignore it on some browsers, so the handlers are the actual guard.
  assert.match(worklistJs, /el\.readOnly = on;/);
  const target = worklistJs.slice(worklistJs.indexOf("$('wlTarget').onchange"));
  assert.match(target.slice(0, 500), /if\(dayLocked\(\)\)\{/);
  const planDate = worklistJs.slice(worklistJs.indexOf('async function planDateChanged'));
  assert.match(planDate.slice(0, 600), /if\(dayLocked\(\)\)\{/);
});

// ── the manual add ──────────────────────────────────────────────────────────
test('the add sheet offers two answers, and neither one rolls a stop out', () => {
  assert.match(indexHtml, /id="wlAddToExtend"/);
  assert.match(indexHtml, /id="wlAddToLater"/);
  // "Add to today, keep the day's size" rolled the tail to tomorrow on a tap. That is
  // the reported behaviour with a button in front of it.
  assert.doesNotMatch(indexHtml, /wlAddToSwap/);
  assert.doesNotMatch(worklistJs, /wlAddToSwap/);
  assert.match(worklistJs, /\$\('wlAddToExtend'\)\.onclick = \(\) => acceptAddTo\(\);/);
  assert.match(worklistJs, /async function acceptAddTo\(\)\{/);
});

test('the add sheet appears only under the lock — and a FINISHED locked day gets it', () => {
  // Unlocked there is nothing to join and nothing to protect, so asking would be a
  // question with no consequence attached to either answer. A spent locked day still
  // gets it: nothing re-commits now, so bailing on an empty day 1 would send a
  // hand-typed order silently to tomorrow.
  const offer = worklistJs.slice(worklistJs.indexOf('async function offerAddTo('),
                                 worklistJs.indexOf('async function acceptAddTo()'));
  assert.match(offer, /if\(!dayLocked\(\) \|\| !anchor\)\{ hideAddTo\(\); return; \}/);
  assert.doesNotMatch(offer, /if\(!day1\.length\)/);
});

test('an office Download asks rather than overriding a locked day — and never mid-drive', () => {
  // adoptPlannerDay1 used to fold the office's whole day 1 in without asking. The
  // lock reverses that. But it also runs on autoSync, whose whole contract is that it
  // never speaks — there is nobody to answer a prompt at 80 km/h.
  const adopt = worklistJs.slice(worklistJs.indexOf('async function adoptPlannerDay1'));
  assert.match(adopt.slice(0, 1600), /if\(!dayLocked\(\)\) return;/);
  assert.match(adopt.slice(0, 1600), /if\(!\(opts && opts\.interactive\)\) return;/);
  assert.match(worklistJs, /await adoptPlannerDay1\(r\.plan, \{ interactive: true \}\);/);
  const autoSync = worklistJs.slice(worklistJs.indexOf('export async function autoSync'));
  assert.match(autoSync.slice(0, 1400), /await adoptPlannerDay1\(r\.plan\);/);
});
