// ── District geometry: which pack covers a run, and how two areas combine ────
// Pure and DOM-free, like js/route-variants.js and js/drive-track.js, because
// both ends of the offline-map story need the same arithmetic:
//
//   * the phone, choosing which downloaded district to route a run on
//     (js/roadpack.js `loadGraph`), and
//   * the desktop planner, working out the area a *grown* district has to cover
//     when a second rectangle is drawn over an existing one (js/pages/planner.js).
//
// Everything here works on plain `{minLat,minLng,maxLat,maxLng}` boxes and
// `{lat,lng}` points — no graph, no pack bytes, no DOM. Unit-tested in
// tests/districts.test.mjs.

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : NaN;

export function validBbox(b){
  if(!b) return null;
  const minLat = num(b.minLat), minLng = num(b.minLng),
        maxLat = num(b.maxLat), maxLng = num(b.maxLng);
  if([minLat, minLng, maxLat, maxLng].some(Number.isNaN)) return null;
  if(minLat > maxLat || minLng > maxLng) return null;
  return { minLat, minLng, maxLat, maxLng };
}

// Inclusive, and deliberately the same test `packCovers` applies to a decoded
// pack — this one just runs off the descriptor, so it costs no decode.
export function bboxHas(bbox, coord){
  const b = validBbox(bbox);
  if(!b || !coord) return false;
  const lat = num(coord.lat), lng = num(coord.lng);
  if(Number.isNaN(lat) || Number.isNaN(lng)) return false;
  return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

export function unionBbox(a, b){
  const x = validBbox(a), y = validBbox(b);
  if(!x) return y;
  if(!y) return x;
  return {
    minLat: Math.min(x.minLat, y.minLat), minLng: Math.min(x.minLng, y.minLng),
    maxLat: Math.max(x.maxLat, y.maxLat), maxLng: Math.max(x.maxLng, y.maxLng),
  };
}

// Degrees², which is not an area anybody should quote — it is only ever
// compared against another box at the same latitude, where the cos(lat)
// distortion cancels out.
export function bboxArea(b){
  const x = validBbox(b);
  return x ? (x.maxLat - x.minLat) * (x.maxLng - x.minLng) : 0;
}

function intersectionArea(a, b){
  const x = validBbox(a), y = validBbox(b);
  if(!x || !y) return 0;
  const lat = Math.min(x.maxLat, y.maxLat) - Math.max(x.minLat, y.minLat);
  const lng = Math.min(x.maxLng, y.maxLng) - Math.max(x.minLng, y.minLng);
  return (lat > 0 && lng > 0) ? lat * lng : 0;
}

// How much dead space growing `a` by `b` would buy. A district is one
// rectangle, so extending it means clipping the whole bounding box of the two —
// which for adjacent areas is nearly free (≈1) and for two areas on opposite
// corners of the province is mostly empty land the crew will never drive.
// 1 means no waste; 2 means the rebuild would clip twice the ground it needs.
export function unionWaste(a, b){
  const x = validBbox(a), y = validBbox(b);
  if(!x || !y) return 1;
  const wanted = bboxArea(x) + bboxArea(y) - intersectionArea(x, y);
  if(!(wanted > 0)) return 1;
  return bboxArea(unionBbox(x, y)) / wanted;
}

export const SPARSE_UNION = 2;
export const isSparseUnion = (a, b) => unionWaste(a, b) > SPARSE_UNION;

// Which installed district to route this run on.
//
// Scored on the pack DESCRIPTORS (id + bbox), never on decoded graphs: the
// point is to decode exactly one district, so the choice has to be made before
// any of them are read. Most stops inside the box wins.
//
// `preferredId` — the district the installer picked in Settings — breaks ties
// and carries the whole decision when the run tells us nothing (no coordinates
// yet, or every stop outside every district). That last case matters: it is the
// "my pins aren't geocoded yet" path, and falling through to *some* pack keeps
// today's behaviour instead of silently dropping to straight-line.
export function pickPack(packs, coords, preferredId = ''){
  const list = (packs || []).filter(p => p && p.id);
  if(!list.length) return '';
  const fallback = list.some(p => p.id === preferredId) ? preferredId : list[0].id;
  const pts = (coords || []).filter(c => c && Number.isFinite(c.lat) && Number.isFinite(c.lng));
  if(!pts.length) return fallback;

  let bestId = '', best = 0;
  for(const p of list){
    let hits = 0;
    for(const c of pts) if(bboxHas(p.bbox, c)) hits++;
    // Strictly greater, so the first pack listed wins a tie — except that the
    // preferred one is checked against the leader below, which is the tie rule
    // that actually matters to an installer who chose a district by hand.
    if(hits > best){ best = hits; bestId = p.id; }
    else if(hits === best && hits > 0 && p.id === preferredId) bestId = p.id;
  }
  return best > 0 ? bestId : fallback;
}
