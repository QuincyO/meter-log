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

/** A fresh batch: the numbers that ✅ Send will queue. */
export function newBatch(){ return { confirmed: [] }; }

/** Fold one photo's numbers into the batch. The scrolled photos of one list
 *  overlap, so repeats are expected and harmless. Returns what changed, for
 *  the reply. */
export function addPhoto(batch, nums){
  let added = 0;
  for(const n of nums){
    if(batch.confirmed.includes(n)) continue;
    batch.confirmed.push(n); added++;
  }
  return { read: nums.length, added };
}

/** Numbers the user typed, added like a photo's. */
export function addTyped(batch, text){
  const nums = numbersIn(text);
  return { found: nums.length, added: addPhoto(batch, nums).added };
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
