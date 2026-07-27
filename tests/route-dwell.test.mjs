import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dwellLookup, siteKey, onSiteMinutes,
  MIN_ONSITE_MIN, SITE_FACTOR_MIN, SITE_FACTOR_MAX
} from '../js/route-dwell.js';

const at = (address, extra = {}) => ({ id:address, address, ...extra });

// ── siteKey ──────────────────────────────────────────────────────────────────

test('siteKey survives the ways one address gets written twice', () => {
  // The whole point: the office TYPES a worklist address, the field LOGGED the
  // Stops address months earlier. These have to land on the same key or the
  // history tier never fires.
  const k = siteKey('123 Main St');
  assert.equal(siteKey('123 Main Street'), k);
  assert.equal(siteKey('  123   main st  '), k);
  assert.equal(siteKey('123A Main St'), k);       // houseNumber takes the digits
});

test('siteKey separates different civic numbers on one street', () => {
  assert.notEqual(siteKey('123 Main St'), siteKey('125 Main St'));
});

test('siteKey ignores the unit, because two meters in one building are one site', () => {
  // The unit is a separate order field and never reaches siteKey — asserted here
  // because the repeat-meter tier depends on it staying that way.
  assert.equal(siteKey('45 Bay Rd'), siteKey('45 Bay Road'));
});

test('siteKey is empty for a blank address, and an empty key never matches', () => {
  assert.equal(siteKey(''), '');
  assert.equal(siteKey(null), '');
  const d = dwellLookup({ paceMin:30, onSiteMin:20, extraMeterMin:3 });
  // Two un-addressed orders must NOT be read as a repeat meter at one site.
  assert.equal(d.forItem(at(''), at('')), 20);
});

// ── the fallback tier: nothing measured ──────────────────────────────────────

test('with no measurements the dwell is exactly the old flat pace-derived number', () => {
  const d = dwellLookup({ paceMin:30 });
  assert.equal(d.base, onSiteMinutes(30));            // 30 − 10 nominal drive
  assert.equal(d.base, 20);
  assert.equal(d.forItem(at('1 A St')), 20);
  assert.equal(d.forItem(at('1 A St'), at('1 A St')), 20);  // no extraMeterMin ⇒ no cut
});

test('a measured on-site time replaces the pace guess as the base', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:26 });
  assert.equal(d.base, 26);
  assert.equal(d.forItem(at('1 A St')), 26);
});

test('a zero or nonsense measurement falls back rather than zeroing the day', () => {
  for(const onSiteMin of [0, -5, NaN, null, undefined, 'x']){
    assert.equal(dwellLookup({ paceMin:30, onSiteMin }).base, 20);
  }
});

// ── tier 1: repeat meter at an address already parked at ─────────────────────

test('a second meter at the same address takes extraMeterMin, not a full dwell', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:22, extraMeterMin:4 });
  assert.equal(d.forItem(at('7 Lake St')), 22);                  // first meter
  assert.equal(d.forItem(at('7 Lake St'), at('7 Lake St')), 4);   // second, same site
  assert.equal(d.forItem(at('7 Lake St'), at('9 Lake St')), 22);  // different site
});

test('extraMeterMin is allowed below MIN_ONSITE_MIN — the real number is small', () => {
  // Stops logs consecutive meters at one site a minute apart. Flooring this at
  // MIN_ONSITE_MIN would re-introduce most of the error the tier exists to remove.
  const d = dwellLookup({ paceMin:30, onSiteMin:22, extraMeterMin:2 });
  assert.ok(2 < MIN_ONSITE_MIN);
  assert.equal(d.forItem(at('7 Lake St'), at('7 Lake St')), 2);
});

test('an extraMeterMin slower than a fresh site is a bad fit and is capped at base', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:18, extraMeterMin:40 });
  assert.equal(d.forItem(at('7 Lake St'), at('7 Lake St')), 18);
});

// ── tier 2: a site with a track record ───────────────────────────────────────

test('a site factor scales the base dwell', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:20,
    siteFactors:{ [siteKey('3 Slow Rd')]:1.5, [siteKey('4 Fast Rd')]:0.6 } });
  assert.equal(d.forItem(at('3 Slow Rd')), 30);
  assert.equal(d.forItem(at('4 Fast Rd')), 12);
  assert.equal(d.forItem(at('5 Unknown Rd')), 20);   // no history ⇒ base
});

test('site factors are clamped at both ends and never below the on-site floor', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:20,
    siteFactors:{ [siteKey('1 Wild Rd')]:99, [siteKey('2 Wild Rd')]:0.001 } });
  assert.equal(d.forItem(at('1 Wild Rd')), 20 * SITE_FACTOR_MAX);
  assert.equal(d.forItem(at('2 Wild Rd')), Math.max(MIN_ONSITE_MIN, 20 * SITE_FACTOR_MIN));
});

test('the repeat-meter cut wins over a site factor at the same address', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:20, extraMeterMin:3,
    siteFactors:{ [siteKey('8 Pier St')]:2 } });
  assert.equal(d.forItem(at('8 Pier St')), 40);                    // first: factored
  assert.equal(d.forItem(at('8 Pier St'), at('8 Pier St')), 3);    // second: cut
});

// ── placeholders and averaging ───────────────────────────────────────────────

test('a missing item prices at base — simulateDay pads short days with placeholders', () => {
  // `__free_k` slot ids have no item behind them. Returning 0 here would let a
  // half-empty day pretend to finish early; throwing would break appointments.
  const d = dwellLookup({ paceMin:30, onSiteMin:20, extraMeterMin:3 });
  assert.equal(d.forItem(undefined), 20);
  assert.equal(d.forItem(null, at('1 A St')), 20);
  assert.equal(d.forItem(at('1 A St'), undefined), 20);
});

test('average walks the list in order so clusters are priced as the schedule will', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:20, extraMeterMin:5 });
  // Three stops, the last two sharing an address: 20 + 20 + 5 = 45 over 3.
  const avg = d.average([at('1 A St'), at('2 B St'), at('2 B St')]);
  assert.equal(avg, 15);
});

test('average of an empty route is the base, not NaN', () => {
  const d = dwellLookup({ paceMin:30, onSiteMin:20 });
  assert.equal(d.average([]), 20);
  assert.equal(d.average(null), 20);
});
