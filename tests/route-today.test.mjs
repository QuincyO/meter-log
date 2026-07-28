import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorDay1Ids, anchorExtend, anchorTarget, day1Count, dayCapacity, freshAnchorIds,
  insertByProximity, needsCommit, orderAnchorFirst,
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

test('needsCommit: nothing pending never commits', () => {
  assert.equal(needsCommit(null, '2026-07-24', []), false);
});

test('needsCommit: no anchor or a stale date forces a fresh commit', () => {
  const pending = items(['a', 'b']);
  assert.equal(needsCommit(null, '2026-07-24', pending), true);
  assert.equal(needsCommit({ date:'2026-07-23', ids:['a'] }, '2026-07-24', pending), true);
});

test('needsCommit: a live set with work still on it is kept frozen', () => {
  assert.equal(needsCommit({ date:'2026-07-24', ids:['a'] }, '2026-07-24', items(['a', 'b'])), false);
});

test('needsCommit: an exhausted set rolls to the next chunk', () => {
  // every committed id is done/gone → time to move to the next day's orders.
  assert.equal(needsCommit({ date:'2026-07-24', ids:['z'] }, '2026-07-24', items(['a', 'b'])), true);
});

test('anchorTarget reads the frozen target, null for a legacy anchor or junk', () => {
  assert.equal(anchorTarget({ date:'d', ids:['a'], target:6 }), 6);
  assert.equal(anchorTarget({ date:'d', ids:['a'], target:'24' }), 24);
  assert.equal(anchorTarget({ date:'d', ids:['a'] }), null);        // legacy {date, ids}
  assert.equal(anchorTarget({ target:0 }), null);
  assert.equal(anchorTarget({ target:'lots' }), null);
  assert.equal(anchorTarget(null), null);
});

test('needsCommit: a raised target re-plans today, but only on an explicit Optimize', () => {
  const anchor = { date:'2026-07-24', ids:['a'], target:6 };
  const pending = items(['a', 'b']);
  // The Optimize press is the re-plan; typing a new number in the box is not.
  assert.equal(needsCommit(anchor, '2026-07-24', pending, { replan:true, target:24 }), true);
  assert.equal(needsCommit(anchor, '2026-07-24', pending, { replan:false, target:24 }), false);
  assert.equal(needsCommit(anchor, '2026-07-24', pending, { target:24 }), false);
});

test('needsCommit: an Optimize at an UNCHANGED target never unfreezes today', () => {
  // The whole reason the anchor exists: re-optimizing after finishing a few orders
  // must not refill Day 1 from the front of what's left.
  const anchor = { date:'2026-07-24', ids:['a'], target:24 };
  assert.equal(
    needsCommit(anchor, '2026-07-24', items(['a', 'b']), { replan:true, target:24 }), false);
});

test('needsCommit: a legacy anchor re-plans once on the next Optimize', () => {
  // No stored target ⇒ unknown ⇒ treated as changed, which is what unsticks a day
  // frozen under a target nobody can recover.
  const anchor = { date:'2026-07-24', ids:['a'] };
  const pending = items(['a', 'b']);
  assert.equal(needsCommit(anchor, '2026-07-24', pending, { replan:true, target:24 }), true);
  assert.equal(needsCommit(anchor, '2026-07-24', pending, { replan:false, target:24 }), false);
});

test('needsCommit: opts never overrides "nothing pending"', () => {
  assert.equal(needsCommit({ date:'d', ids:['a'], target:6 }, 'd', [], { replan:true, target:24 }), false);
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

// The tag preference is right only when something has just re-solved the tags at the
// target being frozen at — an Optimize does, the meters/day box on its own does not.
// Preferring stale tags there made a RAISED target do nothing at all: Day 1 is
// min(capacity, group.length), and the group was still sized for the smaller number,
// so the control worked downwards only. Reported as "I can't even change the amount
// of orders … they get stuck on a different value and never got updated."
test('freshAnchorIds ignores the day tags when told they are stale', () => {
  const tagged = [
    { id:'a', day:1 }, { id:'b', day:1 },                       // a Day 1 sized for target 2
    { id:'c', day:2 }, { id:'d', day:2 }, { id:'e', day:2 },
  ];
  // Default and explicit-true keep honouring the group — the Optimize path.
  assert.deepEqual(freshAnchorIds(tagged, 4), ['a', 'b']);
  assert.deepEqual(freshAnchorIds(tagged, 4, { fromTags:true }), ['a', 'b']);
  // fromTags:false takes the first `target` by count instead, so raising grows.
  assert.deepEqual(freshAnchorIds(tagged, 4, { fromTags:false }), ['a', 'b', 'c', 'd']);
  // Lowering still works either way.
  assert.deepEqual(freshAnchorIds(tagged, 1, { fromTags:false }), ['a']);
  // opts.max still binds — a mid-day resize may only grow into the room left.
  assert.deepEqual(freshAnchorIds(tagged, 4, { fromTags:false, max:3 }), ['a', 'b', 'c']);
});

test('freshAnchorIds caps the frozen set at opts.max (the day’s remaining room)', () => {
  const tagged = [{ id:'a', day:1 }, { id:'b', day:1 }, { id:'c', day:1 }, { id:'d', day:2 }];
  assert.deepEqual(freshAnchorIds(tagged, 24, { max:2 }), ['a', 'b']);   // tagged group trimmed
  assert.deepEqual(freshAnchorIds(tagged, 24, { max:9 }), ['a','b','c']); // roomier than the group
  const untagged = [{ id:'a' }, { id:'b' }, { id:'c' }];
  assert.deepEqual(freshAnchorIds(untagged, 24, { max:2 }), ['a', 'b']); // fallback capped too
  assert.deepEqual(freshAnchorIds(untagged, 2, { max:9 }), ['a', 'b']);  // target still binds
});

test('freshAnchorIds: an absent/null max is UNBOUNDED, not zero', () => {
  // Number(null) is 0 — a coercion that would silently freeze an empty day on the
  // very path (a day nobody has driven yet) that means "no limit".
  const tagged = [{ id:'a', day:1 }, { id:'b', day:1 }];
  assert.deepEqual(freshAnchorIds(tagged, 24, { max:null }), ['a', 'b']);
  assert.deepEqual(freshAnchorIds(tagged, 24, {}), ['a', 'b']);
  assert.deepEqual(freshAnchorIds(tagged, 24), ['a', 'b']);
  assert.deepEqual(freshAnchorIds(tagged, 24, { max:'lots' }), ['a', 'b']);
  assert.deepEqual(freshAnchorIds(tagged, 24, { max:0 }), []);   // an explicit 0 IS zero
});

test('orderAnchorFirst leads with today, preserving each group’s order', () => {
  assert.deepEqual(
    orderAnchorFirst(['t1', 'x1', 't2', 'x2'], ['t1', 't2']),
    ['t1', 't2', 'x1', 'x2']);
});

test('orderAnchorFirst is a no-op when today already leads', () => {
  assert.deepEqual(orderAnchorFirst(['a', 'b', 'c'], ['a', 'b']), ['a', 'b', 'c']);
});

// ── day capacity (target − meters actually installed today) ─────────────────

test('dayCapacity is the target less every meter installed today', () => {
  assert.equal(dayCapacity(20, 0), 20);
  assert.equal(dayCapacity(20, 5), 15);
  // The brief's case: 5 planned + 5 walk-ups both spend the day's room.
  assert.equal(dayCapacity(20, 10), 10);
});

test('dayCapacity floors at zero and never goes negative past the target', () => {
  assert.equal(dayCapacity(20, 20), 0);
  assert.equal(dayCapacity(20, 26), 0);
});

test('dayCapacity coerces junk: target floors at 1, installs at 0', () => {
  assert.equal(dayCapacity(0, 0), 1);
  assert.equal(dayCapacity(null, null), 1);
  assert.equal(dayCapacity(20, -4), 20);
  assert.equal(dayCapacity(20.7, 5.9), 15);
});

test('anchorExtend reads 0 for a legacy {date, ids} anchor or junk', () => {
  assert.equal(anchorExtend(null), 0);
  assert.equal(anchorExtend({ date:'d', ids:['a'] }), 0);
  assert.equal(anchorExtend({ extend:-3 }), 0);
  assert.equal(anchorExtend({ extend:'x' }), 0);
  assert.equal(anchorExtend({ extend:2 }), 2);
});

test('day1Count sizes today to the room left, not to the frozen count', () => {
  const anchor = { date:'d', ids:['a','b','c','d','e'] };
  // 5 orders still frozen for today, but only 3 meters of room left → 2 roll over.
  assert.equal(day1Count(anchor, ['a','b','c','d','e'], 3), 3);
});

test('day1Count never exceeds the orders today actually holds', () => {
  const anchor = { date:'d', ids:['a','b'] };
  assert.equal(day1Count(anchor, ['a','b'], 20), 2);
});

test('day1Count adds the installer’s explicit extend on top of capacity', () => {
  const anchor = { date:'d', ids:['a','b','c','d'], extend:2 };
  // 1 meter of room + 2 the installer agreed to work past it = 3.
  assert.equal(day1Count(anchor, ['a','b','c','d'], 1), 3);
});

test('day1Count returns 0 once the target is met with no extend', () => {
  // A full day: today keeps its identity, but no order fits — all roll to Day 2.
  assert.equal(day1Count({ date:'d', ids:['a','b'] }, ['a','b'], 0), 0);
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

test('needsCommit ignores capacity — a met target is full, not exhausted', () => {
  // The set still owns unfinished orders, so hitting the target must NOT roll
  // tomorrow's chunk into today; it only pushes today's leftovers out to Day 2.
  const anchor = { date:'2026-07-24', ids:['a', 'b'] };
  assert.equal(needsCommit(anchor, '2026-07-24', items(['a', 'b'])), false);
});
