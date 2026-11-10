import test from 'node:test';
import assert from 'node:assert/strict';

import { ownerOf, isOwner, isAllowed, parseUserId, allowUser, revokeUser, listUsers }
  from '../tools/wo-bot/access.mjs';

const OWNER = '1603929437';

test('owner is ownerUserId, else the first allowedUserIds entry (old configs keep working)', () => {
  assert.equal(ownerOf({ ownerUserId: 42, allowedUserIds: [OWNER] }), '42');
  assert.equal(ownerOf({ allowedUserIds: [Number(OWNER), 7] }), OWNER);
  assert.equal(ownerOf({ allowedUserIds: [] }), null);
  assert.equal(ownerOf({}), null);
  assert.ok(isOwner({ allowedUserIds: [Number(OWNER)] }, Number(OWNER)));
  assert.ok(!isOwner({}, OWNER), 'no owner configured means nobody is owner');
});

test('allowed = owner, config list, or added through the bot', () => {
  const config = { ownerUserId: OWNER, allowedUserIds: [111111] };
  const state = { allowed: { 222222: { name: 'Sam' } } };
  assert.ok(isAllowed(config, state, OWNER));
  assert.ok(isAllowed(config, state, 111111));
  assert.ok(isAllowed(config, state, '222222'));
  assert.ok(!isAllowed(config, state, '333333'));
  assert.ok(!isAllowed(config, {}, '222222'), 'a state with no allowed map lets nobody extra in');
});

test('parseUserId reads the id after a command, and only a plain id', () => {
  assert.equal(parseUserId('/allow 123456789'), '123456789');
  assert.equal(parseUserId('/allow@MeterLogReaderBot 123456789'), '123456789');
  assert.equal(parseUserId('  987654321 '), '987654321');
  assert.equal(parseUserId('/allow'), null);
  assert.equal(parseUserId('/allow H12345'), null);
  assert.equal(parseUserId('/allow 123 456'), null);
  assert.equal(parseUserId('/revoke 777000'), '777000', 'old accounts have short ids');
  assert.equal(parseUserId('/allow -100123'), null, 'a group id is not a person');
});

test('allowUser adds once and lets the person in immediately', () => {
  const config = { ownerUserId: OWNER, allowedUserIds: [] }, state = {};
  const now = new Date('2026-11-10T15:00:00Z');
  assert.deepEqual(allowUser(config, state, 555555, 'Sam Lee', now), { ok: true });
  assert.ok(isAllowed(config, state, '555555'));
  assert.deepEqual(state.allowed['555555'], { name: 'Sam Lee', addedAt: now.toISOString() });
  assert.deepEqual(allowUser(config, state, '555555', 'Sam Lee'), { ok: false, already: true });
  assert.deepEqual(allowUser(config, state, OWNER, 'me'), { ok: false, already: true });
});

test('revokeUser removes bot-added people and their link, never the owner or config ids', () => {
  const config = { ownerUserId: OWNER, allowedUserIds: [111111] };
  const state = { allowed: { 555555: { name: 'Sam' } },
    links: { 555555: { hNumber: 'H1', name: 'Sam' }, [OWNER]: { hNumber: 'H2', name: 'Me' } } };
  assert.deepEqual(revokeUser(config, state, OWNER), { ok: false, reason: 'owner' });
  assert.deepEqual(revokeUser(config, state, '111111'), { ok: false, reason: 'config' });
  assert.deepEqual(revokeUser(config, state, '999999'), { ok: false, reason: 'unknown' });
  assert.deepEqual(revokeUser(config, state, 555555), { ok: true, name: 'Sam' });
  assert.ok(!isAllowed(config, state, '555555'));
  assert.equal(state.links['555555'], undefined);
  assert.ok(state.links[OWNER], 'other links are untouched');
});

test('listUsers puts the owner first and lists each person once', () => {
  const config = { allowedUserIds: [Number(OWNER), 111111] };
  const state = { allowed: { 555555: { name: 'Sam' }, 111111: { name: 'dup' } },
    links: { [OWNER]: { hNumber: 'H629528', name: 'Quincy Orta' } } };
  const users = listUsers(config, state);
  assert.deepEqual(users.map(u => [u.id, u.source]),
    [[OWNER, 'owner'], ['111111', 'config'], ['555555', 'bot']]);
  assert.equal(users[0].name, 'Quincy Orta');
  assert.equal(users[2].name, 'Sam');
});
