// ── The Audits view: controls, the address bar and what is on screen ─────────
// Shared by both pages. js/pages/audits.js (the office, behind the password)
// passes the installer list and a way to load a day's drive log; js/pages/
// my-audit.js (the installer's phone) passes one fixed name and neither. This
// file must never import the admin gate and never name a password-gated read:
// tests/admin-gate.test.mjs scans it as capture-side code, because the phone
// runs it.
//
// One `audit` read per installer, kept in memory. Every figure is then worked out
// in the browser (js/compute/audit.js), so changing the work mode, the range or
// the day costs no second request.
//
// State lives in the address: who, mode, from, to, day. The browser's Back button
// therefore returns from a day to the period, and a view can be reopened from its
// link. With `day` set the day view shows and the period view hides.
//
// Every element is looked up once into a const and tested before use. A page can
// run this script against older cached markup (or the reverse); a missing element
// must cost that one control, not the page.
import { $, esc, toast } from './dom.js';
import { apiGet } from './api.js';
import { prepareAudit, periodStats, dayDetail, driveStats } from './compute/audit.js';
import { fmtDate } from './audit-charts.js';
import { periodHtml, notesHtml, dayTopHtml, dayLogsHtml, gapDetailHtml, dayNotesHtml, driveLineHtml }
  from './audit-render.js';
import { createRouteMap, offMapHtml } from './audit-map.js';

const MODES = ['land', 'boat', 'all'];
const MODE_LABEL = { land: 'Land work', boat: 'Boat work', all: 'Land and boat work' };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const todayKey = () => { const n = new Date(), p = x => ('0' + x).slice(-2);
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`; };

/** installers: string[] | null — the office's picker. fixedInstaller: string | null
 *  — the phone's one name (hides the picker). loadDriveLegs: (installer, date) =>
 *  Promise<object[]>, office only. */
export function initAuditView({ installers = null, fixedInstaller = null, loadDriveLegs = null } = {}){
  const el = {
    status: $('status'), statusText: $('statusText'),
    who: $('auWho'), mode: $('auMode'), from: $('auFrom'), to: $('auTo'), all: $('auAll'),
    day: $('auDay'), print: $('auPrint'), printDay: $('auPrintDay'),
    periodControls: $('auPeriodControls'), dayControls: $('auDayControls'),
    back: $('auBack'), prev: $('auPrev'), next: $('auNext'), dayTitle: $('auDayTitle'),
    printHead: $('auPrintHead'), note: $('auNote'), period: $('auPeriod'), dayView: $('auDayView'),
    dayTop: $('auDayTop'), dayBottom: $('auDayBottom'), routeCard: $('auRouteCard'),
    drive: $('auDrive'), map: $('auMap'), mapNote: $('auMapNote'),
  };
  const show = (node, on) => { if(node) node.classList.toggle('hide', !on); };
  const html = (node, markup) => { if(node) node.innerHTML = markup; };
  function setStatus(kind, text){
    if(el.status){ el.status.classList.remove('wait', 'off'); if(kind) el.status.classList.add(kind); }
    if(el.statusText) el.statusText.textContent = text;
  }

  // ── state ↔ the address bar ────────────────────────────────────────────────
  const state = { who: '', mode: 'land', from: '', to: '', day: '' };
  function readAddress(){
    const q = new URLSearchParams(location.search);
    state.who = fixedInstaller || (q.get('who') || '').trim();
    if(installers && state.who && !installers.includes(state.who)) state.who = '';
    state.mode = MODES.includes(q.get('mode')) ? q.get('mode') : 'land';
    state.from = isDate(q.get('from')) ? q.get('from') : '';
    state.to = isDate(q.get('to')) ? q.get('to') : '';
    state.day = isDate(q.get('day')) ? q.get('day') : '';
  }
  function address(){
    const q = new URLSearchParams();
    if(state.who && !fixedInstaller) q.set('who', state.who);
    if(state.mode !== 'land') q.set('mode', state.mode);
    if(state.from) q.set('from', state.from);
    if(state.to) q.set('to', state.to);
    if(state.day) q.set('day', state.day);
    const s = q.toString();
    return location.pathname + (s ? '?' + s : '');
  }
  // A change the user made: one new history entry, then draw it.
  function go(change){
    Object.assign(state, change);
    try { history.pushState(null, '', address()); } catch {}
    render();
  }

  // ── data ───────────────────────────────────────────────────────────────────
  const raws = new Map();      // installer → the audit read
  const preps = new Map();     // installer|mode → prepareAudit's result
  async function rawFor(who){
    if(raws.has(who)) return raws.get(who);
    const res = await apiGet('audit', { installer: who });
    if(!res || res.ok === false) throw new Error((res && res.error) || 'no answer');
    // A spine from before this read answers an unknown action with a bare ok.
    if(!Array.isArray(res.stops)) throw new Error('the server does not have this report yet');
    raws.set(who, res);
    return res;
  }
  function prepFor(who, mode, raw){
    const key = who + '|' + mode;
    if(!preps.has(key)) preps.set(key, prepareAudit(raw, { installer: who, mode }));
    return preps.get(key);
  }

  // ── drawing ────────────────────────────────────────────────────────────────
  function syncControls(prep){
    if(el.who && el.who.value !== state.who) el.who.value = state.who;
    if(el.mode) for(const b of el.mode.querySelectorAll('button[data-mode]')){
      const on = b.dataset.mode === state.mode;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // An empty From/To means "all to date"; show the dates that turns out to be.
    const first = prep && prep.days.length ? prep.days[0].date : '';
    const last = prep && prep.days.length ? prep.days[prep.days.length - 1].date : '';
    if(el.from) el.from.value = state.from || first;
    if(el.to) el.to.value = state.to || last;
    if(el.day) el.day.value = state.day;
    if(el.all) el.all.disabled = !state.from && !state.to;
    show(el.periodControls, !state.day);
    show(el.dayControls, !!state.day);
    show(el.period, !state.day);
    show(el.dayView, !!state.day);
  }
  function printHead(what){
    html(el.printHead, `Audit: ${esc(state.who)}<small>${esc(MODE_LABEL[state.mode])} · ${esc(what)} · printed ${esc(fmtDate(todayKey()))}</small>`);
  }

  function renderPeriod(prep){
    const stats = periodStats(prep, { from: state.from, to: state.to });
    html(el.note, notesHtml({ prep, stats, name: state.who }));
    html(el.period, periodHtml(stats, prep));
    const a = stats.daily.length ? stats.daily[0].date : '', b = stats.daily.length ? stats.daily[stats.daily.length - 1].date : '';
    printHead(a ? `${fmtDate(a)} to ${fmtDate(b)}` : 'no logs');
  }

  // ── one day ────────────────────────────────────────────────────────────────
  let routeMap = null;         // made on the first day opened, then reused
  let shownDay = null;         // the DayRec on screen, for the gap detail
  const driveLegs = new Map(); // installer|date → the day's legs (office only)

  function openGap(i){
    const box = $('auGapDetail');
    if(!box || !shownDay) return;
    box.innerHTML = gapDetailHtml(shownDay, i);
    for(const b of document.querySelectorAll('.au-timeline .au-blk.sel, .au-logrow.on')) b.classList.remove('sel', 'on');
    for(const b of document.querySelectorAll(`.au-timeline .au-blk[data-gap="${i}"]`)) b.classList.add('sel');
    for(const r of document.querySelectorAll(`.au-logrow[data-gap="${i}"]`)) r.classList.add('on');
  }

  // The day's drive log. Only the office page passes a loader: the read behind it
  // needs the office password, so on the phone none of this is drawn.
  async function renderDrive(who, date, my){
    if(!el.drive) return;
    if(loadDriveLegs){
      const key = who + '|' + date;
      html(el.drive, '<p class="au-cap">Looking for a drive log…</p>');
      let legs;
      try {
        if(!driveLegs.has(key)) driveLegs.set(key, await loadDriveLegs(who, date));
        legs = driveLegs.get(key);
      } catch {
        if(my === seq) html(el.drive, '<p class="au-cap">Could not load the drive log.</p>');
        return;
      }
      if(my !== seq) return;
      if(!legs.length){ html(el.drive, '<p class="au-cap">No drive log was recorded this day.</p>'); return; }
      html(el.drive, '<label class="au-check"><input type="checkbox" id="auDriveOn"> Show drive log</label>'
        + `<span class="au-cap">${esc(driveLineHtml(driveStats(legs)))}</span>`);
      const box = $('auDriveOn');
      if(box) box.onchange = () => { if(routeMap) routeMap.setDriveLegs(box.checked ? legs : null); };
    } else {
      html(el.drive, '');
    }
  }

  function renderDay(prep, my){
    const detail = dayDetail(prep, state.day);
    if(el.dayTitle) el.dayTitle.textContent = fmtDate(state.day);
    // Step to the nearest worked day either side, even from a day with no logs.
    const before = prep.days.filter(d => d.date < state.day), after = prep.days.filter(d => d.date > state.day);
    const prev = before.length ? before[before.length - 1].date : '', next = after.length ? after[0].date : '';
    if(el.prev){ el.prev.disabled = !prev; el.prev.onclick = () => { if(prev) go({ day: prev }); }; }
    if(el.next){ el.next.disabled = !next; el.next.onclick = () => { if(next) go({ day: next }); }; }
    printHead(fmtDate(state.day));
    if(!detail){
      shownDay = null;
      show(el.dayView, false);
      html(el.note, (prep.mode !== 'land' ? '<p class="au-note warn">The pause figures were checked against land work only.</p>' : '')
        + `<p class="au-note">No logs on ${esc(fmtDate(state.day))} for ${esc(state.who)} in this view.</p>`);
      return;
    }
    const day = shownDay = detail.day;
    html(el.note, (prep.mode !== 'land' ? '<p class="au-note warn">The pause figures were checked against land work only.</p>' : '')
      + dayNotesHtml(day));
    html(el.dayTop, dayTopHtml(detail));
    html(el.dayBottom, dayLogsHtml(day));
    html(el.mapNote, offMapHtml(day)
      + '<p class="au-cap">Pins are numbered in the order the orders were logged and joined in that order with straight lines. It is the order worked, not the roads driven.</p>');
    if(el.map){
      if(!routeMap) routeMap = createRouteMap(el.map);
      routeMap.show(day);
    }
    renderDrive(state.who, state.day, my);
  }

  let seq = 0;
  async function render(){
    const my = ++seq;
    syncControls(null);
    if(!state.who){
      html(el.period, ''); html(el.note, '<p class="au-note">Pick an installer to see their audit.</p>');
      setStatus('', 'Ready');
      return;
    }
    let raw;
    try {
      if(!raws.has(state.who)) setStatus('wait', 'Loading…');
      raw = await rawFor(state.who);
    } catch(err){
      if(my !== seq) return;
      html(el.period, '');
      html(el.note, `<p class="au-note bad">Could not load the audit for ${esc(state.who)} (${esc(err.message || 'no connection')}). `
        + 'It needs a connection. <button type="button" class="btn" id="auRetry">Try again</button></p>');
      const retry = $('auRetry');
      if(retry) retry.onclick = render;
      setStatus('off', 'Offline');
      return;
    }
    if(my !== seq) return;       // a newer pick overtook this one
    const prep = prepFor(state.who, state.mode, raw);
    syncControls(prep);
    if(state.day) renderDay(prep, my); else renderPeriod(prep);
    setStatus('', 'Loaded');
  }

  // ── wiring ─────────────────────────────────────────────────────────────────
  if(el.who){
    if(fixedInstaller || !installers) show(el.who.closest('label') || el.who, false);
    else for(const name of installers){
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      el.who.appendChild(o);
    }
    el.who.onchange = () => go({ who: el.who.value, day: '' });
  }
  if(el.mode) el.mode.onclick = e => {
    const b = e.target.closest('button[data-mode]');
    if(b && b.dataset.mode !== state.mode) go({ mode: b.dataset.mode });
  };
  if(el.from) el.from.onchange = () => go({ from: isDate(el.from.value) ? el.from.value : '' });
  if(el.to) el.to.onchange = () => go({ to: isDate(el.to.value) ? el.to.value : '' });
  if(el.all) el.all.onclick = () => go({ from: '', to: '' });
  if(el.day) el.day.onchange = () => { if(isDate(el.day.value)) go({ day: el.day.value }); };
  if(el.back) el.back.onclick = () => go({ day: '' });
  if(el.period) el.period.onclick = e => {
    const b = e.target.closest('button[data-day]');
    if(b) go({ day: b.dataset.day });
  };
  // A timeline block or a row of the log list opens that gap's detail in place.
  const pickGap = e => {
    const t = e.target.closest('[data-gap]');
    if(t) openGap(Number(t.dataset.gap));
  };
  if(el.dayTop) el.dayTop.onclick = pickGap;
  if(el.dayBottom) el.dayBottom.onclick = pickGap;
  const print = () => window.print();
  if(el.print) el.print.onclick = print;
  if(el.printDay) el.printDay.onclick = print;
  // A closed <details> prints empty. Open method and limits for the printout and
  // put it back afterwards.
  let reopened = [];
  window.addEventListener('beforeprint', () => {
    reopened = [...document.querySelectorAll('details.au-method:not([open])')];
    reopened.forEach(d => { d.open = true; });
  });
  window.addEventListener('afterprint', () => { reopened.forEach(d => { d.open = false; }); reopened = []; });
  window.addEventListener('popstate', () => { readAddress(); render(); });

  readAddress();
  render();
  return { render, toast };
}
