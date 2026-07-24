import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorDay1Ids, needsCommit, freshAnchorIds, orderAnchorFirst } from '../js/route-today.js';

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

test('orderAnchorFirst leads with today, preserving each group’s order', () => {
  assert.deepEqual(
    orderAnchorFirst(['t1', 'x1', 't2', 'x2'], ['t1', 't2']),
    ['t1', 't2', 'x1', 'x2']);
});

test('orderAnchorFirst is a no-op when today already leads', () => {
  assert.deepEqual(orderAnchorFirst(['a', 'b', 'c'], ['a', 'b']), ['a', 'b', 'c']);
});
