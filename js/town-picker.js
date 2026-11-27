// js/town-picker.js — "Which town?": the ⚠ pick-a-town candidates on a map.
//
// An address that matches the same street and number in more than one town is
// parked with `geoAmbig` (js/route.js pickBest) and never auto-picked (owner's
// rule, 2026-11-27, reversing the 2026-11-18 nearest-town auto-pick). The card's
// chips pick in one tap; this sheet is the same pick with the pins on a map, so
// the installer can see WHERE each town's answer is before choosing. The pin
// nearest the crew (`near`, set by pickBest from the Optimize gate centre) is
// highlighted, and the phone's own position is drawn when it has one.
//
// Loaded with a dynamic import() and deliberately NOT in sw.js SHELL — see
// AGENTS.md §"The status pill's activity log" (1): any byte change to sw.js
// re-downloads the whole shell on every phone. A phone that cannot load this
// file keeps the chips and loses only the map. The sheet is built here rather
// than in index.html, so there is no markup contract for a skewed phone to break.
//
// The pure half (nearestIndex, townOptions) is DOM-free so node can test it.

const R = 6371000;
function metres(a, b){
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const ok = p => !!(p && isFinite(p.lat) && isFinite(p.lng));

// Which candidate to highlight. The one pickBest flagged `near` wins: it was
// measured from the same centre the Optimize gate used, so the card's chips, this
// map and "Use nearest town for all" can never disagree. A list saved before the
// flag existed falls back to the phone's position when there is one. -1 = none.
export function nearestIndex(cands, here){
  const list = Array.isArray(cands) ? cands : [];
  const flagged = list.findIndex(c => c && c.near);
  if(flagged >= 0) return flagged;
  if(!ok(here) || list.length < 2) return -1;
  let best = -1, bestM = Infinity;
  list.forEach((c, i) => {
    if(!ok(c)) return;
    const m = metres(c, here);
    if(m < bestM){ bestM = m; best = i; }
  });
  return best;
}

// One row per candidate, in the order given: a letter that matches its pin, the
// label, how far it is, and whether it is the highlighted one. The distance is
// pickBest's `km` when it has one — measured from the Optimize gate centre, which
// is the phone's own GPS unless the phone was more than GEO_RADIUS_KM (240 km)
// from the list — so the figure and the highlight come from one place. Only a
// candidate saved without `km` is measured from the live fix.
export function townOptions(cands, here){
  const list = Array.isArray(cands) ? cands : [];
  const hi = nearestIndex(list, here);
  return list.map((c, i) => {
    const stored = c && c.km != null && c.km !== '' && isFinite(c.km);
    const km = stored ? Number(c.km)
      : (ok(here) && ok(c) ? Math.round(metres(c, here) / 100) / 10 : null);
    return {
      key: String.fromCharCode(65 + i),
      label: String((c && c.label) || ''),
      km,
      nearest: i === hi,
    };
  });
}

function distText(o){
  if(o.km == null) return o.nearest ? 'Nearest you' : '';
  const d = o.km < 10 ? o.km.toFixed(1) : String(Math.round(o.km));
  return `${d} km away${o.nearest ? ' · nearest you' : ''}`;
}

// A best-effort position for the "You" dot: the drive recorder's last fix when
// the caller hands one over, else one quick, coarse fix. Never rejects, and never
// waits long — the sheet is already showing.
function quickFix(maxMs = 6000){
  if(typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null);
  const fix = new Promise(res => navigator.geolocation.getCurrentPosition(
    p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
    () => res(null), { enableHighAccuracy: false, timeout: maxMs, maximumAge: 120000 }));
  return Promise.race([fix, new Promise(res => setTimeout(() => res(null), maxMs + 1000))]);
}

let openSheet = null;

// Show the picker. Resolves with the chosen candidate (one of `cands`, as given)
// or null when cancelled. `title` is the order's own line ("WO 123 · 10 Main St").
export function openTownPicker({ title = '', cands = [], here = null } = {}){
  if(openSheet) openSheet.close(null);
  const list = (cands || []).filter(ok);
  if(!list.length) return Promise.resolve(null);

  return new Promise(resolve => {
    let pos = ok(here) ? here : null;
    let map = null, pins = [], youDot = null;

    const sheet = document.createElement('div');
    sheet.className = 'sheet town-pick';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Which town?');
    sheet.innerHTML = `
      <div class="card">
        <h2>Which town?</h2>
        <p>${escHtml(title)}${title ? ' — ' : ''}this address is in ${list.length} places. Tap the right one.</p>
        <div class="tp-map" style="height:46vh;min-height:220px;border-radius:12px;overflow:hidden"></div>
        <div class="tp-note muted hide"></div>
        <div class="tp-opts"></div>
        <button class="ghost tp-cancel" type="button" style="width:100%;margin-top:12px">Cancel</button>
      </div>`;
    document.body.appendChild(sheet);
    const mapEl = sheet.querySelector('.tp-map');
    const note = sheet.querySelector('.tp-note');
    const optsEl = sheet.querySelector('.tp-opts');

    // Android Back leaves the worklist screen; the sheet must not outlive it.
    const onPop = () => close(null);
    window.addEventListener('popstate', onPop);
    function close(result){
      if(openSheet !== handle) return;
      openSheet = null;
      window.removeEventListener('popstate', onPop);
      try { if(map) map.remove(); } catch {}
      sheet.remove();
      resolve(result);
    }
    const handle = { close };
    openSheet = handle;

    function paintOptions(){
      const rows = townOptions(list, pos);
      optsEl.innerHTML = rows.map((o, i) => `
        <button class="wl-ask-opt tp-opt${o.nearest ? ' tp-near' : ''}" type="button" data-i="${i}">
          <span class="tp-key" aria-hidden="true">${o.key}</span>${escHtml(o.label)}
          ${distText(o) ? `<span class="wl-ask-sub">${escHtml(distText(o))}</span>` : ''}
        </button>`).join('');
      [...optsEl.querySelectorAll('.tp-opt')].forEach(b =>
        b.onclick = () => close(list[Number(b.dataset.i)]));
      return rows;
    }

    function paintMap(rows){
      if(!map) return;
      const Lf = globalThis.L;
      pins.forEach(m => m.remove()); pins = [];
      rows.forEach((o, i) => {
        const c = list[i];
        const icon = Lf.divIcon({
          className: '',
          html: `<div class="tp-pin${o.nearest ? ' tp-pin-near' : ''}">${o.key}</div>`,
          iconSize: o.nearest ? [38, 38] : [30, 30],
          iconAnchor: o.nearest ? [19, 19] : [15, 15],
        });
        const m = Lf.marker([c.lat, c.lng], { icon, zIndexOffset: o.nearest ? 1000 : 0,
          title: o.label, keyboard: false })
          .on('click', () => close(c))
          .addTo(map);
        pins.push(m);
      });
      if(youDot){ youDot.remove(); youDot = null; }
      if(pos){
        youDot = Lf.circleMarker([pos.lat, pos.lng], { radius: 8, weight: 3,
          color: '#fff', fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map)
          .bindTooltip('You', { permanent: true, direction: 'right', offset: [8, 0] });
      }
      const pts = list.map(c => [c.lat, c.lng]);
      if(pos) pts.push([pos.lat, pos.lng]);
      map.fitBounds(pts, { padding: [36, 36], maxZoom: 14 });
    }

    let rows = paintOptions();
    if(typeof globalThis.L === 'undefined' || !globalThis.L.map){
      mapEl.remove();
      note.textContent = 'The map isn’t available on this phone right now — the choices still work.';
      note.classList.remove('hide');
    } else {
      try {
        map = globalThis.L.map(mapEl, { zoomControl: true, attributionControl: true });
        const tiles = globalThis.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '© OpenStreetMap contributors' });
        tiles.on('tileerror', () => {
          note.textContent = 'Map tiles need signal — the pins and choices still work.';
          note.classList.remove('hide');
        });
        tiles.addTo(map);
        paintMap(rows);
        // The sheet was just attached; let it lay out before Leaflet measures it.
        requestAnimationFrame(() => { try { map.invalidateSize(); paintMap(rows); } catch {} });
      } catch(e){
        console.warn('town picker map failed:', e);
        map = null;
        mapEl.remove();
      }
    }

    sheet.querySelector('.tp-cancel').onclick = () => close(null);
    sheet.addEventListener('click', e => { if(e.target === sheet) close(null); });

    if(!pos) quickFix().then(p => {
      if(!p || openSheet !== handle) return;
      pos = p;
      rows = paintOptions();
      try { paintMap(rows); } catch {}
    });
  });
}
