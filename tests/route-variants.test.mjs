import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVariant, fmtKm, hasVariant, isPending, liveDayMeters, routeScopeText, routeTotalSummary,
  variantCoversPending, variantDayCount, variantMatchesLive, variantMeters, variantSelectable,
  variantSequence, variantSummary,
} from '../js/route-variants.js';

const PLAN = { routeStartDate:'2026-07-27', firstStopTime:'08:00', paceMin:30, target:2 };

// Two saved routes over the same four orders: the road variant visits them
// A,C,B,D and the straight-line variant A,B,C,D. The live fields start on the
// road variant, as an optimize run would have left them.
function list(){
  return [
    { id:'a', workOrderId:'1', createdAt:'2026-07-20 08:00:00', wlStatus:'pending', order:0,  day:1,
      orderRoad:0,  dayRoad:1, legMetersRoad:0,     orderStraight:0,  dayStraight:1, legMetersStraight:0 },
    { id:'c', workOrderId:'3', createdAt:'2026-07-20 08:02:00', wlStatus:'pending', order:10, day:1,
      orderRoad:10, dayRoad:1, legMetersRoad:1000,  orderStraight:20, dayStraight:2, legMetersStraight:1000 },
    { id:'b', workOrderId:'2', createdAt:'2026-07-20 08:01:00', wlStatus:'pending', order:20, day:2,
      orderRoad:20, dayRoad:2, legMetersRoad:1000,  orderStraight:10, dayStraight:1, legMetersStraight:100000 },
    { id:'d', workOrderId:'4', createdAt:'2026-07-20 08:03:00', wlStatus:'pending', order:30, day:2,
      orderRoad:30, dayRoad:2, legMetersRoad:1000,  orderStraight:30, dayStraight:2, legMetersStraight:1000 },
  ];
}

test('a variant that never ran is not selectable', () => {
  const items = list().map(x => ({ ...x, orderStraight:'', dayStraight:'', legMetersStraight:'' }));
  assert.equal(hasVariant(items, 'straight'), false);
  assert.equal(variantSelectable(items, 'straight'), false);
  assert.equal(hasVariant(items, 'road'), true);
  assert.equal(variantSelectable(items, 'road'), true);
});

test('applying a variant rewrites the live order and days from its sequence', () => {
  const out = applyVariant(list(), 'straight', PLAN);
  assert.deepEqual(out.map(x => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(out.map(x => x.order), [0, 10, 20, 30]);
  assert.deepEqual(out.map(x => x.day), [1, 1, 2, 2]);
  assert.ok(out.every(x => x.scheduledEta));
});

test('switching variants re-honours a locked slot instead of trusting the sequence', () => {
  // 'd' is nailed to day 1 slot 2, so the straight-line sequence a,b,c,d cannot
  // be taken literally — d must land second and b slides on.
  const items = list().map(x =>
    x.id === 'd' ? { ...x, lockedDate:'2026-07-27', lockedSlot:2 } : x);
  const out = applyVariant(items, 'straight', PLAN);
  assert.deepEqual(out.map(x => x.id), ['a', 'd', 'b', 'c']);
  assert.equal(out[1].day, 1);
  assert.equal(out[1].scheduledSlot, 2);
});

test('an unreachable appointment is applied first and flagged, not thrown away', () => {
  // The crew departs at 08:00, so a 07:30 appointment cannot be met from any slot
  // on that day. It used to throw, which left every OTHER order in the variant
  // unapplied over one impossible one. Now it takes the earliest slot it can and
  // carries the lateness on its own row for the card to badge.
  const items = list().map(x =>
    x.id === 'd' ? { ...x, appointmentDate:'2026-07-27', appointmentTime:'07:30' } : x);
  const out = applyVariant(items, 'road', PLAN);
  const d = out.find(x => x.id === 'd');
  assert.equal(d.scheduledSlot, 1);          // as early as the day allows
  assert.equal(d.scheduledEta, '08:00');
  assert.equal(d.scheduledLateMin, 30);      // 08:00 − 07:30, reported not thrown
  assert.ok(out.every(x => x.scheduledEta)); // and the rest of the route applied
});

test('distance sums the whole route and a single day, from the variant own days', () => {
  const items = list();
  assert.equal(variantMeters(items, 'road'), 3000);
  assert.equal(variantMeters(items, 'straight'), 102000);
  assert.equal(variantMeters(items, 'road', { day:1 }), 1000);
  assert.equal(variantMeters(items, 'road', { day:2 }), 2000);
  // The straight variant clusters days differently — its day 1 is a + b.
  assert.equal(variantMeters(items, 'straight', { day:1 }), 100000);
  assert.equal(liveDayMeters(items, 'road', 2), 2000);
});

test('done and ignored orders are outside the route and its distance', () => {
  const items = list();
  items[1] = { ...items[1], wlStatus:'done' };
  items[2] = { ...items[2], ignored:true };
  assert.equal(isPending(items[1]), false);
  assert.equal(isPending(items[2]), false);
  assert.deepEqual(variantSequence(items, 'road'), ['a', 'd']);
  assert.equal(variantMeters(items, 'road'), 1000);
});

test('an unmeasured variant reads as a dash, never as 0 km', () => {
  const items = list().map(x => ({ ...x, legMetersRoad:'' }));
  assert.equal(variantMeters(items, 'road'), null);
  assert.equal(fmtKm(null), '—');
  assert.equal(fmtKm(4200), '4.2 km');
  assert.equal(fmtKm(234000), '234 km');
});

test('a new order makes a saved variant stale without erasing it', () => {
  const items = list();
  items.push({ id:'e', createdAt:'2026-07-21 08:00:00', wlStatus:'pending', order:40 });
  assert.equal(hasVariant(items, 'road'), true);          // the sequence survives
  assert.equal(variantCoversPending(items, 'road'), false);
  assert.equal(variantSelectable(items, 'road'), false);
  assert.equal(variantSummary(items, 'road').stale, true);
  // Ignoring the newcomer puts the pending set back where the variant left it.
  items[4].ignored = true;
  assert.equal(variantSelectable(items, 'road'), true);
});

test('a manual drag marks the active distance edited', () => {
  const items = list();
  assert.equal(variantMatchesLive(items, 'road'), true);
  assert.match(variantSummary(items, 'road', { active:true }).text, /^3 km \(road\)$/);
  items[3] = { ...items[3], order: -10 };                 // dragged 'd' to the top
  assert.equal(variantMatchesLive(items, 'road'), false);
  assert.match(variantSummary(items, 'road', { active:true }).text, /· edited$/);
});

test('the headline total is qualified whenever it stops describing the list', () => {
  const items = list();
  assert.equal(routeTotalSummary(items, 'road', 'road'), '3 km (road)');
  // Dragged: the legs were measured for a sequence that no longer exists.
  const dragged = items.map(x => x.id === 'd' ? { ...x, order:-10 } : x);
  assert.equal(routeTotalSummary(dragged, 'road', 'road'), '3 km (road) · edited');
  // A new order isn't in the sum at all, so the figure understates the day —
  // silently reporting it is how a crew plans around a number that is wrong.
  const added = items.concat({ id:'e', createdAt:'2026-07-21 08:00:00', wlStatus:'pending', order:40 });
  assert.equal(routeTotalSummary(added, 'road', 'road'), '3 km (road) · out of date');
  // Switching to the straight route makes it the live one, so its total stands
  // unqualified — and is labelled an estimate when it was never road-priced.
  const onStraight = applyVariant(items, 'straight', PLAN);
  assert.equal(routeTotalSummary(onStraight, 'straight', 'straight-line'),
    '102 km (straight-line est.)');
  assert.equal(routeTotalSummary(onStraight, 'straight', 'road'), '102 km (road)');
});

// ── the phone's headline is one day, the planner's is the whole plan ─────────
// Field report: two orders 2 km apart, and the road button read 241 km. The
// arithmetic was right and answering the wrong question — one far-off order
// sitting at the bottom of a four-day plan, summed into the figure the crew
// reads as today's driving. These pin the scope, not the sum.

// Eight pending orders, four days of two, with the distant one last: day 1 is
// 2.2 km and the whole plan is 241 km, exactly as reported.
function reported(){
  const legs = [[1, 0], [1, 2200], [2, 0], [2, 6300], [3, 0], [3, 3000], [4, 0], [4, 229500]];
  return legs.map(([day, m], i) => ({
    id:`w${i}`, createdAt:`2026-07-20 08:0${i}:00`, wlStatus:'pending', order:i * 10, day,
    orderRoad:i * 10, dayRoad:day, legMetersRoad:m,
    orderStraight:i * 10, dayStraight:day, legMetersStraight:m,
  }));
}

test('the phone headline is day 1 and a far-off order on day 4 cannot move it', () => {
  const items = reported();
  assert.equal(routeTotalSummary(items, 'road', 'road', { day:1 }), 'day 1: 2.2 km (road)');
  assert.equal(variantSummary(items, 'road', { active:true, straightDistanceSource:'road', day:1 }).text,
    '2.2 km (road)');
  // The order that caused the report: move it further still, and the headline
  // does not budge. Unscoped it was the entire complaint.
  const worse = items.map(x => x.id === 'w7' ? { ...x, legMetersRoad:500000 } : x);
  assert.equal(routeTotalSummary(worse, 'road', 'road', { day:1 }), 'day 1: 2.2 km (road)');
  assert.equal(routeTotalSummary(worse, 'road', 'road'), '512 km (road)');
});

test('the day-scoped headline IS the day divider number, by construction', () => {
  // Both buckets read the LIVE `day`, so the two can never disagree — the gap
  // between them (241 km over headers reading 2.2 km) was the whole bug.
  const items = reported();
  for(const d of [1, 2, 3, 4])
    assert.match(routeTotalSummary(items, 'road', 'road', { day:d }),
      new RegExp(`^day ${d}: ${fmtKm(liveDayMeters(items, 'road', d))} `));
  // A day with nothing left prints nothing rather than "0 km", the same answer
  // the pace card gives when today's work is done.
  const doneDay1 = items.map(x => Number(x.day) === 1 ? { ...x, wlStatus:'done' } : x);
  assert.equal(routeTotalSummary(doneDay1, 'road', 'road', { day:1 }), '');
});

test('the office keeps the whole plan, and the figure names its own span', () => {
  const items = reported();
  assert.equal(variantDayCount(items, 'road'), 4);
  assert.equal(routeTotalSummary(items, 'road', 'road', { days:true }), '241 km (road) · 4 days');
  assert.equal(variantSummary(items, 'road', { active:true, straightDistanceSource:'road', days:true }).text,
    '241 km (road) · 4 days');
  // A one-day plan has no span worth naming.
  const oneDay = list();
  assert.equal(routeTotalSummary(oneDay.map(x => ({ ...x, dayRoad:1 })), 'road', 'road', { days:true }),
    '3 km (road)');
});

test('the phone caption carries the whole-plan figure the tiles no longer show', () => {
  const items = reported();
  assert.equal(routeScopeText(items, 'road', 1),
    'Day 1 only — the whole plan is 241 km over 4 days');
  // Nothing to disambiguate: a single-day plan, or an unscoped surface.
  assert.equal(routeScopeText(list().map(x => ({ ...x, dayRoad:1 })), 'road', 1), '');
  assert.equal(routeScopeText(items, 'road', null), '');
});

test('a day-scoped headline still says when it stopped describing the list', () => {
  const items = reported();
  const dragged = items.map(x => x.id === 'w7' ? { ...x, order:-10 } : x);
  assert.equal(routeTotalSummary(dragged, 'road', 'road', { day:1 }), 'day 1: 2.2 km (road) · edited');
  const added = items.concat({ id:'e', createdAt:'2026-07-21 08:00:00', wlStatus:'pending', order:80 });
  assert.equal(routeTotalSummary(added, 'road', 'road', { day:1 }), 'day 1: 2.2 km (road) · out of date');
});

test('straight-line metres are labelled comparable only when priced on the road', () => {
  const items = list();
  assert.match(variantSummary(items, 'straight', { straightDistanceSource:'road' }).text,
    /\(road\)$/);
  assert.match(variantSummary(items, 'straight', { straightDistanceSource:'straight-line' }).text,
    /\(straight-line est\.\)$/);
});
