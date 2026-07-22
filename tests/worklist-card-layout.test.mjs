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
