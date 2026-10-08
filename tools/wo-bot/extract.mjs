// ── Work-order numbers out of photo text — the pure half of the photo bot ────
// Two engines read every photo (Windows OCR and a local vision model, see
// ocr.mjs). They fail differently: OCR mangles a digit under glare or at an
// angle, a vision model can invent a plausible one. So a number BOTH report is
// trusted, and a number only one reports is held back for the user to confirm.
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

/** The six-digit numbers in one engine's text, top to bottom, de-duplicated. */
export function numbersIn(text){
  const out = [], seen = new Set();
  const push = n => { if(!seen.has(n)){ seen.add(n); out.push(n); } };
  for(const raw of String(text == null ? '' : text).split(/\r?\n/)){
    const line = raw.replace(LIST_MARKER, '');
    // A line that is nothing but digits split by spaces ("902 732") is one number
    // OCR broke apart; anything with letters in it is left to the token match.
    const squeezed = line.replace(/\s+/g, '');
    if(ONLY_DIGITS.test(squeezed)){ push(squeezed); continue; }
    for(const m of line.matchAll(WO_IN_LINE)) push(m[0]);
  }
  return out;
}

/** Combine the two engines' lists for one photo. Either may be null (that engine
 *  failed or is off) — then nothing is "agreed" and the other's numbers all need
 *  confirming. Order follows the OCR list (it reads top to bottom by position),
 *  then anything only the vision model saw. */
export function mergeEngines(ocr, vlm){
  const a = ocr || [], b = vlm || [];
  const inB = new Set(b), inA = new Set(a);
  const agreed = (ocr && vlm) ? a.filter(n => inB.has(n)) : [];
  const onlyOcr = vlm ? a.filter(n => !inB.has(n)) : a.slice();
  const onlyVlm = ocr ? b.filter(n => !inA.has(n)) : b.slice();
  return { agreed, unsure: onlyOcr.concat(onlyVlm.filter(n => !onlyOcr.includes(n))) };
}

/** A fresh batch: `confirmed` will be sent, `unsure` waits for the user. */
export function newBatch(){ return { confirmed: [], unsure: [] }; }

/** Fold one photo's merge into the batch. The scrolled photos of one list
 *  overlap, so repeats are expected and harmless; a number one photo was unsure
 *  about is promoted when a later photo's engines agree on it. Returns what
 *  changed, for the reply. */
export function addPhoto(batch, merged){
  let added = 0, promoted = 0, unsure = 0;
  for(const n of merged.agreed){
    if(batch.confirmed.includes(n)) continue;
    const i = batch.unsure.indexOf(n);
    if(i !== -1){ batch.unsure.splice(i, 1); promoted++; }
    else added++;
    batch.confirmed.push(n);
  }
  for(const n of merged.unsure){
    if(batch.confirmed.includes(n) || batch.unsure.includes(n)) continue;
    batch.unsure.push(n); unsure++;
  }
  return { read: merged.agreed.length + merged.unsure.length, added, promoted, unsure };
}

/** Numbers the user typed: they are the authority, so straight to confirmed. */
export function addTyped(batch, text){
  const nums = numbersIn(text);
  let added = 0;
  for(const n of nums){
    const i = batch.unsure.indexOf(n);
    if(i !== -1) batch.unsure.splice(i, 1);
    if(!batch.confirmed.includes(n)){ batch.confirmed.push(n); added++; }
  }
  return { found: nums.length, added };
}

/** Drop numbers from the batch, wherever they sit. Returns how many went. */
export function removeFrom(batch, text){
  let removed = 0;
  for(const n of numbersIn(text)){
    for(const list of [batch.confirmed, batch.unsure]){
      const i = list.indexOf(n);
      if(i !== -1){ list.splice(i, 1); removed++; }
    }
  }
  return removed;
}
