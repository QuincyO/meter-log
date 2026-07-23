// ── Drag-to-edge autoscroll ──────────────────────────────────────────────────
// Shared by the two touch-drag lists (js/worklist.js and
// js/worklist-route-view.js). Without it a card can only be moved as far as the
// screen shows: to lift the last order to the top of a twenty-stop list the
// installer had to drop it, scroll, pick it up again, and repeat.
//
// While the finger sits within `edge` px of the top or bottom of the viewport
// the page scrolls under it, a frame at a time. The caller is handed the ACTUAL
// scrolled distance (the page can be at its end and scroll nothing) so it can
// re-anchor the dragged card and re-pick its slot against the neighbours that
// just came into view.
//
// Both lists scroll the window — `.wlscreen` and `.wl-route-screen` have no
// overflow of their own — so `windowScroller()` is the only adapter that
// exists. Everything is injectable so this runs under `node --test` with no DOM.

/** px/frame for a pointer at `clientY` in a viewport `height` tall. 0 in the
 *  middle band, negative near the top (scroll up), positive near the bottom,
 *  ramped by how deep into the zone the finger is and clamped to `maxSpeed`. */
// px/frame at the very edge. ~1400 px/s at 60fps: fast enough to cross a
// twenty-order list in a couple of seconds, slow enough to stop on a slot.
export function edgeSpeed(clientY, height, edge = 96, maxSpeed = 24){
  if(!isFinite(clientY) || !isFinite(height) || height <= 0) return 0;
  // A short viewport (or a fat edge band) would otherwise have the two zones
  // overlap in the middle and scroll while the finger is nowhere near an edge.
  const band = Math.max(1, Math.min(edge, Math.floor(height / 2) - 1));
  if(clientY < band) return -ramp(band - clientY, band, maxSpeed);
  if(clientY > height - band) return ramp(clientY - (height - band), band, maxSpeed);
  return 0;
}
function ramp(depth, band, maxSpeed){
  return Math.max(1, Math.round(Math.min(1, depth / band) * maxSpeed));
}

/** The window/document adapter. `scrollBy` returns the distance actually
 *  scrolled, which is 0 once the document is at either end. */
export function windowScroller(){
  return {
    height: () => window.innerHeight || 0,
    scrollBy(dy){
      const el = document.scrollingElement || document.documentElement;
      const before = el.scrollTop;
      window.scrollBy(0, dy);
      return el.scrollTop - before;
    },
  };
}

/** Autoscroll for one drag. `track(clientY)` on every pointermove; `stop()` on
 *  release (idempotent — release can arrive twice through capture loss). */
export function createDragAutoScroll(opts = {}){
  const scroller = opts.scroller || windowScroller();
  const raf = opts.raf || (fn => requestAnimationFrame(fn));
  const cancelRaf = opts.cancelRaf || (id => cancelAnimationFrame(id));
  const edge = opts.edge == null ? 96 : opts.edge;
  const maxSpeed = opts.maxSpeed == null ? 24 : opts.maxSpeed;
  const onScroll = opts.onScroll || (() => {});
  let frame = null, y = null, stopped = false;

  const step = () => {
    frame = null;
    if(stopped || y == null) return;
    const speed = edgeSpeed(y, scroller.height(), edge, maxSpeed);
    if(!speed) return;                      // finger left the zone — idle until the next track()
    const moved = scroller.scrollBy(speed);
    if(moved) onScroll(moved);              // 0 = document already at the end; keep the loop alive
    frame = raf(step);
  };

  return {
    track(clientY){
      if(stopped) return;
      y = clientY;
      if(frame == null && edgeSpeed(y, scroller.height(), edge, maxSpeed)) frame = raf(step);
    },
    stop(){
      stopped = true;
      if(frame != null) cancelRaf(frame);
      frame = null;
    },
  };
}
