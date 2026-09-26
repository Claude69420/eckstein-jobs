/* Eckstein Jobs: job stages + stage store (R-1).
 *
 * Plain browser script (defines the global `Stages`) and a Node module (module.exports) for tests.
 * Spec: docs/r1-build-spec.md sec. 1.1-1.2 and APP_MASTER.md sec. 5 "Stage data".
 *
 * Storage backends, picked per device (store.mode):
 *   "github"   edit key saved and accepted: read/write stages.json in Claude69420/eckstein-jobs-state
 *              through the GitHub contents API (the ONLY host that ever receives the key).
 *   "readonly" no key on the live site: read raw.githubusercontent.com (CDN, up to ~5 min stale).
 *   "local"    no key AND hostname is localhost / 127.0.0.1 / [::1]: localStorage "ej_stages" (preview testing).
 *   "invalid"  the key was rejected (401/403): behaves read-only until a new key is saved.
 *
 * Key hygiene: the key is never logged, never put in a URL, never included in an error or status
 * string, and only ever sent in the Authorization header to https://api.github.com.
 */
var Stages = (function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));

  /* ---------- stage definitions (APP_MASTER sec. 5; colours are CSS only: --stage-1..--stage-6) ---------- */
  var STAGES = [
    { key: 'ready', label: 'Ready to start', short: 'Ready' },
    { key: 'excavation', label: 'Excavation', short: 'Excav.' },
    { key: 'base', label: 'Base', short: 'Base' },
    { key: 'prep', label: 'Prep', short: 'Prep' },
    { key: 'inspected', label: 'Passed inspection', short: 'Passed' },
    { key: 'poured', label: 'Poured', short: 'Poured' }
  ];
  var KEYS = STAGES.map(function (s) { return s.key; });

  function knownKey(key) {
    if (typeof key !== 'string') return null;
    var i = KEYS.indexOf(key);
    if (i < 0) i = KEYS.indexOf(key.trim().toLowerCase());
    return i < 0 ? null : KEYS[i];
  }
  /** 0..5; unknown or missing -> 0 ("ready"). */
  function stageIndex(key) { var k = knownKey(key); return k ? KEYS.indexOf(k) : 0; }
  /** A valid stage key; unknown or missing -> "ready". */
  function normalize(key) { return KEYS[stageIndex(key)]; }

  /* ---------- constants ---------- */
  var REPO = 'Claude69420/eckstein-jobs-state';
  var API_URL = 'https://api.github.com/repos/' + REPO + '/contents/stages.json';
  var RAW_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/stages.json';
  var LS_TOKEN = 'ej_gh_token', LS_LOCAL = 'ej_stages', LS_QUEUE = 'ej_stage_queue', LS_DEVICE = 'ej_device';
  var LS_CACHE = 'ej_stages_cache'; // last good remote map {version, at, map} (public data, never the key): offline cold start
  var BATCH_MS = 3000;            // changes made within 3 s -> one commit
  var POLL_GITHUB_MS = 60000;     // with a key (fresh API reads)
  var POLL_READONLY_MS = 300000;  // raw CDN is cached for 300 s anyway
  var MAX_ATTEMPTS = 3;           // PUT attempts per save (409/422/5xx -> re-GET, merge, retry)
  var RETRY_BACKOFF_MS = 400;     // wait 400 ms, then 800 ms, before retries
  var REQUEST_TIMEOUT_MS = 20000; // a hung request must not block the save chain forever
  var LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

  var MSG = {
    auth: 'Edit key rejected \u2014 Settings \u2192 Stages',
    readonly: 'Stages are read-only on this device. Settings \u2192 Stages',
    conflict: 'Couldn\u2019t save \u2014 stages changed on another device. Showing the latest.',
    offline: 'Offline \u2014 stage changes will save when you\u2019re back online',
    loadOffline: 'Offline \u2014 showing the last known stages',
    loadOfflineEmpty: 'Offline \u2014 stages not loaded yet (every job shows as Ready)',
    noWrite: 'This key can read but not write eckstein-jobs-state \u2014 it needs Contents: Read and write',
    rateLimited: 'GitHub is busy (rate limit) \u2014 try again in a few minutes',
    storage: 'Couldn\u2019t save on this device (storage blocked)',
    newer: 'Stages were saved by a newer version of the app \u2014 close and reopen the app to update, then try again',
    damaged: 'stages.json in eckstein-jobs-state is damaged (not valid stage JSON) \u2014 saving is paused until it is fixed'
  };

  /* ---------- small helpers ---------- */
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function noop() {}
  function parseJSON(t) { try { return JSON.parse(t); } catch (e) { return null; } }

  /** jobNumber (number or string) -> string key, or '' when unusable. */
  function cleanJobKey(jn) {
    if (typeof jn === 'number') { if (!isFinite(jn)) return ''; jn = String(jn); }
    if (typeof jn !== 'string') return '';
    jn = jn.trim();
    return /^[0-9A-Za-z-]{1,32}$/.test(jn) ? jn : '';
  }
  /** One-line, free of control and bidi-override characters, max 80 chars (commit messages, device labels). */
  function cleanLabel(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  /** Keys never contain whitespace; strip anything pasted around/inside. */
  function cleanToken(t) { return typeof t === 'string' ? t.replace(/\s+/g, '') : ''; }

  /* ---------- base64 <-> UTF-8 (browser and Node) ---------- */
  function utf8Bytes(s) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8String(bytes) {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(bin));
  }
  function toBase64(bin) {
    if (typeof G.btoa === 'function') return G.btoa(bin);
    return Buffer.from(bin, 'binary').toString('base64'); // eslint-disable-line no-undef
  }
  function fromBase64(b64) {
    if (typeof G.atob === 'function') return G.atob(b64);
    return Buffer.from(b64, 'base64').toString('binary'); // eslint-disable-line no-undef
  }
  function b64encodeUtf8(s) {
    var bytes = utf8Bytes(String(s)), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return toBase64(bin);
  }
  function b64decodeUtf8(b64) {
    var bin = fromBase64(String(b64).replace(/\s+/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return utf8String(bytes);
  }

  /* ---------- stages.json shape ---------- */
  // Map = { "<jobNumber>": {stage, at, by} } holding only non-"ready" entries.
  function cleanEntry(v) {
    var isObj = !!v && typeof v === 'object';
    var k = knownKey(isObj ? v.stage : v);
    if (!k || k === 'ready') return null;
    // at/by come from a public file that anyone with a key can edit: one line, bounded, no bidi overrides.
    return { stage: k, at: isObj ? cleanLabel(str(v.at)).slice(0, 40) : '', by: isObj ? cleanLabel(str(v.by)).slice(0, 40) : '' };
  }
  /** Any parsed JSON -> {map, extras}; malformed/missing -> empty map. Unknown top-level fields are kept. */
  function sanitizeDoc(obj) {
    var map = {}, extras = {};
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.keys(obj).forEach(function (k) {
        if (k !== 'version' && k !== 'stages' && k !== '__proto__') extras[k] = obj[k];
      });
      var st = obj.stages;
      if (st && typeof st === 'object' && !Array.isArray(st)) {
        Object.keys(st).forEach(function (k) {
          var jn = cleanJobKey(k), e = jn ? cleanEntry(st[k]) : null;
          if (e) map[jn] = e;
        });
      }
    }
    var version = obj && typeof obj === 'object' && typeof obj.version === 'number' ? obj.version : 1;
    return { map: map, extras: extras, version: version };
  }
  function parseDocText(text) {
    return sanitizeDoc(parseJSON(String(text || '').replace(/^\ufeff/, '')));
  }
  /** Non-empty text that is not {"stages":{...}}: a hand-edit typo. Never write over it (that would wipe every stage). */
  function isDamaged(text) {
    var t = String(text || '').replace(/^\ufeff/, '').trim();
    if (!t) return false;
    var j = parseJSON(t);
    return !j || typeof j !== 'object' || Array.isArray(j) || !j.stages || typeof j.stages !== 'object' || Array.isArray(j.stages);
  }
  /** File text: 2-space JSON + trailing newline; numeric job keys come out in ascending order. */
  function serializeDoc(map, extras) {
    var stages = {};
    Object.keys(map).forEach(function (jn) {
      var e = map[jn];
      stages[jn] = { stage: e.stage, at: e.at, by: e.by };
    });
    var doc = { version: 1, stages: stages };
    if (extras) Object.keys(extras).forEach(function (k) { if (!has(doc, k)) doc[k] = extras[k]; });
    return JSON.stringify(doc, null, 2) + '\n';
  }
  function copyMap(m) {
    var o = {};
    Object.keys(m || {}).forEach(function (k) { var e = m[k]; o[k] = { stage: e.stage, at: e.at, by: e.by }; });
    return o;
  }
  /** changes = {jn: {stage, at, by}}; stage "ready" deletes the entry. Returns a new map. */
  function applyChanges(base, changes) {
    var o = copyMap(base);
    Object.keys(changes || {}).forEach(function (jn) {
      var c = changes[jn];
      if (c.stage === 'ready') delete o[jn];
      else o[jn] = { stage: c.stage, at: c.at, by: c.by };
    });
    return o;
  }
  function sameEntry(a, b) {
    if (!a || !b) return !a && !b;
    return a.stage === b.stage && a.at === b.at && a.by === b.by;
  }
  function sameMap(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (!has(b, ka[i]) || !sameEntry(a[ka[i]], b[ka[i]])) return false;
    return true;
  }
  function sortJobKeys(keys) {
    return keys.slice().sort(function (a, b) {
      var na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
      if (na && nb) return Number(a) - Number(b);
      if (na !== nb) return na ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }
  /** "stage: #684 SW Corner Ellice & Kennedy -> base" | "stages: #684 -> base, #699 -> prep" */
  function commitMessage(changes) {
    var jns = sortJobKeys(Object.keys(changes));
    if (jns.length === 1) {
      var c = changes[jns[0]], lbl = cleanLabel(c.label);
      return 'stage: #' + jns[0] + (lbl ? ' ' + lbl : '') + ' -> ' + c.stage;
    }
    var shown = jns.slice(0, 30).map(function (jn) { return '#' + jn + ' -> ' + changes[jn].stage; });
    return 'stages: ' + shown.join(', ') + (jns.length > 30 ? ', +' + (jns.length - 30) + ' more' : '');
  }
  function codeError(code, message, status) {
    var e = new Error(message);
    e.code = code;
    if (status) e.status = status;
    return e;
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
    var win = has(env, 'window') ? env.window
      : (G.document && typeof G.addEventListener === 'function' ? G : undefined);
    var nav = has(env, 'navigator') ? env.navigator : G.navigator;

    /* --- storage (every access guarded) --- */
    function sGet(k) { try { return storage ? storage.getItem(k) : null; } catch (e) { return null; } }
    function sSet(k, v) { try { if (!storage) return false; storage.setItem(k, v); return true; } catch (e) { return false; } }
    function sDel(k) { try { if (storage) storage.removeItem(k); } catch (e) { /* ignore */ } }

    /* --- state --- */
    var token = cleanToken(sGet(LS_TOKEN)) || null;
    var keyInvalid = false;   // set by a 401/403; cleared by setKey/removeKey
    var gen = 0;              // bumps on key change; stale async results are ignored
    var remote = {};          // last known remote map (github / readonly / invalid modes)
    var remoteExtras = {};
    var remoteVersion = 1;    // file format version last read; this app writes v1 only and never over a newer file
    var lastSync = null;      // ms of the last good read/save (seeded from the cache below)
    var sha = null;          // blob sha of stages.json (null = file missing, when ghLoaded)
    var ghLoaded = false;     // remote + sha are known from the API for the current key
    var remoteKnown = false;  // remote has been read at least once (enables the no-op shortcut in set)
    var lastError = null, errKind = null; // errKind: 'read' | 'save' | 'auth'
    function setError(kind, msg) { lastError = msg; errKind = kind; }
    // A successful read clears only read errors; a save error stays until a save succeeds,
    // an auth error until the key is replaced or removed.
    function clearError(kinds) { if (!kinds || kinds.indexOf(errKind) >= 0) { lastError = null; errKind = null; } }
    var queue = loadQueue();  // unsaved changes (write-ahead, persisted): {jn: {stage, at, by, label, b}}
    var batchSeq = 0, openBatch = null; // {id, timer, waiters:[{jn, prev, resolve, reject}]}
    var chain = Promise.resolve();      // serialises every GET/PUT so reads never race writes
    var replayScheduled = false;
    var shown = null;         // the map the UI is believed to show (for onChange diffing)
    var changeFns = [], statusFns = [], lastStatusJSON = '';
    var started = false, pollTimer = null;

    function mode() {
      if (token) return keyInvalid ? 'invalid' : 'github';
      return LOCAL_HOSTS.indexOf(hostname.toLowerCase()) >= 0 ? 'local' : 'readonly';
    }
    function isWritable() { var m = mode(); return m === 'github' || m === 'local'; }

    /* --- offline / write-ahead queue: localStorage "ej_stage_queue" --- */
    // Entry field b = batch id while the change waits in an open/closing batch; 0 once it is a
    // plain queued change (network failure, or left over from an earlier session).
    function loadQueue() {
      var raw = parseJSON(sGet(LS_QUEUE)), q = {};
      var src = raw && typeof raw === 'object' ? (raw.changes && typeof raw.changes === 'object' ? raw.changes : raw) : null;
      if (src && !Array.isArray(src)) {
        Object.keys(src).forEach(function (k) {
          var jn = cleanJobKey(k), v = src[k];
          if (!jn || !v || typeof v !== 'object' || typeof v.stage !== 'string') return;
          q[jn] = { stage: normalize(v.stage), at: str(v.at), by: str(v.by), label: cleanLabel(v.label), b: 0 };
        });
      }
      return q;
    }
    function saveQueue() {
      var keys = Object.keys(queue);
      if (!keys.length) { sDel(LS_QUEUE); return; }
      var out = {};
      keys.forEach(function (jn) {
        var e = queue[jn];
        out[jn] = { stage: e.stage, at: e.at, by: e.by, label: e.label };
      });
      sSet(LS_QUEUE, JSON.stringify({ version: 1, changes: out }));
    }

    /* --- last good remote map: localStorage "ej_stages_cache". It seeds `remote`, so an offline cold start
     *     shows the last known stages instead of "every job Ready". remoteKnown stays false until a real
     *     read, so set() still reads the server before it skips a "no-op" change. --- */
    function writeCache() {
      sSet(LS_CACHE, JSON.stringify({ version: 1, at: lastSync || now(), map: copyMap(remote) }));
    }
    function readCache() {
      var c = parseJSON(sGet(LS_CACHE));
      if (!c || typeof c !== 'object' || !c.map || typeof c.map !== 'object' || Array.isArray(c.map)) return null;
      return { map: sanitizeDoc({ stages: c.map }).map, at: typeof c.at === 'number' && isFinite(c.at) ? c.at : null };
    }
    if (mode() !== 'local') {
      var cached = readCache();
      if (cached) { remote = cached.map; lastSync = cached.at; }
    }

    /* --- local mode: localStorage "ej_stages" (same file shape) --- */
    function readLocal() { return parseDocText(sGet(LS_LOCAL)).map; }
    function writeLocal(map) { return sSet(LS_LOCAL, serializeDoc(map)); }

    /* --- effective map = remote + unsaved changes on top --- */
    function effective() {
      return mode() === 'local' ? readLocal() : applyChanges(remote, queue);
    }

    /* --- device label: localStorage "ej_device" --- */
    function deviceLabel() {
      var v = cleanLabel(sGet(LS_DEVICE)).slice(0, 40);
      if (v) return v;
      try {
        if (nav && nav.standalone) return 'iPhone app';
        if (nav && /Windows/i.test(String(nav.userAgent || ''))) return 'PC';
      } catch (e) { /* ignore */ }
      return 'browser';
    }
    function setDeviceLabel(s) {
      var v = cleanLabel(s).slice(0, 40);
      if (v) sSet(LS_DEVICE, v); else sDel(LS_DEVICE);
      return deviceLabel();
    }
    function isoNow() { return new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

    /* --- listeners --- */
    function report(e) { setT(function () { throw e; }, 0); } // surface listener bugs without breaking the store
    function status() {
      return { mode: mode(), writable: isWritable(), pending: mode() === 'local' ? 0 : Object.keys(queue).length,
        lastError: lastError, lastSync: lastSync };
    }
    function emitStatus() {
      var s = status(), j = JSON.stringify(s);
      if (j === lastStatusJSON) return;
      lastStatusJSON = j;
      statusFns.slice().forEach(function (fn) { try { fn(status()); } catch (e) { report(e); } });
    }
    function emitChange(force) {
      var eff = effective();
      if (!force && shown && sameMap(eff, shown)) return;
      shown = copyMap(eff);
      changeFns.slice().forEach(function (fn) { try { fn(copyMap(eff)); } catch (e) { report(e); } });
    }
    // After a rejected set(), the UI's rollback handlers must run before we tell it the truth.
    function emitChangeLater() { setT(function () { emitChange(false); }, 0); }
    function shownApply(jn, stage, entry) {
      if (!shown) return;
      if (stage === 'ready') delete shown[jn];
      else shown[jn] = { stage: entry.stage, at: entry.at, by: entry.by };
    }

    /* --- HTTP --- */
    function apiHeaders(tok, withBody) {
      var h = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (withBody) h['Content-Type'] = 'application/json';
      return h;
    }
    /** -> Promise<{status, text, header(name)}>; rejects {code:"network"} when fetch fails or times out. */
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
          return {
            status: res.status,
            text: typeof text === 'string' ? text : '',
            header: function (n) { try { return res.headers && res.headers.get ? res.headers.get(n) : null; } catch (e) { return null; } }
          };
        });
      }).then(null, function () {
        done(); // offline, DNS, CORS, abort/timeout, or a broken body: all "network" (-> queue and retry)
        throw codeError('network', 'Network error');
      });
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
        return isRateLimited(r) ? codeError('http', MSG.rateLimited, r.status) : codeError('auth', MSG.auth, r.status);
      }
      if (r.status === 409 || r.status === 422) return codeError('conflict', MSG.conflict, r.status);
      return codeError('http', 'Couldn\u2019t ' + (what || 'reach') + ' stages (GitHub HTTP ' + r.status + ')', r.status);
    }
    /** Authenticated read (fresh). 404 -> empty map, sha null (a PUT without sha creates the file). */
    function getRemoteGithub(tok) {
      return request(API_URL, { method: 'GET', headers: apiHeaders(tok, false), cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { map: {}, extras: {}, sha: null, missing: true };
        if (r.status !== 200) throw httpError(r, 'load');
        var j = parseJSON(r.text);
        if (!j || typeof j !== 'object' || typeof j.sha !== 'string') throw codeError('http', 'Couldn\u2019t load stages (bad response)', 200);
        if (j.encoding && j.encoding !== 'base64') throw codeError('http', 'Couldn\u2019t load stages (file too large)', 200);
        var text;
        try { text = typeof j.content === 'string' ? b64decodeUtf8(j.content) : ''; }
        catch (e) { throw codeError('http', 'Couldn\u2019t load stages (bad encoding)', 200); }
        if (isDamaged(text)) throw codeError('http', MSG.damaged, 200); // keep the last known map; block saves
        var parsed = parseDocText(text);
        return { map: parsed.map, extras: parsed.extras, sha: j.sha, version: parsed.version };
      });
    }
    /** Unauthenticated read (CDN, up to ~5 min stale; no Authorization header, no preflight). */
    function getRemoteRaw() {
      return request(RAW_URL + '?t=' + now(), { method: 'GET', cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { map: {}, extras: {} };
        if (r.status !== 200) throw codeError('http', 'Couldn\u2019t load stages (HTTP ' + r.status + ')', r.status);
        if (isDamaged(r.text)) throw codeError('http', MSG.damaged, 200);
        return parseDocText(r.text);
      });
    }
    function wait(ms) { return new Promise(function (resolve) { setT(resolve, ms); }); }

    /** Serialise async work. */
    function enqueue(fn) {
      var p = chain.then(fn, fn);
      chain = p.then(noop, noop);
      return p;
    }

    /** Refresh `remote` for the current mode. Never rejects; sets lastError instead. */
    function fetchRemote() {
      var m = mode(), g = gen;
      if (m === 'local') return Promise.resolve();
      var p = m === 'github' ? getRemoteGithub(token) : getRemoteRaw();
      return p.then(function (res) {
        if (g !== gen) return;
        remote = res.map; remoteExtras = res.extras; remoteVersion = res.version || 1;
        if (m === 'github') { sha = res.sha; ghLoaded = true; }
        remoteKnown = true; lastSync = now();
        writeCache();
        clearError(['read']);
      }, function (err) {
        if (g !== gen) return;
        if (err.code === 'auth' && m === 'github') {
          keyInvalid = true; ghLoaded = false; setError('auth', MSG.auth);
          return fetchRemote(); // show the (read-only) truth from the CDN copy
        }
        if (!errKind || errKind === 'read') {
          setError('read', err.code === 'network' ? (lastSync ? MSG.loadOffline : MSG.loadOfflineEmpty) : err.message);
        }
      });
    }

    /** GET-if-needed, merge `changes` on top of the remote file, PUT with sha; 409/422/5xx -> re-GET + retry. */
    function saveChanges(changes) {
      var tok = token, g = gen, attempt = 0;
      function attemptOnce(forceGet) {
        attempt++;
        var ready = (!forceGet && ghLoaded) ? Promise.resolve() : getRemoteGithub(tok).then(function (res) {
          if (g !== gen) throw codeError('stale', 'Key changed');
          remote = res.map; remoteExtras = res.extras; remoteVersion = res.version || 1; sha = res.sha; ghLoaded = true; remoteKnown = true; lastSync = now();
          writeCache();
        });
        return ready.then(function () {
          if (remoteVersion > 1) throw codeError('http', MSG.newer, 200); // never strip fields a newer app wrote
          var merged = applyChanges(remote, changes), real = {};
          Object.keys(changes).forEach(function (jn) {
            if (!sameEntry(has(remote, jn) ? remote[jn] : null, has(merged, jn) ? merged[jn] : null)) real[jn] = changes[jn];
          });
          if (!Object.keys(real).length) return; // nothing new: skip (GitHub would make an empty commit)
          var payload = { message: commitMessage(real), content: b64encodeUtf8(serializeDoc(merged, remoteExtras)), branch: 'main' };
          if (sha) payload.sha = sha;
          return request(API_URL, { method: 'PUT', headers: apiHeaders(tok, true), body: JSON.stringify(payload), cache: 'no-store' })
            .then(function (r) {
              if (g !== gen) throw codeError('stale', 'Key changed');
              if (r.status === 200 || r.status === 201) {
                var j = parseJSON(r.text);
                sha = j && j.content && typeof j.content.sha === 'string' ? j.content.sha : null;
                ghLoaded = !!sha; // unknown new sha -> GET before the next write
                remote = merged; lastSync = now();
                writeCache();
                return;
              }
              // The repo is public, so a key without write access still passes setKey's GET. GitHub answers
              // its PUT with 404 (classic token without the repo scope): treat that like a rejected key.
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

    /** Save one closed batch (plus any queued changes) or, with batch null, replay the queue. */
    function runSave(batch) {
      var bid = batch ? batch.id : -1, snap = {};
      Object.keys(queue).forEach(function (jn) { var e = queue[jn]; if (e.b === 0 || e.b === bid) snap[jn] = e; });
      var jns = Object.keys(snap);
      function settle(err, value) {
        if (!batch) return;
        batch.waiters.forEach(function (w) {
          if (err) {
            if (shown && w.prev !== undefined) { if (w.prev) shown[w.jn] = w.prev; else delete shown[w.jn]; }
            w.reject(err);
          } else w.resolve(value);
        });
      }
      function drop(onlyBatch) {
        jns.forEach(function (jn) { if (queue[jn] === snap[jn] && (!onlyBatch || snap[jn].b === bid)) delete queue[jn]; });
        saveQueue();
      }
      var m = mode();
      if (m !== 'github') {
        // Key removed or rejected while the batch was open: this batch cannot be saved.
        drop(true);
        settle(m === 'invalid' ? codeError('auth', MSG.auth) : codeError('readonly', MSG.readonly));
        emitStatus(); emitChangeLater();
        return Promise.resolve();
      }
      if (!jns.length) { settle(null, { status: 'saved' }); return Promise.resolve(); }
      var g = gen;
      return saveChanges(snap).then(function () {
        jns.forEach(function (jn) { if (queue[jn] === snap[jn]) delete queue[jn]; });
        saveQueue();
        clearError();
        settle(null, { status: 'saved' });
        emitStatus(); emitChangeLater(); // a retry may have pulled in other devices' changes
      }, function (err) {
        if (err.code === 'network' || err.code === 'stale' || g !== gen) {
          // Offline (or the key changed mid-save): keep the changes queued; replay on online /
          // visibilitychange / next poll (or right away with the new key).
          jns.forEach(function (jn) { if (queue[jn] === snap[jn]) snap[jn].b = 0; });
          saveQueue();
          if (err.code === 'network') setError('save', MSG.offline);
          settle(null, { status: 'queued' });
          emitStatus();
          if (err.code !== 'network') maybeReplay();
          return;
        }
        drop(false);
        if (err.code === 'auth') { keyInvalid = true; ghLoaded = false; }
        setError(err.code === 'auth' ? 'auth' : 'save', err.code === 'auth' ? (err.status === 404 ? MSG.noWrite : MSG.auth) : err.message);
        settle(err);
        emitStatus();
        // Reload the truth, then tell the UI (after its own rollback handlers have run).
        return fetchRemote().then(function () {
          emitStatus(); emitChangeLater();
        });
      });
    }

    /** runSave that can never leave a set() promise hanging, even on an unexpected exception. */
    function safeRun(batch) {
      var p;
      try { p = runSave(batch); } catch (e) { p = Promise.reject(e); }
      return p.then(null, function (e) {
        if (batch) batch.waiters.forEach(function (w) { w.reject(codeError('http', 'Could not save stages')); });
        report(e);
      });
    }
    function closeBatch() {
      var b = openBatch;
      if (!b) return chain;
      openBatch = null;
      clearT(b.timer);
      return enqueue(function () { return safeRun(b); });
    }
    function maybeReplay() {
      if (mode() !== 'github' || replayScheduled) return;
      var any = Object.keys(queue).some(function (jn) { return queue[jn].b === 0; });
      if (!any) return;
      replayScheduled = true;
      enqueue(function () { replayScheduled = false; return safeRun(null); });
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
    function onVisibility() {
      if (isVisible()) { pollNow().then(schedulePoll, schedulePoll); }
      else if (openBatch) closeBatch(); // app going to the background: save now, don't wait 3 s
    }
    function onOnline() { maybeReplay(); pollNow().then(schedulePoll, schedulePoll); }
    function onPageHide() { if (openBatch) closeBatch(); }

    /* ---------------------------------- public API ---------------------------------- */
    var store = {
      get mode() { return mode(); },
      get writable() { return isWritable(); },
      get lastError() { return lastError; },
      get pending() { return status().pending; },
      hasKey: function () { return !!token; },
      status: status,

      /** Synchronous best guess before load() settles: the cached last good map plus unsaved changes (or local stages). */
      peek: function () { return copyMap(effective()); },

      /** -> Promise<{jobNumber: {stage, at, by}}> (non-ready entries only). Never rejects. */
      load: function () {
        return enqueue(fetchRemote).then(function () {
          var eff = effective();
          shown = copyMap(eff);
          emitStatus();
          maybeReplay();
          return copyMap(eff);
        });
      },

      /** Optimistic; batched 3 s into one commit. -> Promise<{status:"saved"|"queued"}>; rejects Error{code}. */
      set: function (jobNumber, key, meta) {
        var jn = cleanJobKey(jobNumber);
        if (!jn) return Promise.reject(codeError('http', 'Invalid job number'));
        var k = normalize(key), m = mode();
        if (m === 'readonly') return Promise.reject(codeError('readonly', MSG.readonly));
        if (m === 'invalid') return Promise.reject(codeError('auth', MSG.auth));
        var cur = effective();
        if ((m === 'local' || remoteKnown) && (has(cur, jn) ? cur[jn].stage : 'ready') === k) {
          return Promise.resolve({ status: 'saved' }); // already in that stage: no commit
        }
        var entry = { stage: k, at: isoNow(), by: deviceLabel(), label: cleanLabel(meta && meta.label) };
        if (m === 'local') {
          var map = readLocal();
          if (k === 'ready') delete map[jn]; else map[jn] = { stage: k, at: entry.at, by: entry.by };
          if (!writeLocal(map)) return Promise.reject(codeError('http', MSG.storage));
          shownApply(jn, k, entry);
          lastSync = now();
          emitStatus();
          return Promise.resolve({ status: 'saved' });
        }
        return new Promise(function (resolve, reject) {
          if (!openBatch) {
            openBatch = { id: ++batchSeq, waiters: [], timer: null };
            openBatch.timer = setT(closeBatch, BATCH_MS);
          }
          entry.b = openBatch.id;
          queue[jn] = entry;
          saveQueue(); // write-ahead: survives the app being closed inside the 3 s window
          var prev = shown ? (has(shown, jn) ? shown[jn] : null) : undefined;
          shownApply(jn, k, entry);
          openBatch.waiters.push({ jn: jn, prev: prev, resolve: resolve, reject: reject });
          emitStatus();
        });
      },

      /** Save the open batch now (e.g. before closing). -> Promise that settles when it is done. */
      flush: function () { closeBatch(); return chain.then(noop, noop); },

      onChange: function (fn) {
        if (typeof fn === 'function') changeFns.push(fn);
        return function () { changeFns = changeFns.filter(function (f) { return f !== fn; }); };
      },
      onStatus: function (fn) {
        if (typeof fn === 'function') statusFns.push(fn);
        return function () { statusFns = statusFns.filter(function (f) { return f !== fn; }); };
      },

      start: function () {
        if (started) return;
        started = true;
        if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisibility);
        if (win && typeof win.addEventListener === 'function') {
          win.addEventListener('online', onOnline);
          win.addEventListener('pagehide', onPageHide);
        }
        schedulePoll();
        maybeReplay();
      },
      stop: function () {
        started = false;
        if (pollTimer !== null) { clearT(pollTimer); pollTimer = null; }
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisibility);
        if (win && typeof win.removeEventListener === 'function') {
          win.removeEventListener('online', onOnline);
          win.removeEventListener('pagehide', onPageHide);
        }
        if (openBatch) closeBatch(); // never drop a change: save it now instead of in 3 s
      },

      /** Validate with an authenticated GET; save only on 200. -> Promise<{ok:true}|{ok:false, reason}>. */
      setKey: function (input) {
        var t = cleanToken(input);
        if (!t) return Promise.resolve({ ok: false, reason: 'Paste the edit key first.' });
        if (!/^[\x21-\x7e]{10,255}$/.test(t)) return Promise.resolve({ ok: false, reason: 'That doesn\u2019t look like a GitHub key.' });
        return enqueue(function () {
          return getRemoteGithub(t).then(function (res) {
            if (res.missing) return { ok: false, reason: 'This key can\u2019t see stages.json in eckstein-jobs-state (404). Check the key\u2019s repository access.' };
            if (!sSet(LS_TOKEN, t)) return { ok: false, reason: 'Couldn\u2019t save the key on this device (storage blocked).' };
            token = t; keyInvalid = false; gen++;
            remote = res.map; remoteExtras = res.extras; remoteVersion = res.version || 1; sha = res.sha; ghLoaded = true; remoteKnown = true;
            lastSync = now(); writeCache(); clearError();
            try {
              if (nav && nav.storage && typeof nav.storage.persist === 'function') {
                var pp = nav.storage.persist();
                if (pp && typeof pp.then === 'function') pp.then(noop, noop);
              }
            } catch (e) { /* ignore */ }
            emitStatus();
            emitChange(true);
            schedulePoll();
            maybeReplay();
            return { ok: true };
          }, function (err) {
            var s = err.status;
            if (err.code === 'network') return { ok: false, reason: 'No connection \u2014 try again when you\u2019re online.' };
            if (s === 401) return { ok: false, reason: 'GitHub rejected this key (401). Check it was copied in full and hasn\u2019t expired.' };
            if (s === 403 && err.code === 'auth') return { ok: false, reason: 'This key isn\u2019t allowed to use eckstein-jobs-state (403). Check its repository access and permissions.' };
            return { ok: false, reason: err.message || 'GitHub error \u2014 try again.' };
          });
        });
      },

      /** Forget the key on this device -> readonly (or local on localhost). Queued offline changes are kept. */
      removeKey: function () {
        sDel(LS_TOKEN);
        token = null; keyInvalid = false; gen++;
        sha = null; ghLoaded = false; clearError();
        if (openBatch) closeBatch(); // cannot be saved any more: rejects with code "readonly"
        emitStatus();
        schedulePoll();
        return enqueue(fetchRemote).then(function () { emitStatus(); emitChange(true); });
      },

      /** The saved key, only for the Settings "Share edit access" button the user taps. */
      getKeyForShare: function () { return token || null; },

      deviceLabel: deviceLabel,
      setDeviceLabel: setDeviceLabel
    };
    return store;
  }

  return {
    STAGES: STAGES,
    stageIndex: stageIndex,
    normalize: normalize,
    createStore: createStore,
    API_URL: API_URL,
    RAW_URL: RAW_URL,
    _util: {
      b64encodeUtf8: b64encodeUtf8, b64decodeUtf8: b64decodeUtf8, parseDocText: parseDocText,
      serializeDoc: serializeDoc, commitMessage: commitMessage, cleanJobKey: cleanJobKey
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Stages;
