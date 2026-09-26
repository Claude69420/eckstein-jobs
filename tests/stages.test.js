'use strict';
/* Node tests for js/stages.js (no npm deps). Run: node tests/stages.test.js
 * Uses a mocked GitHub (contents API + raw CDN), a fake localStorage, fake timers and fake
 * document/window event targets. Exit code 1 on any failure. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'js', 'stages.js');
const Stages = require(SRC);

const KEY = 'github_pat_TESTONLY_0123456789abcdefghijABCDEFGHIJ_notreal';
const API = 'https://api.github.com/repos/Claude69420/eckstein-jobs-state/contents/stages.json';
const RAW = 'https://raw.githubusercontent.com/Claude69420/eckstein-jobs-state/main/stages.json';
const LIVE_HOST = 'claude69420.github.io';
const AUTH_MSG = 'Edit key rejected — Settings → Stages';
const T0 = Date.UTC(2026, 8, 26, 15, 0, 0);

/* ---------- global recorders (key hygiene checks run over these at the end) ---------- */
const ALL_REQUESTS = [];
const CONSOLE_OUT = [];
['log', 'info', 'warn', 'error', 'debug'].forEach((m) => {
  const orig = console[m].bind(console);
  console[m] = (...a) => { CONSOLE_OUT.push(a.map(String).join(' ')); orig(...a); };
});

/* ---------- fakes ---------- */
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
function docText(stages, extra) { return JSON.stringify(Object.assign({ version: 1, stages: stages || {} }, extra || {}), null, 2) + '\n'; }
function b64lines(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') + '\n'; }
function entry(stage, at, by) { return { stage, at: at || '2026-09-25T10:00:00Z', by: by || 'iPhone app' }; }

/* Mock GitHub: contents API (auth, sha checks: 409 stale sha, 422 missing sha) + raw CDN. */
function makeServer(initialStages, opts) {
  const o = opts || {};
  const srv = {
    exists: o.exists !== false,
    text: o.text !== undefined ? o.text : docText(initialStages || {}),
    rawText: undefined,
    sha: 'sha-1', n: 1, offline: false,
    validKeys: new Set([KEY]),
    requests: [], commits: [], hook: null
  };
  function resp(status, body, headers) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const lower = {};
    Object.keys(headers || {}).forEach((k) => { lower[k.toLowerCase()] = String(headers[k]); });
    return { status, ok: status >= 200 && status < 300, headers: { get: (n) => (lower[String(n).toLowerCase()] ?? null) },
      text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)) };
  }
  srv.resp = resp;
  srv.commitFile = (newText, message) => { srv.text = newText; srv.exists = true; srv.sha = 'sha-' + (++srv.n); srv.commits.push({ message, text: newText }); };
  srv.stages = () => JSON.parse(srv.text).stages;
  srv.fetch = function (url, init) {
    const opt = init || {};
    const headers = {};
    Object.keys(opt.headers || {}).forEach((k) => { headers[k.toLowerCase()] = opt.headers[k]; });
    const req = { url: String(url), method: String(opt.method || 'GET').toUpperCase(), headers, body: opt.body, cache: opt.cache };
    srv.requests.push(req); ALL_REQUESTS.push(req);
    if (srv.offline) return Promise.reject(new TypeError('Failed to fetch'));
    if (srv.hook) { const r = srv.hook(req); if (r) return Promise.resolve(r); }
    const u = new URL(req.url);
    if (u.origin === 'https://raw.githubusercontent.com' && u.pathname === '/Claude69420/eckstein-jobs-state/main/stages.json') {
      if (!srv.exists) return Promise.resolve(resp(404, '404: Not Found'));
      return Promise.resolve(resp(200, srv.rawText !== undefined ? srv.rawText : srv.text));
    }
    if (u.origin === 'https://api.github.com' && u.pathname === '/repos/Claude69420/eckstein-jobs-state/contents/stages.json' && !u.search) {
      const m = /^Bearer (.+)$/.exec(headers.authorization || '');
      if (!m || !srv.validKeys.has(m[1])) return Promise.resolve(resp(401, { message: 'Bad credentials', status: '401' }));
      if (req.method === 'GET') {
        if (!srv.exists) return Promise.resolve(resp(404, { message: 'Not Found', status: '404' }));
        return Promise.resolve(resp(200, { name: 'stages.json', path: 'stages.json', sha: srv.sha, size: Buffer.byteLength(srv.text),
          type: 'file', encoding: 'base64', content: b64lines(srv.text) }));
      }
      if (req.method === 'PUT') {
        const b = JSON.parse(req.body);
        if (srv.exists && !b.sha) return Promise.resolve(resp(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.', status: '422' }));
        if (srv.exists && b.sha !== srv.sha) return Promise.resolve(resp(409, { message: 'stages.json does not match ' + b.sha, status: '409' }));
        const created = !srv.exists;
        srv.commitFile(Buffer.from(b.content, 'base64').toString('utf8'), b.message);
        return Promise.resolve(resp(created ? 201 : 200, { content: { name: 'stages.json', sha: srv.sha }, commit: { sha: 'c' + srv.n, message: b.message } }));
      }
    }
    return Promise.resolve(resp(404, { message: 'Not Found' }));
  };
  return srv;
}
function setup(o) {
  o = o || {};
  const clock = makeClock();
  const srv = o.srv || makeServer(o.stages || {}, o.srvOpts);
  const init = Object.assign({}, o.ls || {});
  if (o.key) init.ej_gh_token = o.key === true ? KEY : o.key;
  const storage = o.storage || makeStorage(init, o.storageOpts);
  const document = makeTarget({ visibilityState: 'visible' });
  const window = makeTarget();
  const persistCalls = [];
  const navigator = o.navigator || { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140', storage: { persist: () => { persistCalls.push(1); return Promise.resolve(true); } } };
  const store = Stages.createStore({ fetch: srv.fetch, storage, now: clock.now, hostname: o.hostname !== undefined ? o.hostname : LIVE_HOST,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, document, window, navigator });
  return { clock, srv, storage, document, window, navigator, store, persistCalls };
}
function track(p) {
  const s = { state: 'pending' };
  p.then((v) => { s.state = 'resolved'; s.value = v; }, (e) => { s.state = 'rejected'; s.error = e; });
  return s;
}
const puts = (srv) => srv.requests.filter((r) => r.method === 'PUT');
const gets = (srv) => srv.requests.filter((r) => r.method === 'GET');
const queueOf = (storage) => JSON.parse(storage.getItem('ej_stage_queue') || 'null');

/* ---------- runner ---------- */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ======================================= tests ======================================= */

test('STAGES, stageIndex and normalize match the contract', async () => {
  assert.deepStrictEqual(Stages.STAGES, [
    { key: 'ready', label: 'Ready to start', short: 'Ready' },
    { key: 'excavation', label: 'Excavation', short: 'Excav.' },
    { key: 'base', label: 'Base', short: 'Base' },
    { key: 'prep', label: 'Prep', short: 'Prep' },
    { key: 'inspected', label: 'Passed inspection', short: 'Passed' },
    { key: 'poured', label: 'Poured', short: 'Poured' }
  ]);
  ['ready', 'excavation', 'base', 'prep', 'inspected', 'poured'].forEach((k, i) => assert.strictEqual(Stages.stageIndex(k), i));
  [undefined, null, '', 'bogus', 42, {}].forEach((k) => assert.strictEqual(Stages.stageIndex(k), 0));
  assert.strictEqual(Stages.normalize('prep'), 'prep');
  assert.strictEqual(Stages.normalize('bogus'), 'ready');
  assert.strictEqual(Stages.normalize(undefined), 'ready');
});

test('read with key: API URL, Authorization/Accept/API-version headers, cache no-store, base64 UTF-8 decode', async () => {
  const { store, srv } = setup({ key: true, stages: { '684': entry('base', '2026-09-25T10:00:00Z', 'Gérard') } });
  assert.strictEqual(store.mode, 'github');
  assert.strictEqual(store.writable, true);
  assert.strictEqual(store.hasKey(), true);
  const map = await store.load();
  assert.deepStrictEqual(map, { '684': { stage: 'base', at: '2026-09-25T10:00:00Z', by: 'Gérard' } });
  assert.strictEqual(srv.requests.length, 1);
  const r = srv.requests[0];
  assert.strictEqual(r.url, API);
  assert.strictEqual(r.method, 'GET');
  assert.strictEqual(r.headers.authorization, 'Bearer ' + KEY);
  assert.strictEqual(r.headers.accept, 'application/vnd.github+json');
  assert.strictEqual(r.headers['x-github-api-version'], '2022-11-28');
  assert.strictEqual(r.cache, 'no-store');
});

test('read without key on the live site: raw URL with ?t=, no Authorization header, read-only', async () => {
  const { store, srv, clock } = setup({ stages: { '699': entry('prep') } });
  assert.strictEqual(store.mode, 'readonly');
  assert.strictEqual(store.writable, false);
  assert.strictEqual(store.hasKey(), false);
  const map = await store.load();
  assert.strictEqual(map['699'].stage, 'prep');
  const r = srv.requests[0];
  assert.strictEqual(r.url, RAW + '?t=' + clock.now());
  assert.strictEqual(r.method, 'GET');
  assert.ok(!('authorization' in r.headers), 'no Authorization header on raw reads');
  assert.strictEqual(r.cache, 'no-store');
  await assert.rejects(store.set(699, 'base'), (e) => e.code === 'readonly');
  assert.strictEqual(puts(srv).length, 0);
});

test('local mode only on localhost / 127.0.0.1 / [::1], never on the live site', async () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    const { store } = setup({ hostname: h });
    assert.strictEqual(store.mode, 'local', h);
    assert.strictEqual(store.writable, true, h);
  }
  for (const h of [LIVE_HOST, 'example.localhost', 'localhost.evil.test', '127.0.0.2', '']) {
    assert.strictEqual(setup({ hostname: h }).store.mode, 'readonly', h);
  }
  assert.strictEqual(setup({ hostname: 'localhost', key: true }).store.mode, 'github', 'a key wins over local');

  const { store, srv, storage } = setup({ hostname: 'localhost' });
  assert.deepStrictEqual(await store.load(), {});
  assert.deepStrictEqual(await store.set(684, 'base'), { status: 'saved' });
  const saved = JSON.parse(storage.getItem('ej_stages'));
  assert.deepStrictEqual(saved, { version: 1, stages: { '684': { stage: 'base', at: '2026-09-26T15:00:00Z', by: 'PC' } } });
  assert.strictEqual((await store.load())['684'].stage, 'base');
  await store.set('684', 'ready');
  assert.deepStrictEqual(JSON.parse(storage.getItem('ej_stages')).stages, {});
  assert.strictEqual(srv.requests.length, 0, 'local mode never touches the network');
});

test('writable flag per mode (github, local, readonly, invalid) and invalid key on load falls back to raw', async () => {
  assert.strictEqual(setup({ key: true }).store.writable, true);
  assert.strictEqual(setup({ hostname: 'localhost' }).store.writable, true);
  assert.strictEqual(setup({}).store.writable, false);
  const s = setup({ key: 'github_pat_REVOKED_0123456789abcdef', stages: { '1': entry('base') } });
  assert.strictEqual(s.store.mode, 'github');
  const map = await s.store.load(); // 401 on the API read -> invalid, then read-only raw read
  assert.strictEqual(s.store.mode, 'invalid');
  assert.strictEqual(s.store.writable, false);
  assert.strictEqual(s.store.lastError, AUTH_MSG);
  assert.strictEqual(map['1'].stage, 'base');
  const last = s.srv.requests[s.srv.requests.length - 1];
  assert.ok(last.url.startsWith(RAW + '?t='));
  assert.ok(!('authorization' in last.headers));
  await assert.rejects(s.store.set(1, 'prep'), (e) => e.code === 'auth');
});

test('batching: 3 sets within 3 s -> ONE PUT; message format for many and for one', async () => {
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  const a = track(store.set(684, 'base', { label: 'SW Corner Ellice & Kennedy' }));
  await clock.advance(1000);
  const b = track(store.set(699, 'prep', { label: 'Other St' }));
  await clock.advance(1500);
  const c = track(store.set('701', 'poured'));
  await clock.advance(499);
  assert.strictEqual(puts(srv).length, 0, 'nothing sent before 3 s');
  assert.strictEqual(a.state, 'pending');
  await clock.advance(1);
  assert.strictEqual(puts(srv).length, 1, 'exactly one PUT');
  [a, b, c].forEach((x) => assert.deepStrictEqual(x.value, { status: 'saved' }));
  assert.strictEqual(srv.commits[0].message, 'stages: #684 -> base, #699 -> prep, #701 -> poured');
  const body = JSON.parse(puts(srv)[0].body);
  assert.strictEqual(body.branch, 'main');
  assert.strictEqual(body.sha, 'sha-1');
  assert.strictEqual(body.message, srv.commits[0].message);
  const text = Buffer.from(body.content, 'base64').toString('utf8');
  assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2) + '\n', '2-space indent + trailing newline');
  assert.deepStrictEqual(JSON.parse(text), { version: 1, stages: {
    '684': { stage: 'base', at: '2026-09-26T15:00:00Z', by: 'PC' },
    '699': { stage: 'prep', at: '2026-09-26T15:00:01Z', by: 'PC' },
    '701': { stage: 'poured', at: '2026-09-26T15:00:02Z', by: 'PC' } } });
  const put = puts(srv)[0];
  assert.strictEqual(put.url, API);
  assert.strictEqual(put.headers.authorization, 'Bearer ' + KEY);
  assert.strictEqual(put.cache, 'no-store');

  const d = track(store.set(684, 'prep', { label: 'SW Corner Ellice & Kennedy' }));
  await clock.advance(3000);
  assert.deepStrictEqual(d.value, { status: 'saved' });
  assert.strictEqual(srv.commits[1].message, 'stage: #684 SW Corner Ellice & Kennedy -> prep');
  assert.strictEqual(JSON.parse(puts(srv)[1].body).sha, 'sha-2', 'uses the sha returned by the previous PUT');
  assert.strictEqual(gets(srv).length, 1, 'no extra GET between consecutive saves');
});

test('"ready" deletes the entry; unknown keys count as ready; no-op set makes no commit', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '684': entry('base'), '699': entry('prep'), '700': entry('poured') } });
  await store.load();
  const same = await store.set(700, 'poured');
  assert.deepStrictEqual(same, { status: 'saved' });
  const a = track(store.set(684, 'ready'));
  const b = track(store.set(699, 'not-a-stage'));
  await clock.advance(3000);
  assert.strictEqual(a.state, 'resolved');
  assert.strictEqual(b.state, 'resolved');
  assert.strictEqual(puts(srv).length, 1);
  assert.strictEqual(srv.commits[0].message, 'stages: #684 -> ready, #699 -> ready');
  assert.deepStrictEqual(Object.keys(srv.stages()), ['700']);
  assert.deepStrictEqual(Object.keys(await store.load()), ['700']);
});

test('409 -> re-GET, re-apply this device\'s change on top, retry succeeds', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '500': entry('base') } });
  await store.load();
  let first = true;
  srv.hook = (req) => {
    if (req.method === 'PUT' && first) { // another device commits first -> our sha is stale -> 409
      first = false;
      srv.commitFile(docText({ '500': entry('base'), '800': entry('poured', '2026-09-26T14:59:00Z', 'iPhone app') }), 'other device');
    }
  };
  const changes = [];
  store.onChange((m) => changes.push(m));
  const p = track(store.set(684, 'excavation'));
  await clock.advance(5000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  assert.strictEqual(puts(srv).length, 2);
  assert.deepStrictEqual(Object.keys(srv.stages()).sort(), ['500', '684', '800']);
  assert.strictEqual(srv.stages()['684'].stage, 'excavation');
  assert.strictEqual(JSON.parse(puts(srv)[1].body).sha, 'sha-2');
  assert.ok(changes.length >= 1 && changes[changes.length - 1]['800'], 'onChange reports the other device\'s change');
});

test('409 on the same job: this device\'s pending change wins (last write)', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '684': entry('base') } });
  await store.load();
  let first = true;
  srv.hook = (req) => {
    if (req.method === 'PUT' && first) { first = false; srv.commitFile(docText({ '684': entry('prep', 'x', 'iPhone app') }), 'other'); }
  };
  const p = track(store.set(684, 'poured'));
  await clock.advance(5000);
  assert.strictEqual(p.state, 'resolved');
  assert.strictEqual(srv.stages()['684'].stage, 'poured');
});

test('422 -> re-GET and retry succeeds', async () => {
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  let n = 0;
  srv.hook = (req) => (req.method === 'PUT' && n++ === 0 ? srv.resp(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }) : undefined);
  const p = track(store.set(684, 'base'));
  await clock.advance(5000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  assert.strictEqual(puts(srv).length, 2);
  const seq = srv.requests.map((r) => r.method);
  assert.deepStrictEqual(seq, ['GET', 'PUT', 'GET', 'PUT']);
  assert.strictEqual(srv.stages()['684'].stage, 'base');
});

test('3 conflicts in a row -> reject code "conflict", nothing kept, lastError set', async () => {
  const { store, srv, clock, storage } = setup({ key: true });
  await store.load();
  srv.hook = (req) => (req.method === 'PUT' ? srv.resp(409, { message: 'does not match' }) : undefined);
  const p = track(store.set(684, 'base'));
  await clock.advance(10000);
  assert.strictEqual(p.state, 'rejected');
  assert.strictEqual(p.error.code, 'conflict');
  assert.strictEqual(puts(srv).length, 3);
  assert.strictEqual(queueOf(storage), null);
  assert.strictEqual(store.status().pending, 0);
  assert.ok(store.lastError && /another device/.test(store.lastError));
  srv.hook = null;
  assert.deepStrictEqual(await store.load(), {});
  assert.strictEqual(store.mode, 'github', 'a conflict does not invalidate the key');
});

test('401/403 on save -> reject "auth", mode invalid, writable false, lastError', async () => {
  for (const status of [401, 403]) {
    const { store, srv, clock } = setup({ key: true });
    await store.load();
    const statuses = [];
    store.onStatus((s) => statuses.push(s));
    srv.hook = (req) => (req.method === 'PUT' ? srv.resp(status, { message: status === 401 ? 'Bad credentials' : 'Resource not accessible by personal access token' }) : undefined);
    const p = track(store.set(684, 'base'));
    await clock.advance(5000);
    assert.strictEqual(p.state, 'rejected', String(status));
    assert.strictEqual(p.error.code, 'auth');
    assert.strictEqual(puts(srv).length, 1, 'auth errors are not retried');
    assert.strictEqual(store.mode, 'invalid');
    assert.strictEqual(store.writable, false);
    assert.strictEqual(store.lastError, AUTH_MSG);
    assert.ok(statuses.some((s) => s.mode === 'invalid' && s.writable === false && s.lastError === AUTH_MSG));
    const before = srv.requests.length;
    await assert.rejects(store.set(699, 'prep'), (e) => e.code === 'auth');
    assert.strictEqual(srv.requests.length, before);
  }
});

test('403 caused by a rate limit is an "http" error, not a rejected key', async () => {
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  srv.hook = (req) => (req.method === 'PUT' ? srv.resp(403, { message: 'API rate limit exceeded' }, { 'X-RateLimit-Remaining': '0' }) : undefined);
  const p = track(store.set(684, 'base'));
  await clock.advance(5000);
  assert.strictEqual(p.error.code, 'http');
  assert.strictEqual(store.mode, 'github');
});

test('5xx is retried (re-GET) and then rejects "http"; a single 5xx recovers', async () => {
  const s = setup({ key: true });
  await s.store.load();
  s.srv.hook = (req) => (req.method === 'PUT' ? s.srv.resp(502, 'Bad Gateway') : undefined);
  const p = track(s.store.set(684, 'base'));
  await s.clock.advance(10000);
  assert.strictEqual(p.error.code, 'http');
  assert.strictEqual(puts(s.srv).length, 3);

  const t = setup({ key: true });
  await t.store.load();
  let n = 0;
  t.srv.hook = (req) => (req.method === 'PUT' && n++ === 0 ? t.srv.resp(500, 'oops') : undefined);
  const q = track(t.store.set(684, 'base'));
  await t.clock.advance(10000);
  assert.deepStrictEqual(q.value, { status: 'saved' });
});

test('network failure -> {status:"queued"}, persisted in ej_stage_queue, replayed on "online"', async () => {
  const { store, srv, clock, storage, window } = setup({ key: true });
  await store.load();
  store.start();
  srv.offline = true;
  const p = track(store.set(684, 'base', { label: 'Main St' }));
  await clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued' });
  const q = queueOf(storage);
  assert.strictEqual(q.changes['684'].stage, 'base');
  assert.strictEqual(q.changes['684'].label, 'Main St');
  assert.strictEqual(store.status().pending, 1);
  assert.ok(/Offline/.test(store.lastError));
  const offlineMap = await store.load(); // never rejects offline; keeps the queued change in view
  assert.strictEqual(offlineMap['684'].stage, 'base');
  assert.strictEqual(srv.commits.length, 0);

  srv.offline = false;
  window.dispatch('online');
  await clock.advance(10);
  assert.strictEqual(srv.commits.length, 1);
  assert.strictEqual(srv.commits[0].message, 'stage: #684 Main St -> base');
  assert.strictEqual(queueOf(storage), null);
  assert.strictEqual(store.status().pending, 0);
  assert.strictEqual(store.lastError, null);
  store.stop();
});

test('queued changes also replay on visibilitychange -> visible and on the next poll', async () => {
  const a = setup({ key: true });
  await a.store.load();
  a.store.start();
  a.srv.offline = true;
  track(a.store.set(684, 'base'));
  await a.clock.advance(3000);
  a.srv.offline = false;
  a.document.visibilityState = 'hidden'; a.document.dispatch('visibilitychange');
  await a.clock.advance(10);
  assert.strictEqual(a.srv.commits.length, 0);
  a.document.visibilityState = 'visible'; a.document.dispatch('visibilitychange');
  await a.clock.advance(10);
  assert.strictEqual(a.srv.commits.length, 1);
  a.store.stop();

  const b = setup({ key: true });
  await b.store.load();
  b.store.start();
  b.srv.offline = true;
  track(b.store.set(699, 'prep'));
  await b.clock.advance(3000);
  b.srv.offline = false;
  await b.clock.advance(56999); // the poll timer was armed by start() at t=0 -> fires at t=60000
  assert.strictEqual(b.srv.commits.length, 0);
  await b.clock.advance(1); // 60 s poll -> replay
  assert.strictEqual(b.srv.commits.length, 1);
  assert.strictEqual(b.srv.stages()['699'].stage, 'prep');
  b.store.stop();
});

test('rollback path: a replay that finally fails is dropped, the truth is reloaded and onChange fires', async () => {
  const { store, srv, clock, storage, window } = setup({ key: true, stages: { '684': entry('excavation') } });
  await store.load();
  store.start();
  srv.offline = true;
  track(store.set(684, 'base'));
  await clock.advance(3000);
  const changes = [];
  store.onChange((m) => changes.push(m));
  srv.offline = false;
  srv.hook = (req) => (req.method === 'PUT' ? srv.resp(409, { message: 'does not match' }) : undefined);
  const putsBefore = puts(srv).length; // includes the PUT attempt that failed offline
  window.dispatch('online');
  await clock.advance(10000);
  assert.strictEqual(puts(srv).length - putsBefore, 3);
  assert.strictEqual(queueOf(storage), null);
  assert.strictEqual(store.status().pending, 0);
  assert.ok(/another device/.test(store.lastError));
  assert.ok(changes.length >= 1);
  assert.strictEqual(changes[changes.length - 1]['684'].stage, 'excavation', 'UI told the truth');
  store.stop();
});

test('rollback path: rejected sets roll back in the UI and onChange then restores the truth', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '684': entry('excavation') } });
  let ui = await store.load();
  let onChangeCalls = 0;
  store.onChange((m) => { ui = m; onChangeCalls++; });
  srv.hook = (req) => (req.method === 'PUT' ? srv.resp(409, { message: 'does not match' }) : undefined);
  const errors = [];
  function move(jn, key) { // what the UI does: optimistic apply, roll back to prev on rejection
    const prev = ui[jn] ? ui[jn].stage : 'ready';
    ui = Object.assign({}, ui, { [jn]: { stage: key } });
    return store.set(jn, key).catch((e) => {
      errors.push(e.code);
      ui = Object.assign({}, ui);
      if (prev === 'ready') delete ui[jn]; else ui[jn] = { stage: prev };
    });
  }
  move('684', 'base');
  move('684', 'prep'); // same batch; its "prev" is the optimistic base
  await clock.advance(10000);
  assert.deepStrictEqual(errors, ['conflict', 'conflict']);
  assert.strictEqual(ui['684'].stage, 'excavation');
  assert.ok(onChangeCalls >= 1);
});

test('setKey: 200 saves + persist() + github mode + notifies; 401/404/network/empty do not save', async () => {
  const s = setup({ stages: { '684': entry('base') } });
  assert.strictEqual(s.store.mode, 'readonly');
  const changes = [], statuses = [];
  s.store.onChange((m) => changes.push(m));
  s.store.onStatus((st) => statuses.push(st));
  const r = await s.store.setKey('  ' + KEY + '\n');
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(s.storage.getItem('ej_gh_token'), KEY, 'trimmed key saved');
  assert.strictEqual(s.persistCalls.length, 1, 'navigator.storage.persist() called');
  assert.strictEqual(s.store.mode, 'github');
  assert.strictEqual(s.store.writable, true);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]['684'].stage, 'base');
  assert.ok(statuses.some((x) => x.mode === 'github' && x.writable));
  const v = s.srv.requests[0];
  assert.strictEqual(v.url, API);
  assert.strictEqual(v.method, 'GET');
  assert.strictEqual(v.headers.authorization, 'Bearer ' + KEY);

  const bad = 'github_pat_WRONG_0123456789abcdef';
  const s2 = setup({});
  const r2 = await s2.store.setKey(bad);
  assert.strictEqual(r2.ok, false);
  assert.ok(typeof r2.reason === 'string' && r2.reason.length > 0);
  assert.ok(!r2.reason.includes(bad) && !r2.reason.includes('WRONG'));
  assert.strictEqual(s2.storage.getItem('ej_gh_token'), null);
  assert.strictEqual(s2.store.mode, 'readonly');

  const s3 = setup({ srvOpts: { exists: false } });
  const r3 = await s3.store.setKey(KEY);
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(s3.storage.getItem('ej_gh_token'), null);

  const s4 = setup({});
  s4.srv.offline = true;
  const r4 = await s4.store.setKey(KEY);
  assert.strictEqual(r4.ok, false);
  assert.strictEqual(s4.storage.getItem('ej_gh_token'), null);
  assert.strictEqual((await s4.store.setKey('   ')).ok, false);
  assert.strictEqual((await s4.store.setKey('bad key with spaces é')).ok, false);
});

test('setKey replays changes queued before the key was saved; storage that throws is reported', async () => {
  const s = setup({ ls: { ej_stage_queue: JSON.stringify({ version: 1, changes: { '684': { stage: 'poured', at: 'a', by: 'PC', label: '' } } }) } });
  const r = await s.store.setKey(KEY);
  assert.strictEqual(r.ok, true);
  await s.clock.advance(10);
  assert.strictEqual(s.srv.stages()['684'].stage, 'poured');

  const t = setup({ storageOpts: { throwAll: true } });
  assert.strictEqual(t.store.mode, 'readonly');
  assert.deepStrictEqual(await t.store.load(), {});
  const r2 = await t.store.setKey(KEY);
  assert.strictEqual(r2.ok, false);
  assert.ok(/storage/i.test(r2.reason));
  const u = setup({ hostname: 'localhost', storageOpts: { throwSet: true } });
  await assert.rejects(u.store.set(684, 'base'), (e) => e.code === 'http');
});

test('removeKey: forgets the key, falls back to readonly (live) or local (localhost)', async () => {
  const s = setup({ key: true });
  await s.store.load();
  assert.strictEqual(s.store.getKeyForShare(), KEY);
  const statuses = [];
  s.store.onStatus((x) => statuses.push(x));
  await s.store.removeKey();
  assert.strictEqual(s.storage.getItem('ej_gh_token'), null);
  assert.strictEqual(s.store.mode, 'readonly');
  assert.strictEqual(s.store.writable, false);
  assert.strictEqual(s.store.hasKey(), false);
  assert.strictEqual(s.store.getKeyForShare(), null);
  assert.ok(statuses.some((x) => x.mode === 'readonly'));
  const last = s.srv.requests[s.srv.requests.length - 1];
  assert.ok(last.url.startsWith(RAW) && !('authorization' in last.headers));

  const l = setup({ key: true, hostname: 'localhost' });
  l.store.removeKey();
  assert.strictEqual(l.store.mode, 'local');

  const b = setup({ key: true });
  await b.store.load();
  const p = track(b.store.set(684, 'base'));
  await b.store.removeKey();
  await b.clock.advance(10);
  assert.strictEqual(p.state, 'rejected');
  assert.strictEqual(p.error.code, 'readonly');
  assert.strictEqual(puts(b.srv).length, 0);
});

test('UTF-8 round-trip: "Gérard" in device label, commit message and file content', async () => {
  const s = setup({ key: true });
  await s.store.load();
  assert.strictEqual(s.store.setDeviceLabel('Gérard’s iPhone 🚧'), 'Gérard’s iPhone 🚧');
  track(s.store.set(684, 'base', { label: 'Rue Désautels & Ste-Anne' }));
  await s.clock.advance(3000);
  const body = JSON.parse(puts(s.srv)[0].body);
  const decoded = Buffer.from(body.content, 'base64').toString('utf8');
  assert.ok(decoded.includes('"by": "Gérard’s iPhone 🚧"'));
  assert.strictEqual(s.srv.commits[0].message, 'stage: #684 Rue Désautels & Ste-Anne -> base');
  const viaApi = await setup({ key: true, srv: s.srv }).store.load();
  assert.strictEqual(viaApi['684'].by, 'Gérard’s iPhone 🚧');
  const viaRaw = await setup({ srv: s.srv }).store.load();
  assert.strictEqual(viaRaw['684'].by, 'Gérard’s iPhone 🚧');
  const U = Stages._util;
  const sample = 'Gérard ✓ 🚧 — Kennedy';
  assert.strictEqual(U.b64decodeUtf8(U.b64encodeUtf8(sample)), sample);
  assert.strictEqual(U.b64encodeUtf8(sample), Buffer.from(sample, 'utf8').toString('base64'));
  assert.strictEqual(U.b64decodeUtf8(b64lines(sample)), sample, 'GitHub-style line-wrapped base64');
});

test('robust to missing / empty / malformed stages.json and odd entries; jobNumber number or string', async () => {
  for (const text of ['', 'not json', '[]', 'null', '{"version":1}', '{"stages":null}', '{"stages":[1,2]}', '\ufeff{"version":1,"stages":{}}']) {
    assert.deepStrictEqual(await setup({ srvOpts: { text } }).store.load(), {}, JSON.stringify(text));
    assert.deepStrictEqual(await setup({ key: true, srvOpts: { text } }).store.load(), {}, JSON.stringify(text));
  }
  const odd = JSON.stringify({ version: 1, note: 'keep me', stages: {
    '684': { stage: 'base', at: 'a', by: 'b' }, '699': 'prep', '700': { stage: 'bogus' }, '701': { stage: 'ready' },
    '__proto__': { stage: 'base' }, 'bad key!': { stage: 'base' }, '702': null, '703': { stage: 'Poured', at: 5 } } });
  const s = setup({ key: true, srvOpts: { text: odd } });
  const map = await s.store.load();
  assert.deepStrictEqual(map, {
    '684': { stage: 'base', at: 'a', by: 'b' },
    '699': { stage: 'prep', at: '', by: '' },
    '703': { stage: 'poured', at: '', by: '' } });
  assert.strictEqual(({}).stage, undefined, 'no prototype pollution');
  track(s.store.set(705, 'base'));
  track(s.store.set('705', 'inspected'));
  await s.clock.advance(3000);
  const written = JSON.parse(s.srv.text);
  assert.strictEqual(written.note, 'keep me', 'unknown top-level fields are preserved');
  assert.strictEqual(written.stages['705'].stage, 'inspected');
  assert.deepStrictEqual(Object.keys(written.stages), ['684', '699', '703', '705']);
  assert.strictEqual(s.srv.commits[0].message, 'stage: #705 -> inspected');

  const m = setup({ key: true, srvOpts: { exists: false } }); // file missing: empty, first save creates it
  assert.deepStrictEqual(await m.store.load(), {});
  track(m.store.set(684, 'base'));
  await m.clock.advance(3000);
  assert.ok(!('sha' in JSON.parse(puts(m.srv)[0].body)), 'create = PUT without sha');
  assert.strictEqual(m.srv.stages()['684'].stage, 'base');
  assert.deepStrictEqual(await setup({ srvOpts: { exists: false } }).store.load(), {});
  await assert.rejects(m.store.set(null, 'base'), (e) => e.code === 'http');
});

test('a damaged stages.json (hand-edit typo) is never overwritten: saves reject, lastError explains', async () => {
  for (const text of ['not json', '[]', 'null', '{"version":1}', '{"stages":[1,2]}', '{"version":1,"stages":{"684":{"stage":"base"}']) {
    const s = setup({ key: true, srvOpts: { text } });
    assert.deepStrictEqual(await s.store.load(), {}, 'load never rejects: ' + JSON.stringify(text));
    assert.ok(/damaged/.test(s.store.lastError || ''), 'lastError says damaged: ' + JSON.stringify(text));
    const p = s.store.set(684, 'base', { label: 'X' });
    p.catch(() => {});
    await s.clock.advance(3000);
    await assert.rejects(p, (e) => e.code === 'http' && /damaged/.test(e.message), JSON.stringify(text));
    assert.strictEqual(puts(s.srv).length, 0, 'no PUT over a damaged file: ' + JSON.stringify(text));
    assert.strictEqual(s.srv.text, text, 'file untouched');
    const r = setup({ srvOpts: { text } });
    await r.store.load();
    assert.ok(/damaged/.test(r.store.lastError || ''), 'read-only lastError: ' + JSON.stringify(text));
  }
});

test('a stages.json written by a newer app version (version > 1) is read but never overwritten', async () => {
  const text = JSON.stringify({ version: 2, stages: { '684': { stage: 'base', at: 'a', by: 'b', asphalt: 'req' } } }, null, 2) + '\n';
  const s = setup({ key: true, srvOpts: { text } });
  const map = await s.store.load();
  assert.strictEqual(map['684'].stage, 'base', 'stages still display');
  const p = s.store.set(699, 'prep', { label: 'X' });
  p.catch(() => {});
  await s.clock.advance(3000);
  await assert.rejects(p, (e) => e.code === 'http' && /newer version/.test(e.message));
  assert.strictEqual(puts(s.srv).length, 0, 'no PUT over a newer-format file');
  assert.strictEqual(s.srv.text, text, 'file untouched (v2 fields kept)');
});

test('polling: 60 s with a key while visible, paused when hidden, immediate on visible, 300 s read-only, clean stop()', async () => {
  const s = setup({ key: true });
  await s.store.load();
  s.srv.requests.length = 0;
  s.store.start();
  await s.clock.advance(59999);
  assert.strictEqual(gets(s.srv).length, 0);
  await s.clock.advance(1);
  assert.strictEqual(gets(s.srv).length, 1);
  s.document.visibilityState = 'hidden'; s.document.dispatch('visibilitychange');
  await s.clock.advance(180000);
  assert.strictEqual(gets(s.srv).length, 1, 'no polling while hidden');
  s.document.visibilityState = 'visible'; s.document.dispatch('visibilitychange');
  await s.clock.advance(1);
  assert.strictEqual(gets(s.srv).length, 2, 'immediate refresh on visible');
  s.window.dispatch('online');
  await s.clock.advance(1);
  assert.strictEqual(gets(s.srv).length, 3, 'immediate refresh on online');
  s.store.stop();
  assert.strictEqual(s.document.count('visibilitychange'), 0);
  assert.strictEqual(s.window.count('online'), 0);
  assert.strictEqual(s.clock.pending(), 0, 'no timers left after stop()');
  await s.clock.advance(600000);
  assert.strictEqual(gets(s.srv).length, 3);

  const r = setup({});
  await r.store.load();
  r.srv.requests.length = 0;
  r.store.start();
  await r.clock.advance(299999);
  assert.strictEqual(gets(r.srv).length, 0);
  await r.clock.advance(1);
  assert.strictEqual(gets(r.srv).length, 1);
  assert.ok(gets(r.srv)[0].url.startsWith(RAW));
  r.store.stop();
  assert.strictEqual(r.clock.pending(), 0);
});

test('onChange fires when another device changes stages (poll), not when nothing changed', async () => {
  const s = setup({ key: true });
  await s.store.load();
  s.store.start();
  const changes = [];
  s.store.onChange((m) => changes.push(m));
  await s.clock.advance(60000);
  assert.strictEqual(changes.length, 0);
  s.srv.commitFile(docText({ '900': entry('prep') }), 'other device');
  await s.clock.advance(60000);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]['900'].stage, 'prep');
  await s.clock.advance(60000);
  assert.strictEqual(changes.length, 1);
  s.store.stop();
});

test('going to the background saves the open batch at once; stop() never drops it', async () => {
  const s = setup({ key: true });
  await s.store.load();
  s.store.start();
  const p = track(s.store.set(684, 'base'));
  s.document.visibilityState = 'hidden'; s.document.dispatch('visibilitychange');
  await s.clock.advance(1);
  assert.strictEqual(puts(s.srv).length, 1);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  const q = track(s.store.set(699, 'prep'));
  s.store.stop();
  await s.clock.advance(1);
  assert.deepStrictEqual(q.value, { status: 'saved' });
  assert.strictEqual(s.clock.pending(), 0);
});

test('write-ahead: a change survives the app closing inside the 3 s window', async () => {
  const s = setup({ key: true });
  await s.store.load();
  track(s.store.set(684, 'base', { label: 'Main St' })); // app killed before the batch timer fires
  assert.strictEqual(queueOf(s.storage).changes['684'].stage, 'base');
  const s2 = setup({ key: true, srv: s.srv, storage: s.storage });
  const map = await s2.store.load();
  assert.strictEqual(map['684'].stage, 'base');
  await s2.clock.advance(10);
  assert.strictEqual(s.srv.commits.length, 1);
  assert.strictEqual(s.srv.commits[0].message, 'stage: #684 Main St -> base');
  assert.strictEqual(queueOf(s.storage), null);
});

test('replaying a change GitHub already has makes no commit', async () => {
  const q = { version: 1, changes: { '684': { stage: 'base', at: '2026-09-25T10:00:00Z', by: 'iPhone app', label: '' } } };
  const s = setup({ key: true, stages: { '684': entry('base') }, ls: { ej_stage_queue: JSON.stringify(q) } });
  await s.store.load();
  await s.clock.advance(10);
  assert.strictEqual(puts(s.srv).length, 0);
  assert.strictEqual(queueOf(s.storage), null);
});

test('read-only view applies queued changes on top of the remote map', async () => {
  const q = { version: 1, changes: { '684': { stage: 'poured', at: 'a', by: 'PC', label: '' }, '699': { stage: 'ready', at: 'a', by: 'PC', label: '' } } };
  const s = setup({ stages: { '699': entry('base') }, ls: { ej_stage_queue: JSON.stringify(q) } });
  const map = await s.store.load();
  assert.strictEqual(map['684'].stage, 'poured');
  assert.ok(!('699' in map));
  assert.strictEqual(s.store.status().pending, 2);
  assert.strictEqual(puts(s.srv).length, 0);
});

test('device label: default iPhone app / PC / browser, override via ej_device', async () => {
  assert.strictEqual(setup({ navigator: { standalone: true, userAgent: 'iPhone' } }).store.deviceLabel(), 'iPhone app');
  assert.strictEqual(setup({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' } }).store.deviceLabel(), 'PC');
  assert.strictEqual(setup({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)' } }).store.deviceLabel(), 'browser');
  const s = setup({});
  assert.strictEqual(s.store.setDeviceLabel('  Joshua \n  phone '), 'Joshua phone');
  assert.strictEqual(s.storage.getItem('ej_device'), 'Joshua phone');
  assert.strictEqual(s.store.setDeviceLabel(''), 'PC');
  assert.strictEqual(s.storage.getItem('ej_device'), null);
});

test('set() before any load() reads the remote first and never skips a real change', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '684': entry('base') } });
  const p = track(store.set(684, 'ready'));
  await clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  assert.deepStrictEqual(srv.requests.map((r) => r.method), ['GET', 'PUT']);
  assert.ok(!('684' in srv.stages()));
});

test('works as a plain browser <script>: global Stages, browser globals as defaults', async () => {
  const vm = require('vm');
  const clock = makeClock();
  const srv = makeServer({ '684': entry('base') });
  const win = makeTarget();
  const ctx = Object.assign(win, {
    fetch: srv.fetch, localStorage: makeStorage({ ej_gh_token: KEY }), location: { hostname: LIVE_HOST },
    document: makeTarget({ visibilityState: 'visible' }), navigator: { userAgent: 'Mozilla/5.0 (iPhone)', standalone: true },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, TextEncoder, TextDecoder, btoa, atob, AbortController
  });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'stages.js' });
  assert.strictEqual(typeof ctx.Stages, 'object');
  assert.strictEqual(ctx.Stages.STAGES.length, 6);
  const store = ctx.Stages.createStore();
  assert.strictEqual(store.mode, 'github');
  const map = await store.load();
  assert.strictEqual(map['684'].stage, 'base');
  assert.strictEqual(store.deviceLabel(), 'iPhone app');
  track(store.set(699, 'prep'));
  await clock.advance(3000);
  assert.strictEqual(srv.stages()['699'].by, 'iPhone app');
  store.start();
  assert.strictEqual(win.count('online'), 1);
  assert.strictEqual(win.count('pagehide'), 1);
  assert.strictEqual(ctx.document.count('visibilitychange'), 1);
  store.stop();
  assert.strictEqual(win.count('online'), 0);
  const local = vm.createContext({ location: { hostname: 'localhost' }, localStorage: makeStorage({}), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), local);
  assert.strictEqual(local.Stages.createStore().mode, 'local');
});

test('offline cold start shows the cached last good stages (read-only and with a key); peek() is synchronous', async () => {
  for (const withKey of [false, true]) {
    const storage = makeStorage(withKey ? { ej_gh_token: KEY } : {});
    const a = setup({ storage, stages: { '694': entry('base'), '699': entry('prep') } });
    assert.deepStrictEqual(a.store.peek(), {}, 'nothing cached yet');
    await a.store.load();
    const cache = JSON.parse(storage.getItem('ej_stages_cache'));
    assert.strictEqual(cache.map['694'].stage, 'base');
    assert.strictEqual(cache.at, T0);
    assert.ok(!JSON.stringify(cache).includes('github_pat_'), 'the key is never cached');
    // next launch, no signal
    const b = setup({ storage });
    b.srv.offline = true;
    assert.strictEqual(b.store.peek()['699'].stage, 'prep', 'peek() shows the cache before load()');
    const map = await b.store.load();
    assert.deepStrictEqual(Object.keys(map).sort(), ['694', '699'], withKey ? 'github' : 'readonly');
    assert.strictEqual(b.store.status().lastSync, T0, 'status shows when the cached stages were synced');
    assert.strictEqual(b.store.lastError, 'Offline — showing the last known stages');
  }
  const c = setup(); c.srv.offline = true;           // never synced on this device: say so
  assert.deepStrictEqual(await c.store.load(), {});
  assert.ok(/not loaded yet/.test(c.store.lastError));
  const cachedLocal = makeStorage({ ej_stages_cache: JSON.stringify({ version: 1, at: T0, map: { '1': entry('base') } }) });
  const l = setup({ storage: cachedLocal, hostname: 'localhost' });
  assert.deepStrictEqual(await l.store.load(), {}, 'local mode never uses the remote cache');
  const bad = setup({ storage: makeStorage({ ej_stages_cache: '{"map":[1]}' }) }); bad.srv.offline = true;
  assert.deepStrictEqual(await bad.store.load(), {}, 'a malformed cache is ignored');
});

test('cached stages do not enable the no-op shortcut: set() reads the server first', async () => {
  const storage = makeStorage({ ej_gh_token: KEY, ej_stages_cache: JSON.stringify({ version: 1, at: T0, map: { '684': entry('base') } }) });
  const { store, srv, clock } = setup({ storage, stages: {} });  // the server says 684 is ready
  const p = track(store.set(684, 'base'));
  await clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  assert.strictEqual(srv.stages()['684'].stage, 'base', 'the move was saved, not skipped');
});

test('PUT 404 (key can read but not write) -> "auth", mode invalid, message names the missing permission', async () => {
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  srv.hook = (req) => (req.method === 'PUT' ? srv.resp(404, { message: 'Not Found' }) : undefined);
  const p = track(store.set(684, 'base'));
  await clock.advance(5000);
  assert.strictEqual(p.error.code, 'auth');
  assert.strictEqual(puts(srv).length, 1);
  assert.strictEqual(store.mode, 'invalid');
  assert.ok(/read but not write/.test(store.lastError) && /Read and write/.test(store.lastError));
});

test('remote at/by are one line, bounded and free of bidi overrides', async () => {
  const by = '<img src=x onerror=alert(1)>' + 'A'.repeat(3000) + '‮gnp.exe⁦x‏';
  const { store } = setup({ stages: { '684': { stage: '  POURED ', at: '2026-09-25T10:00:00Z\n' + 'Z'.repeat(99), by } } });
  const e = (await store.load())['684'];
  assert.strictEqual(e.stage, 'poured');
  assert.ok(e.by.length <= 40 && e.at.length <= 40);
  assert.ok(!/[‪-‮⁦-⁩‎‏\n]/.test(e.by + e.at));
});

test('key hygiene: never in a URL, a body, a status, lastError or the console; only api.github.com receives it', async () => {
  // Exercise the error paths once more with status capture.
  const s = setup({ key: true });
  const seen = [];
  s.store.onStatus((x) => seen.push(JSON.stringify(x)));
  s.store.onChange((m) => seen.push(JSON.stringify(m)));
  await s.store.load();
  s.srv.hook = (req) => (req.method === 'PUT' ? s.srv.resp(401, { message: 'Bad credentials' }) : undefined);
  const p = track(s.store.set(684, 'base'));
  await s.clock.advance(5000);
  seen.push(String(p.error && p.error.message), String(s.store.lastError), JSON.stringify(s.store.status()));
  seen.forEach((t) => assert.ok(!t.includes('github_pat_'), 'status/change/error text contains the key'));

  assert.ok(ALL_REQUESTS.length > 50, 'hygiene check ran over the whole suite');
  for (const r of ALL_REQUESTS) {
    const u = new URL(r.url);
    assert.ok(!r.url.includes('github_pat_'), 'key in URL: ' + u.origin + u.pathname);
    const keyHeader = Object.keys(r.headers).some((h) => String(r.headers[h]).includes('github_pat_'));
    if (keyHeader) assert.strictEqual(u.origin, 'https://api.github.com');
    if (r.body) assert.ok(!String(r.body).includes('github_pat_'), 'key in a request body');
    if (u.origin !== 'https://api.github.com') assert.ok(!('authorization' in r.headers));
    assert.ok(['https://api.github.com', 'https://raw.githubusercontent.com'].includes(u.origin), 'unexpected host ' + u.origin);
  }
  assert.ok(!CONSOLE_OUT.some((l) => l.includes('github_pat_')), 'key printed to the console');
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/console\s*\./.test(src), 'stages.js must not log');
  assert.ok(!/Math\.random/.test(src));
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
