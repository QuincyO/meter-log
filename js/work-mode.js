// ── Work mode (boat | land) — the capture app's single source of truth ──────
// Every write the capture PWA makes is tagged `workType`, and the daily-log
// template, the end-of-day labels and the accent theme all follow it.
//
// **The control lives in Settings** (☰ ▸ ⚙︎ Settings ▸ Work mode), not the top
// bar. It sat on the bar until 2026-07-31, when boat work wound down and the
// switch was removed outright — a control a thumb can hit by accident, that
// silently retags every write and reprints the day on the wrong template, is
// worse than no control. Boat work came back on 2026-08-04, so the switch is
// back too, but behind the menu where reaching it is deliberate.
//
// **Land is the default**, and the key is new (`captureWorkMode`) for exactly
// that reason. Boat *was* the original default under the old `workMode` key, so
// every phone in the field still holds a literal `workMode='boat'` — the lock
// ignored it rather than clearing it. Reading that key again with a land
// default would do nothing: a default never fires on a key that is already set,
// so most of the fleet would come up boat. A fresh key is what makes "unset ⇒
// land" mean something. The dead one is swept below; never read it again.
//
// The mode is sticky per device: set it once, it survives reloads until someone
// sets it back. There is no daily auto-reset.
//
// This module exists separately from js/pages/capture.js because of one import
// edge: js/drive-recorder.js needs workMode() to tag its legs and cannot import
// capture.js — capture.js imports IT. It is a hard import of both, so it must
// stay in the sw.js SHELL or the capture page will not open offline.
//
// Keep this module DOM-free — `node --test` imports it. The `<html data-mode>`
// repaint that follows a change belongs to capture.js's setMode().
import { store } from './store.js';

export const MODE_KEY = 'captureWorkMode';

// One-time sweep of the dead pre-2026-08-04 key, so a phone's localStorage dump
// can't send the next person debugging a mode report down the wrong hole.
// Guarded: there is no localStorage under `node --test`.
try { localStorage.removeItem('workMode'); } catch {}

export function workMode(){
  return store.get(MODE_KEY) === 'boat' ? 'boat' : 'land';   // unset ⇒ land
}

export function setWorkMode(m){
  store.set(MODE_KEY, m === 'boat' ? 'boat' : 'land');
}
