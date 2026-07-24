import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const planner = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');
const worklist = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

test('the planner fetch fills the drive-out geometry for a day first stop', () => {
  assert.match(planner, /import\s*\{[^}]*\bencodePolyline\b[^}]*\}\s*from\s*'\.\.\/route\.js'/);
  // road path when OSRM has one, else a straight two-point line.
  assert.match(planner, /f\.homeLegGeometry\s*\]\s*=\s*road\s*\|\|\s*encodePolyline/s);
  // fetchVariantGeometry takes the crew start + an OSRM-online flag, so the straight
  // drive-out is filled even when OSRM is down (the pin + faint line always show).
  assert.match(planner, /async function fetchVariantGeometry\(osrmUrl,\s*start,\s*osrmOnline\)/);
});

test('a reorder blanks stale geometry, and the drive-out is redrawn', () => {
  // Planner clears the home-leg geometry in the optimize-apply loop before it
  // refills it (so a reorder can never leave a stale home-ward line).
  assert.match(planner, /x\[f\.homeLegGeometry\]\s*=\s*''/);
  // The phone can't fetch OSRM road paths, so it draws the crew-start drive-out as a
  // straight two-point line for each day's first stop (not just a blank).
  assert.match(worklist, /encodePolyline\(\[\[crewStart\.lat,\s*crewStart\.lng\]/);
});
