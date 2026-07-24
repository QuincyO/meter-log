import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_DEPART_TIME } from '../js/config.js';

test('config exposes the org-wide departure time', () => {
  assert.equal(ROUTE_DEPART_TIME, '08:15');
});
