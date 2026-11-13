// ── Work-order numbers out of photo text — the pure half of the photo bot ────
// The vision model (ocr.mjs) reads each photo; this turns its text into
// six-digit numbers and keeps the batch the user sends. The user still sees
// every number before ✅ Send, which is the check on a misread.
//
// Pure and dependency-free so `node --test` covers it (tests/wo-bot-extract.test.mjs).

/** Work orders are exactly six digits (the handheld's list: 902732, 900821, …). */
export const WO_DIGITS = 6;

// A run of exactly six digits, not glued to another digit or a decimal point —
// so the dialog header "5160.0 Minute" (and OCR's "51 60 n Minute") never match.
const WO_IN_LINE = new RegExp(`(?<![\\d.])\\d{${WO_DIGITS}}(?![\\d.])`, 'g');
// "1. 902732", "- 902732", "• 902732" — a vision model's list formatting.
const LIST_MARKER = /^\s*(?:\d{1,2}[.)]\s+|[-*•]\s*)/;
const ONLY_DIGITS = new RegExp(`^\\d{${WO_DIGITS}}$`);

/** The six-digit numbers in the reader's text, top to bottom, de-duplicated. */
export function numbersIn(text){
  const out = [], seen = new Set();
  const push = n => { if(!seen.has(n)){ seen.add(n); out.push(n); } };
  for(const raw of String(text == null ? '' : text).split(/\r?\n/)){
    const line = raw.replace(LIST_MARKER, '');
    // A line that is nothing but digits split by spaces ("902 732") is one number
    // broken apart; anything with letters in it is left to the token match.
    const squeezed = line.replace(/\s+/g, '');
    if(ONLY_DIGITS.test(squeezed)){ push(squeezed); continue; }
    for(const m of line.matchAll(WO_IN_LINE)) push(m[0]);
  }
  return out;
}

/** A fresh batch: the numbers that ✅ Send will queue, and how many photos they
 *  came from. `photos` is what lets Send treat the batch as a picture of the
 *  WHOLE list and ask which worklist orders are missing from it — typed numbers
 *  alone never do, or one typed order would report every other one as removed. */
export function newBatch(){ return { confirmed: [], photos: 0 }; }

function fold(batch, nums){
  let added = 0;
  for(const n of nums){
    if(batch.confirmed.includes(n)) continue;
    batch.confirmed.push(n); added++;
  }
  return added;
}

/** Fold one photo's numbers into the batch. The scrolled photos of one list
 *  overlap, so repeats are expected and harmless. Returns what changed, for
 *  the reply. */
export function addPhoto(batch, nums){
  batch.photos = (batch.photos || 0) + 1;
  return { read: nums.length, added: fold(batch, nums) };
}

/** Numbers the user typed, added like a photo's — but not counted as one. */
export function addTyped(batch, text){
  const nums = numbersIn(text);
  return { found: nums.length, added: fold(batch, nums) };
}

/** The batch as ✅ Send queues it: lowest work-order number first. The inbox
 *  claim keeps this order on the phone's list. The batch itself stays in
 *  reading order, so /list still matches the handheld's screen top to bottom. */
export function sendOrder(batch){
  return [...batch.confirmed].sort((a, b) => Number(a) - Number(b));
}

/** Drop numbers from the batch. Returns how many went. */
export function removeFrom(batch, text){
  let removed = 0;
  for(const n of numbersIn(text)){
    const i = batch.confirmed.indexOf(n);
    if(i !== -1){ batch.confirmed.splice(i, 1); removed++; }
  }
  return removed;
}

// ── orders that left the handheld ───────────────────────────────────────────
// `missing` is queueWorklistOrders' compare result: the installer's pending
// worklist orders that were not in the photos, as { id, workOrderId, address,
// appointmentDate, appointmentTime, waiting }.

/** The removal notice: one line per order, named by what the installer would
 *  recognise (a bare number means little; the address is what they remember).
 *  When half the list or more is missing, it leads with the likelier story —
 *  a photo was missed — because that is the one mistake this could turn into
 *  a wiped worklist. */
export function missingText(missing, pendingCount){
  const n = missing.length;
  const lines = missing.map(m => {
    const appt = [m.appointmentDate, m.appointmentTime].filter(Boolean).join(' ');
    const what = m.waiting ? '(not downloaded yet)' : (m.address || '(no address)');
    return `${m.workOrderId} — ${what}${appt ? ` · appt ${appt}` : ''}`;
  });
  const head = `${n} on your worklist ${n === 1 ? "wasn't" : "weren't"} in these photos:`;
  const warn = pendingCount > 0 && n * 2 >= pendingCount
    ? `⚠ That's ${n} of the ${pendingCount} on your list — did a photo get missed?\n\n` : '';
  return warn + [head, ...lines].join('\n');
}

/** /keep: hold orders back from a pending removal. Returns how many were held. */
export function keepBack(items, text){
  let kept = 0;
  for(const n of numbersIn(text)){
    const i = items.findIndex(m => String(m.workOrderId) === n);
    if(i !== -1){ items.splice(i, 1); kept++; }
  }
  return kept;
}
