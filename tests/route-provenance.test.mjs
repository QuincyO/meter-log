import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeRoute } from '../js/route.js';
import { ORS_API_KEY } from '../js/config.js';

// This one asserts the ORS *fallback path*, so it needs js/config.js to actually
// carry an ORS key — a blank one disables the fallback outright (config.js: "leave
// '' to disable the fallback entirely"), and optimizeRoute correctly makes no call
// at all. A tenant running without an ORS key (the js/config.example.js default —
// see ONBOARDING.md §6) would otherwise see this fail for a reason that has nothing
// to do with their change. Skip loudly rather than silently: the runner prints the
// reason, so the lost coverage is visible and not mistaken for a pass.
test('an unavailable desktop OSRM skips its fetch and uses ORS without Google Routes', {
  skip: ORS_API_KEY ? false : 'js/config.js has no ORS_API_KEY — ORS fallback is disabled',
}, async () => {
  const priorFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options={}) => {
    calls.push({ url:String(url), options });
    assert.match(String(url), /^https:\/\/api\.openrouteservice\.org\/v2\/matrix\/driving-car$/);
    return { ok:true, status:200, json:async () => ({ distances:[[0, 100], [100, 0]] }) };
  };

  try {
    const result = await optimizeRoute([
      { id:'one', address:'1 Main', lat:43.65, lng:-79.38 },
      { id:'two', address:'2 Main', lat:43.66, lng:-79.37 },
    ], null, null, { osrmUrl:'http://localhost:5000', osrmReady:false });

    assert.deepEqual(calls.map(x => x.url), ['https://api.openrouteservice.org/v2/matrix/driving-car']);
    assert.deepEqual(result.provenance, {
      geocoding:{
        cached:2,
        nominatim:{ attempted:0, resolved:0 },
        google:{ attempted:0, resolved:0 },
        ors:{ attempted:0, resolved:0 },
        parked:0,
      },
      routing:{ method:'matrix', provider:'ors', fallbackReason:'OSRM offline' },
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});
