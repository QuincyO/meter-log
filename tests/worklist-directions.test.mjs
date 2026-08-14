// Tests for the 🧭 / Navigate hand-off in js/worklist.js — destOf() + the
// clipboard copy inside openDirections().
//
// These are source-text assertions rather than unit tests because worklist.js is
// DOM-bound (it imports dom.js/idb.js and touches `document` at module scope), so
// `node --test` cannot import it — the same convention as
// tests/worklist-card-layout.test.mjs and the openDirections ordering test in
// tests/worklist-address-fill.test.mjs.
//
// What they pin: which destination the hand-off uses is the installer's switch
// (Route tuning ▸ "Navigate by address instead of map pin"), it DEFAULTS to the
// pin, and each mode falls back to the other so Navigate is never a dead button.
// A parked order (geoFail / geoAmbig) keeps a stale pin that is never blanked and
// must NOT steer the truck — in either mode. The clipboard half is unchanged by
// all of this — it still copies the address line, never the coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const tuningJs = readFileSync(new URL('../js/worklist-tuning.js', import.meta.url), 'utf8');

const destOfBody = js.match(/function destOf\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';
const openDirectionsBody = js.match(/function openDirections\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';

test('destOf builds both destinations and lets the toggle pick', () => {
  assert.ok(destOfBody, 'destOf not found');
  assert.ok(destOfBody.includes("c.lat + ',' + c.lng"),
    'destOf no longer builds a lat,lng destination');
  assert.ok(destOfBody.includes("', ON'"),
    'destOf no longer builds an address destination');
  // Both are computed and the preference chooses, so there is no source ORDER to
  // assert any more (this used to be `coords < address`). What matters instead is
  // that each mode falls back to the other — Navigate must never go dead on an
  // order that has one of the two.
  assert.match(destOfBody,
    /navByPin\(\)\s*\?\s*\(\s*pinDest\s*\|\|\s*addrDest\s*\)\s*:\s*\(\s*addrDest\s*\|\|\s*pinDest\s*\)/,
    'each mode must fall back to the other destination');
  assert.match(js, /import\s*\{[^}]*\bnavByPin\b[^}]*\}\s*from\s*'\.\/worklist-tuning\.js'/,
    'destOf reads the preference from the tuning module (the cycle-free direction)');
});

test('the pin is the default — an unset key is not "address"', () => {
  // The behaviour shipped 2026-08-13. A phone that never opens Route tuning must
  // navigate exactly as it did before the toggle existed.
  assert.match(tuningJs, /export function navByPin\(\)\{\s*return store\.get\('wlNavBy'\) !== 'address';\s*\}/);
});

test('a parked order never navigates on its stale pin — in either mode', () => {
  // geoFail / geoAmbig orders keep their last-known pin (route.js never blanks
  // it) and it is precisely the pin known to be in the wrong place. isParked is
  // the repo's one "must not be routed on this pin" test — don't grow a second.
  assert.match(destOfBody, /isParked\(item\)\s*\?\s*null\s*:\s*coordsOf\(item\)/,
    'destOf must gate the pin on isParked, not just coordsOf');
  // And the gate must sit ABOVE the branch, so the carve-out is structural: a
  // parked order simply has no pinDest to prefer, whichever mode is on. Gate it
  // inside one arm and "coordinates mode" quietly starts steering by known-bad pins.
  assert.ok(destOfBody.indexOf('isParked(item)') < destOfBody.indexOf('navByPin()'),
    'the isParked gate must come before the navByPin branch, not inside it');
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
