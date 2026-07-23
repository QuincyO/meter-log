import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeRoute } from '../js/route.js';

test('an unavailable desktop OSRM skips its fetch and uses ORS without Google Routes', async () => {
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
