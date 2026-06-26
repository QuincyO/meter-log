// ── IndexedDB: the durable store for all offline data (falls back to null on error) ─
// Stores:
//   'dayCache'  (key = "name|date", value = {stops,downtime,day,closed,cachedAt})
//   'worklist'  (keyPath 'id', installer-built planned orders)
//   'queue'     (keyPath '_seq', autoIncrement → FIFO un-synced writes; the
//                system of record until each write reaches the Sheet)
//   'addrCache' (key = rounded "lat,lng", value = {address, ts}) — coord→address
//                cache so reverse-geocoding works offline (see geocode.js)
//
// Bumping the schema: raise DB_VERSION and add the new store inside
// onupgradeneeded (guarded by `contains`, so it's additive and safe on upgrade).
// This is separate from the sw.js CACHE version.
export const DB_VERSION = 3;

export const idb = (() => {
  let _db = null;
  function open(){
    return new Promise((res, rej) => {
      if(_db){ res(_db); return; }
      try{
        const req = indexedDB.open('meterlog', DB_VERSION);
        req.onupgradeneeded = e => {
          const d = e.target.result;
          if(!d.objectStoreNames.contains('dayCache'))  d.createObjectStore('dayCache');
          if(!d.objectStoreNames.contains('worklist'))  d.createObjectStore('worklist', {keyPath:'id'});
          if(!d.objectStoreNames.contains('queue'))     d.createObjectStore('queue', {keyPath:'_seq', autoIncrement:true});
          if(!d.objectStoreNames.contains('addrCache')) d.createObjectStore('addrCache');
        };
        req.onsuccess = e => { _db = e.target.result; res(_db); };
        req.onerror   = e => rej(e.target.error);
      } catch(e){ rej(e); }
    });
  }
  function tx(sName, mode, fn){
    return open().then(d => new Promise((res, rej) => {
      try{
        const t = d.transaction(sName, mode);
        const r = fn(t.objectStore(sName));
        r.onsuccess = e => res(e.target.result);
        r.onerror   = e => rej(e.target.error);
      } catch(e){ rej(e); }
    })).catch(() => null);
  }
  return {
    get : (s, k)   => tx(s, 'readonly',  os => os.get(k)),
    put : (s, v, k) => tx(s, 'readwrite', os => k!==undefined ? os.put(v,k) : os.put(v)),
    del : (s, k)   => tx(s, 'readwrite', os => os.delete(k)),
    all : s        => tx(s, 'readonly',  os => os.getAll()),
    keys: s        => tx(s, 'readonly',  os => os.getAllKeys()),
  };
})();
