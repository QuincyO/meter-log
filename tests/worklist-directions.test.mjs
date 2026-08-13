// Tests for the 🧭 / Navigate hand-off in js/worklist.js — destOf() + the
// clipboard copy inside openDirections().
//
// These are source-text assertions rather than unit tests because worklist.js is
// DOM-bound (it imports dom.js/idb.js and touches `document` at module scope), so
// `node --test` cannot import it — the same convention as
// tests/worklist-card-layout.test.mjs and the openDirections ordering test in
// tests/worklist-address-fill.test.mjs.
//
// What they pin: navigation goes to the ORDER'S PIN when it has a trusted one,
// and falls back to the typed address only when it doesn't. A parked order
// (geoFail / geoAmbig) keeps a stale pin that is never blanked and must NOT steer
// the truck. The clipboard half is unchanged by all of this — it still copies the
// address line, never the coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');

const destOfBody = js.match(/function destOf\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';
const openDirectionsBody = js.match(/function openDirections\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';

test('destOf prefers the pin over the address text', () => {
  assert.ok(destOfBody, 'destOf not found');
  const coords = destOfBody.indexOf("c.lat + ',' + c.lng");
  const address = destOfBody.indexOf("', ON'");
  assert.ok(coords >= 0, 'destOf no longer builds a lat,lng destination');
  assert.ok(address >= 0, 'destOf no longer builds an address destination');
  // The maps app re-geocodes an address string with a guess of its own; the pin
  // is the exact spot the route map draws. Pin first, address as the fallback.
  assert.ok(coords < address,
    'the coordinate destination has to be returned before the address falls back');
});

test('a parked order never navigates on its stale pin', () => {
  // geoFail / geoAmbig orders keep their last-known pin (route.js never blanks
  // it) and it is precisely the pin known to be in the wrong place. isParked is
  // the repo's one "must not be routed on this pin" test — don't grow a second.
  assert.match(destOfBody, /isParked\(item\)\s*\?\s*null\s*:\s*coordsOf\(item\)/,
    'destOf must gate the pin on isParked, not just coordsOf');
});

test('the clipboard still gets the address, never the coordinates', () => {
  assert.ok(openDirectionsBody, 'openDirections not found');
  assert.match(openDirectionsBody, /addressLabel\(item\)/);
  assert.match(openDirectionsBody, /navigator\.clipboard\.writeText\(label\)/);
  assert.doesNotMatch(openDirectionsBody, /writeText\(\s*dest\s*\)/,
    'the destination string (which may be lat,lng) must never reach the clipboard');
  // addressLabel is the card's own unit + address line, so what lands on the
  // clipboard is what the crew is looking at.
  const label = js.match(/function addressLabel\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(label, /item\.unit/);
  assert.match(label, /item\.address/);
});
