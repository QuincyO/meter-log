import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  addressQueue, fixReason, hasNoAddress, joinAddr, needsAddressFix,
  recentStreets, sinkAddressless, splitAddr,
} from '../js/worklist-address-fill.js';

const order = (id, extra = {}) => Object.assign({
  id, workOrderId: 'WO' + id, address: `${id} Main St`, wlStatus: 'pending', order: 0,
}, extra);

test('splitAddr / joinAddr survive a pasted whole address', () => {
  assert.deepEqual(splitAddr('6740 Svorn River Shore'), { num: '6740', street: 'Svorn River Shore' });
  assert.deepEqual(splitAddr('Bala Island'), { num: '', street: 'Bala Island' });
  // Pasting the whole thing into the street field still saves the right text.
  assert.equal(joinAddr('', '6740 Svorn River Shore'), '6740 Svorn River Shore');
  assert.equal(joinAddr('6740', 'Svorn River Shore'), '6740 Svorn River Shore');
});

test('recentStreets lists distinct streets, most recently added first', () => {
  const streets = recentStreets([
    order('a', { address: '1 Bay St' }),
    order('b', { address: '2 Bay St' }),
    order('c', { address: '3 Lake Rd' }),
  ]);
  assert.deepEqual(streets, ['Lake Rd', 'Bay St']);
});

test('the queue holds blank, unmapped and ambiguous orders — never a done one', () => {
  assert.equal(needsAddressFix(order('a', { address: '' })), true);
  assert.equal(needsAddressFix(order('b', { address: '   ' })), true);
  assert.equal(needsAddressFix(order('c', { geoFail: true })), true);
  assert.equal(needsAddressFix(order('d', { geoAmbig: [{ label: 'Bala' }, { label: 'Bracebridge' }] })), true);
  assert.equal(needsAddressFix(order('e')), false);
  assert.equal(needsAddressFix(order('f', { geoAmbig: [] })), false);
  assert.equal(needsAddressFix(order('g', { address: '', wlStatus: 'done' })), false);
});

test('a set-aside order still needs its address — it is work, just not today', () => {
  assert.equal(needsAddressFix(order('a', { address: '', ignored: true })), true);
});

test('addressQueue keeps the list order it was given', () => {
  const items = [
    order('a'),
    order('b', { address: '' }),
    order('c', { geoFail: true }),
    order('d'),
  ];
  assert.deepEqual(addressQueue(items).map(x => x.id), ['b', 'c']);
});

test('only a genuinely blank address sinks — a bad-but-typed one keeps its place', () => {
  assert.equal(hasNoAddress(order('a', { address: '' })), true);
  assert.equal(hasNoAddress(order('b', { geoFail: true })), false);
  assert.equal(hasNoAddress(order('c', { address: '', wlStatus: 'done' })), false);
});

test('sinkAddressless parks blank orders under the pending ones, above done and set-aside', () => {
  const items = [
    order('p1'),
    order('blank1', { address: '' }),
    order('p2'),
    order('done1', { wlStatus: 'done' }),
    order('blank2', { address: '' }),
    order('aside1', { ignored: true }),
  ];
  assert.deepEqual(sinkAddressless(items),
    ['p1', 'p2', 'blank1', 'blank2', 'done1', 'aside1']);
});

test('sinking leaves the addressed orders in the sequence they were already in', () => {
  const items = [order('c'), order('a'), order('blank', { address: '' }), order('b')];
  assert.deepEqual(sinkAddressless(items), ['c', 'a', 'b', 'blank']);
});

test('a set-aside order with no address sorts with the set-aside group, not the blanks', () => {
  // It is out of the route either way; keeping it in one place is what makes the
  // "set aside" group mean something.
  const items = [order('p'), order('aside', { address: '', ignored: true })];
  assert.deepEqual(sinkAddressless(items), ['p', 'aside']);
});

test('the reason line names the actual problem', () => {
  assert.match(fixReason(order('a', { address: '' })), /No address yet/);
  assert.match(fixReason(order('b', { geoFail: true })), /didn’t map/);
  assert.match(fixReason(order('c', { geoAmbig: [{ label: 'x' }, { label: 'y' }] })), /Matches 2 places/);
  assert.equal(fixReason(order('d')), '');
});

// ── wiring (source assertions — there is no DOM in the test runner) ──────────
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

test('the walkthrough has a screen, an entry button, and its own history entry', () => {
  assert.match(html, /id="wlAddrScreen"/);
  assert.match(html, /id="wlFillAddr"/);
  for(const id of ['wlAddrBack', 'wlAddrCount', 'wlAddrBar', 'wlAddrWo', 'wlAddrNum',
                   'wlAddrStreet', 'wlAddrTowns', 'wlAddrPrev', 'wlAddrSkip', 'wlAddrSave'])
    assert.match(html, new RegExp(`id="${id}"`), `index.html is missing #${id}`);
  assert.match(js, /pushState\(\{ wlAddr:1 \}, '', '#worklist-address'\)/);
  assert.match(js, /location\.hash === '#worklist-address'/);
});

test('leaving the walkthrough sinks the still-blank orders through the shared order writer', () => {
  assert.match(js, /persistOrderIds\(sinkAddressless\(before\)\)/);
  assert.match(js, /onDone: afterAddressFill/);
  // Locks and appointments are honoured because the sink reuses the drag path.
  assert.match(js, /async function persistOrderIds\(ordered\)/);
  assert.match(js, /persistOrderIds\(\[\.\.\.\$\('wlList'\)/);
});

test('the list marks the parked-for-no-address group', () => {
  assert.match(js, /wl-noaddr-head/);
  assert.match(js, /Needs address ·/);
  assert.match(css, /\.wl-noaddr-head\{/);
});

test('a changed address drops the stale pin so the next optimize re-geocodes', () => {
  assert.match(js, /async function saveWorklistAddress[\s\S]*?geoFail: undefined, geoAmbig: undefined/);
});

test('the service worker ships the new module', () => {
  assert.match(sw, /'\.\/js\/worklist-address-fill\.js'/);
});

test('directions copy the address before handing off to the maps app', () => {
  const fn = js.match(/function openDirections\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(fn, 'openDirections not found');
  assert.match(fn, /navigator\.clipboard\?\.writeText/);
  // Must precede the iOS scheme hand-off, which takes the page out from under us.
  assert.ok(fn.indexOf('clipboard') < fn.indexOf('comgooglemaps://'),
    'the clipboard write has to happen before the maps launch');
});
