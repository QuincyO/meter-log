import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The installer's phone is the source of truth for route tuning + target. These
// assert the sync contract that carries them phone → sheet → planner: a plan-only
// write action, the target column, a Download-time push, and the guarantee that a
// Download never overwrites the installer's own tuning/target.
const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const worklist = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const planner = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');

test('the spine exposes a plan-only savePlan action', () => {
  assert.match(code, /case 'savePlan':\s*return json\(savePlan\(body\)\)/);
  assert.match(code, /function savePlan\(body\)\s*\{[\s\S]*saveWorklistPlan\(body\.hNumber, body\.plan/);
});

test('saveWorklistPlan persists the target column', () => {
  assert.match(code, /target:\s*\(\(\)\s*=>\s*\{[\s\S]*?Number\(plan\.target\)/);
});

test('the phone plan shape carries target and Download pushes it up', () => {
  assert.match(worklist, /target\s*:\s*targetVal\(\)/);
  // Plan-only push (never a whole-list saveWorklist, which would clobber the
  // ordering the phone is about to pull). It sends implicitPlan() — the plan
  // minus routeStartDate — see the two tests below.
  assert.match(worklist, /action\s*:\s*'savePlan'[\s\S]*plan\s*:\s*implicitPlan\(\)/);
});

// The OFFICE owns the route's calendar date (planner.html's "Route starts"); the
// phone owns tuning + target. Before the phone could plan a day other than today
// this never mattered — every push wrote the same derived date back. Now a phone
// planning tomorrow would re-date the planner's route on every logged stop, so the
// two IMPLICIT pushes drop the field and only the explicit ⇪ Upload carries it.
test('implicit pushes omit routeStartDate; the explicit Upload keeps it', () => {
  assert.match(worklist, /function implicitPlan\(\)\s*\{[\s\S]*?routeStartDate,\s*\.\.\.rest[\s\S]*?\}/);
  // The post-log sync and the Download-time savePlan both go through it.
  assert.equal((worklist.match(/plan\s*:\s*implicitPlan\(\)/g) || []).length, 2);
  // The explicit Upload still publishes the full plan, date included.
  assert.match(worklist, /async function wlUpload\(\)[\s\S]*?plan\s*:\s*savePlanLocal\(\)/);
});

test('the spine treats an absent routeStartDate as "keep", not "blank"', () => {
  // upsertByHeader leaves any header it is not handed exactly as it was, so the
  // field must be added conditionally rather than defaulted to ''.
  assert.match(code, /if \(plan\.routeStartDate\) fields\.routeStartDate = String\(plan\.routeStartDate\)/);
  assert.doesNotMatch(code, /routeStartDate:\s*plan\.routeStartDate \|\| ''/);
});

// `change` fires only on blur, and targetVal() reads the LIVE field — so a number
// typed and then abandoned (app backgrounded, screen closed with focus still in the
// box) built a route at the new target and restored the old one on the next open.
// Reported as "I set it to 20 and it isn't saving", with a route demonstrably built
// for 20. The store write has to hang off `input`, not `change` alone.
test('the meters/day target persists as it is typed, not only on blur', () => {
  assert.match(worklist, /\$\('wlTarget'\)\.oninput\s*=/,
    'wlTarget must persist on input — change alone loses an unblurred edit');
  const persist = /const persistTarget = \(\) => \{[\s\S]*?\n  \};/.exec(worklist);
  assert.ok(persist, 'persistTarget helper is still there');
  assert.match(persist[0], /store\.set\('wlTarget'/);
  // A blank or zero field must not be written — that is how the 24 default sneaks
  // back in over a real value mid-edit.
  assert.match(persist[0], /isFinite\(n\) && n > 0/);
});

// Storing the typed target was only half of it. Day 1 is today's committed set, and
// the only thing that re-commits it is needsCommit seeing `replan` — which, back then,
// only Optimize passed. Reported as "I can't even change the amount of orders that
// populate the list with the target value. They get stuck on a different value and
// never got updated." (At the time Day 1 was `min(dayCapacity + extend, |set|)`, so
// LOWERING the target did clamp the day through `capacity` while raising it moved
// nothing — a silently one-way control. That capacity clamp is gone: it was also what
// shuffled a committed day's tail into tomorrow. Now neither direction moves without
// this handler, which is why it has to keep passing `replan`.)
test('the meters/day target re-splits the days, not just the store', () => {
  const handler = /\$\('wlTarget'\)\.onchange = [\s\S]*?\n  \};/.exec(worklist);
  assert.ok(handler, 'wlTarget onchange handler is still there');
  assert.match(handler[0], /applyTodayAnchor\(\{[^}]*replan\s*:\s*true/,
    'the target box must pass replan — without it a RAISED target never unfreezes today');
  assert.match(handler[0], /renderWorklist\(\)/, 'the re-split has to reach the screen');
});

// Same lost-edit defect as the target, in the field beside it: planShape() and
// offerAddTo() read $('wlPace').value LIVE, but the write hung off `change`, which
// fires only on blur — so a pace typed and then abandoned shaped the route and was
// discarded. The blank branch is the other half: without it, clearing the box pinned
// paceMin at the flat 30 flagged 'override', and refreshAvgDay refuses to overwrite an
// override, so the installer's measured 30-workday pace could never come back. That
// recovery path is also what makes persisting on `input` safe.
test('the pace persists as it is typed, and a cleared box reverts to the measured pace', () => {
  assert.match(worklist, /\$\('wlPace'\)\.oninput\s*=/,
    'wlPace must persist on input — change alone loses an unblurred edit');
  const persist = /const persistPace = \(\) => \{[\s\S]*?\n  \};/.exec(worklist);
  assert.ok(persist, 'persistPace helper is still there');
  assert.match(persist[0], /store\.set\('wlPaceMin'/);
  // A blank/garbage field must write nothing — Number('') is 0, so the guard has to
  // sit on the RAW value, before any Math.max(1, …) clamp turns it into a real 1.
  assert.match(persist[0], /isFinite\(n\) && n > 0/);
  const onchange = /\$\('wlPace'\)\.onchange = \(\) => \{[\s\S]*?\n  \};/.exec(worklist);
  assert.ok(onchange, 'wlPace onchange handler is still there');
  assert.match(onchange[0], /wlPaceSource',\s*wlAvgLogMin \? 'recent30' : 'fallback'/,
    'a blank pace must revert to the MEASURED source, never stay an override');
});

test('a Download never overwrites the phone-owned tuning + target', () => {
  const fn = worklist.match(/function loadPlanFields\(plan\)\s*\{[\s\S]*?\n\}/)[0];
  for(const key of ['wlCommutePull', 'wlTarget'])
    assert.doesNotMatch(fn, new RegExp(key), `${key} must not be written from a downloaded plan`);
});

test('the planner consumes the installer target from a downloaded plan', () => {
  assert.match(planner, /target\s*:\s*targetVal\(\)/);
  assert.match(planner, /plTarget'\)\.value\s*=\s*String\([\s\S]*p\.target/);
});
