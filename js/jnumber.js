// ── J# scan normalization ───────────────────────────────────────────────────
// The crew captures Old/New J# by scanning a barcode; the phone's scanner is a
// keyboard wedge that types straight into the focused field, so a second scan
// APPENDS to the first. A J# is always `J` + exactly 7 digits (e.g. J1234567).
//
// One stateless rule, applied on every input, gives the crew everything they
// asked for — no button, no popup:
//   uppercase, anchor on the LAST `J`, keep `J` + up to 7 digits after it.
//
//   • wrong barcode (no valid J#)  → ''            → field wipes itself
//   • re-scan onto a wrong value   → newest J wins  → replace, never append
//     ("J1234567J7654321" → "J7654321", because the fresh scan's J is last)
//   • correct scan / manual type   → "j1234567" → "J1234567"; a partial "J12"
//     is a valid prefix and is left alone as they type.
//
// Pure and DOM-free so it drops into the repo's node --test suite.
export function normalizeJScan(raw){
  const s = String(raw ?? '').toUpperCase();
  const j = s.lastIndexOf('J');
  if(j === -1) return '';
  let digits = '';
  for(let i = j + 1; i < s.length && digits.length < 7; i++){
    const c = s[i];
    if(c >= '0' && c <= '9') digits += c; else break;
  }
  return 'J' + digits;
}

// A complete, well-formed J# — `J` + exactly 7 digits. For any caller that
// wants to distinguish a finished scan from an in-progress prefix.
export const isCompleteJ = v => /^J\d{7}$/.test(v);
