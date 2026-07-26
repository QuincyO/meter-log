// ── Offline road map packs: download, storage, selection ─────────────────────
// The side-effect half of on-device routing. js/roadgraph.js is pure and only
// ever sees an ArrayBuffer; this module is what fetches that buffer, keeps it in
// IndexedDB, and decides which district is in play.
//
// WHY PACKS ARE NOT IN sw.js's SHELL: they are megabytes. The app shell is
// re-fetched wholesale by refreshShell() on every ⟳ Force update from GitHub,
// and adding packs there would turn a crew's routine "get the latest app" into
// a multi-megabyte download on boat signal. Packs are downloaded deliberately,
// once, from Settings — and they survive an app refresh precisely because they
// live in IndexedDB rather than Cache Storage.
import { idb } from './idb.js';
import { store } from './store.js';
import { decodePack, packCovers } from './roadgraph.js';

const MANIFEST_URL = 'maps/index.json';
const STORE = 'roadPacks';

// localStorage mirrors only the small descriptors (name, size, bbox) so the
// Settings list can paint offline without pulling megabytes of ArrayBuffer out
// of IndexedDB. The buffers themselves are the durable state and live in
// IndexedDB per the storage policy in AGENTS.md; this mirror is rebuildable and
// is reconciled against the real keys on every read.
const MIRROR_KEY = 'roadPackMeta';
const ACTIVE_KEY = 'roadPackActive';

// One decoded graph at a time. Decoding is a few milliseconds but allocating a
// second district's adjacency and grid is not free, and only one can be in play.
let decoded = null;      // { id, graph }
let decodeFailed = null; // id we already know is unusable, so we don't retry per run

function readMirror(){
  try { const v = JSON.parse(store.get(MIRROR_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function writeMirror(list){ store.set(MIRROR_KEY, JSON.stringify(list)); }

// The districts actually on this phone. Reads only the KEYS — pulling whole
// rows here would load every pack's bytes just to render a settings list.
export async function installedPacks(){
  const ids = (await idb.keys(STORE)) || [];
  const mirror = readMirror();
  const list = ids.map(id => mirror.find(m => m.id === id) || { id, name: id, bytes: 0, bbox: null });
  // Drop mirror entries whose pack is gone (a failed write, a cleared origin).
  if(mirror.length !== list.length) writeMirror(list);
  return list;
}

export function activePackId(){ return store.get(ACTIVE_KEY) || ''; }

export async function setActivePack(id){
  store.set(ACTIVE_KEY, id || '');
  if(decoded && decoded.id !== id) decoded = null;
  decodeFailed = null;
}

// The district catalogue published with the app. Needs signal; the Settings
// screen falls back to installedPacks() when this throws.
export async function fetchManifest(){
  const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if(!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data && data.districts) ? data.districts : [];
}

// Download one district and store it. onProgress({received, total}) fires as the
// body streams so a several-MB pull on boat signal shows movement rather than
// looking hung. Rejects (and stores nothing) on any failure — a half-written
// pack that decoded into a partial district would silently misroute.
export async function downloadPack(entry, onProgress){
  const res = await fetch(entry.file, { cache: 'no-cache' });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || entry.bytes || 0;

  let buf;
  if(res.body && typeof res.body.getReader === 'function'){
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for(;;){
      const { done, value } = await reader.read();
      if(done) break;
      chunks.push(value);
      received += value.length;
      onProgress && onProgress({ received, total });
    }
    const joined = new Uint8Array(received);
    let at = 0;
    for(const c of chunks){ joined.set(c, at); at += c.length; }
    buf = joined.buffer;
  } else {
    buf = await res.arrayBuffer();
    onProgress && onProgress({ received: buf.byteLength, total: total || buf.byteLength });
  }

  // Decode before storing: a pack that can't be read is a download to redo, not
  // a row to keep.
  decodePack(buf.slice(0));

  const row = {
    id: entry.id, name: entry.name, bbox: entry.bbox,
    bytes: buf.byteLength, builtAt: entry.builtAt || '', buf,
  };
  const ok = await idb.put(STORE, row);
  if(ok === null) throw new Error('could not save the map (storage full?)');

  const meta = { id: row.id, name: row.name, bbox: row.bbox, bytes: row.bytes, builtAt: row.builtAt };
  writeMirror([...readMirror().filter(m => m.id !== row.id), meta]);
  if(!activePackId()) await setActivePack(row.id);
  if(decoded && decoded.id === row.id) decoded = null;
  decodeFailed = null;
  return meta;
}

export async function deletePack(id){
  await idb.del(STORE, id);
  writeMirror(readMirror().filter(m => m.id !== id));
  if(decoded && decoded.id === id) decoded = null;
  if(activePackId() === id){
    const left = await installedPacks();
    await setActivePack(left.length ? left[0].id : '');
  }
}

// The decoded graph for the active district, or null. Decoding is lazy — the
// first Optimize pays it, not every page load, because most sessions never
// route at all.
export async function loadGraph(){
  const id = activePackId() || (await installedPacks())[0]?.id || '';
  if(!id) return null;
  if(decoded && decoded.id === id) return decoded.graph;
  if(decodeFailed === id) return null;
  const row = await idb.get(STORE, id);
  if(!row || !row.buf) return null;
  try {
    const graph = decodePack(row.buf);
    decoded = { id, graph };
    return graph;
  } catch(e){
    // A corrupt pack must not wedge every future run; remember and move on.
    console.warn('road pack unusable, ignoring:', e);
    decodeFailed = id;
    return null;
  }
}

// How much of a run this graph can actually measure. Returns
// { covered, total, ratio, outside } — route.js uses it to decide between
// routing locally, pricing a few stray stops crow-flies, or declining to the
// next provider entirely.
export function coverage(graph, coords){
  const total = coords.length;
  if(!graph || !total) return { covered: 0, total, ratio: 0, outside: coords.map((_, i) => i) };
  const outside = [];
  for(let i = 0; i < total; i++) if(!packCovers(graph, coords[i])) outside.push(i);
  const covered = total - outside.length;
  return { covered, total, ratio: total ? covered / total : 0, outside };
}

// Test seam + a way for Settings to force a re-read after a delete/download.
export function resetGraphCache(){ decoded = null; decodeFailed = null; }
