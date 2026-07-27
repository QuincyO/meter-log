// District geometry: choosing a pack for a run, and growing one district's area.
// js/districts.js is pure, so this is a plain unit test — no IndexedDB, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bboxHas, unionBbox, bboxArea, unionWaste, isSparseUnion, pickPack, validBbox,
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

// Guards against the module drifting out of the offline shell — a phone would
// keep running the previous copy and never auto-pick at all.
test('the service worker ships the districts module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/districts\.js'/);
});
