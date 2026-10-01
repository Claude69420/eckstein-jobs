'use strict';
/* Node tests for js/routes.js (synced saved routes, R-3; no npm deps). Run: node tests/routes.test.js
 * Mocked GitHub (contents API + raw CDN for routes.json), a fake localStorage, fake timers and fake
 * document/window event targets, like tests/stages.test.js. Exit code 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'js', 'routes.js');
const R = require(SRC);
const U = R._util;

const KEY = 'github_pat_TESTONLY_routes_0123456789abcdefABCDEF_notreal'; // fake test value
const KEY2 = 'github_pat_TESTONLY_routes_second_key_0123456789_notreal'; // fake test value
const API = 'https://api.github.com/repos/Claude69420/eckstein-jobs-state/contents/routes.json';
const RAW = 'https://raw.githubusercontent.com/Claude69420/eckstein-jobs-state/main/routes.json';
const LIVE_HOST = 'claude69420.github.io';
const T0 = Date.UTC(2026, 8, 30, 15, 0, 0);
const ISO0 = '2026-09-30T15:00:00Z';
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* ---------- recorders (key hygiene checks run over these at the end) ---------- */
const ALL_REQUESTS = [];
const CONSOLE_OUT = [];
const ALL_STORAGES = [];
['log', 'info', 'warn', 'error', 'debug'].forEach((m) => {
  const orig = console[m].bind(console);
  console[m] = (...a) => { CONSOLE_OUT.push(a.map(String).join(' ')); orig(...a); };
});

/* ---------- fakes ---------- */
function makeStorage(init, opts) {
  const m = new Map(Object.entries(init || {}));
  const o = opts || {};
  const s = {
    getItem(k) { if (o.throwAll) throw new Error('SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (o.throwAll || o.throwSet) throw new Error('QuotaExceededError'); m.set(k, String(v)); },
    removeItem(k) { if (o.throwAll) throw new Error('SecurityError'); m.delete(k); },
    _map: m
  };
  ALL_STORAGES.push(s);
  return s;
}
async function drain(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
function makeClock(start = T0) {
  let t = start, seq = 0, timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers = timers.filter((x) => x.id !== id); },
    pending: () => timers.length,
    async advance(ms) {
      const end = t + ms;
      await drain();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
        await drain();
      }
      t = end;
      await drain();
    }
  };
}
function makeTarget(props) {
  const ls = {};
  return Object.assign({
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    removeEventListener(t, f) { ls[t] = (ls[t] || []).filter((x) => x !== f); },
    dispatch(t) { (ls[t] || []).slice().forEach((f) => f({ type: t })); },
    count(t) { return (ls[t] || []).length; }
  }, props || {});
}
function b64lines(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') + '\n'; }
function stop(name, lat, lon, extra) { return Object.assign({ name, lat, lon }, extra || {}); }
const S1 = stop('130 Midland St', 49.9102, -97.1601, { jobNumber: 664 });
const S2 = stop('Portage & Lipton', 49.8812, -97.1834, { jobNumber: 700, match: 'Portage Ave & Lipton St, Winnipeg, MB' });
const S3 = stop('Selkirk site', 50.1436, -96.8839, { oot: true });
function route(id, name, at, extra) {
  return Object.assign({ id, name, owner: 'Riley', by: 'PC', at, rt: false, start: { mode: 'shop' }, seq: [S1, S2], skipped: [] }, extra || {});
}
function docText(routes, extra) { return JSON.stringify(Object.assign({ version: 1, routes: routes || {} }, extra || {}), null, 2) + '\n'; }

/* Mock GitHub: contents API for routes.json (auth, sha checks: 409 stale sha, 422 missing sha) + raw CDN. */
function makeServer(routes, opts) {
  const o = opts || {};
  const srv = {
    exists: o.exists !== false,
    text: o.text !== undefined ? o.text : docText(routes || {}),
    rawText: undefined,
    sha: 'sha-1', n: 1, offline: false,
    validKeys: new Set([KEY, KEY2]),
    requests: [], commits: [], hook: null
  };
  function resp(status, body, headers) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const lower = {};
    Object.keys(headers || {}).forEach((k) => { lower[k.toLowerCase()] = String(headers[k]); });
    return { status, ok: status >= 200 && status < 300, headers: { get: (n) => (lower[String(n).toLowerCase()] ?? null) },
      text: () => Promise.resolve(text) };
  }
  srv.resp = resp;
  srv.commitFile = (newText, message) => { srv.text = newText; srv.exists = true; srv.sha = 'sha-' + (++srv.n); srv.commits.push({ message, text: newText }); };
  srv.doc = () => JSON.parse(srv.text);
  srv.routes = () => srv.doc().routes;
  srv.fetch = function (url, init) {
    const opt = init || {};
    const headers = {};
    Object.keys(opt.headers || {}).forEach((k) => { headers[k.toLowerCase()] = opt.headers[k]; });
    const req = { url: String(url), method: String(opt.method || 'GET').toUpperCase(), headers, body: opt.body, cache: opt.cache };
    srv.requests.push(req); ALL_REQUESTS.push(req);
    if (srv.offline) return Promise.reject(new TypeError('Failed to fetch'));
    if (srv.hook) { const r = srv.hook(req); if (r) return Promise.resolve(r); }
    const u = new URL(req.url);
    if (u.origin === 'https://raw.githubusercontent.com' && u.pathname === '/Claude69420/eckstein-jobs-state/main/routes.json') {
      if (!srv.exists) return Promise.resolve(resp(404, '404: Not Found'));
      return Promise.resolve(resp(200, srv.rawText !== undefined ? srv.rawText : srv.text));
    }
    if (u.origin === 'https://api.github.com' && u.pathname === '/repos/Claude69420/eckstein-jobs-state/contents/routes.json' && !u.search) {
      const m = /^Bearer (.+)$/.exec(headers.authorization || '');
      if (!m || !srv.validKeys.has(m[1])) return Promise.resolve(resp(401, { message: 'Bad credentials', status: '401' }));
      if (req.method === 'GET') {
        if (!srv.exists) return Promise.resolve(resp(404, { message: 'Not Found', status: '404' }));
        return Promise.resolve(resp(200, { name: 'routes.json', path: 'routes.json', sha: srv.sha, type: 'file', encoding: 'base64', content: b64lines(srv.text) }));
      }
      if (req.method === 'PUT') {
        const b = JSON.parse(req.body);
        if (srv.exists && !b.sha) return Promise.resolve(resp(422, { message: '"sha" wasn\'t supplied.', status: '422' }));
        if (srv.exists && b.sha !== srv.sha) return Promise.resolve(resp(409, { message: 'routes.json does not match ' + b.sha, status: '409' }));
        const created = !srv.exists;
        srv.commitFile(Buffer.from(b.content, 'base64').toString('utf8'), b.message);
        return Promise.resolve(resp(created ? 201 : 200, { content: { name: 'routes.json', sha: srv.sha }, commit: { sha: 'c' + srv.n } }));
      }
    }
    return Promise.resolve(resp(404, { message: 'Not Found' }));
  };
  return srv;
}
let RND = 0;
const fakeCrypto = { getRandomValues(a) { for (let i = 0; i < a.length; i++) a[i] = (0x9e3779b9 * (++RND)) >>> 0; return a; } };
function setup(o) {
  o = o || {};
  const clock = o.clock || makeClock();
  const srv = o.srv || makeServer(o.routes || {}, o.srvOpts);
  const init = Object.assign({}, o.ls || {});
  if (o.key) init.ej_gh_token = o.key === true ? KEY : o.key;
  const storage = o.storage || makeStorage(init, o.storageOpts);
  const document = makeTarget({ visibilityState: 'visible' });
  const window = makeTarget();
  const navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140' };
  const env = { fetch: srv.fetch, storage, now: clock.now, hostname: o.hostname !== undefined ? o.hostname : LIVE_HOST,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, document, window, navigator, crypto: fakeCrypto };
  if (o.config !== undefined) env.config = o.config;
  const store = R.createStore(env);
  return { clock, srv, storage, document, window, store, env };
}
function track(p) {
  const s = { state: 'pending' };
  p.then((v) => { s.state = 'resolved'; s.value = v; }, (e) => { s.state = 'rejected'; s.error = e; });
  return s;
}
async function settle(clock, p, ms = 5000) { const t = track(p); await clock.advance(ms); if (t.state === 'rejected') throw t.error; assert.strictEqual(t.state, 'resolved'); return t.value; }
const puts = (srv) => srv.requests.filter((r) => r.method === 'PUT');
const lastPut = (srv) => JSON.parse(puts(srv).slice(-1)[0].body);
const putDoc = (srv) => JSON.parse(Buffer.from(lastPut(srv).content, 'base64').toString('utf8'));
const ID_A = 'rmfq0abc123', ID_B = 'rmfq0def456', ID_C = 'rmfq0ghi789';

/* ---------- runner ---------- */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ===================================== pure helpers ===================================== */

test('cleanText: one line, controls / bidi overrides removed, whitespace collapsed, clipped without splitting pairs', () => {
  assert.strictEqual(U.cleanText('  a\tb\n\nc\u202e d\u2066 ', 80), 'a b c d');
  assert.strictEqual(U.cleanText('x\u0000y\u007fz\u2028w', 80), 'x y z w');
  assert.strictEqual(U.cleanText(42, 80), '');
  assert.strictEqual(U.cleanText(null, 80), '');
  assert.strictEqual(U.cleanText('a'.repeat(200), 80).length, 80);
  assert.strictEqual(U.cleanText('abc def', 4), 'abc', 'no trailing space after the clip');
  assert.strictEqual(U.cleanText('ab\ud83d\ude00', 3), 'ab', 'a surrogate pair is never split');
  assert.strictEqual(U.cleanText('ab\ud83d\ude00', 4), 'ab\ud83d\ude00');
  assert.strictEqual(U.cleanText('a\ud800b\udc00c', 80), 'a\ufffdb\ufffdc', 'lone surrogates become U+FFFD');
  assert.strictEqual(U.cleanText('\ufeff\u00a0 x \u3000', 80), 'x');
});

test('cleanStop: Manitoba box, number types, jobNumber / match / shop / oot; unknown fields dropped', () => {
  assert.deepStrictEqual(R.cleanStop(S2), { name: 'Portage & Lipton', lat: 49.8812, lon: -97.1834, jobNumber: 700, match: 'Portage Ave & Lipton St, Winnipeg, MB' });
  assert.deepStrictEqual(R.cleanStop({ name: 'Shop', lat: 49.84, lon: -97.25, shop: true, oot: 'yes', skip: true, _id: 5, evil: '<img>' }),
    { name: 'Shop', lat: 49.84, lon: -97.25, shop: true });
  for (const bad of [null, [], 'x', { lat: '49.9', lon: -97.1 }, { lat: 49.9 }, { lat: NaN, lon: -97 }, { lat: 49.9, lon: Infinity },
    { lat: 51.0, lon: -97 }, { lat: 48.8, lon: -97 }, { lat: 49.9, lon: -100 }, { lat: 49.9, lon: -95.2 }, { lat: true, lon: -97 }]) {
    assert.strictEqual(R.cleanStop(bad), null, JSON.stringify(bad));
  }
  assert.ok(R.cleanStop({ lat: 48.9, lon: -99.8 }) && R.cleanStop({ lat: 50.9, lon: -95.3 }), 'box edges are inside');
  assert.deepStrictEqual(R.cleanStop({ lat: 49.9, lon: -97.1 }), { name: '', lat: 49.9, lon: -97.1 });
  const jn = (v) => R.cleanStop({ lat: 49.9, lon: -97.1, jobNumber: v }).jobNumber;
  assert.strictEqual(jn(664), 664);
  assert.strictEqual(jn('9001'), '9001');
  assert.strictEqual(jn('A-12'), 'A-12');
  [-1, 1.5, 1e12, NaN, ' 12', '12 ', 'a b', '', true, {}, 'x'.repeat(33)].forEach((v) => assert.strictEqual(jn(v), undefined, JSON.stringify(v)));
  assert.strictEqual(R.cleanStop({ lat: 49.9, lon: -97.1, name: 'n'.repeat(100), match: 'm'.repeat(200) }).name.length, 80);
  assert.strictEqual(R.cleanStop({ lat: 49.9, lon: -97.1, match: 'm'.repeat(200) }).match.length, 120);
});

test('cleanEntry / sanitizeRoute: id, at and a routed stop required; start modes; limits; tombstones', () => {
  const r = R.sanitizeRoute(route(ID_A, '  Setup\ncrew  ', ISO0, { rt: 'yes', extra: 1, start: { mode: 'gps', lat: 49.9, lon: -97.1, name: 'Me', x: 1 } }));
  assert.deepStrictEqual(r, { id: ID_A, name: 'Setup crew', owner: 'Riley', by: 'PC', at: ISO0, rt: false,
    start: { mode: 'gps', lat: 49.9, lon: -97.1, name: 'Me' }, seq: [R.cleanStop(S1), R.cleanStop(S2)], skipped: [] });
  assert.deepStrictEqual(Object.keys(r), ['id', 'name', 'owner', 'by', 'at', 'rt', 'start', 'seq', 'skipped'], 'key order');
  assert.strictEqual(R.sanitizeRoute(route(ID_A, '', ISO0)).name, 'Route');
  assert.deepStrictEqual(U.cleanStart({ mode: 'car' }), { mode: 'shop' });
  assert.deepStrictEqual(U.cleanStart('stop'), { mode: 'shop' });
  assert.deepStrictEqual(U.cleanStart({ mode: 'stop', lat: 60, lon: -97 }), { mode: 'stop' });
  assert.strictEqual(R.sanitizeRoute(route('bad id', 'x', ISO0)), null);
  assert.strictEqual(R.sanitizeRoute(route('R' + 'a'.repeat(8), 'x', ISO0)), null, 'upper-case R');
  assert.strictEqual(R.sanitizeRoute(route(ID_A, 'x', 'yesterday')), null, 'no valid at');
  assert.strictEqual(R.sanitizeRoute(route(ID_A, 'x', '2026-02-30T00:00:00Z')), null, 'not a calendar date');
  assert.strictEqual(R.sanitizeRoute(route(ID_A, 'x', ISO0, { seq: [{ lat: 0, lon: 0 }] })), null, 'no stop inside Manitoba');
  assert.strictEqual(R.sanitizeRoute(route(ID_A, 'x', ISO0, { seq: 'nope' })), null);
  const many = Array.from({ length: 150 }, (_, i) => stop('s' + i, 49.8 + i / 10000, -97.1));
  const big = R.sanitizeRoute(route(ID_A, 'n'.repeat(300), ISO0, { owner: 'o'.repeat(99), by: 'b'.repeat(99), seq: many, skipped: many }));
  assert.strictEqual(big.seq.length, 100); assert.strictEqual(big.skipped.length, 100);
  assert.strictEqual(big.name.length, 80); assert.strictEqual(big.owner.length, 40); assert.strictEqual(big.by.length, 40);
  assert.strictEqual(big.seq[99].name, 's99', 'the first 100 kept in order');
  assert.deepStrictEqual(U.cleanEntry(ID_A, { deleted: true, at: ISO0, by: 'PC\u202e', name: 'gone', seq: [S1] }), { deleted: true, at: ISO0, by: 'PC' });
  assert.strictEqual(U.cleanEntry(ID_A, { deleted: true }), null, 'tombstone needs a time');
  assert.strictEqual(U.cleanEntry(ID_A, { deleted: 'true', at: ISO0 }), null, 'deleted must be true (and then it needs stops)');
});

test('sanitizeDoc: hostile routes.json input (prototype keys, arrays, wrong types, caps, extras kept)', () => {
  const routes = JSON.parse('{"__proto__": ' + JSON.stringify(route('rproto123', 'p', ISO0)) + ', "constructor": 1}');
  routes[ID_A] = route(ID_A, 'A', ISO0);
  routes[ID_B] = [1, 2];
  routes[ID_C] = { deleted: true, at: ISO0, by: 'x' };
  routes.rmismatch1 = route(ID_B, 'key wins', ISO0);
  const d = U.sanitizeDoc({ version: 1, routes, note: 'kept', __proto__x: 1 });
  assert.deepStrictEqual(Object.keys(d.map), [ID_A, ID_C, 'rmismatch1']);
  assert.strictEqual(d.map.rmismatch1.id, 'rmismatch1', 'the map key is the id');
  assert.deepStrictEqual(d.extras, { note: 'kept', __proto__x: 1 });
  assert.strictEqual(({}).polluted, undefined);
  assert.deepStrictEqual(U.sanitizeDoc(null), { map: {}, extras: {}, version: 1 });
  assert.deepStrictEqual(U.sanitizeDoc({ routes: [] }).map, {});
  assert.strictEqual(U.sanitizeDoc({ version: 7, routes: {} }).version, 7);
  // caps: 300 newest routes, 1000 newest tombstones
  const lots = {};
  for (let i = 0; i < 320; i++) lots['rlive' + String(i).padStart(4, '0')] = route('x', 'r' + i, iso(T0 - i * 60000));
  for (let i = 0; i < 1010; i++) lots['rdead' + String(i).padStart(4, '0')] = { deleted: true, at: iso(T0 - i * 60000) };
  const c = U.sanitizeDoc({ routes: lots }).map;
  const live = Object.keys(c).filter((k) => !c[k].deleted), dead = Object.keys(c).filter((k) => c[k].deleted);
  assert.strictEqual(live.length, 300); assert.strictEqual(dead.length, 1000);
  assert.ok(live.includes('rlive0000') && !live.includes('rlive0300'), 'the newest are kept');
  assert.ok(!dead.includes('rdead1009'));
});

test('isDamaged, serializeDoc, parseDocText, pruneTombstones, commitMessage', () => {
  assert.strictEqual(U.isDamaged(''), false);
  assert.strictEqual(U.isDamaged('  \n'), false);
  assert.strictEqual(U.isDamaged('{"version":1,"routes":{}}'), false);
  assert.strictEqual(U.isDamaged('\ufeff{"routes":{}}'), false);
  ['{', '[]', '{"version":1}', '{"routes":[]}', '{"routes":null}', '"x"', 'null'].forEach((t) => assert.strictEqual(U.isDamaged(t), true, t));
  const map = { [ID_B]: U.cleanEntry(ID_B, route(ID_B, 'B', ISO0)), [ID_A]: U.cleanEntry(ID_A, route(ID_A, 'G\u00e9rard', ISO0)) };
  const text = U.serializeDoc(map, { note: 1, version: 9, routes: 'x' });
  assert.ok(text.endsWith('}\n'));
  const j = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(j), ['version', 'routes', 'note']);
  assert.strictEqual(j.version, 1);
  assert.deepStrictEqual(Object.keys(j.routes), [ID_A, ID_B], 'sorted by id');
  assert.strictEqual(U.parseDocText(text).map[ID_A].name, 'G\u00e9rard');
  assert.strictEqual(U.b64decodeUtf8(U.b64encodeUtf8(text)), text, 'UTF-8 base64 round trip');
  const pr = U.pruneTombstones({ a: { deleted: true, at: iso(T0 - 31 * DAY) }, b: { deleted: true, at: iso(T0 - 29 * DAY) }, c: map[ID_A] }, T0);
  assert.deepStrictEqual(Object.keys(pr), ['b', 'c']);
  assert.strictEqual(U.commitMessage([{ kind: 'save', name: 'Setup crew' }]), 'route: save "Setup crew"');
  assert.strictEqual(U.commitMessage([{ kind: 'delete', name: 'Old\nroute' }]), 'route: delete "Old route"');
  assert.strictEqual(U.commitMessage([{ kind: 'save', name: 'A' }, { kind: 'delete', name: 'B' }]), 'routes: save "A"; delete "B"');
  const long = U.commitMessage(Array.from({ length: 40 }, (_, i) => ({ kind: 'save', name: 'n'.repeat(60) + i })));
  assert.ok(long.length <= 520 && /; \+\d+ more$/.test(long));
});

test('newId: "r" + base36 time + random from crypto.getRandomValues; unique; valid; fromLegacy', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) { const id = R.newId(T0, fakeCrypto); assert.ok(R.ID_RE.test(id), id); ids.add(id); }
  assert.strictEqual(ids.size, 200);
  assert.ok(R.newId(T0, fakeCrypto).startsWith('r' + T0.toString(36)));
  assert.ok(R.ID_RE.test(R.newId()), 'default: global crypto');
  const noCrypto = R.newId(T0, { getRandomValues() { throw new Error('no'); } });
  assert.ok(R.ID_RE.test(noCrypto), 'works without crypto');
  const shop = { name: 'Shop (1279 Loudoun Rd)', lat: 49.8401, lon: -97.2546, shop: true };
  const legacy = { name: 'Monday', when: '2026-09-28T13:05:00.123Z', seq: [shop, S1, S2], rt: true, skipped: [Object.assign({ skip: true }, S3)] };
  const a = R.fromLegacy(legacy, 'Riley', T0, fakeCrypto);
  assert.ok(R.ID_RE.test(a.id));
  assert.deepStrictEqual(Object.assign({}, a, { id: 'x' }), { id: 'x', name: 'Monday', owner: 'Riley', by: '', at: '2026-09-28T13:05:00Z', rt: true,
    start: { mode: 'shop' }, seq: [R.cleanStop(S1), R.cleanStop(S2)], skipped: [R.cleanStop(S3)] });
  const b = R.fromLegacy({ name: 'From site', when: 'bad', seq: [S1, S2] }, '', T0, fakeCrypto);
  assert.deepStrictEqual([b.start, b.seq.length, b.at], [{ mode: 'stop' }, 2, ISO0], 'a site start stays #1');
  assert.strictEqual(R.fromLegacy({ name: 'x', seq: [shop] }, '', T0), null, 'nothing but the shop');
  assert.strictEqual(R.fromLegacy(null), null);
});

/* ======================================== store ======================================== */

test('read with key: API URL + headers, cache no-store; list newest first, tombstones hidden, hostile entries dropped', async () => {
  const { store, srv } = setup({ key: true, routes: {
    [ID_A]: route(ID_A, 'Older', '2026-09-29T10:00:00Z'), [ID_B]: route(ID_B, 'Newer', '2026-09-30T10:00:00Z'),
    [ID_C]: { deleted: true, at: ISO0, by: 'PC' }, rbadroute1: { name: 'no stops', at: ISO0, seq: [] } } });
  assert.strictEqual(store.mode, 'github');
  assert.strictEqual(store.writable, true);
  const list = await store.load();
  assert.deepStrictEqual(list.map((r) => r.name), ['Newer', 'Older']);
  assert.strictEqual(srv.requests.length, 1);
  const r = srv.requests[0];
  assert.strictEqual(r.url, API);
  assert.strictEqual(r.headers.authorization, 'Bearer ' + KEY);
  assert.strictEqual(r.headers.accept, 'application/vnd.github+json');
  assert.strictEqual(r.headers['x-github-api-version'], '2022-11-28');
  assert.strictEqual(r.cache, 'no-store');
  assert.deepStrictEqual(store.peek(), list, 'peek = the same list');
  assert.strictEqual(store.get(ID_B).name, 'Newer');
  assert.strictEqual(store.get(ID_C), null, 'a tombstone is not a route');
  list[0].name = 'mutated';
  assert.strictEqual(store.peek()[0].name, 'Newer', 'copies are handed out');
});

test('404 = empty list; the first save creates routes.json (PUT without sha)', async () => {
  const { store, srv } = setup({ key: true, srvOpts: { exists: false } });
  assert.deepStrictEqual(await store.load(), []);
  assert.strictEqual(store.lastError, null);
  const res = await store.save({ name: 'First', owner: 'Riley', seq: [S1], start: { mode: 'shop' } });
  assert.strictEqual(res.status, 'saved');
  assert.ok(R.ID_RE.test(res.id));
  const body = lastPut(srv);
  assert.strictEqual(body.sha, undefined);
  assert.strictEqual(body.branch, 'main');
  assert.strictEqual(body.message, 'route: save "First"');
  assert.deepStrictEqual(Object.keys(srv.routes()), [res.id]);
});

test('read without key on the live site: raw URL with ?t=, no Authorization; read-only (save / remove refused)', async () => {
  const { store, srv } = setup({ routes: { [ID_A]: route(ID_A, 'Shared', ISO0) } });
  assert.strictEqual(store.mode, 'readonly');
  assert.strictEqual(store.writable, false);
  assert.strictEqual(store.hasKey(), false);
  const list = await store.load();
  assert.deepStrictEqual(list.map((r) => r.name), ['Shared']);
  assert.strictEqual(srv.requests[0].url, RAW + '?t=' + T0);
  assert.ok(!('authorization' in srv.requests[0].headers));
  const s = track(store.save(route(null, 'x', ISO0)));
  const d = track(store.remove(ID_A));
  await drain();
  assert.strictEqual(s.state, 'rejected'); assert.strictEqual(s.error.code, 'readonly');
  assert.strictEqual(d.state, 'rejected'); assert.strictEqual(d.error.code, 'readonly');
  assert.strictEqual(puts(srv).length, 0);
  // 404 on the CDN: empty, no error
  const t = setup({ srvOpts: { exists: false } });
  assert.deepStrictEqual(await t.store.load(), []);
  assert.strictEqual(t.store.lastError, null);
});

test('local mode (localhost without a key): saves and deletes in ns + "saved_routes_local", never the network', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const { store, srv, storage } = setup({ hostname: host });
    assert.strictEqual(store.mode, 'local', host);
    assert.strictEqual(store.writable, true);
    const res = await store.save({ name: 'Local', seq: [S1, S2], start: { mode: 'stop' }, owner: 'Riley' });
    assert.deepStrictEqual(res, { status: 'saved', id: res.id });
    const file = JSON.parse(storage.getItem('ej_saved_routes_local'));
    assert.strictEqual(file.version, 1);
    assert.strictEqual(file.routes[res.id].start.mode, 'stop');
    assert.strictEqual(file.routes[res.id].by, 'PC');
    assert.deepStrictEqual((await store.load()).map((r) => r.name), ['Local']);
    assert.strictEqual(store.peek()[0].pending, undefined, 'local routes are never pending');
    await store.remove(res.id);
    assert.deepStrictEqual(store.peek(), []);
    assert.strictEqual(srv.requests.length, 0, 'no network in local mode');
    assert.strictEqual(store.status().pending, 0);
  }
  assert.strictEqual(setup({ hostname: LIVE_HOST }).store.mode, 'readonly');
  assert.strictEqual(setup({ hostname: 'localhost.evil.com' }).store.mode, 'readonly');
  assert.strictEqual(setup({ hostname: 'localhost', key: true }).store.mode, 'github', 'a key always wins');
});

test('save with key: sanitized payload, at/by stamped, owner kept, hostile fields dropped; update keeps the id', async () => {
  const { store, srv, clock } = setup({ key: true, routes: { [ID_A]: route(ID_A, 'Existing', '2026-09-29T10:00:00Z') } });
  await store.load();
  const res = await store.save({ id: 'not-an-id', name: 'Setup \u202ecrew', owner: 'Riley', by: 'spoofed', at: '1999-01-01T00:00:00Z', rt: true,
    start: { mode: 'shop' }, seq: [S1, { lat: 'x' }, S2, Object.assign({ skip: true, __proto__: { bad: 1 } }, S3)], skipped: [S3], html: '<b>' });
  assert.strictEqual(res.status, 'saved');
  assert.notStrictEqual(res.id, 'not-an-id');
  assert.ok(R.ID_RE.test(res.id));
  const saved = srv.routes()[res.id];
  assert.deepStrictEqual(saved, { id: res.id, name: 'Setup crew', owner: 'Riley', by: 'PC', at: ISO0, rt: true, start: { mode: 'shop' },
    seq: [R.cleanStop(S1), R.cleanStop(S2), R.cleanStop(S3)], skipped: [R.cleanStop(S3)] });
  assert.strictEqual(srv.routes()[ID_A].name, 'Existing', 'other routes untouched');
  assert.strictEqual(lastPut(srv).sha, 'sha-1');
  assert.strictEqual(lastPut(srv).message, 'route: save "Setup crew"');
  // update: same id, new name, later time
  await clock.advance(60000);
  const upd = await store.save(Object.assign({}, store.get(res.id), { name: 'Setup + cleanup' }));
  assert.deepStrictEqual(upd, { status: 'saved', id: res.id });
  assert.strictEqual(srv.routes()[res.id].name, 'Setup + cleanup');
  assert.strictEqual(srv.routes()[res.id].at, iso(T0 + 60000));
  assert.strictEqual(puts(srv).length, 2);
  // saving exactly what is there makes no commit? (at always changes, so a save is always a commit)
  const bad = track(store.save({ name: 'empty', seq: [] }));
  const bad2 = track(store.save('route'));
  await drain();
  assert.strictEqual(bad.error.code, 'invalid');
  assert.strictEqual(bad2.error.code, 'invalid');
  assert.strictEqual(puts(srv).length, 2);
});

test('a save beats the version shown even when this device\'s clock runs behind', async () => {
  const ahead = iso(T0 + 5 * 60000);
  const { store, srv } = setup({ key: true, routes: { [ID_A]: route(ID_A, 'Edited on a fast clock', ahead) } });
  await store.load();
  const res = await store.save(Object.assign({}, store.get(ID_A), { name: 'Mine' }));
  assert.strictEqual(res.status, 'saved');
  assert.strictEqual(srv.routes()[ID_A].name, 'Mine');
  assert.strictEqual(srv.routes()[ID_A].at, iso(T0 + 5 * 60000 + 1000));
});

test('remove: a tombstone {deleted, at, by} ("route: delete"), hidden from the list; old tombstones pruned on write', async () => {
  const { store, srv, clock } = setup({ key: true, routes: {
    [ID_A]: route(ID_A, 'Doomed', '2026-09-29T10:00:00Z'),
    rold000001: { deleted: true, at: iso(T0 - 31 * DAY), by: 'PC' },
    rnew000001: { deleted: true, at: iso(T0 - 29 * DAY), by: 'PC' } } });
  await store.load();
  const res = await store.remove(ID_A);
  assert.deepStrictEqual(res, { status: 'saved', id: ID_A });
  assert.strictEqual(lastPut(srv).message, 'route: delete "Doomed"');
  const rs = srv.routes();
  assert.deepStrictEqual(rs[ID_A], { deleted: true, at: ISO0, by: 'PC' });
  assert.strictEqual(rs.rold000001, undefined, 'older than 30 days: pruned');
  assert.ok(rs.rnew000001, '29 days: kept');
  assert.deepStrictEqual(store.peek(), []);
  // removing an unknown id: no commit; a malformed id is refused
  await clock.advance(1000);
  assert.deepStrictEqual(await store.remove('rnothere01'), { status: 'saved', id: 'rnothere01' });
  assert.strictEqual(puts(srv).length, 1);
  const bad = track(store.remove('../etc'));
  await drain();
  assert.strictEqual(bad.error.code, 'invalid');
});

test('409 -> re-GET and merge per route id: another device\'s new route survives, this one is added', async () => {
  const { store, srv, clock } = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', '2026-09-29T10:00:00Z') } });
  await store.load();
  srv.commitFile(docText({ [ID_A]: route(ID_A, 'A', '2026-09-29T10:00:00Z'), [ID_B]: route(ID_B, 'From iPhone', '2026-09-30T14:00:00Z') }), 'other device');
  const res = await settle(clock, store.save({ name: 'Mine', seq: [S1] }));
  assert.strictEqual(res.status, 'saved');
  const codes = srv.requests.map((r) => r.method);
  assert.deepStrictEqual(codes, ['GET', 'PUT', 'GET', 'PUT'], '409 then re-GET, then PUT');
  assert.deepStrictEqual(Object.keys(srv.routes()).sort(), [ID_A, ID_B, res.id].sort());
  assert.deepStrictEqual(store.peek().map((r) => r.name), ['Mine', 'From iPhone', 'A']);
});

test('merge per id: newest "at" wins, tombstones included (both directions)', async () => {
  // (1) the same route was edited later elsewhere while this save was in flight: the newer one stays
  const s1 = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', '2026-09-29T10:00:00Z') } });
  await s1.store.load();
  s1.srv.commitFile(docText({ [ID_A]: route(ID_A, 'Newer elsewhere', iso(T0 + 3600000)) }), 'other');
  const r1 = await settle(s1.clock, s1.store.save(Object.assign({}, s1.store.get(ID_A), { name: 'Mine' })));
  assert.strictEqual(r1.status, 'saved', 'nothing left to save');
  assert.strictEqual(s1.srv.routes()[ID_A].name, 'Newer elsewhere');
  assert.strictEqual(puts(s1.srv).length, 1, 'only the refused PUT');
  assert.strictEqual(s1.store.status().pending, 0);
  assert.strictEqual(s1.store.get(ID_A).name, 'Newer elsewhere');
  // (2) deleted elsewhere later: stays deleted
  const s2 = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', '2026-09-29T10:00:00Z') } });
  await s2.store.load();
  s2.srv.commitFile(docText({ [ID_A]: { deleted: true, at: iso(T0 + 3600000), by: 'iPhone app' } }), 'other');
  await settle(s2.clock, s2.store.save(Object.assign({}, s2.store.get(ID_A), { name: 'Mine' })));
  assert.strictEqual(s2.srv.routes()[ID_A].deleted, true);
  assert.deepStrictEqual(s2.store.peek(), []);
  // (3) an older tombstone elsewhere loses to this newer save (the route comes back); a newer delete here beats an older edit
  const s3 = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', '2026-09-29T10:00:00Z') } });
  await s3.store.load();
  s3.srv.commitFile(docText({ [ID_A]: { deleted: true, at: '2026-09-30T09:00:00Z', by: 'iPhone app' }, [ID_B]: route(ID_B, 'B', '2026-09-30T09:00:00Z') }), 'other');
  await settle(s3.clock, s3.store.save(Object.assign({}, s3.store.get(ID_A), { name: 'Back' })));
  assert.strictEqual(s3.srv.routes()[ID_A].name, 'Back');
  await settle(s3.clock, s3.store.remove(ID_B));
  assert.strictEqual(s3.srv.routes()[ID_B].deleted, true);
});

test('422 (missing sha) -> re-GET and retry; 3 conflicts in a row -> queued with the reason, replayed at the next poll', async () => {
  const s = setup({ key: true, routes: {} });
  await s.store.load();
  s.srv.hook = (req) => (req.method === 'PUT' && s.srv.hook.n422-- > 0 ? s.srv.resp(422, { message: 'sha' }) : undefined);
  s.srv.hook.n422 = 1;
  assert.strictEqual((await settle(s.clock, s.store.save({ name: 'x', seq: [S1] }))).status, 'saved');
  const t = setup({ key: true, routes: {} });
  await t.store.load();
  t.store.start();
  t.srv.hook = (req) => (req.method === 'PUT' && t.srv.hook.n-- > 0 ? t.srv.resp(409, { message: 'no' }) : undefined);
  t.srv.hook.n = 3;
  const p = track(t.store.save({ name: 'Stubborn', seq: [S1] }));
  await t.clock.advance(5000);
  assert.strictEqual(p.value.status, 'queued');
  assert.strictEqual(p.value.reason, 'conflict');
  assert.strictEqual(puts(t.srv).length, 3, 'at most 3 attempts');
  assert.ok(/another device/.test(t.store.lastError));
  assert.strictEqual(t.store.status().pending, 1);
  assert.strictEqual(t.store.peek()[0].pending, true, 'shown as waiting');
  await t.clock.advance(60000);
  assert.strictEqual(puts(t.srv).length, 4);
  assert.strictEqual(Object.values(t.srv.routes())[0].name, 'Stubborn');
  assert.strictEqual(t.store.status().pending, 0);
  assert.strictEqual(t.store.lastError, null);
  t.store.stop();
});

test('offline: save -> queued in ns + "route_queue" (write-ahead), shown pending; replayed on "online"; survives a restart', async () => {
  const s = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', '2026-09-29T10:00:00Z') } });
  await s.store.load();
  s.store.start();
  s.srv.offline = true;
  const res = await s.store.save({ name: 'Offline route', seq: [S1], owner: 'Riley' });
  assert.deepStrictEqual(res, { status: 'queued', id: res.id, reason: 'offline' });
  const q = JSON.parse(s.storage.getItem('ej_route_queue'));
  assert.strictEqual(q.version, 1);
  assert.strictEqual(q.ops[res.id].entry.name, 'Offline route');
  assert.strictEqual(s.store.pending, 1);
  assert.ok(/Offline/.test(s.store.lastError));
  const del = await s.store.remove(ID_A);
  assert.strictEqual(del.status, 'queued');
  assert.deepStrictEqual(s.store.peek().map((r) => [r.name, r.pending]), [['Offline route', true]], 'the delete shows at once');
  // a restart while still offline: a new store on the same storage shows the queued changes
  const s2 = R.createStore(Object.assign({}, s.env, { fetch: s.srv.fetch }));
  assert.deepStrictEqual(s2.peek().map((r) => r.name), ['Offline route']);
  assert.strictEqual(s2.pending, 2);
  s.store.stop();
  // back online: the restarted store replays both in ONE commit
  s.srv.offline = false;
  s2.start();
  s.window.dispatch('online');
  await s.clock.advance(10);
  assert.strictEqual(s.srv.commits.length, 1, 'one commit for both queued changes');
  assert.strictEqual(lastPut(s.srv).message, 'routes: save "Offline route"; delete "A"');
  assert.strictEqual(s.srv.routes()[ID_A].deleted, true);
  assert.strictEqual(s.srv.routes()[res.id].owner, 'Riley');
  assert.strictEqual(s2.pending, 0);
  assert.strictEqual(s.storage.getItem('ej_route_queue'), null);
  assert.strictEqual(s2.lastError, null);
  s2.stop();
});

test('start() replays queued changes at once (none while hidden are lost); a hostile queue is sanitized', async () => {
  const hostileQueue = JSON.stringify({ version: 1, ops: {
    [ID_A]: { entry: route(ID_A, 'Queued\u202e', ISO0), name: 'Queued' },
    'bad id': { entry: route('bad id', 'x', ISO0) }, [ID_B]: { entry: { seq: [] } }, [ID_C]: 'nope' } });
  const s = setup({ key: true, ls: { ej_route_queue: hostileQueue } });
  assert.strictEqual(s.store.pending, 1);
  s.store.start();
  s.document.visibilityState = 'hidden';
  s.document.dispatch('visibilitychange');
  await s.clock.advance(10);
  assert.strictEqual(puts(s.srv).length, 1, 'start() replays at once');
  assert.strictEqual(s.srv.routes()[ID_A].name, 'Queued');
  s.store.stop();
});

test('cold start offline: the last good routes come from ns + "saved_routes_cache"; peek() is synchronous', async () => {
  const s = setup({ key: true, routes: { [ID_A]: route(ID_A, 'Cached', ISO0) } });
  await s.store.load();
  const cache = JSON.parse(s.storage.getItem('ej_saved_routes_cache'));
  assert.ok(cache.map[ID_A]);
  assert.ok(!JSON.stringify(cache).includes('github_pat_'), 'no key in the cache');
  s.srv.offline = true;
  const s2 = R.createStore(Object.assign({}, s.env));
  assert.deepStrictEqual(s2.peek().map((r) => r.name), ['Cached']);
  const list = await s2.load();
  assert.deepStrictEqual(list.map((r) => r.name), ['Cached'], 'load() never rejects');
  assert.ok(/Offline/.test(s2.lastError));
});

test('damaged routes.json is never overwritten: last known list kept, saves wait (queued, reason "format")', async () => {
  const s = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', ISO0) } });
  await s.store.load();
  s.srv.commitFile('{"version":1, "routes": [oops', 'hand edit');
  const list = await s.store.load();
  assert.deepStrictEqual(list.map((r) => r.name), ['A'], 'the last known routes stay');
  assert.ok(/damaged/.test(s.store.lastError));
  const res = await s.store.save({ name: 'Waits', seq: [S1] });
  assert.strictEqual(res.status, 'queued');
  assert.strictEqual(res.reason, 'format');
  assert.strictEqual(puts(s.srv).length, 0, 'never PUT over a damaged file');
  // raw read of a damaged file (no key): same, no crash
  const t = setup({ srvOpts: { text: 'not json' } });
  assert.deepStrictEqual(await t.store.load(), []);
  assert.ok(/damaged/.test(t.store.lastError));
  // fixed: the queued save goes through at the next poll
  s.store.start();
  s.srv.commitFile(docText({ [ID_A]: route(ID_A, 'A', ISO0) }), 'fixed');
  await s.clock.advance(60000);
  assert.strictEqual(puts(s.srv).length, 1);
  assert.deepStrictEqual(Object.values(s.srv.routes()).map((r) => r.name).sort(), ['A', 'Waits']);
  s.store.stop();
});

test('a routes.json from a newer app version (version > 1) is read but never overwritten', async () => {
  const text = docText({ [ID_A]: route(ID_A, 'Future', ISO0, { color: 'red' }) }, { version: 2 });
  const s = setup({ key: true, srvOpts: { text } });
  const list = await s.store.load();
  assert.deepStrictEqual(list.map((r) => r.name), ['Future']);
  const res = await s.store.save({ name: 'Mine', seq: [S1] });
  assert.deepStrictEqual([res.status, res.reason], ['queued', 'format']);
  assert.ok(/newer version/.test(s.store.lastError));
  assert.strictEqual(puts(s.srv).length, 0);
  assert.strictEqual(s.srv.text, text, 'untouched');
});

test('auth: 401 on read -> mode invalid (raw fallback), saves refused; PUT 404 -> "needs write access", change kept', async () => {
  const s = setup({ key: 'github_pat_TESTONLY_rejected_key_000000000_notreal', routes: { [ID_A]: route(ID_A, 'A', ISO0) } });
  const list = await s.store.load();
  assert.strictEqual(s.store.mode, 'invalid');
  assert.strictEqual(s.store.writable, false);
  assert.deepStrictEqual(list.map((r) => r.name), ['A'], 'still shows the CDN copy');
  assert.strictEqual(s.store.lastError, 'Edit key rejected \u2014 Settings \u2192 Stages');
  const p = track(s.store.save({ name: 'x', seq: [S1] }));
  await drain();
  assert.strictEqual(p.error.code, 'auth');
  // a new key saved (by the Stages store) is picked up without a new store
  s.storage.setItem('ej_gh_token', KEY);
  assert.strictEqual(s.store.mode, 'github');
  assert.strictEqual(s.store.lastError, null, 'the auth error goes with the old key');
  // a key that can read but not write
  const t = setup({ key: true, routes: {} });
  await t.store.load();
  t.srv.hook = (req) => (req.method === 'PUT' ? t.srv.resp(404, { message: 'Not Found' }) : undefined);
  const r = await t.store.save({ name: 'x', seq: [S1] });
  assert.deepStrictEqual([r.status, r.reason], ['queued', 'auth']);
  assert.strictEqual(t.store.mode, 'invalid');
  assert.ok(/Contents: Read and write/.test(t.store.lastError));
  assert.strictEqual(t.store.pending, 1, 'kept for a working key');
  // rate limit is not a rejected key
  const u = setup({ key: true, routes: {} });
  await u.store.load();
  u.srv.hook = (req) => (req.method === 'PUT' ? u.srv.resp(403, { message: 'API rate limit exceeded' }) : undefined);
  const q = await u.store.save({ name: 'x', seq: [S1] });
  assert.strictEqual(q.status, 'queued');
  assert.strictEqual(u.store.mode, 'github');
  assert.ok(/rate limit/.test(u.store.lastError));
});

test('key removed (Settings -> Stages -> Remove) -> read-only; a key change re-reads with the new key', async () => {
  const s = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', ISO0) } });
  await s.store.load();
  s.storage.removeItem('ej_gh_token');
  assert.strictEqual(s.store.mode, 'readonly');
  await s.store.load();
  assert.ok(s.srv.requests.slice(-1)[0].url.startsWith(RAW));
  s.storage.setItem('ej_gh_token', '  ' + KEY2 + '\n');
  assert.strictEqual(s.store.mode, 'github');
  await s.store.save({ name: 'with key 2', seq: [S1] });
  const gets = s.srv.requests.filter((r) => r.method === 'GET' && r.url === API);
  assert.strictEqual(gets.slice(-1)[0].headers.authorization, 'Bearer ' + KEY2, 'fresh read with the new key (whitespace stripped)');
  assert.strictEqual(puts(s.srv).slice(-1)[0].headers.authorization, 'Bearer ' + KEY2);
});

test('onChange / onStatus: another device\'s route arrives at the poll; nothing fires when nothing changed', async () => {
  const s = setup({ key: true, routes: { [ID_A]: route(ID_A, 'A', ISO0) } });
  const changes = [], statuses = [];
  const offC = s.store.onChange((l) => changes.push(l.map((r) => r.name)));
  s.store.onStatus((st) => statuses.push(st));
  await s.store.load();
  s.store.start();
  await s.clock.advance(60000);
  assert.strictEqual(changes.length, 0, 'same list: no event');
  s.srv.commitFile(docText({ [ID_A]: route(ID_A, 'A', ISO0), [ID_B]: route(ID_B, 'New', iso(T0 + 1000)) }), 'other');
  await s.clock.advance(60000);
  assert.deepStrictEqual(changes, [['New', 'A']]);
  assert.ok(statuses.length >= 1);
  assert.deepStrictEqual(Object.keys(statuses[0]).sort(), ['lastError', 'lastSync', 'mode', 'pending', 'writable']);
  offC();
  s.srv.commitFile(docText({}), 'wipe');
  await s.clock.advance(60000);
  assert.strictEqual(changes.length, 1, 'unsubscribed');
  s.store.stop();
});

test('polling: 60 s with a key, 300 s read-only, none in local mode, paused while hidden; stop() cleans up', async () => {
  const s = setup({ key: true });
  s.store.start();
  await s.clock.advance(59000);
  assert.strictEqual(s.srv.requests.length, 0);
  await s.clock.advance(1000);
  assert.strictEqual(s.srv.requests.length, 1);
  s.document.visibilityState = 'hidden';
  await s.clock.advance(120000);
  assert.strictEqual(s.srv.requests.length, 1, 'no reads while hidden');
  s.document.visibilityState = 'visible';
  s.document.dispatch('visibilitychange');
  await s.clock.advance(10);
  assert.strictEqual(s.srv.requests.length, 2, 'read at once when visible');
  s.store.stop();
  assert.strictEqual(s.document.count('visibilitychange'), 0);
  assert.strictEqual(s.window.count('online'), 0);
  assert.strictEqual(s.clock.pending(), 0);
  const r = setup({});
  r.store.start();
  await r.clock.advance(299000);
  assert.strictEqual(r.srv.requests.length, 0);
  await r.clock.advance(1000);
  assert.strictEqual(r.srv.requests.length, 1);
  r.store.stop();
  const l = setup({ hostname: 'localhost' });
  l.store.start();
  await l.clock.advance(600000);
  assert.strictEqual(l.srv.requests.length, 0);
  l.store.stop();
});

test('caps: saving route 301 keeps the newest 300 in the file', async () => {
  const routes = {};
  for (let i = 0; i < 300; i++) routes['rcap' + String(i).padStart(5, '0')] = route('x', 'r' + i, iso(T0 - (i + 1) * 60000));
  const s = setup({ key: true, routes });
  await s.store.load();
  const res = await s.store.save({ name: 'Newest', seq: [S1] });
  const rs = s.srv.routes();
  assert.strictEqual(Object.keys(rs).length, 300);
  assert.ok(rs[res.id]);
  assert.strictEqual(rs.rcap00299, undefined, 'the oldest dropped');
});

test('caps: routes.json stays under LIMITS.fileBytes (GitHub stops serving files over 1 MB): the oldest routes go', async () => {
  const big = []; for (let i = 0; i < 60; i++) big.push(stop('Stop ' + i + ' ' + 'x'.repeat(60), 49.8 + i / 1000, -97.1, { jobNumber: 100 + i, match: 'm'.repeat(110) }));
  const routes = {};
  for (let i = 0; i < 300; i++) routes['rsize' + String(i).padStart(5, '0')] = route('x', 'r' + i, iso(T0 - (i + 1) * 60000), { seq: big });
  const m = U.parseDocText(docText(routes)).map;
  const n = Object.keys(m).length, bytes = Buffer.byteLength(U.serializeDoc(m));
  assert.ok(n < 300 && n > 20, 'kept ' + n);
  assert.ok(bytes <= 900000 && bytes > 850000, 'bytes ' + bytes);
  assert.ok(m.rsize00000 && !m.rsize00299, 'the newest stay, the oldest go');
  // a 403 "too large" read is an HTTP problem, never "Edit key rejected"
  const s = setup({ key: true });
  s.srv.hook = (req) => req.method === 'GET' && req.url.startsWith(API) ? s.srv.resp(403, { message: 'This API returns blobs up to 1 MB in size. The requested blob is too large to fetch via the API', errors: [{ code: 'too_large' }] }) : null;
  await s.store.load();
  assert.strictEqual(s.store.mode, 'github', 'the key is not marked invalid');
  assert.ok(/too large/.test(s.store.status().lastError || ''), String(s.store.status().lastError));
});

test('save(route, {keepAt: true}) keeps the date of a NEW route (the one-time copy of device routes); updates are stamped now', async () => {
  const { store, storage } = setup({ hostname: 'localhost' });
  const old = await store.save({ name: 'Old R2 route', seq: [S1, S2], at: '2026-09-20T15:00:00Z' }, { keepAt: true });
  const file = () => JSON.parse(storage.getItem('ej_saved_routes_local')).routes;
  assert.strictEqual(file()[old.id].at, '2026-09-20T15:00:00Z');
  const fut = await store.save({ name: 'Future', seq: [S1], at: iso(T0 + DAY) }, { keepAt: true });
  assert.strictEqual(file()[fut.id].at, ISO0, 'a future date is not kept');
  const plain = await store.save({ name: 'Plain', seq: [S1], at: '2026-09-01T00:00:00Z' });
  assert.strictEqual(file()[plain.id].at, ISO0, 'without keepAt: now');
  await store.save({ id: old.id, name: 'Old R2 route', seq: [S1], at: '2026-09-20T15:00:00Z' }, { keepAt: true });
  assert.strictEqual(file()[old.id].at, ISO0, 'an update is always stamped now');
});

test('config: default ns "ej_"; another main ns uses its own keys; a bad or non-main config is locked read-only', async () => {
  assert.deepStrictEqual(R.resolveConfig(undefined), { channel: 'main', base: '', ns: 'ej_', routesFile: 'routes.json' });
  assert.deepStrictEqual(R.resolveConfig({ channel: 'main', base: '../', ns: 'ejx_', stateFile: 'stages.json', overlayFile: null, cachePrefix: 'ej-' }),
    { channel: 'main', base: '../', ns: 'ejx_', routesFile: 'routes.json' }, 'other EJ_CONFIG fields are ignored');
  const s = setup({ config: { ns: 'ejx_' }, ls: { ejx_gh_token: KEY } });
  assert.strictEqual(s.store.mode, 'github');
  s.srv.offline = true;
  await s.store.save({ name: 'x', seq: [S1] });
  assert.ok(s.storage.getItem('ejx_route_queue'));
  assert.strictEqual(s.storage.getItem('ej_route_queue'), null);
  for (const bad of ['nope', { ns: 'bad ns!' }, { base: 'https://evil/' }, { channel: 'beta', ns: 'ejb_' }, { channel: 'beta', ns: 'ej_', routesFile: 'routes-beta.json' }]) {
    const t = setup({ config: bad, key: true, hostname: 'localhost' });
    assert.strictEqual(t.store.mode, 'readonly', JSON.stringify(bad));
    assert.ok(t.store.status().locked);
    assert.strictEqual(t.store.hasKey(), false, 'a locked store never reads the key');
    const p = track(t.store.save({ name: 'x', seq: [S1] }));
    await drain();
    assert.strictEqual(p.error.code, 'readonly');
    await t.store.load();
    assert.strictEqual(t.storage._map.size, 1, 'no storage writes');
  }
  const beta = setup({ config: { channel: 'beta', ns: 'ejb_', routesFile: 'routes-beta.json' }, ls: { ejb_gh_token: KEY } });
  assert.strictEqual(beta.store.mode, 'github', 'a beta with its own file and keys');
  await beta.store.load();
  assert.ok(beta.srv.requests[0].url.endsWith('/contents/routes-beta.json'));
});

test('works as a plain browser <script>: global SavedRoutes, browser globals as defaults', async () => {
  const vm = require('vm');
  const clock = makeClock();
  const srv = makeServer({ [ID_A]: route(ID_A, 'A', ISO0) });
  const win = makeTarget();
  const ctx = Object.assign(win, {
    fetch: srv.fetch, localStorage: makeStorage({ ej_gh_token: KEY }), location: { hostname: LIVE_HOST },
    document: makeTarget({ visibilityState: 'visible' }), navigator: { userAgent: 'Mozilla/5.0 (iPhone)', standalone: true },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, TextEncoder, TextDecoder, btoa, atob, AbortController,
    crypto: require('crypto').webcrypto
  });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'routes.js' });
  assert.strictEqual(typeof ctx.SavedRoutes, 'object');
  const store = ctx.SavedRoutes.createStore();
  assert.strictEqual(store.mode, 'github');
  assert.strictEqual((await store.load()).length, 1);
  const res = await store.save({ name: 'From the phone', seq: [S1] });
  assert.strictEqual(srv.routes()[res.id].by, 'iPhone app');
  store.start();
  assert.strictEqual(win.count('online'), 1);
  store.stop();
  const local = vm.createContext({ location: { hostname: 'localhost' }, localStorage: makeStorage({}), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), local);
  assert.strictEqual(local.SavedRoutes.createStore().mode, 'local');
});

test('storage blocked: save rejects "storage" instead of losing the route silently', async () => {
  const s = setup({ key: true, storageOpts: { throwSet: true } });
  const p = track(s.store.save({ name: 'x', seq: [S1] }));
  await drain();
  assert.strictEqual(p.error.code, 'storage');
  assert.strictEqual(puts(s.srv).length, 0);
});

test('key hygiene: never in a URL, a body, a status, an error, the console or other storage; only api.github.com gets it', async () => {
  const s = setup({ key: true });
  const seen = [];
  s.store.onStatus((x) => seen.push(JSON.stringify(x)));
  s.store.onChange((l) => seen.push(JSON.stringify(l)));
  await s.store.load();
  s.srv.hook = (req) => (req.method === 'PUT' ? s.srv.resp(401, { message: 'Bad credentials' }) : undefined);
  const r = await s.store.save({ name: 'x', seq: [S1] });
  seen.push(JSON.stringify(r), String(s.store.lastError), JSON.stringify(s.store.status()), JSON.stringify(s.store.config));
  seen.forEach((t) => assert.ok(!t.includes('github_pat_'), 'status/change/error text contains the key'));
  assert.ok(ALL_REQUESTS.length > 40, 'hygiene check ran over the whole suite');
  for (const q of ALL_REQUESTS) {
    const u = new URL(q.url);
    assert.ok(!q.url.includes('github_pat_'), 'key in a URL');
    const keyHeader = Object.keys(q.headers).some((h) => String(q.headers[h]).includes('github_pat_'));
    if (keyHeader) assert.strictEqual(u.origin, 'https://api.github.com');
    if (q.body) assert.ok(!String(q.body).includes('github_pat_'), 'key in a request body');
    if (u.origin !== 'https://api.github.com') assert.ok(!('authorization' in q.headers));
    assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(u.origin), 'unexpected host ' + u.origin);
  }
  for (const st of ALL_STORAGES) {
    for (const [k, v] of st._map) if (!/gh_token$/.test(k)) assert.ok(!String(v).includes('github_pat_'), 'key stored under ' + k);
  }
  assert.ok(!CONSOLE_OUT.some((l) => l.includes('github_pat_')), 'key printed to the console');
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/console\s*\./.test(src), 'routes.js must not log');
  assert.ok(!/innerHTML|eval\(|new Function/.test(src));
  assert.ok(!/=>|\blet\b|\bconst\b|`/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'plain ES5-style script');
});

/* ---------- run ---------- */
(async () => {
  let failed = 0;
  process.on('unhandledRejection', (e) => { failed++; console.log('FAIL unhandled rejection: ' + (e && e.stack || e)); });
  for (const t of tests) {
    try {
      await t.fn();
      console.log('PASS ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     '));
    }
  }
  await drain();
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
