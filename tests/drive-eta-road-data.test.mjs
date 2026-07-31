// ── The Drive page's ETAs are measured on roads, not on the crow's route ─────
// The arrival time on the Drive card is `scheduledEta`, written by
// applyTodayAnchor from whatever `estimateTravel` hands the scheduler. That was
// haversine × 1.3 ÷ 50 km/h — every leg, every day — even on a phone holding a
// downloaded district that Optimize had just routed on. So a pack-carried Optimize
// produced road-accurate ETAs and the very next re-anchor (after a logged stop, on
// the Drive screen's 3-minute refresh, on Download, at boot) threw them away. The
// road-accurate times survived minutes, and the driver read the estimate all day.
//
// These are the assertions for the ladder that replaces it, the one road leg the
// pace card re-prices, and the "~" that must now describe the model rather than
// the caller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodePack, ONEWAY_FWD } from '../tools/build-roadpack.mjs';
import { decodePack, matrix, matrixRow } from '../js/roadgraph.js';
import {
  savedRoadTravelFromCoords, estimateTravelFromCoords,
  roadTravelFromCoords, resetTravelCache,
  ESTIMATE_SPEED_KMH, ROAD_DETOUR_FACTOR, ROAD_MIN_PER_METRE,
} from '../js/route.js';

const worklistJs = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const routeJs = readFileSync(new URL('../js/route.js', import.meta.url), 'utf8');
const roadpackJs = readFileSync(new URL('../js/roadpack.js', import.meta.url), 'utf8');

// The same 2×3 lattice tests/roadgraph.test.mjs uses, built through the REAL
// writer so a format change breaks these tests rather than the field.
//
//   3 ── 4 ── 5      lat 44.010
//   │    │    │
//   0 ── 1 ── 2      lat 44.000
//  -78.0 -77.99 -77.98
const LNG = [-78.000, -77.990, -77.980];
const LAT = [44.000, 44.010];
const STEP_LNG_M = 799.9, STEP_LAT_M = 1111.9;
const NODES = [
  [LAT[0], LNG[0]], [LAT[0], LNG[1]], [LAT[0], LNG[2]],
  [LAT[1], LNG[0]], [LAT[1], LNG[1]], [LAT[1], LNG[2]],
];
const seg = (from, to, lengthM, opts = {}) => ({
  from, to, lengthM, speedKph: opts.speedKph ?? 50, flags: opts.flags ?? 0, shape: [],
});
const toArrayBuffer = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

function buildGraph({ s0Flags = 0 } = {}){
  return decodePack(toArrayBuffer(encodePack({
    bbox: { minLat: 43.99, minLng: -78.01, maxLat: 44.02, maxLng: -77.97 },
    nodes: NODES,
    segments: [
      seg(0, 1, STEP_LNG_M, { flags: s0Flags }),
      seg(1, 2, STEP_LNG_M),
      seg(3, 4, STEP_LNG_M),
      seg(4, 5, STEP_LNG_M),
      seg(0, 3, STEP_LAT_M),
      seg(1, 4, STEP_LAT_M),
      seg(2, 5, STEP_LAT_M),
    ],
  })));
}
const at = i => ({ lat: NODES[i][0], lng: NODES[i][1] });

// ── the row is the matrix's row ─────────────────────────────────────────────
test('matrixRow answers exactly what matrix would, for one origin', () => {
  // This is the whole licence for the cache: the stop×stop block is measured once
  // and the truck's row is re-measured alone. If the two ever disagreed, the ETAs
  // would depend on whether the cache happened to be warm — the worst kind of bug
  // to read a field report about.
  const g = buildGraph();
  const stops = [at(1), at(2), at(5), at(3)];
  const full = matrix(g, [at(0), ...stops]);
  const row = matrixRow(g, at(0), stops);
  assert.equal(row.snapped, true);
  for(let j = 0; j < stops.length; j++){
    assert.ok(Number.isFinite(row.T[j]), `leg ${j} should be routable`);
    assert.equal(row.T[j], full.T[0][j + 1]);
    assert.equal(row.D[j], full.D[0][j + 1]);
  }
});

test('an off-network origin gives an all-Infinity row rather than throwing', () => {
  // The caller (roadTravelFromCoords) repairs those pairs crow-flies and drops
  // `.measured`, so a fix in a field still prices the day — it just says so.
  const row = matrixRow(buildGraph(), { lat: 44.5, lng: -77.0 }, [at(1), at(2)]);
  assert.equal(row.snapped, false);
  assert.ok(row.T.every(v => !Number.isFinite(v)));
});

// ── the number genuinely changes ────────────────────────────────────────────
test('a road leg is not the crow-flies estimate, and a oneway makes it asymmetric', () => {
  // 0→1 is one block west-to-east. With s0 open, the drive is that block. Forced
  // one-way eastbound, coming BACK from 1 to 0 has to go up, across and down —
  // a detour no crow-flies model can express, because haversine(a,b) === haversine(b,a).
  const open = matrix(buildGraph(), [at(0), at(1)]);
  const oneWay = matrix(buildGraph({ s0Flags: ONEWAY_FWD }), [at(0), at(1)]);

  assert.equal(oneWay.D[0][1], open.D[0][1], 'the legal direction is unchanged');
  assert.ok(oneWay.D[1][0] > open.D[1][0] * 2,
    `the forced detour should dwarf the direct block, saw ${oneWay.D[1][0]} vs ${open.D[1][0]}`);
  // The asymmetry itself is the point: this is information a straight line cannot carry.
  assert.ok(oneWay.T[1][0] > oneWay.T[0][1]);

  // And the detour is longer than what the crow-flies model would have charged.
  const crowMetres = STEP_LNG_M * ROAD_DETOUR_FACTOR;
  assert.ok(oneWay.D[1][0] > crowMetres,
    `road ${oneWay.D[1][0]}m should exceed the crow-flies allowance ${crowMetres}m`);
});

// ── tier B: the saved road metres ───────────────────────────────────────────
const items = [
  { id: 'a', lat: 44.000, lng: -78.000, legMetersRoad: 4000 },
  { id: 'b', lat: 44.000, lng: -77.990, legMetersRoad: 6000 },
  { id: 'c', lat: 44.010, lng: -77.990, legMetersRoad: 0 },      // a day's first stop
];
const START = { lat: 44.000, lng: -78.010 };

test('tier B prices consecutive legs off the saved road metres', () => {
  const saved = savedRoadTravelFromCoords(items, START, null, 'legMetersRoad');
  const crow = estimateTravelFromCoords(items, START, null);
  assert.ok(saved, 'a saved-leg lookup should be built');

  // b's saved arrival leg is 6 km of ROAD, at the nominal speed and with NO detour
  // factor — a road metre has already driven the detour.
  assert.ok(Math.abs(saved.between('a', 'b') - 6000 * ROAD_MIN_PER_METRE) < 1e-9);
  assert.ok(Math.abs(saved.between('a', 'b') - (6 / ESTIMATE_SPEED_KMH) * 60) < 1e-9);
  // Both directions, because the scheduler can walk a pair either way once an
  // appointment reorders a day.
  assert.equal(saved.between('b', 'a'), saved.between('a', 'b'));
  // It is a different number from the crow-flies one, which is the point.
  assert.notEqual(saved.between('a', 'b'), crow.between('a', 'b'));
});

test('tier B leaves alone what it cannot speak for', () => {
  const saved = savedRoadTravelFromCoords(items, START, null, 'legMetersRoad');
  const crow = estimateTravelFromCoords(items, START, null);

  // A day's first stop carries 0 (legMetersFor charges the drive out to
  // homeLegMeters*, which no total reads) — so that pair keeps the estimate rather
  // than becoming a zero-minute drive.
  assert.equal(saved.between('b', 'c'), crow.between('b', 'c'));
  assert.ok(saved.between('b', 'c') > 0);
  // Non-adjacent pairs have no saved leg at all, and the scheduler can form them.
  // They must still answer — a null here becomes route-constraints' nominal drive.
  assert.equal(saved.between('a', 'c'), crow.between('a', 'c'));
  // The drive from the ORIGIN is deliberately untouched: the origin is usually the
  // truck's live GPS fix, and a metre figure measured from the crew start is not a
  // measurement of that.
  assert.equal(saved.fromStart('a'), crow.fromStart('a'));
  // Road LENGTHS at a nominal speed are still an estimate — the "~" stays.
  assert.equal(saved.measured, false);
});

test('tier B declines rather than relabelling crow-flies as road', () => {
  // No field named (the caller could not vouch for the saved metres: a dragged
  // sequence, or a straight variant priced on a straight-line run) ⇒ null, and the
  // ladder falls to tier C rather than dressing an estimate up as a measurement.
  assert.equal(savedRoadTravelFromCoords(items, START, null, ''), null);
  // Nothing saved to read ⇒ also null.
  assert.equal(savedRoadTravelFromCoords(
    items.map(x => ({ ...x, legMetersRoad: 0 })), START, null, 'legMetersRoad'), null);
  // No located stops at all ⇒ null, exactly as tier C does.
  assert.equal(savedRoadTravelFromCoords([], START, null, 'legMetersRoad'), null);
});

// ── tier A degrades instead of throwing ─────────────────────────────────────
test('tier A returns null when there is no pack to read', async () => {
  // Node has no IndexedDB, which is the same answer a phone with no district
  // downloaded gives: decline, and let the caller drop a tier. It must not throw —
  // this runs on the path that re-times the day after every logged stop.
  resetTravelCache();
  assert.equal(await roadTravelFromCoords(items, START, null), null);
  assert.equal(await roadTravelFromCoords([], START, null), null);
});

// ── the wiring ──────────────────────────────────────────────────────────────
test('estimateTravel is a ladder: road graph → saved legs → crow-flies', () => {
  const fn = worklistJs.slice(worklistJs.indexOf('async function estimateTravel(items, all)'),
                              worklistJs.indexOf('async function crewStartPin()'));
  const a = fn.indexOf('roadTravelFromCoords'),
        b = fn.indexOf('savedRoadTravelFromCoords'),
        c = fn.indexOf('estimateTravelFromCoords');
  assert.ok(a > -1 && b > -1 && c > -1, 'all three rungs must be present');
  assert.ok(a < b && b < c, 'best measurement first, crow-flies last');
  // Each rung is reached only when the one above has nothing to say.
  assert.match(fn, /if\(road\) return road;/);
  assert.match(fn, /if\(saved\) return saved;/);
});

test('every re-scheduling path awaits the ladder', () => {
  // scheduleRouteConstraints computes ETAs only when handed `opts.travel`; a path
  // that forgot to await would hand it a Promise, which is truthy, and the ETAs
  // would silently fall back to the flat firstStopTime + slot × pace cadence.
  const calls = [...worklistJs.matchAll(/(?<!function )estimateTravel\(/g)];
  assert.ok(calls.length >= 3, `expected every call site, saw ${calls.length}`);
  for(const m of calls){
    const before = worklistJs.slice(Math.max(0, m.index - 12), m.index);
    assert.match(before, /await $/, `estimateTravel at ${m.index} must be awaited`);
  }
  assert.match(worklistJs, /const travel = await routeTravel\(pending\);/);
});

test('the pack is chosen for the run but never adopted by a background re-anchor', () => {
  // setActivePack also drops the decoded graph, so an unattended caller flipping
  // the active district would rename the crew's Settings line AND throw away the
  // decode on every tick. AGENTS.md: an unattended refresh is not a Download with
  // the prompts removed.
  assert.match(roadpackJs, /export async function loadGraph\(coords, opts\)/);
  assert.match(roadpackJs, /const switchActive = !\(opts && opts\.switchActive === false\);/);
  assert.match(roadpackJs, /if\(switchActive && id !== activePackId\(\)\) await setActivePack\(id\);/);
  // Both ETA-path readers ask for the no-switch behaviour.
  const road = routeJs.slice(routeJs.indexOf('export async function roadTravelFromCoords'),
                             routeJs.indexOf('// TIER B'));
  assert.match(road, /loadGraph\([^)]*, \{ switchActive: false \}\)/);
  const leg = routeJs.slice(routeJs.indexOf('export async function roadLegMetres'));
  assert.match(leg, /loadGraph\(\[a, b\], \{ switchActive: false \}\)/);
});

test('coverage is judged on the stops, never on the truck', () => {
  // The origin is usually the live GPS fix. A fix a field's width outside the pack
  // bbox — on the way in, or at the edge of the district — must not veto a day the
  // pack covers perfectly well. It gets its own row and falls back per pair.
  const road = routeJs.slice(routeJs.indexOf('export async function roadTravelFromCoords'),
                             routeJs.indexOf('// TIER B'));
  assert.match(road, /coverage\(graph, stops\)\.ratio < LOCAL_MIN_COVERAGE/);
  // …but the origin IS offered to loadGraph, so the district picked is the one
  // covering the run the crew is actually driving.
  assert.match(road, /loadGraph\(origin \? \[origin, \.\.\.stops\] : stops/);
});

test('the "~" describes the model that made the times, not who called', () => {
  // It used to mean "somebody re-anchored, therefore estimated" — true only while a
  // re-anchor could not measure anything. Now rung A measures the same road graph
  // Optimize does, and a tilde on those numbers is a lie in the other direction.
  assert.match(worklistJs,
    /store\.set\('wlTimesEstimated', travel && travel\.measured \? '' : '1'\)/);
  // Optimize still owns the flag through base.estimatedTimes.
  assert.match(worklistJs, /if\(!\(opts && opts\.travel\)\) store\.set\('wlTimesEstimated'/);
  assert.match(worklistJs, /store\.set\('wlTimesEstimated', base\.estimatedTimes \? '1' : ''\)/);
  // The two Download-time writes are gone: applyTodayAnchor runs immediately after
  // both and re-derives the flag, so they never survived to be read.
  const writes = [...worklistJs.matchAll(/store\.set\('wlTimesEstimated'/g)];
  assert.equal(writes.length, 2, 'exactly two writers: Optimize and the re-anchor');
  // Only tier A can clear it, and only when nothing in the day was repaired.
  assert.match(routeJs, /lookup\.measured = measured;/);
  assert.match(routeJs, /lookup\.measured = false;\s+\/\/ road LENGTHS/);
});
