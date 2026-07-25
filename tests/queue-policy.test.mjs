import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFlush, MAX_FLUSH_TRIES } from '../js/queue-policy.js';

const text = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const queue = text('js/queue.js');
const capture = text('js/pages/capture.js');
const indexHtml = text('index.html');

// ── the pure policy ─────────────────────────────────────────────────────────
test('a 2xx with ok / duplicate / flagged is delivered', () => {
  assert.equal(classifyFlush(true, { ok: true }, 0), 'delivered');
  assert.equal(classifyFlush(true, { ok: false, duplicate: true }, 0), 'delivered');
  assert.equal(classifyFlush(true, { ok: true, flagged: true }, 0), 'delivered');
});

test('a fresh definitive rejection counts a strike, not a park', () => {
  assert.equal(classifyFlush(true, { ok: false, error: 'unknown action' }, 0), 'retry-count');
  assert.equal(classifyFlush(true, { ok: false, error: 'OTHER downtime needs a note' }, 4), 'retry-count');
});

test('a definitive rejection parks once it has burned through its tries', () => {
  // The item that has already failed MAX-1 times parks on this attempt.
  assert.equal(classifyFlush(true, { ok: false, error: 'unknown action' }, MAX_FLUSH_TRIES - 1), 'park');
  assert.equal(classifyFlush(true, { ok: false, error: 'malformed body' }, MAX_FLUSH_TRIES + 3), 'park');
});

test("'bad token' is an auth problem, not a poison payload — it must never park", () => {
  // This case used to assert 'park', which is the bug: the payload is perfectly
  // valid and the ONLY thing wrong is the credential. Parking it meant a token
  // rotation set aside every un-synced write on every phone after six attempts.
  // See js/queue-policy.js AUTH_REJECT_RE and tests/queue-auth.test.mjs.
  assert.equal(classifyFlush(true, { ok: false, error: 'bad token' }, MAX_FLUSH_TRIES + 3), 'auth');
});

test("lock contention ('busy, retry') is transient — it never parks", () => {
  // The spine returns this when the script lock is held; it must retry forever, so
  // a quitting-time burst can never strand a write as "poison".
  assert.equal(classifyFlush(true, { ok: false, error: 'busy, retry' }, 0), 'retry');
  assert.equal(classifyFlush(true, { ok: false, error: 'busy, retry' }, MAX_FLUSH_TRIES + 10), 'retry');
});

test('transport failures are transient and never park', () => {
  assert.equal(classifyFlush(false, null, 0), 'retry');                 // HTTP 500 / non-JSON page
  assert.equal(classifyFlush(false, { ok: false }, MAX_FLUSH_TRIES), 'retry'); // !ok wins over tries
  assert.equal(classifyFlush(true, null, MAX_FLUSH_TRIES), 'retry');    // 2xx but unparseable body
});

// ── the flush/paint wiring that uses it ──────────────────────────────────────
test('flush skips parked items so a poison payload cannot wedge the FIFO', () => {
  assert.match(queue, /import \{ classifyFlush \} from '\.\/queue-policy\.js'/);
  assert.match(queue, /q\.find\(it => !it\._parked\)/);
  assert.match(queue, /_parked: true/);
});

test('the pill tells a truly-offline phone from an unresponsive spine', () => {
  assert.match(queue, /server not responding/);
  assert.match(queue, /navigator\.onLine/);
});

test('parked items can be un-parked and retried', () => {
  assert.match(queue, /export async function retryParked/);
  assert.match(queue, /_parked: false, _tries: 0/);
});

// ── the "Stuck uploads" review screen ────────────────────────────────────────
test('queue exposes the per-item review API', () => {
  assert.match(queue, /export async function parkedItems/);
  assert.match(queue, /export async function retryParkedOne/);
  assert.match(queue, /export async function discardParkedOne/);
});

test('discardParkedOne only deletes an item that is actually parked', () => {
  // Guard against a race deleting a write that is still trying (a real data loss).
  assert.match(queue, /if\(it && it\._parked\) await idb\.del\('queue', seq\)/);
});

test('the capture page has a stuck-uploads sheet wired to the pill', () => {
  assert.match(indexHtml, /id="stuckSheet"/);
  assert.match(indexHtml, /id="stuckList"/);
  assert.match(indexHtml, /id="stuckRetryAll"/);
  // Tapping the pill opens the review when something is parked.
  assert.match(capture, /const stuck = await parkedItems\(\);\s*\n\s*if \(stuck\.length\) openStuckSheet\(\)/);
  assert.match(capture, /function openStuckSheet\(\)\{ renderStuck\(\); openSheet\('stuckSheet'\); \}/);
});

test('discarding a stuck upload is confirmed first (it is unrecoverable)', () => {
  assert.match(capture, /discardParkedOne\(Number\(discard\.dataset\.seq\)\)/);
  assert.match(capture, /if\(!confirm\(/);
});
