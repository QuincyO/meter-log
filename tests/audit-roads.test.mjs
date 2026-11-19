// js/audit-roads.js: the audit's only door to the device's offline road map. The
// router itself is tested in tests/roadgraph.test.mjs; here it is a stand-in, and
// the tests are about what the audit is handed and what happens when there is no map.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roadsFrom, loadAuditRoads } from '../js/audit-roads.js';

const A = { lat: 44.1, lng: -79.1 }, B = { lat: 44.2, lng: -79.2 }, C = { lat: 44.3, lng: -79.3 };

test('km is the drive in kilometres, asked once per pair, and null where the map cannot say', () => {
  const asked = [];
  const rg = { matrixRow: (g, from, to) => { asked.push([g, from, to]);
    return { D: [to[0].lat === B.lat ? 1500 : to[0].lat === C.lat ? Infinity : 0] }; }, path: () => [] };
  const roads = roadsFrom('graph', rg, 'Test District');
  assert.equal(roads.name, 'Test District');
  assert.equal(roads.km(A, B), 1.5);
  assert.equal(roads.km(A, B), 1.5);
  assert.equal(asked.length, 1, 'remembered');
  assert.deepEqual(asked[0], ['graph', A, [B]]);
  assert.equal(roads.km(A, C), null, 'no drive between them');
  assert.equal(roads.km(B, A), 0, 'the same spot on the road is a drive of nothing, not a miss');
  assert.equal(roadsFrom('g', { matrixRow: () => { throw new Error('corrupt'); }, path: () => [] }, '').km(A, B), null);
  assert.equal(roadsFrom('g', { matrixRow: () => null, path: () => [] }, '').km(A, B), null);
  assert.equal(roadsFrom('g', rg, '').name, 'offline road map');
});

test('path is the drive as points, and empty where the map cannot say', () => {
  let asked = 0;
  const rg = { matrixRow: () => ({ D: [1] }), path: (g, from, to) => { asked++; return to.lat === B.lat ? [[44.1, -79.1], [44.15, -79.12], [44.2, -79.2]] : null; } };
  const roads = roadsFrom('graph', rg, 'T');
  assert.equal(roads.path(A, B).length, 3);
  roads.path(A, B);
  assert.equal(asked, 1);
  assert.deepEqual(roads.path(A, C), []);
  assert.deepEqual(roadsFrom('g', { matrixRow: () => ({ D: [1] }), path: () => { throw new Error('x'); } }, '').path(A, B), []);
});

test('a device with no road map has no roads, and asking never throws', async () => {
  assert.equal(await loadAuditRoads([{ lat: 44.1, lng: -79.1 }, { lat: 44.2, lng: -79.2 }]), null);   // no IndexedDB here
  assert.equal(await loadAuditRoads([]), null);
  assert.equal(await loadAuditRoads(null), null);
  assert.equal(await loadAuditRoads([{ lat: '', lng: '' }, { lat: null, lng: null }]), null, 'no pin, so nothing to measure');
});

test('the module never downloads a road map', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../js/audit-roads.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /downloadPack|fetch\(|\.pack['"`]|apiGet|apiPost|setActivePack/);
  assert.match(src, /switchActive: false/);
});
