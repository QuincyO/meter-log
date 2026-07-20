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
let _onActivityChange = null;
export function onActivityChange(fn){ _onActivityChange = fn; }
export function activeActivity(){
  if(!_activities.size) return null;
  return [..._activities.values()].pop();   // most recently started
}
export function beginActivity(label){
  const id = ++_actSeq;
  _activities.set(id, label);
  if(_onActivityChange) _onActivityChange();
  return id;
}
export function endActivity(id){
  if(id == null || !_activities.delete(id)) return;
  if(_onActivityChange) _onActivityChange();
}
// Ergonomic wrapper: show `label` for the lifetime of the async `fn`.
export async function withActivity(label, fn){
  const id = beginActivity(label);
  try { return await fn(); } finally { endActivity(id); }
}
