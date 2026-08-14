// ── Route tuning screen (#tuning) ─────────────────────────────────────────────
// A capture-only settings screen for the installer's route dials — commute pull
// (how hard each day heads home) and the on-site override. Values live in
// localStorage (store key wlCommutePull) and are read by worklist.js planShape;
// they ride the worklist Upload to the office.
//
// There used to be a "Target finish time" dial here as well, and it did two jobs:
// projected the day's landing, and — invisibly — SHRANK the day below the
// meters/day target. The second made the target inert above whatever clock the
// dial implied, so it is gone and the target alone sizes a day. The projection
// survives, anchored on the fixed end of the working day (config.js
// ROUTE_DAY_END), because "will I get through today's route" is a useful question
// that never needed a per-installer dial to answer.
import { $, esc, toast } from './dom.js';
import { store, cfg } from './store.js';
import { showMetricsPref, setShowMetricsPref } from './drive-recorder.js';
import { apiGet } from './api.js';
import { hhmmMin } from './time.js';
import { ROUTE_DAY_END } from './config.js';
import { projectDayReal } from './compute/estimate.js';

// ── Navigate destination preference (device-local) ──────────────────────────
// Which destination the maps hand-off prefers — see js/worklist.js destOf(). It
// is saved the instant it is tapped (like driveShowMetrics) and NEVER uploaded:
// it changes nothing the office or the router reads, so it has no business in
// the Save/Upload path above.
//
// It lives in this module rather than beside destOf() because js/worklist.js
// already imports initWorklistTuning from here — the reverse import would be a
// cycle (the same reason js/drive.js never imports worklist.js back; see its
// header). One key, one default, one place.
//
// Default 'pin', the behaviour shipped 2026-08-13. `wlNavBy` is a brand-new key,
// so unlike the workMode rename there is no legacy value in the field for the
// default to fight — a default never fires on a key that is already set.
export function navByPin(){ return store.get('wlNavBy') !== 'address'; }
export function setNavByPin(on){ store.set('wlNavBy', on ? 'pin' : 'address'); }

// A commute-pull dial value clamped to 0–100; blank/garbage ⇒ the 70 default.
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}

let pace = null, avgPerDay = null, metricsLoaded = false;
// Real-data pace inputs from the live route/day, loaded once per open (worklist.js
// paceContext). Independent of the dials, so render() can reproject synchronously
// as the on-site box is typed in without re-reading the dayCache each keystroke.
let getPaceContext = null, paceCtx = null;
// The dwell model + its provenance, handed down by worklist.js. Not re-derived
// here: a second copy of the "override beats measurement" precedence is how the
// readout and the actual route end up quoting different numbers.
let getDwell = null, getMeasuredOnSite = null, getOnSiteSourceLabel = null,
    onOnSiteChanged = null;

async function loadMetrics(){
  const c = cfg();
  if(metricsLoaded || !c.hNumber || !navigator.onLine) return;
  try{
    const r = await apiGet('installerMetrics', { hNumber:c.hNumber, workType:'land' });
    const m = (r && r.ok && r.metrics && r.metrics[0]) || null;
    if(m){
      pace = (m.recent30AvgLogMin === '' || m.recent30AvgLogMin == null)
        ? ((m.avgLogMin === '' || m.avgLogMin == null) ? null : Number(m.avgLogMin))
        : Number(m.recent30AvgLogMin);
      avgPerDay = (m.avgPerDay === '' || m.avgPerDay == null) ? null : Number(m.avgPerDay);
      metricsLoaded = true;
    }
  } catch {}
}

function render(){
  // The LIVE on-site field wins while typing, so the readout responds before Save
  // rather than after it. The dwell model is handed down rather than re-derived —
  // a second copy of "override beats measurement" is how the two screens drift.
  const dwell = getDwell ? getDwell() : null;
  const typed = Math.round(Number($('tuneOnSite').value));
  const onSiteMin = (isFinite(typed) && typed > 0) ? typed : (dwell ? dwell.base : null);
  const lines = [`Your 30-day pace: ${pace ? pace + ' min/stop' : '—'}`];
  if(onSiteMin) lines.push(`On site: ${Math.round(onSiteMin)} min/stop`
    + ((isFinite(typed) && typed > 0) ? ' (set by you)'
       : (getOnSiteSourceLabel ? ` (${getOnSiteSourceLabel()})` : '')));
  if(avgPerDay) lines.push(`Recent avg: ${avgPerDay} meters/day`);
  // Where today's remaining route lands, from real cadence + real route travel,
  // against the fixed end of the working day. A projection only — nothing here
  // shortens a route, which is the whole difference from the dial this replaced.
  if(paceCtx && paceCtx.pendingCount){
    const est = projectDayReal({ ...paceCtx, finishByMin: hhmmMin(ROUTE_DAY_END) });
    const t = est.ready ? est.paces.target : null;
    // Short of the ROUTE — the stops still on today's day-1 list that won't be
    // reached, which is what the Drive-screen gauge reads too (js/compute/estimate.js
    // paceFor). The meters/day target sizes the route rather than judging it.
    if(t) lines.push(`Projected to land ~${t.projected} by ${ROUTE_DAY_END}`
      + `${t.onPace ? ' ✓' : ` · ${t.routeShort} short`}`);
  }
  $('tuneReadout').innerHTML = lines.map(esc).join('<br>');
}

function loadControls(){
  const pull = $('tuneCommutePull');
  pull.value = String(pullVal(store.get('wlCommutePull')));
  $('tuneCommutePullVal').textContent = pull.value + '%';
  $('tuneShowDriveMetrics').checked = showMetricsPref();
  // Unchecked is the default (the pin), so an untouched phone reads as today.
  // Guarded for the same reason as the binding in initWorklistTuning below —
  // this screen can legitimately run against markup that predates the element.
  const navBox = $('tuneNavByAddress');
  if(navBox) navBox.checked = !navByPin();
  // Blank means "use the measurement" — so show the override only when there is
  // one, and let the placeholder carry the measured number.
  const override = Number(store.get('wlOnSiteOverride'));
  $('tuneOnSite').value = (isFinite(override) && override > 0) ? String(override) : '';
  const measured = getMeasuredOnSite ? getMeasuredOnSite() : null;
  $('tuneOnSite').placeholder = measured ? `measured: ${Math.round(measured)}` : 'measured';
  $('tuneOnSiteHint').textContent = measured
    ? `Hands-on time at a stop, not counting the drive to it. Yours measures ${Math.round(measured)} min — leave blank to use it.`
    : 'Hands-on time at a stop, not counting the drive to it. No history yet, so this is estimated from your pace.';
}

function save(){
  store.set('wlCommutePull', String(pullVal($('tuneCommutePull').value)));
  // The override lives in its own key, so clearing the box hands the installer
  // their measured number back rather than leaving the last typed one behind.
  const on = Math.round(Number($('tuneOnSite').value));
  store.set('wlOnSiteOverride', (isFinite(on) && on > 0) ? String(on) : '');
  if(onOnSiteChanged) onOnSiteChanged();
  toast('Saved — Upload your list to sync these to the office');
}

async function open(){
  $('captureMain').classList.add('hide');
  $('worklistScreen').classList.add('hide');
  $('tuningScreen').classList.remove('hide');
  loadControls();
  render();
  window.scrollTo(0, 0);
  // Real route/day inputs for the landing what-if — best-effort, offline-capable.
  try { paceCtx = getPaceContext ? await getPaceContext() : null; } catch { paceCtx = null; }
  await loadMetrics();
  render();
}
function close(){ $('tuningScreen').classList.add('hide'); }

export function initWorklistTuning(opts){
  getPaceContext = (opts && opts.getPaceContext) || getPaceContext;
  getDwell = (opts && opts.getDwell) || getDwell;
  getMeasuredOnSite = (opts && opts.getMeasuredOnSite) || getMeasuredOnSite;
  getOnSiteSourceLabel = (opts && opts.getOnSiteSourceLabel) || getOnSiteSourceLabel;
  onOnSiteChanged = (opts && opts.onOnSiteChanged) || onOnSiteChanged;
  $('tuneCommutePull').oninput = () => { $('tuneCommutePullVal').textContent = $('tuneCommutePull').value + '%'; };
  $('tuneOnSite').oninput = render;
  $('tuneSave').onclick = save;
  // Device-local: save on toggle, independent of Save/Upload — it never syncs.
  $('tuneShowDriveMetrics').onchange = e => setShowMetricsPref(e.target.checked);
  // Same deal, and deliberately NOT routed through save(): that toast says
  // "Upload your list to sync these to the office", which would be a lie about a
  // key that never leaves the phone. It gets its own toast because the effect is
  // invisible until the next Navigate press and there is no Save press to confirm it.
  //
  // GUARDED ON PURPOSE — this is structural, not defensive style. sw.js is
  // stale-while-revalidate **per file**, so this module and the index.html that
  // carries #tuneNavByAddress refresh on their own schedules: for an open or two
  // after a deploy (longer on a truck with poor signal, where the background
  // re-fetch just fails) a phone legitimately runs THIS file against the PREVIOUS
  // markup. `$()` returns null for a missing id rather than throwing, so an
  // unguarded assignment here throws a TypeError — and initWorklist() is called
  // from js/pages/capture.js at module top level, so that throw aborted the whole
  // capture module and left every handler below it unbound: Log stop, the downtime
  // form and the entire end-of-day close-out. It shipped that way on 2026-08-14 and
  // was reported as "the End of day button does not work".
  //
  // The rule it earns: **an element in a page's markup is a cross-file contract
  // with the module that binds it**, so bind a freshly-added id defensively. There
  // is no atomic-shell alternative here: the sw.js CACHE version is never bumped
  // (AGENTS.md standing rule — the field updates manually via Settings ▸ ⟳ Force
  // update), so a phone may run this file against older markup indefinitely.
  const navBox = $('tuneNavByAddress');
  if(navBox) navBox.onchange = e => {
    setNavByPin(!e.target.checked);
    toast(e.target.checked ? 'Navigate by address' : 'Navigate by map pin');
  };
  $('tuneBack').onclick = () => location.hash === '#tuning' ? history.back() : close();
  return { open, close };
}
