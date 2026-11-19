// The downloaded audit PDF (js/audit-pdf.js), built here with the real vendored
// jsPDF and read back from the PDF's own text. The PDF is written from the same
// sections as the page (js/audit-render.js), so these tests are about the writer:
// that every section arrives, in order, on as many pages as it takes, and that
// nothing the page keeps for the screen leaks in. Made-up days only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { prepareAudit, periodStats, dayDetail } from '../js/compute/audit.js';
import { auditPdfName, pdfText, periodPdfModel, dayPdfModel, drawAuditPdf, buildAuditPdf, auditPdfShare, mapFrame } from '../js/audit-pdf.js';
import { encodeTrack } from '../js/drive-track.js';

const { jsPDF } = createRequire(import.meta.url)('../js/vendor/jspdf.umd.min.js');
const WHO = 'Pat Example', TODAY = '2026-11-19';
const pad = n => String(n).padStart(2, '0');
function stopsOn(date, clocks, { pins = true } = {}){
  return clocks.map((c, i) => ({ id: `${date}-${i}`, timestamp: `${date} ${c}:00`, status: i === 2 ? 'UTI' : 'INSTALLED',
    workOrderId: String(900000 + i), address: `${i + 1} Main St`, lat: pins ? 44 + i * 0.0009 : null, lng: pins ? -79 + (i % 3) * 0.0007 : null }));
}
const every = (first, count, step = 6) => Array.from({ length: count }, (_, i) => {
  const [h, m] = first.split(':').map(Number), t = h * 60 + m + i * step;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
});
function weekdays(n, start = '2026-09-01'){
  const out = [], d = new Date(start + 'T12:00:00Z');
  while(out.length < n){ if(d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const DAY = '2026-11-02';
const DOWN = [
  { timestamp: `${DAY} 12:00:00`, category: 'DISPATCH', minutes: 30, note: 'gap 07:30–08:00' },
  { timestamp: `${DAY} 12:00:00`, category: 'WAREHOUSE', minutes: 20, note: 'gap 09:42–11:00' },
];
const prepOf = (stops, mode = 'land') => prepareAudit({ stops, downtime: DOWN, days: [] }, { installer: WHO, mode });
const HISTORY = n => weekdays(n).flatMap(d => stopsOn(d, every('09:00', 9)));
const LONG_DAY = stopsOn(DAY, [...every('09:00', 8), '11:00']);

// Every string the PDF draws, in drawing order.
const texts = doc => [...doc.output().matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1].replace(/\\([()\\])/g, '$1'));
const all = doc => texts(doc).join('\n');
const pages = doc => doc.internal.getNumberOfPages();
const period = (stops, mode) => { const prep = prepOf(stops, mode);
  return periodPdfModel({ name: WHO, prep, stats: periodStats(prep, { from: '', to: '' }), today: TODAY }); };
const day = (stops, date, drive = null) => { const prep = prepOf(stops);
  return dayPdfModel({ name: WHO, prep, detail: dayDetail(prep, date), drive, today: TODAY }); };
const inOrder = (text, list) => { let at = -1;
  for(const t of list){ const i = text.indexOf(t, at + 1); assert.ok(i > at, `"${t}" is missing or out of order`); at = i; } };

test('the file is named for the installer and the period or day', () => {
  assert.equal(auditPdfName({ name: WHO, from: '2026-09-01', to: '2026-11-05' }), 'Audit - Pat Example - 2026-09-01 to 2026-11-05.pdf');
  assert.equal(auditPdfName({ name: WHO, day: '2026-11-02' }), 'Audit - Pat Example - 2026-11-02.pdf');
  assert.equal(auditPdfName({ name: WHO }), 'Audit - Pat Example.pdf');
  assert.equal(auditPdfName({ name: 'A/B: "C" <D>', day: '2026-11-02' }), 'Audit - A B C D - 2026-11-02.pdf');
  assert.equal(period([...HISTORY(6), ...LONG_DAY]).fileName, 'Audit - Pat Example - 2026-09-01 to 2026-11-02.pdf');
  assert.equal(day([...HISTORY(6), ...LONG_DAY], DAY).fileName, 'Audit - Pat Example - 2026-11-02.pdf');
});

test('text the PDF font cannot draw is replaced, and the audit\'s own punctuation is kept', () => {
  assert.equal(pdfText('07:30–08:00 — a · b ‹ › “q” é'), '07:30–08:00 — a · b ‹ › “q” é');
  assert.equal(pdfText('a → b ← c'), 'a -> b <- c');
  assert.equal(pdfText('☰ 📊 My\taudit\nnow'), 'My audit now');
  assert.equal(pdfText(null), '');
  assert.equal(pdfText(12), '12');
});

test('the period PDF carries every section of the page, in order', () => {
  const model = period([...HISTORY(12), ...LONG_DAY, ...stopsOn('2026-11-03', ['10:00', '10:06'])]);
  const doc = buildAuditPdf(jsPDF, model);
  const text = all(doc);
  inOrder(text, ['Audit: Pat Example', 'HEADLINE', 'WHERE AN AVERAGE DAY GOES', 'UNLOGGED PAUSE TIME PER DAY', 'BY MONTH',
    'LOGGED DELAYS BY CATEGORY', 'OUTPUT', 'DAY BY DAY', 'METHOD AND LIMITS', 'What the data cannot show']);
  for(const piece of ['Land work', 'Statistics use the 13 days with 8 or more orders, of 14 days.', 'Unlogged pauses (unlogged breaks included)', 'Break or lunch, logged',
    'Close-out and drive home', 'Before the first meter, not logged', 'first meter 09:00', 'Tue Nov 3', 'under 8 orders',
    '1 long gap', 'Warehouse', 'Next door (under 60 m)', 'made Thu Nov 19, 2026'])
    assert.ok(text.includes(piece), piece);
  for(const d of weekdays(12)) assert.ok(text.includes(new Date(d + 'T12:00:00Z').getUTCDate() + ''), d);
  assert.doesNotMatch(text, /NaN|undefined|null|drive back|\[object/);
  assert.ok(pages(doc) >= 2);
  assert.match(text, new RegExp(`Page 1 of ${pages(doc)}`));
  assert.match(text, new RegExp(`Page ${pages(doc)} of ${pages(doc)}`));
});

test('a table longer than a page repeats its heading row', () => {
  const doc = buildAuditPdf(jsPDF, period(HISTORY(70)));
  const heads = texts(doc).filter(t => t === 'Longest pause').length;
  assert.ok(heads >= 2, `the Day by day heading row was drawn ${heads} time(s)`);
  assert.equal(texts(doc).filter(t => /^(Mon|Tue|Wed|Thu|Fri) [A-Z][a-z]{2} \d+$/.test(t)).length, 70, 'every day has its row');
});

test('a view with no days still makes a PDF that says so', () => {
  const model = period(HISTORY(3), 'boat');
  const text = all(buildAuditPdf(jsPDF, model));
  assert.match(text, /No logs for Pat Example in this view\./);
  assert.match(text, /The pause figures were checked against land work only\./);
  assert.doesNotMatch(text, /HEADLINE|NaN|undefined/);
  const none = all(buildAuditPdf(jsPDF, period([stopsOn(DAY, ['10:00', '10:06'])].flat())));
  assert.match(none, /No day with 8 or more orders/);
  assert.doesNotMatch(none, /NaN|undefined/);
});

test('the day PDF has the day\'s sections, the route and the method, and nothing kept for the screen', () => {
  const doc = buildAuditPdf(jsPDF, day([...HISTORY(8), ...LONG_DAY], DAY));
  const text = all(doc);
  inOrder(text, ['Audit: Pat Example', 'Mon Nov 2, 2026', 'TIMELINE OF THE DAY', 'PACE ON THIS ROUTE', 'THIS DAY, AND HOW IT COMPARES', 'DELAYS LOGGED THIS DAY',
    'ROUTE WORKED', 'EVERY LOG, IN ORDER', 'METHOD AND LIMITS']);
  for(const piece of ['30 worked days before (8 days)', 'All to date (9 days)', 'Dispatch (drive to the first order)',
    'before the first meter', 'It is the order worked, not the roads driven.', 'first meter', 'long gap', '900008'])
    assert.ok(text.includes(piece), piece);
  assert.doesNotMatch(text, /Pick a block|NaN|undefined|Show drive log|No drive log|Top \d+ km/i);
});

test('the route is drawn as one numbered pin per pinned order', () => {
  const draw = (stops, drive) => { const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const seen = { circle: 0, line: 0, image: 0 };
    for(const k of ['circle', 'line']){ const real = doc[k].bind(doc); doc[k] = (...a) => { seen[k]++; return real(...a); }; }
    doc.addImage = () => { seen.image++; };
    drawAuditPdf(doc, day(stops, DAY, drive));
    return { seen, text: all(doc) }; };
  const pinned = draw([...HISTORY(8), ...LONG_DAY]);
  assert.equal(pinned.seen.circle, 9);
  assert.equal(pinned.seen.image, 0, 'no street map unless one was fetched for it');
  const stops = LONG_DAY.map((s, i) => (i === 1 || i === 4 ? { ...s, lat: null, lng: null } : s));
  const some = draw([...HISTORY(8), ...stops]);
  assert.equal(some.seen.circle, 7);
  assert.match(some.text, /Not on the map: #2 900001 \(no pin\), #5 900004 \(no pin\)/);
  const none = draw([...HISTORY(8), ...stopsOn(DAY, every('09:00', 9), { pins: false })]);
  assert.equal(none.seen.circle, 0);
  assert.match(none.text, /No pins to draw/);

  // the drive log: its numbers when there are legs, its line only when switched on
  const t0 = 1790000000000;
  const track = [0, 10, 20, 30].map((s, i) => ({ lat: 44 + i * 0.001, lng: -79.001, t: t0 + s * 1000, spd: 12 }));
  const legs = [{ distanceM: 31400, driveMin: 52, maxSpeed: 23.4, gaps: [], startTime: t0, encoded: encodeTrack(track) }];
  const off = draw([...HISTORY(8), ...LONG_DAY], { legs, show: false });
  const on = draw([...HISTORY(8), ...LONG_DAY], { legs, show: true });
  assert.match(off.text, /Top 84 km\/h · average 36 km\/h · 31\.4 km · 52 min driving · 1 leg/);
  assert.ok(on.seen.line > off.seen.line, 'the track is drawn only when the overlay is on');
  assert.match(on.text, /where the truck drove/);
  assert.doesNotMatch(off.text, /where the truck drove/);
  assert.match(draw([...HISTORY(8), ...LONG_DAY], { legs: [], show: false }).text, /No drive log was recorded this day\./);
  assert.doesNotMatch(pinned.text, /No drive log|Top \d+ km|truck drove/i,'the phone has no drive log, and the PDF says nothing of one');
});

test('sheet values of any shape are drawn as text', () => {
  const stops = LONG_DAY.map(s => ({ ...s, workOrderId: '(a) \\ <b> → ☰', address: 'x'.repeat(300) }));
  const prep = prepareAudit({ stops: [...HISTORY(8), ...stops],
    downtime: [{ timestamp: `${DAY} 12:00:00`, category: 'A very long category name that nobody chose', minutes: 5, note: '' }], days: [] },
    { installer: WHO, mode: 'land' });
  const doc = buildAuditPdf(jsPDF, dayPdfModel({ name: 'N/A <x>', prep, detail: dayDetail(prep, DAY), drive: null, today: TODAY }));
  assert.match(all(doc), /\(a\) \\ <b> ->/);
  assert.ok(pages(doc) >= 1);
});

// ── Send PDF: the system share sheet ─────────────────────────────────────────

const setNavigator = value => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

test('sending is offered only where the browser can hand a PDF file to another app', () => {
  setNavigator({});
  assert.equal(auditPdfShare.can(), false, 'no share sheet at all');
  setNavigator({ share(){}, canShare: () => false });
  assert.equal(auditPdfShare.can(), false, 'a share sheet that takes links but not files');
  setNavigator({ share(){}, canShare(){ throw new TypeError('no'); } });
  assert.equal(auditPdfShare.can(), false);
  const asked = [];
  setNavigator({ share(){}, canShare: d => { asked.push(d); return true; } });
  assert.equal(auditPdfShare.can(), true);
  assert.equal(asked[0].files[0].type, 'application/pdf', 'it asks about a PDF, not about sharing in general');
});

test('the file handed over is the PDF the download makes, named and typed, and nothing goes with it', async () => {
  globalThis.window = { jspdf: { jsPDF } };
  const model = day([...HISTORY(8), ...LONG_DAY], DAY);
  const file = await auditPdfShare.file(model);
  assert.equal(file.name, 'Audit - Pat Example - 2026-11-02.pdf');
  assert.equal(file.type, 'application/pdf');
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString('latin1'), '%PDF-');
  const shared = [];
  setNavigator({ share: d => { shared.push(d); return Promise.resolve(); } });
  await auditPdfShare.send(file);
  assert.deepEqual(Object.keys(shared[0]), ['files'], 'the file alone: a title or text beside it makes some apps drop the file');
  assert.equal(shared[0].files[0], file);
});

// ── the route map: along the roads, and over the street map ──────────────────

test('the map frame keeps every point inside the box, north up, and centres a lone pin', () => {
  const f = mapFrame([[44.0, -79.0], [44.1, -78.9], [44.05, -79.2]], 528, 236);
  for(const p of [[44.0, -79.0], [44.1, -78.9], [44.05, -79.2]]){
    const [x, y] = f.at(p);
    assert.ok(x >= 17.9 && x <= 510.1 && y >= 17.9 && y <= 218.1, `${p} is at ${x}, ${y}`);
  }
  assert.ok(f.at([44.1, -79.0])[1] < f.at([44.0, -79.0])[1], 'north is up');
  assert.ok(f.at([44.0, -78.9])[0] > f.at([44.0, -79.0])[0], 'east is right');
  const one = mapFrame([[44.0, -79.0]], 528, 236);
  assert.deepEqual(one.at([44.0, -79.0]).map(Math.round), [264, 118]);
  assert.ok(isFinite(one.scale) && one.scale > 0);
});

test('the route is drawn along the roads it was handed, and over the street map when one was fetched', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const draw = change => { const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const seen = { line: 0, image: [] };
    const realLine = doc.line.bind(doc); doc.line = (...a) => { seen.line++; return realLine(...a); };
    doc.addImage = (...a) => { seen.image.push(a); };
    const model = day([...HISTORY(8), ...LONG_DAY], DAY);
    change(model.sections.find(s => s.title === 'Route worked').blocks.find(b => b.t === 'map'));
    drawAuditPdf(doc, model);
    return { seen, text: all(doc) }; };
  const straight = draw(() => {});
  assert.deepEqual(straight.seen.image, []);
  assert.doesNotMatch(straight.text, /OpenStreetMap/);
  // three points a gap instead of two: twice the line pieces
  const pins = LONG_DAY.map(s => [s.lat, s.lng]);
  const roads = draw(map => { map.lines = pins.slice(1).map((p, i) => [pins[i], [pins[i][0] + 0.0002, pins[i][1] + 0.0002], p]); });
  assert.equal(roads.seen.line - straight.seen.line, 8);
  // the street map, at the size of the box, with its credit
  const mapped = draw(map => { map.image = { data: PNG, w: 528, h: 236 }; });
  assert.equal(mapped.seen.image.length, 1);
  assert.deepEqual(mapped.seen.image[0].slice(1, 3).concat(mapped.seen.image[0].slice(4)), ['PNG', 42, 528, 236]);
  assert.match(mapped.text, /© OpenStreetMap contributors/);
  // a picture made for another width is not stretched over the map
  assert.deepEqual(draw(map => { map.image = { data: PNG, w: 300, h: 236 }; }).seen.image, []);
});

test('a street map that cannot be embedded costs the background, not the PDF', () => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  doc.addImage = () => { throw new Error('bad image'); };
  const model = day([...HISTORY(8), ...LONG_DAY], DAY);
  model.sections.find(s => s.title === 'Route worked').blocks.find(b => b.t === 'map').image = { data: 'data:image/jpeg;base64,AAAA', w: 528, h: 236 };
  drawAuditPdf(doc, model);
  assert.match(all(doc), /EVERY LOG, IN ORDER/);
  assert.doesNotMatch(all(doc), /OpenStreetMap/);
});
