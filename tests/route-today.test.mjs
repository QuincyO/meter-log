import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorDay1Ids, anchorTarget, day1Count, freshAnchorIds,
  insertByProximity, orderAnchorFirst, taggedDay1Ids,
} from '../js/route-today.js';

const items = ids => ids.map(id => ({ id }));

test('anchorDay1Ids keeps committed ids that are still pending, in list order', () => {
  const anchor = { date:'2026-07-24', ids:['a','b','c'] };
  // b was finished (gone from pending), x is a new order not in today's set.
  const pending = items(['c','a','x']);
  assert.deepEqual(anchorDay1Ids(anchor, pending), ['c','a']);
});

test('anchorDay1Ids coerces ids so number/string keys still match', () => {
  const anchor = { date:'d', ids:[1, 2] };
  assert.deepEqual(anchorDay1Ids(anchor, items(['2', '3'])), ['2']);
});

test('anchorDay1Ids is empty for a null anchor', () => {
  assert.deepEqual(anchorDay1Ids(null, items(['a'])), []);
});

test('anchorTarget reads the frozen target, null for a legacy anchor or junk', () => {
  assert.equal(anchorTarget({ date:'d', ids:['a'], target:6 }), 6);
  assert.equal(anchorTarget({ date:'d', ids:['a'], target:'24' }), 24);
  assert.equal(anchorTarget({ date:'d', ids:['a'] }), null);        // legacy {date, ids}
  assert.equal(anchorTarget({ target:0 }), null);
  assert.equal(anchorTarget({ target:'lots' }), null);
  assert.equal(anchorTarget(null), null);
});

test('freshAnchorIds prefers the current day-1 group when days are tagged', () => {
  // a,b are Day 1 (an optimizer time-shrunk day of 2); c,d are Day 2. Freeze Day 1.
  const pending = [
    { id:'a', day:1 }, { id:'b', day:1 }, { id:'c', day:2 }, { id:'d', day:2 },
  ];
  assert.deepEqual(freshAnchorIds(pending, 24), ['a', 'b']);
});

test('freshAnchorIds falls back to the first target ids for a never-routed list', () => {
  const pending = [{ id:'a' }, { id:'b' }, { id:'c' }, { id:'d' }];   // no day tags
  assert.deepEqual(freshAnchorIds(pending, 2), ['a', 'b']);
  assert.deepEqual(freshAnchorIds([{ id:'a' }, { id:'b' }], 5), ['a', 'b']);   // fewer than target
  assert.deepEqual(freshAnchorIds([{ id:'a' }, { id:'b' }], 0), ['a']);        // target floored to 1
});

test('freshAnchorIds ignores blank day tags (treated as unrouted)', () => {
  const pending = [{ id:'a', day:'' }, { id:'b', day:'' }, { id:'c', day:'' }];
  assert.deepEqual(freshAnchorIds(pending, 2), ['a', 'b']);
});

// ── the lock's set is the day the installer is looking at ─────────────────
// `opts.max` (a capacity bound on a mid-day target raise) and `opts.fromTags` (were
// the tags stale?) both existed to make an INFERRED re-commit behave. The 🔒 press is
// the only commit now, and it happens while the installer is looking at the day, so
// there is nothing to infer and nothing to bound.

test('taggedDay1Ids is the lowest tagged day, in list order', () => {
  const pending = [
    { id:'a', day:2 }, { id:'b', day:1 }, { id:'c', day:2 }, { id:'d', day:1 },
  ];
  assert.deepEqual(taggedDay1Ids(pending), ['b', 'd']);
});

test('taggedDay1Ids is empty for a list nothing has routed', () => {
  assert.deepEqual(taggedDay1Ids([{ id:'a' }, { id:'b', day:'' }]), []);
  assert.deepEqual(taggedDay1Ids([]), []);
  assert.deepEqual(taggedDay1Ids(null), []);
});

test('taggedDay1Ids does not assume the lowest day is 1', () => {
  // Day 1 finished and was pruned; day 2 is now the day in front of the crew.
  assert.deepEqual(taggedDay1Ids([{ id:'a', day:2 }, { id:'b', day:3 }]), ['a']);
});

test('orderAnchorFirst leads with today, preserving each group’s order', () => {
  assert.deepEqual(
    orderAnchorFirst(['t1', 'x1', 't2', 'x2'], ['t1', 't2']),
    ['t1', 't2', 'x1', 'x2']);
});

test('orderAnchorFirst is a no-op when today already leads', () => {
  assert.deepEqual(orderAnchorFirst(['a', 'b', 'c'], ['a', 'b']), ['a', 'b', 'c']);
});

// ── Day 1 is the LOCKED set, entire ────────────────────────────────────────
// It used to be min(target − installedToday + anchor.extend, |set ∩ pending|), which
// re-sized the day all day long. The tests below are the field report, as arithmetic.

test('day1Count is the whole committed set', () => {
  assert.equal(day1Count(['a','b','c','d','e']), 5);
  assert.equal(day1Count(['a','b']), 2);
});

test('day1Count of an empty or missing set is 0', () => {
  assert.equal(day1Count([]), 0);
  assert.equal(day1Count(null), 0);
  assert.equal(day1Count(undefined), 0);
});

test('a locked day is counted in ORDERS, and meters installed do not touch it', () => {
  // The report: 12 orders downloaded at a 24 meters/day target, each carrying two
  // meters. Day 1 used to be min(target − installed, |set|), so meters raced
  // membership and the tail of a day the installer had committed to was stamped day 2
  // by mid-morning — and a walk-up did the same to orders nobody had touched.
  // Nothing in this module reads an install count any more; there is no arithmetic
  // left for the day's size to lose to.
  const day1 = ['g','h','i','j','k','l'];
  assert.equal(day1Count(day1), 6);
  assert.equal(day1Count(day1), 6);   // …and it stays 6 whatever the crew installs.
});

test('meeting the meters/day target leaves the locked day’s orders on today', () => {
  // Old behaviour: capacity 0 ⇒ day1Count 0 ⇒ every remaining order stamped day 2+,
  // and the pace card gone from the screen with work still in front of the crew.
  assert.equal(day1Count(['x','y','z']), 3);
});

test('a spent locked day counts 0 — a real value, never "unset"', () => {
  // route-constraints.js reads null as "size day 1 by the target"; 0 means the locked
  // day holds nothing, which is the honest reading of a day whose work is done. A
  // truthiness test here hands a finished day a whole fresh target.
  assert.equal(day1Count([]), 0);
  assert.notEqual(day1Count([]), null);
});

// ── cheapest-insertion of a new order into a solved day ────────────────────

// Stops on a line at x = 0,10,20,30; `n` is the new order. dist() is |Δx|.
const LINE = { a:0, b:10, c:20, d:30 };
const lineDist = pos => (p, q) => {
  const A = { ...LINE, n:pos };
  return (A[p] == null || A[q] == null) ? null : Math.abs(A[p] - A[q]);
};

test('insertByProximity slots a new order beside its nearest neighbours', () => {
  // n sits at 12 — between b (10) and c (20).
  assert.deepEqual(
    insertByProximity(['a','b','c','d'], 'n', lineDist(12)),
    ['a','b','n','c','d']);
});

test('insertByProximity puts a new order at the front when that is cheapest', () => {
  assert.deepEqual(
    insertByProximity(['a','b','c','d'], 'n', lineDist(-30)),
    ['n','a','b','c','d']);
});

test('insertByProximity puts a new order at the end when that is cheapest', () => {
  assert.deepEqual(
    insertByProximity(['a','b','c','d'], 'n', lineDist(60)),
    ['a','b','c','d','n']);
});

test('insertByProximity moves an order already in the sequence', () => {
  // Re-placing 'd' (30) with the list out of order must not duplicate it.
  const out = insertByProximity(['a','d','b','c'], 'd', lineDist(30));
  assert.equal(out.filter(x => x === 'd').length, 1);
  assert.equal(out.length, 4);
});

test('insertByProximity parks an unpinnable order last', () => {
  assert.deepEqual(
    insertByProximity(['a','b','c'], 'n', () => null),
    ['a','b','c','n']);
});

test('insertByProximity handles an empty sequence', () => {
  assert.deepEqual(insertByProximity([], 'n', () => null), ['n']);
});


// ── locked, then an order is added by hand ─────────────────────────────────
// The one way work joins a day that is already settled (js/worklist.js acceptAddTo):
// cheapest-insertion into the locked sequence, then the grown set leads the pending
// list and sizes day 1. Nothing is displaced to make room — the day simply runs on.
test('an order added to a locked day joins it without pushing anything out', () => {
  const day1 = insertByProximity(['a','b','c','d'], 'n', lineDist(12));
  assert.deepEqual(day1, ['a','b','n','c','d']);
  // The whole pending list, with two orders that belong to later days.
  const seq = orderAnchorFirst(['a','x','b','n','c','y','d'], day1);
  assert.deepEqual(seq, ['a','b','n','c','d','x','y']);
  // Day 1 grew by exactly the one added order; x and y stayed where they were.
  assert.equal(day1Count(day1), 5);
});
