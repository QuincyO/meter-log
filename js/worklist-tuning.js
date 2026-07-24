// ── Route tuning screen (#tuning) ─────────────────────────────────────────────
// A capture-only settings screen for the installer's two route dials — commute
// pull (how hard each day heads home) and target finish time (finish-early vs
// more stops). Values live in localStorage (store keys wlCommutePull / wlFinishBy)
// and are read by worklist.js planShape; they ride the worklist Upload to the
// office. A live "expected stops/day" readout is driven by the finish time only
// (commute pull's true cost needs a real route — deferred, see docs/backlog).
import { $, esc, toast } from './dom.js';
import { store, cfg } from './store.js';
import { apiGet } from './api.js';
import { hhmmMin } from './time.js';
import { ROUTE_DEPART_TIME } from './config.js';
import { onSiteMinutes, NOMINAL_TRAVEL_MIN } from './route-constraints.js';

// A commute-pull dial value clamped to 0–100; blank/garbage ⇒ the 70 default.
function pullVal(v){
  const n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : 70;
}

// How many stops a day fits by `finishMin`, from the installer's pace — the same
// per-stop model route.js timeCapacity uses (pace-derived on-site + a nominal
// between-stop drive), minus one nominal morning drive-out. Minutes-of-day in;
// null when the finish time or pace is unusable, or the break eats the day.
export function expectedDailyStops({ departMin, finishMin, pace, breakMin = 60 }){
  if(!isFinite(finishMin) || !isFinite(departMin) || !(pace > 0)) return null;
  const available = finishMin - departMin - breakMin;
  const perStop = onSiteMinutes(pace) + NOMINAL_TRAVEL_MIN;
  if(!(available > 0) || !(perStop > 0)) return null;
  return Math.max(0, Math.floor((available - NOMINAL_TRAVEL_MIN) / perStop));
}

let pace = null, avgPerDay = null, metricsLoaded = false;

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
  const p = pace || Number(store.get('wlPaceMin')) || 30;
  const n = expectedDailyStops({ departMin:hhmmMin(ROUTE_DEPART_TIME), finishMin:hhmmMin(finishStr), pace:p });
  const lines = [
    n == null ? 'Set a finish time to see expected stops' : `At ${finishStr} finish → ~${n} stops/day`,
    `Your 30-day pace: ${pace ? pace + ' min/stop' : '—'}`
  ];
  if(avgPerDay) lines.push(`Recent avg: ${avgPerDay} meters/day`);
  $('tuneReadout').innerHTML = lines.map(esc).join('<br>');
}

function loadControls(){
  const pull = $('tuneCommutePull');
  pull.value = String(pullVal(store.get('wlCommutePull')));
  $('tuneCommutePullVal').textContent = pull.value + '%';
  $('tuneFinishBy').value = store.get('wlFinishBy') || '14:00';
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
  await loadMetrics();
  render();
}
function close(){ $('tuningScreen').classList.add('hide'); }

export function initWorklistTuning(){
  $('tuneCommutePull').oninput = () => { $('tuneCommutePullVal').textContent = $('tuneCommutePull').value + '%'; };
  $('tuneFinishBy').oninput = render;
  $('tuneSave').onclick = save;
  $('tuneBack').onclick = () => location.hash === '#tuning' ? history.back() : close();
  return { open, close };
}
