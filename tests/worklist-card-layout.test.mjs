import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../css/capture.css', import.meta.url), 'utf8');

function rule(selector){
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] || '';
}

test('worklist card reserves a full row for mobile actions', () => {
  assert.match(rule('.wl-card'), /display\s*:\s*grid/);
  assert.match(rule('.wl-main'), /grid-column\s*:\s*3/);
  assert.match(rule('.wl-actions'), /grid-column\s*:\s*1\s*\/\s*-1/);
  assert.match(rule('.wl-actions'), /width\s*:\s*100%/);
  assert.match(rule('.wl-actions'), /flex-wrap\s*:\s*nowrap/);
});

test('the action row wraps on the narrowest phones instead of clipping labels', () => {
  // Six actions fit one line from 360px up. At 320px they do not, and shrinking
  // them clipped "Use →" and "Edit" down to unreadable stubs.
  const narrow = css.match(/@media \(max-width:359px\)\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(narrow, /\.wl-actions\{[^}]*flex-wrap\s*:\s*wrap/);
  assert.match(narrow, /\.wl-use\{[^}]*flex\s*:\s*1 1 100%/);
});
