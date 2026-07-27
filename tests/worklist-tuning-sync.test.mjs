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

test('a Download never overwrites the phone-owned tuning + target', () => {
  const fn = worklist.match(/function loadPlanFields\(plan\)\s*\{[\s\S]*?\n\}/)[0];
  for(const key of ['wlCommutePull', 'wlFinishBy', 'wlTarget'])
    assert.doesNotMatch(fn, new RegExp(key), `${key} must not be written from a downloaded plan`);
});

test('the planner consumes the installer target from a downloaded plan', () => {
  assert.match(planner, /target\s*:\s*targetVal\(\)/);
  assert.match(planner, /plTarget'\)\.value\s*=\s*String\([\s\S]*p\.target/);
});
