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
// per-stop model route.js timeCapacity uses (pace-derived on-site + a between-stop
// drive), minus one morning drive-out. `travelPerStopMin` is the between-stop drive:
// it defaults to the nominal baseline, but callers pass the current route's REAL
// average leg travel (priced at the truck's measured speed) so the what-if reflects
// actual working data. Minutes-of-day in; null when the finish time or pace is
// unusable, or the break eats the day.
export function expectedDailyStops({ departMin, finishMin, pace, breakMin = 60,
                                     travelPerStopMin = NOMINAL_TRAVEL_MIN }){
  if(!isFinite(finishMin) || !isFinite(departMin) || !(pace > 0)) return null;
  const available = finishMin - departMin - breakMin;
  const perStop = onSiteMinutes(pace) + travelPerStopMin;
  if(!(available > 0) || !(perStop > 0)) return null;
  return Math.max(0, Math.floor((available - travelPerStopMin) / perStop));
}

let pace = null, avgPerDay = null, metricsLoaded = false;
// Real-data pace inputs from the live route/day, loaded once per open (worklist.js
// paceContext). Independent of the dials, so render() can reproject synchronously
// against a dragged finish time without re-reading the dayCache each keystroke.
let getPaceContext = null, paceCtx = null;

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
  const n = expectedDailyStops({ departMin:hhmmMin(ROUTE_DEPART_TIME), finishMin, pace:p, travelPerStopMin });
  const lines = [
    n == null ? 'Set a finish time to see expected stops' : `At ${finishStr} finish → ~${n} stops/day`,
    `Your 30-day pace: ${pace ? pace + ' min/stop' : '—'}`
  ];
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
}

function save(){
  store.set('wlCommutePull', String(pullVal($('tuneCommutePull').value)));
  const f = $('tuneFinishBy').value;
  if(/^\d{1,2}:\d{2}$/.test(f)) store.set('wlFinishBy', f);
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
  $('tuneCommutePull').oninput = () => { $('tuneCommutePullVal').textContent = $('tuneCommutePull').value + '%'; };
  $('tuneFinishBy').oninput = render;
  $('tuneSave').onclick = save;
  // Device-local: save on toggle, independent of Save/Upload — it never syncs.
  $('tuneShowDriveMetrics').onchange = e => setShowMetricsPref(e.target.checked);
  $('tuneBack').onclick = () => location.hash === '#tuning' ? history.back() : close();
  return { open, close };
}
