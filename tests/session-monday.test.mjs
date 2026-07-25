// Makes permanent the ad-hoc sweep that verified nextMondayExpiry() over every
// hour of 2026 (both DST transitions included) during the auth work — see
// HANDOFF.md. That check ran once by hand and was never committed as a test;
// this file is the same sweep, kept.
//
// Same reason as tests/auth-actions.test.mjs: Code.gs formats a timestamp in
// TIMEZONE but parses it back with a component-wise `new Date(y, m, d, …)`,
// which reads as HOST-local. That round-trip is only exact when the two agree
// — as they do in Apps Script, where the script timezone IS Toronto — and here
// it must be made to agree by forcing TZ before anything reads a clock.
process.env.TZ = 'America/Toronto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CODE = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');

function grab(re, label) {
  const m = CODE.match(re);
  assert.ok(m, `could not lift ${label} out of Code.gs — did it move or get renamed?`);
  return m[0];
}

// The whole dependency chain of nextMondayExpiry, lifted verbatim rather than
// re-implemented, so this test tracks the real function instead of a
// description of it.
const SRC = [
  grab(/const TIMEZONE\s*= [^\n]*/, 'TIMEZONE'),
  grab(/const SESSION_ANCHOR_HOUR[\s\S]*?const SESSION_MIN_MS\s*=[^\n]*/, 'the session constants'),
  grab(/function parseLocal\(s\) \{[\s\S]*?\n\}/, 'parseLocal'),
  grab(/function localMs\(v\) \{[\s\S]*?\n\}/, 'localMs'),
  grab(/function addDaysYmd\(ymd, n\) \{[\s\S]*?\nfunction nextMondayExpiry\(nowMs\) \{[\s\S]*?\n\}/,
       'addDaysYmd and nextMondayExpiry'),
].join('\n');

// ── Apps Script stub ────────────────────────────────────────────────────────
// nextMondayExpiry's only Apps Script dependency is Utilities.formatDate, called
// with either TIMEZONE ('u', 'yyyy-MM-dd') or the literal 'UTC' (addDaysYmd's
// noon-UTC construction, 'yyyy-MM-dd'). Everything else it uses — Date, Math,
// String — is a real JS global, already in scope inside `new Function`.
function spine() {
  const factory = new Function('FMT', `
    const Utilities = { formatDate: (d, tz, f) => FMT(d, tz, f) };
    ${SRC}
    return { nextMondayExpiry, addDaysYmd, localMs, parseLocal };
  `);
  return factory(formatDate);
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function formatDate(d, tz, fmt) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  if (fmt === 'u') return String(DOW.indexOf(p.weekday) + 1);
  if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
  throw new Error('unsupported formatDate pattern: ' + fmt);
}

// A second, independent read of a Toronto instant — used only to make
// assertions in this file, never fed back into the code under test — so a
// mistake in `formatDate` above can't hide a mistake in nextMondayExpiry.
function torontoParts(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).reduce((o, x) => (o[x.type] = x.value, o), {});
}

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SESSION_MIN_MS = 24 * HOUR_MS;

// ── The assumption this whole file rests on ─────────────────────────────────

test('forcing TZ=America/Toronto actually makes host-local Date read as Toronto', () => {
  // If this ever fails, every other assertion in this file is meaningless — it
  // would mean the component-wise `new Date(y, m, d, …)` round trip Code.gs
  // relies on (see the file header) is silently reading some other zone.
  // 2026-01-05 is a known Monday in Toronto; check it against host-local Date
  // rather than assuming the environment cooperates.
  assert.equal(new Date(2026, 0, 5).getDay(), 1,
    '2026-01-05 must read as a Monday — TZ=America/Toronto did not take effect');
});

// ── The sweep: every hour of 2026 ────────────────────────────────────────────

test('every hour of 2026: Monday 04:00 Toronto, at least 24h out, never more than 8 days', () => {
  const api = spine();
  const start = Date.UTC(2026, 0, 1, 0, 0, 0);
  const end = Date.UTC(2026, 11, 31, 23, 0, 0);
  let checked = 0;
  for (let nowMs = start; nowMs <= end; nowMs += HOUR_MS) {
    const exp = api.nextMondayExpiry(nowMs);
    const p = torontoParts(exp);
    const dow = DOW.indexOf(p.weekday) + 1;

    assert.equal(dow, 1,
      `nowMs=${new Date(nowMs).toISOString()} → expiry weekday ${p.weekday}, expected Monday`);
    assert.equal(`${p.hour}:${p.minute}:${p.second}`, '04:00:00',
      `nowMs=${new Date(nowMs).toISOString()} → expiry time ${p.hour}:${p.minute}:${p.second}, expected 04:00:00`);
    assert.ok(exp - nowMs >= SESSION_MIN_MS,
      `nowMs=${new Date(nowMs).toISOString()} → only ${(exp - nowMs) / HOUR_MS}h out, under the 24h floor`);
    assert.ok(exp - nowMs <= 8 * DAY_MS,
      `nowMs=${new Date(nowMs).toISOString()} → ${(exp - nowMs) / DAY_MS} days out, past the 8-day ceiling`);
    checked++;
  }
  assert.equal(checked, 8760, 'a non-leap year is 8760 hours — a gap here means the loop skipped one');
});

// ── The DST transitions by name ──────────────────────────────────────────────
// addDaysYmd is built at noon UTC specifically so these two dates can never
// slip onto the neighbouring calendar day (Code.gs:499-500). Naming them here
// makes that the sweep's whole reason for existing, not an incidental pass.

test('spring forward (Sun 8 Mar 2026, 02:00→03:00): still lands on Mon 9 Mar 04:00', () => {
  // Probes stay close to the 2am jump itself. A late-Sunday-evening probe is
  // deliberately NOT included here — that's a different rule (the 24h floor,
  // covered separately below) and would expect a different Monday entirely.
  const api = spine();
  const probes = [
    new Date(2026, 2, 7, 23, 0, 0).getTime(),  // Sat evening, before the transition day
    new Date(2026, 2, 8, 1, 0, 0).getTime(),   // Sun, still EST
    new Date(2026, 2, 8, 3, 0, 0).getTime(),   // Sun, just after the jump (EDT)
    new Date(2026, 2, 8, 4, 0, 0).getTime(),   // Sun, an hour later
  ];
  const wantExpiry = new Date(2026, 2, 9, 4, 0, 0).getTime(); // Mon 9 Mar 04:00 EDT
  for (const nowMs of probes) {
    const exp = api.nextMondayExpiry(nowMs);
    assert.equal(exp, wantExpiry,
      `nowMs=${new Date(nowMs).toString()} → expected Mon 9 Mar 04:00, got ${new Date(exp).toString()}`);
  }
});

test('fall back (Sun 1 Nov 2026, 02:00→01:00): still lands on Mon 2 Nov 04:00', () => {
  // Same reasoning as the spring-forward test above: no late-Sunday-evening
  // probe, because that hits the 24h floor instead of the DST edge.
  const api = spine();
  const probes = [
    new Date(2026, 9, 31, 23, 0, 0).getTime(), // Sat evening, before the transition day
    new Date(2026, 10, 1, 1, 0, 0).getTime(),  // Sun, the repeated 01:00 hour
    new Date(2026, 10, 1, 3, 0, 0).getTime(),  // Sun, after the fall-back (EST)
    new Date(2026, 10, 1, 4, 0, 0).getTime(),  // Sun, an hour later
  ];
  const wantExpiry = new Date(2026, 10, 2, 4, 0, 0).getTime(); // Mon 2 Nov 04:00 EST
  for (const nowMs of probes) {
    const exp = api.nextMondayExpiry(nowMs);
    assert.equal(exp, wantExpiry,
      `nowMs=${new Date(nowMs).toString()} → expected Mon 2 Nov 04:00, got ${new Date(exp).toString()}`);
  }
});

// ── The floor and the anchor, named ──────────────────────────────────────────

test('a Sunday late evening does not get the Monday five hours later — that is under the 24h floor', () => {
  // Sun 5 Apr 2026 23:00 → the very next Monday's 04:00 is only 5h away, so the
  // rule (see Code.gs:503-506) has to skip a full week and land on the Monday
  // AFTER that instead — 8 days out, the ceiling this same sweep checks.
  const api = spine();
  const now = new Date(2026, 3, 5, 23, 0, 0).getTime();
  const exp = api.nextMondayExpiry(now);
  const want = new Date(2026, 3, 13, 4, 0, 0).getTime(); // Mon 13 Apr, not Mon 6 Apr
  assert.equal(exp, want);
  assert.ok(exp - now >= SESSION_MIN_MS);
});

test('Monday 03:00 returns the following Monday, not the 04:00 an hour away', () => {
  // The anchor is a WEEKLY re-prompt, not "the next time it's 04:00" — a Monday
  // morning login, even shortly before the anchor hour, still expires next week
  // together with everyone else, not in an hour.
  const api = spine();
  const now = new Date(2026, 3, 6, 3, 0, 0).getTime(); // Mon 6 Apr 2026, 03:00
  const exp = api.nextMondayExpiry(now);
  const want = new Date(2026, 3, 13, 4, 0, 0).getTime(); // the FOLLOWING Monday
  assert.equal(exp, want);
});

test('Monday 05:00 (just past the anchor) also returns the following Monday', () => {
  const api = spine();
  const now = new Date(2026, 3, 6, 5, 0, 0).getTime(); // Mon 6 Apr 2026, 05:00
  const exp = api.nextMondayExpiry(now);
  const want = new Date(2026, 3, 13, 4, 0, 0).getTime(); // the FOLLOWING Monday
  assert.equal(exp, want);
});
