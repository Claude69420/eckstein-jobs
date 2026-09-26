/* Eckstein Jobs - encrypted job prices (R-2, docs/r2-plan.md section 5).
 *
 * data/prices.json (written by sync_jobs.py when the PRICE_KEY secret is set):
 *   {"v":1, "alg":"A256GCM", "iv":"<base64, 12 bytes>", "ct":"<base64 ciphertext||16-byte tag>", "at":"<ISO UTC>"}
 * Plaintext: UTF-8 JSON {"<jobNumber>": {"t": total, "u": uninvoicedTotal}} (either field may be missing).
 * The file keeps its old contents when a sync runs without PRICE_KEY, so `at` says how old the prices are.
 *
 * The pricing key (base64 of 32 bytes) is pasted per device and kept in localStorage[ns + 'price_key'] (ns = the
 * window.EJ_CONFIG localStorage prefix: "ej_" by default, "ejb_" in the beta at /beta/, docs/r2-plan.md section 9).
 * It only ever decrypts locally: it is never logged, never put in a URL and never sent anywhere.
 *
 * Browser global `Prices` and CommonJS module (Node 24 tests). Plain ES2017, no dependencies;
 * WebCrypto via globalThis.crypto.subtle (browsers on https/localhost, Node >= 19).
 *
 * API:
 *   Prices.decrypt(fileObj, keyB64) -> Promise<{"<jobNumber>": {t?, u?}}>; rejects Error{code}:
 *       'badkey' (not base64 of 32 bytes), 'badfile' (not a v1 A256GCM file), 'decrypt' (wrong key or
 *       tampered file), 'nocrypto' (no WebCrypto, e.g. plain-http page).
 *   Prices.createPriceStore(env?) -> store:
 *       hasKey(), setKey(keyB64) -> Promise<{ok:true, count} | {ok:true, pending:true, count:0, code:'nofileyet',
 *         reason} | {ok:false, reason, code}>, removeKey(),
 *         setKey validates the key by decrypting the current file. When the site has no prices file yet (HTTP 404:
 *         normal until the first sync after PRICE_KEY is added), a well-formed key is saved unvalidated
 *         ({pending:true}; show `reason`) and the next load() checks it ('wrong key?' then, if it does not fit).
 *       load() -> Promise<map|null> (never rejects; null = no key / no file / wrong key / offline),
 *       lastError() -> string|null, info() -> {at, count}|null (from the last good load),
 *       getShow() -> bool (default true once a key exists; always false without a key), setShow(bool).
 *     env (tests): {fetch, storage, now, url, config}. config defaults to window.EJ_CONFIG ({ns, base}; missing =
 *       {ns:"ej_", base:""}). Storage keys = ns + "price_key" / ns + "show_prices"; url defaults to
 *       base + 'data/prices.json' (same origin; "../data/prices.json" in the beta).
 *   Prices.fmt(n) -> "$12,345" (CAD, whole dollars); Prices.fmtShort(n) -> "$12.3k".
 */
var Prices = (function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}));

  var LS_KEY = 'ej_price_key';     // default key names (ns "ej_"); a store uses ns + 'price_key' / ns + 'show_prices'
  var LS_SHOW = 'ej_show_prices';  // price_key is SECRET (APP_MASTER rule 1): never read it in the Browser pane; show = "1" | "0"
  var URL_DEFAULT = 'data/prices.json';
  var JOB_KEY_RE = /^[0-9A-Za-z-]{1,32}$/;
  var NOFILE = {};                 // fetchFile() sentinel: HTTP 404 (no prices.json published yet)

  var MSG = {
    badkey: 'That is not a pricing key (it should be 44 characters of base64)',
    decrypt: 'That key does not unlock the prices (wrong key?)',
    badfile: 'The prices file is damaged or from a newer version',
    nofile: 'Could not load the prices file — check the connection and try again',
    nofileyet: 'No prices yet — they appear after the next sync',
    nocrypto: 'This browser cannot decrypt prices here (needs https)'
  };

  function err(code) { var e = new Error(MSG[code] || code); e.code = code; return e; }

  /* ---------- base64 ---------- */
  function b64ToBytes(s) {
    if (typeof s !== 'string') return null;
    var t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (!t || /[^A-Za-z0-9+/=]/.test(t)) return null;
    while (t.length % 4) t += '=';
    var bin;
    try { bin = G.atob(t); } catch (e) { return null; }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /** Pasted key -> 32 raw bytes, or null. Whitespace anywhere is ignored; url-safe base64 is accepted. */
  function keyBytes(keyB64) {
    var b = b64ToBytes(keyB64);
    return b && b.length === 32 ? b : null;
  }
  function cleanKey(keyB64) { return typeof keyB64 === 'string' ? keyB64.replace(/\s+/g, '') : ''; }

  function subtle() {
    var c = G.crypto;
    return c && c.subtle ? c.subtle : null;
  }

  function finite(v) { return typeof v === 'number' && isFinite(v); }

  /** Plaintext object -> clean map; only job keys and finite numbers survive. */
  function cleanMap(obj) {
    var out = {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    Object.keys(obj).forEach(function (k) {
      if (!JOB_KEY_RE.test(k) || k === '__proto__') return;
      var v = obj[k], e = {};
      if (!v || typeof v !== 'object') return;
      if (finite(v.t)) e.t = v.t;
      if (finite(v.u)) e.u = v.u;
      if (e.t !== undefined || e.u !== undefined) out[k] = e;
    });
    return out;
  }

  /** Decrypt a parsed prices.json object with a base64 key. */
  function decrypt(fileObj, keyB64) {
    return Promise.resolve().then(function () {
      var raw = keyBytes(keyB64);
      if (!raw) throw err('badkey');
      if (!fileObj || typeof fileObj !== 'object' || fileObj.v !== 1 || fileObj.alg !== 'A256GCM') throw err('badfile');
      var iv = b64ToBytes(fileObj.iv), ct = b64ToBytes(fileObj.ct);
      if (!iv || iv.length !== 12 || !ct || ct.length < 16) throw err('badfile');
      var s = subtle();
      if (!s) throw err('nocrypto');
      return s.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt'])
        .then(function (k) { return s.decrypt({ name: 'AES-GCM', iv: iv, tagLength: 128 }, k, ct); })
        .then(null, function () { throw err('decrypt'); })
        .then(function (buf) {
          var obj;
          try { obj = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf))); } catch (e) { throw err('badfile'); }
          var m = cleanMap(obj);
          if (!m) throw err('badfile');
          return m;
        });
    });
  }

  /* ---------- store ---------- */
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  // Same ns rule as js/stages.js (Stages.NS_RE), js/app.js and the index.html boot script (tests/stages.test.js
  // checks they match). A given but invalid ns -> the quarantine prefix "ejx_", never v1's "ej_".
  var NS_RE = /^[A-Za-z0-9_]{1,16}$/;
  /** EJ_CONFIG (docs/r2-plan.md section 9) -> {ns, base}. Defaults = the main app ("ej_", ""). */
  function readConfig(env) {
    var c = null;
    try { c = has(env, 'config') ? env.config : G.EJ_CONFIG; } catch (e) { c = null; }
    if (!c || typeof c !== 'object') c = {};
    return {
      ns: !has(c, 'ns') ? 'ej_' : typeof c.ns === 'string' && NS_RE.test(c.ns) ? c.ns : 'ejx_',
      base: typeof c.base === 'string' && /^(\.\.?\/)*$/.test(c.base) && c.base.length <= 32 ? c.base : ''
    };
  }

  function createPriceStore(env) {
    env = env || {};
    var cfg = readConfig(env);
    var K_KEY = cfg.ns + 'price_key', K_SHOW = cfg.ns + 'show_prices';
    var fetchFn = has(env, 'fetch') ? env.fetch
      : (typeof G.fetch === 'function' ? function (u, o) { return G.fetch(u, o); } : null);
    var storage = has(env, 'storage') ? env.storage
      : (function () { try { return G.localStorage || null; } catch (e) { return null; } })();
    var now = typeof env.now === 'function' ? env.now : function () { return Date.now(); };
    var url = typeof env.url === 'string' ? env.url : cfg.base + URL_DEFAULT;

    var memKey = null;       // used when storage is blocked, so the key still works for this session
    var lastErr = null;
    var lastInfo = null;

    function sGet(k) { try { return storage ? storage.getItem(k) : null; } catch (e) { return null; } }
    function sSet(k, v) { try { if (!storage) return false; storage.setItem(k, v); return true; } catch (e) { return false; } }
    function sDel(k) { try { if (storage) storage.removeItem(k); } catch (e) { /* ignore */ } }

    function currentKey() {
      var k = sGet(K_KEY);
      if (k && keyBytes(k)) return k;
      return memKey && keyBytes(memKey) ? memKey : null;
    }
    function hasKey() { return !!currentKey(); }

    /** Fetch data/prices.json (same origin, cache-busted). Resolves the parsed object, NOFILE (HTTP 404: the
     *  sync has not written one yet), false (not JSON) or null (offline / any other failure). */
    function fetchFile() {
      if (!fetchFn) return Promise.resolve(null);
      var u = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + now();
      return Promise.resolve()
        .then(function () { return fetchFn(u, { cache: 'no-store', credentials: 'same-origin' }); })
        .then(function (r) {
          if (r && r.status === 404) return NOFILE;
          if (!r || !r.ok) return null;
          return r.text().then(function (t) {
            try { return JSON.parse(String(t).replace(/^﻿/, '')); } catch (e) { return false; }
          });
        })
        .then(null, function () { return null; });
    }

    /** How many jobs the app can show a price for (the app shows only a finite total > 0, like priceOf in app.js). */
    function pricedCount(map) {
      return Object.keys(map).filter(function (jn) { var p = map[jn]; return !!p && typeof p.t === 'number' && isFinite(p.t) && p.t > 0; }).length;
    }
    function remember(fileObj, map) {
      lastInfo = { at: typeof fileObj.at === 'string' ? fileObj.at.slice(0, 40) : null, count: pricedCount(map) };
    }

    /** Validates the key by decrypting the current prices file; stores it only on success. */
    function setKey(keyB64) {
      var k = cleanKey(keyB64);
      if (!keyBytes(k)) return Promise.resolve({ ok: false, code: 'badkey', reason: MSG.badkey });
      return fetchFile().then(function (fileObj) {
        if (fileObj === NOFILE) {   // nothing to check against yet: keep the key, load() validates it later
          if (!sSet(K_KEY, k)) memKey = k; else memKey = null;
          lastErr = MSG.nofileyet;
          lastInfo = null;
          return { ok: true, pending: true, count: 0, code: 'nofileyet', reason: MSG.nofileyet };
        }
        if (fileObj === null) return { ok: false, code: 'nofile', reason: MSG.nofile };
        if (fileObj === false) return { ok: false, code: 'badfile', reason: MSG.badfile };
        return decrypt(fileObj, k).then(function (map) {
          if (!sSet(K_KEY, k)) memKey = k; else memKey = null;
          lastErr = null;
          remember(fileObj, map);
          return { ok: true, count: pricedCount(map) };
        }, function (e) {
          var code = (e && e.code) || 'decrypt';
          return { ok: false, code: code, reason: MSG[code] || MSG.decrypt };
        });
      });
    }

    function removeKey() {
      sDel(K_KEY);
      memKey = null;
      lastErr = null;
      lastInfo = null;
    }

    /** Map of prices, or null (no key, no file, offline, wrong key). Never rejects. */
    function load() {
      var k = currentKey();
      if (!k) { lastErr = null; return Promise.resolve(null); }
      return fetchFile().then(function (fileObj) {
        if (fileObj === NOFILE) { lastErr = MSG.nofileyet; return null; }
        if (fileObj === null) { lastErr = MSG.nofile; return null; }
        if (fileObj === false) { lastErr = MSG.badfile; return null; }
        return decrypt(fileObj, k).then(function (map) {
          lastErr = null;
          remember(fileObj, map);
          return map;
        }, function (e) {
          lastErr = MSG[(e && e.code) || 'decrypt'] || MSG.decrypt;
          return null;
        });
      }).then(null, function () { lastErr = MSG.nofile; return null; });
    }

    function getShow() {
      if (!hasKey()) return false;
      return sGet(K_SHOW) !== '0';
    }
    function setShow(v) { sSet(K_SHOW, v ? '1' : '0'); }

    return {
      hasKey: hasKey,
      setKey: setKey,
      removeKey: removeKey,
      load: load,
      getShow: getShow,
      setShow: setShow,
      lastError: function () { return lastErr; },
      info: function () { return lastInfo ? { at: lastInfo.at, count: lastInfo.count } : null; }
    };
  }

  /* ---------- formatting (CAD, whole dollars) ---------- */
  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /** 12345.6 -> "$12,346"; -1200 -> "-$1,200"; non-numbers -> "". */
  function fmt(n) {
    if (!finite(n)) return '';
    var r = Math.round(Math.abs(n));
    return (n < 0 && r !== 0 ? '-' : '') + '$' + group(String(r));
  }

  /** 950 -> "$950", 12345 -> "$12.3k", 12000 -> "$12k", 123456 -> "$123k", 1250000 -> "$1.3M". */
  function fmtShort(n) {
    if (!finite(n)) return '';
    var a = Math.abs(n), sign = n < 0 && Math.round(a) !== 0 ? '-' : '', s;
    function one(x) { var v = (Math.round(x * 10) / 10).toFixed(1); return v.slice(-2) === '.0' ? v.slice(0, -2) : v; }
    if (Math.round(a) < 1000) s = String(Math.round(a));
    else if (a < 99950) s = one(a / 1000) + 'k';
    else if (a < 999500) s = String(Math.round(a / 1000)) + 'k';
    else s = one(a / 1e6) + 'M';
    return sign + '$' + s;
  }

  return {
    decrypt: decrypt,
    createPriceStore: createPriceStore,
    fmt: fmt,
    fmtShort: fmtShort,
    LS_KEY: LS_KEY,
    LS_SHOW: LS_SHOW,
    _util: { keyBytes: keyBytes, b64ToBytes: b64ToBytes, cleanMap: cleanMap }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Prices;
