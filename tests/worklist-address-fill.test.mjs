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

// ── Clear map pins (owner's request, 2026-11-23) ────────────────────────────
// Six orders were pinned in the wrong town and could not be fixed quickly in the
// field. Clearing the pin alone is not enough: after a wrong pin the app writes
// that pin's town onto the address, so the next lookup would find it again.

test('clearing a pin puts back the address as it was typed', () => {
  assert.equal(typeof addressText.clearedPin, 'function');
  const got = addressText.clearedPin({
    address: '6 York St, London', typedAddress: '6 York St, Delaware, ON N0L 1E0',
    lat: 42.9796, lng: -81.2549, geoLabel: '6 York St, London', geoSource: 'offline' });
  assert.equal(got.address, '6 York St, Delaware, ON N0L 1E0');
  for(const k of ['lat', 'lng', 'geoFail', 'geoAmbig', 'geoLabel', 'geoSource', 'typedAddress']){
    assert.ok(k in got, `${k} must be written`);
    assert.equal(got[k], undefined, k);
  }
});

test('with no typed copy saved, a pinned order keeps its address, town and all', () => {
  // It used to lose the town, so the nearest street to the phone would be taken.
  // The owner cleared 85 pins from London the evening it shipped: "95 Wellington
  // St, Delaware" became "95 Wellington St" and was pinned in London, and
  // "33 Caverhill Cres, Middlesex Centre" was pinned in Milton, 145 km away.
  // Nearly every town on a list is right. Throwing them all away to mend the
  // few that are wrong made the list worse.
  for(const address of [
    '95 Wellington St, Delaware', '6 York St, London, ON N6A 1A1', '6 York St', 'Bala Island, Muskoka',
  ]){
    const got = addressText.clearedPin({ address, lat: 42.98, lng: -81.25 });
    assert.equal(got.address, address);
    assert.equal(got.lat, undefined);
  }
});

test('an order that was never pinned keeps its own text', () => {
  // Never looked up, so the town on it is the one the installer typed.
  assert.equal(addressText.clearedPin({ address: '6 York St, Delaware, ON N0L 1E0' }), null);
  assert.equal(addressText.clearedPin({ address: '6 York St, Delaware', lat: '', lng: '' }), null);
  assert.equal(addressText.clearedPin(null), null);
});

test('a parked order with no pin has its flags reset and its text left alone', () => {
  const failed = addressText.clearedPin({ address: '6 Yrok St, Delaware', geoFail: true });
  assert.equal(failed.address, '6 Yrok St, Delaware');
  assert.equal(failed.geoFail, undefined);
  const ambig = addressText.clearedPin({ address: '6 York St, Delaware',
    geoAmbig: [{ label: '6 York St, London', lat: 1, lng: 2 }] });
  assert.equal(ambig.address, '6 York St, Delaware');
  assert.equal(ambig.geoAmbig, undefined);
});

test('the Clear map pins button, the typed copy and its guards are wired', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
  // Hidden in the markup and shown by the code that binds it, so a phone on the
  // new page and an older worklist.js never shows a button that does nothing.
  assert.match(html, /<button class="[^"]*\bhide\b[^"]*" id="wlClearPins"/);
  // A new id is bound defensively: the page and the module can be a deploy apart.
  assert.match(js, /const clearBtn = \$\('wlClearPins'\);\s*\n\s*if\(clearBtn\) clearBtn\.onclick = clearPins;/);
  assert.doesNotMatch(js, /\$\('wlClearPins'\)\.onclick/);
  // A logged order and a pin typed as coordinates are never cleared.
  assert.match(js, /const clearable = x => x\.wlStatus !== 'done' && !isExactPin\(x\)/);
  // The town-writing pass keeps what was typed, and only the first time.
  assert.match(js, /typedAddress: stored\.typedAddress \|\| typed/);
  // …and never writes onto an order whose pin has gone or moved meanwhile.
  assert.match(js, /if\(!at \|\| at\.lat !== pin\.lat \|\| at\.lng !== pin\.lng\) continue;/);
  // A list download keeps the typed copy while the address is unchanged.
  assert.match(js, /typedAddress: keptTyped\.get\(String\(o\.id\) \+ '\\n' \+ String\(o\.address\|\|''\)\)/);
  // Clearing pins never uploads: the list goes up with the next log, like any edit.
  const body = js.slice(js.indexOf('async function clearPins('), js.indexOf('// ── end clear pins'));
  assert.ok(body.length > 0, 'clearPins must exist');
  assert.doesNotMatch(body, /syncWorklist|wlUpload|saveWorklist/);
});

test('a typed copy with no town on it never replaces an address that has one', () => {
  // What the typed copy is FOR is a town the installer typed and the app wrote
  // over. A copy that is only the number and street has nothing to give back,
  // and putting it back would take the town off: the same damage as above. The
  // owner's phone holds 80 such copies from the evening the first version ran.
  for(const [address, typedAddress] of [
    ['95 Wellington St, London', '95 Wellington St'],
    ['33 Caverhill Crescent, Milton', '33 Caverhill Cres'],   // the lookup spelled the street out
    ['2 John St, Delaware', '2 john st'],
  ]) assert.equal(addressText.clearedPin({ address, typedAddress, lat: 42.9, lng: -81.4 }).address, address);
  // A town typed without a comma is still a town.
  assert.equal(addressText.clearedPin({ address: '6 York St, London', typedAddress: '6 York St Delaware',
    lat: 42.98, lng: -81.25 }).address, '6 York St Delaware');
});

test('the note for a shared pin names the other addresses and what moves the pin', () => {
  const pin = [
    { id:'w8', address:'8 Wellington St, Delaware' },
    { id:'w95', address:'95 Wellington St, Delaware' },
  ];
  const note = addressText.sharedPinReason(pin[1], pin);
  assert.match(note, /same spot as 8 Wellington St, and only one address can be there/);
  // Retyping the same address gets the same pin back, so the note must not say "retype".
  assert.match(note, /empty the No\. box and put the coordinates/);
  assert.doesNotMatch(note, /95 Wellington/);
  const many = ['1 A St', '2 A St', '3 A St', '4 A St', '5 A St'].map((address, i) => ({ id:'x' + i, address }));
  assert.match(addressText.sharedPinReason(many[0], many), /2 A St, 3 A St, 4 A St and 1 more/);
  assert.match(addressText.sharedPinReason(many[0], many.slice(0, 3)), /2 A St and 3 A St,/);
  // Nothing else on the pin: no note.
  assert.equal(addressText.sharedPinReason(pin[0], [pin[0]]), '');
});

test('the address screen takes a picked queue, and a review that changes nothing writes nothing', () => {
  const src = readFileSync(new URL('../js/worklist-address-fill.js', import.meta.url), 'utf8');
  const screen = src.slice(src.indexOf('export function initWorklistAddressFill('));
  assert.match(screen, /async function open\(pick\)/);
  assert.match(screen, /queue = pick\.ids\.map\(String\)\.filter\(id => live\.has\(id\)\);/);
  // The default queue is untouched: no pick, the fill-in walkthrough as before.
  assert.match(screen, /queue = addressQueue\(items\)\.map\(x => String\(x\.id\)\);/);
  // Looking and leaving must not re-write the list order or the schedule.
  assert.match(screen, /if\(review && !touched\) return;\s+await opts\.onDone\(\);/);
  // A note is about the pin the order had when the screen opened.
  assert.match(screen, /if\(now && now === pinsAtOpen\[String\(item\.id\)\]\) return note;/);
  const wl = readFileSync(new URL('../js/worklist.js', import.meta.url), 'utf8');
  assert.match(wl, /onFix: pick => \(pick && pick\.ids && pick\.ids\.length\) \? openAddressReview\(pick\)/);
  const review = wl.slice(wl.indexOf('async function openAddressReview('), wl.indexOf('async function showHashScreen('));
  assert.match(review, /if\(!\(await addrFill\.open\(pick\)\)\)\{ await routeView\.open\(\); return; \}/);
  assert.match(review, /history\.pushState\(\{ wlAddr:1 \}, '', '#worklist-address'\)/);
});
