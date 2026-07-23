import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');

test('worklist exposes an unarmed one-time Start from here control', () => {
  assert.match(html, /<button[^>]+id="wlStartHere"[^>]+type="button"[^>]+aria-pressed="false"[^>]*>Start from here<\/button>/);
});

test('Start from here is passed to Optimize and reset after an attempted run', () => {
  assert.match(js, /optimizeRoute\([^;]+\{[^}]*\bstraightLine\b[^}]*\bstartFromCurrent\b[^}]*\}\)/s);
  assert.match(js, /finally\s*\{[^}]*setStartHere\(false\)/s);
  assert.match(js, /\$\('wlStartHere'\)\.onclick\s*=\s*\(\)\s*=>\s*setStartHere\(!startHereArmed\(\)\)/);
});

test('the second route is only ever asked for on the road-matrix press', () => {
  // A plain tap must cost exactly what it always did: one solve, no matrix.
  assert.match(js, /compareVariants:\s*!straightLine/);
  assert.doesNotMatch(js, /compareVariants:\s*true/);
});

test('armed Start from here pill has a distinct selected style', () => {
  assert.match(css, /\.wl-start-here\[aria-pressed="true"\]/);
});
