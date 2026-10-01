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
  // R-1-era tests model the main app on a v1-format file: they opt in to the v1 -> v2 upgrade (allowUpgrade), which
  // the real app never does (see 'fail closed: never upgrades an existing v1 file').
  const store = Stages.createStore({ fetch: srv.fetch, storage, now: clock.now, hostname: o.hostname !== undefined ? o.hostname : LIVE_HOST,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, document, window, navigator, allowUpgrade: o.allowUpgrade !== false });
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

test('STAGES, stageIndex and normalize match the contract (v2: setup at index 1)', async () => {
  assert.deepStrictEqual(Stages.STAGES, [
    { key: 'ready', label: 'Ready to start', short: 'Ready' },
    { key: 'setup', label: 'Setup', short: 'Setup' },
    { key: 'excavation', label: 'Excavation', short: 'Excav.' },
    { key: 'base', label: 'Base', short: 'Base' },
    { key: 'prep', label: 'Prep', short: 'Prep' },
    { key: 'inspected', label: 'Passed inspection', short: 'Passed' },
    { key: 'poured', label: 'Poured', short: 'Poured' }
  ]);
  ['ready', 'setup', 'excavation', 'base', 'prep', 'inspected', 'poured'].forEach((k, i) => assert.strictEqual(Stages.stageIndex(k), i));
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
  assert.deepStrictEqual(saved, { version: 2, stages: { '684': { stage: 'base', at: '2026-09-26T15:00:00Z', by: 'PC' } } });
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
  assert.strictEqual(srv.commits[0].message, 'jobs: #684 stage -> base; #699 stage -> prep; #701 stage -> poured');
  const body = JSON.parse(puts(srv)[0].body);
  assert.strictEqual(body.branch, 'main');
  assert.strictEqual(body.sha, 'sha-1');
  assert.strictEqual(body.message, srv.commits[0].message);
  const text = Buffer.from(body.content, 'base64').toString('utf8');
  assert.strictEqual(text, JSON.stringify(JSON.parse(text), null, 2) + '\n', '2-space indent + trailing newline');
  assert.deepStrictEqual(JSON.parse(text), { version: 2, stages: {
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
  assert.strictEqual(srv.commits[1].message, 'job #684 SW Corner Ellice & Kennedy: stage -> prep');
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
  assert.strictEqual(srv.commits[0].message, 'jobs: #684 stage -> ready; #699 stage -> ready');
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
  assert.strictEqual(q.version, 2);
  assert.deepStrictEqual(q.changes['684'].fields, { stage: 'base' });
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
  assert.strictEqual(srv.commits[0].message, 'job #684 Main St: stage -> base');
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
  assert.strictEqual(s.srv.commits[0].message, 'job #684 Rue Désautels & Ste-Anne: stage -> base');
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
  assert.strictEqual(s.srv.commits[0].message, 'job #705: stage -> inspected');

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

test('a stages.json written by a newer app version (version > 2) is read but never overwritten (the change waits)', async () => {
  const text = JSON.stringify({ version: 3, stages: { '684': { stage: 'base', at: 'a', by: 'b', asphalt: 'req', tarp: 'x' } } }, null, 2) + '\n';
  const s = setup({ key: true, srvOpts: { text } });
  const map = await s.store.load();
  assert.strictEqual(map['684'].stage, 'base', 'stages still display');
  const p = track(s.store.set(699, 'prep', { label: 'X' }));
  await s.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued', reason: 'format' }, 'kept on this device, never dropped');
  assert.strictEqual(s.store.status().pending, 1);
  assert.ok(/newer version/.test(s.store.status().lastError), s.store.status().lastError);
  assert.strictEqual(s.store.peek()['699'].stage, 'prep', 'the move stays on screen');
  await s.clock.advance(120000);   // polls replay it: still refused, still queued
  assert.strictEqual(s.store.status().pending, 1);
  assert.strictEqual(puts(s.srv).length, 0, 'no PUT over a newer-format file');
  assert.strictEqual(s.srv.text, text, 'file untouched (v3 fields kept)');
  assert.deepStrictEqual(map['684'], { stage: 'base', asphalt: 'req', at: 'a', by: 'b' }, 'known v2 fields display, unknown dropped');
  const r = setup({ srvOpts: { text } }); // read-only devices display it too
  assert.strictEqual((await r.store.load())['684'].asphalt, 'req');
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
  assert.deepStrictEqual(queueOf(s.storage).changes['684'].fields, { stage: 'base' });
  const s2 = setup({ key: true, srv: s.srv, storage: s.storage });
  const map = await s2.store.load();
  assert.strictEqual(map['684'].stage, 'base');
  await s2.clock.advance(10);
  assert.strictEqual(s.srv.commits.length, 1);
  assert.strictEqual(s.srv.commits[0].message, 'job #684 Main St: stage -> base');
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
  const srv = makeServer({}, { text: docText({ '684': entry('base') }, { version: 2 }) }); // the real app never upgrades a v1 file
  const win = makeTarget();
  const ctx = Object.assign(win, {
    fetch: srv.fetch, localStorage: makeStorage({ ej_gh_token: KEY }), location: { hostname: LIVE_HOST },
    document: makeTarget({ visibilityState: 'visible' }), navigator: { userAgent: 'Mozilla/5.0 (iPhone)', standalone: true },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, TextEncoder, TextDecoder, btoa, atob, AbortController
  });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'stages.js' });
  assert.strictEqual(typeof ctx.Stages, 'object');
  assert.strictEqual(ctx.Stages.STAGES.length, 7);
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

/* ======================================= R-2 (v2) tests ======================================= */
function docText2(stages, extra) { return JSON.stringify(Object.assign({ version: 2, stages: stages || {} }, extra || {}), null, 2) + '\n'; }
const eff = (entry, hints) => Stages.effective(entry, hints);
const DEFAULT_EFF = { stage: 'ready', assess: 'no', lane: { s: 'na' }, cut: 'na', asphalt: 'na', pavers: 'na', cleanup: 'todo', removed: false,
  name: null, loc: null };
// The shared vectors (sync_jobs.py twin) predate R-3's name / loc, which the sync ignores: the app adds them as null.
const withR3 = (e) => Object.assign({}, e, { name: null, loc: null });

test('v2: ITEMS and LISTS definitions (keys, labels, values, value labels) and they are frozen', async () => {
  const I = Stages.ITEMS;
  assert.deepStrictEqual(I.map((i) => i.key), ['assess', 'lane', 'cut', 'asphalt', 'pavers', 'cleanup']);
  assert.deepStrictEqual(I.map((i) => i.label), ['Assessed', 'Lane closure', 'Street cut', 'Asphalt', 'Pavers', 'Cuts & cleanup']);
  const byKey = {};
  I.forEach((i) => { byKey[i.key] = i; });
  assert.deepStrictEqual(byKey.assess.values, ['no', 'virtual', 'onsite']);
  assert.deepStrictEqual(byKey.assess.labels, { no: 'Not yet', virtual: 'Virtual', onsite: 'On site', prior: 'Assessed before beta' });
  assert.deepStrictEqual(byKey.lane.values, ['na', 'req', 'booked']);
  assert.deepStrictEqual(byKey.lane.labels, { na: 'N/A', req: 'Required', booked: 'Booked' });
  for (const k of ['cut', 'asphalt', 'pavers']) {
    assert.deepStrictEqual(byKey[k].values, ['na', 'req', 'done'], k);
    assert.deepStrictEqual(byKey[k].labels, { na: 'N/A', req: 'Required', done: 'Done' }, k);
  }
  assert.deepStrictEqual(byKey.cleanup.values, ['todo', 'done']);
  assert.deepStrictEqual(byKey.cleanup.labels, { todo: 'To do', done: 'Done' });
  assert.deepStrictEqual(I.map((i) => i.def), ['no', 'na', 'na', 'na', 'na', 'todo']);
  assert.strictEqual(byKey.asphalt.hint, true);
  assert.strictEqual(byKey.pavers.hint, true);
  assert.deepStrictEqual(byKey.assess.stages, ['ready', 'setup']);
  assert.deepStrictEqual(byKey.cleanup.stages, ['poured']);
  assert.strictEqual(byKey.asphalt.stages.length, 7);
  assert.deepStrictEqual(Stages.LISTS.map((l) => [l.key, l.label]), [
    ['unassessed', 'Unassessed'], ['booklane', 'Book lane'], ['streetcuts', 'Street cuts'],
    ['cleanup', 'Cuts & cleanup'], ['asphalt', 'Asphalt'], ['pavers', 'Pavers']]);
  Stages.LISTS.forEach((l) => assert.strictEqual(typeof l.predicate, 'function'));
  assert.ok(Object.isFrozen(I) && Object.isFrozen(I[0]) && Object.isFrozen(I[0].values) && Object.isFrozen(I[0].labels));
  assert.ok(Object.isFrozen(Stages.LISTS) && Object.isFrozen(Stages.LISTS[0]));
  assert.strictEqual(Stages.FILE_VERSION, 2);
});

test('v2: effective() applies defaults, hints, and a stored value (even "na") always beats the hint', async () => {
  for (const e of [undefined, null, {}, 'bogus', 42, [], { at: 'a', by: 'b' }]) assert.deepStrictEqual(eff(e), DEFAULT_EFF, JSON.stringify(e));
  assert.deepStrictEqual(eff({ stage: 'base', at: 'a', by: 'b' }), Object.assign({}, DEFAULT_EFF, { stage: 'base' }), 'v1 entry');
  assert.strictEqual(eff('prep').stage, 'prep', 'v1 shorthand string');
  // hints
  assert.strictEqual(eff({}, { asphalt: true }).asphalt, 'req');
  assert.strictEqual(eff({}, { asphalt: true }).pavers, 'na');
  assert.strictEqual(eff({}, { pavers: true }).pavers, 'req');
  assert.strictEqual(eff({}, { asphalt: false, pavers: false }).asphalt, 'na');
  assert.strictEqual(eff({}, { asphalt: 'yes', pavers: 1 }).asphalt, 'na', 'only boolean true counts');
  assert.strictEqual(eff({}, { asphalt: 'yes', pavers: 1 }).pavers, 'na');
  assert.strictEqual(eff({}, null).asphalt, 'na');
  assert.strictEqual(eff({ asphalt: 'na' }, { asphalt: true }).asphalt, 'na', 'stored na beats hint true');
  assert.strictEqual(eff({ pavers: 'na' }, { pavers: true }).pavers, 'na');
  assert.strictEqual(eff({ asphalt: 'done' }, { asphalt: true }).asphalt, 'done');
  assert.strictEqual(eff({ asphalt: 'req' }, { asphalt: false }).asphalt, 'req', 'stored req without a hint');
  assert.strictEqual(eff({ asphalt: 'yes' }, { asphalt: true }).asphalt, 'req', 'an unknown stored value is dropped -> hint');
  // full entry
  const full = { stage: 'setup', assess: 'virtual', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, cut: 'req',
    asphalt: 'req', pavers: 'na', cleanup: 'done', removed: true, at: 'a', by: 'b' };
  assert.deepStrictEqual(eff(full), { stage: 'setup', assess: 'virtual', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' },
    cut: 'req', asphalt: 'req', pavers: 'na', cleanup: 'done', removed: true, name: null, loc: null });
  const e = eff(full);
  e.lane.s = 'na';
  assert.strictEqual(full.lane.s, 'booked', 'effective() returns copies');
  // unknown values fall back to defaults
  assert.deepStrictEqual(eff({ stage: 'nope', assess: 'maybe', lane: 'req', cut: 'REQ', cleanup: 'yes', removed: 'true' }), DEFAULT_EFF);
});

test('v2: canMove gates (lane blocks >= setup, cut blocks >= excavation, backwards always allowed)', async () => {
  const LANE = { ok: false, reason: 'lane', message: 'Book the lane closure first' };
  const CUT = { ok: false, reason: 'cut', message: 'Street cut must be done first' };
  const OK = { ok: true };
  const lane = { lane: { s: 'req' } };
  assert.deepStrictEqual(Stages.canMove(lane, 'setup'), LANE);
  assert.deepStrictEqual(Stages.canMove(lane, 'excavation'), LANE);
  assert.deepStrictEqual(Stages.canMove(lane, 'poured'), LANE);
  assert.deepStrictEqual(Stages.canMove(lane, 'ready'), OK);
  assert.deepStrictEqual(Stages.canMove({ lane: { s: 'booked' } }, 'poured'), OK);
  assert.deepStrictEqual(Stages.canMove({ lane: { s: 'na' } }, 'setup'), OK);
  const cut = { cut: 'req' };
  assert.deepStrictEqual(Stages.canMove(cut, 'setup'), OK, 'street cuts can still set up');
  assert.deepStrictEqual(Stages.canMove(cut, 'excavation'), CUT);
  assert.deepStrictEqual(Stages.canMove(Object.assign({ stage: 'setup' }, cut), 'excavation'), CUT);
  assert.deepStrictEqual(Stages.canMove(Object.assign({ stage: 'setup' }, cut), 'base'), CUT);
  assert.deepStrictEqual(Stages.canMove({ stage: 'setup', cut: 'done' }, 'excavation'), OK);
  assert.deepStrictEqual(Stages.canMove({ stage: 'ready', lane: { s: 'req' }, cut: 'req' }, 'excavation'), LANE, 'lane reported first');
  assert.deepStrictEqual(Stages.canMove({ stage: 'ready', lane: { s: 'booked' }, cut: 'req' }, 'excavation'), CUT);
  // backwards / staying is always allowed, even with items still Required
  const late = { stage: 'poured', lane: { s: 'req' }, cut: 'req' };
  for (const k of ['ready', 'setup', 'excavation', 'base', 'prep', 'inspected', 'poured']) assert.deepStrictEqual(Stages.canMove(late, k), OK, k);
  // forward from a stage already beyond the gate (item set to Required later) is still gated
  assert.deepStrictEqual(Stages.canMove({ stage: 'excavation', lane: { s: 'req' } }, 'base'), LANE);
  assert.deepStrictEqual(Stages.canMove({ stage: 'base', cut: 'req' }, 'prep'), CUT);
  assert.deepStrictEqual(Stages.canMove({}, 'bogus'), OK, 'unknown target = ready');
  assert.deepStrictEqual(Stages.canMove(null, 'poured'), OK);
});

test('v2: canSetItem rules (done only at poured for asphalt/pavers/cleanup; invalid items/values)', async () => {
  const early = ['ready', 'setup', 'excavation', 'base', 'prep', 'inspected'];
  for (const item of ['asphalt', 'pavers', 'cleanup']) {
    for (const st of early) {
      const r = Stages.canSetItem({ stage: st }, item, 'done');
      assert.strictEqual(r.ok, false, item + '@' + st);
      assert.strictEqual(r.reason, 'poured');
      assert.ok(/once the job is Poured/.test(r.message), r.message);
    }
    assert.deepStrictEqual(Stages.canSetItem({ stage: 'poured' }, item, 'done'), { ok: true }, item);
  }
  assert.strictEqual(Stages.canSetItem({}, 'asphalt', 'done').message, 'Asphalt can only be marked Done once the job is Poured');
  assert.strictEqual(Stages.canSetItem({}, 'cleanup', 'done').message, 'Cuts & cleanup can only be marked Done once the job is Poured');
  for (const st of early.concat(['poured'])) {
    for (const [item, v] of [['asphalt', 'req'], ['asphalt', 'na'], ['pavers', 'req'], ['pavers', null], ['cleanup', 'todo'],
      ['assess', 'onsite'], ['lane', 'req'], ['lane', 'booked'], ['cut', 'done'], ['cut', 'req'], ['removed', true], ['removed', false]]) {
      assert.deepStrictEqual(Stages.canSetItem({ stage: st }, item, v), { ok: true }, item + '=' + v + '@' + st);
    }
  }
  assert.deepStrictEqual(Stages.canSetItem({}, 'lane', { s: 'booked', from: '2026-10-06', to: '2026-10-08' }), { ok: true });
  const bad = [['lane', { s: 'booked', from: '2026-02-30' }], ['lane', 'yes'], ['asphalt', 'yes'], ['cut', 'booked'],
    ['cleanup', 'na'], ['assess', 'yes'], ['removed', 'true'], ['bogus', 'req'], ['__proto__', 'req'], ['stage', 'bogus']];
  for (const [item, v] of bad) {
    const r = Stages.canSetItem({ stage: 'poured' }, item, v);
    assert.strictEqual(r.ok, false, item);
    assert.strictEqual(r.reason, 'invalid', item);
    assert.strictEqual(typeof r.message, 'string');
  }
  assert.deepStrictEqual(Stages.canSetItem({ lane: { s: 'req' } }, 'stage', 'setup'), { ok: false, reason: 'lane', message: 'Book the lane closure first' });
  assert.deepStrictEqual(Stages.canSetItem({ stage: 'setup' }, 'stage', 'ready'), { ok: true });
  assert.deepStrictEqual(Stages.canSetItem({}, 'asphalt', 'done', { asphalt: true }).reason, 'poured');
});

test('v2: fieldWorkDone truth table', async () => {
  let n = 0;
  for (const stage of ['ready', 'setup', 'inspected', 'poured']) {
    for (const cleanup of ['todo', 'done']) {
      for (const asphalt of ['na', 'req', 'done']) {
        for (const pavers of ['na', 'req', 'done']) {
          const e = eff({ stage, cleanup, asphalt, pavers });
          const want = stage === 'poured' && cleanup === 'done' && asphalt !== 'req' && pavers !== 'req';
          assert.strictEqual(Stages.fieldWorkDone(e), want, JSON.stringify(e));
          if (want) n++;
        }
      }
    }
  }
  assert.strictEqual(n, 4, 'poured + cleanup done + asphalt/pavers each na|done');
  assert.strictEqual(Stages.fieldWorkDone(eff({ stage: 'poured', cleanup: 'done' }, { asphalt: true })), false, 'hint makes asphalt Required');
  assert.strictEqual(Stages.fieldWorkDone(eff({ stage: 'poured', cleanup: 'done', asphalt: 'na' }, { asphalt: true })), true, 'manual N/A beats the hint');
  assert.strictEqual(Stages.fieldWorkDone(null), false);
});

test('v2: keepWhenClosed truth table', async () => {
  let checked = 0;
  for (const stage of ['ready', 'setup', 'poured']) {
    for (const ls of ['na', 'req', 'booked']) {
      for (const cut of ['na', 'req', 'done']) {
        for (const asphalt of ['na', 'req', 'done']) {
          for (const pavers of ['na', 'req', 'done']) {
            for (const cleanup of ['todo', 'done']) {
              for (const removed of [false, true]) {
                const e = eff({ stage, lane: { s: ls }, cut, asphalt, pavers, cleanup, removed });
                const fwd = stage === 'poured' && cleanup === 'done' && asphalt !== 'req' && pavers !== 'req';
                const started = stage !== 'ready' || asphalt === 'req' || pavers === 'req' || cut === 'req' || ls === 'req' || ls === 'booked';
                assert.strictEqual(Stages.keepWhenClosed(e), !removed && !fwd && started, JSON.stringify(e));
                checked++;
              }
            }
          }
        }
      }
    }
  }
  assert.strictEqual(checked, 972);
  const k = (entry, hints) => Stages.keepWhenClosed(eff(entry, hints));
  assert.strictEqual(k({}), false, 'untouched Ready job leaves with Jobber');
  assert.strictEqual(k({ assess: 'onsite' }), false, 'assessed only');
  assert.strictEqual(k({ cut: 'done' }), false, 'street cut done, still Ready');
  assert.strictEqual(k({ lane: { s: 'booked', from: '2026-10-06' } }), true);
  assert.strictEqual(k({}, { asphalt: true }), true, 'hint Required');
  assert.strictEqual(k({ asphalt: 'na' }, { asphalt: true }), false, 'manual N/A beats the hint');
  assert.strictEqual(k({ stage: 'setup' }), true);
  assert.strictEqual(k({ stage: 'poured' }), true, 'cleanup still to do');
  assert.strictEqual(k({ stage: 'poured', cleanup: 'done' }), false, 'field work done');
  assert.strictEqual(k({ stage: 'poured', cleanup: 'done', pavers: 'req' }), true);
  assert.strictEqual(k({ stage: 'base', removed: true }), false, 'Remove from app');
  assert.strictEqual(Stages.keepWhenClosed(null), false);
});

test('v2: every LISTS predicate', async () => {
  const P = {};
  Stages.LISTS.forEach((l) => { P[l.key] = (entry, hints) => l.predicate(eff(entry, hints)); });
  // unassessed = stage in {ready, setup} AND assess no
  assert.strictEqual(P.unassessed({}), true);
  assert.strictEqual(P.unassessed({ stage: 'setup' }), true);
  assert.strictEqual(P.unassessed({ stage: 'excavation' }), false);
  assert.strictEqual(P.unassessed({ stage: 'poured' }), false);
  assert.strictEqual(P.unassessed({ assess: 'virtual' }), false);
  assert.strictEqual(P.unassessed({ stage: 'setup', assess: 'onsite' }), false);
  // booklane = lane.s req (any stage)
  assert.strictEqual(P.booklane({ lane: { s: 'req' } }), true);
  assert.strictEqual(P.booklane({ stage: 'excavation', lane: { s: 'req' } }), true);
  assert.strictEqual(P.booklane({ lane: { s: 'booked' } }), false);
  assert.strictEqual(P.booklane({}), false);
  // streetcuts = cut req
  assert.strictEqual(P.streetcuts({ cut: 'req' }), true);
  assert.strictEqual(P.streetcuts({ stage: 'setup', cut: 'req' }), true);
  assert.strictEqual(P.streetcuts({ cut: 'done' }), false);
  assert.strictEqual(P.streetcuts({}), false);
  // cleanup = poured AND cleanup todo (automatic To do at Poured)
  assert.strictEqual(P.cleanup({ stage: 'poured' }), true);
  assert.strictEqual(P.cleanup({ stage: 'poured', cleanup: 'done' }), false);
  assert.strictEqual(P.cleanup({ stage: 'inspected' }), false);
  // asphalt / pavers = poured AND req (hint or stored)
  for (const key of ['asphalt', 'pavers']) {
    assert.strictEqual(P[key]({ stage: 'poured', [key]: 'req' }), true, key);
    assert.strictEqual(P[key]({ stage: 'poured' }, { [key]: true }), true, key + ' from the hint');
    assert.strictEqual(P[key]({ stage: 'poured', [key]: 'na' }, { [key]: true }), false, key + ' manual N/A');
    assert.strictEqual(P[key]({ stage: 'inspected', [key]: 'req' }), false, key + ' before pour');
    assert.strictEqual(P[key]({ stage: 'poured', [key]: 'done' }), false, key + ' done');
    assert.strictEqual(P[key]({ stage: 'poured' }), false, key + ' no hint');
  }
  Stages.LISTS.forEach((l) => assert.strictEqual(l.predicate(null), false, l.key + '(null)'));
});

test('v2: itemShown (early items in Ready/Setup and later while Required; asphalt/pavers always; cleanup at Poured)', async () => {
  const S = (entry, item, hints) => Stages.itemShown(eff(entry, hints), item);
  assert.strictEqual(S({}, 'assess'), true);
  assert.strictEqual(S({ stage: 'base' }, 'assess'), false);
  assert.strictEqual(S({ stage: 'base' }, 'lane'), false);
  assert.strictEqual(S({ stage: 'base', lane: { s: 'req' } }, 'lane'), true);
  assert.strictEqual(S({ stage: 'base', lane: { s: 'booked' } }, 'lane'), false);
  assert.strictEqual(S({ stage: 'prep', cut: 'req' }, 'cut'), true);
  assert.strictEqual(S({ stage: 'prep', cut: 'done' }, 'cut'), false);
  assert.strictEqual(S({ stage: 'prep' }, 'asphalt'), true);
  assert.strictEqual(S({ stage: 'prep' }, 'cleanup'), false);
  assert.strictEqual(S({ stage: 'poured' }, 'cleanup'), true);
  assert.strictEqual(S({}, 'bogus'), false);
});

test('v2: a v1 stages.json reads as v2; the first save writes version 2 and keeps v1 entries unchanged', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '684': entry('base'), '699': entry('prep') } });
  assert.strictEqual(JSON.parse(srv.text).version, 1);
  const map = await store.load();
  assert.deepStrictEqual(map, { '684': entry('base'), '699': entry('prep') });
  const p = track(store.set(699, { asphalt: 'req' }, { label: 'Other St' }));
  await clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  const written = JSON.parse(srv.text);
  assert.strictEqual(written.version, 2);
  assert.deepStrictEqual(written.stages['684'], entry('base'), 'untouched v1 entry carried over as-is');
  assert.deepStrictEqual(written.stages['699'], { stage: 'prep', asphalt: 'req', at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.deepStrictEqual(Object.keys(written.stages['699']), ['stage', 'asphalt', 'at', 'by'], 'file key order');
  assert.strictEqual(srv.commits[0].message, 'job #699 Other St: asphalt -> req');
});

test('v2: round trip of every field (stored form drops defaults, keeps asphalt/pavers "na")', async () => {
  const full = { stage: 'setup', assess: 'virtual', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, cut: 'req',
    asphalt: 'req', pavers: 'na', cleanup: 'todo', removed: false, at: '2026-09-25T10:00:00Z', by: 'iPhone app' };
  const stored = { stage: 'setup', assess: 'virtual', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, cut: 'req',
    asphalt: 'req', pavers: 'na', at: '2026-09-25T10:00:00Z', by: 'iPhone app' };
  const { store, srv, clock } = setup({ key: true, srvOpts: { text: docText2({ '684': full, '700': { stage: 'poured', cleanup: 'done', removed: true, at: 'x', by: 'y' } }) } });
  const map = await store.load();
  assert.deepStrictEqual(map['684'], stored);
  assert.deepStrictEqual(map['700'], { stage: 'poured', cleanup: 'done', removed: true, at: 'x', by: 'y' });
  track(store.set(701, 'setup'));
  await clock.advance(3000);
  const written = JSON.parse(srv.text);
  assert.deepStrictEqual(written.stages['684'], stored);
  assert.deepStrictEqual(Object.keys(written.stages['684']), ['stage', 'assess', 'lane', 'cut', 'asphalt', 'pavers', 'at', 'by']);
  assert.deepStrictEqual(Object.keys(written.stages['684'].lane), ['s', 'from', 'to']);
  assert.deepStrictEqual(await setup({ srv }).store.load(), await setup({ key: true, srv }).store.load(), 'raw and API read the same');
  const again = await setup({ srv }).store.load();
  assert.deepStrictEqual(again['684'], stored);
  const U = Stages._util;
  const doc = U.parseDocText(U.serializeDoc(again, { note: 'x' }));
  assert.deepStrictEqual(doc.map, again, 'serialize -> parse is the identity on sanitized maps');
  assert.strictEqual(doc.version, 2);
  assert.deepStrictEqual(doc.extras, { note: 'x' });
});

test('v2: set() patches, per-field batching, explicit asphalt "na", null resets, defaults delete the entry', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '684': entry('ready') } });
  await store.load();
  const a = track(store.set(684, { stage: 'setup', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' } }, { label: 'SW Corner Ellice & Kennedy' }));
  await clock.advance(3000);
  assert.deepStrictEqual(a.value, { status: 'saved' });
  assert.strictEqual(srv.commits[0].message, 'job #684 SW Corner Ellice & Kennedy: stage -> setup, lane -> booked 2026-10-06..2026-10-08');
  // three sets of one job inside one batch: per-field merge, last write per field wins
  const b1 = track(store.set(684, { asphalt: 'req' }));
  const b2 = track(store.set(684, 'base'));
  const b3 = track(store.set(684, { asphalt: 'done', assess: 'onsite' }));
  const b4 = track(store.set(699, { pavers: 'na' }));
  await clock.advance(3000);
  [b1, b2, b3, b4].forEach((x) => assert.deepStrictEqual(x.value, { status: 'saved' }));
  assert.strictEqual(puts(srv).length, 2);
  assert.strictEqual(srv.commits[1].message, 'jobs: #684 stage -> base, assess -> onsite, asphalt -> done; #699 pavers -> na');
  assert.deepStrictEqual(srv.stages()['684'], { stage: 'base', assess: 'onsite', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' },
    asphalt: 'done', at: '2026-09-26T15:00:03Z', by: 'PC' });
  assert.deepStrictEqual(srv.stages()['699'], { pavers: 'na', at: '2026-09-26T15:00:03Z', by: 'PC' }, 'explicit N/A is stored');
  // no-op: already stored -> no commit; null = follow the hint again
  assert.deepStrictEqual(await store.set(699, { pavers: 'na' }), { status: 'saved' });
  const c = track(store.set(699, { pavers: null }));
  await clock.advance(3000);
  assert.deepStrictEqual(c.value, { status: 'saved' });
  assert.strictEqual(srv.commits[2].message, 'job #699: pavers -> auto');
  assert.ok(!('699' in srv.stages()), 'entry with only defaults is deleted');
  // setting every field back to its default deletes the entry
  const d = track(store.set(684, { stage: null, assess: 'no', lane: 'na', cut: null, asphalt: null, cleanup: 'todo', removed: false }));
  await clock.advance(3000);
  assert.deepStrictEqual(d.value, { status: 'saved' });
  assert.deepStrictEqual(srv.stages(), {});
  assert.strictEqual(srv.commits[3].message, 'job #684: stage -> ready, assess -> no, lane -> na, asphalt -> auto');
  // dates only kept when booked; cleared date inputs ('' / null) are fine
  const e = track(store.set(684, { lane: { s: 'req', from: '2026-10-06', to: '' } }));
  const f = track(store.set(685, { lane: { s: 'booked', from: '', to: null } }));
  await clock.advance(3000);
  assert.strictEqual(e.state, 'resolved');
  assert.strictEqual(f.state, 'resolved');
  assert.deepStrictEqual(srv.stages()['684'].lane, { s: 'req' });
  assert.deepStrictEqual(srv.stages()['685'].lane, { s: 'booked' });
  assert.strictEqual(srv.commits[4].message, 'jobs: #684 lane -> req; #685 lane -> booked');
});

test('v2: invalid patches reject (code "http") and never reach GitHub', async () => {
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  const bad = [{}, { foo: 1 }, { stage: 'base', label: 'x' }, { asphalt: 'yes' }, { pavers: 'DONE' }, { lane: { s: 'booked', from: '2026-02-30' } },
    { lane: { s: 'booked', to: '2026-10-8' } }, { lane: { from: '2026-10-06' } }, { lane: ['req'] }, { lane: 'yes' }, { removed: 'true' },
    { stage: 'bogus' }, { stage: 5 }, { cleanup: 'na' }, { assess: 'yes' }, { cut: 'booked' }, [], null, 42, undefined, true,
    JSON.parse('{"__proto__":{"stage":"base"}}'), { stage: undefined }];
  for (const p of bad) {
    await assert.rejects(store.set(684, p), (e) => e.code === 'http', JSON.stringify(p));
  }
  await clock.advance(5000);
  assert.strictEqual(puts(srv).length, 0);
  assert.strictEqual(store.status().pending, 0);
  assert.strictEqual(({}).stage, undefined);
  const r = setup({});
  await assert.rejects(r.store.set(684, { asphalt: 'req' }), (e) => e.code === 'readonly', 'read-only devices still reject patches');
});

test('v2: per-field merge on 409 (other fields keep the remote values; the same field -> this device wins)', async () => {
  // different fields of one job
  const a = setup({ key: true, stages: { '684': entry('setup') } });
  await a.store.load();
  let first = true;
  a.srv.hook = (req) => {
    if (req.method === 'PUT' && first) {
      first = false;
      a.srv.commitFile(docText2({ '684': { stage: 'excavation', lane: { s: 'booked', from: '2026-10-06' }, at: 'x', by: 'iPhone app' } }), 'other device');
    }
  };
  const p = track(a.store.set(684, { asphalt: 'req' }, { label: 'Main St' }));
  await a.clock.advance(5000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  assert.strictEqual(puts(a.srv).length, 2);
  assert.deepStrictEqual(a.srv.stages()['684'], { stage: 'excavation', lane: { s: 'booked', from: '2026-10-06' }, asphalt: 'req',
    at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(a.srv.commits[a.srv.commits.length - 1].message, 'job #684 Main St: asphalt -> req');

  // the same field: this device's value wins, the other device's other fields survive
  const b = setup({ key: true, stages: { '684': entry('setup') } });
  await b.store.load();
  first = true;
  b.srv.hook = (req) => {
    if (req.method === 'PUT' && first) {
      first = false;
      b.srv.commitFile(docText2({ '684': { stage: 'setup', lane: { s: 'booked', from: '2026-10-06' }, cut: 'req', at: 'x', by: 'iPhone app' } }), 'other device');
    }
  };
  const q = track(b.store.set(684, { lane: 'req', stage: 'ready' }));
  await b.clock.advance(5000);
  assert.deepStrictEqual(q.value, { status: 'saved' });
  assert.deepStrictEqual(b.srv.stages()['684'], { lane: { s: 'req' }, cut: 'req', at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(b.srv.commits[b.srv.commits.length - 1].message, 'job #684: stage -> ready, lane -> req');

  // the other device already made exactly this change: the retry makes no commit
  const c = setup({ key: true, stages: { '684': entry('setup') } });
  await c.store.load();
  first = true;
  c.srv.hook = (req) => {
    if (req.method === 'PUT' && first) { first = false; c.srv.commitFile(docText2({ '684': { stage: 'setup', cut: 'done', at: 'x', by: 'iPhone app' } }), 'other'); }
  };
  const r = track(c.store.set(684, { cut: 'done' }));
  await c.clock.advance(5000);
  assert.deepStrictEqual(r.value, { status: 'saved' });
  assert.strictEqual(puts(c.srv).length, 1, 'no second PUT');
  assert.deepStrictEqual(c.srv.stages()['684'], { stage: 'setup', cut: 'done', at: 'x', by: 'iPhone app' });
});

test('v2: two devices edit different fields of one job at the same time: both survive', async () => {
  const A = setup({ key: true, stages: { '684': entry('setup') } });
  const B = setup({ key: true, srv: A.srv, navigator: { standalone: true, userAgent: 'iPhone' } });
  await A.store.load();
  await B.store.load();
  const pa = track(A.store.set(684, { stage: 'excavation', cut: 'done' }));
  const pb = track(B.store.set(684, { asphalt: 'req', pavers: 'req' }));
  await A.clock.advance(3000);
  assert.deepStrictEqual(pa.value, { status: 'saved' });
  await B.clock.advance(5000); // B's PUT carries the old sha -> 409 -> re-GET -> merge -> PUT
  assert.deepStrictEqual(pb.value, { status: 'saved' });
  assert.deepStrictEqual(A.srv.stages()['684'], { stage: 'excavation', cut: 'done', asphalt: 'req', pavers: 'req',
    at: '2026-09-26T15:00:00Z', by: 'iPhone app' });
  assert.strictEqual(A.srv.commits.length, 2);
  assert.strictEqual(A.srv.commits[1].message, 'job #684: asphalt -> req, pavers -> req');
  assert.strictEqual((await A.store.load())['684'].asphalt, 'req', 'A sees B\'s fields');
});

test('v2: queue replay of patches (v2 write-ahead format, per-field merge onto the newer remote)', async () => {
  const s = setup({ key: true, stages: { '684': entry('setup') } });
  await s.store.load();
  s.srv.offline = true;
  const p1 = track(s.store.set(684, { lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' } }, { label: 'Main St' }));
  const p2 = track(s.store.set(684, { cut: 'req' }));
  await s.clock.advance(3000);
  assert.deepStrictEqual(p1.value, { status: 'queued' });
  assert.deepStrictEqual(p2.value, { status: 'queued' });
  assert.deepStrictEqual(queueOf(s.storage), { version: 2, changes: { '684': {
    fields: { lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, cut: 'req' }, at: '2026-09-26T15:00:00Z', by: 'PC', label: 'Main St' } } });
  assert.deepStrictEqual(s.store.peek()['684'], { stage: 'setup', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, cut: 'req',
    at: '2026-09-26T15:00:00Z', by: 'PC' }, 'queued patch shown on top of the remote entry');
  // meanwhile another device moved the job and flagged asphalt; then the app is reopened online
  s.srv.offline = false;
  s.srv.commitFile(docText2({ '684': { stage: 'excavation', asphalt: 'req', at: 'x', by: 'iPhone app' } }), 'other device');
  const s2 = setup({ key: true, srv: s.srv, storage: s.storage });
  await s2.store.load();
  await s2.clock.advance(10);
  const last = s.srv.commits[s.srv.commits.length - 1];
  assert.strictEqual(last.message, 'job #684 Main St: lane -> booked 2026-10-06..2026-10-08, cut -> req');
  assert.deepStrictEqual(s.srv.stages()['684'], { stage: 'excavation', lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, cut: 'req',
    asphalt: 'req', at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(queueOf(s.storage), null);

  // a tampered / partly invalid queue: invalid fields and job keys are skipped, valid ones replay
  const q = { version: 2, changes: {
    '684': { fields: { stage: 'base', asphalt: 'yes', lane: { s: 'booked', from: 'bad' }, removed: 'x' }, at: 'a', by: 'PC', label: 'L' },
    '699': { fields: { bogus: 1 }, at: 'a', by: 'PC' },
    'bad key!': { fields: { stage: 'base' } },
    '700': { fields: { pavers: null, cut: 'done' }, at: 'a', by: 'PC', label: '' } } };
  const t = setup({ key: true, stages: { '700': { stage: 'poured', pavers: 'req', at: 'x', by: 'y' } }, ls: { ej_stage_queue: JSON.stringify(q) } });
  assert.strictEqual(t.store.status().pending, 2);
  await t.store.load();
  await t.clock.advance(10);
  assert.deepStrictEqual(t.srv.stages(), {
    '684': { stage: 'base', at: 'a', by: 'PC' },
    '700': { stage: 'poured', cut: 'done', at: 'a', by: 'PC' } });
  assert.strictEqual(t.srv.commits[0].message, 'jobs: #684 stage -> base; #700 cut -> done, pavers -> auto');
});

test('v2: read-only and local modes use the same entries; load()/onChange give stored entries, not effective values', async () => {
  const r = setup({ srvOpts: { text: docText2({ '684': { stage: 'poured', asphalt: 'na', at: 'a', by: 'b' } }) } });
  const map = await r.store.load();
  assert.deepStrictEqual(map, { '684': { stage: 'poured', asphalt: 'na', at: 'a', by: 'b' } }, 'no cleanup/pavers defaults filled in');
  const l = setup({ hostname: 'localhost' });
  await l.store.load();
  assert.deepStrictEqual(await l.store.set(684, { asphalt: 'na', lane: { s: 'booked', to: '2026-10-08' } }), { status: 'saved' });
  assert.deepStrictEqual(JSON.parse(l.storage.getItem('ej_stages')), { version: 2, stages: {
    '684': { lane: { s: 'booked', to: '2026-10-08' }, asphalt: 'na', at: '2026-09-26T15:00:00Z', by: 'PC' } } });
  assert.deepStrictEqual(await l.store.set(684, { asphalt: 'na' }), { status: 'saved' }, 'no-op');
  await l.store.set(684, { asphalt: null, lane: null });
  assert.deepStrictEqual(JSON.parse(l.storage.getItem('ej_stages')).stages, {});
  assert.strictEqual(l.srv.requests.length, 0);
});

test('v2: sanitization of hostile stages.json input (unknown values, bad dates, long strings, prototype pollution)', async () => {
  const RLO = String.fromCharCode(0x202e), LS = String.fromCharCode(0x2028);
  const big = 'x'.repeat(100000);
  const hostile = '{"version":2,"__proto__":{"polluted":1},"note":"keep","stages":{' +
    '"684":{"__proto__":{"stage":"poured","s":"req"},"stage":" SETUP ","assess":"onsite",' +
      '"lane":{"__proto__":{"s":"req"},"s":"booked","from":"2026-02-30","to":"2026-10-08","extra":"x"},' +
      '"cut":"REQ","asphalt":"yes","pavers":["req"],"cleanup":"done","removed":"true","evil":"<script>",' +
      '"at":"2026-09-25T10:00:00Z' + big + '","by":"dev' + RLO + 'gnp.exe' + LS + 'x"},' +
    '"685":{"lane":{"s":"booked","from":"2026-1-6","to":"20261008"}},' +
    '"686":{"lane":"req","at":"a","by":"b"},' +
    '"687":{"lane":{"s":"req","from":"2026-10-06","to":"2026-10-08"}},' +
    '"688":{"asphalt":"na"},' +
    '"689":{"stage":"ready","cleanup":"todo","removed":false,"assess":"no","cut":"na","lane":{"s":"na"},"at":"x","by":"y"},' +
    '"690":{"stage":["base"],"assess":{"v":"onsite"}},' +
    '"691":{"removed":true},' +
    '"692":{"lane":{"s":"booked","from":"9999-12-31","to":"0999-01-01"}},' +
    '"693":{"lane":{"s":"booked","from":"2024-02-29","to":"2026-02-29"}},' +
    '"694":{"lane":{"s":"booked","from":"2026-13-01","to":"2026-00-10"}},' +
    '"695":{"lane":{"s":"booked","from":"' + big + '","to":2026}},' +
    '"__proto__":{"stage":"base"},"' + 'k'.repeat(5000) + '":{"stage":"base"},"bad key!":{"stage":"base"}}}';
  for (const key of [false, true]) {
    const s = setup({ key, srvOpts: { text: hostile } });
    const map = await s.store.load();
    assert.deepStrictEqual(Object.keys(map).sort(), ['684', '685', '687', '688', '691', '692', '693', '694', '695']);
    const e = map['684'];
    assert.deepStrictEqual(Object.keys(e), ['stage', 'assess', 'lane', 'cleanup', 'at', 'by']);
    assert.strictEqual(e.stage, 'setup');
    assert.strictEqual(e.assess, 'onsite');
    assert.deepStrictEqual(e.lane, { s: 'booked', to: '2026-10-08' });
    assert.strictEqual(e.cleanup, 'done');
    assert.ok(e.at.length <= 40 && e.by.length <= 40);
    assert.ok(!e.by.includes(RLO) && !e.by.includes(LS));
    assert.deepStrictEqual(map['685'], { lane: { s: 'booked' }, at: '', by: '' });
    assert.deepStrictEqual(map['687'], { lane: { s: 'req' }, at: '', by: '' }, 'dates dropped unless booked');
    assert.deepStrictEqual(map['688'], { asphalt: 'na', at: '', by: '' });
    assert.deepStrictEqual(map['691'], { removed: true, at: '', by: '' });
    assert.deepStrictEqual(map['692'].lane, { s: 'booked', from: '9999-12-31' });
    assert.deepStrictEqual(map['693'].lane, { s: 'booked', from: '2024-02-29' }, 'leap day real, 2026-02-29 not');
    assert.deepStrictEqual(map['694'], { lane: { s: 'booked' }, at: '', by: '' }, 'month 13 / month 0 dropped');
    assert.deepStrictEqual(map['695'], { lane: { s: 'booked' }, at: '', by: '' }, 'huge / numeric dates dropped');
    assert.strictEqual(({}).stage, undefined, 'no prototype pollution');
    assert.strictEqual(({}).s, undefined);
    assert.strictEqual(({}).polluted, undefined);
    if (key) {
      track(s.store.set(700, 'base'));
      await s.clock.advance(3000);
      const written = JSON.parse(s.srv.text);
      assert.strictEqual(written.version, 2);
      assert.strictEqual(written.note, 'keep');
      assert.ok(!Object.prototype.hasOwnProperty.call(written, 'polluted'));
      assert.ok(!s.srv.text.includes('<script>') && !s.srv.text.includes('"REQ"') && !s.srv.text.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
      assert.deepStrictEqual(written.stages['684'], map['684'], 'the next save rewrites the sanitized entry');
    }
  }
  const U = Stages._util;
  for (const d of ['2026-10-06', '2024-02-29', '2026-12-31', '1000-01-01']) assert.strictEqual(U.cleanDate(d), d, d);
  for (const d of ['2026-02-29', '2026-13-01', '2026-00-01', '2026-01-00', '2026-04-31', '2026-1-6', ' 2026-10-06', '2026-10-06T00:00:00Z',
    '0999-12-31', '', null, 20261006, undefined, {}]) assert.strictEqual(U.cleanDate(d), null, String(d));
});

test('v2: commit messages are bounded; one-job label is cleaned', async () => {
  const U = Stages._util;
  const desc = {};
  for (let i = 1; i <= 300; i++) desc[String(i)] = { label: 'x', parts: ['stage -> base', 'lane -> booked 2026-10-06..2026-10-08'] };
  const m = U.commitMessage(desc);
  assert.ok(m.startsWith('jobs: #1 stage -> base, lane -> booked 2026-10-06..2026-10-08; #2 '), m.slice(0, 80));
  assert.ok(m.length <= 520, 'length ' + m.length);
  assert.ok(/; \+\d+ more$/.test(m));
  const shown = (m.match(/#\d+ /g) || []).length;
  assert.strictEqual(m.slice(m.lastIndexOf('+') + 1), (300 - shown) + ' more');
  const one = U.commitMessage({ '684': { label: '  SW Corner' + String.fromCharCode(0x202e) + ' Ellice\n& Kennedy ' + 'y'.repeat(200), parts: ['stage -> setup'] } });
  assert.ok(one.startsWith('job #684 SW Corner Ellice & Kennedy yyy'), one);
  assert.ok(one.endsWith(': stage -> setup'));
  assert.ok(one.length <= 'job #684 '.length + 80 + ': stage -> setup'.length);

  const { store, srv, clock } = setup({ key: true });
  await store.load();
  for (let i = 1; i <= 60; i++) track(store.set(1000 + i, { stage: 'setup', lane: 'req', cut: 'req', asphalt: 'req', pavers: 'req' }));
  await clock.advance(3000);
  assert.strictEqual(puts(srv).length, 1);
  assert.strictEqual(Object.keys(srv.stages()).length, 60);
  assert.ok(srv.commits[0].message.length <= 520, 'store message bounded: ' + srv.commits[0].message.length);
  assert.ok(/\+\d+ more$/.test(srv.commits[0].message));
});

test('v2: a rejected patch rolls back (refused save); onChange sends the truth only when the rollback cannot', async () => {
  // A refused PUT (rate limit: code "http", not retried). The file-format guards no longer reject: they queue.
  const text = JSON.stringify({ version: 2, stages: { '684': { stage: 'setup', at: 'a', by: 'b' } } }, null, 2) + '\n';
  const { store, srv, clock } = setup({ key: true, srvOpts: { text } });
  srv.hook = (req) => (req.method === 'PUT' ? srv.resp(403, { message: 'API rate limit exceeded' }, { 'X-RateLimit-Remaining': '0' }) : undefined);
  await store.load();
  const seen = [];
  store.onChange((m) => seen.push(m));
  const truth = { '684': { stage: 'setup', at: 'a', by: 'b' } };
  // one set: the UI's own rollback (to the view before the set) already shows the truth -> no onChange
  const p = track(store.set(684, { asphalt: 'req' }));
  await clock.advance(5000);
  assert.strictEqual(p.state, 'rejected');
  assert.strictEqual(p.error.code, 'http');
  assert.ok(/rate limit/.test(p.error.message));
  assert.strictEqual(puts(srv).length, 1);
  assert.strictEqual(srv.text, text);
  assert.strictEqual(store.status().pending, 0);
  assert.strictEqual(seen.length, 0, 'no extra render after a plain rollback');
  assert.deepStrictEqual(store.peek(), truth);
  // two sets of the job in one batch: the rollbacks leave the first change on screen -> onChange sends the truth
  const q1 = track(store.set(684, { asphalt: 'req' }));
  const q2 = track(store.set(684, { cut: 'req' }));
  await clock.advance(5000);
  assert.strictEqual(q1.state, 'rejected');
  assert.strictEqual(q2.state, 'rejected');
  assert.strictEqual(seen.length, 1, 'onChange once');
  assert.deepStrictEqual(seen[0], truth);
  assert.deepStrictEqual(await store.load(), truth);
  assert.strictEqual(puts(srv).length, 2);
  assert.strictEqual(srv.text, text);
});

/* Holds the next PUT in flight until release() (then the mock server answers it normally, or with `status`). */
function holdNextPut(srv) {
  const h = { held: null, release: null };
  const prevHook = srv.hook;
  srv.hook = (req) => {
    if (req.method !== 'PUT' || h.held) return prevHook ? prevHook(req) : undefined;
    h.held = new Promise((resolve) => {
      h.release = (status) => {
        srv.hook = prevHook;
        if (status) { resolve(srv.resp(status, { message: 'held', status: String(status) })); return; }
        const n = srv.requests.length;
        resolve(srv.fetch(req.url, { method: 'PUT', headers: { Authorization: req.headers.authorization }, body: req.body }));
        srv.requests.splice(n, 1); // the replayed request is the same PUT, not a new one
      };
    });
    return h.held;
  };
  return h;
}

test('sec. 10: existing jobs (jobNumber <= ASSESS_CUTOFF, < 9000) count as assessed "prior" unless assess is stored', async () => {
  assert.strictEqual(Stages.ASSESS_CUTOFF, 699);
  const E = (entry, jn, hints) => Stages.effective(entry, hints, jn);
  const unassessed = Stages.LISTS.filter((l) => l.key === 'unassessed')[0];
  for (const jn of [1, 698, 699]) {
    assert.deepStrictEqual(E(null, jn), Object.assign({}, DEFAULT_EFF, { assess: 'prior' }), 'prior ' + jn);
    assert.strictEqual(E({ stage: 'setup', at: 'a', by: 'b' }, jn).assess, 'prior', 'prior with other fields ' + jn);
    assert.strictEqual(unassessed.predicate(E(null, jn)), false, 'unassessed excludes prior ' + jn);
  }
  for (const jn of [700, 701, 9000, 9001, NaN, Infinity, -Infinity, '684', null, undefined, {}, true]) {
    assert.strictEqual(E(null, jn).assess, 'no', 'no ' + String(jn));
  }
  assert.strictEqual(unassessed.predicate(E(null, 700)), true, 'a newer job is unassessed');
  // priorAssessed(jn): the job qualifies whatever is stored (the app dims "Not yet" on it even after a Virtual tap)
  for (const jn of [1, 698, 699]) assert.strictEqual(Stages.priorAssessed(jn), true, 'qualifies ' + jn);
  for (const jn of [700, 9000, 9001, NaN, Infinity, '684', null, undefined, {}, true]) {
    assert.strictEqual(Stages.priorAssessed(jn), false, 'does not qualify ' + String(jn));
  }
  // "no" is the default and never stored, so an old job cannot be un-assessed (open design call for Riley):
  // a patch {assess:"no"} only clears a stored value, and the job shows "prior" again
  assert.deepStrictEqual(Stages._util.cleanPatch({ assess: 'no' }), { assess: 'no' });
  assert.strictEqual(E({ assess: 'no' }, 684).assess, 'prior');
  assert.strictEqual(E({ assess: 'no' }, 700).assess, 'no');
  const parsedNo = Stages._util.parseDocText(docText2({ 684: { assess: 'no', stage: 'setup', at: 'a', by: 'b' } }));
  assert.deepStrictEqual(parsedNo.map['684'], { stage: 'setup', at: 'a', by: 'b' });
  assert.strictEqual(unassessed.predicate(E(null, 9001)), true, 'a pending job is unassessed');
  // a stored value always wins (and the third argument changes nothing else)
  assert.strictEqual(E({ assess: 'virtual' }, 684).assess, 'virtual');
  assert.strictEqual(E({ assess: 'onsite' }, 699).assess, 'onsite');
  assert.strictEqual(E({ assess: 'virtual' }, 700).assess, 'virtual');
  const h = { asphalt: true, pavers: false };
  const withJn = E({ stage: 'poured', cut: 'req' }, 684, h), without = eff({ stage: 'poured', cut: 'req' }, h);
  assert.deepStrictEqual(Object.assign({}, withJn, { assess: 'no' }), without, 'only assess differs');
  assert.strictEqual(Stages.keepWhenClosed(withJn), Stages.keepWhenClosed(without));
  assert.strictEqual(Stages.fieldWorkDone(withJn), Stages.fieldWorkDone(without));
  // without the third argument nothing changes (sync_jobs.py and the contract vectors)
  assert.strictEqual(eff(null).assess, 'no');
  assert.strictEqual(eff({ stage: 'setup' }, {}).assess, 'no');
  // "prior" is not selectable, never accepted in a patch, never stored, and dropped from files
  const assessDef = Stages.ITEMS.filter((i) => i.key === 'assess')[0];
  assert.deepStrictEqual(assessDef.values, ['no', 'virtual', 'onsite']);
  assert.strictEqual(assessDef.labels.prior, 'Assessed before beta');
  assert.strictEqual(Stages._util.cleanPatch({ assess: 'prior' }), null);
  assert.strictEqual(Stages._util.cleanPatch({ assess: 'prior', stage: 'setup' }), null);
  assert.strictEqual(Stages.canSetItem(null, 'assess', 'prior').ok, false);
  assert.strictEqual(Stages._util.cleanEntry({ assess: 'prior', at: 'a', by: 'b' }), null);
  assert.deepStrictEqual(Stages._util.cleanEntry({ stage: 'setup', assess: 'prior', at: 'a', by: 'b' }), { stage: 'setup', at: 'a', by: 'b' });
  const parsed = Stages._util.parseDocText(docText2({ 684: { assess: 'prior', at: 'a', by: 'b' }, 685: { assess: 'prior', cut: 'req', at: 'a', by: 'b' } }));
  assert.ok(!('684' in parsed.map), 'an entry holding only "prior" is dropped');
  assert.deepStrictEqual(parsed.map['685'], { cut: 'req', at: 'a', by: 'b' });
  assert.strictEqual(E({ assess: 'prior' }, 700).assess, 'no', 'a stored "prior" is ignored (newer job)');
  assert.strictEqual(E({ assess: 'prior' }, 684).assess, 'prior', 'a stored "prior" is ignored (cutoff default)');
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  await assert.rejects(store.set(684, { assess: 'prior' }), (e) => e.code === 'http');
  await clock.advance(5000);
  assert.strictEqual(puts(srv).length, 0);
  const s1 = track(store.set(684, { assess: 'virtual' }));
  await clock.advance(3000);
  assert.deepStrictEqual(s1.value, { status: 'saved' });
  assert.strictEqual(srv.stages()['684'].assess, 'virtual', 'tapping a segment stores it');
  assert.strictEqual(E(store.peek()['684'], 684).assess, 'virtual');
  const s2 = track(store.set(684, { assess: null }));
  await clock.advance(3000);
  assert.deepStrictEqual(s2.value, { status: 'saved' });
  assert.ok(!srv.stages()['684'], 'resetting (Undo) stores nothing');
  assert.strictEqual(E(store.peek()['684'] || null, 684).assess, 'prior', 'and shows prior again');
});

test('v2: contract vectors (tests/fixtures/contract_vectors.json): effective, fieldWorkDone, keepWhenClosed, LISTS', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contract_vectors.json'), 'utf8'));
  assert.ok(doc.vectors.length >= 30, 'vectors loaded');
  assert.deepStrictEqual(Stages.LISTS.map((l) => l.key), ['unassessed', 'booklane', 'streetcuts', 'cleanup', 'asphalt', 'pavers']);
  assert.deepStrictEqual(eff(null, null), withR3(doc.defaults));
  for (const v of doc.vectors) {
    const e = eff(v.entry, v.hints);
    assert.deepStrictEqual(e, withR3(v.effective), v.name + ': effective');
    assert.strictEqual(Stages.fieldWorkDone(e), v.fieldWorkDone, v.name + ': fieldWorkDone');
    assert.strictEqual(Stages.keepWhenClosed(e), v.keepWhenClosed, v.name + ': keepWhenClosed');
    assert.deepStrictEqual(Stages.LISTS.filter((l) => l.predicate(e)).map((l) => l.key), v.lists, v.name + ': lists');
  }
});

test('v2: duplicate job keys differing only by whitespace: the exact key wins, whatever the order', async () => {
  const U = Stages._util;
  const exact = { stage: 'poured', cleanup: 'done' }, alias = { stage: 'base' };
  const want = { stage: 'poured', cleanup: 'done', at: '', by: '' };
  assert.deepStrictEqual(U.parseDocText(JSON.stringify({ version: 2, stages: { ' 684': alias, '684': exact } })).map, { '684': want });
  assert.deepStrictEqual(U.parseDocText(JSON.stringify({ version: 2, stages: { '684': exact, ' 684': alias } })).map, { '684': want });
  assert.deepStrictEqual(U.parseDocText(JSON.stringify({ version: 2, stages: { 'A-1 ': alias, 'A-1': exact, ' A-1': alias } })).map, { 'A-1': want });
  // no exact key: the aliases behave like any duplicate (the last one in the file wins)
  assert.deepStrictEqual(U.parseDocText(JSON.stringify({ version: 2, stages: { ' 684': alias, '684 ': exact } })).map, { '684': want });
});

test('v2: lane dates: a booking whose end is before its start is refused (canSetItem and set)', async () => {
  const swapped = { s: 'booked', from: '2026-10-08', to: '2026-10-06' };
  const r = Stages.canSetItem({}, 'lane', swapped);
  assert.deepStrictEqual(r, { ok: false, reason: 'dates', message: 'End date is before start date' });
  assert.deepStrictEqual(Stages.canSetItem({}, 'lane', { s: 'booked', from: '2026-10-06', to: '2026-10-06' }), { ok: true }, 'one-day booking');
  assert.deepStrictEqual(Stages.canSetItem({}, 'lane', { s: 'booked', from: '2026-10-06', to: '2026-10-08' }), { ok: true });
  assert.deepStrictEqual(Stages.canSetItem({}, 'lane', { s: 'booked', from: '2026-10-08' }), { ok: true }, 'one date only');
  assert.deepStrictEqual(Stages.canSetItem({}, 'lane', { s: 'req', from: '2026-10-08', to: '2026-10-06' }), { ok: true }, 'dates ignored unless booked');
  assert.strictEqual(Stages._util.cleanPatch({ lane: swapped }), null);
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  await assert.rejects(store.set(684, { lane: swapped }), (e) => e.code === 'http');
  await clock.advance(5000);
  assert.strictEqual(puts(srv).length, 0);
  assert.strictEqual(store.status().pending, 0);
});

test('v2: a change made while an earlier batch of the same job is in flight never re-sends the saved fields', async () => {
  const A = setup({ key: true, stages: { '684': entry('setup') } });
  const B = setup({ key: true, srv: A.srv, navigator: { standalone: true, userAgent: 'iPhone' } });
  await A.store.load();
  await B.store.load();
  const hold = holdNextPut(A.srv);
  const p1 = track(A.store.set(684, { lane: { s: 'booked', from: '2026-10-06', to: '2026-10-08' } }, { label: 'Main St' }));
  await A.clock.advance(3000); // batch 1 closes; its PUT is in flight
  assert.ok(hold.held, 'batch 1 PUT held');
  const p2 = track(A.store.set(684, { cut: 'done' })); // batch 2 opens while batch 1 is in flight
  assert.deepStrictEqual(A.store.peek()['684'].lane, { s: 'booked', from: '2026-10-06', to: '2026-10-08' }, 'shown while in flight');
  hold.release();
  await drain();
  assert.deepStrictEqual(p1.value, { status: 'saved' });
  assert.strictEqual(p2.state, 'pending');
  // another device corrects the lane dates
  const pb = track(B.store.set(684, { lane: { s: 'booked', from: '2026-10-13', to: '2026-10-15' } }));
  await B.clock.advance(5000);
  assert.deepStrictEqual(pb.value, { status: 'saved' });
  await A.clock.advance(5000); // batch 2: 409 (stale sha) -> re-GET -> merge -> PUT
  assert.deepStrictEqual(p2.value, { status: 'saved' });
  assert.deepStrictEqual(A.srv.stages()['684'].lane, { s: 'booked', from: '2026-10-13', to: '2026-10-15' }, 'B\'s correction survives');
  assert.strictEqual(A.srv.stages()['684'].cut, 'done');
  assert.deepStrictEqual(A.srv.commits.map((c) => c.message), [
    'job #684 Main St: lane -> booked 2026-10-06..2026-10-08',
    'job #684: lane -> booked 2026-10-13..2026-10-15',
    'job #684 Main St: cut -> done']);
  assert.strictEqual(A.store.status().pending, 0);
  assert.strictEqual(queueOf(A.storage), null);

  // the same window for a replay of queued (offline) changes
  const C = setup({ key: true, stages: { '700': entry('setup') } });
  const D = setup({ key: true, srv: C.srv });
  await C.store.load();
  await D.store.load();
  C.srv.offline = true;
  track(C.store.set(700, { assess: 'virtual' }));
  await C.clock.advance(3000);
  assert.strictEqual(C.store.status().pending, 1);
  C.srv.offline = false;
  const hold2 = holdNextPut(C.srv);
  await C.store.load(); // back online: load() replays the queued change; its PUT is held in flight
  await drain();
  assert.ok(hold2.held, 'replay PUT held');
  const p3 = track(C.store.set(700, { cut: 'req' }));
  hold2.release();
  await drain();
  assert.strictEqual(C.srv.stages()['700'].assess, 'virtual');
  const pd = track(D.store.set(700, { assess: 'onsite' }));
  await D.clock.advance(5000);
  assert.deepStrictEqual(pd.value, { status: 'saved' });
  await C.clock.advance(5000);
  assert.deepStrictEqual(p3.value, { status: 'saved' });
  assert.strictEqual(C.srv.stages()['700'].assess, 'onsite', 'the replayed field is not sent again');
  assert.strictEqual(C.srv.stages()['700'].cut, 'req');
  assert.strictEqual(C.srv.commits[C.srv.commits.length - 1].message, 'job #700: cut -> req');
});

test('v2: a batch that fails for good takes only its own fields with it (later and queued changes stay)', async () => {
  // (a) batch 1 fails (3 conflicts) while batch 2 of the same job waits: batch 2 commits only its own field
  const s = setup({ key: true, stages: { '684': entry('poured') } });
  await s.store.load();
  let conflicts = 0; // the held PUT answers 409, then the next two PUTs too
  s.srv.hook = (req) => (req.method === 'PUT' && ++conflicts <= 2 ? s.srv.resp(409, { message: 'conflict' }) : undefined);
  const hold = holdNextPut(s.srv);
  const p1 = track(s.store.set(684, { asphalt: 'req' }));
  await s.clock.advance(3000);
  assert.ok(hold.held);
  const p2 = track(s.store.set(684, { cut: 'done' }));
  hold.release(409);
  await s.clock.advance(1300); // retries at +400 ms and +800 ms, both 409 -> batch 1 fails
  assert.strictEqual(p1.state, 'rejected');
  assert.strictEqual(p1.error.code, 'conflict');
  assert.strictEqual(p2.state, 'pending');
  assert.strictEqual(s.store.peek()['684'].asphalt, undefined, 'the failed field is no longer shown');
  await s.clock.advance(3000);
  assert.deepStrictEqual(p2.value, { status: 'saved' });
  assert.deepStrictEqual(s.srv.stages()['684'], { stage: 'poured', cut: 'done', at: '2026-09-26T15:00:03Z', by: 'PC' });
  assert.strictEqual(s.srv.commits.length, 1);
  assert.strictEqual(s.srv.commits[0].message, 'job #684: cut -> done');

  // (b) removeKey() rejects the open batch but keeps an earlier offline change of the same job
  const t = setup({ key: true, stages: { '684': entry('setup') } });
  await t.store.load();
  t.srv.offline = true;
  const q1 = track(t.store.set(684, { lane: { s: 'booked', from: '2026-10-06' } }, { label: 'Main St' }));
  await t.clock.advance(3000);
  assert.deepStrictEqual(q1.value, { status: 'queued' });
  const q2 = track(t.store.set(684, { cut: 'req' }));
  await t.store.removeKey();
  await drain();
  assert.strictEqual(q2.state, 'rejected');
  assert.strictEqual(q2.error.code, 'readonly');
  const kept = queueOf(t.storage);
  assert.deepStrictEqual(Object.keys(kept.changes), ['684']);
  assert.deepStrictEqual(kept.changes['684'].fields, { lane: { s: 'booked', from: '2026-10-06' } },
    'the offline lane booking is still queued; the rejected cut is not');
  assert.strictEqual(kept.changes['684'].label, 'Main St');
  assert.strictEqual(t.store.status().pending, 1);
  t.srv.offline = false;
  assert.deepStrictEqual(await t.store.setKey(KEY), { ok: true });
  await t.clock.advance(10);
  assert.deepStrictEqual(t.srv.stages()['684'].lane, { s: 'booked', from: '2026-10-06' });
  assert.strictEqual(t.srv.stages()['684'].cut, undefined);
  assert.strictEqual(t.srv.commits[0].message, 'job #684 Main St: lane -> booked 2026-10-06..');
  assert.strictEqual(queueOf(t.storage), null);
});

/* ============================== beta channel (r2-plan sec. 9) ============================== */
const BETA_CFG = { channel: 'beta', base: '../', ns: 'ejb_', stateFile: 'stages-beta.json', overlayFile: 'stages.json', cachePrefix: 'ejb-' };
const REPO_API = 'https://api.github.com/repos/Claude69420/eckstein-jobs-state/contents/';
const REPO_RAW = 'https://raw.githubusercontent.com/Claude69420/eckstein-jobs-state/main/';
const API_BETA = REPO_API + 'stages-beta.json', RAW_BETA = REPO_RAW + 'stages-beta.json';
const T_OLD = '2026-09-26T10:00:00Z', T_MID = '2026-09-26T12:00:00Z', T_NEW = '2026-09-26T14:00:00Z';
const BETA_REQUESTS = []; // every request of every beta test: the overlay is never written (checked at the end)

/* Mock GitHub serving several files of the state repo (contents API with sha checks + raw CDN).
 * files: {name: text | null (missing)}. */
function makeFilesServer(files) {
  const srv = { files: {}, offline: false, validKeys: new Set([KEY]), requests: [], commits: [], hook: null, n: 1 };
  Object.keys(files || {}).forEach((f) => { if (files[f] !== null) srv.files[f] = { text: files[f], sha: 'sha-' + f + '-1' }; });
  const resp = (status, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: () => Promise.resolve(text) };
  };
  srv.resp = resp;
  srv.put = (name, text) => { srv.files[name] = { text, sha: 'sha-' + name + '-' + (++srv.n) }; };
  srv.del = (name) => { delete srv.files[name]; };
  srv.stages = (name) => JSON.parse(srv.files[name].text).stages;
  srv.fetch = function (url, init) {
    const opt = init || {};
    const headers = {};
    Object.keys(opt.headers || {}).forEach((k) => { headers[k.toLowerCase()] = opt.headers[k]; });
    const req = { url: String(url), method: String(opt.method || 'GET').toUpperCase(), headers, body: opt.body, cache: opt.cache };
    srv.requests.push(req); ALL_REQUESTS.push(req); if (srv.beta !== false) BETA_REQUESTS.push(req);
    if (srv.offline) return Promise.reject(new TypeError('Failed to fetch'));
    if (srv.hook) { const r = srv.hook(req); if (r) return Promise.resolve(r); }
    const u = new URL(req.url);
    const rawM = /^\/Claude69420\/eckstein-jobs-state\/main\/([^/]+)$/.exec(u.pathname);
    if (u.origin === 'https://raw.githubusercontent.com' && rawM) {
      const f = srv.files[rawM[1]];
      return Promise.resolve(f ? resp(200, f.text) : resp(404, '404: Not Found'));
    }
    const apiM = /^\/repos\/Claude69420\/eckstein-jobs-state\/contents\/([^/]+)$/.exec(u.pathname);
    if (u.origin === 'https://api.github.com' && apiM && !u.search) {
      const name = apiM[1], f = srv.files[name];
      const m = /^Bearer (.+)$/.exec(headers.authorization || '');
      if (!m || !srv.validKeys.has(m[1])) return Promise.resolve(resp(401, { message: 'Bad credentials' }));
      if (req.method === 'GET') {
        if (!f) return Promise.resolve(resp(404, { message: 'Not Found' }));
        return Promise.resolve(resp(200, { name, sha: f.sha, type: 'file', encoding: 'base64', content: b64lines(f.text) }));
      }
      if (req.method === 'PUT') {
        const b = JSON.parse(req.body);
        if (f && !b.sha) return Promise.resolve(resp(422, { message: '"sha" wasn\'t supplied.' }));
        if (f && b.sha !== f.sha) return Promise.resolve(resp(409, { message: 'does not match' }));
        srv.put(name, Buffer.from(b.content, 'base64').toString('utf8'));
        srv.commits.push({ name, message: b.message, text: srv.files[name].text });
        return Promise.resolve(resp(f ? 200 : 201, { content: { name, sha: srv.files[name].sha } }));
      }
    }
    return Promise.resolve(resp(404, { message: 'Not Found' }));
  };
  return srv;
}
function v1Doc(stages) { return JSON.stringify({ version: 1, stages }, null, 2) + '\n'; }
function v2Doc(stages) { return JSON.stringify({ version: 2, stages }, null, 2) + '\n'; }
function setupBeta(o) {
  o = o || {};
  const clock = makeClock();
  const srv = o.srv || makeFilesServer(o.files || {});
  const cfg = o.config !== undefined ? o.config : BETA_CFG;
  if (!Stages.resolveConfig(cfg).overlayFile) srv.beta = false; // a main-app store writes stages.json legitimately
  const init = Object.assign({}, o.ls || {});
  if (o.key) init.ejb_gh_token = KEY;
  const storage = o.storage || makeStorage(init);
  const document = makeTarget({ visibilityState: 'visible' });
  const window = makeTarget();
  const navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140' };
  const store = Stages.createStore({ fetch: srv.fetch, storage, now: clock.now, hostname: o.hostname !== undefined ? o.hostname : LIVE_HOST,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, document, window, navigator,
    config: cfg, allowUpgrade: o.allowUpgrade === true });
  return { clock, srv, storage, document, window, store };
}
const overlayPuts = (reqs) => reqs.filter((r) => r.method !== 'GET' && /\/contents\/stages\.json$/.test(new URL(r.url).pathname));

test('beta: config defaults = the main app (ej_ keys, stages.json URLs, no overlay); EJ_CONFIG global and env.config', async () => {
  assert.deepStrictEqual(Stages.resolveConfig(undefined),
    { channel: 'main', base: '', ns: 'ej_', stateFile: 'stages.json', overlayFile: null, cachePrefix: 'ej-' });
  assert.deepStrictEqual(Stages.resolveConfig(null), Stages.resolveConfig(undefined));
  assert.deepStrictEqual(Stages.resolveConfig({}), Stages.resolveConfig(undefined));
  assert.deepStrictEqual(Stages.resolveConfig(BETA_CFG), BETA_CFG);
  assert.strictEqual(Stages.API_URL, API);
  assert.strictEqual(Stages.RAW_URL, RAW);
  // Bad values never fall back quietly: the config is locked (tested in 'fail closed: a bad EJ_CONFIG ...').
  const bad = Stages.resolveConfig({ ns: 'ej b', stateFile: '../x.json', overlayFile: 'https://evil/x.json', base: 'https://evil/', channel: 'B E T A' });
  assert.ok(bad.locked);
  assert.deepStrictEqual(Object.assign({}, bad, { locked: undefined }), Object.assign({}, Stages.resolveConfig({}), { locked: undefined }), 'the values themselves are the defaults');

  // Default store: exactly the old keys and URLs, no overlay read, no status.overlay (a v2 file: see the upgrade guard).
  const d = setupBeta({ config: {}, files: { 'stages.json': v2Doc({ '684': entry('base') }) },
    ls: { ej_gh_token: KEY, ejb_gh_token: 'github_pat_WRONGNS_0123456789' } });
  assert.strictEqual(d.store.config.ns, 'ej_');
  assert.strictEqual(d.store.mode, 'github');
  const map = await d.store.load();
  assert.strictEqual(map['684'].stage, 'base');
  assert.deepStrictEqual(d.srv.requests.map((r) => r.method + ' ' + r.url), ['GET ' + API]);
  assert.strictEqual(d.srv.requests[0].headers.authorization, 'Bearer ' + KEY, 'ej_gh_token, not ejb_gh_token');
  assert.ok(!('overlay' in d.store.status()));
  d.store.set(684, 'prep');
  await d.clock.advance(3000);
  assert.deepStrictEqual(d.srv.stages('stages.json')['684'], { stage: 'prep', at: '2026-09-26T15:00:00Z', by: 'PC' }, 'no sat without an overlay');
  assert.ok(d.storage.getItem('ej_stages_cache'));
  assert.strictEqual(d.storage.getItem('ejb_stages_cache'), null);

  // window.EJ_CONFIG is read when env.config is absent.
  globalThis.EJ_CONFIG = BETA_CFG;
  try {
    const clock = makeClock(), srv = makeFilesServer({}), storage = makeStorage({ ej_gh_token: KEY });
    const g = Stages.createStore({ fetch: srv.fetch, storage, now: clock.now, hostname: LIVE_HOST, setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout, document: makeTarget({ visibilityState: 'visible' }), window: makeTarget(), navigator: {} });
    assert.deepStrictEqual(g.config, BETA_CFG);
    assert.strictEqual(g.mode, 'readonly', 'the v1 key (ej_gh_token) is not the beta key');
  } finally { delete globalThis.EJ_CONFIG; }
});

test('fail closed: a bad EJ_CONFIG locks the store (never v1\'s stages.json or "ej_" keys, never a write)', async () => {
  const cases = [
    [{ channel: 'beta', base: '../', ns: 'ejb_', stateFile: 'stages_beta.JSON', overlayFile: 'stages.json', cachePrefix: 'ejb-' }, 'stateFile'],
    [{ channel: 'beta', base: '../', ns: 'ejb_', stateFile: 'stages-beta.json ', overlayFile: 'stages.json', cachePrefix: 'ejb-' }, 'stateFile'],
    [{ channel: 'beta', base: '../', ns: 'ejb-', stateFile: 'stages-beta.json', overlayFile: 'stages.json', cachePrefix: 'ejb-' }, 'ns'],
    [{ channel: 'beta', base: '../', ns: 'ej_', stateFile: 'stages-beta.json', overlayFile: 'stages.json', cachePrefix: 'ejb-' }, '"ej_" keys'],
    [{ channel: 'beta', base: '../', ns: 'ejb_', overlayFile: 'stages.json' }, 'must not write stages.json'],
    [{ channel: 'beta', ns: 'ejb_', stateFile: 'stages.json' }, 'must not write stages.json'],
    [{ stateFile: 'x.json', overlayFile: 'x.json' }, 'overlayFile = stateFile'],
    [{ overlayFile: 'https://evil/x.json' }, 'overlayFile'],
    [{ base: 'https://evil/' }, 'base'],
    ['beta', 'not an object'],
    [[], 'not an object']
  ];
  for (const [cfg, why] of cases) {
    const r = Stages.resolveConfig(cfg);
    assert.ok(typeof r.locked === 'string' && r.locked.indexOf(why) >= 0, JSON.stringify(cfg) + ' -> ' + r.locked);
  }
  // Good configs come back unchanged and unlocked (an explicit null overlay is fine).
  assert.ok(!('locked' in Stages.resolveConfig({ overlayFile: null })));
  assert.ok(!('locked' in Stages.resolveConfig({ channel: 'main', ns: 'ej_', stateFile: 'stages.json' })));

  // A locked store with keys saved under BOTH prefixes, on localhost (which would otherwise be "local" mode).
  for (const host of [LIVE_HOST, 'localhost']) {
    const ls = { ej_gh_token: KEY, ejb_gh_token: KEY, ej_stage_queue: '{"version":2,"changes":{}}' };
    const t = setupBeta({ config: cases[0][0], hostname: host, ls,
      files: { 'stages.json': v1Doc({ '684': entry('base') }), 'stages-beta.json': v2Doc({}) } });
    const snapshot = JSON.stringify(ls);
    assert.strictEqual(t.store.mode, 'readonly', host);
    assert.strictEqual(t.store.hasKey(), false);
    assert.ok(t.store.config.locked);
    const st = t.store.status();
    assert.ok(st.locked && /misconfigured/.test(st.lastError), host + ': ' + st.lastError);
    const m = await t.store.load();
    assert.strictEqual(m['684'].stage, 'base', 'still shows stages read-only');
    const p = track(t.store.set(684, 'prep'));
    await t.clock.advance(3000);
    assert.strictEqual(p.state, 'rejected');
    assert.strictEqual(p.error.code, 'readonly');
    const k = await t.store.setKey(KEY);
    assert.strictEqual(k.ok, false);
    assert.ok(/misconfigured/.test(k.reason));
    await t.store.removeKey();
    assert.ok(/misconfigured/.test(t.store.status().lastError), 'the config error is never cleared');
    assert.deepStrictEqual(t.srv.requests.filter((r) => r.method !== 'GET'), [], 'nothing written to GitHub');
    const after = {};
    ['ej_gh_token', 'ejb_gh_token', 'ej_stage_queue'].forEach((key) => { after[key] = t.storage.getItem(key); });
    assert.strictEqual(JSON.stringify(after), snapshot, 'localStorage untouched');
    assert.strictEqual(t.storage.getItem('ej_stages_cache'), null);
    assert.strictEqual(t.storage.getItem('ejb_stages_cache'), null);
  }
});

test('fail closed: the store never writes a v2 file over an existing v1 file (live v1 stages.json) unless allowUpgrade', async () => {
  // The r2 main app (defaults) with a real key, e.g. the r2 root on localhost during the beta trial.
  const t = setupBeta({ config: {}, hostname: 'localhost', ls: { ej_gh_token: KEY },
    files: { 'stages.json': v1Doc({ '684': entry('base') }) } });
  assert.strictEqual(t.store.mode, 'github');
  await t.store.load();
  const p = track(t.store.set(684, 'prep'));
  await t.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued', reason: 'format' }, 'the move waits on this device');
  assert.strictEqual(t.store.status().pending, 1);
  assert.deepStrictEqual(t.srv.requests.filter((r) => r.method !== 'GET'), [], 'no PUT over the v1 file');
  assert.strictEqual(JSON.parse(t.srv.files['stages.json'].text).version, 1);
  assert.ok(/still in the v1 format/.test(t.store.status().lastError));
  // A file without a version field counts as v1 too.
  const nv = setupBeta({ config: {}, ls: { ej_gh_token: KEY }, files: { 'stages.json': JSON.stringify({ stages: {} }) } });
  const p2 = track(nv.store.set(684, 'prep'));
  await nv.clock.advance(3000);
  assert.deepStrictEqual(p2.value, { status: 'queued', reason: 'format' });
  assert.deepStrictEqual(nv.srv.requests.filter((r) => r.method !== 'GET'), []);
  // v2 file: saves normally. Missing file: created as v2. allowUpgrade (tests / a one-off migration): converts.
  const v2 = setupBeta({ config: {}, ls: { ej_gh_token: KEY }, files: { 'stages.json': v2Doc({}) } });
  const p3 = track(v2.store.set(684, 'prep'));
  await v2.clock.advance(3000);
  assert.deepStrictEqual(p3.value, { status: 'saved' });
  const none = setupBeta({ config: {}, ls: { ej_gh_token: KEY }, files: {} });
  const p4 = track(none.store.set(684, 'prep'));
  await none.clock.advance(3000);
  assert.deepStrictEqual(p4.value, { status: 'saved' });
  assert.strictEqual(JSON.parse(none.srv.files['stages.json'].text).version, 2);
  const up = setupBeta({ config: {}, allowUpgrade: true, ls: { ej_gh_token: KEY }, files: { 'stages.json': v1Doc({ '684': entry('base') }) } });
  const p5 = track(up.store.set(684, 'prep'));
  await up.clock.advance(3000);
  assert.deepStrictEqual(p5.value, { status: 'saved' });
  assert.strictEqual(JSON.parse(up.srv.files['stages.json'].text).version, 2);
});

test('beta build: a fresh tools/build_beta.py build\'s EJ_CONFIG resolves unchanged; one ns rule in stages.js, app.js, prices.js and index.html', () => {
  // Since the promotion the committed beta/ is the retired notice, so build a beta into a temp dir (--out) and read that.
  const root = path.join(__dirname, '..');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ej_beta_build_'));
  let html;
  try {
    let r = null;
    for (const py of ['python', 'python3', 'py']) {
      r = spawnSync(py, [path.join(root, 'tools', 'build_beta.py'), '--out', out], { encoding: 'utf8' });
      if (!r.error) break;
    }
    assert.ok(r && !r.error, 'python is needed for this test');
    assert.strictEqual(r.status, 0, 'build_beta.py --out: ' + r.stdout + r.stderr);
    html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
  const m = /window\.EJ_CONFIG = (\{[^\n]*\});<\/script>/.exec(html);
  assert.ok(m, 'EJ_CONFIG found in the built beta index.html');
  const cfg = JSON.parse(m[1]);
  assert.deepStrictEqual(Stages.resolveConfig(cfg), cfg, 'no field falls back and the config is not locked');
  assert.deepStrictEqual(cfg, BETA_CFG);
  const src = Stages.NS_RE.source;
  for (const f of ['js/app.js', 'js/prices.js', 'index.html']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const found = text.match(/NS_RE = \/([^/\n]+)\//);
    assert.ok(found, f + ' defines NS_RE');
    assert.strictEqual(found[1], src, f + ' uses the same ns pattern as js/stages.js');
  }
});

test('beta: ejb_ storage keys and stages-beta.json URLs; the overlay is read from stages.json (API with the key)', async () => {
  const b = setupBeta({ key: true, ls: { ej_gh_token: 'github_pat_V1ONLY_0123456789abcdef', ej_device: 'v1 phone', ejb_device: 'Beta phone' },
    files: { 'stages-beta.json': v2Doc({}), 'stages.json': v1Doc({ '684': entry('base', T_OLD, 'iPhone app') }) } });
  assert.strictEqual(b.store.mode, 'github');
  await b.store.load();
  assert.deepStrictEqual(b.srv.requests.map((r) => r.method + ' ' + r.url), ['GET ' + API_BETA, 'GET ' + API]);
  b.srv.requests.forEach((r) => assert.strictEqual(r.headers.authorization, 'Bearer ' + KEY));
  assert.strictEqual(b.store.deviceLabel(), 'Beta phone');
  assert.ok(b.storage.getItem('ejb_stages_cache'));
  assert.ok(b.storage.getItem('ejb_overlay_cache'));
  b.srv.offline = true;
  const p = track(b.store.set(699, { cut: 'req' }));
  await b.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued' });
  assert.ok(JSON.parse(b.storage.getItem('ejb_stage_queue')).changes['699']);
  assert.strictEqual(b.storage.getItem('ej_stage_queue'), null);
  assert.strictEqual(b.storage.getItem('ej_stages_cache'), null);
  const st = b.store.status();
  assert.deepStrictEqual(st.overlay, { file: 'stages.json', stateFile: 'stages-beta.json', note: null, lastSync: T0 });

  // Read-only (no key): raw URLs of both files, no Authorization header.
  const r = setupBeta({ files: { 'stages-beta.json': v2Doc({}), 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
  assert.strictEqual(r.store.mode, 'readonly');
  const m = await r.store.load();
  assert.strictEqual(m['684'].stage, 'base');
  assert.deepStrictEqual(r.srv.requests.map((x) => x.url), [RAW_BETA + '?t=' + T0, RAW + '?t=' + T0]);
  r.srv.requests.forEach((x) => assert.ok(!('authorization' in x.headers)));

  // Local mode (localhost, no key): state in ejb_stages, overlay from the raw CDN.
  const l = setupBeta({ hostname: 'localhost', files: { 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
  assert.strictEqual(l.store.mode, 'local');
  assert.strictEqual((await l.store.load())['684'].stage, 'base');
  assert.deepStrictEqual(l.srv.requests.map((x) => x.url), [RAW + '?t=' + T0]);
  await l.store.set(699, 'setup');
  const saved = JSON.parse(l.storage.getItem('ejb_stages'));
  assert.deepStrictEqual(saved.stages['699'], { stage: 'setup', sat: '2026-09-26T15:00:00Z', at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(l.storage.getItem('ej_stages'), null);
  assert.strictEqual(overlayPuts(l.srv.requests).length, 0);
});

test('beta: overlay merge rule truth table (pure mergeEntry)', async () => {
  const ov = { stage: 'base', at: T_MID, by: 'iPhone app' };
  const M = Stages.mergeEntry;
  // no beta entry -> overlay stage (at/by from the overlay)
  assert.deepStrictEqual(M(null, ov), { stage: 'base', at: T_MID, by: 'iPhone app' });
  // beta entry without sat -> overlay stage, beta items kept
  assert.deepStrictEqual(M({ stage: 'setup', cut: 'req', at: T_OLD, by: 'PC' }, ov),
    { stage: 'base', cut: 'req', at: T_MID, by: 'iPhone app' });
  // sat older than overlay.at -> overlay stage
  assert.deepStrictEqual(M({ stage: 'setup', sat: T_OLD, at: T_OLD, by: 'PC' }, ov), { stage: 'base', sat: T_OLD, at: T_MID, by: 'iPhone app' });
  // sat newer -> the beta stage (entry unchanged)
  assert.deepStrictEqual(M({ stage: 'setup', sat: T_NEW, at: T_NEW, by: 'PC' }, ov), { stage: 'setup', sat: T_NEW, at: T_NEW, by: 'PC' });
  // sat equal -> the beta stage (overlay must be strictly newer)
  assert.strictEqual(M({ stage: 'setup', sat: T_MID, at: T_MID, by: 'PC' }, ov).stage, 'setup');
  // beta set Ready after v1's move: {sat} only -> Ready (no stage field)
  assert.deepStrictEqual(M({ sat: T_NEW, at: T_NEW, by: 'PC' }, ov), { sat: T_NEW, at: T_NEW, by: 'PC' });
  // no overlay entry / invalid overlay stage -> the beta entry as is
  assert.deepStrictEqual(M({ stage: 'setup', at: T_OLD, by: 'PC' }, null), { stage: 'setup', at: T_OLD, by: 'PC' });
  assert.deepStrictEqual(M({ stage: 'setup', at: T_OLD, by: 'PC' }, { stage: 'bogus', at: T_NEW, by: 'x' }), { stage: 'setup', at: T_OLD, by: 'PC' });
  assert.strictEqual(M(null, null), null);
  // overlay "ready" (explicit, e.g. a v2 file) wins like any stage; nothing left -> null
  assert.strictEqual(M({ stage: 'setup', at: T_OLD, by: 'PC' }, { stage: 'ready', at: T_MID, by: 'x' }), null);
  // unusable overlay.at never beats a sat; without a sat the overlay still wins
  assert.strictEqual(M({ stage: 'setup', sat: T_OLD, at: T_OLD, by: 'PC' }, { stage: 'base', at: 'yesterday', by: 'x' }).stage, 'setup');
  assert.strictEqual(M({ stage: 'setup', at: T_OLD, by: 'PC' }, { stage: 'base', at: '', by: '' }).stage, 'base');
  // beta entry newer than the overlay (items changed later) keeps its own at/by even when the overlay stage wins
  assert.deepStrictEqual(M({ stage: 'setup', cut: 'req', at: T_NEW, by: 'PC' }, ov), { stage: 'base', cut: 'req', at: T_NEW, by: 'PC' });
});

test('beta: shared overlay vectors (tests/fixtures/overlay_vectors.json; sync_jobs.py must match): times, merge, effective, keepWhenClosed', async () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'overlay_vectors.json'), 'utf8'));
  assert.ok(doc.vectors.length >= 20 && doc.times.length >= 5, 'vectors loaded');
  for (const x of doc.times) {
    const ms = Stages._util.isoMs(x.s);
    assert.strictEqual(Number.isNaN(ms) ? null : ms, x.ms, 'time ' + JSON.stringify(x.s));
  }
  for (const v of doc.vectors) {
    // Through the same parsers the store uses: the beta file entry via sanitize, the v1 entry via the overlay parser.
    const state = v.state === null ? null : (Stages._util.parseDocText(JSON.stringify({ version: 2, stages: { 1: v.state } })).map['1'] || null);
    const ov = v.overlay === null ? null : (Stages._util.parseOverlayText(JSON.stringify({ stages: { 1: v.overlay } })).map['1'] || null);
    const merged = Stages.mergeEntry(state, ov);
    const eff = Stages.effective(merged, null);
    const from = Stages._util.overlayWins(state, ov) ? 'overlay' : (state ? 'state' : 'none');
    assert.strictEqual(eff.stage, v.stage, v.name + ': stage');
    assert.strictEqual(from, v.stageFrom, v.name + ': stageFrom');
    assert.deepStrictEqual(eff, withR3(v.effective), v.name + ': effective');
    assert.strictEqual(Stages.keepWhenClosed(eff), v.keepWhenClosed, v.name + ': keepWhenClosed');
    // The whole store agrees (read-only beta, both files served).
    const files = { 'stages-beta.json': v2Doc(v.state === null ? {} : { 1: v.state }), 'stages.json': v1Doc(v.overlay === null ? {} : { 1: v.overlay }) };
    const t = setupBeta({ files });
    const m = await t.store.load();
    assert.deepStrictEqual(Stages.effective(m['1'] || null, null), withR3(v.effective), v.name + ': store view');
  }
});

test('beta: store merge (overlay missing / damaged / newer / v1 vs v2 file); items never come from the overlay', async () => {
  const beta = v2Doc({
    '1': { cut: 'req', at: T_OLD, by: 'PC' },                                   // no sat
    '2': { stage: 'setup', sat: T_OLD, at: T_OLD, by: 'PC' },                   // sat older than v1
    '3': { stage: 'setup', sat: T_NEW, at: T_NEW, by: 'PC' },                   // sat newer than v1
    '4': { stage: 'prep', asphalt: 'na', sat: T_OLD, at: T_OLD, by: 'PC' }       // no v1 entry
  });
  const v1 = v1Doc({ '1': entry('base', T_MID), '2': entry('base', T_MID), '3': entry('base', T_MID), '9': entry('poured', T_MID, 'iPhone app') });
  const t = setupBeta({ key: true, files: { 'stages-beta.json': beta, 'stages.json': v1 } });
  const m = await t.store.load();
  assert.deepStrictEqual(m, {
    '1': { stage: 'base', cut: 'req', at: T_MID, by: 'iPhone app' },
    '2': { stage: 'base', sat: T_OLD, at: T_MID, by: 'iPhone app' },
    '3': { stage: 'setup', sat: T_NEW, at: T_NEW, by: 'PC' },
    '4': { stage: 'prep', asphalt: 'na', sat: T_OLD, at: T_OLD, by: 'PC' },
    '9': { stage: 'poured', at: T_MID, by: 'iPhone app' }
  });
  assert.deepStrictEqual(t.store.peek(), m, 'peek() gives the merged view too');
  assert.strictEqual(t.store.status().overlay.note, null);

  // Overlay missing (404): the beta file alone.
  const miss = setupBeta({ key: true, files: { 'stages-beta.json': beta } });
  const mm = await miss.store.load();
  assert.strictEqual(mm['1'].stage, undefined);
  assert.strictEqual(mm['2'].stage, 'setup');
  assert.strictEqual(miss.store.status().overlay.note, null);
  assert.strictEqual(miss.store.lastError, null);

  // Overlay damaged: no overlay + a note; never lastError, never blocks a save.
  const dmg = setupBeta({ key: true, files: { 'stages-beta.json': beta, 'stages.json': '{"stages": {"684": "base",}' } });
  const md = await dmg.store.load();
  assert.strictEqual(md['2'].stage, 'setup');
  assert.ok(!('9' in md));
  assert.ok(/damaged/.test(dmg.store.status().overlay.note));
  assert.strictEqual(dmg.store.lastError, null);
  assert.strictEqual(dmg.store.writable, true);
  const ps = track(dmg.store.set(5, 'base'));
  await dmg.clock.advance(3000);
  assert.deepStrictEqual(ps.value, { status: 'saved' });
  assert.strictEqual(dmg.srv.stages('stages-beta.json')['5'].stage, 'base');

  // Overlay newer format (version 3): no overlay + a note; saves still work.
  const nw = setupBeta({ key: true, files: { 'stages-beta.json': beta,
    'stages.json': JSON.stringify({ version: 3, stages: { '9': { stage: 'poured', at: T_MID, by: 'x' } } }) } });
  const mn = await nw.store.load();
  assert.ok(!('9' in mn));
  assert.ok(/newer/.test(nw.store.status().overlay.note));
  const pn = track(nw.store.set(9, 'setup'));
  await nw.clock.advance(3000);
  assert.deepStrictEqual(pn.value, { status: 'saved' });

  // Overlay as a v2 file with items: only the stage is used (explicit "ready" counts; no stage = no overlay entry).
  const v2ov = v2Doc({
    '1': { stage: 'base', cut: 'req', asphalt: 'req', pavers: 'req', lane: { s: 'req' }, assess: 'onsite', cleanup: 'done', removed: true, at: T_MID, by: 'x' },
    '2': { stage: 'ready', at: T_MID, by: 'x' },
    '3': { asphalt: 'req', at: T_NEW, by: 'x' },
    '4': { stage: 'poured', at: T_MID, by: 'x' }
  });
  const v2t = setupBeta({ key: true, files: { 'stages-beta.json': v2Doc({ '2': { stage: 'setup', at: T_OLD, by: 'PC' }, '4': { cut: 'na', pavers: 'na', at: T_OLD, by: 'PC' } }), 'stages.json': v2ov } });
  const m2 = await v2t.store.load();
  assert.deepStrictEqual(m2['1'], { stage: 'base', at: T_MID, by: 'x' }, 'items never from the overlay');
  assert.ok(!('2' in m2), 'explicit overlay "ready" (newer, no sat) moves the job back to Ready');
  assert.ok(!('3' in m2), 'an overlay entry without a stage is ignored');
  assert.deepStrictEqual(m2['4'], { stage: 'poured', pavers: 'na', at: T_MID, by: 'x' });
  assert.strictEqual(Stages.effective(m2['4'], { asphalt: true }).asphalt, 'req', 'hint, not the overlay');

  // v1 shorthand entries ("684": "prep") count with an empty at (only wins over a beta entry without sat).
  const sh = setupBeta({ key: true, files: { 'stages-beta.json': v2Doc({ '7': { stage: 'setup', sat: T_OLD, at: T_OLD, by: 'PC' } }),
    'stages.json': JSON.stringify({ stages: { '6': 'prep', '7': 'poured' } }) } });
  const ms = await sh.store.load();
  assert.strictEqual(ms['6'].stage, 'prep');
  assert.strictEqual(ms['7'].stage, 'setup');
  [t, miss, dmg, nw, v2t, sh].forEach((x) => assert.strictEqual(overlayPuts(x.srv.requests).length, 0));
});

test('beta: setting the stage writes sat (= at); items do not; v1 moves after it show, earlier ones do not', async () => {
  const t = setupBeta({ key: true, files: { 'stages-beta.json': v2Doc({}), 'stages.json': v1Doc({ '684': entry('base', T_OLD, 'iPhone app') }) } });
  const seen = [];
  t.store.onChange((m) => seen.push(m));
  await t.store.load();
  t.store.start();
  assert.strictEqual(t.store.peek()['684'].stage, 'base');
  const p = track(t.store.set(684, 'excavation', { label: 'Main St' }));
  assert.strictEqual(t.store.peek()['684'].stage, 'excavation', 'optimistic view: the beta stage wins at once');
  await t.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  assert.deepStrictEqual(t.srv.stages('stages-beta.json')['684'], { stage: 'excavation', sat: '2026-09-26T15:00:00Z', at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(t.srv.commits[0].name, 'stages-beta.json');
  assert.strictEqual(t.srv.commits[0].message, 'job #684 Main St: stage -> excavation');
  assert.strictEqual(JSON.parse(t.srv.files['stages.json'].text).stages['684'].stage, 'base', 'v1 file untouched');

  // An item change keeps sat as it is.
  await t.clock.advance(60000);
  t.store.set(684, { cut: 'done' });
  await t.clock.advance(3000);
  assert.deepStrictEqual(t.srv.stages('stages-beta.json')['684'], { stage: 'excavation', cut: 'done', sat: '2026-09-26T15:00:00Z', at: '2026-09-26T15:01:03Z', by: 'PC' });

  // v1 moves the job BEFORE the beta's sat (clock skew / late commit): not shown.
  t.srv.put('stages.json', v1Doc({ '684': entry('poured', '2026-09-26T14:59:00Z', 'iPhone app') }));
  await t.clock.advance(60000);
  assert.strictEqual(t.store.peek()['684'].stage, 'excavation');
  // v1 moves it after the sat: shown, items still from the beta file.
  const n = seen.length;
  t.srv.put('stages.json', v1Doc({ '684': entry('prep', '2026-09-26T15:30:00Z', 'iPhone app') }));
  await t.clock.advance(60000);
  assert.deepStrictEqual(t.store.peek()['684'], { stage: 'prep', cut: 'done', sat: '2026-09-26T15:00:00Z', at: '2026-09-26T15:30:00Z', by: 'iPhone app' });
  assert.strictEqual(seen.length, n + 1, 'onChange fired for an overlay-only change');
  assert.strictEqual(seen[seen.length - 1]['684'].stage, 'prep');

  // Setting the stage the beta file already has (but v1 overrides it) renews sat and commits "stage -> excavation".
  const q = track(t.store.set(684, 'excavation'));
  await t.clock.advance(3000);
  assert.deepStrictEqual(q.value, { status: 'saved' });
  const e = t.srv.stages('stages-beta.json')['684'];
  assert.strictEqual(e.stage, 'excavation');
  assert.strictEqual(e.at, '2026-09-26T15:03:06Z');
  assert.strictEqual(e.sat, '2026-09-26T15:30:01Z', 'v1 clock ahead: sat = v1 at + 1 s, so this move still wins');
  assert.strictEqual(t.srv.commits[t.srv.commits.length - 1].message, 'job #684: stage -> excavation');
  assert.strictEqual(t.store.peek()['684'].stage, 'excavation');
  // The same stage again (file and view agree) is a no-op: no commit.
  const c = t.srv.commits.length;
  assert.deepStrictEqual(await t.store.set(684, 'excavation'), { status: 'saved' });
  await t.clock.advance(3000);
  assert.strictEqual(t.srv.commits.length, c);

  // Moving back to Ready over a v1 stage keeps a {sat} entry so the move sticks.
  t.srv.put('stages.json', v1Doc({ '684': entry('prep', '2026-09-26T15:30:00Z'), '700': entry('base', T_OLD) }));
  await t.clock.advance(60000);
  assert.strictEqual(t.store.peek()['700'].stage, 'base');
  t.store.set(700, 'ready', { label: 'Elm St' });
  assert.ok(!('stage' in (t.store.peek()['700'] || {})));
  await t.clock.advance(3000);
  const r = t.srv.stages('stages-beta.json')['700'];
  assert.deepStrictEqual(Object.keys(r), ['sat', 'at', 'by']);
  assert.strictEqual(t.srv.commits[t.srv.commits.length - 1].message, 'job #700 Elm St: stage -> ready');
  await t.clock.advance(60000);
  assert.strictEqual(Stages.effective(t.store.peek()['700']).stage, 'ready');
  assert.strictEqual(overlayPuts(t.srv.requests).length, 0);
  assert.ok(t.srv.commits.every((x) => x.name === 'stages-beta.json'));
  t.store.stop();
});

test('beta: sat survives the write-ahead queue, the per-field merge on 409 and a reload', async () => {
  const t = setupBeta({ key: true, files: { 'stages-beta.json': v2Doc({}), 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
  await t.store.load();
  t.srv.offline = true;
  const p = track(t.store.set(684, 'prep'));
  await t.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued' });
  const q = JSON.parse(t.storage.getItem('ejb_stage_queue'));
  assert.deepStrictEqual(q.changes['684'].fields, { stage: 'prep', sat: '2026-09-26T15:00:00Z' });
  // App restarts offline: the queued stage (with its sat) still wins over v1 in the view.
  const t2 = setupBeta({ key: true, srv: t.srv, storage: t.storage });
  assert.strictEqual(t2.store.peek()['684'].stage, 'prep');
  // Another device changed the beta file meanwhile: per-field merge keeps its item and our stage + sat.
  t.srv.offline = false;
  t.srv.put('stages-beta.json', v2Doc({ '684': { cut: 'req', at: T_OLD, by: 'Other' } }));
  t2.store.start();
  t2.window.dispatch('online');
  await t2.clock.advance(10);
  assert.deepStrictEqual(t.srv.stages('stages-beta.json')['684'], { stage: 'prep', cut: 'req', sat: '2026-09-26T15:00:00Z', at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(overlayPuts(t.srv.requests).length, 0);

  // A tampered sat in the file is dropped on read (then the overlay wins, as for "no sat").
  const bad = setupBeta({ key: true, files: { 'stages-beta.json': v2Doc({ '684': { stage: 'setup', sat: 'soon', at: T_NEW, by: 'PC' } }),
    'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
  assert.strictEqual((await bad.store.load())['684'].stage, 'base');
  // A patch can never set sat itself.
  await assert.rejects(bad.store.set(684, { sat: T_NEW }), (e) => e.code === 'http');
  assert.strictEqual(Stages._util.cleanPatch({ stage: 'base', sat: T_NEW }), null);
});

test('beta: 404 stages-beta.json + overlay present = merged view; first save creates the beta file; setKey accepts it', async () => {
  const t = setupBeta({ key: true, files: { 'stages.json': v1Doc({ '684': entry('base', T_OLD), '699': entry('prep', T_OLD) }) } });
  const m = await t.store.load();
  assert.deepStrictEqual(Object.keys(m).sort(), ['684', '699']);
  assert.strictEqual(m['699'].stage, 'prep');
  assert.strictEqual(t.store.lastError, null);
  const p = track(t.store.set(699, { cut: 'req' }));
  await t.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  const put = t.srv.requests.filter((r) => r.method === 'PUT');
  assert.strictEqual(put.length, 1);
  assert.strictEqual(put[0].url, API_BETA);
  assert.ok(!('sha' in JSON.parse(put[0].body)), 'creates the file (no sha)');
  assert.deepStrictEqual(t.srv.stages('stages-beta.json'), { '699': { cut: 'req', at: '2026-09-26T15:00:00Z', by: 'PC' } });
  assert.deepStrictEqual(t.store.peek()['699'], { stage: 'prep', cut: 'req', at: '2026-09-26T15:00:00Z', by: 'PC' });

  // setKey: beta file missing but v1's file readable -> accepted; both missing -> refused (names the beta file).
  const k = setupBeta({ files: { 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
  assert.deepStrictEqual(await k.store.setKey(KEY), { ok: true });
  assert.strictEqual(k.store.mode, 'github');
  assert.strictEqual(k.storage.getItem('ejb_gh_token'), KEY);
  assert.strictEqual(k.storage.getItem('ej_gh_token'), null);
  assert.strictEqual(k.store.peek()['684'].stage, 'base');
  const none = setupBeta({ files: {} });
  const res = await none.store.setKey(KEY);
  assert.strictEqual(res.ok, false);
  assert.ok(/stages-beta\.json/.test(res.reason));
  assert.strictEqual(none.storage.getItem('ejb_gh_token'), null);
  [t, k, none].forEach((x) => assert.strictEqual(overlayPuts(x.srv.requests).length, 0));
});

test('beta: overlay polling (same cadence), read failures keep the last overlay, offline cold start from ejb_overlay_cache', async () => {
  const t = setupBeta({ key: true, files: { 'stages-beta.json': v2Doc({}), 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
  const changes = [];
  t.store.onChange((m) => changes.push(m));
  await t.store.load();
  t.store.start();
  await t.clock.advance(59999);
  assert.strictEqual(gets(t.srv).length, 2);
  await t.clock.advance(1);
  assert.deepStrictEqual(gets(t.srv).slice(2).map((r) => r.url), [API_BETA, API], 'one poll reads both files');
  assert.strictEqual(changes.length, 0, 'nothing changed: no onChange');
  // Only the overlay changes -> onChange.
  t.srv.put('stages.json', v1Doc({ '684': entry('prep', T_MID) }));
  await t.clock.advance(60000);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0]['684'].stage, 'prep');
  // HTTP 500 on the overlay: the last overlay stays, a note explains; state reads are unaffected.
  t.srv.hook = (req) => (/\/contents\/stages\.json$/.test(req.url) ? t.srv.resp(500, { message: 'boom' }) : undefined);
  await t.clock.advance(60000);
  assert.strictEqual(t.store.peek()['684'].stage, 'prep');
  assert.ok(/Couldn’t read v1 stages/.test(t.store.status().overlay.note));
  assert.strictEqual(t.store.lastError, null);
  t.srv.hook = null;
  await t.clock.advance(60000);
  assert.strictEqual(t.store.status().overlay.note, null);
  // Offline: the last overlay stays.
  t.srv.offline = true;
  await t.clock.advance(60000);
  assert.strictEqual(t.store.peek()['684'].stage, 'prep');
  t.store.stop();
  // Cold start offline: the overlay comes from ejb_overlay_cache.
  const cold = setupBeta({ key: true, srv: t.srv, storage: t.storage });
  assert.strictEqual(cold.store.peek()['684'].stage, 'prep');
  const m = await cold.store.load();
  assert.strictEqual(m['684'].stage, 'prep');

  // Read-only and local modes poll the overlay every 300 s (raw CDN).
  for (const host of [LIVE_HOST, 'localhost']) {
    const r = setupBeta({ hostname: host, files: { 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) } });
    await r.store.load();
    const before = r.srv.requests.length;
    r.store.start();
    await r.clock.advance(299999);
    assert.strictEqual(r.srv.requests.length, before, host);
    await r.clock.advance(1);
    assert.ok(r.srv.requests.length > before, host + ' polled at 300 s');
    assert.ok(r.srv.requests.slice(before).some((x) => x.url.startsWith(RAW + '?t=')), host);
    r.store.stop();
  }
  // A rejected key: the overlay falls back to the raw CDN (no Authorization header).
  const inv = setupBeta({ files: { 'stages.json': v1Doc({ '684': entry('base', T_OLD) }) }, ls: { ejb_gh_token: 'github_pat_REVOKED_0123456789abcdef' } });
  const mi = await inv.store.load();
  assert.strictEqual(inv.store.mode, 'invalid');
  assert.strictEqual(mi['684'].stage, 'base');
  const last = inv.srv.requests[inv.srv.requests.length - 1];
  assert.ok(last.url.startsWith(RAW + '?t='));
  assert.ok(!('authorization' in last.headers));
});

test('beta: without an overlay no sat is written; a stale sat is dropped when the stage moves', async () => {
  const t = setupBeta({ config: {}, key: false, ls: { ej_gh_token: KEY },
    files: { 'stages.json': v2Doc({ '684': { stage: 'base', cut: 'req', sat: T_OLD, at: T_OLD, by: 'PC' } }) } });
  const m = await t.store.load();
  assert.strictEqual(m['684'].sat, T_OLD, 'kept when read');
  t.store.set(684, { cut: 'done' });
  await t.clock.advance(3000);
  assert.strictEqual(t.srv.stages('stages.json')['684'].sat, T_OLD, 'an item change keeps it');
  t.store.set(684, 'prep');
  await t.clock.advance(3000);
  assert.deepStrictEqual(t.srv.stages('stages.json')['684'], { stage: 'prep', cut: 'done', at: '2026-09-26T15:00:03Z', by: 'PC' });
  assert.strictEqual(t.srv.commits[t.srv.commits.length - 1].message, 'job #684: stage -> prep');
});

test('beta: the overlay file is never written (no PUT/POST/DELETE to stages.json in any beta test)', async () => {
  assert.ok(BETA_REQUESTS.length > 40, 'ran over the beta tests');
  assert.strictEqual(overlayPuts(BETA_REQUESTS).length, 0);
  assert.ok(BETA_REQUESTS.some((r) => r.method === 'PUT' && r.url === API_BETA), 'beta saves did happen');
  // Source check: the store has exactly one PUT, and it targets the state file.
  const src = fs.readFileSync(SRC, 'utf8');
  assert.strictEqual((src.match(/method: 'PUT'/g) || []).length, 1);
  assert.ok(/request\(STATE_API, \{ method: 'PUT'/.test(src));
  assert.ok(!/request\(OVL_API, \{ method: 'PUT'/.test(src));
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

/* ======================= promotion (r2-plan sec. 9): R-1 devices and the one-time beta key copy ======================= */
const FAKE_BETA_KEY = 'github_pat_FAKE_BETA_TEST_ONLY_0123456789';   // TEST ONLY
const FAKE_PRICE_KEY = 'FAKE_PRICE_KEY_TEST_ONLY_base64==';          // TEST ONLY
const BETA_LS = { ejb_gh_token: FAKE_BETA_KEY, ejb_price_key: FAKE_PRICE_KEY, ejb_show_prices: '1', ejb_device: 'PC beta' };

test('promotion: migrateFromBeta copies every ejb_ key into a MISSING ej_ key once, marks the time, removes the beta secrets', () => {
  assert.deepStrictEqual(Stages.MIGRATE_KEYS, ['gh_token', 'price_key', 'show_prices', 'device']);
  assert.deepStrictEqual(Stages.MIGRATE_SECRETS, ['gh_token', 'price_key']);
  const ls = Object.assign({ ejb_routes: '[]', ejb_theme: 'dark', ejb_stage_queue: '{"version":2,"changes":{}}' }, BETA_LS, { ejb_device: 'Office PC' });
  const st = makeStorage(ls);
  const r = Stages.migrateFromBeta(st, undefined, T0);
  assert.deepStrictEqual(r, { done: true, copied: ['gh_token', 'price_key', 'show_prices', 'device'], removed: ['gh_token', 'price_key'] });
  assert.strictEqual(st.getItem('ej_gh_token'), FAKE_BETA_KEY);
  assert.strictEqual(st.getItem('ej_price_key'), FAKE_PRICE_KEY);
  assert.strictEqual(st.getItem('ej_show_prices'), '1');
  assert.strictEqual(st.getItem('ej_device'), 'Office PC');
  assert.strictEqual(st.getItem('ej_migrated_from_beta'), new Date(T0).toISOString());
  assert.strictEqual(st.getItem('ejb_gh_token'), null, 'the beta copy of the edit key is removed (no UI left for it)');
  assert.strictEqual(st.getItem('ejb_price_key'), null, 'the beta copy of the pricing key is removed');
  for (const k of ['ejb_show_prices', 'ejb_device', 'ejb_routes', 'ejb_theme', 'ejb_stage_queue']) assert.strictEqual(st.getItem(k), ls[k], k + ' is left in place');
  assert.strictEqual(st.getItem('ej_routes'), null, 'an empty beta route list adds nothing');
  assert.strictEqual(st.getItem('ej_theme'), null, 'prefs are not copied');
  assert.strictEqual(st.getItem('ej_stage_queue'), null, 'unsent beta changes are not copied (they targeted stages-beta.json)');
  assert.ok(JSON.stringify(r).indexOf('FAKE') < 0, 'the result never carries a value');
});

test('promotion: a beta device name that says "beta" is not copied (the PC keeps v1\'s "PC" label)', () => {
  for (const name of ['PC beta', 'EJ Beta PC', 'BETA']) {
    const st = makeStorage(Object.assign({}, BETA_LS, { ejb_device: name }));
    const r = Stages.migrateFromBeta(st, undefined, T0);
    assert.strictEqual(r.done, true);
    assert.ok(r.copied.indexOf('device') < 0, name);
    assert.strictEqual(st.getItem('ej_device'), null, name);
    assert.strictEqual(st.getItem('ejb_device'), name, 'left in place');
  }
});

test('promotion: the beta\'s saved routes are merged into ej_routes once (no duplicates, newest first, cap 50)', () => {
  const R = (name, when, extra) => Object.assign({ name, when, seq: [{ name: 'Shop', lat: 49.9, lon: -97.1, shop: true }], rt: false }, extra || {});
  const main = [R('Mon', '2026-09-22T12:00:00.000Z'), R('Same', '2026-09-20T12:00:00.000Z')];
  const beta = [R('Beta Thu', '2026-09-25T12:00:00.000Z', { skipped: [{ name: 'X', lat: 49.8, lon: -97.2, skip: true }] }),
    R('Same', '2026-09-20T12:00:00.000Z'), R('Beta Sun', '2026-09-21T12:00:00.000Z'), 'junk', { name: 'no seq', when: 'x' }];
  const st = makeStorage({ ej_routes: JSON.stringify(main), ejb_routes: JSON.stringify(beta) });
  const r = Stages.migrateFromBeta(st, undefined, T0);
  assert.deepStrictEqual(r.copied, ['routes']);
  const got = JSON.parse(st.getItem('ej_routes'));
  assert.deepStrictEqual(got.map((x) => x.name), ['Beta Thu', 'Mon', 'Beta Sun', 'Same']);
  assert.deepStrictEqual(got[0].skipped, beta[0].skipped, 'skipped stops kept');
  assert.strictEqual(st.getItem('ejb_routes'), JSON.stringify(beta), 'the beta list is left in place');
  // no main list yet: the beta list becomes it
  const st2 = makeStorage({ ejb_routes: JSON.stringify([R('Only', '2026-09-25T12:00:00.000Z')]) });
  assert.deepStrictEqual(Stages.migrateFromBeta(st2, undefined, T0).copied, ['routes']);
  assert.deepStrictEqual(JSON.parse(st2.getItem('ej_routes')).map((x) => x.name), ['Only']);
  // cap 50 (the app's own cap), newest kept
  const many = []; for (let i = 0; i < 40; i++) many.push(R('m' + i, new Date(T0 - i * 3600e3).toISOString()));
  const bmany = []; for (let i = 0; i < 40; i++) bmany.push(R('b' + i, new Date(T0 - i * 3600e3 - 1800e3).toISOString()));
  const st3 = makeStorage({ ej_routes: JSON.stringify(many), ejb_routes: JSON.stringify(bmany) });
  Stages.migrateFromBeta(st3, undefined, T0);
  const g3 = JSON.parse(st3.getItem('ej_routes'));
  assert.strictEqual(g3.length, 50);
  assert.deepStrictEqual(g3.slice(0, 3).map((x) => x.name), ['m0', 'b0', 'm1']);
  // an unreadable main list is never overwritten
  const st4 = makeStorage({ ej_routes: '{broken', ejb_routes: JSON.stringify([R('B', '2026-09-25T12:00:00.000Z')]) });
  assert.strictEqual(Stages.migrateFromBeta(st4, undefined, T0).done, true);
  assert.strictEqual(st4.getItem('ej_routes'), '{broken');
});

test('promotion: an existing ej_ key always wins (the PC\'s v1 edit key and device name stay); empty counts as missing', () => {
  const st = makeStorage(Object.assign({ ej_gh_token: KEY, ej_device: 'PC', ej_show_prices: '' }, BETA_LS));
  const r = Stages.migrateFromBeta(st, {}, T0);
  assert.deepStrictEqual(r.copied, ['price_key', 'show_prices']);
  assert.deepStrictEqual(r.removed, ['gh_token', 'price_key'], 'the stale beta edit key goes too (the main key is in use)');
  assert.strictEqual(st.getItem('ejb_gh_token'), null);
  assert.strictEqual(st.getItem('ej_gh_token'), KEY);
  assert.strictEqual(st.getItem('ej_device'), 'PC');
  assert.strictEqual(st.getItem('ej_price_key'), FAKE_PRICE_KEY);
  assert.strictEqual(st.getItem('ej_show_prices'), '1');
});

test('promotion: the copy runs once (marker), never on a beta / locked config, and a storage failure retries later', () => {
  const st = makeStorage({});
  assert.deepStrictEqual(Stages.migrateFromBeta(st, undefined, T0), { done: true, copied: [], removed: [] }, 'no beta keys: nothing copied, marked');
  st.setItem('ejb_price_key', FAKE_PRICE_KEY);
  const again = Stages.migrateFromBeta(st, undefined, T0 + 1000);
  assert.strictEqual(again.done, true); assert.deepStrictEqual(again.copied, []);
  assert.strictEqual(st.getItem('ej_price_key'), null, 'after the marker a later beta key is not copied');
  assert.strictEqual(st.getItem('ej_migrated_from_beta'), new Date(T0).toISOString(), 'the marker keeps the first time');

  for (const cfg of [BETA_CFG, { ns: 'ejb_' }, { channel: 'beta', ns: 'ej_' }, { stateFile: 'x' }, 'junk']) {
    const s = makeStorage(Object.assign({}, BETA_LS));
    const r = Stages.migrateFromBeta(s, cfg, T0);
    assert.strictEqual(r.done, false, JSON.stringify(cfg));
    assert.deepStrictEqual([...s._map.keys()].filter((k) => k.indexOf('ej_') === 0), [], 'no ej_ key written for ' + JSON.stringify(cfg));
  }

  const failing = makeStorage(Object.assign({}, BETA_LS), { throwSet: true });
  const f = Stages.migrateFromBeta(failing, undefined, T0);
  assert.strictEqual(f.done, false);
  assert.strictEqual(failing.getItem('ej_migrated_from_beta'), null, 'no marker: the next load tries again');
  assert.strictEqual(failing.getItem('ejb_gh_token'), FAKE_BETA_KEY, 'a failed copy never removes the beta secret');
  assert.strictEqual(failing.getItem('ejb_price_key'), FAKE_PRICE_KEY);
  assert.doesNotThrow(() => Stages.migrateFromBeta(makeStorage({}, { throwAll: true }), undefined, T0));
  assert.strictEqual(Stages.migrateFromBeta(makeStorage({}, { throwAll: true }), undefined, T0).done, false);
  assert.strictEqual(Stages.migrateFromBeta(null, undefined, T0).done, false);
});

test('promotion: after the copy a main-app store uses the beta edit key and device name (no v1 key on this browser)', async () => {
  const storage = makeStorage(Object.assign({}, BETA_LS, { ejb_gh_token: KEY, ejb_device: 'Riley PC' }));
  Stages.migrateFromBeta(storage, undefined, T0);
  const s = setup({ storage, stages: { '684': entry('base') }, srvOpts: { text: v2Doc({ '684': entry('base') }) }, allowUpgrade: false });
  assert.strictEqual(s.store.hasKey(), true);
  assert.strictEqual(s.store.deviceLabel(), 'Riley PC');
  await s.store.load();
  assert.strictEqual(s.store.mode, 'github');
  const p = track(s.store.set(684, 'prep'));
  await s.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' });
  const doc = JSON.parse(s.srv.text);
  assert.strictEqual(doc.version, 2);
  assert.strictEqual(doc.stages['684'].stage, 'prep');
  assert.strictEqual(doc.stages['684'].by, 'Riley PC');
  assert.strictEqual(doc.stages['684'].sat, undefined, 'the main app (no overlay) never writes sat');
});

test('promotion: an R-1 device upgrades cleanly (v1 queue + v1 cache + key + device; the file is v2 after the conversion)', async () => {
  const r1 = {
    ej_gh_token: KEY, ej_device: 'iPhone v1',
    ej_stage_queue: JSON.stringify({ version: 1, changes: { '684': { stage: 'base', at: '2026-09-26T19:00:00Z', by: 'iPhone v1', label: 'Main St' } } }),
    ej_stages_cache: JSON.stringify({ version: 1, at: T0 - 60000, map: { '699': entry('prep', '2026-09-26T18:30:00Z', 'PC'), '650': entry('inspected') } }),
    ej_mode: 'stage', ej_vis_stage: '["base","prep"]', ej_routes: '[]', ej_theme: 'dark', ej_glass: 'tinted'
  };
  const storage = makeStorage(r1);
  assert.deepStrictEqual(Stages.migrateFromBeta(storage, undefined, T0).copied, [], 'no beta on this device: nothing copied');
  const remote = { '699': Object.assign(entry('prep', '2026-09-26T18:30:00Z', 'PC'), { assess: 'onsite' }), '650': entry('inspected') };
  const s = setup({ storage, srvOpts: { text: v2Doc(remote) }, allowUpgrade: false });
  // offline cold start: the R-1 cache + the R-1 queue on top, before any network read
  const cold = s.store.peek();
  assert.strictEqual(cold['699'].stage, 'prep');
  assert.strictEqual(cold['650'].stage, 'inspected');
  assert.strictEqual(cold['684'].stage, 'base');
  assert.strictEqual(s.store.status().pending, 1);
  assert.strictEqual(s.store.deviceLabel(), 'iPhone v1');
  await s.store.load();
  await s.clock.advance(10);
  assert.strictEqual(puts(s.srv).length, 1, 'the R-1 queued move is replayed once');
  const doc = JSON.parse(s.srv.text);
  assert.strictEqual(doc.version, 2);
  assert.deepStrictEqual(doc.stages['684'], { stage: 'base', at: '2026-09-26T19:00:00Z', by: 'iPhone v1' });
  assert.strictEqual(doc.stages['699'].assess, 'onsite', 'fields of other jobs are kept');
  assert.strictEqual(queueOf(storage), null);
  const cache = JSON.parse(storage.getItem('ej_stages_cache'));
  assert.strictEqual(cache.version, 2);
  assert.strictEqual(cache.map['684'].stage, 'base');
  for (const k of ['ej_mode', 'ej_vis_stage', 'ej_routes', 'ej_theme', 'ej_glass']) assert.strictEqual(storage.getItem(k), r1[k], k + ' untouched');
  assert.ok(![...storage._map.keys()].some((k) => k.indexOf('ejb_') === 0), 'the main app never writes ejb_ keys');
});

test('promotion: an R-1 queued move waits (kept, never PUT) while stages.json is still v1, then saves once it is v2', async () => {
  const q = { version: 1, changes: { '684': { stage: 'base', at: '2026-09-26T19:00:00Z', by: 'PC', label: '' } } };
  const s = setup({ key: true, stages: { '699': entry('prep') }, ls: { ej_stage_queue: JSON.stringify(q) }, allowUpgrade: false });
  await s.store.load();
  await s.clock.advance(10);
  assert.strictEqual(puts(s.srv).length, 0, 'a v2 store never writes over the live v1 file');
  assert.strictEqual(JSON.parse(s.srv.text).version, 1);
  assert.strictEqual(s.store.status().pending, 1, 'the queued move is kept');
  assert.strictEqual(queueOf(s.storage).changes['684'].fields.stage, 'base', 'still in ej_stage_queue');
  assert.strictEqual(s.store.peek()['684'].stage, 'base');
  assert.ok(/still in the v1 format/.test(s.store.status().lastError));
  // a live move in the same window is kept too (not rolled back)
  const p = track(s.store.set(699, 'poured'));
  await s.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued', reason: 'format' });
  assert.strictEqual(s.store.peek()['699'].stage, 'poured');
  assert.strictEqual(puts(s.srv).length, 0);
  // the conversion lands: the next poll replays both moves in ONE PUT
  s.srv.commitFile(v2Doc({ '699': entry('prep'), '650': Object.assign(entry('inspected'), { assess: 'onsite' }) }), 'promote');
  await s.store.load();
  await s.clock.advance(10);
  assert.strictEqual(puts(s.srv).length, 1, 'replayed exactly once');
  const doc = JSON.parse(s.srv.text);
  assert.strictEqual(doc.version, 2);
  assert.strictEqual(doc.stages['684'].stage, 'base');
  assert.strictEqual(doc.stages['699'].stage, 'poured');
  assert.strictEqual(doc.stages['650'].assess, 'onsite', 'the promoted items are kept');
  assert.strictEqual(s.store.status().pending, 0);
  assert.strictEqual(s.store.status().lastError, null, 'the paused message clears after the save');
});

test('promotion: a version remembered from an earlier read never refuses a save (re-read once before refusing)', async () => {
  const s = setup({ key: true, stages: { '699': entry('prep') }, allowUpgrade: false });
  await s.store.load();                       // reads v1 (the live file before the conversion)
  s.srv.commitFile(v2Doc({ '699': entry('prep') }), 'promote');   // converted; no poll yet
  const p = track(s.store.set(684, 'base'));
  await s.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' }, 'the FIRST move after the conversion saves');
  assert.strictEqual(puts(s.srv).length, 1);
  assert.strictEqual(JSON.parse(s.srv.text).stages['684'].stage, 'base');
});

/* ================================ R-3: name / loc, awaitingOk ================================ */
const LOC = { lat: 49.8812, lon: -97.1834 };
const LOC2 = { lat: 49.8815, lon: -97.1790 };
/** The file as this app reads it (stage entries + top-level overrides merged). */
const fileView = (srv) => Stages._util.parseDocText(srv.text).map;

test('R-3: name / loc are sanitized from the file (one line <= 80; finite lat/lon inside Manitoba) and are content', async () => {
  const clean = (v) => Stages._util.cleanEntry(v);
  assert.deepStrictEqual(clean({ name: '  Portage\n& \u202eLipton ', loc: { lat: 49.8812, lon: -97.1834, alt: 5 }, at: 'a', by: 'b' }),
    { name: 'Portage & Lipton', loc: LOC, at: 'a', by: 'b' });
  assert.strictEqual(clean({ name: 'n'.repeat(200), at: 'a' }).name.length, 80);
  assert.deepStrictEqual(Object.keys(clean({ loc: LOC, name: 'x', stage: 'base' })), ['stage', 'name', 'loc', 'at', 'by'], 'file key order');
  for (const bad of [{ name: 5 }, { name: '' }, { name: ' \n\t ' }, { name: null }, { name: ['x'] }, { loc: null }, { loc: 'x' }, { loc: [49.9, -97.1] },
    { loc: { lat: '49.9', lon: -97.1 } }, { loc: { lat: 49.9 } }, { loc: { lat: NaN, lon: -97.1 } }, { loc: { lat: 49.9, lon: -Infinity } },
    { loc: { lat: 51, lon: -97.1 } }, { loc: { lat: 48.89, lon: -97.1 } }, { loc: { lat: 49.9, lon: -99.81 } }, { loc: { lat: 49.9, lon: -95.29 } },
    { loc: { lat: 0, lon: 0 } }]) {
    assert.strictEqual(clean(Object.assign({ at: 'a', by: 'b' }, bad)), null, JSON.stringify(bad));
  }
  assert.ok(clean({ loc: { lat: 48.9, lon: -99.8 } }) && clean({ loc: { lat: 50.9, lon: -95.3 } }), 'the box edges are inside');
  const doc = Stages._util.parseDocText(JSON.stringify({ version: 2, stages: { 700: { name: 'Portage & Lipton', loc: LOC, at: 'x', by: 'y' },
    701: { name: { toString: 1 }, loc: { lat: 99, lon: 0 } } } }));
  assert.deepStrictEqual(Object.keys(doc.map), ['700'], 'an entry left with nothing is dropped');
});

test('R-3: effective() exposes name and loc (null by default, copies); gates and lists ignore them', async () => {
  const e = Stages.effective({ name: 'Portage & Lipton', loc: LOC });
  assert.strictEqual(e.name, 'Portage & Lipton');
  assert.deepStrictEqual(e.loc, LOC);
  const entry = { loc: { lat: LOC.lat, lon: LOC.lon } };
  Stages.effective(entry).loc.lat = 1;
  assert.strictEqual(entry.loc.lat, LOC.lat, 'effective() returns a copy');
  assert.strictEqual(Stages.effective(null).name, null);
  assert.strictEqual(Stages.effective(null).loc, null);
  assert.strictEqual(Stages.effective({ name: 5, loc: { lat: 60, lon: 0 } }).name, null);
  const named = Stages.effective({ name: 'X', loc: LOC });
  assert.strictEqual(Stages.keepWhenClosed(named), false, 'a rename alone never keeps a closed job');
  assert.strictEqual(Stages.fieldWorkDone(named), false);
  assert.deepStrictEqual(Stages.canSetItem(null, 'name', 'X'), { ok: true });
  assert.deepStrictEqual(Stages.canSetItem(null, 'loc', LOC), { ok: true });
  assert.strictEqual(Stages.canSetItem(null, 'loc', { lat: 60, lon: -97 }).reason, 'invalid');
  assert.ok(Stages.inManitoba(49.9, -97.1) && !Stages.inManitoba(49.9, -94));
  assert.deepStrictEqual(Stages.MB_BOX, { latMin: 48.9, latMax: 50.9, lonMin: -99.8, lonMax: -95.3 });
});

test('R-3: awaitingOk(eff, job) = closed && !removed && !keepWhenClosed', async () => {
  const E = (x) => Stages.effective(x);
  const closed = { jobNumber: 700, closed: true }, open = { jobNumber: 700 };
  assert.strictEqual(Stages.awaitingOk(E(null), closed), true, 'closed, nothing outstanding');
  assert.strictEqual(Stages.awaitingOk(E({ stage: 'poured', cleanup: 'done' }), closed), true, 'field work done');
  assert.strictEqual(Stages.awaitingOk(E(null), open), false, 'still active in Jobber');
  assert.strictEqual(Stages.awaitingOk(E({ removed: true }), closed), false, 'already removed');
  assert.strictEqual(Stages.awaitingOk(E({ stage: 'poured', cleanup: 'done', pavers: 'req' }), closed), false, 'pavers outstanding');
  assert.strictEqual(Stages.awaitingOk(E({ stage: 'base' }), closed), false, 'work in progress');
  assert.strictEqual(Stages.awaitingOk(Stages.effective(null, { asphalt: true }), closed), false, 'asphalt hint outstanding');
  assert.strictEqual(Stages.awaitingOk(E({ name: 'Renamed' }), closed), true, 'a name alone changes nothing');
  assert.strictEqual(Stages.awaitingOk(E(null), { closed: 'yes' }), true, 'truthy like the contract (!!job.closed)');
  assert.strictEqual(Stages.awaitingOk(E(null), null), false);
  assert.strictEqual(Stages.awaitingOk(null, closed), false);
});

test('R-3: set name / loc: commit parts name -> "...", loc -> moved / cleared; null clears; no-op makes no commit', async () => {
  const { store, srv, clock } = setup({ key: true, stages: { '700': entry('base') } });
  await store.load();
  const a = track(store.set(700, { name: '  Portage & Lipton\n', loc: LOC }, { label: 'Portage Ave' }));
  await clock.advance(3000);
  assert.deepStrictEqual(a.value, { status: 'saved' });
  assert.strictEqual(srv.commits[0].message, 'job #700 Portage Ave: name -> "Portage & Lipton", loc -> moved');
  assert.deepStrictEqual(srv.stages()['700'], { stage: 'base', at: '2026-09-26T15:00:00Z', by: 'PC' }, 'no name / loc inside stage entries');
  assert.deepStrictEqual(JSON.parse(srv.text).overrides, { '700': { name: 'Portage & Lipton', loc: LOC, at: '2026-09-26T15:00:00Z', by: 'PC' } });
  assert.deepStrictEqual(fileView(srv)['700'], { stage: 'base', name: 'Portage & Lipton', loc: LOC, at: '2026-09-26T15:00:00Z', by: 'PC' });
  assert.strictEqual(Stages.effective(store.peek()['700']).name, 'Portage & Lipton');
  // the same values again: no commit
  assert.deepStrictEqual(await store.set(700, { name: 'Portage & Lipton', loc: { lat: LOC.lat, lon: LOC.lon } }), { status: 'saved' });
  assert.strictEqual(srv.commits.length, 1);
  // a move to another point is still "moved"
  const b = track(store.set(700, { loc: LOC2 }));
  await clock.advance(3000);
  assert.deepStrictEqual(b.value, { status: 'saved' });
  assert.strictEqual(srv.commits[1].message, 'job #700: loc -> moved');
  assert.deepStrictEqual(fileView(srv)['700'].loc, LOC2);
  // Reset to Jobber: both null
  const c = track(store.set(700, { name: null, loc: null }));
  await clock.advance(3000);
  assert.deepStrictEqual(c.value, { status: 'saved' });
  assert.strictEqual(srv.commits[2].message, 'job #700: name -> cleared, loc -> cleared');
  assert.deepStrictEqual(Object.keys(srv.stages()['700']), ['stage', 'at', 'by']);
  assert.ok(!('overrides' in JSON.parse(srv.text)), 'no empty overrides object is written');
  // a job whose only content is a name: stored; a blank name clears it and the entry goes
  const d = track(store.set(701, { name: 'Lenore St' }));
  await clock.advance(3000);
  assert.ok(!('701' in srv.stages()), 'a name-only job has no stage entry');
  assert.deepStrictEqual(JSON.parse(srv.text).overrides['701'], { name: 'Lenore St', at: '2026-09-26T15:00:09Z', by: 'PC' });
  const e = track(store.set(701, { name: '   ' }));
  await clock.advance(3000);
  assert.strictEqual(d.state, 'resolved'); assert.strictEqual(e.state, 'resolved');
  assert.ok(!('701' in fileView(srv)));
  assert.strictEqual(srv.commits[4].message, 'job #701: name -> cleared');
});

test('R-3: invalid name / loc patches reject and never reach GitHub', async () => {
  const { store, srv, clock } = setup({ key: true });
  await store.load();
  for (const p of [{ name: 5 }, { name: {} }, { name: ['x'] }, { loc: 'here' }, { loc: [49.9, -97.1] }, { loc: { lat: '49.9', lon: -97.1 } },
    { loc: { lat: 49.9 } }, { loc: { lat: 60, lon: -97.1 } }, { loc: { lat: 49.9, lon: -97.1e9 } }, { loc: { lat: NaN, lon: NaN } }, { loc: true }]) {
    await assert.rejects(store.set(700, p), (e) => e.code === 'http', JSON.stringify(p));
  }
  await clock.advance(5000);
  assert.strictEqual(puts(srv).length, 0);
});

test('R-3: name / loc survive the offline queue and merge per field with another device\'s stage move', async () => {
  const s = setup({ key: true, stages: { '700': entry('base') } });
  await s.store.load();
  s.srv.offline = true;
  const p = track(s.store.set(700, { name: 'Portage & Lipton', loc: LOC }));
  await s.clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'queued' });
  const q = queueOf(s.storage);
  assert.deepStrictEqual(q.changes['700'].fields, { name: 'Portage & Lipton', loc: LOC });
  s.store.stop();
  // restart from storage; another device moved the stage meanwhile
  s.srv.offline = false;
  s.srv.commitFile(docText({ '700': entry('prep', '2026-09-26T15:01:00Z', 'iPhone app') }, { version: 2 }), 'other device');
  const s2 = Stages.createStore({ fetch: s.srv.fetch, storage: s.storage, now: s.clock.now, hostname: LIVE_HOST,
    setTimeout: s.clock.setTimeout, clearTimeout: s.clock.clearTimeout, document: s.document, window: s.window, navigator: s.navigator });
  assert.strictEqual(Stages.effective(s2.peek()['700']).name, 'Portage & Lipton', 'shown before it is saved');
  await s2.load();
  await s.clock.advance(10);
  const st = fileView(s.srv)['700'];
  assert.strictEqual(st.stage, 'prep', 'the other device\'s stage stays');
  assert.strictEqual(st.name, 'Portage & Lipton');
  assert.deepStrictEqual(st.loc, LOC);
  assert.strictEqual(s2.status().pending, 0);
});

test('R-3: local mode stores name / loc; the beta overlay never touches them', async () => {
  const l = setup({ hostname: 'localhost' });
  assert.strictEqual(l.store.mode, 'local');
  await l.store.set(700, { name: 'Local name', loc: LOC });
  assert.deepStrictEqual(JSON.parse(l.storage.getItem('ej_stages')).overrides['700'].loc, LOC);
  assert.deepStrictEqual(Stages.effective(l.store.peek()['700']).loc, LOC);
  const merged = Stages.mergeEntry({ stage: 'base', name: 'Kept', loc: LOC, at: '2026-09-26T10:00:00Z', by: 'b' },
    { stage: 'prep', at: '2026-09-26T12:00:00Z', by: 'v1' });
  assert.deepStrictEqual([merged.stage, merged.name, merged.loc], ['prep', 'Kept', LOC]);
});

test('R-3: an R-2 page still open after the update keeps every name / loc when it saves a stage (overrides are top-level)', async () => {
  // tests/fixtures/stages_r2.js = js/stages.js as shipped in R-2 (main @ bb19494): the code a resumed iPhone app or an
  // open PC tab still runs on update day. Its cleanEntry drops unknown entry fields, but it keeps top-level fields.
  const R2 = require(path.join(__dirname, 'fixtures', 'stages_r2.js'));
  const r3text = Stages._util.serializeDoc({
    '700': { name: 'Portage Ave & Lipton St', loc: LOC, at: '2026-09-26T14:00:00Z', by: 'Riley' },
    '701': { stage: 'base', name: 'Renamed', at: '2026-09-26T14:01:00Z', by: 'Riley' } });
  const srv = makeServer({});
  srv.commitFile(r3text, 'R-3 device');
  const clock = makeClock();
  const storage = makeStorage({ ej_gh_token: KEY });
  const r2 = R2.createStore({ fetch: srv.fetch, storage, now: clock.now, hostname: LIVE_HOST, setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout, document: makeTarget({ visibilityState: 'visible' }), window: makeTarget(),
    navigator: { userAgent: 'iPhone', storage: { persist: () => Promise.resolve(true) } } });
  await r2.load();
  const p = track(r2.set(702, 'setup'));
  await clock.advance(3000);
  assert.deepStrictEqual(p.value, { status: 'saved' }, 'the R-2 page saved');
  assert.ok(srv.commits.length >= 2 && puts(srv).length === 1);
  const after = fileView(srv);
  assert.strictEqual(after['702'].stage, 'setup');
  assert.deepStrictEqual([after['700'].name, after['700'].loc], ['Portage Ave & Lipton St', LOC], 'a name-only job keeps its override');
  assert.deepStrictEqual([after['701'].stage, after['701'].name], ['base', 'Renamed']);
  r2.stop();
  // and R-3 reads legacy inline name / loc (a local-mode file from before this change); overrides win over them
  const legacy = Stages._util.parseDocText(JSON.stringify({ version: 2, stages: { 700: { stage: 'base', name: 'Inline', loc: LOC2, at: '2026-09-26T10:00:00Z', by: 'a' } },
    overrides: { 700: { name: 'Override', at: '2026-09-26T11:00:00Z', by: 'b' }, 703: 'junk', 704: { loc: { lat: 60, lon: 0 } } } })).map;
  assert.deepStrictEqual(legacy, { '700': { stage: 'base', name: 'Override', loc: LOC2, at: '2026-09-26T11:00:00Z', by: 'b' } });
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
