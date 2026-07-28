import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROUTE_DEPART_TIME } from '../js/config.js';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const plannerJs = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');
const plannerHtml = readFileSync(new URL('../planner.html', import.meta.url), 'utf8');

test('config exposes the org-wide departure time', () => {
  assert.equal(ROUTE_DEPART_TIME, '08:15');
});

test('the phone worklist no longer renders the route-start / first-stop inputs', () => {
  assert.doesNotMatch(indexHtml, /id="wlRouteDate"/);
  assert.doesNotMatch(indexHtml, /id="wlRouteTime"/);
});

test('the phone plan anchors first-stop time to the departure constant', () => {
  assert.match(worklistJs, /import\s*\{[^}]*\bROUTE_DEPART_TIME\b[^}]*\}\s*from\s*'\.\/config\.js'/);
  assert.match(worklistJs, /firstStopTime:\s*ROUTE_DEPART_TIME/);
  assert.doesNotMatch(worklistJs, /\$\('wlRouteDate'\)/);
  assert.doesNotMatch(worklistJs, /\$\('wlRouteTime'\)/);
});

// 08:15 is where the day STARTS, not where every re-solve of it starts. A route
// re-optimized at 11:40 from where the crew is standing has to depart at 11:40, or
// every ETA on it is a morning ETA — reported from the field as "it always begins
// from 8:15 and never takes into account what time it is now".
test('the day-1 clock follows the crew, and only when it is the crew standing there', () => {
  // The rule is about the ANCHOR: the muster point is a morning anchor and keeps
  // the constant; "start from here" and every rolling in-day re-schedule do not.
  assert.match(worklistJs, /function day1DepartTime\(fromCurrent\)/);
  assert.match(worklistJs, /if\(!fromCurrent \|\| planDay\(\) !== localDate\(\)\) return ''/);
  // Only ever forward — a run before 08:15 keeps the constant.
  assert.match(worklistJs, /hhmmMin\(now\) > hhmmMin\(ROUTE_DEPART_TIME\) \? now : ''/);
  // Optimize passes the START-LOCATION answer, never a bare true.
  assert.match(worklistJs, /day1FirstStopTime:\s*day1DepartTime\(startFromCurrent\)/);
  // The re-schedule after every logged stop is by definition where the crew is.
  assert.match(worklistJs, /day1FirstStopTime:\s*day1DepartTime\(true\)/);
});

// The office plans ahead — its route starts on the date its own picker names, so a
// desk clock must never leak into it.
test('the desktop planner keeps the constant and gains no day-1 clock', () => {
  assert.doesNotMatch(plannerJs, /day1FirstStopTime/);
});

test('the phone reads its dial and feeds it into optimize', () => {
  assert.match(worklistJs, /commutePull:\s*pullVal\(store\.get\('wlCommutePull'\)\)/);
  assert.match(worklistJs, /optimizeRoute\([^;]*\bcommutePull:\s*planShape\(\)\.commutePull/s);
});

// The finish-by clock no longer sizes a day: the meters/day target is the only
// input, so a target above the old ceiling stops being silently inert. The clock
// that survives is a CONSTANT answering one unrelated question — is today over,
// for the plan day — and it must never reach optimizeRoute.
test('no finish-by clock reaches the router from either caller', () => {
  for(const src of [worklistJs, plannerJs]){
    assert.doesNotMatch(src, /dayFinishBy/);
    assert.doesNotMatch(src, /wlFinishBy|plannerFinishBy/);
  }
  assert.match(worklistJs, /import\s*\{[^}]*\bROUTE_DAY_END\b[^}]*\}\s*from\s*'\.\/config\.js'/);
});

test('the planner drops its first-stop input and uses the departure constant', () => {
  assert.doesNotMatch(plannerHtml, /id="plRouteTime"/);
  assert.match(plannerHtml, /id="plRouteDate"/); // the office still picks a start date
  assert.match(plannerJs, /import\s*\{[^}]*\bROUTE_DEPART_TIME\b[^}]*\}\s*from\s*'\.\.\/config\.js'/);
  assert.match(plannerJs, /firstStopTime:\s*ROUTE_DEPART_TIME/);
  assert.doesNotMatch(plannerJs, /\$\('plRouteTime'\)/);
});

test('the planner silently consumes the synced dials without adding UI', () => {
  assert.match(plannerJs, /commutePull:\s*pullVal\(store\.get\('plannerCommutePull:'\s*\+\s*hNumber\(\)\)\)/);
  assert.match(plannerJs, /optimizeRoute\([^;]*\bcommutePull:\s*planShape\(\)\.commutePull/s);
  // no dial inputs leak into the office UI
  assert.doesNotMatch(plannerHtml, /id="plCommutePull"/);
  assert.doesNotMatch(plannerHtml, /id="plFinishBy"/);
});
