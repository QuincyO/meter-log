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
  // ordering the phone is about to pull).
  assert.match(worklist, /action\s*:\s*'savePlan'[\s\S]*plan\s*:\s*savePlanLocal\(\)/);
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
