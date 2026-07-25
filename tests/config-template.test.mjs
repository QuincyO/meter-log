import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const live = read('js/config.js');
const tmpl = read('js/config.example.js');

// js/config.example.js is the credential-free copy of js/config.js that ships in a
// handoff bundle (scripts/make-handoff.mjs). Two ways it can rot, both of which put
// a second developer's copy back on someone else's deployment:
//   1. a new constant is added to config.js and not the template — the copied file
//      is missing an export and every page that imports it dies on load;
//   2. a real credential is pasted into the template by accident.
// See ONBOARDING.md and AGENTS.md §"Working with a second tenant".

const exportsOf = src => [...src.matchAll(/^export const (\w+)/gm)].map(m => m[1]).sort();

test('the template exports exactly the same names as the live config', () => {
  assert.deepEqual(exportsOf(tmpl), exportsOf(live),
    'js/config.js and js/config.example.js have drifted — a copied template must be a ' +
    'drop-in replacement, so every export in one must exist in the other');
});

test('the template carries no real credentials', () => {
  // Apps Script deployment ids, Google API keys, and the ORS token's fixed prefix.
  // These are the same patterns scripts/make-handoff.mjs greps its own output for.
  for(const [pattern, what] of [
    [/AKfycb/,                  'an Apps Script deployment id'],
    [/AIza/,                    'a Google API key'],
    [/script\.google\.com\/macros/, 'a Web App /exec URL'],
    [/eyJvcmci/,                'an OpenRouteService token'],
  ]) assert.ok(!pattern.test(tmpl),
    `js/config.example.js contains ${what} — the template must never hold a live credential`);
});

test('the template requires the two values that point at a tenant', () => {
  // Placeholders, not blanks: CONFIG_READY keys off the PASTE_YOUR_ prefix, and a
  // blank URL would read as "misconfigured" rather than "not configured yet".
  assert.match(tmpl, /export const WEB_APP_URL\s*=\s*'PASTE_YOUR_[A-Z_]+'/);
  assert.match(tmpl, /export const SHARED_TOKEN\s*=\s*'PASTE_YOUR_[A-Z_]+'/);
  // The optional provider keys must ship blank — blank is a supported working state
  // (straight-line routing), a placeholder string would be sent as a real key.
  assert.match(tmpl, /export const GMAPS_API_KEY\s*=\s*''/);
  assert.match(tmpl, /export const ORS_API_KEY\s*=\s*''/);
});

test('both files carry the preflight guard, keyed on the same sentinel', () => {
  // CONFIG_READY is what stops an unconfigured copy from reaching a spine at all
  // (js/api.js throws, js/queue.js holds the queue). It has to survive in the LIVE
  // file too — that is the copy a handoff bundle overwrites, and the one that would
  // otherwise let a placeholder build quietly post to production.
  for(const [src, name] of [[live, 'js/config.js'], [tmpl, 'js/config.example.js']]){
    assert.match(src, /export const CONFIG_READY\s*=/, `${name} lost its CONFIG_READY guard`);
    assert.match(src, /PASTE_YOUR_/, `${name}'s guard no longer tests the PASTE_YOUR_ sentinel`);
  }
});

test('the live config is not left on placeholders', () => {
  // Guards against committing a blanked js/config.js to a tenant's own repo — a push
  // to main here is a production deploy, so that would ship a dead app to the crew.
  // Skipped when config.js IS the template: that is an un-configured handoff bundle,
  // where the developer is expected to run the suite before filling anything in.
  if(/PASTE_YOUR_/.test(live.replace(/^const filled =.*$/m, ''))) return;
  assert.match(live, /export const WEB_APP_URL\s*=\s*'https:\/\/script\.google\.com\/macros\//);
  assert.ok(/export const SHARED_TOKEN\s*=\s*'.{8,}'/.test(live),
    'js/config.js has no usable SHARED_TOKEN');
});
