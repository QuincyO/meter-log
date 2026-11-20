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

test('the walkthrough chips list every street; the Edit form keeps its 6', () => {
  const many = Array.from({ length: 9 }, (_, i) => order('s' + i, { address: `${i + 1} Street${i} Rd` }));
  assert.equal(recentStreets(many).length, 6, 'the default stays 6 for the Edit form');
  assert.equal(recentStreets(many, Infinity).length, 9);
  const fill = readFileSync(new URL('../js/worklist-address-fill.js', import.meta.url), 'utf8');
  assert.match(fill, /recentStreets\(items, Infinity\)/, 'the walkthrough must ask for every street');
  const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');
  assert.match(css, /#wlAddrChips\{[^}]*max-height:[^}]*overflow-y:auto/,
    'unbounded chips must scroll in their own box, or they push the fields under the keyboard');
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
  // The real pinTypedCoords too, over the real coordinate parser: a typed
  // position is pinned at Save, not left for the next Optimize.
  const pinSource = js.match(/function pinTypedCoords\([^]*?\n\}/)?.[0];
  assert.ok(pinSource);
  const { coordsFromText } = await import('../js/route.js');
  const save = runInNewContext(`${pinSource}\n(${source})`, {
    idb:{ get:async () => row, put:async (_store, value) => { row = value; } },
    stamp:() => '2026-09-29 12:00:00',
    routeMod:{ coordsFromText },
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
  // Coordinates typed as the address: the pin is the text, and it is exact.
  await save('a', '42.933446,-81.486452', 'Railway Lights');
  assert.equal(row.lat, 42.933446);
  assert.equal(row.lng, -81.486452);
  assert.equal(row.exactPin, true);
  assert.equal(row.unit, 'Railway Lights');
  // Typing a real address over it makes it an ordinary order again.
  await save('a', '15 Whatever Lane', '');
  assert.equal(row.lat, undefined);
  assert.equal(row.exactPin, undefined);
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

// The No. box is focused on every order, so the phone keyboard covers the bottom
// of the screen. Everything tapped while typing has to sit above the fields.
test('the walkthrough keeps Save and the chips above the keyboard', () => {
  const screen = html.slice(html.indexOf('id="wlAddrScreen"'));
  const head = screen.slice(screen.indexOf('class="wl-head"'), screen.indexOf('</div>'));
  assert.match(head, /id="wlAddrSave"/, 'Save & next must live in the sticky header');
  const at = id => screen.indexOf(`id="${id}"`);
  for(const id of ['wlAddrChips', 'wlAddrTowns'])
    assert.ok(at(id) < at('wlAddrNum'), `#${id} must come before the address fields`);
  assert.match(css, /#wlAddrSave\{[^}]*width:auto/, 'the header Save must not stretch full width');
});

// A second Save stays in the original spot under Back/Skip, for when the keyboard
// is down. It is a new id, so it is bound defensively and ships hidden: older JS
// against this markup must not show a button that does nothing.
test('the walkthrough also has a bottom Save, hidden until the module binds it', () => {
  const screen = html.slice(html.indexOf('id="wlAddrScreen"'), html.indexOf('</section>', html.indexOf('id="wlAddrScreen"')));
  assert.match(screen, /class="primary hide" id="wlAddrSaveBottom"/);
  assert.ok(screen.indexOf('id="wlAddrSaveBottom"') > screen.indexOf('id="wlAddrSkip"'),
    'the bottom Save belongs under Back / Skip');
  const fill = readFileSync(new URL('../js/worklist-address-fill.js', import.meta.url), 'utf8');
  assert.match(fill, /const saveBottom = \$\('wlAddrSaveBottom'\);\s*if\(saveBottom\)\{ saveBottom\.classList\.remove\('hide'\); saveBottom\.onclick = save; \}/);
  assert.match(fill, /if\(saveBottom\) saveBottom\.textContent = /, 'both Saves must carry the same label');
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

// ── a unit with no house number, and coordinates typed as the street ─────────
test('a Number box of "-text" is a unit with no house number', () => {
  for(const [num, street, want] of [
    ['-Railway Lights', '42.933446,-81.486452',
      { address:'42.933446,-81.486452', unit:'Railway Lights' }],
    [' - Pump house ', ' Main St ', { address:'Main St', unit:'Pump house' }],
    // A lone dash is "no number, no unit": the way to clear a unit that has no
    // house number in front of it.
    ['-', 'Main St', { address:'Main St', unit:'' }],
  ]) assert.deepEqual(addressText.parseAddressInput(num, street, 'old unit'), want);
});

test('a unit with no house number shows as "-unit" and survives an untouched Save', () => {
  for(const item of [
    { address:'42.933446,-81.486452', unit:'Railway Lights' },
    { address:'Bala Island', unit:'C20-5' },
  ]){
    const f = addressText.addressFields(item);
    assert.equal(f.num, '-' + item.unit);
    assert.deepEqual(addressText.parseAddressInput(f.num, f.street, item.unit), item);
  }
  // No unit, no number: the box stays empty, as it always did.
  assert.deepEqual(addressText.addressFields({ address:'Bala Island' }),
    { num:'', street:'Bala Island' });
});

test('foundAddress adds the found town and keeps the typed house number', () => {
  const google = '123 Main St, Glencoe, ON N0L 1M0, Canada';
  assert.equal(typeof addressText.foundAddress, 'function');
  for(const [typed, found, want] of [
    ['123 Main St', google, '123 Main St, Glencoe'],
    // The pick-a-town chip wrote the municipality; Google names the community.
    ['123 Main St, Southwest Middlesex', google, '123 Main St, Glencoe'],
    // A town typed on the end with no comma.
    ['123 Main Street Glencoe', google, '123 Main St, Glencoe'],
    ['123 Main Street', google, '123 Main St, Glencoe'],
    // The pin sits on an estimate, so the nearest house has another number: the
    // street and town are still right, and the typed number is what was ordered.
    ['123 Main St', '127 Main St, Glencoe, ON N0L 1M0, Canada', '123 Main St, Glencoe'],
    ['123A Main St', 'Main St, Glencoe, ON, Canada', '123A Main St, Glencoe'],
    // A business name ahead of the address.
    ['123 Main St', 'Tim Hortons, 123 Main St, Glencoe, ON N0L 1M0, Canada', '123 Main St, Glencoe'],
    // The offline map's own label, and a Nominatim one.
    ['8583 Falconbridge Dr', '8583 Falconbridge Dr, Strathroy-Caradoc',
      '8583 Falconbridge Dr, Strathroy-Caradoc'],
    ['123 Main St', '123, Main Street, Glencoe, Southwest Middlesex, Ontario, Canada',
      '123 Main Street, Glencoe'],
    // Already current: the same text comes back, so the caller writes nothing.
    ['123 Main St, Glencoe', google, '123 Main St, Glencoe'],
  ]) assert.equal(addressText.foundAddress(typed, found), want, `${typed} <- ${found}`);
});

test('foundAddress leaves an order alone when the street is not the one typed', () => {
  for(const [typed, found] of [
    ['123 Main St', '8 Oak Ave, Glencoe, ON N0L 1M0, Canada'],
    ['123 Main St', 'WGM7+2X Glencoe, ON, Canada'],            // a plus code
    ['123 Main St', 'Glencoe, ON N0L 1M0, Canada'],            // a town, no street
    ['123 Main St', '123 Main St, ON N0L 1M0, Canada'],        // no town to add
    ['123 Main St', ''], ['123 Main St', null], ['', '123 Main St, Glencoe, ON'],
    ['Bala Island', 'Bala Island, Muskoka Lakes, ON'],         // a landmark, no number
    // "King St W" and "King St" can be two different roads.
    ['123 King St W', '123 King St, London, ON N6A 1C1, Canada'],
    ['123 King St', '123 King St W, London, ON N6A 1C1, Canada'],
  ]) assert.equal(addressText.foundAddress(typed, found), null, `${typed} <- ${found}`);
});

test('nearestAddress names the closest address to a typed coordinate', () => {
  assert.equal(typeof addressText.nearestAddress, 'function');
  for(const [found, want] of [
    ['1234 Glendon Dr, Komoka, ON N0L 1R0, Canada', '1234 Glendon Dr, Komoka'],
    ['Glendon Dr, Komoka, ON N0L 1R0, Canada', 'Glendon Dr, Komoka'],
    ['CN Yard, 1234 Glendon Dr, Komoka, ON N0L 1R0, Canada', '1234 Glendon Dr, Komoka'],
    ['1234 Glendon Dr, ON N0L 1R0, Canada', '1234 Glendon Dr'],
    ['WGM7+2X Komoka, ON, Canada', null],
    ['Komoka, ON N0L 1R0, Canada', null],
    ['', null], [null, null],
  ]) assert.equal(addressText.nearestAddress(found), want, String(found));
});

test('two addresses agree when number and street match, whatever the town', () => {
  assert.equal(typeof addressText.addressesAgree, 'function');
  const agree = addressText.addressesAgree;
  assert.equal(agree('123 Main St, Southwest Middlesex', '123 Main St, Glencoe, ON N0L 1M0, Canada'), true);
  assert.equal(agree('123 Main Street', '123 Main St, Glencoe, ON N0L 1M0, Canada'), true);
  assert.equal(agree('Bala Island', 'Bala Island, Muskoka Lakes, ON'), true);
  // The wrong house is still a conflict: that is what the chooser is for.
  assert.equal(agree('123 Main St', '125 Main St, Glencoe, ON'), false);
  assert.equal(agree('123 Main St', '123 Oak St, Glencoe, ON'), false);
  assert.equal(agree('', ''), false);
  assert.equal(agree('123 Main St', ''), false);
});

test('the Log screen asks nothing when only the town differs', () => {
  const cap = readFileSync(new URL('../js/pages/capture.js', import.meta.url), 'utf8');
  // Reached through the namespace: a phone can hold an older cached address
  // module, and a missing named import would take the whole Log screen with it.
  assert.match(cap, /import \* as addressText from '\.\.\/worklist-address-fill\.js'/);
  assert.doesNotMatch(cap, /import\s*\{[^}]*\baddressesAgree\b[^}]*\}/);
  const fn = cap.match(/async function fetchAddress\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(fn, /typeof addressText\.addressesAgree === 'function'/);
  assert.ok(fn.indexOf('addressesAgree') < fn.indexOf('showAddrConflict('),
    'the agreement test has to come before the chooser is shown');
});
