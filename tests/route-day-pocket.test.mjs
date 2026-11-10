// A day's stops are chosen by a nearest-neighbour walk — and a walk never looks back.
// Field report 2026-11-10 (Sombra): two stops in, the walk had a near tie between the
// next house south (108 m) and three orders up a dead-end stub to the north (112 m).
// South won by 4 m, every later step found something closer ahead, the day filled, and
// the three orders the crew was standing beside became tomorrow's first three stops —
// while today's last three were half a kilometre further on.
//
// The walk is still built, but it is no longer the only candidate: the day is also
// built by cheapest insertion (each stop added where it lengthens the path least, so
// a pocket beside the route is picked up on the way past), both are ordered, and the
// SHORTER day wins. Ties and every case where the walk is already the shorter day
// keep the walk, so a day can never come out longer than it did before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { solveVariant } from '../js/route.js';

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
// optimizeRoute's layout with a start and no Home: [start, …located].
const matrix = (start, pts) => {
  const nodes = [start, ...pts];
  return nodes.map(p => Float64Array.from(nodes.map(q => dist(p, q))));
};
const day = (r, n) => r.orderedIds.filter(id => r.dayOf[id] === n);
const sorted = a => a.slice().sort();
const pathLen = (M, located, ids) => {
  const at = id => located.findIndex(x => x.id === id) + 1;
  return ids.reduce((s, id, i) => s + M[i ? at(ids[i - 1]) : 0][at(id)], 0);
};

// Planar metres. The crew stands at the origin on a north–south street. `m1` is the
// house beside them. South of them the street runs on (s1…s5, 30 m apart) and, after
// a 210 m gap, reaches a further block (f1…f3). North of them is a dead-end pocket
// (n1…n3). From m1 the first south house is 51 m away and the first pocket house 56 m.
const P = {
  m1:[10, 0],
  n1:[0, 55],  n2:[0, 85],  n3:[0, 115],
  s1:[0, -50], s2:[0, -80], s3:[0, -110], s4:[0, -140], s5:[0, -170],
  f1:[0, -380], f2:[0, -410], f3:[0, -440],
};
const IDS = Object.keys(P);
const LOCATED = IDS.map(id => ({ id }));
const M = matrix([0, 0], IDS.map(id => P[id]));
const POCKET = ['n1', 'n2', 'n3'], FAR = ['f1', 'f2', 'f3'];
const NEAR_NINE = sorted(['m1', ...POCKET, 's1', 's2', 's3', 's4', 's5']);
const shape = extra => ({ startC:{ lat:1, lng:1 }, homeC:null, startIsCommute:true, target:9, commutePull:0, ...extra });

test('a pocket beside the route is taken today, not stranded behind the walk', () => {
  const r = solveVariant(M, LOCATED, shape());
  assert.deepEqual(sorted(day(r, 1)), NEAR_NINE,
    'Day 1 is the nine stops around the crew — the pocket included');
  assert.deepEqual(sorted(day(r, 2)), FAR, 'the far block is what waits for tomorrow');
});

test('a locked Optimize (day1Count) picks the pocket up the same way', () => {
  // The report's own shape: target 20, one install logged, Day 1 = what is left.
  const r = solveVariant(M, LOCATED, shape({ target:20, day1Count:9 }));
  assert.deepEqual(sorted(day(r, 1)), NEAR_NINE);
});

test('a slot-1 lead still leads the day it is pinned to', () => {
  const r = solveVariant(M, LOCATED, shape({ leadId:'s1' }));
  assert.equal(r.orderedIds[0], 's1');
  assert.deepEqual(sorted(day(r, 1)), NEAR_NINE);
});

// The guarantee that makes this safe to ship: the walk's day is always a candidate,
// so the chosen day is never longer than the one the walk alone would have produced.
// The walk is re-implemented here (it is ten lines) and its set ordered by the real
// solver — a one-day solve over just those stops — so both lengths are the solver's.
test('the chosen day is never longer than the nearest-neighbour day', () => {
  let seed = 20261110;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let shorter = 0;
  for(let trial = 0; trial < 40; trial++){
    // Houses along a loose street grid, like a village.
    const pts = [];
    for(let i = 0; i < 30; i++){
      const street = Math.floor(rnd() * 5) * 90, along = rnd() * 450, off = (rnd() - .5) * 30;
      pts.push(rnd() < .5 ? [street + off, along] : [along, street + off]);
    }
    const start = [rnd() * 450, rnd() * 450];
    const located = pts.map((_, i) => ({ id:'p' + i }));
    const D = matrix(start, pts);
    const count = 10;

    const r = solveVariant(D, located, shape({ target:count }));
    const chosen = pathLen(D, located, day(r, 1));

    const left = new Set(pts.map((_, i) => i)), walk = [];
    let cur = 0;
    while(walk.length < count){
      let best = -1, bestD = Infinity;
      for(const k of left) if(D[cur][k + 1] < bestD){ bestD = D[cur][k + 1]; best = k; }
      walk.push(best); left.delete(best); cur = best + 1;
    }
    const sub = walk.map(k => located[k]);
    const one = solveVariant(matrix(start, walk.map(k => pts[k])), sub, shape({ target:0 }));
    const walked = pathLen(D, located, one.orderedIds);

    assert.ok(chosen <= walked + 1e-6,
      `trial ${trial}: chosen day ${chosen.toFixed(1)} m is longer than the walk's ${walked.toFixed(1)} m`);
    if(chosen < walked - 1e-6) shorter++;
  }
  // Not a tautology: on this seed the second candidate has to win somewhere, or the
  // test above could pass with the comparison deleted.
  assert.ok(shorter > 0, 'the insertion-built day should beat the walk on at least one layout');
});
