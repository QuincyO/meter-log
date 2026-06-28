// ── Downtime category sets + labels (client mirror of Code.gs) ───────────────
// Kept in sync with Code.gs: CATEGORIES (the 10 delay reasons), BREAK_CATS,
// TRAVEL_ADJ_CATS, and CAT_LABEL_SRV. Used by the local daily-log summary +
// renderer so an offline PDF buckets downtime exactly like the spine.

// The 10 delay reasons that count toward the "Delay Time" box / Tracker columns.
export const CATEGORIES = [
  'NEXT_GEN', 'CELL_SIGNAL', 'BAD_WEATHER', 'WAREHOUSE', 'TOOLS_MATERIAL',
  'DISPATCH', 'TRUCK_ISSUES', 'ASSIST', 'URGENT_EER', 'OTHER'
];
// Allocation categories that are NOT delays — their own daily-log lines, and kept
// out of the delay total (they still subtract from a gap's WO→WO travel).
export const BREAK_CATS      = ['LUNCH', 'BREAK'];   // "Breaks" footer line
export const TRAVEL_ADJ_CATS = ['MISC_TRAVEL'];      // "Misc Travel" footer line

// Human labels for the footer summary line.
export const CAT_LABEL = {
  NEXT_GEN:'Next Gen', CELL_SIGNAL:'Cell Signal', BAD_WEATHER:'Bad Weather',
  WAREHOUSE:'Warehouse', TOOLS_MATERIAL:'Tools/Material', DISPATCH:'Dispatch',
  TRUCK_ISSUES:'Truck Issues', ASSIST:'Assist', URGENT_EER:'Urgent/EER', OTHER:'Other',
  LUNCH:'Lunch', BREAK:'Break', MISC_TRAVEL:'Misc Travel',
  // Logged like a downtime reason but counts as TRAVEL, not downtime.
  TRAVEL_TIME:'Travel Time'
};

// "Next Gen 15 · Lunch 30 · Total 45 min" — mirrors downtimeSummary() on the spine.
export function downtimeSummary(downtime){
  const byCat = {}; let total = 0;
  (downtime||[]).forEach(d => {
    const c = (d.category||'OTHER'), m = Number(d.minutes)||0;
    byCat[c] = (byCat[c]||0) + m; total += m;
  });
  const parts = Object.keys(byCat).map(c => (CAT_LABEL[c]||c) + ' ' + byCat[c]);
  return parts.length ? (parts.join(' · ') + ' · Total ' + total + ' min') : '0 min';
}
