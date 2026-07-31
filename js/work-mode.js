// ── Work mode (boat | land) — the capture app's single source of truth ──────
// Every write the capture PWA makes is tagged `workType`, and the daily-log
// template, the end-of-day labels and the accent theme all follow it.
//
// **The capture app is LOCKED to land.** Boat work wound down in July 2026 and
// nobody is running the app from a boat, so the Boat/Land switch was removed
// from index.html: a control that can only be set wrong is worse than no
// control. The lock is a forced value, not a changed default — every phone in
// the field has `workMode='boat'` in localStorage (boat *was* the default), so
// defaulting alone would have left all of them on boat with no way back.
// Nothing reads the stored key any more; it is simply ignored.
//
// Nothing about the data model changed. `workType` still rides every payload
// and still occupies its appended-last column on Stops/Downtime/Tracker, the
// spine still reads blank/'boat' on historical rows (`normWorkType`), and
// js/dailylog.js keeps the boat template so an old day still reprints
// correctly from edit.html. This is a UI lock, not a feature removal.
//
// **To bring boat mode back**, in one commit:
//   1. `LOCKED_MODE = null` below;
//   2. restore the `.mode-seg` block in index.html's top bar and the
//      `.mode-seg` rules in css/capture.css (css/teams.css still has its copy);
//   3. restore `setMode()` + the modeBoat/modeLand click wiring in
//      js/pages/capture.js — `applyModeUI()` is unchanged and still branches on
//      workMode(), so it needs nothing;
//   4. put the localStorage read back in the <head> snippets of index.html and
//      help.html (see git history for the exact one-liner).
//
// teams.html is deliberately NOT locked and does not import this module. Its
// switch chooses which team cards the office is looking at — not what a crew's
// phone writes — so it kept its own toggle under its own `teamsViewMode` key.
import { store } from './store.js';

// Set to null to restore the per-device switch. Read the header first.
export const LOCKED_MODE = 'land';

export function workMode(){
  if (LOCKED_MODE) return LOCKED_MODE;
  return store.get('workMode') === 'land' ? 'land' : 'boat';
}
