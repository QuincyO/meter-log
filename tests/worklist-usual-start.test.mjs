import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The phone's ETAs start from the installer's usual first-stop ARRIVAL, not from an
// 08:15 departure nobody keeps. worklist.js needs a DOM, so like the other worklist
// tests these pin the source text; the scheduler half is pinned behaviourally in
// tests/route-constraints*.test.mjs and the clock itself in usualStartClock's tests.
const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

// One function's own text: from its declaration to the brace that closes its body.
// Template literals in worklist.js keep their `${}` balanced, so a plain brace count
// is enough here.
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

// The name of the function a source offset sits inside (the nearest declaration
// above it), and that function's text.
function enclosingFunction(at){
  const re = /\n(?:export )?(?:async )?function (\w+)\(/g;
  let name = null, m;
  while((m = re.exec(js)) && m.index < at) name = m[1];
  return name ? sourceOf(name) : '';
}

test('the metrics read stores the usual first log and the delay per stop', () => {
  const src = sourceOf('refreshAvgDay');
  assert.match(src, /storeNum\('wlUsualFirstLogMin', m\.usualFirstLogMin\)/);
  assert.match(src, /storeNum\('wlDelayPerStopMin', m\.delayPerStopMin\)/);
});

test('the plan starts on the usual start, as an arrival', () => {
  const src = sourceOf('planShape');
  assert.match(src, /firstStopTime:\s*usualStart\(\)/);
  assert.match(src, /firstStopArrival:\s*true/);
  assert.doesNotMatch(src, /ROUTE_DEPART_TIME/);
});

test('every scheduler call on the phone spreads planShape, so none can miss the flag', () => {
  const calls = [...js.matchAll(/\b(scheduleRouteConstraints|applyVariant)\(/g)]
    // the import lists name both without calling them
    .filter(m => !/import\s*\{[^}]*$/.test(js.slice(Math.max(0, m.index - 400), m.index)));
  // Optimize's per-variant loop, switchVariant, persistOrderIds, applyTodayAnchor. A
  // fifth call has to be read here before this number moves.
  assert.equal(calls.length, 4);
  for(const m of calls){
    const args = js.slice(m.index, js.indexOf(');', m.index));
    if(/\.\.\.planShape\(\)/.test(args)) continue;
    // Optimize builds its options once, as `planOpts`, and reuses them per variant.
    assert.match(args, /\bplanOpts\b/, `${m[1]} call without planShape: ${args.slice(0, 80)}`);
    assert.match(enclosingFunction(m.index), /const planOpts = \{ \.\.\.planShape\(\)/);
  }
  // ...and what they spread carries the flag.
  assert.match(sourceOf('planShape'), /firstStopArrival:\s*true/);
});

test('new scheduler exports are reached through the namespace, never a named import', () => {
  assert.doesNotMatch(js, /import \{[^}]*usualStartClock[^}]*\} from '\.\/route-constraints\.js'/);
  const src = sourceOf('usualStart');
  assert.match(src, /typeof routeConstraints\.usualStartClock !== 'function'/);
  assert.match(src, /routeConstraints\.usualStartClock\(readNum\('wlUsualFirstLogMin'\), dwellShape\(\)\.base, fallback\)/);
});

test('the fallback start comes through the config namespace with the literal behind it', () => {
  assert.match(js, /import \* as conf from '\.\/config\.js';/);
  assert.doesNotMatch(js, /import \{[^}]*ROUTE_USUAL_START[^}]*\} from '\.\/config\.js'/);
  assert.match(sourceOf('usualStart'), /conf\.ROUTE_USUAL_START \|\| '09:30'/);
});

test('dwellShape no longer reaches planShape, so usualStart cannot recurse', () => {
  // planShape -> usualStart -> dwellShape; if dwellShape still called planShape
  // the page would overflow the stack on the first render.
  assert.doesNotMatch(sourceOf('dwellShape'), /planShape\(\)/);
  assert.match(sourceOf('dwellShape'), /paceMin:\s*paceVal\(\)/);
  assert.match(sourceOf('planShape'), /paceMin:\s*paceVal\(\)/);
});

test('the delay per stop reads back as a number, 0 when blank', () => {
  assert.match(sourceOf('delayPerStop'), /return readNum\('wlDelayPerStopMin'\) \|\| 0;/);
  assert.match(js, /export function delayPerStop\(\)/);
  assert.match(js, /export function usualStart\(\)/);
});

test('the day 1 clock goes live after the first log, or once the usual start has passed', () => {
  const src = sourceOf('day1DepartTime');
  assert.match(src, /if\(!fromCurrent \|\| planDay\(\) !== localDate\(\)\) return ''/);
  assert.match(src, /todayFirstLog\(\) \|\| hhmmMin\(now\) > hhmmMin\(usualStart\(\)\)/);
  assert.doesNotMatch(src, /ROUTE_DEPART_TIME/);
});

test('today\'s first log is read from the day cache, installs and UTIs only', () => {
  const src = sourceOf('refreshTodayFirstLog');
  assert.match(js, /export async function refreshTodayFirstLog\(\)/);
  assert.match(src, /idb\.get\('dayCache', `\$\{c\.name\}\|\$\{today\}`\)/);
  assert.match(src, /s\.status === 'INSTALLED' \|\| s\.status === 'UTI'/);
  assert.match(js, /export function todayFirstLog\(\)/);
  // Kept with its date, so yesterday's first log cannot make today's clock live.
  assert.match(sourceOf('todayFirstLog'), /firstLogToday\.date === localDate\(\)/);
});

test('every re-anchor (and so every logged stop) refreshes today\'s first log first', () => {
  // Its first statement, so nothing below it can read a stale clock.
  assert.match(sourceOf('applyTodayAnchor'),
    /^\nasync function applyTodayAnchor\(opts\)\{\n(?:\s*\/\/[^\n]*\n)*\s*await refreshTodayFirstLog\(\);/);
});

test('firstStopArrival is not a sheet field: no plan push carries it', () => {
  // wlUpload, syncWorklist and the Download's savePlan all push savePlanLocal()'s
  // answer (directly or through implicitPlan), so stripping it there covers them all.
  assert.match(sourceOf('savePlanLocal'), /const \{ firstStopArrival, \.\.\.p \} = planShape\(\);/);
  const pushes = [...js.matchAll(/\bplan:\s*([\w$.]+(?:\(\))?)/g)];
  assert.equal(pushes.length, 3);
  for(const m of pushes)
    assert.match(m[1], /^(savePlanLocal|implicitPlan)\(\)$/, `plan pushed as ${m[1]}`);
});

test('a morning day is measured from its own first ETA, without the drive out', () => {
  const src = sourceOf('wlDayEta');
  // An early appointment pulls an arrival-anchored day before firstStopTime, so
  // the span starts at that day's earliest ETA, not at the clock.
  assert.match(src, /fromNow \|\| dayFirstEta\(dayItems\) \|\| shape\.firstStopTime/);
  assert.match(sourceOf('dayFirstEta'), /scheduledEta/);
  // The drive out is only inside a span that departs from where the crew stands.
  assert.match(src, /fromNow \? 'the drive out, ' : ''/);
});
