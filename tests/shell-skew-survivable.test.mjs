// A page's markup is a CROSS-FILE CONTRACT with the module that binds it, and
// sw.js is stale-while-revalidate **per file** — so a module and the index.html it
// needs can legitimately be one deploy apart on a phone for an open or two (longer
// on a truck, where the background re-fetch just fails). `$()` returns null for a
// missing id rather than throwing, so an unguarded binding against markup that has
// not caught up throws a TypeError.
//
// On 2026-08-14 that cost a production day: js/worklist-tuning.js bound the new
// #tuneNavByAddress unconditionally, initWorklist() is called from capture.js at
// module top level, and the throw aborted the whole capture module — leaving every
// handler below it unbound. Log stop, the downtime form, Today, the daily-log PDF
// and the entire end-of-day close-out all died at once. It was reported as "the
// End of day button does not work"; a headless repro against the previous
// index.html measured 16 of 20 top-bar/form handlers dead.
//
// These are content assertions rather than behaviour tests for the same reason
// stop-never-discarded.test.mjs is: the thing to prevent is a future edit quietly
// removing the containment, which no unit test over the pure modules would catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CAPTURE = read('js/pages/capture.js');
const TUNING  = read('js/worklist-tuning.js');
const AGENTS  = read('AGENTS.md');
const HTML    = read('index.html');

test('capture.js contains a worklist init failure instead of dying with it', () => {
  // The call must be inside a try. Without this, ONE null element anywhere in the
  // worklist module graph unbinds ~40 capture handlers below line ~455.
  const call = CAPTURE.indexOf('initWorklist({ fillCapture })');
  assert.ok(call !== -1, 'capture.js no longer calls initWorklist({ fillCapture })');

  // Look at the enclosing region: a `try {` must open before the call and a
  // `catch` must follow it before the next top-level handler binding.
  const before = CAPTURE.slice(0, call);
  const after  = CAPTURE.slice(call);
  assert.match(before.slice(-200), /try \{\s*$/m,
    'initWorklist({ fillCapture }) is not wrapped in try — a throw there kills Log stop and End of day');
  assert.match(after.slice(0, 600), /\} catch/,
    'the initWorklist try has no catch');

  // Contained is not the same as hidden. Both halves are required: the console
  // keeps the real stack for whoever debugs it, and the installer is told the
  // worklist is degraded rather than silently getting a dead button.
  const block = after.slice(0, 600);
  assert.match(block, /console\.error/, 'a contained worklist failure must still reach the console');
  assert.match(block, /showNotice\(/, 'a contained worklist failure must be visible to the installer');
});

test('the end-of-day close-out is wired BELOW the worklist init it must survive', () => {
  // This is the ordering that made the bug expensive, and it is the ordering the
  // containment protects. If these ever move above initWorklist the try/catch
  // stops mattering — but so does the bug, so assert the relationship, not a line.
  const init = CAPTURE.indexOf('initWorklist({ fillCapture })');
  for (const id of ['endDay', 'logStop', 'finishDay', 'openDowntime', 'openToday']) {
    // Anchor to a TOP-LEVEL binding (column 0). capture.js also mentions
    // `$('logStop').onclick` in a comment and calls `$('logStop').click()` from
    // inside the duplicate-J chooser; neither is the binding this is about.
    const m = new RegExp(`^\\$\\('${id}'\\)\\.onclick`, 'm').exec(CAPTURE);
    assert.ok(m, `capture.js no longer binds #${id} at the top level`);
    assert.ok(m.index > init,
      `#${id} is now bound before initWorklist — re-check whether the containment still covers it`);
  }
});

test('the newest tuning-screen element is bound defensively', () => {
  // #tuneNavByAddress shipped 2026-08-14 in index.html. Until every phone's cached
  // shell carries it, this module must tolerate its absence.
  assert.ok(HTML.includes('id="tuneNavByAddress"'), 'index.html is missing #tuneNavByAddress');
  assert.doesNotMatch(TUNING, /\$\('tuneNavByAddress'\)\.(onchange|checked)\s*=/,
    'worklist-tuning.js binds #tuneNavByAddress unguarded — the exact 2026-08-14 regression');
  // The guarded shape: fetch once, null-check, then use.
  assert.match(TUNING, /const navBox = \$\('tuneNavByAddress'\);/);
  assert.match(TUNING, /if\(navBox\) navBox\.onchange/);
  assert.match(TUNING, /if\(navBox\) navBox\.checked/);
});

test('the skew rule is written down where the next agent will look', () => {
  assert.match(AGENTS, /cross-file contract/i,
    'AGENTS.md does not record that markup is a cross-file contract with the module that binds it');
  // The mechanism has to be named, or the rule reads as generic defensive advice.
  assert.match(AGENTS, /stale-while-revalidate/,
    'AGENTS.md does not explain WHY a module and its markup can be one deploy apart');
});
