import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as addressText from '../js/worklist-address-fill.js';

import {
  addressQueue, fixReason, hasNoAddress, joinAddr, needsAddressFix,
  recentStreets, sinkAddressless, splitAddr,
} from '../js/worklist-address-fill.js';

const order = (id, extra = {}) => Object.assign({
  id, workOrderId: 'WO' + id, address: `${id} Main St`, wlStatus: 'pending', order: 0,
}, extra);

test('house-number shorthand separates units from the navigable address', () => {
  assert.equal(typeof addressText.parseAddressInput, 'function');
  for(const [num, street, want] of [
    ['14-a', 'Whatever Lane', { address:'14 Whatever Lane', unit:'a' }],
    ['13-2', 'Whatever Lane', { address:'13 Whatever Lane', unit:'2' }],
    [' 14 - rear door ', ' Whatever Lane ', { address:'14 Whatever Lane', unit:'rear door' }],
    ['14-C20-5', 'Whatever Lane', { address:'14 Whatever Lane', unit:'C20-5' }],
    ['14A', 'Whatever Lane', { address:'14A Whatever Lane', unit:'' }],
    ['14', 'Whatever Lane', { address:'14 Whatever Lane', unit:'' }],
    ['', '6740 Svorn River Shore', { address:'6740 Svorn River Shore', unit:'' }],
    ['', 'Bala Island', { address:'Bala Island', unit:'' }],
  ]) assert.deepEqual(addressText.parseAddressInput(num, street), want);
});

test('editing restores shorthand, clearing its suffix removes the unit, landmarks retain legacy units', () => {
  assert.equal(typeof addressText.addressFields, 'function');
  const item = { address:'14 Whatever Lane', unit:'rear door' };
  assert.deepEqual(addressText.addressFields(item), { num:'14-rear door', street:'Whatever Lane' });
  assert.deepEqual(addressText.parseAddressInput('14', 'Whatever Lane', item.unit),
    { address:'14 Whatever Lane', unit:'' });
  assert.deepEqual(addressText.parseAddressInput('', 'Bala Island', 'C20-5'),
    { address:'Bala Island', unit:'C20-5' });
  // Legacy hyphenated civic numbers stay literal. Saving untouched fields must
  // not silently change where Maps goes, even when the row already has a unit.
  const legacy = { address:'14-a Whatever Lane', unit:'rear door' };
  const fields = addressText.addressFields(legacy);
  assert.deepEqual(fields, { num:'', street:'14-a Whatever Lane' });
  assert.deepEqual(addressText.parseAddressInput(fields.num, fields.street, legacy.unit), legacy);
});

test('order labels distinguish meters without changing their base address', () => {
  assert.equal(typeof addressText.formatOrderAddress, 'function');
  assert.equal(addressText.formatOrderAddress({ address:'14 Whatever Lane', unit:'a' }),
    '14 Whatever Lane · Unit a');
  assert.equal(addressText.formatOrderAddress({ address:'13 Whatever Lane', unit:'2' }),
    '13 Whatever Lane · Unit 2');
  assert.equal(addressText.formatOrderAddress({ address:'14 Whatever Lane' }), '14 Whatever Lane');
  assert.equal(addressText.formatOrderAddress({ unit:'C20-5' }), 'Unit C20-5');
});

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

test('saving only a unit preserves the pin, changing the base address invalidates it, old callers preserve units', async () => {
  // Exercise the real persistence function with just IndexedDB replaced by an
  // in-memory row. Importing the whole worklist requires a browser.
  const source = js.match(/async function saveWorklistAddress\([^]*?\n\}/)?.[0];
  assert.ok(source);
  let row = { id:'a', address:'14 Whatever Lane', unit:'a', lat:45, lng:-79, geoFail:false };
  const save = runInNewContext(`(${source})`, {
    idb:{ get:async () => row, put:async (_store, value) => { row = value; } },
    stamp:() => '2026-09-29 12:00:00',
  });
  await save('a', '14 Whatever Lane', '2');
  assert.equal(row.unit, '2');
  assert.equal(row.lat, 45);
  assert.equal(row.lng, -79);
  await save('a', '14 Whatever Lane');
  assert.equal(row.unit, '2', 'an older walkthrough must not erase a unit');
  await save('a', '15 Whatever Lane', '');
  assert.equal(row.unit, '');
  assert.equal(row.lat, undefined);
  assert.equal(row.lng, undefined);
  assert.equal(row.geoFail, undefined);
});

test('picking a town saves the edited unit and old callers retain the saved detail', async () => {
  const source = js.match(/async function pickTown\([^]*?\n\}/)?.[0];
  let row = { id:'a', address:'13 Whatever Lane', unit:'rear door', geoAmbig:[{}] };
  const pick = runInNewContext(`(${source})`, {
    idb:{ get:async () => row, put:async (_store, value) => { row = value; } },
    stamp:() => '2026-09-29 12:00:00', toast:() => {},
    splitAddr, joinAddr,
    renderWorklist:async () => {}, planAdvance:async () => {},
  });
  const town = { label:'13 Whatever Lane, Huntsville, ON', lat:45.33, lng:-79.22 };
  await pick(row, town, 'upstairs');
  assert.equal(row.unit, 'upstairs');
  assert.equal(row.address, town.label);
  assert.equal(row.lat, 45.33);
  assert.equal(row.geoAmbig, undefined);
  await pick(row, town);
  assert.equal(row.unit, 'upstairs');
  await pick(row, town, undefined, '13-basement');
  assert.equal(row.address, '13-basement Whatever Lane, Huntsville, ON',
    'an older cached address helper must retain raw newly typed detail');
  assert.equal(row.unit, 'upstairs', 'an older caller must also retain the existing unit');
  await pick(row, { ...town, label:'13, Whatever Lane, Huntsville, Ontario, Canada' }, undefined, '13-basement');
  assert.equal(row.address, '13, Whatever Lane, Huntsville, Ontario, Canada (13-basement)',
    'unrecognized geocoder label formats still retain all typed detail');
});

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
