// The status pill's activity log (js/activity-log.js): tap the pill, see exactly
// which writes are waiting to go to the Sheet, what's running, and what recently
// happened. The pure half is tested directly; the wiring is pinned by content
// assertions, because what has to be prevented is a future edit that puts the log
// on the capture page's critical path — the same reason shell-skew-survivable and
// stop-never-discarded are content tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  describeWrite, payloadFields, applyQueueEvent, collapses, pruneIds, splitRows,
  renderActivityHTML, postPart, jobRow, LOG_DB, MAX_AGE_MS, MAX_ROWS,
} from '../js/activity-log.js';
import { MAX_FLUSH_TRIES } from '../js/queue-policy.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 8, 23, 15, 0, 0);

// ── describeWrite: one line per write, for every action the phone sends ─────
test('a logged stop names its work order, J# and status', () => {
  assert.equal(describeWrite({ action:'addStop', workOrderId:'40123', newJNumber:'J778', status:'INSTALLED' }),
    'Stop · WO# 40123 · J# J778 · INSTALLED');
  // A UTI has no New J#; its old J# is the identifying number.
  assert.equal(describeWrite({ action:'addStop', workOrderId:'40124', newJNumber:null, oldJNumber:'J12', status:'UTI' }),
    'Stop · WO# 40124 · old J# J12 · UTI');
  assert.equal(describeWrite({ action:'addStop', status:'DONE', lat:45, lng:-79 }), 'Already-installed marker');
});

test('downtime uses the same category labels as the rest of the app', () => {
  assert.equal(describeWrite({ action:'addDowntime', category:'TRUCK_ISSUES', minutes:25, workOrderId:'40123' }),
    'Downtime · Truck Issues 25 min · WO# 40123');
  assert.equal(describeWrite({ action:'addDowntime', category:'NOPE', minutes:5 }), 'Downtime · NOPE 5 min');
});

test('the two shapes of updateStop and archiveStop read differently', () => {
  // geocode.js backfill: an address-only correction.
  assert.equal(describeWrite({ token:'t', action:'updateStop', id:'1-a', address:'12 Main St' }),
    'Address filled in · 12 Main St');
  // A card edit carries the whole stop.
  assert.equal(describeWrite({ action:'updateStop', id:'1-a', workOrderId:'40123', address:'x', status:'UTI' }),
    'Stop edit · WO# 40123 · UTI');
  assert.equal(describeWrite({ action:'archiveStop', id:'1-a', reason:'reset order' }), 'Start order over (stop archived)');
  assert.equal(describeWrite({ action:'archiveStop', id:'1-a', reason:'' }), 'Remove stop');
  assert.equal(describeWrite({ action:'archiveStop', id:'1-a', reason:'wrong house' }), 'Remove stop · “wrong house”');
});

test('every other write the phone sends has a readable name', () => {
  assert.equal(describeWrite({ action:'saveTravel', allocations:[{}, {}] }), 'Travel review · 2 deductions');
  assert.equal(describeWrite({ action:'saveDay', departure:'07:30', returned:'16:10' }), 'Day start / end times · 07:30–16:10');
  assert.equal(describeWrite({ action:'endOfDay' }), 'End-of-day close');
  assert.equal(describeWrite({ action:'saveEmployee', hNumber:'H123' }), 'Settings — your details · H123');
  assert.equal(describeWrite({ action:'saveDriveTrack', date:'2026-09-23', distanceM:12345, pointCount:88 }),
    'Drive leg · 2026-09-23 · 12.3 km · 88 pts');
  assert.equal(describeWrite({ action:'saveWorklist', orders:[{}, {}, {}] }), 'Worklist upload · 3 orders');
  assert.equal(describeWrite({ action:'savePlan', plan:{} }), 'Route settings');
  assert.equal(describeWrite({ action:'previewDailyLog' }), 'Daily log preview (nothing saved)');
  assert.equal(describeWrite({ action:'somethingNew' }), 'somethingNew');
  assert.equal(describeWrite(null), 'Upload');
});

// ── payloadFields: every field that was sent, never the token ───────────────
test('the expanded view never shows the token or the queue internals', () => {
  const f = payloadFields({ token:'SECRET', action:'addStop', workOrderId:'40123',
    _seq:4, _tries:2, _parked:true, _error:'x' });
  const keys = f.map(([k]) => k);
  assert.deepEqual(keys, ['action', 'workOrderId']);
  assert.ok(!JSON.stringify(f).includes('SECRET'));
});

test('a huge drive polyline is truncated without being stringified', () => {
  const encoded = 'a'.repeat(50000);
  const [[k, v]] = payloadFields({ encoded });
  assert.equal(k, 'encoded');
  assert.ok(v.length < 120, `value is ${v.length} chars`);
  assert.match(v, /\(50000 chars\)$/);
});

test('arrays and nested objects are summarized, blanks and nulls are visible', () => {
  const f = Object.fromEntries(payloadFields({
    orders:[{}, {}], plan:{ commutePull:1, target:24 }, note:'', meterRead:null, ok:false, minutes:0,
  }));
  assert.equal(f.orders, '2 items');
  assert.equal(f.plan, '{commutePull, target}');
  assert.equal(f.note, '(blank)');
  assert.equal(f.meterRead, '—');
  assert.equal(f.ok, 'false');
  assert.equal(f.minutes, '0');
});

// ── applyQueueEvent: ONE row per queued write, updated in place ─────────────
const stop = { token:'t', action:'addStop', workOrderId:'40123', newJNumber:'J1', status:'INSTALLED' };

test('a queued write becomes one row that turns into Sent', () => {
  let r = applyQueueEvent(null, { type:'queued', seq:7, payload:stop }, NOW);
  assert.equal(r.id, 'q:7');
  assert.equal(r.status, 'queued');
  assert.equal(r.queuedAt, NOW);
  assert.equal(r.summary, 'Stop · WO# 40123 · J# J1 · INSTALLED');
  r = applyQueueEvent(r, { type:'sent', seq:7, payload:stop, res:{ ok:true } }, NOW + 5000);
  assert.equal(r.id, 'q:7');
  assert.equal(r.status, 'sent');
  assert.equal(r.queuedAt, NOW, 'the queued time survives the update');
  assert.equal(r.sentAt, NOW + 5000);
  assert.equal(r.attempts, 1);
});

test('an offline stretch updates the same row instead of adding rows', () => {
  let r = applyQueueEvent(null, { type:'queued', seq:1, payload:stop }, NOW);
  for (let i = 1; i <= 5; i++)
    r = applyQueueEvent(r, { type:'waiting', seq:1, payload:stop, reason:'network', online:false }, NOW + i * 1000);
  assert.equal(r.id, 'q:1');
  assert.equal(r.status, 'waiting');
  assert.equal(r.attempts, 5);
  assert.match(r.note, /no signal/i);
  r = applyQueueEvent(r, { type:'waiting', seq:1, payload:stop, reason:'network', online:true }, NOW + 9000);
  assert.match(r.note, /server/i, 'online but unreachable is not "no signal"');
});

test('rejections count strikes, then the row goes stuck, retried, discarded', () => {
  let r = applyQueueEvent(null, { type:'queued', seq:2, payload:stop }, NOW);
  r = applyQueueEvent(r, { type:'rejected', seq:2, payload:stop, tries:1, error:'bad token' }, NOW + 1);
  assert.equal(r.status, 'rejected');
  assert.equal(r.tries, 1);
  assert.equal(r.error, 'bad token');
  r = applyQueueEvent(r, { type:'stuck', seq:2, payload:stop, tries:MAX_FLUSH_TRIES, error:'bad token' }, NOW + 2);
  assert.equal(r.status, 'stuck');
  r = applyQueueEvent(r, { type:'retried', seq:2, payload:stop }, NOW + 3);
  assert.equal(r.status, 'retried');
  assert.equal(r.tries, 0);
  assert.equal(r.error, null);
  r = applyQueueEvent(r, { type:'discarded', seq:2, payload:stop }, NOW + 4);
  assert.equal(r.status, 'discarded');
});

test("the server's reply is explained on the Sent row", () => {
  const sent = res => applyQueueEvent(null, { type:'sent', seq:3, payload:stop, res }, NOW).note;
  assert.match(sent({ ok:true, duplicate:true }), /already on the sheet/i);
  assert.match(sent({ ok:true, jConflicts:[{}] }), /duplicate J#/i);
  assert.match(sent({ ok:true, flagged:true }), /J# conflict/i);
  const upd = { action:'updateStop', id:'x', address:'a' };
  assert.match(applyQueueEvent(null, { type:'sent', seq:4, payload:upd, res:{ ok:true, archived:true } }, NOW).note, /removed/i);
  const arc = { action:'archiveStop', id:'x' };
  assert.match(applyQueueEvent(null, { type:'sent', seq:5, payload:arc, res:{ ok:true, archived:true, alreadyArchived:true } }, NOW).note, /already removed/i);
  assert.match(applyQueueEvent(null, { type:'sent', seq:6, payload:arc, res:{ ok:true, missing:true } }, NOW).note, /not found/i);
  assert.equal(sent({ ok:true }), '');
});

test('an event for a write the log never saw queued still makes a row', () => {
  // Queued before this shipped, or before the lazily-loaded log was ready.
  const r = applyQueueEvent(null, { type:'sent', seq:9, payload:stop, res:{ ok:true } }, NOW);
  assert.equal(r.status, 'sent');
  assert.equal(r.queuedAt, null);
  assert.equal(r.summary, 'Stop · WO# 40123 · J# J1 · INSTALLED');
});

// ── jobs and direct POSTs ───────────────────────────────────────────────────
test('a POST made inside a job is folded into that job\'s row', () => {
  const part = postPart({ body:{ action:'saveWorklist', orders:[{}, {}] }, res:{ ok:true }, ms:900 });
  assert.equal(part.ok, true);
  const row = jobRow({ id:'j:1', label:'Syncing worklist…', start:NOW, parts:[part] }, { ok:true, ms:1200 }, NOW + 1200);
  assert.equal(row.kind, 'job');
  assert.equal(row.summary, 'Syncing worklist — Worklist upload · 2 orders');
  assert.equal(row.ok, true);
  assert.equal(row.ms, 1200);
  assert.equal(row.parts.length, 1);
});

test('a failed POST or a thrown job reads as failed', () => {
  const bad = postPart({ body:{ action:'endOfDay' }, res:{ ok:false, error:'busy, retry' }, ms:10 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'busy, retry');
  const thrown = postPart({ body:{ action:'endOfDay' }, error:new TypeError('Failed to fetch'), ms:10 });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /reach the server/i);
  assert.equal(jobRow({ id:'j', label:'Generating PDF…', start:NOW, parts:[] }, { ok:false, ms:5 }, NOW).ok, false);
  // beginActivity/endActivity callers (geocode.js) report no verdict — that is not a failure.
  assert.equal(jobRow({ id:'j', label:'Fetching address…', start:NOW, parts:[] }, { ms:5 }, NOW).ok, true);
});

test('repeats of the same job within two minutes collapse into one row', () => {
  const a = { kind:'job', summary:'Loading recent days', ok:true, ts:NOW };
  assert.equal(collapses(a, { ...a, ts:NOW + 60000 }), true);
  assert.equal(collapses(a, { ...a, ts:NOW + 3 * 60000 }), false);
  assert.equal(collapses(a, { ...a, ok:false, ts:NOW + 1000 }), false, 'a failure never hides inside a success');
  assert.equal(collapses(a, { ...a, summary:'Generating PDF', ts:NOW + 1000 }), false);
  assert.equal(collapses({ ...a, kind:'queue' }, { ...a, kind:'queue', ts:NOW + 1 }), false, 'queue rows are never merged');
  assert.equal(collapses(null, a), false);
});

// ── retention ───────────────────────────────────────────────────────────────
test('the log keeps two days and at most MAX_ROWS rows', () => {
  assert.equal(MAX_AGE_MS, 48 * 3600 * 1000);
  const old = { id:'old', ts:NOW - MAX_AGE_MS - 1 };
  const fresh = { id:'fresh', ts:NOW - 1000 };
  assert.deepEqual(pruneIds([old, fresh], NOW), ['old']);
  const many = Array.from({ length:MAX_ROWS + 5 }, (_, i) => ({ id:'r' + i, ts:NOW - i }));
  const gone = pruneIds(many, NOW);
  assert.equal(gone.length, 5);
  assert.deepEqual(gone.sort(), ['r500', 'r501', 'r502', 'r503', 'r504'].sort());
});

test('a write still waiting in the queue keeps its row however old it is', () => {
  const ancient = { id:'q:3', ts:NOW - MAX_AGE_MS * 3 };
  assert.deepEqual(pruneIds([ancient], NOW, new Set(['q:3'])), []);
});

// ── splitting rows against the live queue ───────────────────────────────────
test('the live queue decides what is waiting; the rest is recent history', () => {
  const rows = [
    applyQueueEvent(null, { type:'queued', seq:1, payload:stop }, NOW),
    applyQueueEvent(null, { type:'sent', seq:0, payload:stop, res:{ ok:true } }, NOW - 10),
    // The log saw it queued, but it has since left the queue without a recorded result.
    applyQueueEvent(null, { type:'queued', seq:5, payload:stop }, NOW - 20),
    { id:'j:1', kind:'job', summary:'Generating PDF', ok:true, ts:NOW - 5 },
  ];
  const items = [
    { ...stop, _seq:1 },
    { ...stop, _seq:2 },                               // queued before the log existed
    { ...stop, _seq:3, _parked:true, _tries:6 },
  ];
  const { pending, parked, recent } = splitRows(rows, items);
  assert.deepEqual(pending.map(r => r.id), ['q:1', 'q:2']);
  assert.equal(pending[1].queuedAt, null);
  assert.equal(parked, 1);
  assert.deepEqual(recent.map(r => r.id), ['j:1', 'q:0', 'q:5'], 'newest first, waiting rows excluded');
  assert.equal(recent.find(r => r.id === 'q:5').status, 'left');
});

// ── rendering ───────────────────────────────────────────────────────────────
test('the sheet lists exactly what is waiting to send', () => {
  const pending = [1, 2, 3].map(seq =>
    applyQueueEvent(null, { type:'queued', seq, payload:{ ...stop, workOrderId:'4000' + seq } }, NOW));
  const html = renderActivityHTML({ running:['Downloading worklist…'], pending, parked:0, recent:[], now:NOW });
  assert.match(html, /Waiting to send \(3\)/);
  for (const seq of [1, 2, 3]) assert.ok(html.includes('WO# 4000' + seq));
  assert.match(html, /Running now/);
  assert.match(html, /Downloading worklist/);
  assert.match(html, /<details[^>]*data-id="q:1"/);
  assert.doesNotMatch(html, /data-act="stuck"/, 'no Stuck banner when nothing is parked');
});

test('the Stuck banner appears only when something is parked', () => {
  const html = renderActivityHTML({ running:[], pending:[], parked:2, recent:[], now:NOW });
  assert.match(html, /data-act="stuck"/);
  assert.match(html, /2 uploads stuck/);
});

test('every value on the sheet is escaped', () => {
  const evil = { action:'addStop', workOrderId:'<img src=x onerror=alert(1)>', status:'INSTALLED', notes:'<b>hi</b>' };
  const r = applyQueueEvent(null, { type:'queued', seq:1, payload:evil }, NOW);
  const html = renderActivityHTML({ running:['<script>'], pending:[r], parked:0, recent:[], now:NOW });
  assert.ok(!html.includes('<img'), 'summary not escaped');
  assert.ok(!html.includes('<b>hi'), 'field value not escaped');
  assert.ok(!html.includes('<script>'), 'running label not escaped');
});

test('an empty log says so instead of rendering nothing', () => {
  const html = renderActivityHTML({ running:[], pending:[], parked:0, recent:[], now:NOW });
  assert.match(html, /Waiting to send \(0\)/);
  assert.match(html, /Nothing waiting/);
  assert.match(html, /Nothing recorded yet/);
});

// ── the wiring must keep the log OFF the critical path ──────────────────────
const CAPTURE = read('js/pages/capture.js');
const QUEUE = read('js/queue.js');
const LOG = read('js/activity-log.js');

test('capture.js loads the log lazily, so a missing file costs only the log', () => {
  // A static import that fails to resolve kills the whole capture module —
  // Log stop, End of day and ⟳ Force update with it (AGENTS.md, cross-file contract).
  assert.match(CAPTURE, /import\('\.\.\/activity-log\.js'\)/);
  assert.match(CAPTURE, /import\('\.\.\/activity-log\.js'\)[\s\S]{0,200}\.catch\(/);
  assert.doesNotMatch(CAPTURE, /from '\.\.\/activity-log\.js'/);
});

test('the queue never imports the log, and a logging failure cannot touch it', () => {
  assert.doesNotMatch(QUEUE, /from '\.\/activity-log\.js'|import\(\s*'\.\/activity-log\.js'/);
  // Every event goes through one fenced helper.
  assert.match(QUEUE, /function log\(ev\)\{ try \{ if\(_hooks\.onLog\) _hooks\.onLog\(ev\); \} catch \{\} \}/);
});

test('hooks added in this change are reached through namespace checks', () => {
  // A phone can run this file against an older dom.js/api.js; a missing NAMED
  // import would fail the whole module, a namespace member is just undefined.
  assert.match(LOG, /import \* as dom from '\.\/dom\.js'/);
  assert.match(LOG, /import \* as api from '\.\/api\.js'/);
  assert.match(LOG, /typeof dom\.onActivityEvent === 'function'/);
  assert.match(LOG, /typeof api\.setApiHook === 'function'/);
});

test('the log has its own database, so the system-of-record DB needs no upgrade', () => {
  assert.equal(LOG_DB, 'meterlog-activity');
  assert.doesNotMatch(read('js/idb.js'), /activity/i);
  assert.match(read('js/idb.js'), /export const DB_VERSION = 5;/);
});

test('sw.js is untouched: the log is deliberately not in SHELL', () => {
  // Any byte change to sw.js re-downloads the whole shell on every phone — the
  // same fleet-wide effect as the CACHE bump the owner reverted on 2026-08-13.
  assert.doesNotMatch(read('sw.js'), /activity-log/);
});
