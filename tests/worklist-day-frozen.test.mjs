// ── The day the installer committed to is the day they get ──────────────────
// *"I download the WORK list when I start my day, I say that I'm going to do X …
//  I would like the WORK list to stay at that unless I manually add more for the
//  same day. I don't want to shuffle the tail down to the next day, and I don't want
//  to shuffle the next day into the end of today. I only want to manually add days or
//  work orders to today's day, not automatically."*
//
// The today anchor (js/route-today.js) always FROZE which orders are today; what it
// did not do is leave the size alone. Two rules re-sized it behind the installer's
// back, and the Drive screen's 5-minute refresh re-ran both on a timer:
//   • Day 1 was `min(dayCapacity(target, installedToday) + anchor.extend, |set|)`.
//     The target counts METERS and the set counts ORDERS, so a two-meter order or a
//     walk-up logged off-plan spent the room faster than it spent the list, and the
//     tail was stamped day 2 mid-morning. Target met with orders left ⇒ capacity 0 ⇒
//     the whole remainder declared tomorrow's;
//   • `needsCommit` re-committed the moment the set emptied, hauling the next chunk
//     up into today.
// The arithmetic lives in tests/route-today.test.mjs. These are the wiring
// assertions — the call sites that are, and are not, allowed to move the day.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const routeTodayJs = readFileSync(new URL('../js/route-today.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// ── who may re-size the day ─────────────────────────────────────────────────
test('exactly two call sites ask applyTodayAnchor to re-plan', () => {
  // `replan` is the whole unfreeze key (js/route-today.js needsCommit). Optimize and
  // the meters/day box are deliberate presses; everything else — a logged stop, a
  // Download, first view, markWorklistDone, resetWorklistOrder, the plan-date change,
  // and the Drive screen's 5-minute autoSync — passes nothing and must keep doing so.
  const calls = worklistJs.match(/applyTodayAnchor\(\{[^}]*\}\)/g) || [];
  assert.equal(calls.length, 2, `only Optimize and the target box may re-plan; found ${calls}`);
  assert.ok(calls.some(c => /travel, replan: true/.test(c)), 'the Optimize press');
  assert.ok(calls.some(c => /replan: true, resize: true/.test(c)), 'the meters/day box');
});

test('a spent day can still be re-planned by hand, target met or not', () => {
  // `capacity > 0` guards the target-change commit against freezing an EMPTY set.
  // A day whose set is EXHAUSTED needs no such guard (only midReplan passes opts.max,
  // and midReplan cannot fire on a spent set) — and without the exemption an installer
  // who met the target and finished every order had no way to ask for more work at
  // all, which is the one thing the Optimize press has to be able to mean.
  assert.match(worklistJs,
    /const replan = Boolean\(opts && opts\.replan\) && \(freeReplan \|\| exhausted \|\| capacity > 0\);/);
  assert.match(worklistJs, /const midReplan = !freeReplan && anchor && anchor\.date === today && !exhausted;/);
});

// ── nothing else may ────────────────────────────────────────────────────────
test('Day 1 is the committed set entire — no capacity, no extend', () => {
  assert.match(worklistJs, /const fits = day1Count\(day1\);/);
  assert.match(routeTodayJs, /export function day1Count\(day1Ids\)\{\s*\n\s*return \(day1Ids \|\| \[\]\)\.length;/);
  // The override that existed only to buy room back from the clamp.
  assert.doesNotMatch(routeTodayJs, /anchorExtend/);
  assert.doesNotMatch(worklistJs, /\bextend\s*:/);
});

test('dayCapacity survives for one job only: bounding a re-plan it was asked for', () => {
  // Every other reader is gone. If this count moves, something is sizing the day by
  // meters again — which is the defect, wearing a new name.
  const uses = worklistJs.match(/dayCapacity\(/g) || [];
  assert.equal(uses.length, 1, `dayCapacity may only bound midReplan; found ${uses.length} uses`);
  assert.match(worklistJs, /freshAnchorIds\(pending, target, \{ max: midReplan \? capacity : null, fromTags \}\)/);
});

test('finishing today’s last order does not pull tomorrow’s work up', () => {
  assert.match(routeTodayJs,
    /if\(anchorDay1Ids\(anchor, pending\)\.length === 0\) return Boolean\(opts && opts\.replan\);/);
  // markWorklistDone is the path that used to trip it — every logged stop lands here.
  const done = worklistJs.slice(worklistJs.indexOf('export async function markWorklistDone'));
  assert.match(done.slice(0, 900), /await applyTodayAnchor\(\);/);
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

test('a FINISHED day still gets the add sheet', () => {
  // It used to bail on an empty day 1, which was safe only while an exhausted anchor
  // re-committed itself and swept the new order into today anyway. It does not any
  // more, so bailing would send a hand-typed order silently to tomorrow — and adding
  // by hand is now the only way work joins a day that is already under way.
  const offer = worklistJs.slice(worklistJs.indexOf('async function offerAddTo()'),
                                 worklistJs.indexOf('async function acceptAddTo()'));
  assert.match(offer, /if\(!\(anchor && anchor\.date === planDay\(\)\)\)\{ hideAddTo\(\); return; \}/);
  assert.doesNotMatch(offer, /if\(!day1\.length\)/);
});
