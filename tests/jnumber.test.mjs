import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeJScan, isCompleteJ } from '../js/jnumber.js';

// ── normalizeJScan: the one stateless rule behind J# capture ─────────────────

test('empty / null / undefined stay empty', () => {
  assert.equal(normalizeJScan(''), '');
  assert.equal(normalizeJScan(null), '');
  assert.equal(normalizeJScan(undefined), '');
});

test('a clean scan is kept and uppercased', () => {
  assert.equal(normalizeJScan('J1234567'), 'J1234567');
  assert.equal(normalizeJScan('j1234567'), 'J1234567');
});

test('a wrong barcode with no J wipes the field', () => {
  assert.equal(normalizeJScan('1234567'), '');       // just digits, no J
  assert.equal(normalizeJScan('012345678905'), '');  // a UPC-style code
  assert.equal(normalizeJScan('ABC-XYZ'), '');        // some other code
});

test('re-scan onto a wrong value: the newest J wins (replace, never append)', () => {
  // The wedge appended a fresh scan onto a stale one; the fresh J is last.
  assert.equal(normalizeJScan('J1234567J7654321'), 'J7654321');
});

test('a wrong scan appended onto a valid value keeps the valid one, drops the tail', () => {
  // No fresh J in the wrong scan, so the last J is still the good one.
  assert.equal(normalizeJScan('J1234567012345678905'), 'J1234567');
});

test('a partial (mid-type) prefix is left alone', () => {
  assert.equal(normalizeJScan('J'), 'J');
  assert.equal(normalizeJScan('J12'), 'J12');
});

test('an 8th digit is dropped — never more than 7', () => {
  assert.equal(normalizeJScan('J12345678'), 'J1234567');
});

test('leading noise before the J is discarded', () => {
  assert.equal(normalizeJScan('XJ1234567'), 'J1234567');
});

test('a trailing newline / carriage return from the scanner is absorbed', () => {
  assert.equal(normalizeJScan('J1234567\n'), 'J1234567');
  assert.equal(normalizeJScan('J1234567\r\n'), 'J1234567');
});

test('digits stop at the first non-digit after the J', () => {
  assert.equal(normalizeJScan('J12A34'), 'J12');
});

// ── isCompleteJ ──────────────────────────────────────────────────────────────

test('isCompleteJ accepts only J + exactly 7 digits', () => {
  assert.equal(isCompleteJ('J1234567'), true);
  assert.equal(isCompleteJ('J123'), false);
  assert.equal(isCompleteJ('J12345678'), false);
  assert.equal(isCompleteJ('1234567'), false);
  assert.equal(isCompleteJ(''), false);
});
