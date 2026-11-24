// Field report, 2026-11-18: an Optimize tap asked "pick a town" for a road that
// crosses a municipal line, and the town picked put nine different addresses on
// one pin. The geocoder half is in tests/roadgraph.test.mjs. This file covers
// the two rules that live in js/route.js:
//   1. the district index settles a real tie by distance — the town nearest the
//      crew wins when it is clearly the nearest (the owner's rule), and
//   2. two different addresses on one exact pin are looked up again, so a list
//      pinned by the old clamp repairs itself on the next Optimize.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBest, sharedPinIds } from '../js/route.js';

// Two towns with the same street, ~9 km and ~45 km north of the crew.
const CREW = { lat: 43.000, lng: -81.000 };
const NEAR = { lat: 43.080, lng: -81.000, label: '10 Main St, Neartown', place: 'Neartown' };
const FAR  = { lat: 43.400, lng: -81.000, label: '10 Main St, Fartown',  place: 'Fartown' };
// A third, only a little farther out than NEAR: no clear winner between them.
const ALSO = { lat: 42.900, lng: -81.000, label: '10 Main St, Alsotown', place: 'Alsotown' };

test('the town clearly nearest the crew is taken without asking', () => {
  // Listed far-first, so "nearest" is doing the work rather than list order.
  const hit = pickBest([FAR, NEAR], CREW, { nearest:true });
  assert.equal(hit.label, NEAR.label);
  assert.equal(hit.ambig, undefined, 'no pick-a-town prompt');
  assert.equal(hit.lat, NEAR.lat);
});

test('two towns about as far away as each other still ask, nearest first', () => {
  const hit = pickBest([ALSO, NEAR], CREW, { nearest:true });
  assert.ok(hit.ambig, 'a close call is the installer\'s to make');
  assert.deepEqual(hit.ambig.map(c => c.label), [NEAR.label, ALSO.label]);
  assert.equal(hit.label, NEAR.label);
});

test('with no idea where the crew is, a tie is never broken silently', () => {
  const hit = pickBest([FAR, NEAR], null, { nearest:true });
  assert.ok(hit.ambig);
  assert.equal(hit.ambig.length, 2);
});

test('the online geocoders keep their own ranking and still ask', () => {
  // Google and ORS return matches in relevance order, and a nearer partial
  // match must not silently beat the exact one. Only the district index, whose
  // candidates are already equals, is settled by distance.
  const hit = pickBest([FAR, NEAR], CREW);
  assert.ok(hit.ambig);
  assert.equal(hit.label, FAR.label);
});

test('different addresses on one exact pin are flagged for another lookup', () => {
  const pin = { lat: 42.851533, lng: -81.599498 };
  const ids = sharedPinIds([
    { id:'a', address:'8583 Falconbridge Dr, Southwest Middlesex', ...pin },
    { id:'b', address:'8824 Falconbridge Dr, Southwest Middlesex', ...pin },
    { id:'c', address:'12 Elm St', lat: 42.9, lng: -81.5 },
  ]);
  assert.deepEqual([...ids].sort(), ['a', 'b']);
});

test('one address twice on one pin is left alone', () => {
  const pin = { lat: 42.9, lng: -81.5 };
  // Two meters at one civic address, with or without the town spelled out.
  const ids = sharedPinIds([
    { id:'a', address:'12 Elm St', ...pin },
    { id:'b', address:'12 elm st, Glencoe', ...pin },
    { id:'c', address:'', lat: 1, lng: 1 },
    { id:'d', address:'14 Elm St' },
  ]);
  assert.equal(ids.size, 0);
});

test('the orders on a shared pin are handed back pin by pin', async () => {
  const { sharedPinGroups } = await import('../js/route.js');
  const a = { lat: 42.911684, lng: -81.409719 }, b = { lat: 42.906428, lng: -81.417321 };
  const groups = sharedPinGroups([
    { id:'w8', address:'8 Wellington St, Delaware', ...a },
    { id:'p39', address:'39 Pleasant St, Delaware', ...b },
    { id:'w95', address:'95 Wellington St, Delaware', ...a },
    { id:'p41', address:'41 Pleasant St, Delaware', ...b },
    // Two meters at one address are one pin, rightly.
    { id:'j1', address:'1 John St, Delaware', unit:'A', lat: 42.9, lng: -81.4 },
    { id:'j2', address:'1 John St, Delaware', unit:'B', lat: 42.9, lng: -81.4 },
    { id:'none', address:'5 John St, Delaware' },
  ]);
  assert.deepEqual(groups.map(g => g.map(x => x.id)), [['w8', 'w95'], ['p39', 'p41']]);
  // sharedPinIds is the same answer, flattened: Optimize and the route map cannot disagree.
  assert.deepEqual([...sharedPinIds(groups.flat())].sort(), ['p39', 'p41', 'w8', 'w95']);
});
