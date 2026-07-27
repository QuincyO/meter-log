// District geometry: choosing a pack for a run, and growing one district's area.
// js/districts.js is pure, so this is a plain unit test — no IndexedDB, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bboxHas, unionBbox, bboxArea, unionWaste, isSparseUnion, pickPack, validBbox,
  wrapLng, normalizeBbox, clampBbox, wasClamped,
} from '../js/districts.js';

const box = (minLat, minLng, maxLat, maxLng) => ({ minLat, minLng, maxLat, maxLng });
const at = (lat, lng) => ({ lat, lng });

// Two districts side by side, sharing the 45.5 boundary.
const KAWARTHA = box(44.0, -79.0, 45.0, -78.0);
const MUSKOKA  = box(45.0, -79.0, 46.0, -78.0);

test('bboxHas is inclusive on the boundary', () => {
  assert.equal(bboxHas(KAWARTHA, at(44.5, -78.5)), true);
  assert.equal(bboxHas(KAWARTHA, at(44.0, -79.0)), true);   // corner counts
  assert.equal(bboxHas(KAWARTHA, at(45.5, -78.5)), false);
  assert.equal(bboxHas(KAWARTHA, null), false);
  assert.equal(bboxHas(null, at(44.5, -78.5)), false);
});

test('a non-numeric coordinate is outside, never a silent zero', () => {
  assert.equal(bboxHas(KAWARTHA, { lat: '44.5', lng: -78.5 }), false);
  assert.equal(bboxHas(KAWARTHA, { lat: NaN, lng: -78.5 }), false);
});

test('validBbox rejects an inverted box', () => {
  assert.equal(validBbox(box(45, -78, 44, -79)), null);
  assert.deepEqual(validBbox(KAWARTHA), KAWARTHA);
});

test('unionBbox covers both areas', () => {
  assert.deepEqual(unionBbox(KAWARTHA, MUSKOKA), box(44.0, -79.0, 46.0, -78.0));
});

test('unionBbox tolerates a missing side', () => {
  assert.deepEqual(unionBbox(KAWARTHA, null), KAWARTHA);
  assert.deepEqual(unionBbox(null, MUSKOKA), MUSKOKA);
});

test('growing into an adjacent area wastes nothing', () => {
  assert.equal(unionWaste(KAWARTHA, MUSKOKA), 1);
  assert.equal(isSparseUnion(KAWARTHA, MUSKOKA), false);
});

test('an overlapping extension is not counted twice', () => {
  // Half of this box is already inside KAWARTHA; the union is 1.5 boxes of
  // ground and so is the area actually wanted.
  const overlap = box(44.5, -79.0, 45.5, -78.0);
  assert.equal(unionWaste(KAWARTHA, overlap), 1);
});

test('two areas on opposite corners are flagged as mostly dead ground', () => {
  const faraway = box(47.0, -75.0, 48.0, -74.0);
  assert.ok(unionWaste(KAWARTHA, faraway) > 2);
  assert.equal(isSparseUnion(KAWARTHA, faraway), true);
});

test('bboxArea is zero for a degenerate or missing box', () => {
  assert.equal(bboxArea(null), 0);
  assert.equal(bboxArea(box(44, -79, 44, -79)), 0);
});

const PACKS = [{ id:'kawartha', bbox:KAWARTHA }, { id:'muskoka', bbox:MUSKOKA }];

test('the run picks the district holding most of its stops', () => {
  const run = [at(44.2, -78.5), at(44.4, -78.6), at(45.5, -78.5)];
  assert.equal(pickPack(PACKS, run), 'kawartha');
});

test('the same stops the other way round pick the other district', () => {
  const run = [at(45.2, -78.5), at(45.4, -78.6), at(44.5, -78.5)];
  assert.equal(pickPack(PACKS, run), 'muskoka');
});

test('a tie goes to the district the installer chose in Settings', () => {
  const run = [at(44.5, -78.5), at(45.5, -78.5)];
  assert.equal(pickPack(PACKS, run, 'muskoka'), 'muskoka');
  assert.equal(pickPack(PACKS, run, 'kawartha'), 'kawartha');
});

// The no-signal-from-the-run cases. Both must land on a real pack: dropping to
// '' would decline to the next matrix provider even though a usable district is
// sitting on the phone.
test('no coordinates falls back to the chosen district', () => {
  assert.equal(pickPack(PACKS, null, 'muskoka'), 'muskoka');
  assert.equal(pickPack(PACKS, [], 'muskoka'), 'muskoka');
});

test('stops outside every district still route on the chosen one', () => {
  const run = [at(51.0, -60.0), at(51.1, -60.1)];
  assert.equal(pickPack(PACKS, run, 'muskoka'), 'muskoka');
});

test('an unknown preference falls back to the first installed district', () => {
  assert.equal(pickPack(PACKS, null, 'gone'), 'kawartha');
  assert.equal(pickPack(PACKS, null), 'kawartha');
});

test('no packs means no graph', () => {
  assert.equal(pickPack([], [at(44.5, -78.5)], 'kawartha'), '');
  assert.equal(pickPack(null, null), '');
});

test('a pack with no saved bbox never wins, but can still be the fallback', () => {
  const packs = [{ id:'nobbox', bbox:null }, { id:'kawartha', bbox:KAWARTHA }];
  assert.equal(pickPack(packs, [at(44.5, -78.5)]), 'kawartha');
  assert.equal(pickPack(packs, null), 'nobbox');
});

// ── the world-copy longitudes Leaflet hands back ────────────────────────────
// Pan a map sideways onto the next copy of the world and every latlng arrives
// offset by 360. osmium rejects those coordinates outright, and the build then
// failed carrying the CLIPPING step's name — which read as "outside the
// province" and only happened after a sideways pan.

// A wrapped value carries the usual float remainder, so these compare to well
// inside a millimetre rather than bit-for-bit.
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test('a longitude off the next world copy wraps back onto the real one', () => {
  near(wrapLng(-439.9), -79.9);
  near(wrapLng(280.1), -79.9);
});

test('a longitude already on the real world is returned untouched', () => {
  // Exactly, not approximately: wrapping unconditionally would put a float
  // wobble on every rectangle drawn, which is every case but the panned one.
  assert.equal(wrapLng(-79.9), -79.9);
  assert.equal(wrapLng(0), 0);
  assert.equal(wrapLng(180), 180);
});

test('a rectangle drawn on a world copy normalizes to the real one', () => {
  const b = normalizeBbox({ minLat:45.30, minLng:-440.10, maxLat:45.45, maxLng:-439.75 });
  assert.equal(b.minLat, 45.30);
  assert.equal(b.maxLat, 45.45);
  near(b.minLng, -80.10);
  near(b.maxLng, -79.75);
});

test('an already-sane rectangle is unchanged', () => {
  const b = { minLat:45.30, minLng:-80.10, maxLat:45.45, maxLng:-79.75 };
  assert.deepEqual(normalizeBbox(b), b);
});

test('a rectangle wrapped across the date line is refused, not inverted', () => {
  assert.equal(normalizeBbox({ minLat:45, minLng:170, maxLat:46, maxLng:190 }), null);
  assert.equal(normalizeBbox(null), null);
});

// ── trimming to where the extract actually has data ─────────────────────────
// Clipping outside the province does NOT fail at the clip — osmium writes an
// empty extract quite happily — it fails a minute later in the pack build with
// "No drivable segments found", which reads as a broken tool.
const ONTARIO = { minLat:41.6377, minLng:-95.15965, maxLat:57.50826, maxLng:-74.30998 };

test('a rectangle dragged past the edge is trimmed to the data', () => {
  const drawn = { minLat:41.0, minLng:-96.0, maxLat:43.0, maxLng:-94.0 };
  assert.deepEqual(clampBbox(drawn, ONTARIO),
    { minLat:41.6377, minLng:-95.15965, maxLat:43.0, maxLng:-94.0 });
  assert.equal(wasClamped(drawn, clampBbox(drawn, ONTARIO)), true);
});

test('a rectangle wholly inside the data is left alone', () => {
  const drawn = { minLat:45.30, minLng:-80.10, maxLat:45.45, maxLng:-79.75 };
  assert.deepEqual(clampBbox(drawn, ONTARIO), drawn);
  assert.equal(wasClamped(drawn, drawn), false);
});

test('a rectangle with no overlap at all has nothing to build', () => {
  assert.equal(clampBbox({ minLat:10, minLng:10, maxLat:11, maxLng:11 }, ONTARIO), null);
});

test('no known data bounds means no trimming, not an empty district', () => {
  const drawn = { minLat:45.30, minLng:-80.10, maxLat:45.45, maxLng:-79.75 };
  assert.deepEqual(clampBbox(drawn, null), drawn);
});

// Guards against the module drifting out of the offline shell — a phone would
// keep running the previous copy and never auto-pick at all.
test('the service worker ships the districts module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/districts\.js'/);
});

// The progress bar is determinate off a fixed phase list, so a phase renamed on
// one side and not the other silently stalls the bar at that step.
test('every phase the pack build reports is one the builder knows', () => {
  const server = readFileSync(new URL('../tools/roadpack-server.mjs', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../tools/build-roadpack.mjs', import.meta.url), 'utf8');
  const known = [...server.matchAll(/name:'([^']+)',\s*weight:/g)].map(m => m[1]);
  assert.ok(known.length >= 5, 'BUILD_PHASES did not parse');
  for(const m of builder.matchAll(/onPhase\('([^']+)'\)/g))
    assert.ok(known.includes(m[1]), `BUILD_PHASES is missing "${m[1]}"`);
  // And the osmium steps advance it too, or the bar sits at 0 for the whole clip.
  assert.match(server, /setPhase\(job, label\)/);
  assert.match(server, /onPhase: p => setPhase\(job, p\)/);
});

test('the clip carries most of the weight, so the bar is not stuck on step 1', () => {
  const server = readFileSync(new URL('../tools/roadpack-server.mjs', import.meta.url), 'utf8');
  const weights = [...server.matchAll(/name:'([^']+)',\s*weight:(\d+)/g)]
    .map(m => ({ name:m[1], weight:Number(m[2]) }));
  const total = weights.reduce((n, p) => n + p.weight, 0);
  const clip = weights[0];
  assert.match(clip.name, /^Clipping/);
  // It measured ~79% of a small district's build; anything near an equal share
  // (1/9 ≈ 11%) means the weighting was flattened back out by accident.
  assert.ok(clip.weight / total > 0.4, `clip weight is only ${clip.weight}/${total}`);
});
