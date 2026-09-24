// ── Activity log: what the status pill has been doing ───────────────────────
// Tap the pill on the capture page and this sheet shows exactly which writes are
// waiting to go to the Sheet (the offline queue, in send order), which background
// jobs are running, and what recently happened — every Sheet write with its
// outcome, plus the jobs the pill names (worklist sync, PDF, recent days…). Each
// row expands to every field that was sent; the token never appears.
//
// Three things keep this OFF the capture page's critical path, and each one is
// load-bearing (AGENTS.md §"The status pill's activity log"):
//   1. capture.js loads this file with a dynamic import() inside a .catch — never
//      a static import — and it is deliberately NOT in sw.js SHELL. Any byte
//      change to sw.js re-downloads the whole shell on every phone at once; a
//      failed load here costs the log, never Log stop / End of day / Force update.
//   2. Hooks added alongside this file (dom.onActivityEvent, api.setApiHook) are
//      reached through namespace imports with a typeof check, so a phone running
//      this against an older dom.js/api.js loses one feed instead of the module.
//      The queue feed rides the long-standing setQueueHooks, handed in by capture.js.
//   3. The log lives in its OWN IndexedDB database. Adding a store to 'meterlog'
//      means a version bump, and idb.js has no onblocked: a v5 connection held by
//      another tab (or planner.html) would hang every idb call, enqueue included.
//
// Row model — one row per thing, updated in place rather than appended:
//   queue rows  id 'q:<_seq>'  one per queued write; its status moves
//               queued → waiting / rejected / stuck → sent (or retried, discarded),
//               so an hour offline changes one row and adds none.
//   job rows    one per pill job, written when it ends. A POST made while exactly
//               one job is open is folded into it ("Syncing worklist — Worklist
//               upload · 24 orders" is one row, not two).
//   post rows   a direct apiPost with no job around it (the online End-of-day).
// Identical job/post rows within COLLAPSE_MS merge into one with a ×N count.
//
// The top half is pure and unit-tested (tests/activity-log.test.mjs); nothing
// touches the DOM or storage at load, so node --test can import it.
import * as dom from './dom.js';
import * as api from './api.js';
import { idb } from './idb.js';
import { CAT_LABEL } from './compute/categories.js';
import { MAX_FLUSH_TRIES } from './queue-policy.js';

export const LOG_DB = 'meterlog-activity';
const LOG_STORE = 'rows';
export const MAX_AGE_MS = 48 * 3600 * 1000;   // ~2 days of history
export const MAX_ROWS = 500;
export const COLLAPSE_MS = 2 * 60 * 1000;
export const FIELD_STR_MAX = 80;
const RENDER_THROTTLE_MS = 500;

// ── pure: describing a write ────────────────────────────────────────────────
const join = (...xs) => xs.filter(Boolean).join(' · ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const catLabel = c => CAT_LABEL[c] || c || 'Other';
const count = v => Array.isArray(v) ? v.length : 0;

// One line naming the write, for every action the phone sends to the spine.
export function describeWrite(p){
  if(!p || typeof p !== 'object') return 'Upload';
  const wo = p.workOrderId ? `WO# ${p.workOrderId}` : '';
  switch(p.action){
    case 'addStop':
      if(p.status === 'DONE') return 'Already-installed marker';
      return join('Stop', wo || 'no WO#',
        p.newJNumber ? `J# ${p.newJNumber}` : (p.oldJNumber ? `old J# ${p.oldJNumber}` : ''),
        p.status);
    case 'addDowntime':
      return join('Downtime', `${catLabel(p.category)} ${Number(p.minutes) || 0} min`, wo);
    case 'updateStop': {
      // geocode.js backfillAddresses sends an address-only correction; a card
      // edit on Today's orders sends the whole stop.
      const keys = Object.keys(p).filter(k => k !== 'token' && k !== 'action' && k !== 'id' && k[0] !== '_');
      if(keys.length === 1 && keys[0] === 'address') return join('Address filled in', p.address);
      return join('Stop edit', wo, p.status);
    }
    case 'archiveStop':
      if(p.reason === 'reset order') return 'Start order over (stop archived)';
      return join('Remove stop', p.reason ? `“${p.reason}”` : '');
    case 'saveTravel':      return join('Travel review', plural(count(p.allocations), 'deduction'));
    case 'saveDay':         return join('Day start / end times', [p.departure, p.returned].filter(Boolean).join('–'));
    case 'endOfDay':        return 'End-of-day close';
    case 'saveEmployee':    return join('Settings — your details', p.hNumber);
    case 'saveDriveTrack':  return join('Drive leg', p.date,
                              p.distanceM ? `${(p.distanceM / 1000).toFixed(1)} km` : '',
                              p.pointCount ? `${p.pointCount} pts` : '');
    case 'saveWorklist':    return join('Worklist upload', plural(count(p.orders), 'order'));
    case 'savePlan':        return 'Route settings';
    case 'previewDailyLog': return 'Daily log preview (nothing saved)';
    default:                return p.action || 'Upload';
  }
}

// The expanded view: every field that was sent. Long strings (drive polylines,
// route geometry) are cut by LENGTH first — never JSON.stringify'd whole — and
// arrays/objects are summarized, so a 24-order worklist upload stays one screen.
const INTERNAL = new Set(['token', '_seq', '_tries', '_parked', '_error']);
export function fieldValue(v){
  if(v === null || v === undefined) return '—';
  if(typeof v === 'string'){
    if(v === '') return '(blank)';
    return v.length > FIELD_STR_MAX ? `${v.slice(0, FIELD_STR_MAX)}… (${v.length} chars)` : v;
  }
  if(typeof v === 'number' || typeof v === 'boolean') return String(v);
  if(Array.isArray(v)) return plural(v.length, 'item');
  if(typeof v === 'object'){
    const keys = Object.keys(v);
    return `{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}}`;
  }
  return String(v);
}
export function payloadFields(p){
  if(!p || typeof p !== 'object') return [];
  return Object.keys(p).filter(k => !INTERNAL.has(k)).map(k => [k, fieldValue(p[k])]);
}

// What the spine's ack means, in words — the terminal {ok:true, …} flags.
function replyNote(action, res){
  if(!res || typeof res !== 'object') return '';
  if(res.duplicate) return 'Already on the sheet — an earlier try got through';
  if(Array.isArray(res.jConflicts) && res.jConflicts.length) return 'Saved — duplicate J# warning';
  if(res.flagged) return 'Saved — J# conflict flagged';
  if(action === 'updateStop' && res.archived) return 'The stop had been removed — edit not applied';
  if(res.alreadyArchived) return 'It was already removed';
  if(res.missing) return 'Stop not found on the sheet — nothing to do';
  if(res.regenerated) return 'Closed day rebuilt';
  return '';
}

function waitingNote(reason, online){
  if(reason === 'busy') return 'Server busy — will retry';
  if(reason === 'network' && !online) return 'No signal — will send when back online';
  return 'Server not responding — will retry';
}

// ── pure: the one row per queued write ──────────────────────────────────────
// `ev` = {type, seq, payload, res?, tries?, error?, reason?, online?}; a caller may
// pre-compute summary/fields/action (the live hook does, so a payload mutated
// later can't change what was recorded).
export function applyQueueEvent(row, ev, now){
  const p = ev.payload;
  const r = row ? { ...row } : {
    id: 'q:' + ev.seq, kind: 'queue', seq: ev.seq,
    action: ev.action !== undefined ? ev.action : (p && p.action) || '',
    summary: ev.summary !== undefined ? ev.summary : describeWrite(p),
    fields: ev.fields !== undefined ? ev.fields : payloadFields(p),
    queuedAt: null, sentAt: null, attempts: 0, tries: 0, error: null, note: '', status: 'queued',
  };
  r.ts = now;
  switch(ev.type){
    case 'queued':
      r.status = 'queued'; r.queuedAt = now; break;
    case 'sent':
      r.status = 'sent'; r.sentAt = now; r.attempts++; r.error = null;
      r.note = replyNote(r.action, ev.res); break;
    case 'waiting':
      r.status = 'waiting'; r.attempts++; r.note = waitingNote(ev.reason, ev.online !== false); break;
    case 'rejected':
      r.status = 'rejected'; r.attempts++; r.tries = ev.tries || 0; r.error = ev.error || 'rejected';
      r.note = `Server said no — try ${r.tries} of ${MAX_FLUSH_TRIES}`; break;
    case 'stuck':
      r.status = 'stuck'; r.attempts++; r.tries = ev.tries || 0; r.error = ev.error || 'rejected';
      r.note = 'Set aside so the rest could send'; break;
    case 'retried':
      r.status = 'retried'; r.tries = 0; r.error = null; r.note = 'Un-parked — trying again'; break;
    case 'discarded':
      r.status = 'discarded'; r.note = 'Discarded — not sent to the office'; break;
  }
  return r;
}

// ── pure: jobs and direct POSTs ─────────────────────────────────────────────
function errText(e){
  if(!e) return '';
  if(e.name === 'SyntaxError') return 'The server sent an unreadable reply';
  if(e.name === 'TypeError') return "Couldn't reach the server";
  return String(e.message || e);
}
// One apiPost, as recorded: `{body, res, error, ms}` from api.js's hook, where
// `body` is the caller's object (the token is merged in later and never seen).
export function postPart({ body, res, error, ms }){
  const failed = !!error || res == null || (typeof res === 'object' && res.ok === false);
  return {
    action: (body && body.action) || '',
    summary: describeWrite(body),
    fields: payloadFields(body),
    ok: !failed,
    error: error ? errText(error) : (failed ? String((res && res.error) || 'The server said no') : ''),
    note: failed ? '' : replyNote(body && body.action, res),
    ms: ms || 0,
  };
}
const trimLabel = l => String(l || '').replace(/…$/, '').trim();
// `end.ok` is undefined for beginActivity/endActivity callers that report no
// verdict (geocode.js) — that is "done", not a failure.
export function jobRow(job, end, now){
  const parts = job.parts || [];
  return {
    id: job.id, kind: 'job', ts: now, label: job.label,
    summary: trimLabel(job.label) + (parts.length ? ' — ' + parts.map(p => p.summary).join(' + ') : ''),
    ok: end.ok !== false && parts.every(p => p.ok),
    error: parts.map(p => p.error).filter(Boolean).join('; '),
    ms: end.ms || 0, parts, count: 1,
  };
}
export function postRow(part, id, now){
  return { id, kind: 'post', ts: now, summary: part.summary, ok: part.ok, error: part.error,
           note: part.note, ms: part.ms, parts: [part], count: 1 };
}
// Consecutive repeats ("Loading recent days", "Fetching address", the End-of-day
// prefetch) merge into one row. Never across a success/failure boundary, and
// never for queue rows — those are one per write by design.
export function collapses(prev, next){
  if(!prev || !next || prev.kind === 'queue' || next.kind === 'queue') return false;
  return prev.kind === next.kind && prev.summary === next.summary && prev.ok === next.ok
      && next.ts - prev.ts <= COLLAPSE_MS;
}

// ── pure: retention + splitting against the live queue ──────────────────────
// Ids to delete: anything older than MAX_AGE_MS, then anything past the newest
// MAX_ROWS. A write still in the queue keeps its row however long it has waited.
export function pruneIds(rows, now, keep = new Set()){
  const gone = new Set();
  const live = [];
  for(const r of rows){
    if(keep.has(r.id)) continue;
    if(!(now - (r.ts || 0) <= MAX_AGE_MS)) gone.add(r.id); else live.push(r);
  }
  live.sort((a, b) => b.ts - a.ts);
  for(const r of live.slice(Math.max(0, MAX_ROWS - keep.size))) gone.add(r.id);
  return [...gone];
}

const OPEN = new Set(['queued', 'waiting', 'rejected', 'retried']);
// `items` = the raw IndexedDB queue. Waiting = its non-parked items in send order
// (joined to their rows; an item the log never saw still shows, with no queued
// time). Recent = every other row, newest first. A queue row the log last saw as
// open whose item has left the queue gets status 'left' — its result was never
// recorded (the app was killed mid-send, or the log wasn't loaded yet).
export function splitRows(rows, items){
  const byId = new Map((rows || []).map(r => [r.id, r]));
  const waitingIds = new Set();
  const liveIds = new Set();
  const pending = [];
  let parked = 0;
  for(const it of items || []){
    if(!it || it._seq == null) continue;
    const id = 'q:' + it._seq;
    liveIds.add(id);
    if(it._parked){ parked++; continue; }
    waitingIds.add(id);
    // No row ⇒ built here with a null stamp, which renders as "—".
    pending.push(byId.get(id) || applyQueueEvent(null, { type:'queued', seq: it._seq, payload: it }, null));
  }
  const recent = (rows || [])
    .filter(r => !waitingIds.has(r.id))
    .map(r => r.kind === 'queue' && !liveIds.has(r.id) && OPEN.has(r.status)
      ? { ...r, status: 'left', note: 'Left the queue — sent or discarded, result not recorded' } : r)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { pending, parked, recent };
}

// ── pure: rendering ─────────────────────────────────────────────────────────
// dom.attr escapes quotes as well as &<>, so one helper is safe for text and
// for the data-id attribute alike.
const esc = v => dom.attr(v);

function clock(ms, now){
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  return d.toDateString() === new Date(now).toDateString()
    ? t : d.toLocaleDateString([], { weekday:'short' }) + ' ' + t;
}
const dur = ms => ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${(ms / 1000).toFixed(1)} s`;

const QUEUE_STATUS = {
  queued:    ['st-wait', '⏳', 'Waiting to send'],
  waiting:   ['st-wait', '⏳', 'Waiting to send'],
  retried:   ['st-wait', '↻', 'Retrying'],
  rejected:  ['st-warn', '↻', 'Rejected'],
  stuck:     ['st-bad',  '⚠', 'Stuck'],
  sent:      ['st-ok',   '✓', 'Sent'],
  discarded: ['st-bad',  '✗', 'Discarded'],
  left:      ['st-muted','?', 'Left the queue'],
};
function statusOf(r){
  if(r.kind === 'queue') return QUEUE_STATUS[r.status] || QUEUE_STATUS.queued;
  if(!r.ok) return ['st-bad', '✗', 'Failed'];
  return ['st-ok', '✓', r.kind === 'job' ? 'Done' : 'Sent'];
}

const fieldsHTML = f => f && f.length
  ? `<dl class="act-fields">${f.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';

function rowHTML(r, now, when){
  const [cls, ico, text] = statusOf(r);
  const sub = join(
    r.status === 'left' ? '' : text,
    r.note,
    r.error && r.kind === 'queue' ? `“${r.error}”` : '',
    r.kind !== 'queue' && r.error ? r.error : '',
    r.kind === 'queue' && r.attempts > 1 ? `${r.attempts} tries` : '',
    r.count > 1 ? `×${r.count}` : '',
    r.kind !== 'queue' && r.ms ? dur(r.ms) : '');
  const head = `<span class="act-time">${when ? esc(clock(when, now)) : '—'}</span><span class="act-ico" aria-hidden="true">${ico}</span>`
    + `<span class="act-main"><span class="act-sum">${esc(r.summary)}</span>`
    + (sub ? `<span class="act-sub">${esc(sub)}</span>` : '') + '</span>';
  const detail = r.parts && r.parts.length
    ? r.parts.map(p => (r.parts.length > 1 || r.kind === 'job'
        ? `<div class="act-part-h">${esc(join(p.summary, p.ok ? p.note : (p.error || 'failed')))}</div>` : '')
        + fieldsHTML(p.fields)).join('')
    : fieldsHTML(r.fields);
  if(!detail) return `<div class="act-row ${cls}" data-id="${esc(r.id)}"><div class="act-head">${head}</div></div>`;
  return `<details class="act-row ${cls}" data-id="${esc(r.id)}"><summary class="act-head">${head}</summary>`
    + `<div class="act-detail">${detail}</div></details>`;
}

// The sheet body. `pending`/`parked`/`recent` come from splitRows; `running` is
// the live activity labels.
export function renderActivityHTML({ running = [], pending = [], parked = 0, recent = [], now = Date.now() }){
  let h = '';
  if(parked) h += `<div class="act-stuck"><span>⚠ ${plural(parked, 'upload')} stuck — the server kept rejecting `
    + `${parked === 1 ? 'it' : 'them'}.</span><button class="ghost" type="button" data-act="stuck">Review stuck uploads</button></div>`;
  if(running.length) h += '<h3 class="act-h">Running now</h3>'
    + running.map(l => `<div class="act-row act-running"><div class="act-head"><span class="act-time"></span>`
      + `<span class="act-ico" aria-hidden="true">●</span><span class="act-main"><span class="act-sum">${esc(l)}</span></span></div></div>`).join('');
  h += `<h3 class="act-h">Waiting to send (${pending.length})</h3>`;
  h += pending.length ? pending.map(r => rowHTML(r, now, r.queuedAt)).join('')
                      : '<p class="muted act-empty">Nothing waiting — everything has been sent.</p>';
  h += '<h3 class="act-h">Recent activity</h3>';
  h += recent.length ? recent.map(r => rowHTML(r, now, r.ts)).join('')
                     : '<p class="muted act-empty">Nothing recorded yet.</p>';
  return h;
}

// ── storage: a tiny wrapper over the log's own database ─────────────────────
let _opening = null;
function openDb(){
  if(_opening) return _opening;
  _opening = new Promise((res, rej) => {
    try{
      const req = indexedDB.open(LOG_DB, 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if(!d.objectStoreNames.contains(LOG_STORE)) d.createObjectStore(LOG_STORE, { keyPath:'id' });
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    } catch(e){ rej(e); }
  }).catch(() => null);   // no database ⇒ the log is a silent no-op
  return _opening;
}
async function tx(mode, fn){
  const d = await openDb();
  if(!d) return null;
  return new Promise(res => {
    try{
      const r = fn(d.transaction(LOG_STORE, mode).objectStore(LOG_STORE));
      r.onsuccess = e => res(e.target.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
const getRow = id => tx('readonly', os => os.get(id));
const putRow = row => tx('readwrite', os => os.put(row));
const delRow = id => tx('readwrite', os => os.delete(id));
const allRows = async () => (await tx('readonly', os => os.getAll())) || [];

// Every write goes through one chain, so a read-modify-write of a queue row can
// never interleave with the next event for the same write. Never rejects.
let _chain = Promise.resolve();
function write(fn){
  _chain = _chain.then(fn).catch(() => {}).then(changed);
  return _chain;
}

// Job/post rows: merge into the last row with the same shape if collapses() says so.
const _lastByKey = new Map();
function addRow(row){
  return write(async () => {
    const key = `${row.kind}|${row.summary}|${row.ok}`;
    const prev = _lastByKey.get(key);
    if(collapses(prev, row)){
      const merged = { ...prev, ts: row.ts, ms: row.ms, parts: row.parts, count: (prev.count || 1) + 1 };
      _lastByKey.set(key, merged);
      await putRow(merged);
      return;
    }
    _lastByKey.set(key, row);
    await putRow(row);
  });
}

const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// ── feeds ───────────────────────────────────────────────────────────────────
// Queue events (js/queue.js, via setQueueHooks). Summary + fields are taken now,
// synchronously, from the payload as it was sent.
function onQueueEvent(ev){
  if(!ev || ev.seq == null) return;
  const now = Date.now();
  const e = { ...ev, payload: undefined, action: (ev.payload && ev.payload.action) || '',
              summary: describeWrite(ev.payload), fields: payloadFields(ev.payload), online: isOnline() };
  write(async () => { await putRow(applyQueueEvent(await getRow('q:' + e.seq), e, now)); });
}

// Pill jobs (js/dom.js activity registry). A job's row is written once it ends.
const _openJobs = new Map();
function onActivity(ev){
  if(!ev) return;
  if(ev.phase === 'begin'){ _openJobs.set(ev.id, { id: newId('j:'), label: ev.label, start: Date.now(), parts: [] }); }
  else if(ev.phase === 'end'){
    const job = _openJobs.get(ev.id);
    _openJobs.delete(ev.id);
    if(job) addRow(jobRow(job, ev, Date.now()));
  }
  changed();   // the "Running now" section
}

// Direct POSTs (js/api.js apiPost). Folded into the job it ran inside when that
// is unambiguous — exactly one job open, and it started before the POST did.
function onPost(info){
  const part = postPart(info || {});
  const now = Date.now();
  const open = [..._openJobs.values()];
  if(open.length === 1 && open[0].start <= now - part.ms){ open[0].parts.push(part); return; }
  addRow(postRow(part, newId('p:'), now));
}

// Called once by capture.js after the lazy import resolves.
export function initActivityLog(deps = {}){
  if(typeof deps.setQueueHooks === 'function') deps.setQueueHooks({ onLog: onQueueEvent });
  if(typeof dom.onActivityEvent === 'function') dom.onActivityEvent(onActivity);
  if(typeof api.setApiHook === 'function') api.setApiHook(onPost);
  pruneLog();
}

export async function pruneLog(){
  const items = (await idb.all('queue')) || [];
  const keep = new Set(items.map(it => 'q:' + it._seq));
  return write(async () => {
    for(const id of pruneIds(await allRows(), Date.now(), keep)) await delRow(id);
  });
}

// ── the sheet (index.html #activitySheet) ───────────────────────────────────
let _ctl = null, _timer = null, _fingerDown = false, _deferred = false;
const el = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const sheetOpen = () => { const s = el('activitySheet'); return !!s && !s.classList.contains('hide'); };

function running(){
  if(typeof dom.activeActivities === 'function') return dom.activeActivities();
  const one = dom.activeActivity && dom.activeActivity();
  return one ? [one] : [];
}

async function renderSheet(){
  const s = el('activitySheet'), body = el('activityBody');
  if(!s || !body) return;
  const [rows, items] = await Promise.all([allRows(), idb.all('queue')]);
  const { pending, parked, recent } = splitRows(rows, items || []);
  // Keep what the installer is looking at: which rows are open, and the scroll.
  const open = new Set([...body.querySelectorAll('details[open]')].map(d => d.dataset.id));
  const card = s.querySelector('.card');
  const top = card ? card.scrollTop : 0;
  body.innerHTML = renderActivityHTML({ running: running(), pending, parked, recent, now: Date.now() });
  for(const d of body.querySelectorAll('details[data-id]')) if(open.has(d.dataset.id)) d.open = true;
  if(card) card.scrollTop = top;
}

// Live refresh while the sheet is open — throttled, and never under a finger:
// a re-render that moves rows while a tap or scroll is in flight is how the
// End-of-day review used to eat taps (AGENTS.md, the end-of-day review bullet).
function changed(){
  if(!sheetOpen() || _timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    if(_fingerDown){ _deferred = true; return; }
    renderSheet();
  }, RENDER_THROTTLE_MS);
}

function bindSheet(s, body){
  if(s.dataset.actBound) return;
  s.dataset.actBound = '1';
  body.addEventListener('click', e => {
    if(e.target.closest('[data-act="stuck"]') && _ctl){ _ctl.closeSheets(); _ctl.openStuckSheet(); }
  });
  s.addEventListener('pointerdown', () => { _fingerDown = true; });
  const up = () => { _fingerDown = false; if(_deferred){ _deferred = false; changed(); } };
  s.addEventListener('pointerup', up);
  s.addEventListener('pointercancel', up);
}

// Returns false when the page has no sheet markup (a phone whose cached
// index.html predates it) so the pill can fall back to its old behaviour.
export async function openActivitySheet(ctl){
  const s = el('activitySheet'), body = el('activityBody');
  if(!s || !body || !ctl) return false;
  _ctl = ctl;
  bindSheet(s, body);
  body.innerHTML = '';          // a fresh open starts with every row collapsed
  await pruneLog();
  await renderSheet();
  ctl.openSheet('activitySheet');
  const card = s.querySelector('.card');
  if(card) card.scrollTop = 0;
  return true;
}
