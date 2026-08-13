// The End-of-day bookend boxes open on the crew's normal shift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DAY_START_DEFAULT, DAY_END_DEFAULT, ROUTE_DEPART_TIME, ROUTE_DAY_END } from '../js/config.js';

const rd = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const captureJs = rd('../js/pages/capture.js');
const editJs    = rd('../js/pages/edit.js');

test('the defaults are 07:30 and 16:00', () => {
  assert.equal(DAY_START_DEFAULT, '07:30');
  assert.equal(DAY_END_DEFAULT, '16:00');
});

test('they are their own constants, not the route-planning clocks', () => {
  // ROUTE_DEPART_TIME anchors a planned route's first stop and ROUTE_DAY_END answers
  // exactly one question ("is today spent?"). Both are documented as single-purpose —
  // giving either a second job is how the finish-by dial came back last time. The
  // 16:00 collision is a coincidence and must stay one.
  assert.notEqual(DAY_START_DEFAULT, ROUTE_DEPART_TIME);
  assert.equal(ROUTE_DAY_END, '16:00', 'sanity: same value, deliberately separate constant');
  assert.ok(!/ROUTE_DEPART_TIME|ROUTE_DAY_END/.test(captureJs),
    'capture.js has reached for a route constant for the bookends');
});

test('End of day seeds both boxes from them', () => {
  assert.match(captureJs, /import \{ DAY_START_DEFAULT, DAY_END_DEFAULT \} from '\.\.\/config\.js'/);
  assert.match(captureJs,
    /\$\('eodDeparture'\)\.value=DAY_START_DEFAULT; \$\('eodReturned'\)\.value=DAY_END_DEFAULT;/);
  assert.ok(!/\$\('eodDeparture'\)\.value=''/.test(captureJs),
    'the open still blanks the departure box');
});

test('a time already saved for the day still wins', () => {
  // renderDayData's truthy guard is what makes the prefill a default rather than an
  // overwrite — it runs after the open, from the cache and again from the server.
  assert.match(captureJs, /if\(day\.departure\) \$\('eodDeparture'\)\.value = day\.departure;/);
  assert.match(captureJs, /if\(day\.returned\)  \$\('eodReturned'\)\.value  = day\.returned;/);
});

test('the back-office editor does not prefill', () => {
  // edit.html rebuilds arbitrary past days; a day that recorded no times must keep
  // printing blank rather than gain an invented 07:30–16:00.
  assert.ok(!/DAY_START_DEFAULT|DAY_END_DEFAULT/.test(editJs));
});
