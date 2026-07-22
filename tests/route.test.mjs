import test from 'node:test';
import assert from 'node:assert/strict';
import { routeOrderFromMatrix, solveAnchoredPath } from '../js/route.js';

function matrix(rows){
  return rows.map(row => Float64Array.from(row));
}

test('anchored route keeps the requested start and end nodes fixed', () => {
  const D = matrix([
    [0, 1, 2, 0.5],
    [1, 0, 1, 10],
    [2, 1, 0, 1],
    [0.5, 10, 1, 0]
  ]);

  assert.deepEqual(solveAnchoredPath(D, { pinEnd:true }), [0, 1, 2, 3]);
});

test('start-only route keeps the requested start and leaves the end open', () => {
  const D = matrix([
    [0, 5, 1, 4],
    [5, 0, 2, 1],
    [1, 2, 0, 3],
    [4, 1, 3, 0]
  ]);

  const route = solveAnchoredPath(D);
  assert.equal(route[0], 0);
  assert.deepEqual(route.slice().sort((a, b) => a - b), [0, 1, 2, 3]);
});

test('here-to-home route strips both anchors from the work-order sequence', () => {
  const D = matrix([
    [0, 1, 2, 0.5],
    [1, 0, 1, 10],
    [2, 1, 0, 1],
    [0.5, 10, 1, 0]
  ]);

  assert.deepEqual(routeOrderFromMatrix(D, 2, { hasStart:true, hasHome:true }), [0, 1]);
});

test('legacy home mode still orders meters from the far side toward home', () => {
  const D = matrix([
    [0, 1, 5],
    [1, 0, 4],
    [5, 4, 0]
  ]);

  assert.deepEqual(routeOrderFromMatrix(D, 2, { hasHome:true }), [1, 0]);
});
