'use strict';
/* Node tests for js/prices.js (no npm deps). Run: node tests/prices.test.js   (exit code 1 on any failure)
 * tests/fixtures/prices.enc.json was encrypted by sync_jobs.py (Python cryptography AESGCM) with the
 * TEST ONLY key below (bytes 0..31, see tests/fixtures/make_prices_fixture.py); decrypting it here proves
 * the Python and WebCrypto formats agree. The amounts in the fixtures are made up. */
const fs = require('fs');
const path = require('path');
const Prices = require(path.join(__dirname, '..', 'js', 'prices.js'));

const FIX = path.join(__dirname, 'fixtures');
const ENC = JSON.parse(fs.readFileSync(path.join(FIX, 'prices.enc.json'), 'utf8'));
const PLAIN = JSON.parse(fs.readFileSync(path.join(FIX, 'prices.plain.json'), 'utf8'));
const TEST_ONLY_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';   // TEST ONLY: bytes(range(32))
const WRONG_KEY = Buffer.alloc(32, 7).toString('base64');                // TEST ONLY

/* every console line, to prove the key is never logged */
const CONSOLE_OUT = [];
['log', 'info', 'warn', 'error', 'debug'].forEach((m) => {
  const orig = console[m].bind(console);
  console[m] = (...a) => { CONSOLE_OUT.push(a.map(String).join(' ')); orig(...a); };
});

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error((msg || 'not equal') + ': ' + x + ' !== ' + y);
}
async function rejects(p, code) {
  try { await p; } catch (e) { if (code) eq(e.code, code, 'error code'); return e; }
  throw new Error('expected a rejection');
}

function makeStorage(init, opts) {
  const m = new Map(Object.entries(init || {}));
  const o = opts || {};
  return {
    getItem(k) { if (o.throwAll) throw new Error('SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (o.throwAll || o.throwSet) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem(k) { if (o.throwAll) throw new Error('SecurityError'); m.delete(k); },
    _map: m
  };
}
/** fake same-origin fetch serving `body` (object -> JSON, string as-is, null -> 404, 'throw' -> offline). */
function makeFetch(body) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (body === 'throw') throw new TypeError('Failed to fetch');
    if (body === null) return { ok: false, status: 404, text: async () => 'Not found' };
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: true, status: 200, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

/* ---------- decrypt ---------- */
test('decrypts the Python-encrypted fixture with the TEST key', async () => {
  const m = await Prices.decrypt(ENC, TEST_ONLY_KEY);
  eq(m, PLAIN);
});
test('key with whitespace / line breaks and url-safe alphabet still works', async () => {
  const spaced = '  ' + TEST_ONLY_KEY.slice(0, 20) + '\n ' + TEST_ONLY_KEY.slice(20) + '\t';
  eq(await Prices.decrypt(ENC, spaced), PLAIN);
  const urlSafe = TEST_ONLY_KEY.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  eq(await Prices.decrypt(ENC, urlSafe), PLAIN);
});
test('wrong key rejects with code decrypt', async () => {
  const e = await rejects(Prices.decrypt(ENC, WRONG_KEY), 'decrypt');
  assert(e.message.indexOf(WRONG_KEY) < 0, 'message must not contain the key');
});
test('tampered ciphertext rejects with code decrypt', async () => {
  const ct = Buffer.from(ENC.ct, 'base64'); ct[3] ^= 1;
  await rejects(Prices.decrypt(Object.assign({}, ENC, { ct: ct.toString('base64') }), TEST_ONLY_KEY), 'decrypt');
});
test('malformed keys reject with code badkey', async () => {
  for (const k of ['', 'abc', Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64'), 'not base64 !!', null, 42]) {
    await rejects(Prices.decrypt(ENC, k), 'badkey');
  }
});
test('bad files reject with code badfile', async () => {
  const bad = [null, 'x', {}, Object.assign({}, ENC, { v: 2 }), Object.assign({}, ENC, { alg: 'A128GCM' }),
    Object.assign({}, ENC, { iv: 'AAAA' }), Object.assign({}, ENC, { ct: 'AAAA' }), Object.assign({}, ENC, { iv: 42 })];
  for (const f of bad) await rejects(Prices.decrypt(f, TEST_ONLY_KEY), 'badfile');
});
test('WebCrypto round trip: encrypt in JS, decrypt with Prices.decrypt; bad entries are dropped', async () => {
  const raw = Buffer.from(TEST_ONLY_KEY, 'base64');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = { '5': { t: 1, u: 2 }, 'bad key!': { t: 3 }, '6': { t: 'x', u: null }, '7': 'str', '8': { t: Infinity, u: 4 } };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(pt))));
  const file = { v: 1, alg: 'A256GCM', iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64'), at: 'x' };
  eq(await Prices.decrypt(file, TEST_ONLY_KEY), { '5': { t: 1, u: 2 }, '8': { u: 4 } });
});

/* ---------- store ---------- */
test('no key: hasKey false, load -> null without fetching, getShow false', async () => {
  const f = makeFetch(ENC), s = makeStorage();
  const st = Prices.createPriceStore({ fetch: f, storage: s, now: () => 1000 });
  assert(!st.hasKey());
  eq(await st.load(), null);
  eq(f.calls.length, 0);
  assert(st.getShow() === false);
});
test('setKey: validates by decrypting data/prices.json?t=, stores only on success', async () => {
  const f = makeFetch(ENC), s = makeStorage();
  const st = Prices.createPriceStore({ fetch: f, storage: s, now: () => 1234 });
  const r = await st.setKey('  ' + TEST_ONLY_KEY + '\n');
  eq(r, { ok: true, count: 3 });
  eq(s._map.get('ej_price_key'), TEST_ONLY_KEY, 'stored trimmed');
  assert(st.hasKey());
  eq(f.calls[0].url, 'data/prices.json?t=1234');
  eq(f.calls[0].opts.credentials, 'same-origin');
  eq(st.info(), { at: '2026-09-26T17:05:01Z', count: 3 });
  // count = jobs with a price the app can show (a finite total > 0): fixture job 9001 has only "u", so 3 of the 4 entries
});
test('setKey: wrong key is not stored', async () => {
  const s = makeStorage();
  const st = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: s });
  const r = await st.setKey(WRONG_KEY);
  eq(r.ok, false); eq(r.code, 'decrypt');
  assert(!s._map.has('ej_price_key')); assert(!st.hasKey());
  assert(JSON.stringify(r).indexOf(WRONG_KEY) < 0, 'result must not echo the key');
});
test('setKey: malformed key is rejected without fetching', async () => {
  const f = makeFetch(ENC), s = makeStorage();
  const st = Prices.createPriceStore({ fetch: f, storage: s });
  const r = await st.setKey('hello');
  eq(r.code, 'badkey'); eq(f.calls.length, 0); assert(!st.hasKey());
});
test('setKey: offline / other HTTP error / broken JSON -> not stored', async () => {
  const http500 = async () => ({ ok: false, status: 500, text: async () => 'oops' });
  for (const [fetchFn, code] of [[makeFetch('throw'), 'nofile'], [http500, 'nofile'], [makeFetch('{oops'), 'badfile']]) {
    const s = makeStorage();
    const st = Prices.createPriceStore({ fetch: fetchFn, storage: s });
    const r = await st.setKey(TEST_ONLY_KEY);
    eq(r.ok, false); eq(r.code, code); assert(!s._map.has('ej_price_key'));
  }
});
test('setKey: no prices file yet (404) -> key kept as pending, validated by the next load', async () => {
  const s = makeStorage();
  let body = null;                                   // 404 until the first sync writes the file
  const f = async () => (body === null ? { ok: false, status: 404, text: async () => 'Not found' }
    : { ok: true, status: 200, text: async () => JSON.stringify(body) });
  const st = Prices.createPriceStore({ fetch: f, storage: s });
  const r = await st.setKey(' ' + TEST_ONLY_KEY + ' ');
  eq(r, { ok: true, pending: true, count: 0, code: 'nofileyet', reason: 'No prices yet — they appear after the next sync' });
  eq(s._map.get('ej_price_key'), TEST_ONLY_KEY); assert(st.hasKey());
  assert(JSON.stringify(r).indexOf(TEST_ONLY_KEY) < 0, 'result must not echo the key');
  eq(await st.load(), null); assert(/No prices yet/.test(st.lastError()), 'load on 404 says "not yet", not "connection"');
  body = ENC;                                        // the sync ran
  eq(await st.load(), PLAIN); eq(st.lastError(), null);
  eq((await st.setKey('hello')).code, 'badkey', 'a malformed key is still refused');
  // a pending key that does not fit says so on the first load after the file appears
  const s2 = makeStorage();
  eq((await Prices.createPriceStore({ fetch: makeFetch(null), storage: s2 }).setKey(WRONG_KEY)).pending, true);
  const st3 = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: s2 });
  eq(await st3.load(), null); assert(/wrong key/.test(st3.lastError()));
});
test('load with a stored key returns the map; removeKey clears it', async () => {
  const s = makeStorage({ ej_price_key: TEST_ONLY_KEY });
  const st = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: s });
  assert(st.hasKey());
  eq(await st.load(), PLAIN);
  eq(st.lastError(), null);
  st.removeKey();
  assert(!st.hasKey()); assert(!s._map.has('ej_price_key'));
  eq(await st.load(), null);
  eq(st.info(), null);
});
test('load never rejects: wrong stored key, offline, 404 -> null + lastError', async () => {
  let st = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: makeStorage({ ej_price_key: WRONG_KEY }) });
  eq(await st.load(), null); assert(/wrong key/.test(st.lastError()));
  st = Prices.createPriceStore({ fetch: makeFetch('throw'), storage: makeStorage({ ej_price_key: TEST_ONLY_KEY }) });
  eq(await st.load(), null); assert(st.lastError());
  st = Prices.createPriceStore({ fetch: makeFetch(null), storage: makeStorage({ ej_price_key: TEST_ONLY_KEY }) });
  eq(await st.load(), null); assert(st.lastError());
  st = Prices.createPriceStore({ fetch: async () => { throw new Error('boom'); }, storage: makeStorage({ ej_price_key: TEST_ONLY_KEY }) });
  eq(await st.load(), null);
});
test('a stored value that is not a valid key counts as no key', async () => {
  const st = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: makeStorage({ ej_price_key: 'garbage' }) });
  assert(!st.hasKey()); eq(await st.load(), null);
});
test('show/hide preference: default true once a key exists, remembered in ej_show_prices', async () => {
  const s = makeStorage();
  const st = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: s });
  assert(st.getShow() === false, 'no key -> hidden');
  await st.setKey(TEST_ONLY_KEY);
  assert(st.getShow() === true, 'default shown');
  st.setShow(false); eq(s._map.get('ej_show_prices'), '0'); assert(st.getShow() === false);
  st.setShow(true); eq(s._map.get('ej_show_prices'), '1'); assert(st.getShow() === true);
});
test('blocked storage: nothing throws; a validated key works for this session only', async () => {
  const s = makeStorage({}, { throwAll: true });
  const st = Prices.createPriceStore({ fetch: makeFetch(ENC), storage: s });
  assert(!st.hasKey());
  eq((await st.setKey(TEST_ONLY_KEY)).ok, true);
  assert(st.hasKey());
  eq(await st.load(), PLAIN);
  st.setShow(false); st.removeKey();
  assert(!st.hasKey());
});
test('the key never appears in a request URL or options', async () => {
  const f = makeFetch(ENC);
  const st = Prices.createPriceStore({ fetch: f, storage: makeStorage() });
  await st.setKey(TEST_ONLY_KEY); await st.load(); await st.setKey(WRONG_KEY);
  assert(f.calls.length >= 3);
  for (const c of f.calls) assert(JSON.stringify(c).indexOf(TEST_ONLY_KEY) < 0 && JSON.stringify(c).indexOf(WRONG_KEY) < 0);
});

/* ---------- EJ_CONFIG (beta channel, docs/r2-plan.md section 9) ---------- */
test('env.config beta: keys under ejb_, file at ../data/prices.json, ej_ keys untouched', async () => {
  const f = makeFetch(ENC), s = makeStorage({ ej_price_key: WRONG_KEY, ej_show_prices: '0' });
  const st = Prices.createPriceStore({ fetch: f, storage: s, now: () => 77, config: { channel: 'beta', ns: 'ejb_', base: '../' } });
  assert(!st.hasKey(), 'the main app key is not the beta key');
  eq((await st.setKey(TEST_ONLY_KEY)).ok, true);
  eq(f.calls[0].url, '../data/prices.json?t=77');
  eq(s._map.get('ejb_price_key'), TEST_ONLY_KEY);
  eq(s._map.get('ej_price_key'), WRONG_KEY, 'main key unchanged');
  assert(st.getShow() === true, 'beta show default is its own');
  st.setShow(false); eq(s._map.get('ejb_show_prices'), '0'); eq(s._map.get('ej_show_prices'), '0');
  st.setShow(true); eq(s._map.get('ejb_show_prices'), '1'); eq(s._map.get('ej_show_prices'), '0', 'main pref unchanged');
  st.removeKey(); assert(!s._map.has('ejb_price_key')); eq(s._map.get('ej_price_key'), WRONG_KEY);
});
test('config defaults: missing / junk config = ej_ keys and data/prices.json; a bad ns = "ejx_" (never v1 ej_)', async () => {
  const cases = [[undefined, 'ej_'], [null, 'ej_'], [{}, 'ej_'], ['x', 'ej_'], [{ base: 7 }, 'ej_'], [{ base: 'https://evil/' }, 'ej_'],
    [{ ns: 42, base: 7 }, 'ejx_'], [{ ns: 'bad key!' }, 'ejx_'], [{ ns: 'ejb-' }, 'ejx_'], [{ ns: 'ej_b.long.prefix.x' }, 'ejx_']];
  for (const [config, ns] of cases) {
    const f = makeFetch(ENC), s = makeStorage();
    const env = { fetch: f, storage: s, now: () => 5 };
    if (config !== undefined) env.config = config;
    const st = Prices.createPriceStore(env);
    eq((await st.setKey(TEST_ONLY_KEY)).ok, true);
    eq(f.calls[0].url, 'data/prices.json?t=5');
    assert(s._map.get(ns + 'price_key') === TEST_ONLY_KEY, JSON.stringify(config) + ': key saved under ' + ns);
    assert(ns === 'ej_' || !s._map.has('ej_price_key'), JSON.stringify(config) + ': nothing under ej_');
  }
});
test('global EJ_CONFIG is read when env.config is absent; env.url still wins', async () => {
  globalThis.EJ_CONFIG = { channel: 'beta', ns: 'ejb_', base: '../' };
  try {
    let f = makeFetch(ENC), s = makeStorage();
    let st = Prices.createPriceStore({ fetch: f, storage: s, now: () => 9 });
    await st.setKey(TEST_ONLY_KEY);
    eq(f.calls[0].url, '../data/prices.json?t=9'); assert(s._map.has('ejb_price_key') && !s._map.has('ej_price_key'));
    f = makeFetch(ENC); s = makeStorage();
    st = Prices.createPriceStore({ fetch: f, storage: s, now: () => 9, url: 'x/p.json' });
    await st.setKey(TEST_ONLY_KEY);
    eq(f.calls[0].url, 'x/p.json?t=9');
  } finally { delete globalThis.EJ_CONFIG; }
});

test('promotion: after Stages.migrateFromBeta the main app (no config) decrypts with the beta pricing key and keeps the $ choice', async () => {
  const Stages = require(path.join(__dirname, '..', 'js', 'stages.js'));
  const s = makeStorage({ ejb_price_key: TEST_ONLY_KEY, ejb_show_prices: '0' });
  const r = Stages.migrateFromBeta(s, undefined, 5);
  eq(r.copied, ['price_key', 'show_prices']);
  eq(r.removed, ['price_key'], 'the beta copy of the secret is removed once the main key holds it');
  assert(JSON.stringify(r).indexOf(TEST_ONLY_KEY) < 0, 'the migration result never carries the key');
  const f = makeFetch(ENC);
  const st = Prices.createPriceStore({ fetch: f, storage: s, now: () => 5 });
  eq(st.hasKey(), true);
  eq(st.getShow(), false, 'the beta\'s "$ hidden" choice carries over');
  eq(await st.load(), PLAIN);
  eq(f.calls[0].url, 'data/prices.json?t=5', 'the main app reads data/ at the root');
  eq(s._map.has('ejb_price_key'), false, 'the beta copy of the pricing key is gone');
  eq(s._map.get('ejb_show_prices'), '0', 'non-secret beta keys stay');
  // a device that already had its own main-app key keeps it
  const own = makeStorage({ ej_price_key: WRONG_KEY, ejb_price_key: TEST_ONLY_KEY });
  eq(Stages.migrateFromBeta(own, undefined, 5).copied, []);
  eq(own._map.get('ej_price_key'), WRONG_KEY);
  eq(own._map.has('ejb_price_key'), false, 'the stale beta copy goes too: the main key is the one in use');
});

/* ---------- formatting ---------- */
test('fmt: CAD whole dollars with thousands separators', () => {
  eq(Prices.fmt(12345), '$12,345');
  eq(Prices.fmt(12345.6), '$12,346');
  eq(Prices.fmt(0), '$0');
  eq(Prices.fmt(999.49), '$999');
  eq(Prices.fmt(1234567.8), '$1,234,568');
  eq(Prices.fmt(-1200), '-$1,200');
  eq(Prices.fmt(-0.2), '$0');
  eq(Prices.fmt(null), ''); eq(Prices.fmt(NaN), ''); eq(Prices.fmt('12'), ''); eq(Prices.fmt(Infinity), '');
});
test('fmtShort: $950, $12.3k, $12k, $123k, $1.3M', () => {
  eq(Prices.fmtShort(12345), '$12.3k');
  eq(Prices.fmtShort(950), '$950');
  eq(Prices.fmtShort(999.4), '$999');
  eq(Prices.fmtShort(999.6), '$1k');
  eq(Prices.fmtShort(1000), '$1k');
  eq(Prices.fmtShort(1049), '$1k');
  eq(Prices.fmtShort(1050), '$1.1k');
  eq(Prices.fmtShort(12000), '$12k');
  eq(Prices.fmtShort(99949), '$99.9k');
  eq(Prices.fmtShort(99950), '$100k');
  eq(Prices.fmtShort(123456), '$123k');
  eq(Prices.fmtShort(999499), '$999k');
  eq(Prices.fmtShort(999500), '$1M');
  eq(Prices.fmtShort(1250000), '$1.3M');
  eq(Prices.fmtShort(-12345), '-$12.3k');
  eq(Prices.fmtShort(0), '$0');
  eq(Prices.fmtShort(undefined), '');
});

test('browser global: loads as a plain script and defines Prices', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'prices.js'), 'utf8');
  const ctx = { atob, TextDecoder, crypto: globalThis.crypto, Promise };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert(ctx.Prices && typeof ctx.Prices.decrypt === 'function' && ctx.Prices.fmt(5) === '$5');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('PASS  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '  -> ' + (e && e.message ? e.message : e)); }
  }
  const leaked = CONSOLE_OUT.some((l) => l.indexOf(TEST_ONLY_KEY) >= 0 || l.indexOf(WRONG_KEY) >= 0);
  if (leaked) { failed++; console.log('FAIL  a key appeared in console output'); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
