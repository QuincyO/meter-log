// A TAP on Optimize is fully offline — the owner's decision, 2026-11-16. That
// covers the address lookups as well as the road matrix: an address the
// district's own index cannot place PARKS, it is never sent to Google or
// OpenRouteService. Before this, a tap fell through to both on an index miss,
// and on 2026-11-16 a tap reported "lookups failed: OVER_QUERY_LIMIT" with both
// daily quotas already spent. The HOLD is still the online press.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geocodeOne, optimizeRoute } from '../js/route.js';

const stats = () => ({ cached:0,
  offline:{ attempted:0, resolved:0 }, nominatim:{ attempted:0, resolved:0 },
  google:{ attempted:0, resolved:0 }, ors:{ attempted:0, resolved:0 }, parked:0 });

function recordingFetch(){
  const calls = [];
  const fn = async url => {
    calls.push(String(url));
    // A hit from any online geocoder, so a call that slipped through would
    // also show up as a resolved address rather than a quiet miss.
    return { ok:true, status:200, json:async () => ({ status:'OK', results:[{
      geometry:{ location:{ lat:43.66, lng:-79.39 } }, formatted_address:'x',
      address_components:[] }], features:[] }) };
  };
  return { calls, fn };
}

test('an offline-only lookup never reaches Google or ORS', async () => {
  const before = globalThis.fetch;
  const rec = recordingFetch();
  globalThis.fetch = rec.fn;
  try {
    const s = stats();
    const hit = await geocodeOne('12 Nowhere St', { lat:43.65, lng:-79.38 }, null, s, null,
      { offlineOnly:true });
    assert.equal(hit, null, 'no district here, so the order parks');
    assert.deepEqual(rec.calls, [], 'no network geocoder may be asked');
    assert.equal(s.offline.attempted, 1, 'the district index is still tried');
    assert.equal(s.google.attempted, 0);
    assert.equal(s.ors.attempted, 0);
  } finally { globalThis.fetch = before; }
});

test('without the flag a miss still falls through online (the hold, the planner, Settings)', async () => {
  const before = globalThis.fetch;
  const rec = recordingFetch();
  globalThis.fetch = rec.fn;
  try {
    const hit = await geocodeOne('12 Nowhere St', { lat:43.65, lng:-79.38 }, null, stats());
    assert.ok(hit, 'Google answered');
    assert.match(rec.calls[0], /maps\.googleapis\.com\/maps\/api\/geocode/);
  } finally { globalThis.fetch = before; }
});

test('a tap-shaped optimizeRoute parks an unpinned order instead of geocoding it online', async () => {
  const before = globalThis.fetch;
  const rec = recordingFetch();
  globalThis.fetch = rec.fn;
  try {
    const r = await optimizeRoute([
      { id:'a', address:'1 Main', lat:43.65, lng:-79.38 },
      { id:'b', address:'2 Main', lat:43.66, lng:-79.37 },
      { id:'c', address:'99 Unknown Rd' },
    ], null, null, { straightLine:true, offlineGeocode:true });
    assert.deepEqual(rec.calls.filter(u => /geocode/.test(u)), [],
      'no geocoding request left the phone');
    assert.deepEqual(r.parkedIds, ['c']);
    assert.equal(r.geoReason, null, 'nothing online was asked, so no key error to report');
    assert.equal(r.provenance.geocoding.google.attempted, 0);
    assert.equal(r.provenance.geocoding.ors.attempted, 0);
  } finally { globalThis.fetch = before; }
});

test('the phone hands the press to every lookup the Optimize handler makes', () => {
  const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
  assert.match(js, /offlineGeocode:\s*!useNetwork/, 'optimizeRoute is told a tap is offline');
  assert.match(js, /await homePin\(useNetwork\)/);
  assert.match(js, /await crewStartPin\(useNetwork\)/);
  assert.match(js, /async function homePin\(useNetwork\s*=\s*true\)/);
  assert.match(js, /async function crewStartPin\(useNetwork\s*=\s*true\)/);
});
