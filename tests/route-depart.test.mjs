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

test('the planner drops its first-stop input and uses the departure constant', () => {
  assert.doesNotMatch(plannerHtml, /id="plRouteTime"/);
  assert.match(plannerHtml, /id="plRouteDate"/); // the office still picks a start date
  assert.match(plannerJs, /import\s*\{[^}]*\bROUTE_DEPART_TIME\b[^}]*\}\s*from\s*'\.\.\/config\.js'/);
  assert.match(plannerJs, /firstStopTime:\s*ROUTE_DEPART_TIME/);
  assert.doesNotMatch(plannerJs, /\$\('plRouteTime'\)/);
});
