// Tests for js/directions.js — turn-by-turn built from an offline district
// pack. Like tests/roadgraph.test.mjs, the fixtures go through the REAL writer
// (tools/build-roadpack.mjs), so a road-name format change that breaks one side
// breaks these rather than a crew's phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodePack } from '../tools/build-roadpack.mjs';
import { decodePack, roadName, hasRoadNames, pathDetail, PACK_VERSION } from '../js/roadgraph.js';
import {
  buildDirections, directionsBetween, canGiveDirections,
  bearing, turnAngle, classifyTurn, humanMetres, MIN_STEP_M,
} from '../js/directions.js';

// A plus-shaped junction at latitude 44. One east–west road (Main Street) and
// one north–south road (Muskoka Road 3) crossing at node 0.
//
//              2  (44.010, -78.000)   Muskoka Road 3, north
//              │
//   1 ───────  0 ───────  3           Main Street, west → east
//              │
//              4  (43.990, -78.000)   Muskoka Road 3, south
//
// One lng step of 0.010 is ~800 m here; one lat step ~1112 m.
const N = [
  [44.000, -78.000],   // 0 the junction
  [44.000, -78.010],   // 1 west
  [44.010, -78.000],   // 2 north
  [44.000, -77.990],   // 3 east
  [43.990, -78.000],   // 4 south
];
const EW_M = 799.9, NS_M = 1111.9;

const seg = (from, to, lengthM, nameId) => ({
  from, to, lengthM, speedKph: 50, flags: 0, nameId, shape: [],
});

// Name ids index this list; 0 is always '' (unnamed), which the writer relies on.
const ROADS = ['', 'Main Street', 'Muskoka Road 3'];

function crossGraph(roadNames = ROADS){
  const segments = [
    seg(1, 0, EW_M, 1),   // s0 Main Street, west arm
    seg(0, 3, EW_M, 1),   // s1 Main Street, east arm
    seg(0, 2, NS_M, 2),   // s2 Muskoka Road 3, north arm
    seg(4, 0, NS_M, 2),   // s3 Muskoka Road 3, south arm
  ];
  const buf = encodePack({
    bbox: { minLat:43.98, minLng:-78.02, maxLat:44.02, maxLng:-77.98 },
    nodes: N, segments, streets: [], places: [], addresses: [], roadNames,
  });
  return decodePack(new Uint8Array(buf).buffer.slice(
    buf.byteOffset, buf.byteOffset + buf.byteLength));
}

// ── the format ───────────────────────────────────────────────────────────────

test('the pack version moved for the road-name table', () => {
  assert.equal(PACK_VERSION, 3);
});

test('road names survive a round trip through the real writer', () => {
  const g = crossGraph();
  assert.equal(hasRoadNames(g), true);
  assert.equal(roadName(g, 0), 'Main Street');
  assert.equal(roadName(g, 2), 'Muskoka Road 3');
});

test('names are stored raw, not normalized like the address index', () => {
  // The address index deliberately lowercases and expands "Rd" → "road"; a name
  // read out to a driver must not.
  const g = crossGraph();
  assert.equal(roadName(g, 2), 'Muskoka Road 3');
});

test('a pack with no names still routes, and simply offers no directions', () => {
  const g = crossGraph(['']);
  assert.equal(hasRoadNames(g), false);
  assert.equal(canGiveDirections(g), false);
  assert.equal(roadName(g, 0), '');
  // Routing is unaffected — this is the roads-only case.
  assert.ok(pathDetail(g, { lat:44.000, lng:-78.010 }, { lat:44.000, lng:-77.990 }).points.length >= 2);
});

test('an out-of-range segment asks for no name rather than throwing', () => {
  const g = crossGraph();
  assert.equal(roadName(g, 999), '');
  assert.equal(roadName(g, -1), '');
});

// ── the geometry helpers ─────────────────────────────────────────────────────

test('bearing points the way you would expect', () => {
  assert.ok(Math.abs(bearing([44, -78], [44.01, -78]) - 0) < 1);      // north
  assert.ok(Math.abs(bearing([44, -78], [44, -77.99]) - 90) < 1);     // east
  assert.ok(Math.abs(bearing([44, -78], [43.99, -78]) - 180) < 1);    // south
  assert.ok(Math.abs(bearing([44, -78], [44, -78.01]) - 270) < 1);    // west
});

test('turnAngle is signed, and left is negative', () => {
  assert.equal(turnAngle(0, 90), 90);      // north then east = right
  assert.equal(turnAngle(0, 270), -90);    // north then west = left
  assert.equal(turnAngle(350, 10), 20);    // across the 360 wrap
  assert.equal(turnAngle(10, 350), -20);
  assert.equal(turnAngle(0, 180), 180);    // a reversal classifies once
});

test('turns are classified into bands a driver would recognise', () => {
  assert.equal(classifyTurn(0).kind, 'straight');
  assert.equal(classifyTurn(15).kind, 'straight');     // a gentle bend is the same road
  assert.equal(classifyTurn(-30).kind, 'slight');
  assert.equal(classifyTurn(-30).side, 'left');
  assert.equal(classifyTurn(90).kind, 'turn');
  assert.equal(classifyTurn(90).side, 'right');
  assert.equal(classifyTurn(-150).kind, 'sharp');
  assert.equal(classifyTurn(180).kind, 'uturn');
});

test('distances are rounded to something actionable', () => {
  assert.equal(humanMetres(437), '440 m');
  assert.equal(humanMetres(4), '10 m');       // never "0 m"
  assert.equal(humanMetres(1500), '1.5 km');
  assert.equal(humanMetres(0), '10 m');
});

// ── the instructions ─────────────────────────────────────────────────────────

test('driving straight through the junction is one merged instruction', () => {
  const g = crossGraph();
  // West arm → east arm: same road, no turn. Two graph segments, one step.
  const steps = directionsBetween(g, { lat:44.000, lng:-78.009 }, { lat:44.000, lng:-77.991 });
  const moves = steps.filter(s => s.kind !== 'arrive');
  assert.equal(moves.length, 1, JSON.stringify(steps, null, 2));
  assert.equal(moves[0].kind, 'depart');
  assert.equal(moves[0].road, 'Main Street');
  assert.equal(steps[steps.length - 1].kind, 'arrive');
});

test('turning at the junction names the road being turned onto', () => {
  const g = crossGraph();
  // West arm heading east, then north up Muskoka Road 3 — a left turn.
  const steps = directionsBetween(g, { lat:44.000, lng:-78.009 }, { lat:44.009, lng:-78.000 });
  const turn = steps.find(s => s.side);
  assert.ok(turn, 'expected a turn: ' + JSON.stringify(steps, null, 2));
  assert.equal(turn.side, 'left');
  assert.equal(turn.road, 'Muskoka Road 3');
  assert.match(turn.text, /Turn left onto Muskoka Road 3/);
});

test('the other way round is a right turn', () => {
  const g = crossGraph();
  // East arm heading west, then north — a right turn.
  const steps = directionsBetween(g, { lat:44.000, lng:-77.991 }, { lat:44.009, lng:-78.000 });
  const turn = steps.find(s => s.side);
  assert.ok(turn, 'expected a turn: ' + JSON.stringify(steps, null, 2));
  assert.equal(turn.side, 'right');
});

test('every drive ends with an arrival', () => {
  const g = crossGraph();
  const steps = directionsBetween(g, { lat:44.000, lng:-78.009 }, { lat:43.991, lng:-78.000 });
  assert.equal(steps[steps.length - 1].kind, 'arrive');
  assert.equal(steps[steps.length - 1].text, 'Arrive at the stop');
});

test('an unroutable pair gives no instructions rather than a wrong one', () => {
  const g = crossGraph();
  assert.deepEqual(directionsBetween(g, { lat:50, lng:-90 }, { lat:44.000, lng:-77.991 }), []);
  assert.deepEqual(directionsBetween(null, { lat:44, lng:-78 }, { lat:44, lng:-77.99 }), []);
});

test('no legs means no instructions, not a lone "arrive"', () => {
  const g = crossGraph();
  assert.deepEqual(buildDirections(g, []), []);
  assert.deepEqual(buildDirections(g, null), []);
});

test('merged instructions carry the combined distance', () => {
  const g = crossGraph();
  const steps = directionsBetween(g, { lat:44.000, lng:-78.009 }, { lat:44.000, lng:-77.991 });
  // Two ~800 m arms merged; the snap trims a little off each end, so this is a
  // range rather than an equality.
  assert.ok(steps[0].meters > 1000, `expected a merged run, got ${steps[0].meters} m`);
});

// ── readability of the list, all three from real Huntsville output ───────────

// A named road that BENDS, as the graph stores it: several short segments with
// a real angle at each join. Straight north-east-ish, curving as it goes.
function bendyGraph(){
  const nodes = [
    [44.0000, -78.0000], [44.0000, -77.9987], [44.0007, -77.9978], [44.0016, -77.9974],
  ];
  const segments = [
    seg(0, 1, 104, 1), seg(1, 2, 104, 1), seg(2, 3, 104, 1),   // all "Main Street"
  ];
  const buf = encodePack({
    bbox: { minLat:43.99, minLng:-78.01, maxLat:44.01, maxLng:-77.99 },
    nodes, segments, streets: [], places: [], addresses: [], roadNames: ROADS,
  });
  return decodePack(new Uint8Array(buf).buffer.slice(
    buf.byteOffset, buf.byteOffset + buf.byteLength));
}

test('a road that bends is still one instruction, not one per bend', () => {
  // The bug this pins: merging only on a dead-straight join turned a curving
  // rural stretch into "Bear right onto Main Street for 30 m", four times over.
  const g = bendyGraph();
  const steps = directionsBetween(g, { lat:44.0000, lng:-77.9999 }, { lat:44.0015, lng:-77.9974 });
  const moves = steps.filter(s => s.kind !== 'arrive');
  assert.equal(moves.length, 1, 'expected one instruction, got:\n' + steps.map(s => '  ' + s.text).join('\n'));
  assert.equal(moves[0].road, 'Main Street');
});

// Main Street, a left turn onto an unnamed link, then straight on Highway 11 —
// the slip-road shape that produced "Turn left for 430 m" / "Continue on
// Highway 11" as two steps.
function rampGraph(){
  const nodes = [
    [44.000, -78.000], [44.000, -77.998], [44.001, -77.998], [44.004, -77.998],
  ];
  const segments = [
    seg(0, 1, 160, 1),   // Main Street, heading east
    seg(1, 2, 111, 0),   // unnamed link, heading north
    seg(2, 3, 333, 3),   // Highway 11, still north
  ];
  const buf = encodePack({
    bbox: { minLat:43.99, minLng:-78.01, maxLat:44.01, maxLng:-77.99 },
    nodes, segments, streets: [], places: [], addresses: [],
    roadNames: ['', 'Main Street', 'Muskoka Road 3', 'Highway 11'],
  });
  return decodePack(new Uint8Array(buf).buffer.slice(
    buf.byteOffset, buf.byteOffset + buf.byteLength));
}

test('a turn onto an unnamed link names the road it leads onto', () => {
  const g = rampGraph();
  const steps = directionsBetween(g, { lat:44.000, lng:-77.9995 }, { lat:44.0035, lng:-77.998 });
  const turn = steps.find(s => s.side);
  assert.ok(turn, 'expected a turn:\n' + steps.map(s => '  ' + s.text).join('\n'));
  assert.equal(turn.side, 'left');
  assert.equal(turn.road, 'Highway 11');
  // And the link's own distance is carried, not dropped on the floor.
  assert.ok(turn.meters > 333, `expected link + highway, got ${turn.meters} m`);
});

test('no instruction is shorter than a driver can act on', () => {
  const g = bendyGraph();
  for(const s of directionsBetween(g, { lat:44.0000, lng:-77.9999 }, { lat:44.0015, lng:-77.9974 }))
    if(s.kind !== 'arrive') assert.ok(s.meters >= MIN_STEP_M, `${s.text} is only ${s.meters} m`);
});

test('driving straight through never ends in a phantom U-turn', () => {
  // The target sitting on the segment the route arrived along used to push that
  // segment into the leg list a second time, reversed — a U-turn onto the road
  // just joined, for exactly the distance just driven.
  const g = crossGraph();
  const steps = directionsBetween(g, { lat:44.000, lng:-78.009 }, { lat:44.000, lng:-77.991 });
  assert.ok(!steps.some(s => s.kind === 'uturn'),
    'phantom U-turn:\n' + steps.map(s => '  ' + s.text).join('\n'));
});

test('the service worker ships the directions module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/directions\.js'/);
});

// ── wired into the two screens ───────────────────────────────────────────────
const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('the drive screen has somewhere to put the steps', () => {
  assert.match(read('index.html'), /id="driveSteps"/);
  assert.match(read('css/drive.css'), /\.drive-steps-list/);
});

test('the drive card asks for directions whenever it repaints', () => {
  const js = read('js/drive.js');
  assert.match(js, /import \{ offlineDirections \} from '\.\/route\.js'/);
  // Called from renderCard, so stepping Back/Next and refreshing all update it.
  assert.match(js, /renderSteps\(\);/);
  // A late answer must not paint over a card the driver has stepped past.
  assert.match(js, /stepsFor !== at/);
});

test('the drive screen falls back to the last stop when nothing is recording', () => {
  // Recording is opt-in per day per phone, so a live fix is often absent and
  // the previous stop is the only honest starting point.
  const js = read('js/drive.js');
  assert.match(js, /liveMetrics\(\)\.lastFix/);
  assert.match(js, /pending\[at - 1\]/);
  assert.match(read('js/drive-recorder.js'), /lastFix:/);
});

test('the FIRST stop of the day starts from the muster point', () => {
  // Caught by driving the real screen: card 1 has no previous stop, and a phone
  // that never armed the recorder has no fix — so the very first card, the one
  // a driver looks at first, was the one card with no directions on it.
  const js = read('js/drive.js');
  assert.match(js, /at === 0 && opts\.getCrewStart/);
  assert.match(read('js/worklist.js'), /getCrewStart: crewStartPin/);
});

test('the route view offers directions per leg, collapsed', () => {
  const js = read('js/worklist-route-view.js');
  assert.match(js, /offlineDirections/);
  assert.match(js, /wl-route-dirbtn/);
  assert.match(js, /aria-expanded/);
  assert.match(read('css/capture.css'), /\.wl-route-dirs/);
});

// The pack has no turn restrictions. It can be certain of the geometry and not
// of the law, and that has to reach the person driving — not just the docs.
test('both screens say the directions are a guide, not a navigator', () => {
  assert.match(read('js/drive.js'), /Guide only/);
  assert.match(read('js/worklist-route-view.js'), /Guide only/);
});
