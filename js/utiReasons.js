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
export const EER_UTI_REASON = 'Electrical Repair';

export const UTI_REASONS = [
  'Appointment Needed',
  'Bad Road',
  'Breaker Before Meter',
  'Could Not Locate',
  'Customer Delay/Change',
  'Denied Access',
  'Electrical Repair',
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
