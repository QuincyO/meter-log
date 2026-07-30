// ── Today's observed on-site cadence, from the day's own WO→WO gaps ─────────
// Pure and DOM-free. The caller (js/worklist.js onsitePerStopReal) builds the gap
// list with computeGapsLocal and owns the fallbacks; everything that decides what
// a number of minutes MEANS lives here, so it can be tested against a real day.

// The median of a list of numbers, or null when there is nothing to take one of.
// Exported for its own test — the choice of median over mean is the whole point of
// this module, so it is worth being able to state it directly.
export function median(xs){
  const s = (xs || []).slice().sort((a, b) => a - b);
  if(!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One gap's productive minutes: the wall-clock gap less whatever delay the crew
// allocated to it. Floored at 0 — an over-allocated gap is a data-entry artifact,
// not negative time.
export function nettedGapMin(gap){
  const idle = Number(gap && gap.idleMin) || 0;
  const logged = ((gap && gap.allocations) || [])
    .reduce((a, x) => a + (Number(x.minutes) || 0), 0);
  return Math.max(0, idle - logged);
}

// The day's observed minutes between stops, net of logged delay. Null when the day
// has no gaps yet (before the second stop), which the caller reads as "no
// measurement — keep the modelled dwell".
//
// **It is the MEDIAN, and that is the entire bug this replaced.** A day is a
// handful of gaps, and a crew that gets held up — waiting on a meter, a customer
// who isn't home, a truck that won't start — records that wait as one enormous
// WO→WO gap. Averaged, a single 190-minute hold-up moves the per-stop number by
// over an hour, and because every later projection re-reads the same day it NEVER
// washes out: the gauge stays wrecked until midnight. It shipped that way and was
// reported as "at 10:30 it said I'd only get 3 more done, when I'd already done 3
// and had the whole day left". The median costs that day one gap instead of all of
// them, needs no threshold to tune, and — the part that matters — works on a day
// where the crew logged nothing, which is the normal case in the field.
//
// The spine reached the same conclusion from the other end: `installerOnSiteFit`
// trims outliers by residual before fitting (AGENTS.md §"An ETA has two halves",
// trap 3). This is that idea at the size a single day comes in.
//
// Netting the logged delay out first is insurance rather than the fix — a hold-up
// is usually only written down at end of day, if at all. But it costs nothing, the
// caller already has the rows open, and it is what capture.js passes to this same
// gap model for the end-of-day review. Dropping them meant a delay the crew HAD
// logged was still charged as time spent installing.
export function observedOnSiteMin(gaps){
  return median((gaps || []).map(nettedGapMin));
}
