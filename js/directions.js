// ── Turn-by-turn directions from an offline district pack ────────────────────
// The road graph knows the way (js/roadgraph.js `pathDetail`) and, since pack
// v3, what each road is called. This turns those two into instructions a driver
// can follow: "in 1.2 km, turn left onto Muskoka Road 3".
//
// Pure and DOM-free like js/drive-track.js and js/districts.js — it takes a
// decoded graph and a leg list and returns plain objects. Nothing here fetches,
// speaks, or renders; js/route.js wires it to a real route.
//
// WHAT THIS IS NOT: the pack carries no turn restrictions, no traffic signals
// and no lane data. It can tell you the geometry says "turn left"; it cannot
// tell you the left turn is legal. That is exactly why the desktop planner
// still routes against a real OSRM, and why these instructions are a driver's
// aid rather than something to follow blindly. Say so in the UI.
import { segmentPoints, roadName, hasRoadNames, pathDetail } from './roadgraph.js';

const RAD = Math.PI / 180;

// Compass bearing from a→b in degrees (0 = north, clockwise).
export function bearing(a, b){
  const lat1 = a[0] * RAD, lat2 = b[0] * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// Signed turn from one bearing to the next: −180…180, negative = left.
export function turnAngle(from, to){
  let d = ((to - from) + 540) % 360 - 180;
  // −180 and 180 are the same turn; pick the positive so a dead-ahead reversal
  // is classified once rather than depending on float noise.
  if(d === -180) d = 180;
  return d;
}

// Thresholds in degrees. A road that bends gently is still the same road, so
// "straight" is deliberately wide — otherwise a curving rural concession emits
// an instruction every few hundred metres and the list becomes unreadable.
export const TURN_BANDS = [
  { max: 20,  kind: 'straight',     text: 'Continue' },
  { max: 45,  kind: 'slight',       text: 'Bear' },
  { max: 135, kind: 'turn',         text: 'Turn' },
  { max: 170, kind: 'sharp',        text: 'Sharp' },
  { max: 181, kind: 'uturn',        text: 'Make a U-turn' },
];

export function classifyTurn(angle){
  const mag = Math.abs(angle);
  const band = TURN_BANDS.find(b => mag < b.max) || TURN_BANDS[TURN_BANDS.length - 1];
  const side = angle < 0 ? 'left' : 'right';
  if(band.kind === 'straight') return { kind:'straight', side:'', text:'Continue' };
  if(band.kind === 'uturn')    return { kind:'uturn',    side:'', text:'Make a U-turn' };
  return { kind: band.kind, side, text: `${band.text} ${side}` };
}

// Distances a driver can act on: metres below a kilometre, one decimal above.
// Rounded to 10 m because the underlying geometry is a simplified graph and
// "in 437 m" claims a precision the pack does not have.
export function humanMetres(m){
  const v = Math.max(0, Math.round(Number(m) || 0));
  if(v < 1000) return `${Math.max(10, Math.round(v / 10) * 10)} m`;
  return `${(v / 1000).toFixed(1)} km`;
}

// The bearing entering and leaving a leg, taken from the first/last usable pair
// of shape points in DRIVING order. Zero-length hops are skipped: a repeated
// coordinate at a junction would otherwise give a meaningless 0° bearing and
// invent a turn.
function legBearings(g, leg){
  const pts = segmentPoints(g, leg.seg);
  if(!pts || pts.length < 2) return null;
  const ordered = leg.forward ? pts : pts.slice().reverse();
  let inB = null, outB = null;
  for(let i = 1; i < ordered.length; i++){
    if(sameCoord(ordered[i - 1], ordered[i])) continue;
    inB = bearing(ordered[i - 1], ordered[i]);
    break;
  }
  for(let i = ordered.length - 1; i > 0; i--){
    if(sameCoord(ordered[i - 1], ordered[i])) continue;
    outB = bearing(ordered[i - 1], ordered[i]);
    break;
  }
  return (inB === null || outB === null) ? null : { in: inB, out: outB };
}

const sameCoord = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

// Build the instruction list for one drive.
//
//   buildDirections(graph, legs) → [{ kind, side, road, meters, text }, …]
//
// Consecutive legs on the SAME road are merged into one instruction carrying
// their combined distance — a concession road split into forty graph segments
// is one "continue for 6 km", not forty. A new instruction is emitted when the
// road name changes or the geometry turns; the distance on an instruction is
// how far you travel AFTER it, which is the order a driver needs it in.
export function buildDirections(g, legs){
  if(!g || !Array.isArray(legs) || !legs.length) return [];
  const steps = [];
  let prevOut = null;      // bearing leaving the previous leg
  let cur = null;          // the instruction being accumulated

  for(const leg of legs){
    const b = legBearings(g, leg);
    const metres = g.segLen ? (g.segLen[leg.seg] || 0) : 0;
    const name = roadName(g, leg.seg);

    // A leg with no usable geometry still carries distance — fold it into the
    // instruction in progress rather than dropping metres off the total.
    if(!b){
      if(cur) cur.meters += metres;
      continue;
    }

    const angle = prevOut === null ? 0 : turnAngle(prevOut, b.in);
    const turn = classifyTurn(angle);
    const sameRoad = cur && name && cur.road === name;
    // A ROAD THAT BENDS IS STILL THE SAME ROAD. Merging only on a dead-straight
    // join turned a curving rural stretch into a stack of unusable 30 m steps —
    // "Bear right onto Taylor Road for 30 m" four times over, because the graph
    // splits a curve into short segments and each join is a few degrees off.
    // So same-name legs merge through anything short of doubling back, which is
    // the only case on one road where a driver actually has to do something.
    const merge = cur && (
      (sameRoad && turn.kind !== 'sharp' && turn.kind !== 'uturn')
      || (turn.kind === 'straight' && !name && !cur.road)
    );

    if(merge){
      cur.meters += metres;
    } else {
      cur = {
        kind: prevOut === null ? 'depart' : turn.kind,
        side: prevOut === null ? '' : turn.side,
        road: name,
        meters: metres,
      };
      steps.push(cur);
    }
    prevOut = b.out;
  }

  if(!steps.length) return [];
  // Three tidying passes, in this order. Each exists because the raw list read
  // badly on a real district; none of them invents or loses a metre.
  const out = adoptNextName(mergeSameRoad(swallowShortSteps(steps)));
  out.push({ kind:'arrive', side:'', road:'', meters:0 });
  for(const s of out) s.text = phrase(s);
  return out;
}

// An instruction you pass before you have finished reading it is worse than no
// instruction. Anything under this distance is folded into the step before it,
// keeping its metres — the unnamed connector between two arms of a junction is
// the usual culprit, and it is not a decision the driver makes.
export const MIN_STEP_M = 60;

function swallowShortSteps(steps){
  const out = [];
  for(const s of steps){
    const prev = out[out.length - 1];
    // The first step is never swallowed: it is where the drive starts.
    if(prev && s.meters < MIN_STEP_M){ prev.meters += s.meters; continue; }
    out.push(s);
  }
  return out;
}

// Swallowing a short connector can leave the road either side of it as two
// steps — "Head off on Taylor Road for 1.6 km" then "Continue on Taylor Road
// for 810 m", which is one road and one instruction. Rejoin them.
function mergeSameRoad(steps){
  const out = [];
  for(const s of steps){
    const prev = out[out.length - 1];
    const joinable = prev && s.road && prev.road === s.road
      && s.kind !== 'sharp' && s.kind !== 'uturn';
    if(joinable){ prev.meters += s.meters; continue; }
    out.push(s);
  }
  return out;
}

// A turn onto an unnamed stretch that immediately becomes a named road should
// name the road you end up on: "Turn left onto Highway 11 for 4.4 km", not
// "Turn left for 430 m" followed by "Continue on Highway 11". This is the
// slip road / unnamed junction arm case, and it is how every navigation app
// phrases it.
function adoptNextName(steps){
  const out = [];
  for(let i = 0; i < steps.length; i++){
    const s = steps[i], next = steps[i + 1];
    if(!s.road && next && next.road && (next.kind === 'straight' || next.kind === 'slight')){
      out.push({ ...s, road: next.road, meters: s.meters + next.meters });
      i++;                       // the named step has been folded in
      continue;
    }
    out.push(s);
  }
  return out;
}

// The wording. Kept next to the builder rather than in the UI so the phrasing
// is unit-tested with the geometry that produced it.
function phrase(step){
  const onto = step.road ? ` onto ${step.road}` : '';
  const along = step.road ? ` on ${step.road}` : '';
  const far = step.meters ? ` for ${humanMetres(step.meters)}` : '';
  switch(step.kind){
    case 'depart': return `Head off${along}${far}`;
    case 'arrive': return 'Arrive at the stop';
    case 'straight': return `Continue${along}${far}`;
    case 'uturn': return `Make a U-turn${onto}${far}`;
    case 'slight': return `Bear ${step.side}${onto}${far}`;
    case 'sharp':  return `Sharp ${step.side}${onto}${far}`;
    default:       return `Turn ${step.side}${onto}${far}`;
  }
}

// Directions for one drive between two coordinates, straight off the graph.
// Empty when the pack can't route it — the caller falls back to the hand-off to
// a real navigation app, exactly as it does today.
export function directionsBetween(g, fromCoord, toCoord){
  if(!g) return [];
  const { legs } = pathDetail(g, fromCoord, toCoord);
  return buildDirections(g, legs);
}

// A pack built before v3 routes perfectly well but can name nothing, so the
// caller can offer the line on the map without offering instructions.
export const canGiveDirections = g => hasRoadNames(g);
