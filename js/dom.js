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
