// ── Route variants (road matrix vs straight-line) ───────────────────────────
// One optimize run over a road matrix produces TWO candidate sequences for the
// same stops: the road-matrix order and the straight-line order, both priced in
// real driving metres (js/route.js legMetersFor). They are saved side by side on
// each order — `orderRoad`/`dayRoad`/`legMetersRoad` and the `*Straight` trio —
// while `order`/`day`/`scheduled*` stay what they always were: THE LIVE
// SEQUENCE every existing consumer reads (drag-reorder, plan mode, day
// dividers, the route map, upload). Switching variants just copies one saved
// sequence into those live fields, so nothing downstream of `order` changes.
//
// Pure functions only — no DOM, no IndexedDB, no network. The phone and the
// desktop planner both drive their UI from these, which is what keeps the two
// screens from drifting, and it means switching variants works fully offline.
import { scheduleRouteConstraints } from './route-constraints.js';

export const VARIANTS = ['road', 'straight'];

export const VARIANT_FIELDS = {
  road:     { order:'orderRoad',     day:'dayRoad',     legMeters:'legMetersRoad' },
  straight: { order:'orderStraight', day:'dayStraight', legMeters:'legMetersStraight' },
};

export const VARIANT_LABELS = { road:'Road matrix', straight:'Straight-line' };

// An order is "ignored" when the crew set it aside: it stays on the list (and on
// the sheet — the nightly done-sweep only removes wlStatus 'done') but drops out
// of routing, day counts, the meters/day target, and plan mode.
export function isIgnored(item){
  const v = item && item.ignored;
  return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
}
export function isPending(item){
  return !!item && item.wlStatus !== 'done' && !isIgnored(item);
}
export function pendingOf(items){ return (items || []).filter(isPending); }

// Blank/legacy positions sort last, ties break on createdAt — the same contract
// as the phone's sortItems() and the spine's wlCmp(), so a variant sequence and
// the live sequence can be compared position for position.
function ord(v){ return (v === '' || v == null || isNaN(Number(v))) ? Infinity : Number(v); }
function cmp(field){
  return (a, b) => {
    const d = ord(a[field]) - ord(b[field]);
    return d ? d : String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  };
}

function num(v){
  return (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
}

/** Does this variant have any saved sequence at all? */
export function hasVariant(items, variant){
  const f = VARIANT_FIELDS[variant];
  if(!f) return false;
  return pendingOf(items).some(x => num(x[f.order]) != null);
}

/** Does the saved sequence still cover exactly today's pending orders?
 *  False once orders were added, removed, ignored, or completed since the
 *  variant was computed — the switch greys out rather than applying a route
 *  that no longer matches the work. The saved sequence is never erased for
 *  this: a stale route stays visible and comes back the moment the set lines
 *  up again (or the next optimize refreshes it). */
export function variantCoversPending(items, variant){
  const f = VARIANT_FIELDS[variant];
  if(!f) return false;
  const pending = pendingOf(items);
  return pending.length > 0 && pending.every(x => num(x[f.order]) != null);
}

/** Enabled = there is a sequence AND it still matches the work on hand. */
export function variantSelectable(items, variant){
  return hasVariant(items, variant) && variantCoversPending(items, variant);
}

/** The pending ids in this variant's saved order. */
export function variantSequence(items, variant){
  const f = VARIANT_FIELDS[variant];
  if(!f) return [];
  return pendingOf(items).slice().sort(cmp(f.order)).map(x => x.id);
}

/** The live pending ids, in the order the list actually shows them. */
export function liveSequence(items){
  return pendingOf(items).slice().sort(cmp('order')).map(x => x.id);
}

/** Is the live order still this variant's order? False after a manual drag — the
 *  UI marks the distance "edited" so a stale kilometre count never reads as
 *  current (the legs were measured for a sequence that no longer exists). */
export function variantMatchesLive(items, variant){
  const a = liveSequence(items), b = variantSequence(items, variant);
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Make a variant the live route: copy its sequence into order/day and rebuild
 *  scheduled* through the existing constraint solver, so appointments and locks
 *  are re-honoured against the new sequence. Returns every item (pending in the
 *  new order, then done, then ignored) with the live fields rewritten —
 *  callers persist them. Throws the solver's message when the variant cannot
 *  satisfy a lock or appointment, so a caller can toast and leave the current
 *  route untouched instead of half-applying one. */
export function applyVariant(items, variant, planOpts){
  const f = VARIANT_FIELDS[variant];
  if(!f) throw new Error('Unknown route variant');
  const all = (items || []).slice();
  const pending = pendingOf(all);
  if(!pending.length) return all;
  const seq = variantSequence(all, variant);
  const scheduled = scheduleRouteConstraints(pending, seq, planOpts);

  const byId = new Map(all.map(x => [String(x.id), x]));
  const done    = all.filter(x => x.wlStatus === 'done').sort(cmp('order'));
  const ignored = all.filter(x => x.wlStatus !== 'done' && isIgnored(x)).sort(cmp('order'));
  const tail = [...done, ...ignored].map(x => String(x.id));

  return [...scheduled.orderedIds, ...tail].map((id, i) => {
    const item = byId.get(String(id));
    if(!item) return null;
    const s = scheduled.scheduleById[id];
    return Object.assign({}, item, {
      order: i * 10,
      day: s ? scheduled.dayOf[id] : '',
      scheduledDate: s ? s.date : '', scheduledEta: s ? s.eta : '',
      scheduledSlot: s ? s.slot : '', scheduledWaitMin: s ? s.waitMin : '',
    });
  }).filter(Boolean);
}

/** Metres for a variant — the whole route, or one of its days. Sums the saved
 *  per-stop arrival legs over pending orders only. null when nothing was
 *  measured (no optimize has run, or this variant never did), which the UI
 *  shows as an em dash rather than a misleading 0 km. */
export function variantMeters(items, variant, opts = {}){
  const f = VARIANT_FIELDS[variant];
  if(!f) return null;
  const day = opts.day == null ? null : Number(opts.day);
  let total = 0, seen = false;
  for(const item of pendingOf(items)){
    if(day != null && Number(item[f.day]) !== day) continue;
    const m = num(item[f.legMeters]);
    if(m == null) continue;
    total += m; seen = true;
  }
  return seen ? total : null;
}

/** Metres for the LIVE route's day, taken from whichever variant is active.
 *  Day numbers on the live route are the active variant's, so this is just
 *  variantMeters keyed on the live `day` field.
 *
 *  Caveat: the saved legs charge each day's FIRST stop the drive out from home,
 *  so if the meters/day target changed since the route was worked out, the days
 *  are re-cut here and a boundary leg can land on the wrong day. The ROUTE total
 *  stays exact either way; only the per-day split can drift, and re-optimizing
 *  at the new target puts it right. */
export function liveDayMeters(items, variant, day){
  const f = VARIANT_FIELDS[variant];
  if(!f) return null;
  const want = Number(day);
  let total = 0, seen = false;
  for(const item of pendingOf(items)){
    if(Number(item.day) !== want) continue;
    const m = num(item[f.legMeters]);
    if(m == null) continue;
    total += m; seen = true;
  }
  return seen ? total : null;
}

/** Metres → a short human distance. One decimal below 10 km (a 4.2 km day reads
 *  wrong as "4 km"), whole kilometres above. */
export function fmtKm(metres){
  if(metres == null || !isFinite(Number(metres))) return '—';
  const km = Number(metres) / 1000;
  return (km < 10 ? Math.round(km * 10) / 10 : Math.round(km)) + ' km';
}

/** The parenthetical that keeps the two totals honest. `legMetersRoad` is always
 *  real driving metres; `legMetersStraight` is only comparable when it was
 *  priced against a road matrix — after a straight-line-only run it is
 *  crow-flies, and saying so is the difference between a comparison and a lie. */
export function distanceNote(variant, straightDistanceSource){
  if(variant === 'road') return 'road';
  return straightDistanceSource === 'road' ? 'road' : 'straight-line est.';
}

/** The label for one variant's button: "Road matrix · 234 km", plus the caveats
 *  that stop a number from being read as something it isn't. */
export function variantSummary(items, variant, opts = {}){
  const selectable = variantSelectable(items, variant);
  const metres = variantMeters(items, variant);
  const parts = [fmtKm(metres)];
  if(metres != null) parts.push(`(${distanceNote(variant, opts.straightDistanceSource)})`);
  if(selectable && opts.active && !variantMatchesLive(items, variant)) parts.push('· edited');
  return {
    variant,
    label: VARIANT_LABELS[variant],
    selectable,
    stale: hasVariant(items, variant) && !variantCoversPending(items, variant),
    metres,
    text: parts.join(' '),
  };
}

/** The active route's total for a counts line: "27 km (road)", qualified the
 *  moment the figure stops describing the list on screen. Two different ways
 *  that happens, and both must show — an unqualified total is a number the crew
 *  will plan around:
 *   - dragged: the legs were measured for a sequence that no longer exists;
 *   - out of date: orders were added or removed since, so the total silently
 *     leaves some of today's work out of the sum. */
export function routeTotalSummary(items, variant, straightDistanceSource){
  const metres = variantMeters(items, variant);
  if(metres == null) return '';
  let text = `${fmtKm(metres)} (${distanceNote(variant, straightDistanceSource)})`;
  if(!variantCoversPending(items, variant)) text += ' · out of date';
  else if(!variantMatchesLive(items, variant)) text += ' · edited';
  return text;
}
