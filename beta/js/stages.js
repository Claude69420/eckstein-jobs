/* Eckstein Jobs: job stages, job items and the stage store (R-2, file format v2).
 *
 * Plain browser script (defines the global `Stages`) and a Node module (module.exports) for tests.
 * Spec: docs/r2-plan.md sec. 2 + 2a "Shared contract" (sync_jobs.py mirrors the pure helpers), R-1 basis in
 * docs/r1-build-spec.md sec. 1.1-1.2 and APP_MASTER.md sec. 5 "Stage data".
 *
 * Storage backends, picked per device (store.mode):
 *   "github"   edit key saved and accepted: read/write stages.json in Claude69420/eckstein-jobs-state
 *              through the GitHub contents API (the ONLY host that ever receives the key).
 *   "readonly" no key on the live site: read raw.githubusercontent.com (CDN, up to ~5 min stale).
 *   "local"    no key AND hostname is localhost / 127.0.0.1 / [::1]: localStorage "ej_stages" (preview testing).
 *   "invalid"  the key was rejected (401/403): behaves read-only until a new key is saved.
 *
 * Stored entry (only non-default fields; asphalt/pavers whenever someone set them, including "na"):
 *   {stage?, assess?, lane?:{s, from?, to?}, cut?, asphalt?, pavers?, cleanup?, removed?, sat?, at, by}
 * load() / peek() / onChange() hand out these STORED entries (beta: MERGED with the overlay, see below); the UI
 * applies Stages.effective(entry, job.hints, job.jobNumber).
 *
 * Config (r2-plan sec. 9; window.EJ_CONFIG, or env.config in tests; defaults = the main app, unchanged keys/URLs):
 *   ns "ej_"            localStorage prefix: ns + "gh_token" / "stages" / "stage_queue" / "stages_cache" / "device"
 *                        (+ "overlay_cache" when an overlay is configured)
 *   stateFile "stages.json"  the ONLY file this app ever writes (beta: "stages-beta.json")
 *   overlayFile null     beta: "stages.json" = v1's file, READ-ONLY (never PUT). Read like the state file (API with the
 *                        key, raw CDN without, raw CDN in local mode too), on the same poll.
 * Fail closed (protects the live v1 stages.json during the beta trial): a config with a bad field, or a non-main
 * channel that would write stages.json / use the "ej_" keys, is `locked`: read-only, no localStorage, setKey refused
 * (never a silent fallback to the main app's file and keys). And no store ever PUTs its v2 document over an existing
 * file that is still v1 (env.allowUpgrade only in tests / a one-off migration; promotion converts the file first).
 * Stage overlay (beta only): entries gain "sat" (ISO UTC: when this app last set "stage"; written whenever the beta
 * sets stage). Merged entry per job = the state-file entry, except its stage comes from the overlay entry when the
 * overlay has an entry with a valid stage AND (the state entry has no sat OR overlay.at > sat). Items only ever come
 * from the state file. A damaged or newer-format overlay counts as "no overlay" (status().overlay.note) and never
 * blocks saves. Known limitation: v1 records "Ready" by deleting the entry, so a v1 move back to Ready is invisible
 * here. Without an overlay, sat is never written (setting the stage drops a stale one).
 *
 * Key hygiene: the key is never logged, never put in a URL, never included in an error or status
 * string, and only ever sent in the Authorization header to https://api.github.com.
 */
var Stages = (function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));

  /* ---------- stage definitions (r2-plan 2a; colours are CSS only: --stage-N) ---------- */
  var STAGES = [
    { key: 'ready', label: 'Ready to start', short: 'Ready' },
    { key: 'setup', label: 'Setup', short: 'Setup' },
    { key: 'excavation', label: 'Excavation', short: 'Excav.' },
    { key: 'base', label: 'Base', short: 'Base' },
    { key: 'prep', label: 'Prep', short: 'Prep' },
    { key: 'inspected', label: 'Passed inspection', short: 'Passed' },
    { key: 'poured', label: 'Poured', short: 'Poured' }
  ];
  var KEYS = STAGES.map(function (s) { return s.key; });
  var I_SETUP = KEYS.indexOf('setup'), I_EXCAVATION = KEYS.indexOf('excavation');

  function knownKey(key) {
    if (typeof key !== 'string') return null;
    var i = KEYS.indexOf(key);
    if (i < 0) i = KEYS.indexOf(key.trim().toLowerCase());
    return i < 0 ? null : KEYS[i];
  }
  /** 0..6; unknown or missing -> 0 ("ready"). */
  function stageIndex(key) { var k = knownKey(key); return k ? KEYS.indexOf(k) : 0; }
  /** A valid stage key; unknown or missing -> "ready". */
  function normalize(key) { return KEYS[stageIndex(key)]; }

  /* ---------- small helpers ---------- */
  function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function isPlainObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str(v) { return typeof v === 'string' ? v : ''; }
  function noop() {}
  function parseJSON(t) { try { return JSON.parse(t); } catch (e) { return null; } }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
      Object.freeze(o);
    }
    return o;
  }

  /* ---------- job items (r2-plan 1 + 2a) ---------- */
  // key, label, values (order = switch order), labels (value -> text), def (default; asphalt/pavers: the
  // Jobber hint decides, see effective()), stages (where the switch is shown), whileReq (also shown later
  // while still "req"), doneOnlyAt (the value "done" is only allowed at this stage), dates (lane only).
  var ITEMS = deepFreeze([
    { key: 'assess', label: 'Assessed', values: ['no', 'virtual', 'onsite'],
      labels: { no: 'Not yet', virtual: 'Virtual', onsite: 'On site', prior: 'Assessed before beta' }, def: 'no',
      stages: ['ready', 'setup'], whileReq: false },
    { key: 'lane', label: 'Lane closure', values: ['na', 'req', 'booked'],
      labels: { na: 'N/A', req: 'Required', booked: 'Booked' }, def: 'na',
      stages: ['ready', 'setup'], whileReq: true, dates: true },
    { key: 'cut', label: 'Street cut', values: ['na', 'req', 'done'],
      labels: { na: 'N/A', req: 'Required', done: 'Done' }, def: 'na',
      stages: ['ready', 'setup'], whileReq: true },
    { key: 'asphalt', label: 'Asphalt', values: ['na', 'req', 'done'],
      labels: { na: 'N/A', req: 'Required', done: 'Done' }, def: 'na', hint: true,
      stages: KEYS.slice(), whileReq: false, doneOnlyAt: 'poured' },
    { key: 'pavers', label: 'Pavers', values: ['na', 'req', 'done'],
      labels: { na: 'N/A', req: 'Required', done: 'Done' }, def: 'na', hint: true,
      stages: KEYS.slice(), whileReq: false, doneOnlyAt: 'poured' },
    { key: 'cleanup', label: 'Cuts & cleanup', values: ['todo', 'done'],
      labels: { todo: 'To do', done: 'Done' }, def: 'todo',
      stages: ['poured'], whileReq: false, doneOnlyAt: 'poured' }
  ]);
  /* r2-plan sec. 10 ("Existing jobs = assessed"): jobs already in Jobber when the beta launched count as assessed.
   * The highest non-pending Jobber jobNumber in data/jobs.json on launch day (2026-09-26). effective() reports
   * assess "prior" for a job <= this number (and < 9000, pending) with no stored assess. "prior" is display only:
   * not in ITEMS assess values, so it is never selectable, never accepted in a patch and dropped from files. */
  var ASSESS_CUTOFF = 699;
  var ITEM = {};
  ITEMS.forEach(function (it) { ITEM[it.key] = it; });
  function itemDef(key) { return typeof key === 'string' && has(ITEM, key) ? ITEM[key] : null; }
  function inValues(key, v) { return typeof v === 'string' && ITEM[key].values.indexOf(v) >= 0; }

  /** Every field a patch may carry, in file order (sat, at, by follow). */
  var FIELDS = ['stage', 'assess', 'lane', 'cut', 'asphalt', 'pavers', 'cleanup', 'removed'];
  /** Stored/queued fields: FIELDS + "sat" (stage-set time; set by the store itself, never by a patch). */
  var QFIELDS = FIELDS.concat(['sat']);
  /** ISO 8601 date-time with "Z" or a +-HH:MM offset ("2026-09-26T15:00:00Z", "...T10:00:00.5-05:00",
   *  "...T15:00Z") -> itself, or null. Compared as instants (tests/fixtures/overlay_vectors.json "times";
   *  sync_jobs.py parse_time matches). This app writes only toISOString's form without milliseconds.
   *  The raw string only (no trimming), and a real calendar time: Date.parse would also take 2026-02-30, 24:00 and
   *  year 0000, which Python (and so the sync) rejects. */
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
  /** ISO text -> ms, NaN when unusable (NaN never compares as newer). */
  function isoMs(v) { return cleanIso(v) ? Date.parse(v) : NaN; }

  /* ---------- constants ---------- */
  var FILE_VERSION = 2;           // the stages.json format this app writes; never writes over a newer one
  var REPO = 'Claude69420/eckstein-jobs-state';
  function apiUrl(file) { return 'https://api.github.com/repos/' + REPO + '/contents/' + file; }
  function rawUrl(file) { return 'https://raw.githubusercontent.com/' + REPO + '/main/' + file; }
  var API_URL = apiUrl('stages.json');  // default (main app) state file; a store uses its own config
  var RAW_URL = rawUrl('stages.json');
  // localStorage suffixes (key = config.ns + suffix). The cache holds the last good remote map {version, at, map}
  // (public data, never the key) for an offline cold start.
  var S_TOKEN = 'gh_token', S_LOCAL = 'stages', S_QUEUE = 'stage_queue', S_DEVICE = 'device', S_CACHE = 'stages_cache';
  var S_OVL_CACHE = 'overlay_cache'; // beta only: last good overlay {version, at, map}

  /* ---------- config (r2-plan sec. 9): window.EJ_CONFIG or env.config; defaults = the main app ---------- */
  var CONFIG_DEFAULTS = deepFreeze({ channel: 'main', base: '', ns: 'ej_', stateFile: 'stages.json', overlayFile: null,
    cachePrefix: 'ej-' });
  function okFile(v) { return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(v); }
  // The ONE ns rule: js/app.js, js/prices.js and the index.html boot script use this same pattern (tools/build_beta.py
  // mirrors it and refuses to build a beta whose config this function would lock).
  var NS_RE = /^[A-Za-z0-9_]{1,16}$/;
  var CONFIG_OK = {
    channel: function (v) { return typeof v === 'string' && /^[a-z0-9-]{1,16}$/.test(v); },
    base: function (v) { return typeof v === 'string' && /^(\.\.?\/)*$/.test(v) && v.length <= 32; },
    ns: function (v) { return typeof v === 'string' && NS_RE.test(v); },
    stateFile: okFile,
    overlayFile: function (v) { return v === null || okFile(v); },
    cachePrefix: function (v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(v); }
  };
  /** Any value -> a complete, validated config. No config (undefined / null) = the main app's defaults.
   *  FAIL CLOSED: a config that is not an object, has a bad value for a known field, overlays the file it writes,
   *  or is a non-main channel that would write v1's stages.json or use v1's "ej_" keys gets `locked` (a reason):
   *  the store then never writes anything (no GitHub PUT, no localStorage) instead of falling back to the main
   *  app's file and keys. A good config comes back field for field (no `locked` key). */
  function resolveConfig(c) {
    var d = CONFIG_DEFAULTS, src = isPlainObj(c) ? c : {}, bad = [];
    if (c !== undefined && c !== null && !isPlainObj(c)) bad.push('not an object');
    var o = {};
    Object.keys(CONFIG_OK).forEach(function (k) {
      var given = has(src, k), ok = given && CONFIG_OK[k](src[k]);
      if (given && !ok) bad.push(k);
      o[k] = ok ? src[k] : d[k];
    });
    if (o.overlayFile !== null && o.overlayFile === o.stateFile) { bad.push('overlayFile = stateFile'); o.overlayFile = null; }
    if (o.channel !== d.channel && o.stateFile === d.stateFile) bad.push('a ' + o.channel + ' app must not write ' + d.stateFile);
    if (o.channel !== d.channel && o.ns === d.ns) bad.push('a ' + o.channel + ' app must not use the "' + d.ns + '" keys');
    if (bad.length) o.locked = 'EJ_CONFIG: ' + bad.join(', ');
    return o;
  }
  var BATCH_MS = 3000;            // changes made within 3 s -> one commit
  var POLL_GITHUB_MS = 60000;     // with a key (fresh API reads)
  var POLL_READONLY_MS = 300000;  // raw CDN is cached for 300 s anyway
  var MAX_ATTEMPTS = 3;           // PUT attempts per save (409/422/5xx -> re-GET, merge, retry)
  var RETRY_BACKOFF_MS = 400;     // wait 400 ms, then 800 ms, before retries
  var REQUEST_TIMEOUT_MS = 20000; // a hung request must not block the save chain forever
  var MAX_COMMIT_MSG = 500;       // several-job commit messages stop listing jobs past this length ("; +N more")
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
    damaged: 'stages.json in eckstein-jobs-state is damaged (not valid stage JSON) \u2014 saving is paused until it is fixed',
    invalid: 'Invalid stage change',
    lane: 'Book the lane closure first',
    cut: 'Street cut must be done first',
    dates: 'End date is before start date',
    // beta overlay notes (status().overlay.note): never an error, never blocks a save
    ovDamaged: 'v1 stages file is damaged \u2014 v1 moves are not shown until it is fixed',
    ovNewer: 'v1 stages file is in a newer format \u2014 v1 moves are not shown',
    ovRead: 'Couldn\u2019t read v1 stages \u2014 showing the last known v1 moves',
    // fail-closed guards (never write v1's live file by mistake)
    config: 'This copy of the app is misconfigured (EJ_CONFIG) \u2014 stages are read-only here. Open the normal app link.',
    oldFormat: 'stages.json in eckstein-jobs-state is still in the v1 format (the live v1 app\u2019s file) \u2014 this ' +
      'version never converts it, so saving is paused'
  };
  function damagedMsg(file) { return MSG.damaged.replace('stages.json', file); }
  function oldFormatMsg(file) { return MSG.oldFormat.replace('stages.json', file); }

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
  /** "YYYY-MM-DD" that is a real calendar date, else null. */
  function cleanDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    var y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
    if (y < 1000 || m < 1 || m > 12 || d < 1) return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? v : null;
  }

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

  /* ---------- entries: sanitize (public file), patch values, apply ---------- */
  var INVALID = {}; // sentinel: a patch value that is not allowed

  /** Lane from the public file: {s, from?, to?}; dates kept only when booked and real. null when unusable. */
  function cleanLane(l) {
    if (!isPlainObj(l) || !has(l, 's') || !inValues('lane', l.s)) return null;
    var o = { s: l.s };
    if (l.s === 'booked') {
      var f = has(l, 'from') ? cleanDate(l.from) : null, t = has(l, 'to') ? cleanDate(l.to) : null;
      if (f) o.from = f;
      if (t) o.to = t;
    }
    return o;
  }
  function copyLane(l) {
    var o = { s: l.s };
    if (has(l, 'from')) o.from = l.from;
    if (has(l, 'to')) o.to = l.to;
    return o;
  }
  /** Content fields of a public-file entry (unknown values dropped, defaults dropped). Never null. */
  function cleanContent(v) {
    var o = {}, k;
    if (typeof v === 'string') { // v1 shorthand "684": "prep"
      k = knownKey(v);
      if (k && k !== 'ready') o.stage = k;
      return o;
    }
    if (!isPlainObj(v)) return o;
    if (has(v, 'stage')) { k = knownKey(v.stage); if (k && k !== 'ready') o.stage = k; }
    if (has(v, 'assess') && inValues('assess', v.assess) && v.assess !== 'no') o.assess = v.assess;
    if (has(v, 'lane')) { var l = cleanLane(v.lane); if (l && l.s !== 'na') o.lane = l; }
    if (has(v, 'cut') && inValues('cut', v.cut) && v.cut !== 'na') o.cut = v.cut;
    if (has(v, 'asphalt') && inValues('asphalt', v.asphalt)) o.asphalt = v.asphalt; // stored "na" beats the hint
    if (has(v, 'pavers') && inValues('pavers', v.pavers)) o.pavers = v.pavers;
    if (has(v, 'cleanup') && v.cleanup === 'done') o.cleanup = 'done';
    if (has(v, 'removed') && v.removed === true) o.removed = true;
    return o;
  }
  /** Holds anything but at/by? (A beta entry holding only "sat" means "the beta set Ready at sat".) */
  function hasContent(e) {
    if (!e) return false;
    for (var i = 0; i < QFIELDS.length; i++) if (has(e, QFIELDS[i])) return true;
    return false;
  }
  /** Canonical copy (file key order: FIELDS, sat, then at, by). */
  function copyEntry(e) {
    if (!e) return null;
    var o = {};
    QFIELDS.forEach(function (f) { if (has(e, f)) o[f] = f === 'lane' ? copyLane(e.lane) : e[f]; });
    if (has(e, 'at')) o.at = e.at;
    if (has(e, 'by')) o.by = e.by;
    return o;
  }
  /** Public-file entry -> stored entry {..., at, by}, or null when it holds nothing but defaults. */
  function cleanEntry(v) {
    var o = cleanContent(v);
    var isObj = isPlainObj(v);
    if (isObj && has(v, 'sat') && cleanIso(v.sat)) o.sat = v.sat;
    if (!hasContent(o)) return null;
    // at/by come from a public file that anyone with a key can edit: one line, bounded, no bidi overrides.
    o.at = isObj && has(v, 'at') ? cleanLabel(str(v.at)).slice(0, 40) : '';
    o.by = isObj && has(v, 'by') ? cleanLabel(str(v.by)).slice(0, 40) : '';
    return copyEntry(o);
  }
  function contentKey(e) {
    if (!hasContent(e)) return '';
    var c = copyEntry(e);
    delete c.at; delete c.by;
    return JSON.stringify(c);
  }
  function entryKey(e) { return hasContent(e) ? JSON.stringify(copyEntry(e)) : ''; }

  /** One patch value -> canonical value, or INVALID. null resets the field to its default (asphalt/pavers:
   *  back to following the Jobber hint). */
  function cleanFieldValue(f, v) {
    switch (f) {
      case 'stage':
        if (v === null) return 'ready';
        return knownKey(v) || INVALID;
      case 'assess': case 'cut': case 'cleanup':
        if (v === null) return ITEM[f].def;
        return inValues(f, v) ? v : INVALID;
      case 'asphalt': case 'pavers':
        if (v === null) return null;
        return inValues(f, v) ? v : INVALID;
      case 'removed':
        if (v === null) return false;
        return typeof v === 'boolean' ? v : INVALID;
      case 'sat': // internal (the store sets it, cleanPatch never accepts it); null drops it
        if (v === null) return null;
        return cleanIso(v) || INVALID;
      case 'lane': {
        if (v === null) return { s: 'na' };
        if (typeof v === 'string') return inValues('lane', v) ? { s: v } : INVALID;
        if (!isPlainObj(v) || !has(v, 's') || !inValues('lane', v.s)) return INVALID;
        var o = { s: v.s }, bad = false;
        ['from', 'to'].forEach(function (d) {
          if (!has(v, d) || v[d] === null || v[d] === undefined || v[d] === '') return; // cleared date input
          var c = cleanDate(v[d]);
          if (!c) bad = true;
          else if (v.s === 'booked') o[d] = c; // dates only mean something when booked
        });
        if (o.from && o.to && o.from > o.to) bad = true; // YYYY-MM-DD compares as text
        return bad ? INVALID : o;
      }
    }
    return INVALID;
  }
  function isDefaultValue(f, v) {
    switch (f) {
      case 'stage': return v === 'ready';
      case 'lane': return !v || v.s === 'na';
      case 'asphalt': case 'pavers': case 'sat': return v === null;
      case 'removed': return v !== true;
      default: return v === ITEM[f].def;
    }
  }
  /** set() argument -> fields {field: canonical value}, or null when invalid. A string is {stage: key}
   *  (R-1 shorthand: unknown keys count as "ready"). An object must hold only known fields with allowed values. */
  function cleanPatch(p) {
    if (typeof p === 'string') return { stage: normalize(p) };
    if (!isPlainObj(p)) return null;
    var out = {}, n = 0, bad = false;
    Object.keys(p).forEach(function (f) {
      if (p[f] === undefined) return;
      if (FIELDS.indexOf(f) < 0) { bad = true; return; }
      var c = cleanFieldValue(f, p[f]);
      if (c === INVALID) { bad = true; return; }
      out[f] = c; n++;
    });
    return bad || !n ? null : out;
  }
  function copyFields(fields) {
    var o = {};
    QFIELDS.forEach(function (f) { if (has(fields, f)) o[f] = f === 'lane' ? copyLane(fields.lane) : fields[f]; });
    return o;
  }
  /** Stored entry (or null) + fields -> new entry object (defaults dropped; at/by carried over unchanged). */
  function applyFields(e, fields) {
    var o = copyEntry(e) || {};
    QFIELDS.forEach(function (f) {
      if (!has(fields, f)) return;
      var v = fields[f];
      if (isDefaultValue(f, v)) delete o[f];
      else o[f] = f === 'lane' ? copyLane(v) : v;
    });
    return o;
  }

  /* ---------- pure model helpers (r2-plan 2a; sync_jobs.py mirrors these exactly) ---------- */
  /** True when the job existed before the beta (r2-plan sec. 10): a number <= ASSESS_CUTOFF and < 9000, whatever is
   *  stored for it (the app uses it to refuse "Not yet" on such a job even while a Virtual / On site is stored). */
  function priorAssessed(jobNumber) {
    return typeof jobNumber === 'number' && isFinite(jobNumber) && jobNumber <= ASSESS_CUTOFF && jobNumber < 9000;
  }
  /** Stored entry + job.hints (+ optional jobNumber) -> every field with defaults and hints applied.
   *  jobNumber (r2-plan sec. 10): priorAssessed(jobNumber) makes a missing assess "prior" (assessed before the
   *  beta). Without it (sync_jobs.py, contract vectors, gates) the default stays "no". */
  function effective(entry, hints, jobNumber) {
    var e = cleanContent(entry);
    var h = isPlainObj(hints) ? hints : {};
    return {
      stage: has(e, 'stage') ? e.stage : 'ready',
      assess: has(e, 'assess') ? e.assess : (priorAssessed(jobNumber) ? 'prior' : 'no'),
      lane: has(e, 'lane') ? copyLane(e.lane) : { s: 'na' },
      cut: has(e, 'cut') ? e.cut : 'na',
      asphalt: has(e, 'asphalt') ? e.asphalt : (h.asphalt === true ? 'req' : 'na'),
      pavers: has(e, 'pavers') ? e.pavers : (h.pavers === true ? 'req' : 'na'),
      cleanup: has(e, 'cleanup') ? e.cleanup : 'todo',
      removed: has(e, 'removed') && e.removed === true
    };
  }
  function ok() { return { ok: true }; }
  function blocked(reason, message) { return { ok: false, reason: reason, message: message }; }
  /** Stage move gates. Moving backwards (or staying) is always allowed. */
  function canMove(entry, toStageKey, hints) {
    var eff = effective(entry, hints);
    var from = stageIndex(eff.stage), to = stageIndex(toStageKey);
    if (to <= from) return ok();
    if (to >= I_SETUP && eff.lane.s === 'req') return blocked('lane', MSG.lane);
    if (to >= I_EXCAVATION && eff.cut === 'req') return blocked('cut', MSG.cut);
    return ok();
  }
  /** Item switch rules: asphalt / pavers / cleanup can be set to "done" only while the stage is "poured".
   *  item "stage" is the same as canMove. Unknown items or values -> {ok:false, reason:'invalid'}. */
  function canSetItem(entry, item, value, hints) {
    if (item === 'stage') {
      if (value !== null && !knownKey(value)) return blocked('invalid', MSG.invalid);
      return canMove(entry, value === null ? 'ready' : value, hints);
    }
    if (item !== 'removed' && !itemDef(item)) return blocked('invalid', MSG.invalid);
    if (item === 'lane' && isPlainObj(value) && value.s === 'booked' && cleanDate(value.from) && cleanDate(value.to) &&
        value.from > value.to) return blocked('dates', MSG.dates);
    if (cleanFieldValue(item, value) === INVALID) return blocked('invalid', MSG.invalid);
    var def = itemDef(item);
    if (def && def.doneOnlyAt && value === 'done' && effective(entry, hints).stage !== def.doneOnlyAt) {
      return blocked('poured', def.label + ' can only be marked Done once the job is Poured');
    }
    return ok();
  }
  /** stage poured AND cleanup done AND asphalt != req AND pavers != req. Takes effective(). */
  function fieldWorkDone(eff) {
    return !!eff && eff.stage === 'poured' && eff.cleanup === 'done' && eff.asphalt !== 'req' && eff.pavers !== 'req';
  }
  /** Keep a job that left Jobber's active list? Takes effective(). */
  function keepWhenClosed(eff) {
    if (!eff || eff.removed === true || fieldWorkDone(eff)) return false;
    var ls = eff.lane && eff.lane.s;
    return stageIndex(eff.stage) > 0 || eff.asphalt === 'req' || eff.pavers === 'req' || eff.cut === 'req' ||
      ls === 'req' || ls === 'booked';
  }
  /** Is the item's switch shown for this job? (Its stages, plus later stages while still Required.) */
  function itemShown(eff, item) {
    var def = itemDef(item);
    if (!def || !eff) return false;
    if (def.stages.indexOf(normalize(eff.stage)) >= 0) return true;
    var v = item === 'lane' ? (eff.lane && eff.lane.s) : eff[item];
    return def.whileReq && v === 'req';
  }
  function isEarly(eff) { var k = eff.stage; return k === 'ready' || k === 'setup'; }
  /** Item chips (Stage mode). predicate(effective()) -> boolean. */
  var LISTS = deepFreeze([
    { key: 'unassessed', label: 'Unassessed', predicate: function (eff) { return !!eff && isEarly(eff) && eff.assess === 'no'; } },
    { key: 'booklane', label: 'Book lane', predicate: function (eff) { return !!eff && !!eff.lane && eff.lane.s === 'req'; } },
    { key: 'streetcuts', label: 'Street cuts', predicate: function (eff) { return !!eff && eff.cut === 'req'; } },
    { key: 'cleanup', label: 'Cuts & cleanup', predicate: function (eff) { return !!eff && eff.stage === 'poured' && eff.cleanup === 'todo'; } },
    { key: 'asphalt', label: 'Asphalt', predicate: function (eff) { return !!eff && eff.stage === 'poured' && eff.asphalt === 'req'; } },
    { key: 'pavers', label: 'Pavers', predicate: function (eff) { return !!eff && eff.stage === 'poured' && eff.pavers === 'req'; } }
  ]);

  /* ---------- stages.json shape ---------- */
  // Map = { "<jobNumber>": stored entry } holding only entries with at least one non-default field.
  /** Any parsed JSON -> {map, extras, version}; malformed/missing -> empty map. Unknown top-level fields are kept.
   *  Keys that differ only by whitespace (" 684" and "684", hand edits): the exact key always wins, otherwise the
   *  last one in the file (independent of Object.keys order, which lists integer-like keys first). */
  function sanitizeDoc(obj) {
    var map = {}, extras = {};
    if (isPlainObj(obj)) {
      Object.keys(obj).forEach(function (k) {
        if (k !== 'version' && k !== 'stages' && k !== '__proto__') extras[k] = obj[k];
      });
      var st = obj.stages;
      if (isPlainObj(st)) {
        var raw = {}, exact = {};
        Object.keys(st).forEach(function (k) {
          var jn = cleanJobKey(k);
          if (!jn || (jn !== k && has(exact, jn))) return;
          raw[jn] = st[k];
          if (jn === k) exact[jn] = true;
        });
        Object.keys(raw).forEach(function (jn) {
          var e = cleanEntry(raw[jn]);
          if (e) map[jn] = e;
        });
      }
    }
    var version = isPlainObj(obj) && typeof obj.version === 'number' ? obj.version : 1;
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
  /* ---------- stage overlay (beta, r2-plan sec. 9): v1's stages.json, read-only ---------- */
  /** Parsed overlay file -> {map: {jn: {stage, at, by}}, version}. Only the stage matters: an entry counts when its
   *  stage is a known key ("ready" included, e.g. a v2 file); items in it are ignored. at is kept only when the raw
   *  value is a time (cleanIso), by is cleaned like cleanEntry's. Job keys are normalised like sanitizeDoc's
   *  (exact key wins). */
  function sanitizeOverlay(obj) {
    var map = {};
    if (isPlainObj(obj) && isPlainObj(obj.stages)) {
      var st = obj.stages, raw = {}, exact = {};
      Object.keys(st).forEach(function (k) {
        var jn = cleanJobKey(k);
        if (!jn || (jn !== k && has(exact, jn))) return;
        raw[jn] = st[k];
        if (jn === k) exact[jn] = true;
      });
      Object.keys(raw).forEach(function (jn) {
        var v = raw[jn], isObj = isPlainObj(v);
        var k = knownKey(typeof v === 'string' ? v : (isObj && has(v, 'stage') ? v.stage : null));
        if (!k) return;
        // at: the RAW string when it is a time (cleanIso), else '' (never trimmed into one: sync_jobs.py parse_time
        // reads it raw too, and both must pick the same stage)
        map[jn] = { stage: k, at: isObj && cleanIso(v.at) ? v.at : '',
          by: isObj && has(v, 'by') ? cleanLabel(str(v.by)).slice(0, 40) : '' };
      });
    }
    var version = isPlainObj(obj) && typeof obj.version === 'number' ? obj.version : 1;
    return { map: map, version: version };
  }
  function parseOverlayText(text) {
    return sanitizeOverlay(parseJSON(String(text || '').replace(/^\ufeff/, '')));
  }
  /** Overlay rule: does the overlay's stage replace the state entry's? (valid overlay stage AND (no sat OR
   *  overlay.at > sat)). An unusable overlay.at never beats a sat. */
  function overlayWins(e, ov) {
    if (!ov || !knownKey(ov.stage)) return false;
    if (!e || !has(e, 'sat') || !cleanIso(e.sat)) return true;
    return isoMs(ov.at) > isoMs(e.sat);
  }
  /** Merged entry = the state entry (items, sat) with the stage from the overlay when overlayWins; at/by then come
   *  from the overlay when it is the newer change (the UI's "Updated ... by ..."). null when nothing is left. */
  function mergeEntry(e, ov) {
    if (!overlayWins(e, ov)) return e ? copyEntry(e) : null;
    var o = copyEntry(e) || {};
    if (ov.stage === 'ready') delete o.stage; else o.stage = ov.stage;
    var ea = isoMs(e && e.at), oa = isoMs(ov.at);
    if (!e || oa > ea || (isNaN(ea) && !isNaN(oa))) { o.at = ov.at; o.by = ov.by; }
    return hasContent(o) ? copyEntry(o) : null;
  }
  /** state map + overlay map -> merged map (new objects). */
  function mergeOverlay(state, ov) {
    var o = copyMap(state);
    Object.keys(ov || {}).forEach(function (jn) {
      var m = mergeEntry(has(o, jn) ? o[jn] : null, ov[jn]);
      if (m) o[jn] = m; else delete o[jn];
    });
    return o;
  }

  /** File text (v2): 2-space JSON + trailing newline; numeric job keys come out in ascending order. */
  function serializeDoc(map, extras) {
    var stages = {};
    Object.keys(map).forEach(function (jn) { stages[jn] = copyEntry(map[jn]); });
    var doc = { version: FILE_VERSION, stages: stages };
    if (extras) Object.keys(extras).forEach(function (k) { if (!has(doc, k)) doc[k] = extras[k]; });
    return JSON.stringify(doc, null, 2) + '\n';
  }
  function copyMap(m) {
    var o = {};
    Object.keys(m || {}).forEach(function (k) { o[k] = copyEntry(m[k]); });
    return o;
  }
  /** changes = {jn: {fields, at, by}}: per-field merge on top of base; an entry left with only defaults is
   *  deleted. Returns a new map. */
  function applyChanges(base, changes) {
    var o = copyMap(base);
    Object.keys(changes || {}).forEach(function (jn) {
      var c = changes[jn], e = applyFields(has(o, jn) ? o[jn] : null, c.fields);
      if (hasContent(e)) { e.at = c.at; e.by = c.by; o[jn] = copyEntry(e); }
      else delete o[jn];
    });
    return o;
  }
  function sameMap(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (!has(b, ka[i]) || entryKey(a[ka[i]]) !== entryKey(b[ka[i]])) return false;
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
  /** Commit-message text of one stored field ("auto" = asphalt/pavers follow the Jobber hint again). */
  function fieldText(f, e) {
    var v = has(e, f) ? e[f] : undefined;
    switch (f) {
      case 'stage': return v || 'ready';
      case 'lane':
        if (!v) return 'na';
        return v.s + (v.from || v.to ? ' ' + (v.from || '') + '..' + (v.to || '') : '');
      case 'asphalt': case 'pavers': return v || 'auto';
      case 'removed': return v === true ? 'true' : 'false';
      default: return v || ITEM[f].def;
    }
  }
  /** ["stage -> setup", "lane -> booked 2026-10-06..2026-10-08"]: the fields this change really altered. A stage
   *  set that only renews "sat" (beta: the same stage as the file, over a v1 move) still reads "stage -> X". */
  function describeChange(before, after, fields) {
    var parts = [];
    FIELDS.forEach(function (f) {
      if (!has(fields, f)) return;
      var a = fieldText(f, before), b = fieldText(f, after);
      if (a !== b || (f === 'stage' && has(fields, 'sat') && str(before && before.sat) !== str(after && after.sat))) {
        parts.push(f + ' -> ' + b);
      }
    });
    return parts;
  }
  /** desc = {jn: {label, parts}} ->
   *  one job:  "job #684 SW Corner Ellice & Kennedy: stage -> setup, lane -> booked 2026-10-06..2026-10-08"
   *  several:  "jobs: #684 stage -> base; #699 asphalt -> done" (bounded: "; +N more"). */
  function commitMessage(desc) {
    var jns = sortJobKeys(Object.keys(desc));
    if (jns.length === 1) {
      var d = desc[jns[0]], lbl = cleanLabel(d.label);
      return 'job #' + jns[0] + (lbl ? ' ' + lbl : '') + ': ' + d.parts.join(', ');
    }
    var out = 'jobs: ', n = 0;
    for (var i = 0; i < jns.length; i++) {
      var part = '#' + jns[i] + ' ' + desc[jns[i]].parts.join(', ');
      if (n && out.length + part.length + 2 > MAX_COMMIT_MSG) break;
      out += (n ? '; ' : '') + part;
      n++;
    }
    if (n < jns.length) out += '; +' + (jns.length - n) + ' more';
    return out;
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

    /* --- config: env.config (tests) or window.EJ_CONFIG; defaults = the main app --- */
    var cfg = resolveConfig(has(env, 'config') ? env.config : (function () { try { return G.EJ_CONFIG; } catch (e) { return null; } })());
    var NS = cfg.ns, STATE_FILE = cfg.stateFile, OVL_FILE = cfg.overlayFile;
    // A locked (bad) config never writes: no localStorage at all (so never v1's "ej_" keys), mode always "readonly",
    // setKey refused. It still shows the stages read-only, with MSG.config as a permanent error.
    var LOCKED = cfg.locked || null;
    if (LOCKED) storage = null;
    // Never PUT a v2 document over an existing file that is still v1 (during the beta trial that is the live v1
    // app's stages.json: every v1 device would stop saving). Promotion converts the file first; only a test or a
    // one-off migration passes env.allowUpgrade.
    var ALLOW_UPGRADE = env.allowUpgrade === true;
    var LS_TOKEN = NS + S_TOKEN, LS_LOCAL = NS + S_LOCAL, LS_QUEUE = NS + S_QUEUE, LS_DEVICE = NS + S_DEVICE;
    var LS_CACHE = NS + S_CACHE, LS_OVL_CACHE = NS + S_OVL_CACHE;
    var STATE_API = apiUrl(STATE_FILE), STATE_RAW = rawUrl(STATE_FILE);
    var OVL_API = OVL_FILE ? apiUrl(OVL_FILE) : null, OVL_RAW = OVL_FILE ? rawUrl(OVL_FILE) : null;

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
    var remoteVersion = 1;    // file format version last read; this app writes v2 and never over a newer file
    var lastSync = null;      // ms of the last good read/save (seeded from the cache below)
    var sha = null;          // blob sha of stages.json (null = file missing, when ghLoaded)
    var ghLoaded = false;     // remote + sha are known from the API for the current key
    var remoteKnown = false;  // remote has been read at least once (enables the no-op shortcut in set)
    var lastError = null, errKind = null; // errKind: 'read' | 'save' | 'auth' | 'config' (locked: never cleared)
    function setError(kind, msg) { lastError = msg; errKind = kind; }
    // A successful read clears only read errors; a save error stays until a save succeeds,
    // an auth error until the key is replaced or removed.
    function clearError(kinds) {
      if (errKind === 'config') return;
      if (!kinds || kinds.indexOf(errKind) >= 0) { lastError = null; errKind = null; }
    }
    if (LOCKED) setError('config', MSG.config);
    // Unsaved changes (write-ahead, persisted), per job with a per-FIELD merge (last write per field wins):
    // {jn: {fields, fb, at, by, label}}; fb = {field: batch id} (see the queue section below)
    var queue = loadQueue();
    var batchSeq = 0, openBatch = null; // {id (>= 1), timer, waiters:[{jn, prev, resolve, reject}]}
    var chain = Promise.resolve();      // serialises every GET/PUT so reads never race writes
    var replayScheduled = false;
    var shown = null;         // the map the UI is believed to show (for onChange diffing)
    var changeFns = [], statusFns = [], lastStatusJSON = '';
    var started = false, pollTimer = null;
    // Overlay (beta only; OVL_FILE null = none): {jn: {stage (valid key, "ready" included), at, by}} of the last good
    // read. Never written back. A damaged/newer file -> {} + ovNote; a failed read keeps the last one.
    var overlay = {}, ovNote = null, ovSync = null;

    function mode() {
      if (LOCKED) return 'readonly';
      if (token) return keyInvalid ? 'invalid' : 'github';
      return LOCAL_HOSTS.indexOf(hostname.toLowerCase()) >= 0 ? 'local' : 'readonly';
    }
    function isWritable() { var m = mode(); return m === 'github' || m === 'local'; }

    /* --- offline / write-ahead queue: localStorage "ej_stage_queue" --- */
    // Every queued FIELD carries the batch that set it (entry.fb[field]): a batch id while the change waits in an
    // open/closing batch; 0 once it is a plain queued change (network failure, or left over from an earlier session).
    // A save sends only the fields tagged with its batch (or 0) and afterwards removes only the fields that still
    // carry the tag it sent. So a field set again meanwhile (a newer batch) is neither lost nor re-sent, and a
    // saved field is never sent a second time over another device's newer value.
    // Stored format v2 {version:2, changes:{jn:{fields, at, by, label}}} (tags are not stored: all load as 0);
    // R-1's v1 {jn:{stage, at, by, label}} still loads.
    function loadQueue() {
      var raw = parseJSON(sGet(LS_QUEUE)), q = {};
      var src = isPlainObj(raw) ? (isPlainObj(raw.changes) ? raw.changes : raw) : null;
      if (src) {
        Object.keys(src).forEach(function (k) {
          var jn = cleanJobKey(k), v = src[k], f = {};
          if (!jn || !isPlainObj(v)) return;
          if (has(v, 'fields') && isPlainObj(v.fields)) {
            QFIELDS.forEach(function (fk) {
              if (!has(v.fields, fk)) return;
              var c = cleanFieldValue(fk, v.fields[fk]);
              if (c !== INVALID) f[fk] = c;
            });
          } else if (has(v, 'stage') && typeof v.stage === 'string') {
            f.stage = normalize(v.stage);
          }
          if (!Object.keys(f).length) return;
          var fb = {};
          Object.keys(f).forEach(function (fk) { fb[fk] = 0; });
          q[jn] = { fields: f, fb: fb, at: cleanLabel(str(v.at)).slice(0, 40), by: cleanLabel(str(v.by)).slice(0, 40),
            label: cleanLabel(v.label) };
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
        out[jn] = { fields: copyFields(e.fields), at: e.at, by: e.by, label: e.label };
      });
      sSet(LS_QUEUE, JSON.stringify({ version: 2, changes: out }));
    }
    function hasTag(e, tag) { return Object.keys(e.fb).some(function (f) { return e.fb[f] === tag; }); }
    /** Queued fields of one job tagged with batch `bid` or 0 -> {change: {fields, at, by, label}, tags}, or null. */
    function takeFields(e, bid) {
      var f = {}, t = {}, n = 0;
      QFIELDS.forEach(function (k) {
        if (has(e.fields, k) && (e.fb[k] === 0 || e.fb[k] === bid)) { f[k] = e.fields[k]; t[k] = e.fb[k]; n++; }
      });
      return n ? { change: { fields: copyFields(f), at: e.at, by: e.by, label: e.label }, tags: t } : null;
    }
    /** Remove the queued fields named in `tags` ({jn: {field: tag}}) that still carry that tag
     *  (with onlyTag: only fields of that batch). */
    function forgetFields(tags, onlyTag) {
      Object.keys(tags).forEach(function (jn) {
        var e = has(queue, jn) ? queue[jn] : null, t = tags[jn];
        if (!e) return;
        Object.keys(t).forEach(function (f) {
          if (e.fb[f] !== t[f] || (onlyTag !== undefined && t[f] !== onlyTag)) return;
          delete e.fields[f]; delete e.fb[f];
        });
        if (!Object.keys(e.fb).length) delete queue[jn];
      });
      saveQueue();
    }

    /* --- last good remote map: localStorage "ej_stages_cache". It seeds `remote`, so an offline cold start
     *     shows the last known stages instead of "every job Ready". remoteKnown stays false until a real
     *     read, so set() still reads the server before it skips a "no-op" change. --- */
    function writeCache() {
      sSet(LS_CACHE, JSON.stringify({ version: FILE_VERSION, at: lastSync || now(), map: copyMap(remote) }));
    }
    function readCache() {
      var c = parseJSON(sGet(LS_CACHE));
      if (!isPlainObj(c) || !isPlainObj(c.map)) return null;
      return { map: sanitizeDoc({ stages: c.map }).map, at: typeof c.at === 'number' && isFinite(c.at) ? c.at : null };
    }
    if (mode() !== 'local') {
      var cached = readCache();
      if (cached) { remote = cached.map; lastSync = cached.at; }
    }
    // Overlay cache (beta; any mode, local included): the last good overlay for an offline cold start.
    function writeOvlCache() {
      if (OVL_FILE) sSet(LS_OVL_CACHE, JSON.stringify({ version: FILE_VERSION, at: ovSync || now(), map: overlay }));
    }
    if (OVL_FILE) {
      var oc = parseJSON(sGet(LS_OVL_CACHE));
      if (isPlainObj(oc) && isPlainObj(oc.map)) {
        overlay = sanitizeOverlay({ stages: oc.map }).map;
        ovSync = typeof oc.at === 'number' && isFinite(oc.at) ? oc.at : null;
      }
    }

    /* --- local mode: localStorage "ej_stages" (same file shape) --- */
    function readLocal() { return parseDocText(sGet(LS_LOCAL)).map; }
    function writeLocal(map) { return sSet(LS_LOCAL, serializeDoc(map)); }

    /* --- current map = remote + unsaved changes on top (stored entries, not effective values) --- */
    function currentMap() {
      return mode() === 'local' ? readLocal() : applyChanges(remote, queue);
    }
    /* --- what the UI sees: the current map merged with the overlay (beta), else the current map --- */
    function viewMap() { return OVL_FILE ? mergeOverlay(currentMap(), overlay) : currentMap(); }
    function viewEntry(jn) { var v = viewMap(); return has(v, jn) ? v[jn] : null; }

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
      var s = { mode: mode(), writable: isWritable(), pending: mode() === 'local' ? 0 : Object.keys(queue).length,
        lastError: lastError, lastSync: lastSync };
      // Beta only: the read-only v1 overlay. note = why v1 moves are not shown (damaged / newer / read failed).
      if (OVL_FILE) s.overlay = { file: OVL_FILE, stateFile: STATE_FILE, note: ovNote, lastSync: ovSync };
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
      var cur = viewMap();
      if (!force && shown && sameMap(cur, shown)) return;
      shown = copyMap(cur);
      changeFns.slice().forEach(function (fn) { try { fn(copyMap(cur)); } catch (e) { report(e); } });
    }
    // After a rejected set(), the UI's rollback handlers must run before we tell it the truth.
    function emitChangeLater() { setT(function () { emitChange(false); }, 0); }
    function shownPut(jn, entry) {
      if (!shown) return;
      if (hasContent(entry)) shown[jn] = copyEntry(entry); else delete shown[jn];
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
    /** Authenticated GET of one file in the state repo -> {text, sha} or {missing:true} (404). */
    function apiGetText(url, tok) {
      return request(url, { method: 'GET', headers: apiHeaders(tok, false), cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { missing: true };
        if (r.status !== 200) throw httpError(r, 'load');
        var j = parseJSON(r.text);
        if (!j || typeof j !== 'object' || typeof j.sha !== 'string') throw codeError('http', 'Couldn\u2019t load stages (bad response)', 200);
        if (j.encoding && j.encoding !== 'base64') throw codeError('http', 'Couldn\u2019t load stages (file too large)', 200);
        var text;
        try { text = typeof j.content === 'string' ? b64decodeUtf8(j.content) : ''; }
        catch (e) { throw codeError('http', 'Couldn\u2019t load stages (bad encoding)', 200); }
        return { text: text, sha: j.sha };
      });
    }
    /** Unauthenticated GET via the raw CDN (up to ~5 min stale; no Authorization header, no preflight). */
    function rawGetText(url) {
      return request(url + '?t=' + now(), { method: 'GET', cache: 'no-store' }).then(function (r) {
        if (r.status === 404) return { missing: true };
        if (r.status !== 200) throw codeError('http', 'Couldn\u2019t load stages (HTTP ' + r.status + ')', r.status);
        return { text: r.text };
      });
    }
    /** Authenticated read of the state file (fresh). 404 -> empty map, sha null (a PUT without sha creates the file). */
    function getRemoteGithub(tok) {
      return apiGetText(STATE_API, tok).then(function (res) {
        if (res.missing) return { map: {}, extras: {}, sha: null, missing: true };
        if (isDamaged(res.text)) throw codeError('http', damagedMsg(STATE_FILE), 200); // keep the last known map; block saves
        var parsed = parseDocText(res.text);
        return { map: parsed.map, extras: parsed.extras, sha: res.sha, version: parsed.version };
      });
    }
    /** Unauthenticated read of the state file. */
    function getRemoteRaw() {
      return rawGetText(STATE_RAW).then(function (res) {
        if (res.missing) return { map: {}, extras: {} };
        if (isDamaged(res.text)) throw codeError('http', damagedMsg(STATE_FILE), 200);
        return parseDocText(res.text);
      });
    }
    function wait(ms) { return new Promise(function (resolve) { setT(resolve, ms); }); }

    /** Serialise async work. */
    function enqueue(fn) {
      var p = chain.then(fn, fn);
      chain = p.then(noop, noop);
      return p;
    }

    /** Refresh `remote` (state file) and, in the beta, the overlay. Never rejects. */
    function fetchRemote() { return fetchState().then(fetchOverlay); }

    /** Refresh `remote` for the current mode. Never rejects; sets lastError instead. */
    function fetchState() {
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
          return fetchState(); // show the (read-only) truth from the CDN copy
        }
        if (!errKind || errKind === 'read') {
          setError('read', err.code === 'network' ? (lastSync ? MSG.loadOffline : MSG.loadOfflineEmpty) : err.message);
        }
      });
    }

    /** Beta: refresh the read-only overlay (v1's file) with the same transport as the state file: the API with a
     *  working key, the raw CDN otherwise (local mode included). Never rejects, never sets lastError, never blocks a
     *  save: damaged / newer -> no overlay + note; 404 -> no overlay; a failed read keeps the last good overlay. */
    function fetchOverlay() {
      if (!OVL_FILE) return Promise.resolve();
      var m = mode(), g = gen;
      var p = m === 'github'
        ? apiGetText(OVL_API, token).then(null, function (err) {
          if (err.code === 'auth') return rawGetText(OVL_RAW); // the state read reports the key; still show v1
          throw err;
        })
        : rawGetText(OVL_RAW);
      return p.then(function (res) {
        if (g !== gen) return;
        var note = null, map = {};
        if (!res.missing) {
          if (isDamaged(res.text)) note = MSG.ovDamaged;
          else {
            var d = parseOverlayText(res.text);
            if (d.version > FILE_VERSION) note = MSG.ovNewer; else map = d.map;
          }
        }
        overlay = map; ovNote = note; ovSync = now();
        writeOvlCache();
      }, function (err) {
        if (g !== gen) return;
        if (err.code !== 'network') ovNote = MSG.ovRead; // keep the last good overlay
      });
    }

    /** GET-if-needed, merge `changes` field by field on top of the remote file, PUT with sha;
     *  409/422/5xx -> re-GET (other devices' fields keep their values, this device's changed fields win) + retry. */
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
          if (remoteVersion > FILE_VERSION) throw codeError('http', MSG.newer, 200); // never strip fields a newer app wrote
          if (sha && remoteVersion < FILE_VERSION && !ALLOW_UPGRADE) throw codeError('http', oldFormatMsg(STATE_FILE), 200);
          var real = {}, desc = {};
          Object.keys(changes).forEach(function (jn) {
            var c = changes[jn], before = has(remote, jn) ? remote[jn] : null, after = applyFields(before, c.fields);
            if (contentKey(before) === contentKey(after)) return; // GitHub already has it: leave the job alone
            real[jn] = c;
            desc[jn] = { label: c.label, parts: describeChange(before, after, c.fields) };
          });
          if (!Object.keys(real).length) return; // nothing new: skip (GitHub would make an empty commit)
          var merged = applyChanges(remote, real);
          var payload = { message: commitMessage(desc), content: b64encodeUtf8(serializeDoc(merged, remoteExtras)), branch: 'main' };
          if (sha) payload.sha = sha;
          return request(STATE_API, { method: 'PUT', headers: apiHeaders(tok, true), body: JSON.stringify(payload), cache: 'no-store' })
            .then(function (r) {
              if (g !== gen) throw codeError('stale', 'Key changed');
              if (r.status === 200 || r.status === 201) {
                var j = parseJSON(r.text);
                sha = j && j.content && typeof j.content.sha === 'string' ? j.content.sha : null;
                ghLoaded = !!sha; // unknown new sha -> GET before the next write
                remote = merged; remoteVersion = FILE_VERSION; lastSync = now();
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
      var bid = batch ? batch.id : -1, snap = {}, tags = {}; // snap: copies (set() may change the queue meanwhile)
      Object.keys(queue).forEach(function (jn) {
        var t = takeFields(queue[jn], bid);
        if (t) { snap[jn] = t.change; tags[jn] = t.tags; }
      });
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
      var m = mode();
      if (m !== 'github') {
        // Key removed or rejected while the batch was open: this batch cannot be saved. Earlier queued (offline)
        // changes, even of the same job, stay queued for the next key.
        forgetFields(tags, bid);
        settle(m === 'invalid' ? codeError('auth', MSG.auth) : codeError('readonly', MSG.readonly));
        emitStatus(); emitChangeLater();
        return Promise.resolve();
      }
      if (!jns.length) { settle(null, { status: 'saved' }); return Promise.resolve(); }
      var g = gen;
      return saveChanges(snap).then(function () {
        forgetFields(tags); // fields set again meanwhile (a newer batch) stay queued
        clearError();
        settle(null, { status: 'saved' });
        emitStatus(); emitChangeLater(); // a retry may have pulled in other devices' changes
      }, function (err) {
        if (err.code === 'network' || err.code === 'stale' || g !== gen) {
          // Offline (or the key changed mid-save): keep the changes queued; replay on online /
          // visibilitychange / next poll (or right away with the new key).
          jns.forEach(function (jn) {
            var e = has(queue, jn) ? queue[jn] : null;
            if (e) Object.keys(tags[jn]).forEach(function (f) { if (e.fb[f] === tags[jn][f]) e.fb[f] = 0; });
          });
          saveQueue();
          if (err.code === 'network') setError('save', MSG.offline);
          settle(null, { status: 'queued' });
          emitStatus();
          if (err.code !== 'network') maybeReplay();
          return;
        }
        forgetFields(tags); // this save's fields only; a newer batch of the same job keeps its own
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
      var any = Object.keys(queue).some(function (jn) { return hasTag(queue[jn], 0); });
      if (!any) return;
      replayScheduled = true;
      enqueue(function () { replayScheduled = false; return safeRun(null); });
    }

    /* --- polling --- */
    function isVisible() { return !doc || !doc.visibilityState || doc.visibilityState === 'visible'; }
    // Local mode polls only for the beta overlay (raw CDN, at the read-only cadence).
    function pollsHere() { return mode() !== 'local' || !!OVL_FILE; }
    function pollNow() {
      if (!isVisible() || !pollsHere()) return Promise.resolve();
      return enqueue(fetchRemote).then(function () { emitStatus(); maybeReplay(); emitChange(false); });
    }
    function schedulePoll() {
      if (pollTimer !== null) { clearT(pollTimer); pollTimer = null; }
      if (!started || !pollsHere()) return;
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
      peek: function () { return copyMap(viewMap()); },

      /** -> Promise<{jobNumber: stored entry}> (entries with at least one non-default field). Never rejects. */
      load: function () {
        return enqueue(fetchRemote).then(function () {
          var cur = viewMap();
          shown = copyMap(cur);
          emitStatus();
          maybeReplay();
          return copyMap(cur);
        });
      },

      /** set(jobNumber, patch | stageKey, {label}). patch = {stage?, assess?, lane?, cut?, asphalt?, pavers?,
       *  cleanup?, removed?} (null resets a field; asphalt/pavers null = follow the Jobber hint again).
       *  Optimistic; batched 3 s into one commit. -> Promise<{status:"saved"|"queued"}>; rejects Error{code}.
       *  Gates are the UI's job (canMove / canSetItem): the store records what it is given. */
      set: function (jobNumber, patchOrStageKey, meta) {
        var jn = cleanJobKey(jobNumber);
        if (!jn) return Promise.reject(codeError('http', 'Invalid job number'));
        var fields = cleanPatch(patchOrStageKey);
        if (!fields) return Promise.reject(codeError('http', MSG.invalid));
        var m = mode();
        if (m === 'readonly') return Promise.reject(codeError('readonly', MSG.readonly));
        if (m === 'invalid') return Promise.reject(codeError('auth', MSG.auth));
        var cur = currentMap(), before = has(cur, jn) ? cur[jn] : null;
        var known = m === 'local' || remoteKnown, at = isoNow();
        if (has(fields, 'stage')) {
          var fileStage = normalize(before && before.stage);
          if (OVL_FILE) {
            // Beta: "sat" records when this app set the stage, so a later v1 move shows and an earlier one does not.
            var ovE = has(overlay, jn) ? overlay[jn] : null, viewE = mergeEntry(before, ovE);
            if (known && fileStage === fields.stage && normalize(viewE && viewE.stage) === fields.stage) delete fields.stage;
            else {
              // This move was made on top of the v1 stage shown now, so it must beat it even when v1's clock runs
              // ahead of this device's: sat = max(now, that v1 at + 1 s) (skew up to a day; beyond that the v1 time
              // is nonsense and plain now is used).
              var oa = isoMs(ovE && ovE.at), na = isoMs(at);
              fields.sat = oa >= na && oa - na <= 86400000 ? new Date(oa + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : at;
            }
          } else if (before && has(before, 'sat') && fileStage !== fields.stage) {
            fields.sat = null; // no overlay here: a stale stage-set time means nothing, drop it with the move
          }
          if (!Object.keys(fields).length) return Promise.resolve({ status: 'saved' });
        }
        if (known && contentKey(before) === contentKey(applyFields(before, fields))) {
          return Promise.resolve({ status: 'saved' }); // nothing would change: no commit
        }
        var by = deviceLabel(), label = cleanLabel(meta && meta.label);
        if (m === 'local') {
          var map = readLocal(), e = applyFields(has(map, jn) ? map[jn] : null, fields);
          if (hasContent(e)) { e.at = at; e.by = by; map[jn] = copyEntry(e); } else delete map[jn];
          if (!writeLocal(map)) return Promise.reject(codeError('http', MSG.storage));
          shownPut(jn, viewEntry(jn));
          lastSync = now();
          emitStatus();
          return Promise.resolve({ status: 'saved' });
        }
        return new Promise(function (resolve, reject) {
          if (!openBatch) {
            openBatch = { id: ++batchSeq, waiters: [], timer: null };
            openBatch.timer = setT(closeBatch, BATCH_MS);
          }
          // Last write per field wins. Only the patch's fields join this batch; fields queued earlier keep their
          // own batch tag (an earlier batch may be saving them right now).
          var e = has(queue, jn) ? queue[jn] : { fields: {}, fb: {}, label: '' };
          QFIELDS.forEach(function (f) {
            if (!has(fields, f)) return;
            e.fields[f] = f === 'lane' ? copyLane(fields.lane) : fields[f];
            e.fb[f] = openBatch.id;
          });
          e.at = at; e.by = by; e.label = label || e.label;
          queue[jn] = e;
          saveQueue(); // write-ahead: survives the app being closed inside the 3 s window
          var prev = shown ? (has(shown, jn) ? shown[jn] : null) : undefined;
          shownPut(jn, viewEntry(jn));
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
        if (LOCKED) return Promise.resolve({ ok: false, reason: MSG.config });
        if (!t) return Promise.resolve({ ok: false, reason: 'Paste the edit key first.' });
        if (!/^[\x21-\x7e]{10,255}$/.test(t)) return Promise.resolve({ ok: false, reason: 'That doesn\u2019t look like a GitHub key.' });
        // Beta: stages-beta.json may not exist yet (the first save creates it). Then the key is checked on the overlay
        // (v1's stages.json) instead: readable there = accepted.
        function checkMissing(res) {
          if (!res.missing || !OVL_FILE) return res;
          return apiGetText(OVL_API, t).then(function (o) { if (!o.missing) res.missing = false; return res; });
        }
        function finish() {
          emitStatus();
          emitChange(true);
          schedulePoll();
          maybeReplay();
          return { ok: true };
        }
        return enqueue(function () {
          return getRemoteGithub(t).then(checkMissing).then(function (res) {
            if (res.missing) return { ok: false, reason: 'This key can\u2019t see ' + STATE_FILE + ' in eckstein-jobs-state (404). Check the key\u2019s repository access.' };
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
            return OVL_FILE ? fetchOverlay().then(finish) : finish();
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
      setDeviceLabel: setDeviceLabel,

      /** The resolved config this store runs with (copy): channel, base, ns, stateFile, overlayFile, cachePrefix
       *  (+ locked: the reason, when the config was rejected and the store is read-only). */
      get config() { return Object.assign({}, cfg); }
    };
    return store;
  }

  return {
    STAGES: STAGES,
    ITEMS: ITEMS,
    LISTS: LISTS,
    ASSESS_CUTOFF: ASSESS_CUTOFF,
    priorAssessed: priorAssessed,
    FILE_VERSION: FILE_VERSION,
    stageIndex: stageIndex,
    normalize: normalize,
    effective: effective,
    canMove: canMove,
    canSetItem: canSetItem,
    fieldWorkDone: fieldWorkDone,
    keepWhenClosed: keepWhenClosed,
    itemShown: itemShown,
    createStore: createStore,
    resolveConfig: resolveConfig,
    CONFIG_DEFAULTS: CONFIG_DEFAULTS,
    NS_RE: NS_RE,
    mergeEntry: mergeEntry,
    API_URL: API_URL,
    RAW_URL: RAW_URL,
    _util: {
      b64encodeUtf8: b64encodeUtf8, b64decodeUtf8: b64decodeUtf8, parseDocText: parseDocText,
      serializeDoc: serializeDoc, commitMessage: commitMessage, cleanJobKey: cleanJobKey,
      cleanEntry: cleanEntry, cleanPatch: cleanPatch, cleanDate: cleanDate, applyFields: applyFields,
      describeChange: describeChange, parseOverlayText: parseOverlayText, mergeOverlay: mergeOverlay,
      overlayWins: overlayWins, isoMs: isoMs
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Stages;
