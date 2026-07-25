// The offline queue must survive a credential change. Two invariants here, both
// learned the hard way (see js/queue-policy.js AUTH_REJECT_RE):
//
//   1. A credential is resolved at SEND time, never read back off the stored item.
//      Queued writes sit in IndexedDB for days; the token they were enqueued with
//      may be long rotated.
//   2. A credential rejection is NOT a poison payload. It must not count strikes
//      toward parking, or one rotation sets aside every un-synced write on every
//      phone — surfaced only as "N stuck" on the pill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFlush, isAuthReject, MAX_FLUSH_TRIES } from '../js/queue-policy.js';

const QUEUE_SRC = readFileSync(new URL('../js/queue.js', import.meta.url), 'utf8');

test('the spine\'s real bad-credential reply is classified as auth, not park', () => {
  // Code.gs doPost/doGet answer a failed credential check with exactly this body.
  const badToken = { ok: false, error: 'bad token' };
  assert.equal(classifyFlush(true, badToken, 0), 'auth');
  // The critical one: still 'auth' after the strike budget is exhausted. Before the
  // verdict existed this returned 'park' and the write was set aside.
  assert.equal(classifyFlush(true, badToken, MAX_FLUSH_TRIES), 'auth');
  assert.equal(classifyFlush(true, badToken, 99), 'auth');
});

test('auth rejections are recognized by explicit flag and by message', () => {
  assert.ok(isAuthReject({ ok: false, authError: 'expired' }), 'explicit server signal');
  assert.ok(isAuthReject({ ok: false, error: 'bad token' }));
  assert.ok(isAuthReject({ ok: false, error: 'Session expired' }));
  assert.ok(isAuthReject({ ok: false, error: 'unauthorized' }));
  assert.ok(isAuthReject({ ok: false, error: 'token revoked' }));
  // Not auth failures — these are genuine poison payloads and must still park.
  assert.ok(!isAuthReject({ ok: false, error: 'unknown action' }));
  assert.ok(!isAuthReject({ ok: false, error: 'OTHER downtime needs a note' }));
  assert.ok(!isAuthReject({ ok: true }));
  assert.ok(!isAuthReject(null));
});

test('a genuine poison payload still parks — the auth verdict did not widen', () => {
  const poison = { ok: false, error: 'unknown action' };
  assert.equal(classifyFlush(true, poison, 0), 'retry-count');
  assert.equal(classifyFlush(true, poison, MAX_FLUSH_TRIES - 1), 'park');
});

test('lock contention stays transient and uncounted', () => {
  assert.equal(classifyFlush(true, { ok: false, error: 'busy, retry' }, 99), 'retry');
});

test('a delivered write is still delivered', () => {
  assert.equal(classifyFlush(true, { ok: true }, 0), 'delivered');
  assert.equal(classifyFlush(true, { duplicate: true }, 0), 'delivered');
  assert.equal(classifyFlush(true, { flagged: true }, 0), 'delivered');
});

test('flush strips any stored credential and injects the current one', () => {
  // Guards the destructure in flush(): a `token` sitting on an item enqueued by an
  // older build must be discarded, not sent.
  assert.match(QUEUE_SRC, /token:\s*_staleToken/,
    'flush() must destructure the stored token out of the payload');
  assert.match(QUEUE_SRC, /\.\.\.stored,\s*\.\.\.authFields\(\)/,
    'the current credential must be spread in AFTER the stored fields, so it wins');
  // authFields() is the single place that knows what authenticates a request. It
  // lives in store.js as of per-user auth, so the direct api.js calls share it
  // rather than growing a second copy — but it must still be the queue's source.
  assert.match(QUEUE_SRC, /import \{ cfg, authFields \} from '\.\/store\.js'/,
    'the queue must import the shared authFields, not define its own');
  assert.ok(!/const authFields\s*=/.test(QUEUE_SRC),
    'a local copy here is how the queue and the direct calls drift apart');
  assert.match(readFileSync(new URL('../js/store.js', import.meta.url), 'utf8'),
    /export function authFields\(\)/, 'and store.js must actually export it');
});

test('no enqueue call site bakes a credential into the stored payload', () => {
  // The whole point of resolving at send time is undone if a call site stores one.
  for (const f of ['../js/pages/capture.js', '../js/drive-recorder.js', '../js/geocode.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/token\s*:\s*c\.token/.test(src),
      `${f} must not put a token on a queued payload — flush() injects it`);
  }
});
