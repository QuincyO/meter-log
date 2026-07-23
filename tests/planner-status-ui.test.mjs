import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as plannerServices from '../js/planner-services.js';

const buildOptimizeConfirmation = plannerServices.buildOptimizeConfirmation || (() => undefined);
const createPlannerLastRunRecord = plannerServices.createPlannerLastRunRecord || (() => undefined);
const parsePlannerLastRunRecord = plannerServices.parsePlannerLastRunRecord || (() => undefined);

const html = readFileSync(new URL('../planner.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/planner.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../js/pages/planner.js', import.meta.url), 'utf8');

test('confirmation copy distinguishes cached runs and local provider readiness', () => {
  assert.deepEqual(buildOptimizeConfirmation({
    pendingCount:4, lookupCount:0, nominatimOnline:true, osrmOnline:true,
  }), {
    pendingCount:4,
    geocoding:'4 cached; no address lookup needed.',
    routing:'Local OSRM Matrix, with ORS API Matrix fallback, then Straight-line as the final fallback.',
  });

  assert.deepEqual(buildOptimizeConfirmation({
    pendingCount:5, lookupCount:3, nominatimOnline:false, osrmOnline:false,
  }), {
    pendingCount:5,
    geocoding:'2 cached; 3 need lookup through Google API, with ORS API fallback.',
    routing:'ORS API Matrix, then Straight-line as the final fallback.',
  });
});

test('planner last-run records add identity without retaining secrets and reject invalid storage', () => {
  const record = createPlannerLastRunRecord({
    at:'2026-07-22T12:00:00.000Z', installer:'Quincy Jones', hNumber:'H123', pendingCount:6,
    provenance:{
      geocoding:{ cached:2, nominatim:{attempted:2,resolved:1}, google:{attempted:1,resolved:1}, ors:{attempted:0,resolved:0}, parked:2 },
      routing:{ method:'matrix', provider:'osrm', fallbackReason:'' },
    },
    osrmUrl:'http://localhost:5000', apiKey:'never-store-me',
  });

  assert.deepEqual(record, {
    at:'2026-07-22T12:00:00.000Z',
    geocoding:{ cached:2, nominatim:{attempted:2,resolved:1}, google:{attempted:1,resolved:1}, ors:{attempted:0,resolved:0}, parked:2 },
    routing:{ method:'matrix', provider:'osrm', fallbackReason:'' },
    installer:'Quincy Jones', hNumber:'H123', pendingCount:6,
  });
  assert.deepEqual(parsePlannerLastRunRecord(JSON.stringify(record)), record);
  assert.equal(parsePlannerLastRunRecord('{broken'), null);
  assert.equal(parsePlannerLastRunRecord(JSON.stringify({ installer:'Quincy' })), null);
  assert.doesNotMatch(JSON.stringify(record), /localhost|never-store-me|apiKey/);
});

test('planner markup exposes inline live provider badges and an accessible confirmation dialog', () => {
  assert.match(html, /id="plOsrm"[^>]*>\s*<span[^>]+id="plOsrmStatus"[^>]+aria-live="polite"/s);
  assert.match(html, /id="plGeo"[^>]*>\s*<span[^>]+id="plGeoStatus"[^>]+aria-live="polite"/s);
  assert.match(html, /<dialog[^>]+id="plOptimizeDialog"[^>]*>[\s\S]*<h2[^>]+id="plOptimizeTitle"/);
  assert.match(html, /aria-labelledby="plOptimizeTitle"/);
  assert.match(html, /id="plConfirmPending"/);
  assert.match(html, /Geocoding/);
  assert.match(html, /Road routing/);
  assert.match(html, /id="plOptimizeCancel"[^>]*>Cancel</);
  assert.match(html, /id="plOptimizeConfirm"[^>]*>Optimize route</);
});

test('last optimization card follows planner actions and contains every required result field', () => {
  assert.match(html, /id="plOptimize"[\s\S]*id="plLastOptimize"[^>]+hide/);
  for(const id of ['plLastInstaller','plLastAt','plLastGeo','plLastParked','plLastRouting']){
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('provider badges use four accessible states and pulse only while using', () => {
  for(const state of ['checking','online','using','offline']){
    assert.match(css, new RegExp(`\\.provider-status\\.${state}`));
  }
  assert.match(css, /\.provider-status\.using\s+\.provider-dot\s*\{[^}]*animation/s);
  assert.doesNotMatch(css, /\.provider-status\.(?:checking|online|offline)\s+\.provider-dot\s*\{[^}]*animation/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:reduce\)[\s\S]*\.provider-status\.using\s+\.provider-dot[^{]*\{[^}]*animation\s*:\s*none/s);
});

test('planner imports Task 1 defaults and probes instead of duplicating local URLs', () => {
  assert.match(js, /from '\.\.\/planner-services\.js'/);
  assert.match(js, /DEFAULT_OSRM_URL/);
  assert.match(js, /DEFAULT_NOMINATIM_URL/);
  assert.match(js, /probeOsrm/);
  assert.match(js, /probeNominatim/);
  assert.doesNotMatch(js, /const\s+OSRM_DEFAULT/);
  assert.doesNotMatch(js, /const\s+NOMINATIM_DEFAULT/);
  assert.match(js, /\$\('plGeo'\)\.value\s*=\s*store\.get\('plannerGeocode'\)\s*\|\|\s*DEFAULT_NOMINATIM_URL/);
});
