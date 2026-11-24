// ── Address fill-in walkthrough ──────────────────────────────────────────────
// The work app the crew plans from shows GPS pins labelled with nothing but a
// work order number, so a worklist is built from WO#s first and the addresses
// are looked up afterwards, one at a time. Doing that through the list meant
// scrolling down to an order, opening Edit (which paints at the TOP of the
// screen), saving, and scrolling back down — for every order.
//
// This screen walks the orders that need an address one card at a time: the WO#
// big enough to read (tap it to copy for the lookup), the address fields right
// under it, and Back / Skip / Save & next. The queue is SNAPSHOTTED when the
// screen opens, so saving advances but Back still steps into orders already
// filled — a typo is one tap away, not another pass.
//
// On the way out the orders still without an address sink to the bottom of the
// pending group (sinkAddressless), the same place an unroutable stop lands after
// an Optimize: they can't be routed, so they shouldn't sit in the middle of the
// day's sequence.
//
// Pure helpers first (no DOM, no IndexedDB) so `node --test` can cover the queue
// and sink rules; the screen below is the only part that touches the page.
import { $, esc, toast } from './dom.js';
import { isIgnored, isPending } from './route-variants.js';
// Both long-standing exports, so a named import is safe against an older cached
// copy of either module.
import { normalizeStreet } from './roadgraph.js';
import { siteKey } from './route-dwell.js';

// ── address text ────────────────────────────────────────────────────────────
// "6740 Svorn River Shore" → { num:'6740', street:'Svorn River Shore' }.
// Anything that doesn't start with a number is all street (islands, landmarks).
export function splitAddr(address){
  const m = String(address || '').trim().match(/^(\d[\w-]*)\s+(.+)$/);
  return m ? { num: m[1], street: m[2] } : { num: '', street: String(address || '').trim() };
}
export function joinAddr(num, street){
  return [String(num||'').trim(), String(street||'').trim()].filter(Boolean).join(' ');
}

// Shorthand belongs to the NUMBER BOX only, never to arbitrary stored address
// text: old hyphenated civic addresses must not be silently reinterpreted.
// Keeping the detail in unit also keeps it out of geocoding and navigation.
//
// "-Railway Lights" is a unit with NO house number: roadside equipment has no
// civic address, and its Street box holds coordinates ("42.933446,-81.486452",
// which route.js `coordsFromText` pins as typed). A lone "-" clears such a unit.
export function parseAddressInput(num, street, existingUnit = ''){
  const number = String(num || '').trim();
  const bare = number.match(/^-\s*(.*)$/);
  if(bare) return { address: joinAddr('', street), unit: bare[1].trim() };
  const m = number.match(/^(\d\w*)\s*-\s*(\S.*)$/);
  return {
    address: joinAddr(m ? m[1] : number, street),
    unit: m ? m[2].trim() : (number ? '' : String(existingUnit || '').trim()),
  };
}
export function addressFields(item){
  const a = splitAddr(item && item.address);
  // A legacy civic number may itself contain a hyphen. Keep that whole address
  // in Street so an untouched Save cannot reinterpret it as newly typed units.
  if(a.num.includes('-')) return { num:'', street:String(item.address || '').trim() };
  const unit = String((item && item.unit) || '').trim();
  // No house number: the unit still shows, as "-unit", so it can be read and
  // edited, and an untouched Save gives back the same address and unit.
  return { num: unit ? `${a.num}-${unit}` : a.num, street: a.street };
}

// ── the address a lookup found ──────────────────────────────────────────────
// A geocoder's answer is a comma list: "123 Main St, Glencoe, ON N0L 1M0,
// Canada" from Google, "8583 Falconbridge Dr, Strathroy-Caradoc" from the
// district index, "123, Main Street, Glencoe, …" from Nominatim. These read the
// street and the town out of one without caring which it was.
const DIRECTION_WORDS = new Set(['north', 'south', 'east', 'west',
  'northeast', 'northwest', 'southeast', 'southwest']);
// The segment after the street is the town unless it is the province, the
// postal code or the country — "ON N0L 1M0", "Ontario", "Canada".
function townOf(segment){
  const t = String(segment || '').trim();
  return (!t || /\d/.test(t) || /^(on|ontario|canada)$/i.test(t)) ? '' : t;
}

/** The typed address rewritten with what a lookup found: the found street
 *  spelling and town, and the TYPED house number — a pin placed on an estimate
 *  reverse-geocodes to the neighbour's number, and the number on the order is
 *  the one that was ordered. Null when the lookup is for another street, or has
 *  no town to add: the order is then left exactly as typed.
 *
 *  A town already on the typed address — after a comma, or just typed on the
 *  end — is replaced. "King St W" against "King St" is NOT a match: those can be
 *  two different roads, and dropping the W would move the order. */
export function foundAddress(typed, found){
  const head = splitAddr(String(typed || '').split(',')[0]);
  const want = normalizeStreet(head.street);
  if(!head.num || !want) return null;
  const hasComma = String(typed).includes(',');
  const parts = String(found || '').split(',').map(s => s.trim());
  for(let i = 0; i < parts.length; i++){
    const street = splitAddr(parts[i]).street;
    const got = normalizeStreet(street);
    if(!got) continue;
    let same = got === want;
    if(!same && !hasComma && want.startsWith(got + ' ')){
      // The rest of the typed street is a town with no comma before it.
      const rest = want.slice(got.length + 1).split(' ');
      same = !rest.some(w => DIRECTION_WORDS.has(w));
    }
    if(!same) continue;
    const town = townOf(parts[i + 1]);
    return town ? `${head.num} ${street}, ${town}` : null;
  }
  return null;
}

/** The address nearest a typed coordinate, from a reverse lookup: the first
 *  part that is a civic address ("1234 Glendon Dr"), else a bare road, plus its
 *  town. Null for a plus code or a town on its own — nothing worth writing over
 *  the coordinates. */
export function nearestAddress(found){
  const parts = String(found || '').split(',').map(s => s.trim());
  const at = parts.findIndex(p => splitAddr(p).num);
  if(at >= 0) return [parts[at], townOf(parts[at + 1])].filter(Boolean).join(', ');
  const road = parts[0];
  if(!road || road.includes('+') || !/[a-z]/i.test(road)) return null;
  const town = townOf(parts[1]);
  return town ? `${road}, ${town}` : null;
}

/** What "Clear map pins" writes onto one order, or null to leave it alone.
 *
 *  Clearing the pin is not enough on its own. After an Optimize the app writes
 *  the pin's town onto the address (worklist.js confirmFoundAddresses), so an
 *  order pinned in the wrong town now SAYS the wrong town, and the next lookup
 *  would read that and find the same wrong place (field report 2026-11-23:
 *  "6 York St, Delaware" pinned in London became "6 York St, London").
 *
 *  So the address goes back too, to `typedAddress`: the text as it stood before
 *  the app wrote a town over it (kept by confirmFoundAddresses, phone-only).
 *
 *  THE TOWN IS NEVER TAKEN OFF AN ADDRESS HERE. Two rules follow from that:
 *    - with no typed copy (an order rewritten before 2026-11-23, or downloaded
 *      onto another phone) the address is left as it is;
 *    - a typed copy that is only the number and street is not put back either.
 *      It has no town to give, and putting it back removes the one the address
 *      has.
 *  The first version did take the town off, so the next lookup would choose the
 *  street nearest the phone. It was undone the same evening: the owner cleared
 *  85 pins from London, "95 Wellington St, Delaware" became "95 Wellington St"
 *  and was pinned in London, and "33 Caverhill Cres, Middlesex Centre" in
 *  Milton. Nearly every town on a list is right; the few that are not have to
 *  be retyped. The owner plans from London, so "nearest the phone" is not a
 *  safe way to choose a town for an order that already names one.
 *  The caller skips logged orders and pins typed as coordinates. */
export function clearedPin(order){
  if(!order) return null;
  const has = v => v != null && v !== '';
  const pinned = has(order.lat) && has(order.lng);
  const parked = !!(order.geoFail || (order.geoAmbig && order.geoAmbig.length));
  if(!pinned && !parked) return null;
  const current = String(order.address || '').trim();
  const typed = pinned ? String(order.typedAddress || '').trim() : '';
  // normalizeStreet, not a string compare: the lookup spells "Cres" out.
  const bare = normalizeStreet(typed) === normalizeStreet(current.split(',')[0]);
  const address = (typed && !bare) ? typed : current;
  return { address, lat: undefined, lng: undefined, geoFail: undefined, geoAmbig: undefined,
    geoLabel: undefined, geoSource: undefined, typedAddress: undefined };
}

/** Same house number and street, whatever the town or the spelling of "Rd".
 *  The Log screen's planned-vs-GPS chooser asks only when this is false: the
 *  offline map names the municipality and Google names the community, and that
 *  difference fired the chooser on every town-picked order (2026-11-19). */
export function addressesAgree(a, b){
  const ka = siteKey(a);
  return !!ka && ka === siteKey(b);
}
export function formatOrderAddress(item){
  const address = String((item && item.address) || '').trim();
  const unit = String((item && item.unit) || '').trim();
  return [address, unit ? `Unit ${unit}` : ''].filter(Boolean).join(' · ');
}

/** The distinct streets already on the list, most recently added first. Feeds
 *  the one-tap chips on both the Edit form and this screen. */
export function recentStreets(items, limit = 6){
  const seen = {}, streets = [];
  (items || []).slice().reverse().forEach(x => {
    const st = splitAddr(x && x.address).street;
    if(st && !seen[st.toLowerCase()]){ seen[st.toLowerCase()] = 1; streets.push(st); }
  });
  return streets.slice(0, limit);
}

// ── which orders need attention ─────────────────────────────────────────────
/** No address typed at all (and not already done) — the SINK rule. An order
 *  that has an address the geocoder disliked still has a place in the route. */
export function hasNoAddress(item){
  return !!item && item.wlStatus !== 'done' && !String(item.address || '').trim();
}
/** In the walkthrough queue: no address, or one that wouldn't map (📍 geoFail)
 *  or matched several towns (⚠ geoAmbig). Set-aside orders are included — they
 *  are still real work, just out of today's route. */
export function needsAddressFix(item){
  if(!item || item.wlStatus === 'done') return false;
  return hasNoAddress(item)
    || !!item.geoFail
    || !!(item.geoAmbig && item.geoAmbig.length);
}
/** The snapshot the screen walks, in the list's own order. */
export function addressQueue(items){
  return (items || []).filter(needsAddressFix);
}

/** Why this order is in the queue — the one-line note above the fields. */
export function fixReason(item){
  if(hasNoAddress(item)) return 'No address yet — look up the WO# and type it in.';
  if(item && item.geoAmbig && item.geoAmbig.length)
    return `Matches ${item.geoAmbig.length} places — pick the right one below, or make the address more specific.`;
  if(item && item.geoFail) return 'This address didn’t map — check the spelling or add the town.';
  return '';
}

/** The note above the fields for an order whose pin another address also sits
 *  on. `mates` are the orders on that pin (the order itself may be among them).
 *  Retyping the same address gets the same pin back, because it is the same
 *  lookup. So the note says what does move the pin: a corrected number or
 *  street, or the spot's own coordinates. */
export function sharedPinReason(item, mates){
  const names = [...new Set((mates || [])
    .filter(x => x && String(x.id) !== String(item && item.id))
    .map(x => String(x.address || '').split(',')[0].trim()).filter(Boolean))];
  if(!names.length) return '';
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const list = more ? `${shown.join(', ')} and ${more} more`
    : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return `The map put this on the same spot as ${list}, and only one address can be there. `
    + 'If the number or street is wrong, correct it. If it is right, empty the No. box and '
    + 'put the coordinates of the spot (copied from a maps app) in the Street box.';
}

/** The id order to persist when the walkthrough closes: pending orders WITH an
 *  address (relative order untouched), then the ones still without, then done,
 *  then set-aside. Callers hand this to the worklist's own order writer, so
 *  locks and appointments are still honoured. */
export function sinkAddressless(items){
  const list = items || [];
  const withAddr = [], without = [];
  for(const x of list.filter(isPending)) (hasNoAddress(x) ? without : withAddr).push(x);
  const done    = list.filter(x => x.wlStatus === 'done');
  const ignored = list.filter(x => x.wlStatus !== 'done' && isIgnored(x));
  return [...withAddr, ...without, ...done, ...ignored].map(x => String(x.id));
}

// ── the screen ──────────────────────────────────────────────────────────────
// Callback-shaped like initWorklistRouteView so the two sub-screens stay
// decoupled from worklist.js: it owns IndexedDB and rendering, we own this DOM.
//   getItems()            → the sorted worklist items
//   saveAddress(id, addr, unit) → persist one address + optional unit
//   supportsUnits        → caller can persist that third argument (cache skew)
//   pickTown(item, cand, unit) → town pin + optional edited unit
//   onDone()              → sink + re-render, run once per visit
//   onClose()             → leave the screen (history-aware)
export function initWorklistAddressFill(opts){
  let queue = [];        // ids, snapshotted on open
  let idx = 0;
  let open_ = false;
  let notes = {};        // id → why it is here, for a queue the caller picked
  // A queue the caller picked is a REVIEW: looking and leaving must change nothing.
  // onDone re-writes the list order (and, with a locked stop, the schedule), which is
  // right after addresses were filled in and wrong after nothing was touched.
  let review = false, touched = false;
  let pinsAtOpen = {};   // id → "lat,lng" when the screen opened; a note is about that pin
  const pinKey = x => (x && x.lat != null && x.lat !== '' && x.lng != null && x.lng !== '')
    ? `${x.lat},${x.lng}` : '';
  const numInput = $('wlAddrNum');
  if(numInput) numInput.inputMode = 'text';  // also works against older HTML
  // A second Save under Back/Skip, beside the header one. Older HTML lacks it,
  // and it ships hidden so older JS never shows a button nothing is bound to.
  const saveBottom = $('wlAddrSaveBottom');
  if(saveBottom){ saveBottom.classList.remove('hide'); saveBottom.onclick = save; }

  function isOpen(){ return open_; }

  // `pick` (optional) is a queue the caller chose: the route map hands over the
  // orders its warning is about, which the default queue would leave out — an
  // order sharing a pin has an address and no flag. { ids, notes, startId, back }.
  // Without it the screen is the fill-in walkthrough it has always been.
  async function open(pick){
    const items = await opts.getItems();
    const picked = !!(pick && Array.isArray(pick.ids));
    review = picked; touched = false;
    if(picked){
      const live = new Set(items.filter(x => x.wlStatus !== 'done').map(x => String(x.id)));
      queue = pick.ids.map(String).filter(id => live.has(id));
      notes = pick.notes || {};
    } else {
      queue = addressQueue(items).map(x => String(x.id));
      notes = {};
    }
    pinsAtOpen = {};
    for(const x of items) pinsAtOpen[String(x.id)] = pinKey(x);
    if(!queue.length){ toast(picked ? 'Nothing left to check ✓' : 'Every order has an address ✓'); return false; }
    idx = picked ? Math.max(0, queue.indexOf(String(pick.startId))) : 0;
    // The heading has no id, so it is found by shape and left alone when an older
    // index.html has something else there.
    const title = $('wlAddrScreen').querySelector('h2');
    if(title) title.textContent = picked ? 'Check addresses' : 'Fill in addresses';
    const to = (picked && pick.back) || 'Worklist';
    $('wlAddrBack').textContent = `‹ ${to}`;
    $('wlAddrBack').setAttribute('aria-label', `Back to ${to.toLowerCase()}`);
    open_ = true;
    $('wlAddrScreen').classList.remove('hide');
    await paint();
    window.scrollTo(0, 0);
    return true;
  }

  // Idempotent, and the ONLY exit: the button, Finish, and a hardware Back
  // (worklist.js calls close() from its popstate handler) all land here, so the
  // sink runs exactly once however the installer leaves.
  async function close(){
    if(!open_) return;
    open_ = false;
    $('wlAddrScreen').classList.add('hide');
    if(review && !touched) return;
    await opts.onDone();
  }

  async function current(){
    const items = await opts.getItems();
    const byId = new Map(items.map(x => [String(x.id), x]));
    return byId.get(String(queue[idx])) || null;
  }

  // A picked order's note is about the PIN it had when the screen opened. Once a
  // Save has changed the address that pin is gone (or, for typed coordinates,
  // replaced), the note is no longer true, and it gives way to what happens next.
  function reasonFor(item){
    const flagged = fixReason(item);
    if(flagged) return flagged;
    const note = notes[String(item.id)];
    if(!note) return '';
    const now = pinKey(item);
    if(now && now === pinsAtOpen[String(item.id)]) return note;
    return now ? 'Saved. The pin is now at the coordinates you typed.'
      : 'Saved. This order has no pin now. Tap Optimize on the worklist to look it up again.';
  }

  async function paint(){
    const item = await current();
    // The order was deleted from another screen mid-walk — drop it and move on.
    if(!item){
      queue.splice(idx, 1);
      if(!queue.length){ await finish(); return; }
      if(idx >= queue.length) idx = queue.length - 1;
      await paint();
      return;
    }
    const last = idx === queue.length - 1;
    $('wlAddrCount').textContent = `${idx + 1} of ${queue.length}`;
    $('wlAddrBar').style.width = `${Math.round(((idx + 1) / queue.length) * 100)}%`;
    $('wlAddrWo').textContent = item.workOrderId ? `WO ${item.workOrderId}` : '(no WO#)';
    $('wlAddrWo').disabled = !item.workOrderId;
    $('wlAddrOldJ').textContent = item.oldJNumber ? `old J# ${item.oldJNumber}` : '';
    $('wlAddrReason').textContent = reasonFor(item);
    const a = opts.supportsUnits ? addressFields(item) : splitAddr(item.address);
    $('wlAddrNum').value = a.num;
    $('wlAddrStreet').value = a.street;
    $('wlAddrPrev').disabled = idx === 0;
    $('wlAddrSkip').textContent = last ? 'Finish ✓' : 'Skip ›';
    $('wlAddrSave').textContent = last ? 'Save & finish' : 'Save & next';
    if(saveBottom) saveBottom.textContent = $('wlAddrSave').textContent;
    paintChips(await opts.getItems());
    paintTowns(item);
    $('wlAddrNum').focus();
  }

  function paintChips(items){
    const box = $('wlAddrChips');
    // Every distinct street, not the Edit form's 6: a list built from WO#s alone is
    // filled in street by street, and a 7th street would otherwise be retyped every
    // order. The box scrolls past ~3 rows (css) so the fields stay above the keyboard.
    const streets = recentStreets(items, Infinity);
    if(!streets.length){ box.classList.add('hide'); box.innerHTML = ''; return; }
    box.classList.remove('hide');
    box.innerHTML = streets.map(st => `<button class="chip" type="button">${esc(st)}</button>`).join('');
    box.scrollTop = 0;  // most recent first, so a new order starts at the top
    [...box.children].forEach((b, i) => b.onclick = () => {
      $('wlAddrStreet').value = streets[i];
      $('wlAddrNum').focus();
    });
  }

  // The same one-tap town pick the card offers, so an ambiguous order is fixed
  // without leaving the walkthrough.
  function paintTowns(item){
    const box = $('wlAddrTowns'), hint = $('wlAddrTownHint');
    const cands = (item.geoAmbig && item.geoAmbig.length) ? item.geoAmbig : null;
    if(!cands){ box.classList.add('hide'); box.innerHTML = ''; hint.classList.add('hide'); return; }
    box.classList.remove('hide'); hint.classList.remove('hide');
    box.innerHTML = cands.map(c => `<button class="chip" type="button">${esc(c.label)}</button>`).join('');
    [...box.children].forEach((b, i) => b.onclick = async () => {
      const unit = opts.supportsUnits
        ? parseAddressInput($('wlAddrNum').value, $('wlAddrStreet').value, item.unit).unit
        : undefined;
      let candidate = cands[i];
      if(!opts.supportsUnits){
        // Old callers cannot store unit separately. Like the Save fallback,
        // keep typed shorthand in their address while retaining the chosen town.
        const a = splitAddr(candidate.label);
        const num = $('wlAddrNum').value.trim().replace(/\s*-\s*/, '-');
        if(/^\d\w*-\S/.test(num)) candidate = { ...candidate,
          label:a.num && num.startsWith(a.num + '-')
            ? joinAddr(num, a.street) : `${candidate.label} (${num})` };
      }
      touched = true;
      await opts.pickTown(item, candidate, unit);
      await step(1);
    });
  }

  async function step(delta){
    const next = idx + delta;
    if(next < 0) return;
    if(next >= queue.length){ await finish(); return; }
    idx = next;
    await paint();
  }

  async function finish(){
    await close();
    await opts.onClose();
  }

  async function save(){
    const item = await current();
    if(!item) { await step(1); return; }
    // An older cached worklist ignores a third argument. Keep its raw shorthand
    // intact instead of splitting a unit that caller would silently discard.
    const { address, unit } = opts.supportsUnits
      ? parseAddressInput($('wlAddrNum').value, $('wlAddrStreet').value, item.unit)
      : { address: joinAddr($('wlAddrNum').value, $('wlAddrStreet').value) };
    if(!address){ toast('Enter an address, or tap Skip'); return; }
    // Save & next is also how a review is stepped through, so only a real edit counts.
    if(address !== String(item.address || '')
      || (unit !== undefined && unit !== String(item.unit || ''))) touched = true;
    await opts.saveAddress(item.id, address, unit);
    await step(1);
  }

  $('wlAddrBack').onclick = finish;
  $('wlAddrPrev').onclick = () => step(-1);
  $('wlAddrSkip').onclick = () => step(1);
  $('wlAddrSave').onclick = save;
  // Tap the WO# to copy it: the number is what the installer pastes into the
  // work app's search to find the address in the first place.
  $('wlAddrWo').onclick = async () => {
    const item = await current();
    const wo = item && item.workOrderId;
    if(!wo || !navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(String(wo)).catch(() => {});
    toast('WO# copied ✓');
  };

  return { open, close, isOpen };
}
