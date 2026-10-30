import test from 'node:test';
import assert from 'node:assert/strict';

import { numbersIn, newBatch, addPhoto, addTyped, removeFrom, sendOrder }
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

test('overlapping photos: repeats are harmless and counted once', () => {
  const b = newBatch();
  assert.deepEqual(addPhoto(b, ['902732','900821']), { read: 2, added: 2 });
  assert.deepEqual(addPhoto(b, ['900821','905486','907209']), { read: 3, added: 2 });
  assert.deepEqual(b.confirmed, ['902732','900821','905486','907209']);
});

test('typed numbers join the batch; one already there is not doubled', () => {
  const b = newBatch();
  addPhoto(b, ['905486']);
  assert.deepEqual(addTyped(b, '905486 907209'), { found: 2, added: 1 });
  assert.deepEqual(b.confirmed, ['905486','907209']);
});

test('remove drops a number from the batch', () => {
  const b = { confirmed: ['902732','900821','905486'] };
  assert.equal(removeFrom(b, '/remove 900821 905486 999999'), 2);
  assert.deepEqual(b, { confirmed: ['902732'] });
});

test('orders go up lowest work-order number first, without reordering the batch', () => {
  const b = { confirmed: ['907209','900821','905486','902732'] };
  assert.deepEqual(sendOrder(b), ['900821','902732','905486','907209']);
  assert.deepEqual(b.confirmed, ['907209','900821','905486','902732']);
});
