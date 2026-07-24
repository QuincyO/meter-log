// Drive-mode track model — the pure, DOM-free core of the driving-leg recorder.
//
// A "segment" is one driving leg: everything recorded while the Drive screen is
// in front, from open to close. The runtime (js/drive.js) feeds GPS fixes in via
// addFix(), brackets background gaps with markPause()/markResume() (the phone
// loses GPS while the PWA is backgrounded — e.g. during a Google-Maps hand-off),
// and calls finalizeSegment() on the way out to build the row that ships to the
// Sheet. All of that lives here, with no navigator/DOM references, so it unit
// tests as plain data in / data out (tests/drive-track.test.mjs).
//
// The office reads the leg back with decodeTrack() to replay it on the map; the
// gap anchors let the desktop planner road-route the missing stretch via OSRM.

// Fix filter — drop a new fix that is both < MIN_MOVE_M metres and < MIN_GAP_S
// seconds from the last kept point. Cuts GPS jitter and keeps the polyline
// compact (the battery/storage dial). A real move OR enough elapsed time keeps it.
export const MIN_MOVE_M = 15;
export const MIN_GAP_S = 3;

// A fix at or below this speed (m/s ≈ 1 mph) counts its interval as idle —
// stopped at a light, parked, crawling. Used by segmentSummary()'s idle tally.
export const IDLE_SPEED_MS = 0.5;

// Safety cap on points per leg so a single row never approaches the Sheet's
// 50k-char/cell limit (~12 chars/point encoded ⇒ ~42k chars). Island legs are
// short, so this is a guard, not a norm; the runtime finalizes + starts a fresh
// segment when a leg reaches it.
export const MAX_POINTS = 3500;

const R = 6371000; // Earth radius, metres

export function haversineM(a, b){
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── Compact encoding ──────────────────────────────────────────────────────
// One string, four interleaved varint streams per point: Δlat, Δlng, Δt, Δspd,
// each zig-zag + base-64-offset encoded exactly like Google's polyline algorithm.
// lat/lng are scaled ×1e5 (~1 m), t is seconds RELATIVE to the leg start (so the
// value never overflows the 32-bit zig-zag shift — epoch ms would), spd is
// 0.1 m/s. decodeTrack() rebases time onto an absolute start if one is given.

function encSigned(num){
  let v = num < 0 ? ~(num << 1) : (num << 1);
  let out = '';
  while(v >= 0x20){ out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v = Math.floor(v / 32); }
  out += String.fromCharCode(v + 63);
  return out;
}

function decodeAll(str){
  const nums = [];
  let i = 0;
  while(i < str.length){
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result += (b & 0x1f) * Math.pow(2, shift); shift += 5; }
    while(b >= 0x20 && i < str.length);
    nums.push((result % 2) ? -(result + 1) / 2 : result / 2);
  }
  return nums;
}

export function encodeTrack(points){
  const pts = points || [];
  if(!pts.length) return '';
  const baseT = pts[0].t;
  let lat = 0, lng = 0, t = 0, spd = 0, out = '';
  for(const p of pts){
    const iLat = Math.round(p.lat * 1e5);
    const iLng = Math.round(p.lng * 1e5);
    const iT   = Math.round((p.t - baseT) / 1000);
    const iSpd = Math.round((p.spd || 0) * 10);
    out += encSigned(iLat - lat) + encSigned(iLng - lng) + encSigned(iT - t) + encSigned(iSpd - spd);
    lat = iLat; lng = iLng; t = iT; spd = iSpd;
  }
  return out;
}

// decodeTrack(encoded, baseT) → [{lat, lng, t, spd}]. `baseT` (epoch ms) rebases
// the relative timestamps; omit it and t comes back as ms-since-leg-start.
export function decodeTrack(str, baseT = 0){
  const nums = decodeAll(str || '');
  const pts = [];
  let lat = 0, lng = 0, t = 0, spd = 0;
  for(let i = 0; i + 3 < nums.length; i += 4){
    lat += nums[i]; lng += nums[i + 1]; t += nums[i + 2]; spd += nums[i + 3];
    pts.push({ lat: +(lat / 1e5).toFixed(5), lng: +(lng / 1e5).toFixed(5), t: baseT + t * 1000, spd: spd / 10 });
  }
  return pts;
}

// ── Segment state machine ─────────────────────────────────────────────────
export function createSegment({ id, installer, date, workType } = {}){
  return { id, installer: installer || '', date: date || '', workType: workType || '',
    points: [], gaps: [], pendingPause: null };
}

// Append a GPS fix {lat, lng, t, spd?}. Returns true if kept, false if filtered.
// Speed comes from the device (coords.speed, m/s) when present, else is derived
// from the move since the last kept point.
export function addFix(seg, fix){
  const pts = seg.points;
  if(pts.length >= MAX_POINTS) return false;
  const prev = pts[pts.length - 1];
  let spd = (typeof fix.spd === 'number' && fix.spd >= 0) ? fix.spd : null;
  if(prev){
    const d = haversineM(prev, fix);
    const dt = (fix.t - prev.t) / 1000;
    if(d < MIN_MOVE_M && dt < MIN_GAP_S) return false;
    if(spd == null) spd = dt > 0 ? d / dt : 0;
  } else if(spd == null){
    spd = 0;
  }
  pts.push({ lat: fix.lat, lng: fix.lng, t: fix.t, spd: Math.max(0, spd) });
  return true;
}

// The page went to the background — bracket the gap on the last known point.
export function markPause(seg){
  const last = seg.points[seg.points.length - 1];
  if(last) seg.pendingPause = { pauseLat: last.lat, pauseLng: last.lng, pauseT: last.t };
}

// The page came back — close the open gap with the first fresh fix and resume.
// The resume point is recorded with a `gap` flag and its own (not cross-gap
// derived) speed, so segmentSummary() doesn't count the jump as driven distance.
export function markResume(seg, fix){
  if(!seg.pendingPause) return addFix(seg, fix);
  seg.gaps.push({ ...seg.pendingPause, resumeLat: fix.lat, resumeLng: fix.lng, resumeT: fix.t });
  seg.pendingPause = null;
  if(seg.points.length >= MAX_POINTS) return false;
  seg.points.push({ lat: fix.lat, lng: fix.lng, t: fix.t,
    spd: (typeof fix.spd === 'number' && fix.spd >= 0) ? fix.spd : 0, gap: true });
  return true;
}

// ── Office-side numbers (never shown to the driver) ────────────────────────
export function segmentSummary(points){
  const pts = points || [];
  let distanceM = 0, maxSpeed = 0, idleMs = 0;
  for(let i = 1; i < pts.length; i++){
    if(pts[i].gap) continue; // don't count the pause→resume jump as driven distance/idle
    distanceM += haversineM(pts[i - 1], pts[i]);
    // spd on point i characterizes the interval i-1→i (device speed, else derived
    // from the move). At/below the idle threshold the truck was effectively stopped.
    if((pts[i].spd || 0) <= IDLE_SPEED_MS) idleMs += pts[i].t - pts[i - 1].t;
  }
  for(const p of pts) if((p.spd || 0) > maxSpeed) maxSpeed = p.spd;
  const driveMs = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0;
  const avgSpeed = driveMs > 0 ? distanceM / (driveMs / 1000) : 0;
  return {
    pointCount: pts.length,
    distanceM: Math.round(distanceM),
    driveMin: +(driveMs / 60000).toFixed(2),
    idleMin: +(idleMs / 60000).toFixed(2), // stopped time (≤ IDLE_SPEED_MS), gaps excluded
    avgSpeed: +avgSpeed.toFixed(2), // m/s over the whole leg (stopped time included)
    maxSpeed: +maxSpeed.toFixed(2), // m/s, best single fix
  };
}

// Build the row that ships to the Sheet. startTime/endTime are epoch ms.
export function finalizeSegment(seg){
  const points = seg.points || [];
  return {
    id: seg.id,
    installer: seg.installer || '',
    date: seg.date || '',
    workType: seg.workType || '',
    startTime: points.length ? points[0].t : null,
    endTime: points.length ? points[points.length - 1].t : null,
    encoded: encodeTrack(points),
    gaps: seg.gaps || [],
    ...segmentSummary(points),
  };
}

// A leg worth uploading has at least two real points.
export function isWorthUploading(seg){
  return Boolean(seg && seg.points && seg.points.length >= 2);
}
