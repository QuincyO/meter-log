import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the real health check without starting the HTTP listener or requiring
// Docker on the test machine. Only the external command result is substituted.
const source = readFileSync(new URL('../tools/roadpack-server.mjs', import.meta.url), 'utf8');
const checkSource = source.match(/async function dockerUp\(\)\{[\s\S]*?\n\}/)[0];
const check = result => new Function('run', `${checkSource}; return dockerUp();`)(async () => result);

test('a responding Docker engine is ready', async () => {
  assert.deepEqual(await check({ code:0, err:'' }), { ok:true });
});

for(const err of [
  'permission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine',
  'WARNING: Error loading config file: open C:\\Users\\Quincy\\.docker\\config.json: Access is denied.',
  'spawn docker EACCES',
]){
  test(`Docker access failure identifies helper permissions: ${err}`, async () => {
    const result = await check({ code:err.startsWith('spawn') ? -1 : 1, err });
    assert.equal(result.ok, false);
    assert.match(result.reason, /permission|access/i);
    assert.match(result.reason, /restart.*helper.*normal.*account/i);
    assert.ok(result.reason.includes(err), 'keep the actual Docker diagnostic');
    assert.doesNotMatch(result.reason, /Desktop is not running/);
  });
}

test('a missing Docker executable is distinguished from an unreachable engine', async () => {
  const result = await check({ code:-1, err:'spawn docker ENOENT' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not installed|PATH/);
});

test('other Docker failures retain their cause instead of claiming Desktop is closed', async () => {
  const err = 'Error response from daemon: client version 1.55 is too new. Maximum supported API version is 1.44';
  const result = await check({ code:1, err });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes(err));
  assert.doesNotMatch(result.reason, /Desktop is not running/);
});

test('a Docker failure without stderr still explains that the engine is unreachable', async () => {
  const result = await check({ code:1, err:'' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot connect|could not connect|unreachable/i);
});
