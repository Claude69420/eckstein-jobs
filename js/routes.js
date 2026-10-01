/* Eckstein Jobs: synced saved routes (R-3, docs/r3-plan.md F).
 *
 * Plain browser script (defines the global `SavedRoutes`) and a Node module (module.exports) for tests.
 * tools/add_route.py (Claude's routes) mirrors the pure sanitizers exactly (tests/test_add_route.py checks parity).
 *
 * File: routes.json in Claude69420/eckstein-jobs-state = {"version": 1, "routes": {"<id>": route | tombstone}}
 *   route     {id, name, owner, by, at, rt, start, seq, skipped}
 *               id       "r" + base36 time + base36 random (ID_RE); the map key is the id
 *               name     one line, <= 80 chars ("Route" when empty)
 *               owner    who the route belongs to (the "Your name" of the device that saved it; "Claude"), <= 40
 *               by       the device label that saved it last, <= 40
 *               at       ISO UTC time of the last save (newest wins when two devices save the same id)
 *               rt       true = return to the shop at the end
 *               start    {mode: "shop"|"stop"|"gps", lat?, lon?, name?}
 *                          "shop": the route starts at the shop (the shop is not in seq)
 *                          "stop": seq[0] is the start site (numbered #1)
 *                          "gps":  the route starts at {lat, lon} ("Me"; not in seq)
 *               seq      routed stops in order (1..100)
 *               skipped  stops switched off (0..100)
 *   stop      {name (<= 80), lat, lon (inside the Manitoba box), jobNumber?, match? (<= 120), shop?, oot?}
 *   tombstone {deleted: true, at, by}: a deletion (so another device's older copy does not bring it back); pruned 30
 *             days after `at` whenever the file is written.
 *   Limits: <= 300 routes (newest kept), <= 1000 tombstones. Anything else is dropped when read (sanitized on read and
 *   on write); unknown top-level fields are kept.
 *
 * Storage backends (store.mode), like js/stages.js, with the SAME edit key (localStorage ns + "gh_token"):
 *   "github"   key saved: read/write routes.json through the GitHub contents API (sha-guarded PUT; on 409/422 re-GET
 *              and merge per route id, newest "at" wins, tombstones included; <= 3 attempts)
 *   "readonly" no key on the live site: raw.githubusercontent.com (CDN, up to ~5 min stale); saves refused
 *   "local"    no key AND localhost / 127.0.0.1 / [::1]: localStorage ns + "saved_routes_local" (preview testing)
 *   "invalid"  the key was rejected (401/403) by this store: read-only until the key is replaced
 * The key is read from localStorage on every use, so a key saved or removed through the Stages store is picked up.
 * Offline / failed saves wait in ns + "route_queue" (write-ahead) and replay on online / visible / the next poll.
 * Guards: a damaged routes.json (not {"routes": {...}}) or one in a newer format (version > 1) is never overwritten;
 * the change waits on the device.
 *
 * Key hygiene: the key is never logged, never put in a URL, never included in an error or status string, and only ever
 * sent in the Authorization header to https://api.github.com.
 */
var SavedRoutes = (function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));

  /* ---------- constants ---------- */
  var FILE_VERSION = 1;
  var REPO = 'Claude69420/eckstein-jobs-state';
  var DEFAULT_FILE = 'routes.json';
  function apiUrl(file) { return 'https://api.github.com/repos/' + REPO + '/contents/' + file; }
  function rawUrl(file) { return 'https://raw.githubusercontent.com/' + REPO + '/main/' + file; }
  var API_URL = apiUrl(DEFAULT_FILE), RAW_URL = rawUrl(DEFAULT_FILE);
  var MB_BOX = { latMin: 48.9, latMax: 50.9, lonMin: -99.8, lonMax: -95.3 }; // = Stages.MB_BOX
  var LIMITS = { name: 80, owner: 40, by: 40, match: 120, stopName: 80, stops: 100, routes: 300, tombstones: 1000,
    tombstoneDays: 30, fileBytes: 900000 };
  var ID_RE = /^r[0-9a-z]{6,40}$/;
  var JOB_RE = /^[0-9A-Za-z-]{1,32}$/;
  var MODES = ['shop', 'stop', 'gps'];
  var TOMB_MS = LIMITS.tombstoneDays * 86400000;
  var MAX_ATTEMPTS = 3, RETRY_BACKOFF_MS = 400, REQUEST_TIMEOUT_MS = 20000, MAX_COMMIT_MSG = 500;
  var POLL_GITHUB_MS = 60000, POLL_READONLY_MS = 300000;
  var LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
  // localStorage suffixes (key = ns + suffix)
  var S_TOKEN = 'gh_token', S_LOCAL = 'saved_routes_local', S_QUEUE = 'route_queue', S_CACHE = 'saved_routes_cache',
    S_DEVICE = 'device';

  var MSG = {
    auth: 'Edit key rejected \u2014 Settings \u2192 Stages',
    readonly: 'Saved routes are read-only on this device. Settings \u2192 Stages',
    offline: 'Offline \u2014 routes will sync when you\u2019re back online',
    loadOffline: 'Offline \u2014 showing the last known routes',
    conflict: 'Couldn\u2019t save the route \u2014 routes changed on another device. It will try again.',
    noWrite: 'This key can read but not write eckstein-jobs-state \u2014 it needs Contents: Read and write',
    rateLimited: 'GitHub is busy (rate limit) \u2014 try again in a few minutes',
    storage: 'Couldn\u2019t save on this device (storage blocked)',
    damaged: 'routes.json in eckstein-jobs-state is damaged (not valid route JSON) \u2014 saving routes is paused until it is fixed',
    newer: 'Routes were saved by a newer version of the app \u2014 close and reopen the app to update (changes wait on this device)',
    invalid: 'This route has no stops to save',
    badId: 'Unknown route',
    config: 'This copy of the app is misconfigured (EJ_CONFIG) \u2014 saved routes are read-only here. Open the normal app link.'
  };

  /* ---------- small helpers ---------- */
  function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isPlainObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function parseJSON(t) { try { return JSON.parse(t); } catch (e) { return null; } }
  function noop() {}
  function codeError(code, message, status) {
    var e = new Error(message);
    e.code = code;
    if (status) e.status = status;
    return e;
  }

  /* ---------- text (tools/add_route.py clean_text mirrors this exactly) ---------- */
  var CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;
  /** At most `max` UTF-16 units, never splitting a surrogate pair; lone surrogates become U+FFFD. */
  function clip(s, max) {
    var out = '', n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), ch = s.charAt(i), units = 1;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { ch = s.substr(i, 2); units = 2; }
      }
      if (units === 1 && c >= 0xd800 && c <= 0xdfff) ch = '\ufffd';
      if (n + units > max) break;
      out += ch; n += units;
      if (units === 2) i++;
    }
    return out;
  }
  /** Any value -> one line, free of control and bidi-override characters, at most `max` UTF-16 units ('' if not a string). */
  function cleanText(v, max) {
    if (typeof v !== 'string') return '';
    var s = v.replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
    return clip(s, max).replace(/ +$/, '');
  }
  /** Keys never contain whitespace; strip anything pasted around/inside. */
  function cleanToken(t) { return typeof t === 'string' ? t.replace(/\s+/g, '') : ''; }

  /* ---------- time (same rules as js/stages.js cleanIso) ---------- */
  function cleanIso(v) {
    var m = typeof v === 'string' && v.length <= 40 &&
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(v);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > dim[mo - 1] || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59 ||
        (m[9] && (+m[9] > 23 || +m[10] > 59))) return null;
    return isFinite(Date.parse(v)) ? v : null;
  }
  function isoMs(v) { return cleanIso(v) ? Date.parse(v) : NaN; }
  function isoOf(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  /* ---------- sanitizers (tools/add_route.py mirrors these exactly) ---------- */
  function inBox(lat, lon) {
    return typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon) &&
      lat >= MB_BOX.latMin && lat <= MB_BOX.latMax && lon >= MB_BOX.lonMin && lon <= MB_BOX.lonMax;
  }
  function cleanJobNumber(v) {
    if (typeof v === 'number') return isFinite(v) && Math.floor(v) === v && v >= 0 && v <= 999999999 ? v : null;
    return typeof v === 'string' && JOB_RE.test(v) ? v : null;
  }
  /** Any value -> stop {name, lat, lon, jobNumber?, match?, shop?, oot?}, or null (not an object / outside Manitoba). */
  function cleanStop(s) {
    if (!isPlainObj(s) || !inBox(s.lat, s.lon)) return null;
    var o = { name: cleanText(s.name, LIMITS.stopName), lat: s.lat, lon: s.lon };
    var jn = has(s, 'jobNumber') ? cleanJobNumber(s.jobNumber) : null;
    if (jn !== null) o.jobNumber = jn;
    var mt = cleanText(s.match, LIMITS.match);
    if (mt) o.match = mt;
    if (s.shop === true) o.shop = true;
    if (s.oot === true) o.oot = true;
    return o;
  }
  function cleanStops(a) {
    if (!Array.isArray(a)) return [];
    var out = [];
    for (var i = 0; i < a.length && out.length < LIMITS.stops; i++) {
      var s = cleanStop(a[i]);
      if (s) out.push(s);
    }
    return out;
  }
  function cleanStart(v) {
    var o = { mode: isPlainObj(v) && MODES.indexOf(v.mode) >= 0 ? v.mode : 'shop' };
    if (isPlainObj(v)) {
      if (inBox(v.lat, v.lon)) { o.lat = v.lat; o.lon = v.lon; }
      var nm = cleanText(v.name, LIMITS.stopName);
      if (nm) o.name = nm;
    }
    return o;
  }
  /** (id, any value) -> route | tombstone {deleted, at, by} | null (bad id, no valid time, or no routed stop). */
  function cleanEntry(id, v) {
    if (typeof id !== 'string' || !ID_RE.test(id) || !isPlainObj(v)) return null;
    var at = cleanIso(v.at);
    if (!at) return null;
    if (v.deleted === true) return { deleted: true, at: at, by: cleanText(v.by, LIMITS.by) };
    var seq = cleanStops(v.seq);
    if (!seq.length) return null;
    return {
      id: id,
      name: cleanText(v.name, LIMITS.name) || 'Route',
      owner: cleanText(v.owner, LIMITS.owner),
      by: cleanText(v.by, LIMITS.by),
      at: at,
      rt: v.rt === true,
      start: cleanStart(v.start),
      seq: seq,
      skipped: cleanStops(v.skipped)
    };
  }
  /** A route from anywhere (its own id) -> a clean route, or null. */
  function sanitizeRoute(v) {
    var e = isPlainObj(v) ? cleanEntry(v.id, v) : null;
    return e && !e.deleted ? e : null;
  }
  function copyEntry(e) { return e ? JSON.parse(JSON.stringify(e)) : null; }
  function entryKey(e) { return e ? JSON.stringify(e) : ''; }
  /** Newest first (at), then id: the order routes are listed in and kept by the caps. */
  function byNewest(a, b) {
    var ta = isoMs(a.e.at), tb = isoMs(b.e.at);
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  /** {id: entry} -> the same map within the caps (<= 300 routes, <= 1000 tombstones, newest kept), keys sorted by id. */
  /** UTF-8 byte length of a string (a surrogate pair = 4 bytes). */
  function utf8Len(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { n += 4; i++; } else n += 3;
    }
    return n;
  }
  function capMap(map) {
    var live = [], tombs = [];
    Object.keys(map).forEach(function (id) { (map[id].deleted ? tombs : live).push({ id: id, e: map[id] }); });
    live.sort(byNewest); tombs.sort(byNewest);
    live = live.slice(0, LIMITS.routes); tombs = tombs.slice(0, LIMITS.tombstones);
    // GitHub's contents API stops returning a file over 1 MB: the oldest routes go first while the file would pass
    // LIMITS.fileBytes (tools/add_route.py cap_map does the same).
    var empty = utf8Len(serializeDoc({}, null));
    function size(x) { var o = {}; o[x.id] = x.e; return utf8Len(serializeDoc(o, null)) - empty + 1; }
    var total = empty;
    live.concat(tombs).forEach(function (x) { x.n = size(x); total += x.n; });
    while (total > LIMITS.fileBytes && live.length > 1) total -= live.pop().n;
    var keep = live.concat(tombs);
    keep.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    var o = {};
    keep.forEach(function (x) { o[x.id] = x.e; });
    return o;
  }
  /** Any parsed JSON -> {map, extras, version}. */
  function sanitizeDoc(obj) {
    var map = {}, extras = {};
    if (isPlainObj(obj)) {
      Object.keys(obj).forEach(function (k) {
        if (k !== 'version' && k !== 'routes' && k !== '__proto__') extras[k] = obj[k];
      });
      if (isPlainObj(obj.routes)) {
        Object.keys(obj.routes).forEach(function (id) {
          var e = cleanEntry(id, obj.routes[id]);
          if (e) map[id] = e;
        });
      }
    }
    var version = isPlainObj(obj) && typeof obj.version === 'number' ? obj.version : 1;
    return { map: capMap(map), extras: extras, version: version };
  }
  function stripBom(t) { return String(t || '').replace(/^\ufeff/, ''); }
  function parseDocText(text) { return sanitizeDoc(parseJSON(stripBom(text))); }
  /** Non-empty text that is not {"routes": {...}}: never write over it (that would wipe every route). */
  function isDamaged(text) {
    var t = stripBom(text).trim();
    if (!t) return false;
    var j = parseJSON(t);
    return !isPlainObj(j) || !isPlainObj(j.routes);
  }
  /** Tombstones older than 30 days are dropped (only when the file is written). */
  function pruneTombstones(map, nowMs) {
    var o = {};
    Object.keys(map).forEach(function (id) {
      var e = map[id];
      if (e.deleted && !(isoMs(e.at) >= nowMs - TOMB_MS)) return;
      o[id] = e;
    });
    return o;
  }
  /** File text: 2-space JSON + trailing newline; routes sorted by id; unknown top-level fields kept after them. */
  function serializeDoc(map, extras) {
    var routes = {};
    Object.keys(map).sort().forEach(function (id) { routes[id] = map[id]; });
    var doc = { version: FILE_VERSION, routes: routes };
    if (extras) Object.keys(extras).forEach(function (k) { if (!has(doc, k)) doc[k] = extras[k]; });
    return JSON.stringify(doc, null, 2) + '\n';
  }
  /** One op wins over the file's entry unless the file's is newer (newest "at" wins; a tie goes to the op). */
  function opWins(cur, e) { return !cur || !(isoMs(cur.at) > isoMs(e.at)); }
  /** ops = {id: {entry, name}} applied on top of `base` (new map). */
  function applyOps(base, ops) {
    var o = {};
    Object.keys(base || {}).forEach(function (id) { o[id] = base[id]; });
    Object.keys(ops || {}).forEach(function (id) { if (opWins(o[id], ops[id].entry)) o[id] = ops[id].entry; });
    return o;
  }
  /** [{kind: "save"|"delete", name}] -> 'route: save "A"' (one) or 'routes: save "A"; delete "B"' (bounded). */
  function commitMessage(parts) {
    function one(p) { return p.kind + ' "' + cleanText(p.name, LIMITS.name) + '"'; }
    if (parts.length === 1) return 'route: ' + one(parts[0]);
    var out = 'routes: ', n = 0;
    for (var i = 0; i < parts.length; i++) {
      var t = one(parts[i]);
      if (n && out.length + t.length + 2 > MAX_COMMIT_MSG) break;
      out += (n ? '; ' : '') + t; n++;
    }
    if (n < parts.length) out += '; +' + (parts.length - n) + ' more';
    return out;
  }
  /** A new route id: "r" + base36 time + base36 random (crypto.getRandomValues when available). */
  function newId(nowMs, cryptoObj) {
    var t = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    var c = cryptoObj || G.crypto, rnd = '';
    try {
      var u = new Uint32Array(2);
      c.getRandomValues(u);
      rnd = u[0].toString(36) + u[1].toString(36);
    } catch (e) {
      rnd = Math.floor(Math.random() * 0xffffffff).toString(36) + Math.floor(Math.random() * 0xffffffff).toString(36);
    }
    return ('r' + Math.max(0, Math.floor(t)).toString(36) + rnd).slice(0, 41);
  }
  /** A route saved on a device before R-3 (localStorage ns + "routes": {name, when, seq: [start, ...stops], rt,
   *  skipped?}) -> a clean route (new id; owner as given; at = its "when" when valid), or null. seq[0] was the start:
   *  the shop -> start "shop"; any other stop -> start "stop" (it stays seq[0], #1). */
  function fromLegacy(r, owner, nowMs, cryptoObj) {
    if (!isPlainObj(r) || !Array.isArray(r.seq)) return null;
    var seq = r.seq.filter(function (s) { return isPlainObj(s); });
    if (!seq.length) return null;
    var shopStart = seq[0].shop === true;
    var t = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
    var when = isoMs(r.when);
    return sanitizeRoute({
      id: newId(t, cryptoObj), name: r.name, owner: owner, by: '', at: isFinite(when) ? isoOf(when) : isoOf(t),
      rt: r.rt === true, start: { mode: shopStart ? 'shop' : 'stop' }, seq: shopStart ? seq.slice(1) : seq,
      skipped: r.skipped
    });
  }

  /* ---------- config (window.EJ_CONFIG or env.config; defaults = the main app) ---------- */
  var CONFIG_DEFAULTS = { channel: 'main', base: '', ns: 'ej_', routesFile: DEFAULT_FILE };
  var CONFIG_OK = {
    channel: function (v) { return typeof v === 'string' && /^[a-z0-9-]{1,16}$/.test(v); },
    base: function (v) { return typeof v === 'string' && /^(\.\.?\/)*$/.test(v) && v.length <= 32; },
    ns: function (v) { return typeof v === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(v); }, // = Stages.NS_RE
    routesFile: function (v) { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(v); }
  };
  /** Fail closed like Stages.resolveConfig: a bad config, or a non-main channel that would write routes.json or use
   *  the "ej_" keys, is `locked` (read-only, no localStorage). Other EJ_CONFIG fields (stateFile, ...) are ignored. */
  function resolveConfig(c) {
    var src = isPlainObj(c) ? c : {}, bad = [], o = {};
    if (c !== undefined && c !== null && !isPlainObj(c)) bad.push('not an object');
    Object.keys(CONFIG_OK).forEach(function (k) {
      var given = has(src, k), ok = given && CONFIG_OK[k](src[k]);
      if (given && !ok) bad.push(k);
      o[k] = ok ? src[k] : CONFIG_DEFAULTS[k];
    });
    if (o.channel !== CONFIG_DEFAULTS.channel && o.routesFile === DEFAULT_FILE) bad.push('a ' + o.channel + ' app must not write ' + DEFAULT_FILE);
    if (o.channel !== CONFIG_DEFAULTS.channel && o.ns === CONFIG_DEFAULTS.ns) bad.push('a ' + o.channel + ' app must not use the "ej_" keys');
    if (bad.length) o.locked = 'EJ_CONFIG: ' + bad.join(', ');
    return o;
  }

  /* ---------- base64 <-> UTF-8 (browser and Node) ---------- */
  function b64encodeUtf8(s) {
    var bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(String(s))
      : (function () { var b = unescape(encodeURIComponent(String(s))), o = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; })();
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return typeof G.btoa === 'function' ? G.btoa(bin) : Buffer.from(bin, 'binary').toString('base64'); // eslint-disable-line no-undef
  }
  function b64decodeUtf8(b64) {
    var clean = String(b64).replace(/\s+/g, '');
    var bin = typeof G.atob === 'function' ? G.atob(clean) : Buffer.from(clean, 'base64').toString('binary'); // eslint-disable-line no-undef
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var j = 0; j < bytes.length; j++) s += String.fromCharCode(bytes[j]);
    return decodeURIComponent(escape(s));
  }

  /* ======================================================================================= */
  /* Store                                                                                    */
  /* ======================================================================================= */
  function createStore(env) {
    env = env || {};
    var fetchFn = typeof env.fetch === 'function' ? env.fetch
      : (typeof G.fetch === 'function' ? function (u, o) { return G.fetch(u, o); } : null);
    var storage = has(env, 'storage') ? env.storage : (function () { try { return G.localStorage || null; } catch (e) { return null; } })();
    var now = typeof env.now === 'function' ? env.now : function () { return Date.now(); };
    var hostname = has(env, 'hostname') ? String(env.hostname || '')
      : (function () { try { return (G.location && G.location.hostname) || ''; } catch (e) { return ''; } })();
    var setT = typeof env.setTimeout === 'function' ? env.setTimeout : function (f, ms) { return G.setTimeout(f, ms); };
    var clearT = typeof env.clearTimeout === 'function' ? env.clearTimeout : function (h) { return G.clearTimeout(h); };
    var doc = has(env, 'document') ? env.document : G.document;
    var win = has(env, 'window') ? env.window : (G.document && typeof G.addEventListener === 'function' ? G : undefined);
    var nav = has(env, 'navigator') ? env.navigator : G.navigator;
    var cryptoObj = has(env, 'crypto') ? env.crypto : G.crypto;

    var cfg = resolveConfig(has(env, 'config') ? env.config : (function () { try { return G.EJ_CONFIG; } catch (e) { return null; } })());
    var LOCKED = cfg.locked || null;
    if (LOCKED) storage = null;
    var NS = cfg.ns, FILE = cfg.routesFile, API = apiUrl(FILE), RAW = rawUrl(FILE);
    var LS_TOKEN = NS + S_TOKEN, LS_LOCAL = NS + S_LOCAL, LS_QUEUE = NS + S_QUEUE, LS_CACHE = NS + S_CACHE, LS_DEVICE = NS + S_DEVICE;

    function sGet(k) { try { return storage ? storage.getItem(k) : null; } catch (e) { return null; } }
    function sSet(k, v) { try { if (!storage) return false; storage.setItem(k, v); return true; } catch (e) { return false; } }
    function sDel(k) { try { if (storage) storage.removeItem(k); } catch (e) { /* ignore */ } }

    /* --- state --- */
    var badToken = null;       // the key this store saw rejected (401/403): mode "invalid" while it is still the key
    var lastTok = undefined;   // the key the remote state below was read with
    var gen = 0;               // bumps when the key changes; stale async results are ignored
    var remote = {}, remoteExtras = {}, remoteVersion = FILE_VERSION, remoteDamaged = false;
    var sha = null, ghLoaded = false, lastSync = null;
    var lastError = null, errKind = null;
    var queue = loadQueue();   // {id: {entry, name, n}}
    var opSeq = 0;
    var chain = Promise.resolve(), replayScheduled = false;
    var changeFns = [], statusFns = [], lastStatusJSON = '', shownJSON = null;
    var started = false, pollTimer = null;

    function setError(kind, msg) { lastError = msg; errKind = kind; }
    function clearError(kinds) {
      if (errKind === 'config') return;
      if (!kinds || kinds.indexOf(errKind) >= 0) { lastError = null; errKind = null; }
    }
    if (LOCKED) setError('config', MSG.config);

    function token() { return LOCKED ? null : (cleanToken(sGet(LS_TOKEN)) || null); }
    /** Notice a key change (saved or removed through the Stages store): forget what the old key read. */
    function syncKey() {
      var t = token();
      if (t === lastTok) return t;
      if (lastTok !== undefined) {
        gen++; sha = null; ghLoaded = false;
        if (errKind === 'auth') clearError();
      }
      lastTok = t;
      return t;
    }
    function mode() {
      if (LOCKED) return 'readonly';
      var t = syncKey();
      if (t) return t === badToken ? 'invalid' : 'github';
      return LOCAL_HOSTS.indexOf(hostname.toLowerCase()) >= 0 ? 'local' : 'readonly';
    }
    function isWritable() { var m = mode(); return m === 'github' || m === 'local'; }

    /* --- queue (write-ahead): ns + "route_queue" = {version: 1, ops: {id: {entry, name}}} --- */
    function loadQueue() {
      var raw = parseJSON(sGet(LS_QUEUE)), q = {};
      if (isPlainObj(raw) && isPlainObj(raw.ops)) {
        Object.keys(raw.ops).forEach(function (id) {
          var v = raw.ops[id], e = isPlainObj(v) ? cleanEntry(id, v.entry) : null;
          if (e) q[id] = { entry: e, name: cleanText(v.name, LIMITS.name) || (e.deleted ? '' : e.name), n: 0 };
        });
      }
      return q;
    }
    function saveQueue() {
      var ids = Object.keys(queue);
      if (!ids.length) { sDel(LS_QUEUE); return true; }
      var ops = {};
      ids.forEach(function (id) { ops[id] = { entry: queue[id].entry, name: queue[id].name }; });
      return sSet(LS_QUEUE, JSON.stringify({ version: 1, ops: ops }));
    }

    /* --- cache (last good remote map, public data only) for an offline cold start --- */
    function writeCache() { sSet(LS_CACHE, JSON.stringify({ version: FILE_VERSION, at: lastSync || now(), map: remote })); }
    (function readCache() {
      var c = parseJSON(sGet(LS_CACHE));
      if (!isPlainObj(c) || !isPlainObj(c.map)) return;
      remote = sanitizeDoc({ routes: c.map }).map;
      lastSync = typeof c.at === 'number' && isFinite(c.at) ? c.at : null;
    })();

    /* --- local mode --- */
    function readLocal() { return parseDocText(sGet(LS_LOCAL)); }
    function writeLocal(d) { return sSet(LS_LOCAL, serializeDoc(capMap(pruneTombstones(d.map, now())), d.extras)); }

    /* --- views --- */
    function viewMap() { return mode() === 'local' ? readLocal().map : applyOps(remote, queue); }
    function listOf(map, markPending) {
      var items = [];
      Object.keys(map).forEach(function (id) { if (!map[id].deleted) items.push({ id: id, e: map[id] }); });
      items.sort(byNewest);
      return items.map(function (x) {
        var r = copyEntry(x.e);
        if (markPending && has(queue, x.id) && queue[x.id].entry === x.e) r.pending = true;
        return r;
      });
    }
    function list() { return listOf(viewMap(), mode() !== 'local'); }
    function deviceLabel() {
      var v = cleanText(sGet(LS_DEVICE), LIMITS.by);
      if (v) return v;
      try {
        if (nav && nav.standalone) return 'iPhone app';
        if (nav && /Windows/i.test(String(nav.userAgent || ''))) return 'PC';
      } catch (e) { /* ignore */ }
      return 'browser';
    }

    /* --- listeners --- */
    function report(e) { setT(function () { throw e; }, 0); }
    function status() {
      var m = mode();
      var s = { mode: m, writable: m === 'github' || m === 'local', pending: m === 'local' ? 0 : Object.keys(queue).length,
        lastError: lastError, lastSync: lastSync };
      if (LOCKED) s.locked = LOCKED;
      return s;
    }
    function emitStatus() {
      var s = status(), j = JSON.stringify(s);
      if (j === lastStatusJSON) return;
      lastStatusJSON = j;
      statusFns.slice().forEach(function (fn) { try { fn(status()); } catch (e) { report(e); } });
    }
    function emitChange(force) {
      var l = list(), j = JSON.stringify(l);
      if (!force && j === shownJSON) return;
      shownJSON = j;
      changeFns.slice().forEach(function (fn) { try { fn(JSON.parse(j)); } catch (e) { report(e); } });
    }

    /* --- HTTP --- */
    function apiHeaders(tok, withBody) {
      var h = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (withBody) h['Content-Type'] = 'application/json';
      return h;
    }
    function request(url, opts) {
      if (!fetchFn) return Promise.reject(codeError('network', 'Network unavailable'));
      var timer = null, ctrl = null;
      try { if (typeof AbortController === 'function') { ctrl = new AbortController(); opts.signal = ctrl.signal; } } catch (e) { ctrl = null; }
      if (ctrl) timer = setT(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, REQUEST_TIMEOUT_MS);
      function done() { if (timer !== null) { clearT(timer); timer = null; } }
      var p;
      try { p = Promise.resolve(fetchFn(url, opts)); } catch (e) { p = Promise.reject(e); }
      return p.then(function (res) {
        return Promise.resolve(res.text()).then(function (text) {
          done();
          return { status: res.status, text: typeof text === 'string' ? text : '',
            header: function (n) { try { return res.headers && res.headers.get ? res.headers.get(n) : null; } catch (e) { return null; } } };
        });
      }).then(null, function () { done(); throw codeError('network', 'Network error'); });
    }
    function isRateLimited(r) {
      if (r.status === 429) return true;
      if (r.header('x-ratelimit-remaining') === '0' || r.header('retry-after')) return true;
      var j = parseJSON(r.text);
      return !!(j && typeof j.message === 'string' && /rate limit/i.test(j.message));
    }
    function httpError(r, what) {
      if (r.status === 401) return codeError('auth', MSG.auth, 401);
      if (r.status === 403 || r.status === 429) {
        if (isRateLimited(r)) return codeError('http', MSG.rateLimited, r.status);
        // a file over the contents API's 1 MB limit ("too_large"): not a key problem
        if (/too[ _]large/i.test(String(r.text || ''))) return codeError('http', 'Couldn’t ' + what + ' routes (file too large)', r.status);
        return codeError('auth', MSG.auth, r.status);
      }
      if (r.status === 409 || r.status === 422) return codeError('conflict', MSG.conflict, r.status);
      return codeError('http', 'Couldn\u2019t ' + what + ' routes (GitHub HTTP ' + r.status + ')', r.status);
    }
    /** -> {map, extras, version, sha, damaged} ; 404 -> empty (sha null: the first PUT creates the file). */
    function getGithub(tok) {
      return request(API, { method: 'GET', headers: apiHeaders(tok, false), cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { map: {}, extras: {}, version: FILE_VERSION, sha: null, damaged: false };
        if (r.status !== 200) throw httpError(r, 'load');
        var j = parseJSON(r.text);
        if (!isPlainObj(j) || typeof j.sha !== 'string') throw codeError('http', 'Couldn\u2019t load routes (bad response)', 200);
        if (j.encoding && j.encoding !== 'base64') throw codeError('http', 'Couldn\u2019t load routes (file too large)', 200);
        var text;
        try { text = typeof j.content === 'string' ? b64decodeUtf8(j.content) : ''; }
        catch (e) { throw codeError('http', 'Couldn\u2019t load routes (bad encoding)', 200); }
        var d = parseDocText(text);
        return { map: d.map, extras: d.extras, version: d.version, sha: j.sha, damaged: isDamaged(text) };
      });
    }
    function getRaw() {
      return request(RAW + '?t=' + now(), { method: 'GET', cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { map: {}, extras: {}, version: FILE_VERSION, damaged: false };
        if (r.status !== 200) throw codeError('http', 'Couldn\u2019t load routes (HTTP ' + r.status + ')', r.status);
        var d = parseDocText(r.text);
        return { map: d.map, extras: d.extras, version: d.version, damaged: isDamaged(r.text) };
      });
    }
    function wait(ms) { return new Promise(function (resolve) { setT(resolve, ms); }); }
    function enqueue(fn) {
      var p = chain.then(fn, fn);
      chain = p.then(noop, noop);
      return p;
    }
    /** Take a good read. A damaged file keeps the last known routes (and blocks saves). */
    function took(res, m) {
      remoteDamaged = !!res.damaged;
      if (m === 'github') { sha = res.sha; ghLoaded = true; }
      if (remoteDamaged) { setError('read', MSG.damaged.replace('routes.json', FILE)); return; }
      remote = res.map; remoteExtras = res.extras; remoteVersion = res.version;
      lastSync = now();
      writeCache();
      clearError(['read']);
    }

    /** Refresh `remote` for the current mode. Never rejects; sets lastError instead. */
    function fetchRemote() {
      var m = mode(), g = gen, tok = lastTok;
      if (m === 'local') return Promise.resolve();
      var p = m === 'github' ? getGithub(tok) : getRaw();
      return p.then(function (res) { if (g === gen) took(res, m); }, function (err) {
        if (g !== gen) return;
        if (err.code === 'auth' && m === 'github') {
          badToken = tok; ghLoaded = false; setError('auth', MSG.auth);
          return fetchRemote(); // the read-only truth from the CDN copy
        }
        if (!errKind || errKind === 'read') setError('read', err.code === 'network' ? MSG.loadOffline : err.message);
      });
    }

    /** PUT every queued op (one commit), merged per id onto the newest file. -> {ok} | throws Error{code}. */
    function putOps(snap, tok, g) {
      var attempt = 0;
      function fresh() {
        return getGithub(tok).then(function (res) {
          if (g !== gen) throw codeError('stale', 'Key changed');
          took(res, 'github');
        });
      }
      function attemptOnce(forceGet) {
        attempt++;
        return (forceGet || !ghLoaded ? fresh() : Promise.resolve()).then(function () {
          if (remoteDamaged) throw codeError('format', MSG.damaged.replace('routes.json', FILE));
          if (remoteVersion > FILE_VERSION) throw codeError('format', MSG.newer);
          var merged = {}, parts = [];
          Object.keys(remote).forEach(function (id) { merged[id] = remote[id]; });
          Object.keys(snap).forEach(function (id) {
            var op = snap[id], cur = has(merged, id) ? merged[id] : null;
            if (!opWins(cur, op.entry) || entryKey(cur) === entryKey(op.entry)) return; // newer elsewhere / already there
            if (op.entry.deleted && !cur) return; // nothing to delete
            merged[id] = op.entry;
            parts.push({ kind: op.entry.deleted ? 'delete' : 'save', name: op.name || (cur && !cur.deleted ? cur.name : '') || id });
          });
          if (!parts.length) return;
          merged = capMap(pruneTombstones(merged, now()));
          var payload = { message: commitMessage(parts), content: b64encodeUtf8(serializeDoc(merged, remoteExtras)), branch: 'main' };
          if (sha) payload.sha = sha;
          return request(API, { method: 'PUT', headers: apiHeaders(tok, true), body: JSON.stringify(payload), cache: 'no-store' })
            .then(function (r) {
              if (g !== gen) throw codeError('stale', 'Key changed');
              if (r.status === 200 || r.status === 201) {
                var j = parseJSON(r.text);
                sha = j && j.content && typeof j.content.sha === 'string' ? j.content.sha : null;
                ghLoaded = !!sha;
                remote = merged; remoteVersion = FILE_VERSION; lastSync = now();
                writeCache();
                return;
              }
              if (r.status === 404) throw codeError('auth', MSG.noWrite, 404);
              var err = httpError(r, 'save');
              var retry = err.code === 'conflict' || (err.code === 'http' && r.status >= 500);
              if (retry && attempt < MAX_ATTEMPTS) return wait(RETRY_BACKOFF_MS * attempt).then(function () { return attemptOnce(true); });
              throw err;
            });
        });
      }
      return attemptOnce(false);
    }

    /** Replay the whole queue. Never rejects. -> {ok: bool, reason?} */
    function runSave() {
      var m = mode(), tok = lastTok, g = gen;
      var ids = Object.keys(queue);
      if (m !== 'github' || !ids.length) return Promise.resolve({ ok: !ids.length, reason: m === 'invalid' ? 'auth' : 'readonly' });
      var snap = {};
      ids.forEach(function (id) { snap[id] = { entry: queue[id].entry, name: queue[id].name, n: queue[id].n }; });
      return putOps(snap, tok, g).then(function () {
        ids.forEach(function (id) { if (has(queue, id) && queue[id].n === snap[id].n) delete queue[id]; });
        saveQueue();
        clearError(['save', 'read']);
        emitStatus(); emitChange(false);
        return { ok: true };
      }, function (err) {
        var reason = err.code === 'network' ? 'offline' : err.code;
        if (err.code === 'network') setError('save', MSG.offline);
        else if (err.code === 'auth') {
          if (g === gen) { badToken = tok; ghLoaded = false; }
          setError('auth', err.status === 404 ? MSG.noWrite : MSG.auth);
        } else if (err.code !== 'stale') setError('save', err.message);
        emitStatus(); emitChange(false);
        if (err.code === 'stale') maybeReplay();
        return { ok: false, reason: reason };
      }).then(null, function (e) { report(e); return { ok: false, reason: 'http' }; });
    }
    function maybeReplay() {
      if (replayScheduled || mode() !== 'github' || !Object.keys(queue).length) return;
      replayScheduled = true;
      enqueue(function () { replayScheduled = false; return runSave(); });
    }
    /** Queue one op and save it now. -> {status, id, reason?} */
    function submit(id, entry, name) {
      var n = ++opSeq;
      queue[id] = { entry: entry, name: name, n: n };
      if (!saveQueue()) { delete queue[id]; return Promise.reject(codeError('storage', MSG.storage)); }
      emitStatus(); emitChange(false);
      return enqueue(runSave).then(function (res) {
        var waiting = has(queue, id) && queue[id].n === n;
        var out = { status: waiting ? 'queued' : 'saved', id: id };
        if (waiting && res && res.reason) out.reason = res.reason;
        return out;
      });
    }
    /** A save time that beats the version shown now, even when this device's clock runs behind (skew up to a day). */
    function stampAfter(cur) {
      var t = now(), prev = cur ? isoMs(cur.at) : NaN;
      if (prev >= t && prev - t <= 86400000) t = prev + 1000;
      return isoOf(t);
    }
    function refuse() {
      var m = mode();
      if (m === 'readonly') return codeError('readonly', LOCKED ? MSG.config : MSG.readonly);
      if (m === 'invalid') return codeError('auth', MSG.auth);
      return null;
    }

    /* --- polling --- */
    function isVisible() { return !doc || !doc.visibilityState || doc.visibilityState === 'visible'; }
    function pollNow() {
      if (!isVisible() || mode() === 'local') return Promise.resolve();
      return enqueue(fetchRemote).then(function () { emitStatus(); maybeReplay(); emitChange(false); });
    }
    function schedulePoll() {
      if (pollTimer !== null) { clearT(pollTimer); pollTimer = null; }
      if (!started || mode() === 'local') return;
      pollTimer = setT(function () {
        pollTimer = null;
        pollNow().then(schedulePoll, schedulePoll);
      }, mode() === 'github' ? POLL_GITHUB_MS : POLL_READONLY_MS);
      if (pollTimer && typeof pollTimer === 'object' && typeof pollTimer.unref === 'function') pollTimer.unref();
    }
    function onVisibility() { if (isVisible()) pollNow().then(schedulePoll, schedulePoll); }
    function onOnline() { maybeReplay(); pollNow().then(schedulePoll, schedulePoll); }

    /* ---------------------------------- public API ---------------------------------- */
    return {
      get mode() { return mode(); },
      get writable() { return isWritable(); },
      get pending() { return status().pending; },
      get lastError() { return lastError; },
      status: status,
      hasKey: function () { return !!token(); },
      deviceLabel: deviceLabel,
      get config() { var o = {}; Object.keys(cfg).forEach(function (k) { o[k] = cfg[k]; }); return o; },

      /** Synchronous best guess: the cached routes plus unsaved changes (local mode: the device's routes). */
      peek: function () { return list(); },
      /** One route by id from the current view (copy), or null. */
      get: function (id) { var m = viewMap(); return has(m, id) && !m[id].deleted ? copyEntry(m[id]) : null; },

      /** -> Promise<[route]> newest first ("pending: true" on routes still waiting to sync). Never rejects; a missing
       *  file (404) is an empty list. */
      load: function () {
        return enqueue(fetchRemote).then(function () {
          emitStatus(); maybeReplay();
          var l = list();
          shownJSON = JSON.stringify(l);
          return l;
        }).then(null, function (e) { report(e); return list(); });
      },

      /** save(route) -> Promise<{status: "saved"|"queued", id, reason?}>. Keeps route.id when it is a valid id (an
       *  update), else makes a new one; sets at (now) and by (this device's label); owner comes from the route.
       *  opts.keepAt: a NEW route keeps a valid, not-future route.at (the one-time copy of routes saved on the device
       *  before R-3 keeps their dates and order); an update is always stamped now.
       *  Rejects Error{code}: "readonly" / "auth" (this device cannot write), "invalid" (no routable stop), "storage".
       *  "queued" = kept on this device (offline, conflict, damaged / newer file, key problem) and retried later. */
      save: function (route, opts) {
        var r = refuse();
        if (r) return Promise.reject(r);
        if (!isPlainObj(route)) return Promise.reject(codeError('invalid', MSG.invalid));
        var id = typeof route.id === 'string' && ID_RE.test(route.id) ? route.id : newId(now(), cryptoObj);
        var cur = viewMap()[id] || null;
        var src = {};
        Object.keys(route).forEach(function (k) { src[k] = route[k]; });
        var keep = !cur && isPlainObj(opts) && opts.keepAt === true ? isoMs(route.at) : NaN;
        src.at = keep <= now() ? isoOf(keep) : stampAfter(cur); src.by = deviceLabel();
        var e = cleanEntry(id, src);
        if (!e || e.deleted) return Promise.reject(codeError('invalid', MSG.invalid));
        if (mode() === 'local') {
          var d = readLocal();
          d.map[id] = e;
          if (!writeLocal(d)) return Promise.reject(codeError('storage', MSG.storage));
          lastSync = now(); emitStatus(); emitChange(false);
          return Promise.resolve({ status: 'saved', id: id });
        }
        return submit(id, e, e.name);
      },

      /** remove(id) -> Promise<{status, id, reason?}> (a tombstone, so older copies elsewhere never come back).
       *  Rejects like save(); "invalid" for a malformed id. */
      remove: function (id) {
        var r = refuse();
        if (r) return Promise.reject(r);
        if (typeof id !== 'string' || !ID_RE.test(id)) return Promise.reject(codeError('invalid', MSG.badId));
        var cur = viewMap()[id] || null;
        var name = cur && !cur.deleted ? cur.name : '';
        var e = { deleted: true, at: stampAfter(cur), by: deviceLabel() };
        if (mode() === 'local') {
          var d = readLocal();
          if (has(d.map, id)) { d.map[id] = e; if (!writeLocal(d)) return Promise.reject(codeError('storage', MSG.storage)); }
          lastSync = now(); emitStatus(); emitChange(false);
          return Promise.resolve({ status: 'saved', id: id });
        }
        return submit(id, e, name);
      },

      /** fn(list) whenever the visible list changes (another device's save arrives, a save lands). -> unsubscribe */
      onChange: function (fn) {
        if (typeof fn === 'function') changeFns.push(fn);
        return function () { changeFns = changeFns.filter(function (f) { return f !== fn; }); };
      },
      /** fn(status()) whenever mode / writable / pending / lastError / lastSync change. -> unsubscribe */
      onStatus: function (fn) {
        if (typeof fn === 'function') statusFns.push(fn);
        return function () { statusFns = statusFns.filter(function (f) { return f !== fn; }); };
      },
      /** Poll (60 s with a key, 300 s read-only, none in local mode), refresh on visible, replay on online. */
      start: function () {
        if (started) return;
        started = true;
        if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
        if (win && typeof win.addEventListener === 'function') win.addEventListener('online', onOnline);
        schedulePoll();
        maybeReplay();
      },
      stop: function () {
        started = false;
        if (pollTimer !== null) { clearT(pollTimer); pollTimer = null; }
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
        if (win && typeof win.removeEventListener === 'function') win.removeEventListener('online', onOnline);
      },
      /** Replay queued changes now (e.g. right after a key was saved in Settings). -> Promise (settles when done). */
      flush: function () { maybeReplay(); return chain.then(noop, noop); }
    };
  }

  return {
    FILE_VERSION: FILE_VERSION,
    API_URL: API_URL,
    RAW_URL: RAW_URL,
    MB_BOX: MB_BOX,
    LIMITS: LIMITS,
    ID_RE: ID_RE,
    createStore: createStore,
    resolveConfig: resolveConfig,
    sanitizeRoute: sanitizeRoute,
    cleanStop: cleanStop,
    fromLegacy: fromLegacy,
    newId: newId,
    _util: {
      cleanText: cleanText, clip: clip, cleanIso: cleanIso, isoMs: isoMs, cleanEntry: cleanEntry, cleanStart: cleanStart,
      cleanStops: cleanStops, sanitizeDoc: sanitizeDoc, parseDocText: parseDocText, serializeDoc: serializeDoc,
      isDamaged: isDamaged, pruneTombstones: pruneTombstones, capMap: capMap, applyOps: applyOps,
      commitMessage: commitMessage, b64encodeUtf8: b64encodeUtf8, b64decodeUtf8: b64decodeUtf8
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SavedRoutes;
