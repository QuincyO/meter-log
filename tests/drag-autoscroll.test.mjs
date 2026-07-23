import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDragAutoScroll, edgeSpeed } from '../js/drag-autoscroll.js';

const H = 800;

test('the middle of the viewport never scrolls', () => {
  assert.equal(edgeSpeed(400, H), 0);
  assert.equal(edgeSpeed(96, H), 0);        // exactly at the band edge is still neutral
  assert.equal(edgeSpeed(H - 96, H), 0);
});

test('near the top scrolls up, near the bottom scrolls down, faster the deeper in', () => {
  assert.ok(edgeSpeed(80, H) < 0);
  assert.ok(edgeSpeed(10, H) < edgeSpeed(80, H));      // deeper = more negative
  assert.ok(edgeSpeed(H - 80, H) > 0);
  assert.ok(edgeSpeed(H - 10, H) > edgeSpeed(H - 80, H));
});

test('speed is clamped to maxSpeed and never rounds down to a dead 0', () => {
  assert.equal(edgeSpeed(0, H, 96, 18), -18);
  assert.equal(edgeSpeed(H, H, 96, 18), 18);
  assert.equal(Math.abs(edgeSpeed(95, H, 96, 18)), 1);  // one px from the band edge still moves
});

test('a viewport shorter than two edge bands does not scroll from its own middle', () => {
  // A 120px-tall viewport with a 96px band would otherwise have both zones cover
  // the centre and scroll no matter where the finger is.
  assert.equal(edgeSpeed(60, 120), 0);
  assert.ok(edgeSpeed(2, 120) < 0);
});

// A fake scroller + fake rAF: run() drains whatever the loop scheduled, so the
// test drives frames instead of waiting for them.
function harness({ limit = Infinity } = {}){
  const frames = [];
  const scrolled = [];
  let total = 0;
  const scroller = {
    height: () => H,
    scrollBy(dy){
      const next = Math.min(limit, Math.max(0, total + dy));
      const moved = next - total;
      total = next;
      if(moved) scrolled.push(moved);
      return moved;
    },
  };
  const raf = fn => { frames.push(fn); return frames.length; };
  const cancelRaf = () => {};
  return { frames, scrolled, scroller, raf, cancelRaf,
    run(n = 5){ for(let i = 0; i < n && frames.length; i++) frames.shift()(); } };
}

test('tracking a pointer in the edge zone scrolls and reports the real delta', () => {
  const h = harness();
  const seen = [];
  const auto = createDragAutoScroll({ scroller: h.scroller, raf: h.raf, cancelRaf: h.cancelRaf,
    onScroll: d => seen.push(d) });
  auto.track(H - 5);
  h.run(3);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(d => d > 0));
  assert.deepEqual(seen, h.scrolled);
});

test('a pointer back in the middle stops the loop, and it restarts on the next track', () => {
  const h = harness();
  const seen = [];
  const auto = createDragAutoScroll({ scroller: h.scroller, raf: h.raf, cancelRaf: h.cancelRaf,
    onScroll: d => seen.push(d) });
  auto.track(H - 5);
  h.run(1);
  auto.track(400);
  h.run(5);
  const after = seen.length;
  auto.track(H - 5);
  h.run(1);
  assert.equal(seen.length, after + 1);
});

test('a document already at its end keeps the loop alive but reports nothing', () => {
  const h = harness({ limit: 10 });
  const seen = [];
  const auto = createDragAutoScroll({ scroller: h.scroller, raf: h.raf, cancelRaf: h.cancelRaf,
    onScroll: d => seen.push(d) });
  auto.track(H - 1);
  h.run(4);
  assert.equal(seen.reduce((a, b) => a + b, 0), 10);   // scrolled only what was left
  assert.ok(h.frames.length > 0);                       // still scheduled — the page may grow
});

test('stop() ends the drag for good and is safe to call twice', () => {
  const h = harness();
  const seen = [];
  const auto = createDragAutoScroll({ scroller: h.scroller, raf: h.raf, cancelRaf: h.cancelRaf,
    onScroll: d => seen.push(d) });
  auto.track(5);
  auto.stop();
  auto.stop();
  auto.track(5);
  h.run(5);
  assert.equal(seen.length, 0);
});

test('both drag lists use the shared autoscroll and stop it on release', () => {
  for(const file of ['../js/worklist.js', '../js/worklist-route-view.js']){
    const js = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(js, /import \{ createDragAutoScroll \} from '\.\/drag-autoscroll\.js'/);
    assert.match(js, /createDragAutoScroll\(\{\s*onScroll:/);
    // The page moving under a still finger has to be folded back into the drag
    // anchor, or the card slides out from under it.
    assert.match(js, /startY -= delta;\s*\n\s*applyMove\(lastY\);/);
    assert.match(js, /scroller\.track\(ev\.clientY\)/);
    assert.match(js, /scroller\.stop\(\)/);
  }
});

test('the service worker ships the new module', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\.\/js\/drag-autoscroll\.js'/);
  assert.match(sw, /const CACHE = 'meterlog-v26'/);
});
