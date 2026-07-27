// Code.gs cannot import an ES module, so siteKeyOf() there is a hand copy of
// siteKey() in js/route-dwell.js (which is itself built on js/roadgraph.js's
// normalizers). A silent drift between them is close to invisible in the field: the
// spine would key a site's history one way, the phone would look it up another, and
// every site factor would just quietly stop matching — no error, no wrong number,
// only a feature that never fires. So evaluate the real Apps Script source here and
// hold the two to the same output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteKey } from '../js/route-dwell.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'Code.gs'), 'utf8');

function extract(name, kind){
  // Declarations in Code.gs are top-level and brace/brace-balanced; take from the
  // declaration to the first line that closes it at column 0.
  const re = new RegExp(`^${kind} ${name}[\\s\\S]*?^\\};?$`, 'm');
  const hit = SRC.match(re);
  assert.ok(hit, `Code.gs no longer declares ${kind} ${name} — update this test with it`);
  return hit[0];
}

const siteKeyOf = new Function(
  extract('DWELL_SUFFIXES', 'const') + '\n' +
  extract('DWELL_DIRECTIONS', 'const') + '\n' +
  extract('siteKeyOf', 'function') + '\n' +
  'return siteKeyOf;'
)();

const CASES = [
  '123 Main St', '123 Main Street', '123A Main St', '  123   main st  ',
  '125 Main St', '45 Bay Rd', '45 Bay Road', '7 Lake St', '9 Lake St',
  'St Andrews Rd',            // the Saint trap: must not become "street andrews road"
  '12 Concession Rd 4',       // suffix mid-string still expands
  'N Main St', 'North Main Street',
  '88 Harbour Blvd', '88 harbour boulevard',
  '3 Pine Cres', '3 Pine Crescent',
  // Real shapes out of data/Stops.md: a geocoder string vs what the office types,
  // and the label-prefixed form that collapsed 34 addresses onto one key.
  '10 Island 19c, Carling, ON P0G 1G0, Canada', '10 Island 19c',
  '1 Island B, seguin ontario', '1 Island B, Seguin, ON P0C 1J0, Canada',
  'Town of, 14 Maple Heights Dr, Huntsville, ON P1H 1R7, Canada',
  'Town of, 18 Maple Heights Dr, Huntsville, ON P1H 1R7, Canada',
  '9RRX+CQ Carling, ON, Canada', '12 Goat Island',
  '', '   ', null, undefined, '404',
];

test('siteKeyOf in Code.gs matches siteKey in js/route-dwell.js', () => {
  for(const address of CASES){
    assert.equal(siteKeyOf(address), siteKey(address),
      `siteKey mismatch for ${JSON.stringify(address)}`);
  }
});

test('the parity cases actually cover the behaviour that matters', () => {
  // Guards against the above passing because both sides return '' for everything.
  assert.equal(siteKey('123 Main St'), siteKey('123 Main Street'));
  assert.notEqual(siteKey('123 Main St'), siteKey('125 Main St'));
  assert.ok(siteKey('St Andrews Rd').startsWith('st '),
    'the first word must not be suffix-expanded');
  assert.equal(siteKey('N Main St'), siteKey('North Main Street'));
});

test('a geocoded address and the typed one land on the same site', () => {
  // 396 of 457 logged stops carry the full geocoder string while the worklist
  // carries what was typed. If these ever diverge the site tier stops matching
  // entirely — silently, with no error and no wrong number.
  assert.equal(siteKey('10 Island 19c, Carling, ON P0G 1G0, Canada'), siteKey('10 Island 19c'));
  assert.equal(siteKey('1 Island B, seguin ontario'),
               siteKey('1 Island B, Seguin, ON P0C 1J0, Canada'));
});

test('a label-prefixed address keys on the street, not the label', () => {
  // "Town of, 14 Maple Heights Dr, …": taking comma-segment zero collapsed 34
  // distinct Huntsville houses onto the key "town of" and invented a busy site out
  // of unrelated stops — worse than not matching at all.
  const a = siteKey('Town of, 14 Maple Heights Dr, Huntsville, ON P1H 1R7, Canada');
  const b = siteKey('Town of, 18 Maple Heights Dr, Huntsville, ON P1H 1R7, Canada');
  assert.notEqual(a, b);
  assert.equal(a, siteKey('14 Maple Heights Dr'));
});
