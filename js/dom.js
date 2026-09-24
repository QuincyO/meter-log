// ── Tiny DOM helpers shared across pages ────────────────────────────────────
export const $   = id => document.getElementById(id);
export const enc = encodeURIComponent;

// escape helpers for building result cards from stored values
export const esc  = v => String(v??'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export const attr = v => String(v??'').replace(/[&"<>]/g, c => ({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));

// Toast: looks up the page's #toast element (a no-op if the page has none).
let toastTimer;
export function toast(msg){
  const t = $('toast'); if(!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Activity registry: transient "what the app is doing" labels ─────────────
// Silent background jobs (geocoding, PDF build, worklist sync…) push a label
// here while in flight; the status pill's paint() shows the newest one over its
// normal queue text and reverts when the job ends. Kept in this dependency-free
// leaf so any module can import begin/end without an import cycle back into
// queue.js (which owns paint and registers the change hook via onActivityChange).
let _actSeq = 0;
const _activities = new Map();   // id → label (a stack; newest wins)
const _started = new Map();      // id → start ms, for the activity log's durations
let _onActivityChange = null;
export function onActivityChange(fn){ _onActivityChange = fn; }
// A second, optional listener for the status pill's activity log
// (js/activity-log.js): {phase:'begin'|'end', id, label, ms, ok}. Fenced, so a
// logging failure can never break the job it describes.
let _onActivityEvent = null;
export function onActivityEvent(fn){ _onActivityEvent = fn; }
function emitActivity(ev){ if(_onActivityEvent) try { _onActivityEvent(ev); } catch {} }
export function activeActivity(){
  if(!_activities.size) return null;
  return [..._activities.values()].pop();   // most recently started
}
export function activeActivities(){ return [..._activities.values()]; }   // oldest first
export function beginActivity(label){
  const id = ++_actSeq;
  _activities.set(id, label);
  _started.set(id, Date.now());
  emitActivity({ phase:'begin', id, label });
  if(_onActivityChange) _onActivityChange();
  return id;
}
// `ok` is optional: withActivity passes it, direct begin/end callers may not.
export function endActivity(id, ok){
  if(id == null || !_activities.has(id)) return;
  const label = _activities.get(id);
  const ms = Date.now() - (_started.get(id) || Date.now());
  _activities.delete(id); _started.delete(id);
  emitActivity({ phase:'end', id, label, ms, ok });
  if(_onActivityChange) _onActivityChange();
}
// Ergonomic wrapper: show `label` for the lifetime of the async `fn`.
export async function withActivity(label, fn){
  const id = beginActivity(label);
  let ok = false;
  try { const r = await fn(); ok = true; return r; } finally { endActivity(id, ok); }
}
