// ── Tap vs. press-and-hold on one button ─────────────────────────────────────
// The worklist's 🧭 Optimize button carries two commands: a tap routes on
// straight-line distances, a two-second hold routes on the real road matrix
// (js/worklist.js). A timer alone is not enough, because three other things are
// happening on the same touch:
//
//  1. **The finger might be scrolling.** Optimize is a full-width 56px button,
//     so a swipe aimed at the page below it lands on it. A press that travels
//     more than `slop` px is a scroll, not a press, and must fire neither
//     command. (The first version instead preventDefault()ed `touchstart` to
//     stop iOS selecting the label — that also cancels panning, which turned the
//     button into a strip you could not scroll through. Selection is the CSS's
//     job; see the #wlOptimize rule in css/capture.css.)
//  2. **The browser may take the touch over itself** to pan the page, and
//     reports that as pointercancel. Nothing should fire, but a later real click
//     must still work.
//  3. **Releasing a pointer synthesizes a click.** Whichever command ran has to
//     eat that click or it runs twice.
//
// DOM-free and injectable-timer, like js/drag-autoscroll.js, so the whole state
// machine runs under `node --test` with no browser. Events are read for
// `pointerId`/`clientX`/`clientY`/`isPrimary`/`button` only, so tests pass plain
// object literals.

/** One press-and-hold gesture recognizer. Feed it pointer events; it decides
 *  whether they were a tap, a hold, or a scroll that happened to start here. */
export function createPressHold(opts = {}){
  const holdMs = opts.holdMs == null ? 2000 : opts.holdMs;
  // 10px is the usual tap slop: a finger never holds perfectly still, but a
  // deliberate scroll passes it almost immediately.
  const slop = opts.slop == null ? 10 : opts.slop;
  const onTap = opts.onTap || (() => {});
  const onHold = opts.onHold || (() => {});
  const setTimer = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout || (id => clearTimeout(id));

  let pointerId = null;    // the pointer being tracked, null when idle
  let timer = null;
  let startX = 0, startY = 0;
  let held = false;        // the hold already fired for this press
  let aborted = false;     // the press turned out to be a scroll
  let eatClick = false;    // a command ran, so consume the click that follows

  const disarm = () => {
    if(timer != null) clearTimer(timer);
    timer = null;
    pointerId = null;
  };

  return {
    /** Is a press being tracked right now? (Used to suppress the context menu.) */
    get active(){ return pointerId !== null; },

    /** pointerdown. Returns true if the press was accepted, so the caller can
     *  take pointer capture. */
    down(e){
      if(e.isPrimary === false || (e.button != null && e.button !== 0)) return false;
      disarm();
      pointerId = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      held = false;
      aborted = false;
      eatClick = false;
      timer = setTimer(() => {
        timer = null;
        held = true;
        eatClick = true;
        onHold();
      }, holdMs);
      return true;
    },

    /** pointermove. Returns true on the move that aborts the press (the caller
     *  releases capture then, so the browser owns the rest of the gesture). */
    move(e){
      if(pointerId === null || e.pointerId !== pointerId) return false;
      if(aborted || held) return false;   // the hold has already fired; let it stand
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if(Math.sqrt(dx * dx + dy * dy) <= slop) return false;
      aborted = true;
      eatClick = true;     // a mouse drag still ends in a click; that is not a tap
      disarm();
      return true;
    },

    /** pointerup. Fires onTap only for a press that neither travelled nor held. */
    up(e){
      if(pointerId === null || e.pointerId !== pointerId) return false;
      const tapped = !held && !aborted;
      disarm();
      held = false; aborted = false;
      eatClick = true;
      if(tapped) onTap();
      return true;
    },

    /** pointercancel — the browser took the touch to pan the page. Fire nothing,
     *  and leave `eatClick` clear so a later genuine click still activates. */
    cancel(e){
      if(pointerId === null || e.pointerId !== pointerId) return false;
      disarm();
      held = false; aborted = false;
      eatClick = false;
      return true;
    },

    /** click. Returns true if this was the synthetic click after a pointer
     *  gesture and the caller should preventDefault() it; false for a real
     *  click-only activation (keyboard, assistive tech), in which case onTap
     *  has just been called. */
    click(){
      if(eatClick){ eatClick = false; return true; }
      onTap();
      return false;
    },
  };
}
