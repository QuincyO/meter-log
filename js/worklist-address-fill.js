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
//   saveAddress(id, addr) → persist one address
//   pickTown(item, cand)  → the existing one-tap town pin
//   onDone()              → sink + re-render, run once per visit
//   onClose()             → leave the screen (history-aware)
export function initWorklistAddressFill(opts){
  let queue = [];        // ids, snapshotted on open
  let idx = 0;
  let open_ = false;

  function isOpen(){ return open_; }

  async function open(){
    const items = await opts.getItems();
    queue = addressQueue(items).map(x => String(x.id));
    if(!queue.length){ toast('Every order has an address ✓'); return false; }
    idx = 0;
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
    await opts.onDone();
  }

  async function current(){
    const items = await opts.getItems();
    const byId = new Map(items.map(x => [String(x.id), x]));
    return byId.get(String(queue[idx])) || null;
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
    $('wlAddrReason').textContent = fixReason(item);
    const a = splitAddr(item.address);
    $('wlAddrNum').value = a.num;
    $('wlAddrStreet').value = a.street;
    $('wlAddrPrev').disabled = idx === 0;
    $('wlAddrSkip').textContent = last ? 'Finish ✓' : 'Skip ›';
    $('wlAddrSave').textContent = last ? 'Save & finish' : 'Save & next';
    paintChips(await opts.getItems());
    paintTowns(item);
    $('wlAddrNum').focus();
  }

  function paintChips(items){
    const box = $('wlAddrChips');
    const streets = recentStreets(items);
    if(!streets.length){ box.classList.add('hide'); box.innerHTML = ''; return; }
    box.classList.remove('hide');
    box.innerHTML = streets.map(st => `<button class="chip" type="button">${esc(st)}</button>`).join('');
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
      await opts.pickTown(item, cands[i]);
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
    const address = joinAddr($('wlAddrNum').value, $('wlAddrStreet').value);
    if(!address){ toast('Enter an address, or tap Skip'); return; }
    await opts.saveAddress(item.id, address);
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
