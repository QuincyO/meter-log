// The reported bug was never one wrong number — it was three numbers from three
// different solves, only one of which had ever been written to a card. These
// guard the wiring that makes them agree: lateness is persisted and badged
// wherever an ETA is shown, and a parked solver failure marks EVERY surface that
// reads a scheduled* field, not just the screen the failure happened on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worklist  = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const routeView = readFileSync(new URL('../js/worklist-route-view.js', import.meta.url), 'utf8');
const css       = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');

test('both writers persist the lateness that came back with the ETA', () => {
  // scheduledOnSiteMin shipped once WITHOUT this and kept the previous run's
  // value through every re-anchor. A lateness left behind is worse: it badges an
  // order the current route reaches perfectly well.
  const writes = worklist.match(/scheduledLateMin\s*:/g) || [];
  assert.ok(writes.length >= 2,
    `expected the optimize and re-anchor writers to both persist scheduledLateMin, found ${writes.length}`);
});

test('the worklist card badges a late appointment and greys a stale ETA', () => {
  assert.match(worklist, /scheduledLateMin[\s\S]{0,400}wl-badge late/);
  assert.match(worklist, /planStale\(\)[\s\S]{0,200}stale/);
});

test('the route view is handed the staleness signal, not left to guess', () => {
  // It reads its own copy of nothing — worklist.js owns wlPlanIssue and passes
  // both the flag and the message down, so the two screens cannot diverge.
  assert.match(worklist, /planStale,/);
  assert.match(worklist, /planIssue:\s*\(\)\s*=>\s*store\.get\('wlPlanIssue'\)/);
  assert.match(routeView, /function planStale\(\)\{\s*return Boolean\(opts\.planStale/);
  assert.match(routeView, /opts\.planIssue/);
});

test('a stale route view says so on its header and on every stop', () => {
  assert.match(routeView, /re-optimize/i);
  assert.match(routeView, /wl-route-meta\$\{planStale\(\) \? ' stale' : ''\}/);
  assert.match(routeView, /scheduledLateMin/);
});

test('an optimize whose solve fails parks the issue instead of only toasting', () => {
  // The toast scrolls away; the ETAs it contradicts do not. Parking it is what
  // lets the route view grey them.
  assert.match(worklist,
    /catch\(e\)\s*\{[\s\S]{0,600}store\.set\('wlPlanIssue'[\s\S]{0,200}throw e;/);
});

test('the stale and late styles exist and read as different things', () => {
  const rule = sel => css.match(new RegExp(`${sel.replace(/[.#]/g, '\\$&')}\\s*\\{([^}]+)\\}`))?.[1] || '';
  assert.match(rule('.wl-badge.late'), /color/);
  assert.match(rule('.wl-badge.stale'), /line-through/);
  assert.match(rule('.wl-route-meta.stale'), /line-through/);
  assert.match(rule('.wl-route-late'), /color/);
});
