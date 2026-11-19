// js/audit-view.js is wiring: controls, the address bar, what is on screen. It is
// driven here against a small fake DOM with fetch stubbed, because the mistakes it
// can make are about ORDER, not arithmetic: an answer that arrives late, a read
// that fails after another installer's day was on screen. Each test file runs in
// its own process, so the globals set here leak nowhere. Made-up people only.
import test from 'node:test';
import assert from 'node:assert/strict';

function mkEl(id){
  const cls = new Set();
  return { id, innerHTML: '', textContent: '', value: '', disabled: false, dataset: {}, children: [],
    classList: { add: (...a) => a.forEach(x => cls.add(x)), remove: (...a) => a.forEach(x => cls.delete(x)),
      toggle: (x, on) => { (on === undefined ? !cls.has(x) : on) ? cls.add(x) : cls.delete(x); },
      contains: x => cls.has(x) },
    get hidden(){ return cls.has('hide'); },
    setAttribute(){}, appendChild(c){ this.children.push(c); }, closest(){ return null; },
    querySelectorAll(){ return this.buttons || []; } };
}
const IDS = ['status', 'statusText', 'auWho', 'auMode', 'auFrom', 'auTo', 'auAll', 'auDay', 'auPrint',
  'auPrintDay', 'auPeriodControls', 'auDayControls', 'auBack', 'auPrev', 'auNext', 'auDayTitle',
  'auPrintHead', 'auNote', 'auPeriod', 'auDayView', 'auDayTop', 'auDayBottom', 'auRouteCard', 'auDrive',
  'auMap', 'auMapNote', 'toast', 'auSend', 'auSendDay'];

const pad = n => String(n).padStart(2, '0');
const dayOf = (date, who, n = 9) => Array.from({ length: n }, (_, i) => ({ id: `${who}-${date}-${i}`,
  timestamp: `${date} ${pad(9 + Math.floor(i * 12 / 60))}:${pad(i * 12 % 60)}:00`, status: 'INSTALLED',
  workOrderId: `${who[0]}${i}`, address: `${who} Street`, lat: 44.1 + i * 0.0001, lng: -79.1 }));
const DATA = {
  'Pat Example': { ok: true, stops: [...dayOf('2026-11-02', 'Pat'), ...dayOf('2026-11-03', 'Pat')], downtime: [], days: [] },
  'Sam Other': { ok: true, stops: dayOf('2026-11-03', 'Sam'), downtime: [], days: [] },
};

// One fake page. `answer(installer)` decides each audit read: an object to resolve
// with, 'fail' to reject, or 'hold' to leave it pending until release() is called.
async function boot({ search = '', answer = who => DATA[who], fixedInstaller = null, loadDriveLegs = null, savePdf, share, loadRoads = async () => null } = {}){
  const els = Object.fromEntries(IDS.map(id => [id, mkEl(id)]));
  els.auMode.buttons = ['land', 'boat', 'all'].map(m => { const b = mkEl('mode'); b.dataset.mode = m; return b; });
  els.auDayView.classList.add('hide'); els.auDayControls.classList.add('hide');
  // as in the markup: Send PDF is hidden until the script finds the browser can share a file
  for(const id of ['auSend', 'auSendDay']){ els[id].classList.add('hide'); els[id].textContent = 'Send PDF'; }
  const listeners = {}, requests = [], held = [], scrolls = [], prints = [];
  // the drive-log checkbox is drawn by the view; it exists once its markup does
  globalThis.document = { getElementById: id => els[id] || (id === 'auDriveOn' && /id="auDriveOn"/.test(els.auDrive.innerHTML)
      ? (els.auDriveOn = mkEl('auDriveOn')) : null),
    querySelectorAll: () => [], createElement: () => mkEl('new') };
  globalThis.location = { search, pathname: '/audits.html' };
  globalThis.history = { pushState(_, __, url){ const q = url.indexOf('?'); location.search = q < 0 ? '' : url.slice(q); } };
  globalThis.window = { addEventListener: (k, f) => { listeners[k] = f; }, print(){ prints.push(1); }, scrollTo: (x, y) => scrolls.push([x, y]) };
  globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
  globalThis.fetch = url => {
    const u = new URL(url), who = u.searchParams.get('installer');
    requests.push(u.searchParams.get('action') + ':' + who);
    const a = answer(who);
    if(a === 'fail') return Promise.reject(new Error('Failed to fetch'));
    const reply = { json: async () => (a === 'hold' ? DATA[who] : a) };
    return a === 'hold' ? new Promise(res => held.push(() => res(reply))) : Promise.resolve(reply);
  };
  const { initAuditView } = await import('../js/audit-view.js');
  initAuditView({ installers: fixedInstaller ? null : Object.keys(DATA), fixedInstaller, loadDriveLegs, ...(savePdf ? { savePdf } : {}),
    ...(share ? { share } : {}), loadRoads });
  const settle = async () => { for(let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  await settle();
  return { els, requests, scrolls, listeners, prints, settle,
    release: async () => { while(held.length) held.shift()(); await settle(); },
    pick: async who => { els.auWho.value = who; els.auWho.onchange(); await settle(); },
    openDay: async date => { els.auPeriod.onclick({ target: { closest: () => ({ dataset: { day: date } }) } }); await settle(); },
    typeDay: async date => { els.auDay.value = date; els.auDay.onchange(); await settle(); },
    text: id => els[id].innerHTML.replace(/<[^>]+>/g, ' ') };
}
const onScreen = p => ['auPeriod', 'auDayTop', 'auDayBottom', 'auMapNote', 'auPrintHead', 'auDayTitle']
  .filter(id => !p.els[id].hidden).map(id => p.els[id].innerHTML + p.els[id].textContent).join(' ');

test('an installer\'s audit loads once and a day opens from the table', async () => {
  const p = await boot();
  assert.match(p.text('auNote'), /Pick an installer/);
  await p.pick('Pat Example');
  assert.match(p.els.auPeriod.innerHTML, /Day by day/);
  assert.equal(p.els.statusText.textContent, 'Loaded');
  await p.openDay('2026-11-02');
  assert.equal(location.search, '?who=Pat+Example&day=2026-11-02');
  assert.equal(p.els.auDayView.hidden, false);
  assert.equal(p.els.auPeriod.hidden, true);
  assert.match(p.els.auDayTop.innerHTML, /Timeline of the day/);
  assert.equal(p.els.auDayTitle.textContent, 'Mon Nov 2, 2026');
  p.els.auBack.onclick(); await p.settle();
  p.els.auMode.onclick({ target: { closest: () => ({ dataset: { mode: 'all' } }) } }); await p.settle();
  p.els.auFrom.value = '2026-11-03'; p.els.auFrom.onchange(); await p.settle();
  assert.deepEqual(p.requests, ['audit:Pat Example'], 'mode, range and day changes ask for nothing more');
});

test('a failed read never leaves the previous installer\'s day on screen', async () => {
  let fail = false;
  const p = await boot({ answer: who => (fail && who === 'Sam Other' ? 'fail' : DATA[who]) });
  await p.pick('Pat Example');
  await p.openDay('2026-11-02');
  assert.match(onScreen(p), /P0/);                  // Pat's first order is on screen
  p.els.auBack.onclick(); await p.settle();
  fail = true;
  await p.pick('Sam Other');
  assert.match(p.text('auNote'), /Could not load the audit for Sam Other/);
  await p.typeDay('2026-11-03');
  assert.match(p.text('auNote'), /Could not load the audit for Sam Other/);
  assert.doesNotMatch(onScreen(p), /Pat Street|Pat Example|P0|Nov 2/, 'nothing of the installer before');
  assert.equal(p.els.auDayView.hidden, true);
  assert.equal(p.els.auPeriodControls.hidden, false, 'the picker stays reachable');
});

test('a day in the address with no installer picked shows no empty day view', async () => {
  const p = await boot({ search: '?day=2026-11-02' });
  assert.match(p.text('auNote'), /Pick an installer/);
  assert.equal(p.els.auDayView.hidden, true);
  assert.equal(p.els.auPeriodControls.hidden, false);
  assert.deepEqual(p.requests, []);
});

test('an answer that arrives late cannot overwrite a newer pick', async () => {
  const p = await boot({ answer: who => (who === 'Pat Example' ? 'hold' : DATA[who]) });
  await p.pick('Pat Example');                 // still waiting
  await p.pick('Sam Other');                   // answers at once
  assert.match(onScreen(p), /Sam Example|Sam Other/);
  await p.release();                           // Pat's answer lands now
  assert.match(p.els.auPrintHead.innerHTML, /Sam Other/);
  assert.doesNotMatch(onScreen(p), /Pat Example/);
});

test('opening a day starts at the top of the page; the browser\'s Back does not jump', async () => {
  const p = await boot();
  await p.pick('Pat Example');
  assert.deepEqual(p.scrolls, []);
  await p.openDay('2026-11-02');
  assert.deepEqual(p.scrolls, [[0, 0]]);
  location.search = '?who=Pat+Example';
  p.listeners.popstate(); await p.settle();
  assert.deepEqual(p.scrolls, [[0, 0]], 'Back keeps the place the browser restores');
  assert.equal(p.els.auDayView.hidden, true);
});

test('the drive log is asked for only when the office page gave a loader', async () => {
  const asked = [];
  const office = await boot({ search: '?who=Pat+Example&day=2026-11-02', loadDriveLegs: async (who, date) => { asked.push(who + '|' + date); return []; } });
  assert.deepEqual(asked, ['Pat Example|2026-11-02']);
  assert.match(office.els.auDrive.innerHTML, /No drive log was recorded this day/);
  const phone = await boot({ search: '?day=2026-11-02', fixedInstaller: 'Pat Example' });
  assert.equal(phone.els.auDrive.innerHTML, '');
  assert.match(phone.els.auDayTop.innerHTML, /Timeline of the day/);
  assert.deepEqual(phone.requests, ['audit:Pat Example']);
});

// ── Download PDF ─────────────────────────────────────────────────────────────

const routeOf = model => model.sections.find(s => s.title === 'Route worked');

test('Download PDF hands over what is on screen: the period, then the day', async () => {
  const saved = [];
  const p = await boot({ savePdf: async model => { saved.push(model); return model.fileName; } });
  await p.pick('Pat Example');
  await p.els.auPrint.onclick(); await p.settle();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].fileName, 'Audit - Pat Example - 2026-11-02 to 2026-11-03.pdf');
  assert.equal(saved[0].title, 'Audit: Pat Example');
  assert.deepEqual(saved[0].sections.map(s => s.title).slice(0, 2), ['Headline', 'Where an average day goes']);
  assert.match(p.els.toast.textContent, /Saved Audit - Pat Example - 2026-11-02 to 2026-11-03\.pdf/);
  await p.openDay('2026-11-02');
  await p.els.auPrintDay.onclick(); await p.settle();
  assert.equal(saved[1].fileName, 'Audit - Pat Example - 2026-11-02.pdf');
  assert.deepEqual(saved[1].sections.map(s => s.title), ['Timeline of the day', 'Pace on this route', 'This day, and how it compares',
    'Delays logged this day', 'Route worked', 'Every log, in order', 'Method and limits']);
  assert.deepEqual(p.prints, [], 'the print dialog is never opened');
  assert.equal(p.els.auPrintDay.disabled, false);
});

test('the day PDF carries the drive log only on the office page, and its line only when switched on', async () => {
  const legs = [{ distanceM: 31400, driveMin: 52, maxSpeed: 23.4, gaps: [], startTime: 0, encoded: '' }];
  const saved = [];
  const savePdf = async model => { saved.push(model); return model.fileName; };
  const office = await boot({ search: '?who=Pat+Example&day=2026-11-02', loadDriveLegs: async () => legs, savePdf });
  await office.els.auPrintDay.onclick(); await office.settle();
  let route = routeOf(saved[0]);
  assert.match(route.blocks[0].text, /^Top 84 km\/h/);
  assert.equal(route.blocks.find(b => b.t === 'map').legs, null, 'switched off: the numbers, not the line');
  const box = document.getElementById('auDriveOn');
  box.checked = true; box.onchange();
  await office.els.auPrintDay.onclick(); await office.settle();
  route = routeOf(saved[1]);
  assert.equal(route.blocks.find(b => b.t === 'map').legs, legs);

  const none = await boot({ search: '?who=Pat+Example&day=2026-11-02', loadDriveLegs: async () => [], savePdf });
  await none.els.auPrintDay.onclick(); await none.settle();
  assert.equal(routeOf(saved[2]).blocks[0].text, 'No drive log was recorded this day.');

  const phone = await boot({ search: '?day=2026-11-02', fixedInstaller: 'Pat Example', savePdf });
  await phone.els.auPrintDay.onclick(); await phone.settle();
  route = routeOf(saved[3]);
  assert.equal(route.blocks[0].t, 'map');
  assert.equal(route.blocks[0].legs, null);
  assert.doesNotMatch(JSON.stringify(route.blocks.filter(b => b.t === 'cap')), /drive log|km\/h/i);
});

test('with nothing on screen there is nothing to download, and a failure says so', async () => {
  const saved = [];
  const p = await boot({ savePdf: async model => { saved.push(model); throw new Error('no library'); } });
  await p.els.auPrint.onclick(); await p.settle();
  assert.deepEqual(saved, [], 'no installer picked');
  assert.match(p.els.toast.textContent, /Nothing to download/);
  await p.pick('Pat Example');
  await p.typeDay('2026-12-25');                       // a date with no logs
  await p.els.auPrintDay.onclick(); await p.settle();
  assert.deepEqual(saved, []);
  p.els.auBack.onclick(); await p.settle();
  await p.els.auPrint.onclick(); await p.settle();
  assert.equal(saved.length, 1);
  assert.match(p.els.toast.textContent, /Could not make the PDF/);
  assert.equal(p.els.auPrint.disabled, false, 'the button comes back after a failure');
});

// ── Send PDF ─────────────────────────────────────────────────────────────────
// A stand-in for the system share sheet. `outcomes` is what each send() does in
// turn: nothing to succeed, or the name of the error a browser would reject with.

function fakeShare({ can = true, outcomes = [], failBuild = false } = {}){
  const log = { built: [], sent: [], saved: [] };
  return { log, can: () => can,
    file: async model => { log.built.push(model); if(failBuild) throw new Error('no library'); return { name: model.fileName, model }; },
    send: file => { log.sent.push(file); const o = outcomes.shift();
      return o ? Promise.reject(Object.assign(new Error(o), { name: o })) : Promise.resolve(); },
    save: file => { log.saved.push(file); } };
}
const DAY_URL = '?who=Pat+Example&day=2026-11-02';

test('Send PDF shows only where the browser can hand a file to another app', async () => {
  const yes = await boot({ share: fakeShare() });
  assert.equal(yes.els.auSend.hidden, false);
  assert.equal(yes.els.auSendDay.hidden, false);
  const no = await boot({ share: fakeShare({ can: false }) });
  assert.equal(no.els.auSend.hidden, true);
  assert.equal(no.els.auSendDay.hidden, true);
});

test('Send PDF hands what is on screen to the share sheet as a file, and downloads nothing', async () => {
  const share = fakeShare(), downloads = [];
  const p = await boot({ search: DAY_URL, share, savePdf: async m => { downloads.push(m); return m.fileName; } });
  await p.els.auSendDay.onclick(); await p.settle();
  assert.equal(share.log.built.length, 1);
  assert.equal(share.log.built[0].fileName, 'Audit - Pat Example - 2026-11-02.pdf');
  assert.ok(share.log.built[0].sections.some(s => s.title === 'Timeline of the day'));
  assert.equal(share.log.sent.length, 1);
  assert.equal(share.log.sent[0].name, 'Audit - Pat Example - 2026-11-02.pdf');
  assert.deepEqual(share.log.saved, []);
  assert.deepEqual(downloads, []);
  assert.equal(p.els.toast.textContent, '', 'the share sheet is the feedback; nothing claims it was sent');
  assert.equal(p.els.auSendDay.disabled, false);
  assert.equal(p.els.auSendDay.textContent, 'Send PDF');
  p.els.auBack.onclick(); await p.settle();
  await p.els.auSend.onclick(); await p.settle();
  assert.equal(share.log.sent[1].name, 'Audit - Pat Example - 2026-11-02 to 2026-11-03.pdf');
});

test('a browser that wants a fresh tap gets one: the file is kept and the second tap sends it', async () => {
  const share = fakeShare({ outcomes: ['NotAllowedError'] });
  const p = await boot({ search: DAY_URL, share });
  await p.els.auSendDay.onclick(); await p.settle();
  assert.match(p.els.toast.textContent, /Tap Send PDF again/);
  assert.deepEqual(share.log.saved, []);
  await p.els.auSendDay.onclick(); await p.settle();
  assert.equal(share.log.built.length, 1, 'not built a second time');
  assert.equal(share.log.sent.length, 2);
  assert.equal(share.log.sent[1], share.log.sent[0]);
  assert.deepEqual(share.log.saved, []);
});

test('a kept file is never sent for a different view', async () => {
  const share = fakeShare({ outcomes: ['NotAllowedError'] });
  const p = await boot({ search: DAY_URL, share });
  await p.els.auSendDay.onclick(); await p.settle();
  await p.typeDay('2026-11-03');
  await p.els.auSendDay.onclick(); await p.settle();
  assert.equal(share.log.built.length, 2);
  assert.equal(share.log.sent[1].name, 'Audit - Pat Example - 2026-11-03.pdf');

  // the office's "Show drive log" changes what the PDF draws, so it is a different file too
  const legs = [{ distanceM: 31400, driveMin: 52, maxSpeed: 23.4, gaps: [], startTime: 0, encoded: '' }];
  const office = fakeShare();
  const o = await boot({ search: DAY_URL, loadDriveLegs: async () => legs, share: office });
  await o.els.auSendDay.onclick(); await o.settle();
  await o.els.auSendDay.onclick(); await o.settle();
  assert.equal(office.log.built.length, 1, 'the same view is not rebuilt');
  const box = document.getElementById('auDriveOn');
  box.checked = true; box.onchange();
  await o.els.auSendDay.onclick(); await o.settle();
  assert.equal(office.log.built.length, 2);
  assert.equal(routeOf(office.log.built[1]).blocks.find(b => b.t === 'map').legs, legs);
});

test('closing the share sheet is not an error, and a browser that cannot share after all saves the file instead', async () => {
  const share = fakeShare({ outcomes: ['AbortError', 'DataError'] });
  const p = await boot({ search: DAY_URL, share });
  await p.els.auSendDay.onclick(); await p.settle();
  assert.equal(p.els.toast.textContent, '');
  assert.deepEqual(share.log.saved, []);
  await p.els.auSendDay.onclick(); await p.settle();
  assert.equal(share.log.saved.length, 1);
  assert.equal(share.log.saved[0], share.log.sent[0]);
  assert.match(p.els.toast.textContent, /Saved Audit - Pat Example - 2026-11-02\.pdf instead/);

  // refused twice, the second time inside the tap itself: stop asking and save it
  const twice = fakeShare({ outcomes: ['NotAllowedError', 'NotAllowedError'] });
  const q = await boot({ search: DAY_URL, share: twice });
  await q.els.auSendDay.onclick(); await q.settle();
  await q.els.auSendDay.onclick(); await q.settle();
  assert.equal(twice.log.saved.length, 1);
  assert.match(q.els.toast.textContent, /Saved .* instead/);
});

test('with nothing on screen there is nothing to send, and a PDF that cannot be built says so', async () => {
  const share = fakeShare({ failBuild: true });
  const p = await boot({ share });
  await p.els.auSend.onclick(); await p.settle();
  assert.deepEqual(share.log.built, []);
  assert.match(p.els.toast.textContent, /Nothing to send/);
  await p.pick('Pat Example');
  await p.els.auSend.onclick(); await p.settle();
  assert.match(p.els.toast.textContent, /Could not make the PDF/);
  assert.deepEqual(share.log.sent, []);
  assert.equal(p.els.auSend.disabled, false);
  assert.equal(p.els.auSend.textContent, 'Send PDF');
});

// ── the offline road map ─────────────────────────────────────────────────────

const fakeRoads = log => async stops => { log.push(stops.length);
  return { name: 'Test District', km: () => 1.2, path: (a, b) => [[a.lat, a.lng], [a.lat + 0.0005, a.lng - 0.0005], [b.lat, b.lng]] }; };

test('with a road map on the device the audit is measured by road and the day\'s line follows the roads', async () => {
  const asked = [], saved = [];
  const p = await boot({ search: DAY_URL, loadRoads: fakeRoads(asked), savePdf: async m => { saved.push(m); return m.fileName; } });
  assert.deepEqual(asked, [18], 'asked once, with that installer\'s stops');
  assert.match(p.text('auNote'), /Distances between orders are by road, from the offline road map on this device \(Test District\)\./);
  assert.match(p.text('auMapNote'), /follows the roads on the offline road map/);
  assert.match(p.els.auDayTop.innerHTML, /Distance between orders, by road, km/);
  await p.els.auPrintDay.onclick(); await p.settle();
  const route = routeOf(saved[0]), map = route.blocks.find(b => b.t === 'map');
  assert.equal(map.lines.length, 8, 'one line per gap between the nine pinned orders');
  assert.ok(map.lines.every(l => l.length === 5), 'each from its pin, along the road, to the next pin');
  assert.match(route.blocks.at(-1).text, /follows the roads on the offline road map/);
  // another mode, and back to the period: the road map is not read again
  p.els.auBack.onclick(); await p.settle();
  p.els.auMode.buttons[2].onclick && p.els.auMode.buttons[2].onclick(); await p.settle();
  assert.deepEqual(asked, [18]);
  await p.pick('Sam Other');
  assert.deepEqual(asked, [18, 9], 'once per installer');
});

test('without a road map, or when reading it fails, the audit is straight lines and still loads', async () => {
  const saved = [];
  const plain = await boot({ search: DAY_URL, savePdf: async m => { saved.push(m); return m.fileName; } });
  assert.doesNotMatch(plain.text('auNote'), /road/);
  assert.match(plain.text('auMapNote'), /joined in that order with straight lines/);
  await plain.els.auPrintDay.onclick(); await plain.settle();
  assert.equal(routeOf(saved[0]).blocks.find(b => b.t === 'map').lines, null);
  const broken = await boot({ search: DAY_URL, loadRoads: async () => { throw new Error('corrupt pack'); } });
  assert.match(broken.els.auDayTop.innerHTML, /Timeline of the day/);
  assert.match(broken.text('auMapNote'), /straight lines/);
});
