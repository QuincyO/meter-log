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
import { MODE_LABEL, NO_DRIVE_LOG, ROUTE_CAPTION, periodHtml, notesHtml, dayTopHtml, dayLogsHtml, gapDetailHtml,
  dayNotesHtml, driveLineHtml } from './audit-render.js';
import { createRouteMap, offMapHtml } from './audit-map.js';
import { periodPdfModel, dayPdfModel, downloadAuditPdf, auditPdfShare } from './audit-pdf.js';

const MODES = ['land', 'boat', 'all'];
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const todayKey = () => { const n = new Date(), p = x => ('0' + x).slice(-2);
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`; };

/** installers: string[] | null — the office's picker. fixedInstaller: string | null
 *  — the phone's one name (hides the picker). loadDriveLegs: (installer, date) =>
 *  Promise<object[]>, office only. savePdf: what "Download PDF" hands its model to
 *  (the real download unless a test passes its own). share: the system share sheet
 *  behind "Send PDF" ({ can, file, send, save }; js/audit-pdf.js unless a test passes its own). */
export function initAuditView({ installers = null, fixedInstaller = null, loadDriveLegs = null,
  savePdf = downloadAuditPdf, share = auditPdfShare } = {}){
  const el = {
    status: $('status'), statusText: $('statusText'),
    who: $('auWho'), mode: $('auMode'), from: $('auFrom'), to: $('auTo'), all: $('auAll'),
    day: $('auDay'), print: $('auPrint'), printDay: $('auPrintDay'),
    send: $('auSend'), sendDay: $('auSendDay'),
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
    const opensDay = !!change.day && change.day !== state.day;
    Object.assign(state, change);
    try { history.pushState(null, '', address()); } catch {}
    render();
    // A day is opened from the bottom of a long page; start it at the top. Not on
    // popstate: the browser restores its own place for Back and Forward.
    if(opensDay) try { window.scrollTo(0, 0); } catch {}
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

  // What is on screen, kept so "Download PDF" can write exactly that: the period
  // with its statistics, or the day with its detail. Null while there is nothing.
  let current = null;

  function renderPeriod(prep){
    const stats = periodStats(prep, { from: state.from, to: state.to });
    current = { kind: 'period', prep, stats };
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
      if(!legs.length){ html(el.drive, `<p class="au-cap">${esc(NO_DRIVE_LOG)}</p>`); return; }
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
      shownDay = null; current = null;
      show(el.dayView, false);
      html(el.note, (prep.mode !== 'land' ? '<p class="au-note warn">The pause figures were checked against land work only.</p>' : '')
        + `<p class="au-note">No logs on ${esc(fmtDate(state.day))} for ${esc(state.who)} in this view.</p>`);
      return;
    }
    const day = shownDay = detail.day;
    current = { kind: 'day', prep, detail };
    html(el.note, dayNotesHtml(day, prep.mode));
    html(el.dayTop, dayTopHtml(detail));
    html(el.dayBottom, dayLogsHtml(day));
    html(el.mapNote, offMapHtml(day)
      + `<p class="au-cap">${esc(ROUTE_CAPTION)}</p>`);
    if(el.map){
      if(!routeMap) routeMap = createRouteMap(el.map);
      routeMap.show(day);
    }
    renderDrive(state.who, state.day, my);
  }

  // Nothing to show: no installer picked, or the read failed. Whatever was drawn
  // for the installer before must go, the day view above all. Leaving it up shows
  // one person's day under another person's name. The period controls come back
  // so the picker stays reachable even with a day in the address.
  function blank(note){
    shownDay = null; current = null;
    for(const node of [el.period, el.dayTop, el.dayBottom, el.mapNote, el.drive, el.printHead]) html(node, '');
    if(el.dayTitle) el.dayTitle.textContent = '';
    show(el.dayView, false); show(el.dayControls, false);
    show(el.periodControls, true); show(el.period, true);
    html(el.note, note);
  }

  let seq = 0;
  async function render(){
    const my = ++seq;
    syncControls(null);
    if(!state.who){
      blank('<p class="au-note">Pick an installer to see their audit.</p>');
      setStatus('', 'Ready');
      return;
    }
    let raw;
    try {
      if(!raws.has(state.who)) setStatus('wait', 'Loading…');
      raw = await rawFor(state.who);
    } catch(err){
      if(my !== seq) return;
      blank(`<p class="au-note bad">Could not load the audit for ${esc(state.who)} (${esc(err.message || 'no connection')}). `
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
  // "Download PDF": the same sections that are on screen, written as a document
  // (js/audit-pdf.js). On the office page a day's PDF carries the drive-log numbers
  // when the day has legs, and the track itself only while "Show drive log" is on.
  // The two buttons keep the ids they had as Print buttons, so a page whose markup
  // and script are briefly out of step still has a working button.
  function driveForPdf(){
    if(!loadDriveLegs) return null;
    const legs = driveLegs.get(state.who + '|' + state.day);
    if(!legs) return null;                     // still loading, or the read failed
    const box = $('auDriveOn');
    return { legs, show: !!(box && box.checked) };
  }
  function pdfModel(){
    const today = todayKey();
    return current.kind === 'day'
      ? dayPdfModel({ name: state.who, prep: current.prep, detail: current.detail, drive: driveForPdf(), today })
      : periodPdfModel({ name: state.who, prep: current.prep, stats: current.stats, today });
  }
  async function download(button){
    if(!current){ toast('Nothing to download yet'); return; }
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Building…';
    try {
      toast('Saved ' + await savePdf(pdfModel()));
    } catch {
      toast('Could not make the PDF');
    } finally {
      button.disabled = false; button.textContent = label;
    }
  }
  if(el.print) el.print.onclick = () => download(el.print);
  if(el.printDay) el.printDay.onclick = () => download(el.printDay);

  // "Send PDF": the same file, handed to the phone's share sheet. The page sends
  // nothing itself; the person picks the app and the recipient there.
  //
  // A browser opens the share sheet only as the direct result of a tap, and building
  // the first PDF (the library has to load) can outlast what it counts as "direct".
  // So the built file is KEPT. If the browser refuses for that reason, the person is
  // asked to tap again, and that second tap shares the kept file at once, with
  // nothing awaited in between. Refused even then, the file is saved instead.
  // The kept file is only ever reused for the very view it was built from.
  let ready = null;                            // { key, file }
  function pdfKey(){ const d = driveForPdf(); return [current, d && d.legs, d && d.show]; }
  const sameKey = (a, b) => a.every((x, i) => x === b[i]);
  async function hand(file, tappedAgain){
    try {
      await share.send(file);
    } catch(e){
      const why = e && e.name;
      if(why === 'AbortError') return;         // they closed the share sheet
      if(why === 'NotAllowedError' && !tappedAgain){ toast('Ready. Tap Send PDF again'); return; }
      try { share.save(file); toast(`Saved ${file.name} instead`); }
      catch { toast('Could not send the PDF'); }
    }
  }
  async function send(button){
    if(!current){ toast('Nothing to send yet'); return; }
    const key = pdfKey();
    if(ready && sameKey(ready.key, key)) return hand(ready.file, true);
    ready = null;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Building…';
    let file;
    try {
      file = await share.file(pdfModel());
    } catch {
      toast('Could not make the PDF'); return;
    } finally {
      button.disabled = false; button.textContent = label;
    }
    ready = { key, file };
    return hand(file, false);
  }
  // Shown only where the browser can hand over a file. The markup ships them hidden,
  // so a page whose script is older than its markup shows no dead button.
  const canSend = share.can();
  for(const button of [el.send, el.sendDay]){
    if(!button) continue;
    show(button, canSend);
    button.onclick = () => send(button);
  }
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
