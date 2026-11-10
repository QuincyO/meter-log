// ── Who may use the bot ─────────────────────────────────────────────────────
// Three sources, checked together:
//   owner   config.ownerUserId (else the FIRST allowedUserIds entry, so a config
//           written before the owner existed keeps working) — can let people in
//           and out from Telegram, and can't be revoked
//   config  config.allowedUserIds — hand-edited on the PC; the bot can't remove
//           them, because it never rewrites the config file
//   bot     state.allowed — added by the owner through the bot (/allow or the
//           ✅ Allow button), saved in state.local.json, live without a restart
// Pure and DOM-free so tests/wo-bot-access.test.mjs can drive it; bot.mjs owns
// saving the state and talking to Telegram.

const ids = list => (list || []).map(String).filter(Boolean);

export function ownerOf(config){
  if(config.ownerUserId != null && String(config.ownerUserId)) return String(config.ownerUserId);
  return ids(config.allowedUserIds)[0] || null;
}

export function isOwner(config, user){
  const owner = ownerOf(config);
  return owner != null && String(user) === owner;
}

export function isAllowed(config, state, user){
  const id = String(user);
  return isOwner(config, id) || ids(config.allowedUserIds).includes(id)
    || Object.prototype.hasOwnProperty.call(state.allowed || {}, id);
}

// "/allow 123456789", "/allow@MyBot 123456789" or a bare id → "123456789", else null.
export function parseUserId(text){
  const m = String(text || '').replace(/^\/\w+(@\w+)?/, '').trim().match(/^(\d{1,20})$/);
  return m ? m[1] : null;
}

// → { ok:true } | { ok:false, already:true }
export function allowUser(config, state, user, name, now = new Date()){
  const id = String(user);
  if(isAllowed(config, state, id)) return { ok: false, already: true };
  state.allowed = state.allowed || {};
  state.allowed[id] = { name: name || '', addedAt: now.toISOString() };
  return { ok: true };
}

// → { ok:true, name } | { ok:false, reason:'owner'|'config'|'unknown' }
// Revoking also drops their /link, so a re-allowed person links afresh.
export function revokeUser(config, state, user){
  const id = String(user);
  if(isOwner(config, id)) return { ok: false, reason: 'owner' };
  const allowed = state.allowed || {};
  if(!Object.prototype.hasOwnProperty.call(allowed, id))
    return { ok: false, reason: ids(config.allowedUserIds).includes(id) ? 'config' : 'unknown' };
  const name = allowed[id].name || '';
  delete allowed[id];
  if(state.links) delete state.links[id];
  return { ok: true, name };
}

// Everyone who can use the bot, owner first: [{ id, name, source, link }].
export function listUsers(config, state){
  const owner = ownerOf(config), links = state.links || {}, out = [], seen = new Set();
  const add = (id, source, name) => {
    if(seen.has(id)) return;
    seen.add(id);
    out.push({ id, source, name: name || (links[id] && links[id].name) || '', link: links[id] || null });
  };
  if(owner) add(owner, 'owner');
  for(const id of ids(config.allowedUserIds)) add(id, 'config');
  for(const [id, v] of Object.entries(state.allowed || {})) add(id, 'bot', v && v.name);
  return out;
}
