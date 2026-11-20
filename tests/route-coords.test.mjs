// Coordinates typed as an address. Some orders have no address at all — a set
// of railway lights on the side of a road — so the Street box takes
// "42.933446,-81.486452" and the order is pinned exactly there. No geocoder is
// asked: the installer gave the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as route from '../js/route.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('coordsFromText reads a lat,lng pair and nothing that could be an address', () => {
  assert.equal(typeof route.coordsFromText, 'function');
  assert.deepEqual(route.coordsFromText('42.933446,-81.486452'), { lat:42.933446, lng:-81.486452 });
  // Google Maps copies the pair with a space after the comma.
  assert.deepEqual(route.coordsFromText('  42.933446, -81.486452 '), { lat:42.933446, lng:-81.486452 });
  for(const text of [
    '', null, undefined,
    '123 Main St', '12, 34',            // whole numbers are not a position
    '42.933446', '42.933446,',
    '95.5,-81.4', '42.9,-181.2',        // off the globe
    '42.933446,-81.486452 Main St', '1234 Glendon Dr, Komoka',
  ]) assert.equal(route.coordsFromText(text), null, String(text));
});

test('a coordinate address is pinned as typed, and no geocoder is asked', async () => {
  const before = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return { ok:false, status:500, json:async () => ({}) }; };
  try {
    const stats = { cached:0, offline:{ attempted:0, resolved:0 },
      nominatim:{ attempted:0, resolved:0 }, google:{ attempted:0, resolved:0 },
      ors:{ attempted:0, resolved:0 }, parked:0 };
    // A centre a long way off: the radius gate is for geocoder guesses, and a
    // typed position is not a guess.
    const hit = await route.geocodeOne('42.933446,-81.486452', { lat:49.1, lng:-93.2 }, null, stats);
    assert.deepEqual(hit, { lat:42.933446, lng:-81.486452, label:'42.933446,-81.486452', source:'coords' });
    assert.deepEqual(calls, []);
    assert.equal(stats.offline.attempted + stats.google.attempted + stats.ors.attempted, 0);
  } finally { globalThis.fetch = before; }
});

test('a tap routes a coordinate order instead of parking it', async () => {
  const before = globalThis.fetch;
  globalThis.fetch = async () => ({ ok:false, status:500, json:async () => ({}) });
  try {
    const items = [
      { id:'a', address:'1 Main', lat:42.93, lng:-81.48 },
      { id:'b', address:'2 Main', lat:42.94, lng:-81.47 },
      { id:'c', address:'42.933446,-81.486452', unit:'Railway Lights' },
    ];
    const r = await route.optimizeRoute(items, null, null, { straightLine:true, offlineGeocode:true });
    assert.deepEqual(r.parkedIds, []);
    const c = items.find(x => x.id === 'c');
    assert.equal(c.lat, 42.933446);
    assert.equal(c.lng, -81.486452);
    assert.equal(c.exactPin, true);
  } finally { globalThis.fetch = before; }
});

test('a typed pin is never looked up again', () => {
  const fn = read('../js/route.js').match(/async function geocodeAll\([\s\S]*?\n\}/)?.[0] || '';
  // Out of the radius, or sharing a pin: both re-geocode from the address TEXT,
  // and once the nearest house has been written there the text is no longer
  // where the order is.
  assert.match(fn, /const stale = !item\.exactPin &&/);
  assert.match(fn, /shared\.has\(item\.id\) && !item\.exactPin/);
  // The label every geocoder returns is kept: it is where the town comes from
  // when there is no signal to ask Google about the pin.
  assert.match(fn, /geoLabel:/);
});

test('the phone carries exactPin through save, sync and Navigate', () => {
  const js = read('../js/worklist.js');
  assert.match(js.match(/function wireShape\(x\)\{[\s\S]*?\n\}/)?.[0] || '', /exactPin:/);
  assert.match(js.match(/async function applyDownloadedList\([\s\S]*?\n\}/)?.[0] || '', /exactPin:/);
  assert.match(read('../js/pages/planner.js').match(/function wireShape\(x\)\{[\s\S]*?\n\}/)?.[0] || '',
    /exactPin:/, 'an office upload must not blank the flag');
  // New route.js exports are reached through the namespace import.
  assert.doesNotMatch(js, /import\s*\{[^}]*\bcoordsFromText\b[^}]*\}/);
  assert.match(js, /typeof routeMod\.coordsFromText === 'function'/);
  for(const name of ['wlSave', 'saveWorklistAddress']){
    const fn = js.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || '';
    assert.match(fn, /pinTypedCoords\(/, `${name} pins typed coordinates`);
  }
});

test('a typed pin is the destination, whatever the Navigate switch says', () => {
  const body = read('../js/worklist.js').match(/function destOf\(item\)\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(body, /if\(item\.exactPin && pinDest\) return pinDest;/);
  // After the parked gate (a parked order has no pinDest), before the switch.
  assert.ok(body.indexOf('isParked(item)') < body.indexOf('item.exactPin'));
  assert.ok(body.indexOf('item.exactPin') < body.indexOf('navByPin()'));
});

test('the town pass changes the address text and nothing else', () => {
  const js = read('../js/worklist.js');
  const fn = js.match(/async function confirmFoundAddresses\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fn, 'confirmFoundAddresses not found');
  assert.doesNotMatch(fn, /\blat\s*:|\blng\s*:/, 'the pass must never move a pin');
  assert.match(fn, /isParked\(/, 'a parked order has no pin to trust');
  assert.match(fn, /syncWorklist\(\)/, 'or the Drive screen pulls the old text back');
  // Started after the route is saved, and not awaited: a slow lookup must not
  // hold the Optimize button.
  const handler = js.match(/async function optimizeRouteHandler\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(handler, /confirmFoundAddresses\(\)\.catch\(/);
  assert.doesNotMatch(handler, /await confirmFoundAddresses/);
});

test('exactPin is a synced Worklist column, appended last', () => {
  const code = read('../Code.gs');
  const wl = eval(code.match(/const WORKLIST_HEADERS = (\[[\s\S]*?\]);\r?\n/)[1]);
  assert.equal(wl[wl.length - 1], 'exactPin');
  assert.match(code, /o\.exactPin \? 'TRUE' : ''/, 'saveWorklist writes it');
  // A removed order that comes back keeps being a typed pin.
  const details = eval(code.match(/const WORKLIST_REMOVED_DETAILS = (\[[\s\S]*?\]);/)[1]);
  assert.ok(details.includes('exactPin'));
});
