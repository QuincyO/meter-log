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

// What Tesseract returned for the same photo at Telegram size, inside the Docker
// container (ocr.mjs tesseractOcr: fit to 2600 px, adaptive threshold, --psm 11).
// Far noisier than Windows OCR — the car interior and map read as junk lines, and
// the header comes out as "160.0 Minute" — and the numbers must still come out clean.
const TESSERACT_REFERENCE = "Y\n\n. »\n\nA}\n\nP\n\n&\n\n3\n\nPy\n\n.\n\n&\n\n0l\n\n—\n\ns\n\ns W\n\nR S Tl\n\nP aaaaiasai\n\nR Anesonrnasnll\n\n~Mh vt\n\n|\n\niaton b\n\noractig e Gt\n\n-\n\n160.0 Minute\n\n902732\n\n900821\n\n905486\n\n907209\n\n902803\n\n902580\n\n900913\n\n906876\n\nA\n\nb\n\nA\\\n\n0\n\net\n\n907110\n\nB\n\n-4\n\n(i\n\n904048\n\nL\n\ni\n\n\\n\n\nN\n\n900724\n\nWV\n\nN\n\n\"\n\nA\n\n/0\n\n904899\n\nW\\\n\nWy\n\nN\n\nWV\n\nW\\\n\nN\n\nN\n\n902702\n\nNN\n\nN\n\nAM\n\n902686\n\nL\n\n\\\\\\‘\\\n\no\n\nN\n\nN\n\nA\n\n901350\n\nR\n\nSELECT\n\nCANCEL\n\n“~\n\n’ y\n\n|\n\n&S\n\nIty\n\n~\n\n-e\n\n\"\n\n3\n\nA\\\n\nW\n\nB\n\nN\n\n-\n\nL F VRN Y\n\nT ——\n\nC A eama\n\noy\n\nB \\'\\\n\n\\})\n\n)\n\nAR\n\nA\n\nA\n\nS\n\nNy\n\n\\\n\nA\\\n\nN\n\nN\n\nLgai\n\nW\n\nN\n\n\\\n\nAN,\n\nWt\n\nW\n\n\\\n\nW\\\n\nAR\n\n)\n\nv L\n\nY\n\nLAY\n\n1\\\n\n\\\n\nvt\n\nN\n\n\"\\\n\nNN\n\n\\\n";

test('the reference Tesseract text yields exactly the 15 work orders, in order', () => {
  assert.deepEqual(numbersIn(TESSERACT_REFERENCE), EXPECTED);
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
