// ── Shared UTI reason picklist ───────────────────────────────────────────────
// The single source of truth for the "why couldn't we install?" reasons, used
// by the capture form (index.html) and the back-office stop editor (edit.html).
// "Other" is not in this list — it's appended by the option builder and reveals
// a free-text box; the stored value then becomes "Other: <text>".

// The reason that counts as an EER (emergency electrical repair) on the day's
// clipboard tally — see js/compute/tally.js tallyBlock. Named here rather than
// written as a literal at the counting site so the tally and the picklist can
// never drift apart silently; tests/day-tally-block.test.mjs fails the build if
// this string stops being one of the reasons below, because a rename would
// otherwise just zero the EER line with nothing on screen saying so.
//
// It is the EMERGENCY pick only. Plain 'Electrical Repair' was the EER reason
// until 2026-11-18 and is now an ordinary UTI: the two are different jobs, and
// the office counts only the emergency ones as EER.
export const EER_UTI_REASON = 'Emergency Electrical Repair';

export const UTI_REASONS = [
  'Appointment Needed',
  'Bad Road',
  'Breaker Before Meter',
  'Could Not Locate',
  'Customer Delay/Change',
  'Denied Access',
  'Electrical Repair',
  'Emergency Electrical Repair',
  'Device Not Listed',
  'Gas - Natural too close',
  'Gas - Propane too close',
  'Incorrect/Missing Info',
  'Inside Meter - Need Appointment',
  'Key Required',
  'Meter Removed/Disconnected',
  'No Access',
  'No Power',
  'Schedule Change',
  'Theft/Tamper/Vandalism',
  'Unsafe Conditions',
  'Water Access',
  'Wrong Meter'
];

// Inner <option> markup for a UTI-reason <select>: a disabled blank placeholder,
// every known reason, then "Other". `selected` is preselected; a non-empty value
// that isn't a known reason (a stored "Other: …" or legacy free-text) selects
// "Other" so existing data always round-trips.
export function utiReasonOptionsHTML(selected){
  const sel = selected == null ? '' : String(selected);
  const known = UTI_REASONS.includes(sel);
  const other = sel !== '' && !known;   // "Other: …" or any free-text falls here
  const opts = [`<option value="" disabled${sel===''?' selected':''}>Select a reason…</option>`];
  UTI_REASONS.forEach(r => opts.push(`<option${r===sel?' selected':''}>${r}</option>`));
  opts.push(`<option${other?' selected':''}>Other</option>`);
  return opts.join('');
}

// The note the installer sends their supervisor after a UTI, copied to the
// clipboard when the stop is logged (js/pages/capture.js):
//
//     Work order: 1022668
//     No Access - gate locked, dog loose
//
// The second line is the stored reason, then the stop's Note when there is one.
//
// "Work order" is TWO WORDS on purpose. A paste that begins with one word and a
// colon (`Workorder:`) is a valid URI scheme, and iOS publishes a URL flavour of
// it that Messages pastes percent-encoded — the day-tally bug of 2026-08-14 (see
// js/compute/tally.js). A space before the colon means there is no scheme to
// find. tests/uti-note-copy.test.mjs asserts the text does not parse as a URL.
export function utiNoteText(stop){
  const s = stop || {};
  const text = v => String(v == null ? '' : v).trim();
  const note = text(s.notes);
  return `Work order: ${text(s.workOrderId)}\n${text(s.utiReason)}${note ? ' - ' + note : ''}`;
}
