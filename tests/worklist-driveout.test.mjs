import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const planner = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');
const worklist = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

test('the planner fetch fills the drive-out geometry for a day first stop', () => {
  assert.match(planner, /import\s*\{[^}]*\bencodePolyline\b[^}]*\}\s*from\s*'\.\.\/route\.js'/);
  // road path when OSRM has one, else a straight two-point line.
  assert.match(planner, /f\.homeLegGeometry\s*\]\s*=\s*road\s*\|\|\s*encodePolyline/s);
  // fetchVariantGeometry now takes the crew start.
  assert.match(planner, /async function fetchVariantGeometry\(osrmUrl,\s*start\)/);
});

test('a reorder blanks the drive-out geometry on both clients', () => {
  assert.match(planner, /homeLegGeometryRoad\s*=\s*''/);
  assert.match(worklist, /patch\[f\.homeLegGeometry\]\s*=\s*''/);
});
