import test from 'node:test';
import assert from 'node:assert/strict';

import { numbersIn, mergeEngines, newBatch, addPhoto, addTyped, removeFrom }
  from '../tools/wo-bot/extract.mjs';

// What Windows OCR actually returned for the reference photo of the handheld's
// cluster list (2026-10-08) — status bar, dialog header and buttons included.
const OCR_REFERENCE = `Honeywell
O 5GZ 090%
10:43 0 A
Time estimation for completing the cluster
Next
'iew Hetri
51 60 n Minute
902732
900821
905486
907209
902803
902580
900913
906876
907110
904048
900724
904899
902702
902686
901350
SELECT
CANCEL`;
const EXPECTED = ['902732','900821','905486','907209','902803','902580','900913',
  '906876','907110','904048','900724','904899','902702','902686','901350'];

test('the reference OCR text yields exactly the 15 work orders, in order', () => {
  assert.deepEqual(numbersIn(OCR_REFERENCE), EXPECTED);
});

test('the dialog header never reads as a work order', () => {
  assert.deepEqual(numbersIn('Time estimation for completing the cluster\n5160.0 Minute'), []);
  assert.deepEqual(numbersIn('516000.0 Minute'), []);
  assert.deepEqual(numbersIn('10:43 90%'), []);
});

test('only exactly six digits: five and seven are rejected', () => {
  assert.deepEqual(numbersIn('90273\n9027321\n902732'), ['902732']);
});

test('a vision model\'s list formatting is stripped', () => {
  assert.deepEqual(numbersIn('1. 902732\n2) 900821\n- 905486\n• 907209'),
    ['902732','900821','905486','907209']);
});

test('a number OCR split with a space is rejoined; repeats are dropped', () => {
  assert.deepEqual(numbersIn('902 732\n902732\n900821'), ['902732','900821']);
});

test('both engines agree → trusted; one engine only → unsure', () => {
  const m = mergeEngines(['902732','900821','905486'], ['902732','900821','905466']);
  assert.deepEqual(m.agreed, ['902732','900821']);
  assert.deepEqual(m.unsure, ['905486','905466']);
});

test('one engine down → nothing is trusted, all of the other is unsure', () => {
  assert.deepEqual(mergeEngines(['902732'], null), { agreed: [], unsure: ['902732'] });
  assert.deepEqual(mergeEngines(null, ['902732']), { agreed: [], unsure: ['902732'] });
});

test('overlapping photos: repeats are harmless, a later agreement promotes an unsure number', () => {
  const b = newBatch();
  let r = addPhoto(b, { agreed: ['902732','900821'], unsure: ['905486'] });
  assert.deepEqual(r, { read: 3, added: 2, promoted: 0, unsure: 1 });
  r = addPhoto(b, { agreed: ['900821','905486','907209'], unsure: [] });
  assert.deepEqual(r, { read: 3, added: 1, promoted: 1, unsure: 0 });
  assert.deepEqual(b.confirmed, ['902732','900821','905486','907209']);
  assert.deepEqual(b.unsure, []);
});

test('an unsure reading of a number already confirmed is not re-flagged', () => {
  const b = newBatch();
  addPhoto(b, { agreed: ['902732'], unsure: [] });
  addPhoto(b, { agreed: [], unsure: ['902732'] });
  assert.deepEqual(b.unsure, []);
});

test('typed numbers confirm directly, including an unsure one', () => {
  const b = newBatch();
  addPhoto(b, { agreed: [], unsure: ['905486'] });
  assert.deepEqual(addTyped(b, '905486 907209'), { found: 2, added: 2 });
  assert.deepEqual(b.confirmed, ['905486','907209']);
  assert.deepEqual(b.unsure, []);
});

test('remove drops a number from either list', () => {
  const b = { confirmed: ['902732','900821'], unsure: ['905486'] };
  assert.equal(removeFrom(b, '/remove 900821 905486'), 2);
  assert.deepEqual(b, { confirmed: ['902732'], unsure: [] });
});
