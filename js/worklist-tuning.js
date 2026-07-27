// ── Route tuning screen (#tuning) ─────────────────────────────────────────────
// A capture-only settings screen for the installer's two route dials — commute
// pull (how hard each day heads home) and target finish time (finish-early vs
// more stops). Values live in localStorage (store keys wlCommutePull / wlFinishBy)
// and are read by worklist.js planShape; they ride the worklist Upload to the
// office. A live "expected stops/day" readout is driven by the finish time only
// (commute pull's true cost needs a real route — deferred, see docs/backlog).
import { $, esc, toast } from './dom.js';
import { store, cfg } from './store.js';
import { showMetricsPref, setShowMetricsPref } from './drive-recorder.js';
import { apiGet } from './api.js';
import { hhmmMin } from './time.js';
import { ROUTE_DEPART_TIME } from './config.js';
import { onSiteMinutes, NOMINAL_TRAVEL_MIN } from './route-constraints.js';
import { projectDayReal } from './compute/estimate.js';

// A commute-pull dial value clamped to 0–100; blank/garbage ⇒ the 70 default.
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}

// How many stops a day fits by `finishMin`, from the installer's pace — the same
// per-stop model route.js timeCapacity uses (on-site + a between-stop drive), minus
// one morning drive-out. `travelPerStopMin` is the between-stop drive: it defaults
// to the nominal baseline, but callers pass the current route's REAL average leg
// travel (priced at the truck's measured speed) so the what-if reflects actual
// working data. `onSiteMin` is the installer's MEASURED dwell when they have one;
// without it this falls back to pace-minus-the-nominal-drive, unchanged. Minutes-of-day
// in; null when the finish time or pace is unusable, or the break eats the day.
export function expectedDailyStops({ departMin, finishMin, pace, breakMin = 60,
                                     travelPerStopMin = NOMINAL_TRAVEL_MIN,
                                     onSiteMin = null }){
  if(!isFinite(finishMin) || !isFinite(departMin) || !(pace > 0)) return null;
  const available = finishMin - departMin - breakMin;
  const onSite = (isFinite(Number(onSiteMin)) && Number(onSiteMin) > 0)
    ? Number(onSiteMin) : onSiteMinutes(pace);
  const perStop = onSite + travelPerStopMin;
  if(!(available > 0) || !(perStop > 0)) return null;
  return Math.max(0, Math.floor((available - travelPerStopMin) / perStop));
}

let pace = null, avgPerDay = null, metricsLoaded = false;
// Real-data pace inputs from the live route/day, loaded once per open (worklist.js
// paceContext). Independent of the dials, so render() can reproject synchronously
// against a dragged finish time without re-reading the dayCache each keystroke.
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
  const finishStr = $('tuneFinishBy').value;
  const finishMin = hhmmMin(finishStr);
  const p = pace || Number(store.get('wlPaceMin')) || 30;
  // Use the current route's real average leg travel when we have it, so the
  // expected-stops number reacts to the finish dial with actual working data.
  const travelPerStopMin = (paceCtx && paceCtx.avgLegTravelMin) || undefined;
  // The same dwell the route model will use, handed down rather than re-derived —
  // an "expected stops/day" that disagrees with the ETAs is worse than none. The
  // LIVE field value wins while typing, exactly as the finish-time dial does, so
  // the readout responds before Save rather than after it.
  const dwell = getDwell ? getDwell() : null;
  const typed = Math.round(Number($('tuneOnSite').value));
  const onSiteMin = (isFinite(typed) && typed > 0) ? typed : (dwell ? dwell.base : null);
  const n = expectedDailyStops({ departMin:hhmmMin(ROUTE_DEPART_TIME), finishMin, pace:p,
                                 travelPerStopMin, onSiteMin });
  const lines = [
    n == null ? 'Set a finish time to see expected stops' : `At ${finishStr} finish → ~${n} stops/day`,
    `Your 30-day pace: ${pace ? pace + ' min/stop' : '—'}`
  ];
  if(onSiteMin) lines.push(`On site: ${Math.round(onSiteMin)} min/stop`
    + ((isFinite(typed) && typed > 0) ? ' (set by you)'
       : (getOnSiteSourceLabel ? ` (${getOnSiteSourceLabel()})` : '')));
  if(avgPerDay) lines.push(`Recent avg: ${avgPerDay} meters/day`);
  // What-if landing: reproject today's remaining route against the dragged finish
  // time, from real cadence + real route travel. Shows how the day is affected as
  // the installer moves the dial. Only when there's a route + pace to project.
  if(paceCtx && paceCtx.pendingCount){
    const est = projectDayReal({ ...paceCtx, finishByMin: finishMin });
    const t = est.ready ? est.paces.target : null;
    if(t) lines.push(`Projected to land ~${t.projected} today${t.onPace ? ' ✓' : ` · ${t.delta} short`}`);
  }
  $('tuneReadout').innerHTML = lines.map(esc).join('<br>');
}

function loadControls(){
  const pull = $('tuneCommutePull');
  pull.value = String(pullVal(store.get('wlCommutePull')));
  $('tuneCommutePullVal').textContent = pull.value + '%';
  $('tuneFinishBy').value = store.get('wlFinishBy') || '14:00';
  $('tuneShowDriveMetrics').checked = showMetricsPref();
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
  const f = $('tuneFinishBy').value;
  if(/^\d{1,2}:\d{2}$/.test(f)) store.set('wlFinishBy', f);
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
  $('tuneFinishBy').oninput = render;
  $('tuneOnSite').oninput = render;
  $('tuneSave').onclick = save;
  // Device-local: save on toggle, independent of Save/Upload — it never syncs.
  $('tuneShowDriveMetrics').onchange = e => setShowMetricsPref(e.target.checked);
  $('tuneBack').onclick = () => location.hash === '#tuning' ? history.back() : close();
  return { open, close };
}
