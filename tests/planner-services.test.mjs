import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NOMINATIM_URL,
  DEFAULT_OSRM_URL,
  probeNominatim,
  probeOsrm,
  selectDesktopRoutingProviders,
  selectGeocodingProviders,
  createLastRunRecord,
  formatLastRunSummary,
} from '../js/planner-services.js';

const response = (body, ok=true, status=200) => ({ ok, status, json: async () => body });

test('probes the default local providers with their lightweight health endpoints', async () => {
  const urls = [];
  const fetch = async url => {
    urls.push(url);
    return url.startsWith(DEFAULT_OSRM_URL)
      ? response({ code:'Ok', distances:[[0, 120], [120, 0]] })
      : response({ status:0 });
  };

  assert.deepEqual(await probeOsrm({ fetch }), { provider:'osrm', online:true, reason:'' });
  assert.deepEqual(await probeNominatim({ fetch }), { provider:'nominatim', online:true, reason:'' });
  assert.match(urls[0], /^http:\/\/localhost:5000\/table\/v1\/driving\/-79\.38,43\.65;-79\.37,43\.66\?annotations=distance$/);
  assert.equal(urls[1], 'http://localhost:8080/status?format=json');
});

test('probes return structured offline results for invalid responses and timeouts', async () => {
  assert.deepEqual(await probeOsrm({ fetch: async () => response({ code:'InvalidQuery' }) }),
    { provider:'osrm', online:false, reason:'bad response' });
  assert.deepEqual(await probeNominatim({ fetch: () => new Promise(() => {}), timeoutMs:1 }),
    { provider:'nominatim', online:false, reason:'timeout' });
});

test('uses local Nominatim only after its health probe and preserves cached pins', () => {
  assert.deepEqual(selectGeocodingProviders({ nominatimOnline:true }), {
    providers:['nominatim', 'google', 'ors'], cached:'retain'
  });
  assert.deepEqual(selectGeocodingProviders({ nominatimOnline:false }), {
    providers:['google', 'ors'], cached:'retain'
  });
});

test('desktop routing never selects Google Routes when local OSRM is offline', () => {
  assert.deepEqual(selectDesktopRoutingProviders({ osrmOnline:false }), ['ors', 'haversine']);
  assert.deepEqual(selectDesktopRoutingProviders({ osrmOnline:true }), ['osrm', 'ors', 'haversine']);
});

test('makes a serializable key-free last-run record and concise summary', () => {
  const record = createLastRunRecord({
    at:'2026-07-22T12:00:00.000Z',
    provenance:{
      geocoding:{ cached:2, nominatim:{ attempted:2, resolved:1 }, google:{ attempted:1, resolved:1 }, ors:{ attempted:0, resolved:0 }, parked:1 },
      routing:{ method:'matrix', provider:'ors', fallbackReason:'OSRM offline' },
    },
    osrmUrl:'http://localhost:5000',
    nominatimUrl:'http://localhost:8080',
    apiKey:'must-not-persist',
  });

  assert.deepEqual(record, {
    at:'2026-07-22T12:00:00.000Z',
    geocoding:{ cached:2, nominatim:{ attempted:2, resolved:1 }, google:{ attempted:1, resolved:1 }, ors:{ attempted:0, resolved:0 }, parked:1 },
    routing:{ method:'matrix', provider:'ors', fallbackReason:'OSRM offline' },
  });
  assert.equal(formatLastRunSummary(record),
    'Geocoding: 2 cached; Nominatim 1/2; Google 1/1; ORS 0/0; 1 parked. Routing: matrix via ORS (OSRM offline).');
  assert.doesNotMatch(JSON.stringify(record), /key|must-not-persist/i);
});
