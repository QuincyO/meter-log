import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The desktop planner's ETAs start from the picked installer's usual first-stop
// ARRIVAL, the same clock the phone uses, so an office-planned list and the phone
// agree. planner.js needs a DOM and an admin login, so like the phone's
// tests/worklist-usual-start.test.mjs these pin the source text; the scheduler half
// is pinned behaviourally in tests/route-constraints*.test.mjs and the clock itself
// in usualStartClock's tests.
const js = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');

// One function's own text: from its declaration to the brace that closes its body.
function sourceOf(name){
  const m = new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\(`).exec(js);
  assert.ok(m, `function ${name} not found`);
  const open = js.indexOf('{', js.indexOf(')', m.index));
  let depth = 0;
  for(let i = open; i < js.length; i++){
    if(js[i] === '{') depth++;
    else if(js[i] === '}' && --depth === 0) return js.slice(m.index, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// The name of the function a source offset sits inside, and that function's text.
function enclosingFunction(at){
  const re = /\n(?:export )?(?:async )?function (\w+)\(/g;
  let name = null, m;
  while((m = re.exec(js)) && m.index < at) name = m[1];
  return name ? sourceOf(name) : '';
}

// Code only: a comment that names ROUTE_DEPART_TIME is not a reader of it.
const code = js.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

test('the planner plan starts on the usual start, as an arrival', () => {
  const src = sourceOf('planShape');
  assert.match(src, /firstStopTime:\s*usualStart\(\)/);
  assert.match(src, /firstStopArrival:\s*true/);
  assert.doesNotMatch(src, /ROUTE_DEPART_TIME/);
});

test('the usual start comes from usualStartClock through the namespace, on this installer\'s dwell base', () => {
  assert.doesNotMatch(js, /import \{[^}]*usualStartClock[^}]*\} from '\.\.\/route-constraints\.js'/);
  const src = sourceOf('usualStart');
  assert.match(src, /typeof routeConstraints\.usualStartClock !== 'function'/);
  assert.match(src, /routeConstraints\.usualStartClock\(usualFirstLogMin, dwellShape\(\)\.base, fallback\)/);
});

test('the fallback start comes through the config namespace with the literal behind it', () => {
  assert.match(js, /import \* as conf from '\.\.\/config\.js';/);
  assert.doesNotMatch(js, /import \{[^}]*ROUTE_USUAL_START[^}]*\} from '\.\.\/config\.js'/);
  assert.match(sourceOf('usualStart'), /const fallback = conf\.ROUTE_USUAL_START \|\| '09:30';/);
});

test('the metrics read keeps the picked installer\'s usual first log beside the cadence', () => {
  const src = sourceOf('showAvgDay');
  // Cleared with the cadence before the read, so a pending or failed read plans on
  // the 09:30 fallback rather than the previous installer's start.
  assert.match(src, /avgLogMin = null; avgPerDay = null; onSiteMin = null; extraMeterMin = null; usualFirstLogMin = null;/);
  // An older spine omits the field: numOrNull turns that into null, the fallback.
  assert.match(src, /usualFirstLogMin = numOrNull\(m\.usualFirstLogMin\);/);
  // A reply for an installer who is no longer picked must not land on the one who is.
  const awaitAt = src.indexOf("await apiGet('installerMetrics'");
  assert.ok(awaitAt > 0);
  assert.match(src.slice(awaitAt), /^[^\n]*\n\s*if\(hNumber\(\) !== h\) return;/);
  assert.match(js, /\nlet usualFirstLogMin = null;/);
});

test('dwellShape no longer reaches planShape, so usualStart cannot recurse', () => {
  // planShape -> usualStart -> dwellShape; if dwellShape still called planShape
  // the page would overflow the stack on the first render.
  assert.doesNotMatch(sourceOf('dwellShape'), /planShape\(\)/);
  assert.match(sourceOf('dwellShape'), /paceMin:\s*paceVal\(\)/);
  assert.match(sourceOf('planShape'), /paceMin:\s*paceVal\(\)/);
});

test('ROUTE_DEPART_TIME is no longer the schedule\'s clock: only optimizeRoute\'s departMin names it', () => {
  const uses = [...code.matchAll(/\bROUTE_DEPART_TIME\b/g)];
  // the import, and departMin
  assert.equal(uses.length, 2);
  assert.match(code, /import \{ ROUTE_DEPART_TIME \} from '\.\.\/config\.js';/);
  assert.match(code, /departMin:\s*departMinutes\(ROUTE_DEPART_TIME\)/);
  // The usual start is an arrival clock; its 08:00-08:30 departure clamp would turn
  // it into a muster time, so departMinutes never reads the plan's firstStopTime.
  assert.doesNotMatch(code, /departMinutes\(planShape\(\)\.firstStopTime\)/);
});

test('every scheduler call on the planner spreads planShape, so none can miss the flag', () => {
  const calls = [...js.matchAll(/\b(scheduleRouteConstraints|applyVariant)\(/g)]
    // the import lists name both without calling them
    .filter(m => !/import\s*\{[^}]*$/.test(js.slice(Math.max(0, m.index - 400), m.index)));
  // Optimize's per-variant loop and switchVariant. A third call has to be read here
  // before this number moves.
  assert.equal(calls.length, 2);
  for(const m of calls){
    const args = js.slice(m.index, js.indexOf(');', m.index));
    if(/\.\.\.planShape\(\)/.test(args)) continue;
    // Optimize builds its options once, as `planOpts`, and reuses them per variant.
    assert.match(args, /\bplanOpts\b/, `${m[1]} call without planShape: ${args.slice(0, 80)}`);
    assert.match(enclosingFunction(m.index), /const planOpts = \{ \.\.\.planShape\(\)/);
  }
});

test('firstStopArrival is not a sheet field: the upload drops it', () => {
  const src = sourceOf('upload');
  assert.match(src, /const \{ firstStopArrival, \.\.\.plan \} = planShape\(\);/);
  assert.match(src, /orders: items\.map\(wireShape\), plan \}\)/);
  // saveWorklist is the planner's only plan push; no other payload names planShape.
  assert.doesNotMatch(js, /\bplan:\s*planShape\(\)/);
});
