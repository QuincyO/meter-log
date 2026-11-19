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
  'auMap', 'auMapNote', 'toast'];

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
async function boot({ search = '', answer = who => DATA[who], fixedInstaller = null, loadDriveLegs = null } = {}){
  const els = Object.fromEntries(IDS.map(id => [id, mkEl(id)]));
  els.auMode.buttons = ['land', 'boat', 'all'].map(m => { const b = mkEl('mode'); b.dataset.mode = m; return b; });
  els.auDayView.classList.add('hide'); els.auDayControls.classList.add('hide');
  const listeners = {}, requests = [], held = [], scrolls = [];
  globalThis.document = { getElementById: id => els[id] || null, querySelectorAll: () => [], createElement: () => mkEl('new') };
  globalThis.location = { search, pathname: '/audits.html' };
  globalThis.history = { pushState(_, __, url){ const q = url.indexOf('?'); location.search = q < 0 ? '' : url.slice(q); } };
  globalThis.window = { addEventListener: (k, f) => { listeners[k] = f; }, print(){}, scrollTo: (x, y) => scrolls.push([x, y]) };
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
  initAuditView({ installers: fixedInstaller ? null : Object.keys(DATA), fixedInstaller, loadDriveLegs });
  const settle = async () => { for(let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  await settle();
  return { els, requests, scrolls, listeners, settle,
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
