// Note + downtime on the work-order card, in BOTH Today's orders and End of day.
//
// The card is DOM and node can't run it, so — as in tests/eod-review-live.test.mjs —
// the handlers are pinned by source assertions, each on a single line whose absence
// is a specific bug coming back. The one piece of real arithmetic, settleTravel, is
// pure and is tested by calling it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settleTravel, computeGapsLocal } from '../js/compute/gaps.js';

const rd = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const captureJs  = rd('../js/pages/capture.js');
const daycacheJs = rd('../js/daycache.js');

const alloc = (from, to, wo, category, minutes) => ({ fromTime:from, toTime:to, workOrderId:wo, category, minutes });
const fn = (src, name) => {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > -1, name + '() is gone');
  return src.slice(at, at + 1600);
};

// ── settleTravel: what the phone knows once a saveTravel is acked ───────────

test('an acked saveTravel rebuilds the cached gap rows and leaves manual downtime alone', () => {
  const cached = {
    downtime: [
      { id:'m1', category:'LUNCH', minutes:30, workOrderId:'', note:'' },
      { id:'old', category:'BREAK', minutes:5, workOrderId:'100', note:'gap 09:00–09:30' },
    ],
    eodTravel: [ alloc('09:30','10:10','200','TOOLS_MATERIAL',20) ],
  };
  const acked = [ alloc('09:30','10:10','200','TOOLS_MATERIAL',20) ];
  assert.equal(settleTravel(cached, acked, { date:'2026-11-13', installer:'Q' }), true);
  assert.deepEqual(cached.downtime.map(d => [d.category, d.minutes, d.workOrderId, d.note]), [
    ['LUNCH', 30, '', ''],
    ['TOOLS_MATERIAL', 20, '200', 'gap 09:30–10:10'],
  ], 'saveTravel replaced the day\'s gap rows, so the cache must too');
  assert.equal(cached.downtime[1].timestamp, '2026-11-13 12:00:00');
  assert.equal(cached.eodTravel, undefined, 'the stash is the acked set, so it is settled');
});

test('the rebuilt rows read back through computeGapsLocal as the same entry', () => {
  // The point of rebuilding them: with the stash gone, this is where the card gets
  // its downtime from the next time it opens offline.
  const stops = [
    { id:'a', timestamp:'2026-11-13 09:30:00', workOrderId:'100' },
    { id:'b', timestamp:'2026-11-13 10:10:00', workOrderId:'200' },
  ];
  const cached = { downtime:[], eodTravel:[ alloc('09:30','10:10','200','TOOLS_MATERIAL',20) ] };
  settleTravel(cached, cached.eodTravel.slice(), { date:'2026-11-13' });
  const gaps = computeGapsLocal(stops, cached.downtime, cached.eodTravel, false);
  assert.deepEqual(gaps[0].allocations, [{ category:'TOOLS_MATERIAL', minutes:20 }]);
});

test('an ack for an OLDER save never drops a newer edit still waiting behind it', () => {
  // Two edits queued offline; the first one acks. The stash holds the second.
  const cached = { downtime:[], eodTravel:[ alloc('09:30','10:10','200','TOOLS_MATERIAL',35) ] };
  settleTravel(cached, [ alloc('09:30','10:10','200','TOOLS_MATERIAL',20) ], { date:'2026-11-13' });
  assert.deepEqual(cached.eodTravel, [ alloc('09:30','10:10','200','TOOLS_MATERIAL',35) ]);
  // …and while it is there it wins, so the card still shows 35.
  const stops = [
    { id:'a', timestamp:'2026-11-13 09:30:00', workOrderId:'100' },
    { id:'b', timestamp:'2026-11-13 10:10:00', workOrderId:'200' },
  ];
  assert.equal(computeGapsLocal(stops, cached.downtime, cached.eodTravel, false)[0].allocations[0].minutes, 35);
});

test('deleting the last entry settles to no gap rows at all', () => {
  const cached = {
    downtime: [{ id:'old', category:'BREAK', minutes:5, workOrderId:'100', note:'gap 09:00–09:30' }],
    eodTravel: [],
  };
  settleTravel(cached, [], { date:'2026-11-13' });
  assert.deepEqual(cached.downtime, []);
  assert.equal(cached.eodTravel, undefined);
});

test('zero-minute placeholder rows do not count as a difference', () => {
  // "+ Add downtime" pushes a 0-minute row; saveTravel never stores those.
  const cached = { downtime:[], eodTravel:[ alloc('09:30','10:10','200','BREAK',10), alloc('09:30','10:10','200','LUNCH',0) ] };
  settleTravel(cached, [ alloc('09:30','10:10','200','BREAK',10) ], { date:'2026-11-13' });
  assert.equal(cached.eodTravel, undefined);
  assert.equal(cached.downtime.length, 1);
});

test('reconcileCache settles a queued saveTravel on the day it was written for', () => {
  const at = daycacheJs.indexOf('export async function reconcileCache');
  const body = daycacheJs.slice(at, at + 2600);
  assert.match(body, /item\.action==='saveTravel' && item\.date\) \|\| localDate\(\)/,
    'a save that drains after midnight would settle the wrong day');
  assert.match(body, /gapsMod\.settleTravel\(cached, item\.allocations/);
  assert.ok(!/item\.action==='saveTravel' && body\.ok && cached\.eodTravel\)\{\s*\n[^}]*delete cached\.eodTravel;\s*\n\s*changed = true;\s*\n\s*\} else if\(item\.action==='archiveStop'/.test(body),
    'reconcileCache drops the stash on any saveTravel ack again');
});

// ── Today's orders saves downtime itself ────────────────────────────────────

test("a downtime edit in Today's orders is stashed and queued, never left for Finish", () => {
  const edit = fn(captureJs, 'afterGapEdit');
  assert.match(edit, /if\(gapHost !== 'today'\)\{ schedulePersistEod\(\); return; \}/,
    'End of day keeps its own persist + prefetch path');
  // Snapshot at the edit, not when the timer fires: End of day empties eodGaps for
  // its own load, and a saveTravel of [] REPLACES the day's deductions on the Sheet.
  assert.match(edit, /travelPending = \{ snap: collectGapAllocations\(eodGaps\), date: localDate\(\) \}/);
  const queue = fn(captureJs, 'queueTravelSave');
  assert.match(queue, /enqueue\(\{[^}]*action:'saveTravel'[\s\S]*?date:p\.date, allocations:p\.snap/,
    'the save must ride the offline queue and name its own day');
  assert.match(queue, /if\(k === travelQueuedKey\) return;/, 'an unchanged set is written again');
  assert.match(queue, /travelPending = null;/,
    'a snapshot left behind is re-stashed over a later End-of-day edit');
});

test("Today's stash carries the deductions only — never the bookends", () => {
  // persistEodReview reads #eodDeparture/#eodReturned, which hold whatever they last
  // held while Today's orders is the sheet on screen.
  const stash = fn(captureJs, 'stashTravel').split('\nfunction ')[0];
  assert.match(stash, /cached\.eodTravel = p\.snap;/);
  assert.ok(!/eodDeparture|eodReturned|cached\.day\s*=/.test(stash), "Today's stash writes Departure/Returned");
});

test('both sheets queue a pending Today edit before they reload the gap state', () => {
  for(const id of ['endDay', 'openToday']){
    const handler = captureJs.slice(captureJs.indexOf(`$('${id}').onclick`));
    const flushed = handler.indexOf('await flushTravelSave()');
    const loaded  = handler.indexOf("await loadDay(");
    assert.ok(flushed > -1 && flushed < loaded, id + ' reloads before the pending edit is queued');
  }
});

// ── a late server response must not cost the installer their typing ─────────

test("an open card in Today's orders survives the late day/idle response", () => {
  assert.match(captureJs, /else if\(mode==='today' && todayTouched\)\{/);
  const at = captureJs.indexOf("else if(mode==='today' && todayTouched){");
  const branch = captureJs.slice(at, captureJs.indexOf('else renderDayData(mode, stops, downtime', at));
  assert.match(branch, /if\(!todayDtEdited\)\{\s*\n\s*setGapData\(gaps\);/,
    'gaps with downtime typed against them must not be replaced');
  assert.match(branch, /paintTodayTable\(\);/);
  assert.ok(!/renderToday\(|renderDayData\(/.test(branch), 'the touched branch rebuilds the card');
  // paintTodayTable must not be the thing that closes the card.
  assert.ok(!/todayEdit'\)\.innerHTML\s*=\s*''/.test(fn(captureJs, 'paintTodayTable').split("querySelectorAll('tr[data-i]')")[0]));
  assert.match(captureJs, /todayTouched = true;\s*\n\s*box\.appendChild\(makeStopCard\(/, 'opening a row arms the freeze');
});

test('a response for a sheet that is no longer the one on screen paints nothing', () => {
  // The sheets share one gap state; a stale paint re-points it under the live sheet.
  const load = captureJs.slice(captureJs.indexOf('async function loadDay(mode)'));
  assert.match(load.slice(0, 300), /const seq = \+\+dayLoadSeq;/);
  const guard = load.indexOf('if(seq !== dayLoadSeq) return;');
  const paint = load.indexOf("if(mode==='eod' && eodTouched){");
  assert.ok(guard > -1 && guard < paint);
});

test('an un-synced stash wins over the allocations the spine sends back', () => {
  assert.match(captureJs, /if\(idata && idata\.gaps\) gaps = overlayStash\(idata\.gaps, pendingTravel\);/);
  assert.ok(!/if\(idata && idata\.gaps\) gaps = idata\.gaps;/.test(captureJs),
    'idle replaces the gaps wholesale again — un-synced downtime vanishes on open');
  const overlay = fn(captureJs, 'overlayStash');
  assert.match(overlay, /if\(!Array\.isArray\(stash\)\) return gaps;/, 'no stash ⇒ the spine is the truth');
  assert.match(overlay, /a\.fromTime === g\.start && a\.toTime === g\.end/);
});

// ── the note ────────────────────────────────────────────────────────────────

test('the card note saves itself as a notes-only updateStop', () => {
  const quick = captureJs.slice(captureJs.indexOf('function renderQuick('), captureJs.indexOf('// ── look up'));
  assert.match(quick, /enqueue\(\{ token:c\.token, action:'updateStop', id:s\.id, notes:v \}\);/,
    'a wider payload can write a stale status or J# back over a fix made elsewhere');
  assert.match(quick, /ta\.addEventListener\('change', save\);/, 'blur must save before the next tap lands');
  // s.notes moves only when the write is queued (see eodStateKey below).
  assert.ok(!/addEventListener\('input'[\s\S]{0,200}s\.notes\s*=/.test(quick));
});

test('with the note on the card, the Edit form has no second copy of it', () => {
  assert.match(captureJs, /\$\{quick \? '' : `<label>Notes<\/label><textarea data-f="notes">/);
  assert.match(captureJs, /notes: quickNote \? quickNote\.value\.trim\(\) : g\('notes'\)/);
});

test('a note typed after the summary prefetch forces a rebuild', () => {
  const key = fn(captureJs, 'eodStateKey');
  assert.match(key, /JSON\.stringify\(eodNoteEdits\)/);
  assert.match(captureJs, /if\(!open\)\{ eodNoteEdits\[s\.id\] = v; schedulePersistEod\(\); \}/);
  assert.match(captureJs, /eodNoteEdits = \{\};/, 'each End-of-day open starts clean');
});

test('both sheets draw the card with the note + downtime block', () => {
  assert.match(captureJs, /makeStopCard\(s, null, \{ pos: posById\[s\.id\], travel: true, quick: 'fold' \}\)/);
  assert.match(captureJs, /quick:'open',/);
});

// ── skew: nothing new on the capture path may be a named import ─────────────

test('the new helpers are reached through namespace imports', () => {
  assert.match(captureJs, /import \* as daycacheMod from '\.\.\/daycache\.js';/);
  assert.match(captureJs, /typeof daycacheMod\.settleTravelCache === 'function'/);
  assert.ok(!/import \{[^}]*settleTravel[^}]*\}/.test(captureJs), 'capture.js names a new export');
  assert.match(daycacheJs, /import \* as gapsMod from '\.\/compute\/gaps\.js';/);
  assert.match(daycacheJs, /typeof gapsMod\.settleTravel === 'function'/);
  assert.ok(!/import \{[^}]*settleTravel[^}]*\}/.test(daycacheJs), 'daycache.js names a new export');
});
