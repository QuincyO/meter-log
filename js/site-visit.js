// The house timer — how long the truck is parked at an order. Pure and DOM-free
// (tests/site-visit.test.mjs); js/drive.js owns the two buttons, the storage and
// the upload. The Drive screen's left button (Parked) starts a visit, the right one
// (Leaving) ends it, and each pair becomes ONE row on the `SiteVisits` tab via
// `saveSiteVisit`.
//
// This is COLLECTION ONLY (owner, 2026-11-27): nothing reads these rows yet, and
// what the numbers mean is to be tuned once there is data. So the rule everywhere
// below is: keep the raw figure, add the interpretation beside it, never instead.
//
// This file is loaded by drive.js with a dynamic import() and is deliberately NOT in
// sw.js SHELL — the same rule and reason as js/activity-log.js and js/town-picker.js
// (AGENTS.md §"The status pill's activity log"). A phone that cannot load it shows
// no timer and loses nothing else.

// A visit ended this soon after it started is a mis-tap, not a house.
export const MIN_VISIT_SEC = 30;

const round1 = n => Math.round(n * 10) / 10;
const clock = stampStr => {
  const m = String(stampStr || '').match(/[ T](\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
};

// What a visit remembers about an order: enough to name it on the row and to price
// the drive to another one. `key` is the WO# when there is one, else the address —
// the same identity drive.js `destKey` uses.
export function orderOf(item, address){
  if(!item) return null;
  const wo = String(item.workOrderId || '').trim();
  const addr = String(address || '').trim();
  const num = v => (v == null || v === '' || !isFinite(Number(v))) ? null : Number(v);
  return { key: wo || addr, workOrderId: wo, address: addr, lat: num(item.lat), lng: num(item.lng) };
}
export const sameOrder = (a, b) => !!a && !!b && a.key === b.key;

// Which order a Parked press means. Navigate moves the big card on to the NEXT
// house before it hands off to Maps, so the house the truck is parked at is the
// "Driving to" card — unless that is the house the last timer was on. Then the
// press is for somewhere new (two doors down, where nobody presses Navigate), and
// that is the big card. `last` is the order of the running timer, else of the one
// most recently saved.
//
// The order on a row is a HINT. The stops logged between startTime and endTime are
// the stronger record of what the visit was, and they are already on `Stops`.
export function pickOrder(dest, card, last){
  if(dest && !sameOrder(dest, last)) return dest;
  if(card && !sameOrder(card, last)) return card;
  return dest || card || null;
}

// A second Parked press while the timer is still younger than a mis-tap is a double
// tap, not a new house. Without this the press reads as "the next house" (pickOrder
// moves off the order being timed), the first timer is thrown away as too short,
// and the wrong order is timed.
export const isFresh = (open, nowMs) => !!open && (nowMs - open.startMs) < MIN_VISIT_SEC * 1000;

// now = { ms, stamp, date }: epoch ms for the arithmetic, the Toronto stamp and
// date for the row (js/time.js stamp()/localDate()).
export function startVisit({ id, order, now }){
  return { id, date: now.date, startTime: now.stamp, startMs: now.ms,
    order: order || null, navTime: '', navOrder: null };
}

// Navigate pressed while a timer is running. On a DIFFERENT order it is the best
// record there is of when the truck really left a house whose timer was forgotten:
// the first such press is kept as `navTime`, and the latest such order is where the
// truck is now. Navigating back to the order being timed clears the moved-on order.
export function noteNavigate(open, order, stampStr){
  if(!open) return open;
  if(!order || sameOrder(order, open.order)) return { ...open, navOrder: null };
  return { ...open, navTime: open.navTime || stampStr, navOrder: order };
}

function baseRow(open, endOrder){
  const s = open.order || {}, e = endOrder || open.order || {};
  return {
    id: open.id, date: open.date,
    startTime: open.startTime, endTime: '', minutes: '',
    startWO: s.workOrderId || '', startAddress: s.address || '',
    endWO: e.workOrderId || '', endAddress: e.address || '',
    endedBy: '', driveMin: '', driveSource: '', onSiteMin: '', navTime: open.navTime || '',
  };
}

// The order a visit ended on. A Parked press names it (`endOrder`); a Leaving press
// takes the order Navigate was last pressed on, and with no such press the truck
// never left, so it is the order the visit started on. The big card is NOT evidence
// on a Leaving press: once the order is logged and the list refreshes, the card
// moves on by itself while the truck is still in the driveway.
export function endOrderOf(open, endOrder){
  return endOrder || open.navOrder || open.order || null;
}

// End a visit. `leg` is the estimated drive between the two orders ({ min, source }
// from the app's own travel ladder, or null) and is used ONLY when the order
// changed: a timer that ran on past the house holds a drive, and the owner asked for
// that to be taken off. `minutes` stays the raw gap so the subtraction can be redone.
// One leg only — a timer forgotten through several houses still loses just the
// drive from where it started to where it ended.
export function endVisit(open, { endOrder = null, endedBy, now, leg = null }){
  const secs = (now.ms - open.startMs) / 1000;
  if(secs < MIN_VISIT_SEC) return { row: null, discarded: true };
  const end = endOrderOf(open, endOrder);
  const row = baseRow(open, end);
  const minutes = round1(secs / 60);
  const moved = !!open.order && !!end && !sameOrder(open.order, end);
  const drive = (moved && leg && isFinite(Number(leg.min)) && Number(leg.min) >= 0)
    ? round1(Number(leg.min)) : null;
  row.endTime = now.stamp;
  row.minutes = minutes;
  row.endedBy = endedBy;
  row.driveMin = drive == null ? '' : drive;
  row.driveSource = drive == null ? '' : String(leg.source || '');
  row.onSiteMin = round1(Math.max(0, minutes - (drive || 0)));
  return { row, discarded: false };
}

// A timer still running from a previous day was never ended. It is saved as it
// stands — no end time, no minutes — so the forgotten house is on record without a
// sixteen-hour visit beside it. Today's timer is left alone (null).
export function closeStale(open, today){
  if(!open || open.date === today) return null;
  const row = baseRow(open, open.navOrder);
  row.endedBy = 'notEnded';
  return row;
}

// ── what the driver reads ──
const nameOf = (wo, addr) => wo || addr || '(no order)';
export const elapsedMin = (open, nowMs) => Math.max(0, Math.floor((nowMs - open.startMs) / 60000));

export function runningText(open, nowMs){
  const o = open.order || {};
  const who = open.navOrder
    ? `started ${nameOf(o.workOrderId, o.address)} → now ${nameOf(open.navOrder.workOrderId, open.navOrder.address)}`
    : [o.workOrderId, o.address].filter(Boolean).join(' · ') || '(no order)';
  return `Timing ${who} · since ${clock(open.startTime)} · ${elapsedMin(open, nowMs)} min`;
}

export function savedText(row){
  const from = nameOf(row.startWO, row.startAddress), to = nameOf(row.endWO, row.endAddress);
  if(row.endedBy === 'notEnded') return `Saved ${from} from ${row.date} with no end time`;
  if(from === to) return `Saved ${Math.round(row.minutes)} min · ${from}`;
  const sum = row.driveMin === '' ? `${row.minutes} min`
    : `${row.minutes} min − ${row.driveMin} min drive = ${row.onSiteMin} min`;
  return `Saved: started ${from} → ended ${to} · ${sum}`;
}
