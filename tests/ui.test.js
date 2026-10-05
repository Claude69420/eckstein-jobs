/* Tests for the R-3 UI (index.html, css/components.css, js/app.js, js/ui.js) - plain Node, no dependencies.
 * Run: node tests/ui.test.js   (exit code 1 on any failure)
 *
 * The app's UI code is one browser IIFE (no exports), so this suite checks what can be checked without a DOM:
 *  - static contracts: every element id app.js / ui.js look up exists in index.html; glass only as direct children of
 *    <body> (ADR-17); one build id on every local css/js URL (Rule 14); no raw innerHTML in the app code; the chip-row
 *    touch rules (r3-plan D);
 *  - the pure R-3 helpers, extracted from js/app.js by name and run in a sandbox: the name / pin override
 *    (applyOverrides + "Reset to Jobber"), the Manitoba box, name cleaning, and awaitingOk against js/stages.js.
 * Browser behaviour (dialog, chips, editor) is verified in the Browser pane (APP_MASTER §7.12). */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('index.html'), APP = read('js/app.js'), UIJS = read('js/ui.js'), CSS = read('css/components.css');

let passed = 0, failed = 0;
function test(name, fn) {
  try { const info = fn(); passed++; console.log('PASS  ' + name + (info ? '  (' + info + ')' : '')); }
  catch (err) { failed++; console.log('FAIL  ' + name + '  -> ' + (err && err.message ? err.message : err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((msg || 'not equal') + ': ' + x + ' vs ' + y); }

/* ---------- helpers: pull one named function (or var) out of js/app.js ---------- */
function extractFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found in js/app.js');
  let depth = 0, j = src.indexOf('{', i), inStr = null;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (inStr) { if (c === '\\') { k++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && /[(,=:]\s*$/.test(src.slice(Math.max(0, k - 3), k))) {   // a regex literal: skip to its end
      for (k++; k < src.length && src[k] !== '/'; k++) if (src[k] === '\\' || src[k] === '[') { if (src[k] === '[') { while (src[k] !== ']') k++; } else k++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced function ' + name);
}
function extractVar(src, name) {
  const m = src.match(new RegExp('var ' + name + ' = [^;]*;'));
  if (!m) throw new Error('var ' + name + ' not found');
  return m[0];
}
const Stages = require(path.join(ROOT, 'js', 'stages.js'));
// R-3.1 clients: the constants and the pure client helpers (classification, chips), with the built-in list loaded
const CLIENT_VARS = ['BUILTIN_CLIENTS', 'RES_KEY', 'RES_STAGE', 'RES_COL', 'OTHER_KEY', 'CHIP_MAX', 'CLIENT_KEY_RE', 'CLIENTS', 'CHIPS'];
const CLIENT_FNS = ['has', 'normClientName', 'wordRe', 'validClients', 'setClients', 'matchClient', 'classifyClient', 'ckOf', 'isRes', 'clientChips', 'clientGroup'];
function clientCode() {
  return CLIENT_VARS.map((v) => extractVar(APP, v)).concat(CLIENT_FNS.map((f) => extractFunction(APP, f))).join('\n') +
    '\nsetClients(validClients({ version: 1, clients: BUILTIN_CLIENTS }));';
}
function sandbox() {
  const ctx = { SG: Stages, HAS_STAGES: true, console };
  vm.createContext(ctx);
  const code = [extractVar(APP, 'MB_BOX'), 'inMB', 'effName', 'effLoc', 'applyOverrides', 'jobberName', 'jobName', 'normName', 'awaitingOk']
    .map((n) => n.startsWith('var ') ? n : extractFunction(APP, n)).join('\n') +
    '\nfunction effOf(x) { return x.eff; }\n' + clientCode();
  vm.runInContext(code, ctx);
  return ctx;
}

/* ---------- static contracts ---------- */
test('every id app.js / ui.js look up exists in index.html', function () {
  const ids = new Set();
  for (const m of HTML.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  const dynamic = new Set(['dStageInfo', 'betaPill', 'betaPillAcc', 'betaPillDetail']);   // created by app.js
  const used = new Set();
  for (const src of [APP, UIJS]) {
    for (const m of src.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
    for (const m of src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((id) => !ids.has(id) && !dynamic.has(id));
  assert(!missing.length, 'missing in index.html: ' + missing.join(', '));
  return used.size + ' ids';
});
test('R-3 elements are in index.html', function () {
  ['closedPop', 'popScrim', 'popList', 'popLater', 'dEditBtn', 'dEdit', 'eName', 'eAddr', 'eFind', 'eLoc', 'eSave', 'eCancel', 'eReset',
    'rrBox', 'rrTgl', 'rrPane', 'rrList', 'rrN', 'rrNote'].forEach(function (id) { assert(HTML.indexOf('id="' + id + '"') >= 0, id); });
  assert(/id="dRemove">Completed — remove from app</.test(HTML), 'closed-job button wording');
});
test('glass elements are direct children of <body> (ADR-17)', function () {
  const body = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('</body>')).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  let depth = 0, n = 0;
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>/g, VOID = /^(input|img|br|hr|meta|link|path|circle|rect)$/i;
  let m;
  while ((m = re.exec(body))) {
    const closing = m[1] === '/', tag = m[2], attrs = m[3];
    if (closing) { depth--; continue; }
    if (/class="[^"]*\bglass\b/.test(attrs)) { n++; assert(depth === 0, '<' + tag + attrs.slice(0, 40) + '> is nested ' + depth + ' deep'); }
    if (!VOID.test(tag) && m[4] !== '/') depth++;
  }
  assert(/<section class="pop glass" id="closedPop"/.test(HTML), 'the dialog is glass');
  return n + ' glass elements';
});
test('one build id on every local css/js URL (Rule 14)', function () {
  const v = [...HTML.matchAll(/(?:href|src)="(?:css|js)\/[^"?]+\?v=([^"]+)"/g)].map((m) => m[1]);
  assert(v.length >= 8, 'expected >= 8 versioned URLs, got ' + v.length);
  assert(new Set(v).size === 1, 'mixed build ids: ' + [...new Set(v)].join(', '));
  return v[0];
});
test('no raw innerHTML / insertAdjacentHTML in the app code', function () {
  [APP, UIJS].forEach(function (src) { assert(!/\.innerHTML\s*=|insertAdjacentHTML/.test(src), 'raw HTML write found'); });
});
test('chip rows: pan-x from any start point, no press at touchstart (r3-plan D)', function () {
  assert(/\.chips \.chip, \.chips \.chip \*, \.chips \.chip::after[^{]*\{\s*touch-action:pan-x;/.test(CSS), 'touch-action pan-x rule on chips');
  assert(/lazy = e\.pointerType === 'touch' && !!t\.closest\('\.chips'\)/.test(UIJS), 'delayed press inside .chips');
  assert(/if \(chipSwiped\(\)\) return;/.test(APP), 'a swipe never toggles a chip');
  assert(!/chipsEl\.addEventListener\('touch(start|move)'[^\n]*passive:\s*false/.test(APP), 'chip touch handlers stay passive');
});
test('the selection total covers every shown job (r3-plan C)', function () {
  const f = extractFunction(APP, 'updateCount');
  assert(/sumPrices\(list\)/.test(f) && /shownJobs\(\)/.test(f), 'updateCount sums shownJobs()');
  assert(/function paintPrices\(\)[\s\S]*?updateCount\(\)/.test(APP), 'paintPrices repaints the count');
});

/* ---------- pure R-3 helpers ---------- */
test('Manitoba box (contract: lat 48.9..50.9, lon -99.8..-95.3)', function () {
  const c = sandbox();
  assert(c.inMB(49.88, -97.17) && c.inMB(48.9, -99.8) && c.inMB(50.9, -95.3), 'inside');
  assert(!c.inMB(48.89, -97) && !c.inMB(51, -97) && !c.inMB(49.9, -99.81) && !c.inMB(49.9, -95.2), 'outside');
  assert(!c.inMB(NaN, -97) && !c.inMB('49.9', -97) && !c.inMB(Infinity, -97), 'not finite numbers');
});
test('name / pin override is applied to the job record and reset restores Jobber', function () {
  const c = sandbox();
  const x = { jobNumber: 688, street: 'Portage Ave', title: 'Portage Ave - Lipton to Lenore', lat: 49.8799, lon: -97.2821, ok: true };
  c.applyOverrides(x, Stages.effective({ name: 'Portage Ave & Lipton St', loc: { lat: 49.884, lon: -97.19 } }, {}, 688));
  eq([x.street, x.lat, x.lon, x.ok, x.renamed, x.moved], ['Portage Ave & Lipton St', 49.884, -97.19, true, true, true], 'override');
  eq(c.jobName(x), 'Portage Ave & Lipton St'); eq(c.jobberName(x), 'Portage Ave');
  c.applyOverrides(x, Stages.effective({ name: 'Portage Ave & Lipton St' }, {}, 688));   // pin reset only
  eq([x.street, x.lat, x.lon, x.moved], ['Portage Ave & Lipton St', 49.8799, -97.2821, false], 'pin back');
  c.applyOverrides(x, Stages.effective(null, {}, 688));                                     // Reset to Jobber
  eq([x.street, x.lat, x.lon, x.ok, x.renamed, x.moved], ['Portage Ave', 49.8799, -97.2821, true, false, false], 'reset');
});
test('a pin makes an unmapped job mappable; a pin outside Manitoba is ignored', function () {
  const c = sandbox();
  const x = { jobNumber: 9, street: '', title: 'Somewhere', lat: null, lon: null, ok: false };
  c.applyOverrides(x, { loc: { lat: 49.9, lon: -97.1 } });
  eq([x.ok, x.lat, x.lon, c.jobName(x)], [true, 49.9, -97.1, 'Somewhere']);
  c.applyOverrides(x, { loc: { lat: 43.6, lon: -79.4 } });                                  // Toronto: never shown
  eq([x.ok, x.lat, x.moved], [false, null, false]);
  c.applyOverrides(x, { name: '   ' });
  eq(c.jobName(x), 'Somewhere', 'a blank name is no name');
});
test('name cleaning: one line, collapsed spaces, <= 80 chars', function () {
  const c = sandbox();
  eq(c.normName('  Portage \n Ave\t&  Lipton  '), 'Portage Ave & Lipton');
  eq(c.normName('x'.repeat(100)).length, 80);
  eq(c.normName(null), '');
});
test('awaitingOk: closed, not removed, nothing outstanding', function () {
  const c = sandbox();
  function job(entry, closed) { const x = { jobNumber: 664, closed: closed, hints: {}, clientKey: 'Crown', client: 'Crown Pipeline Ltd.' }; x.eff = Stages.effective(entry, x.hints, 664); return x; }
  assert(c.awaitingOk(job(null, true)), 'closed + nothing stored');
  assert(c.awaitingOk(job({ stage: 'poured', cleanup: 'done' }, true)), 'closed + field work done');
  assert(!c.awaitingOk(job({ stage: 'poured', pavers: 'req' }, true)), 'pavers still to do keeps it');
  assert(!c.awaitingOk(job({ stage: 'base' }, true)), 'mid-job keeps it');
  assert(!c.awaitingOk(job({ removed: true }, true)), 'removed');
  assert(!c.awaitingOk(job(null, false)), 'active in Jobber');
});

/* ---------- fix round 1 ---------- */
test('closed-jobs dialog: opens only on a stage read of THIS load (never the cache / defaults); safe focus', function () {
  const f = extractFunction(APP, 'stagesFresh');
  const run = (store, since) => { const ctx = { store }; vm.createContext(ctx); vm.runInContext(f, ctx); return ctx.stagesFresh(since); };
  const T = 1000000;
  assert(run({ mode: 'local' }, T), 'local mode reads its own storage');
  assert(run({ mode: 'github', status: () => ({ lastSync: T + 5 }) }, T), 'read after the load began');
  assert(!run({ mode: 'github', status: () => ({ lastSync: T - 60000, lastError: 'offline' }) }, T), 'cache time from an earlier session');
  assert(!run({ mode: 'github', status: () => ({ lastSync: null }) }, T), 'no read at all (every job would look Ready)');
  assert(!run({ mode: 'github', status: () => { throw new Error('x'); } }, T), 'a broken store never opens it');
  const m = extractFunction(APP, 'maybeShowClosedPop');
  assert(/stagesFresh\(a\.since\)/.test(m) && /popBusy\(\)/.test(m), 'the check needs a fresh read and waits while typing');
  const o = extractFunction(APP, 'openPop');
  assert(/pop\.focus\(/.test(o) && !/data-a="done"/.test(o), 'the dialog itself gets focus, never Completed');
  assert(/id="closedPop"[^>]*tabindex="-1"/.test(HTML), 'the dialog is focusable');
  assert(/function syncPopRows\(\)/.test(APP) && /renderAll\(\); refreshOpenJob\(\); syncPopRows\(\);/.test(APP), 'an Undo puts the row back');
  assert(/armPop\(\);/.test(extractFunction(APP, 'loadData')), 'every load (open, Reload, long resume) arms the check');
});
test('count: the total is stacked under the count everywhere and read as a separate phrase', function () {
  assert(!/\.count \.c-v::before/.test(CSS), 'no one-line desktop layout that clips the total');
  assert(/class: 'sr-only', text: ', Jobber total '/.test(extractFunction(APP, 'updateCount')), 'VoiceOver separator');
});
test('stale removed flag on a job Jobber lists again is cleared only with fresh data', function () {
  const f = extractFunction(APP, 'clearStaleRemoved');
  assert(/stagesFresh\(since\)/.test(f) && /at >= made/.test(f) && /x\.closed/.test(f), 'fresh read, data newer than the removal, active jobs only');
  assert(/removed: null/.test(f), 'clears with a null patch');
});

/* ---------- R-3.1 (docs/r3-plan.md G): residential jobs are stageless; commercial clients from a list ---------- */
test('clients: Jobber names match the commercial list like the sync (whole words, any case / spacing); the rest is Residential', function () {
  const c = sandbox();
  const k = (client, clientKey, extra) => c.classifyClient(Object.assign({ client: client, clientKey: clientKey }, extra || {}));
  eq(k('Crown Pipeline Ltd.', 'Crown'), 'Crown');
  eq(k('Harris Holdings Ltd.', 'Harris'), 'Harris');
  eq(k('Gary Harris Builders', 'Other'), 'Residential', 'not Harris Holdings');
  eq(k('AECON UTILITIES INC.', 'Other'), 'AECON', 'old jobs.json: AECON matched by name');
  eq(k('MyTec Industry Ltd', 'Other'), 'MyTec');
  eq(k('ACV Sewer &amp; Water', 'Other'), 'ACV');
  eq(k('  crown   PIPELINE  ltd', 'Other'), 'Crown', 'any case / spacing');
  eq(k('Crownpipeline Inc', 'Other'), 'Residential', 'whole words only');
  eq(k('Swift Underground Inc', undefined), 'Swift');
  eq(k('No Limits Underground Ltd.', 'NoLimits'), 'NoLimits');
  eq(k('Tricore Contracting', 'Tricore'), 'Tricore');
  eq(k('Cheryl  Levene', 'Other'), 'Residential');
  eq(k('James Friesen', 'Residential', { residential: true }), 'Residential');
  eq(k('Crown Pipeline Ltd.', 'Residential'), 'Residential', 'the sync clientKey wins when it is on the list');
  eq(k('Somebody', 'Unknown'), 'Residential', 'a key not on the list falls back to the name');
  eq(k(null, null), 'Residential');
});
test('clients: data/commercial_clients.json is valid and matches the built-in fallback; validation is all or nothing', function () {
  const c = sandbox();
  const file = JSON.parse(read('data/commercial_clients.json'));
  const list = c.validClients(file);
  assert(list && list.length === 8, 'the file validates (8 clients)');
  eq(list.map((x) => [x.key, x.label, x.short, x.color]), c.BUILTIN_CLIENTS.map((x) => [x.key, x.label, x.short, x.color]), 'built-in = the file');
  eq(file.clients.map((x) => x.match), c.BUILTIN_CLIENTS.map((x) => x.match), 'same match strings');
  assert(!file.clients.some((x) => x.color.toLowerCase() === c.RES_COL), 'no client uses the residential amber');
  assert(new Set(file.clients.map((x) => x.color.toLowerCase())).size === 8, 'distinct colours');
  const one = (o) => ({ version: 1, clients: [Object.assign({ key: 'Crown', label: 'Crown', short: 'Crown', match: ['crown'], color: '#2563eb' }, o)] });
  assert(c.validClients(one({})), 'a good one');
  [{ color: 'red' }, { color: '#2563e' }, { key: 'Residential' }, { key: 'other' }, { key: 'AllOther' }, { key: '9x' }, { label: ' ' }, { short: 5 },
    { match: [] }, { match: ['  '] }, { match: [3] }].forEach(function (o) { assert(c.validClients(one(o)) === null, JSON.stringify(o)); });
  assert(c.validClients({ version: 2, clients: one({}).clients }) === null, 'version');
  assert(c.validClients({ version: 1, clients: one({}).clients.concat(one({}).clients) }) === null, 'a duplicate key rejects the file');
});
test('client chips: every commercial client with jobs (list order); 9 or more -> the 8 with the most jobs + "All other"', function () {
  const c = sandbox();
  const jobs = (counts) => [].concat(...Object.keys(counts).map((k) => Array.from({ length: counts[k] }, () => ({ clientKey: k, client: k }))));
  const today = c.clientChips(jobs({ Crown: 21, Harris: 14, ACV: 6, MyTec: 2, NoLimits: 2, AECON: 1, Residential: 8 }));
  eq(today.own, ['Crown', 'Harris', 'ACV', 'MyTec', 'NoLimits', 'AECON'], 'the data of 2026-10-04');
  const moved = c.clientChips(jobs({ Crown: 1, Harris: 2, ACV: 9, MyTec: 1, NoLimits: 5, AECON: 3 }));
  eq(moved.own, ['Crown', 'Harris', 'ACV', 'MyTec', 'NoLimits', 'AECON'], 'counts change, chips never reshuffle');
  eq(today.lumped, []);
  const eight = c.clientChips(jobs({ Swift: 9, Crown: 1, Harris: 1, ACV: 1, MyTec: 1, NoLimits: 1, AECON: 1, Tricore: 1 }));
  eq([eight.own.length, eight.own[7], eight.lumped.length], [8, 'Swift', 0], '8 clients: all get chips, in list order');
  c.setClients(c.validClients({ version: 1, clients: c.BUILTIN_CLIENTS.concat([{ key: 'Ninth', label: 'Ninth Co', short: 'Ninth', match: ['ninth co'], color: '#123456' }]) }));
  const nine = c.clientChips(jobs({ Crown: 5, Harris: 4, ACV: 3, MyTec: 3, NoLimits: 2, AECON: 2, Tricore: 2, Swift: 1, Ninth: 1 }));
  eq(nine.own, ['Crown', 'Harris', 'ACV', 'MyTec', 'NoLimits', 'AECON', 'Tricore', 'Swift'], '9 clients: the 8 with the most jobs');
  eq(nine.lumped, ['Ninth'], 'the rest under All other');
  const busyNinth = c.clientChips(jobs({ Crown: 5, Harris: 4, ACV: 3, MyTec: 3, NoLimits: 2, AECON: 2, Tricore: 2, Swift: 1, Ninth: 9 }));
  eq(busyNinth.own, ['Crown', 'Harris', 'ACV', 'MyTec', 'NoLimits', 'AECON', 'Tricore', 'Ninth'], 'chosen by count, shown in list order');
  eq(busyNinth.lumped, ['Swift']);
  c.nineChips = nine;
  vm.runInContext('CHIPS = nineChips;', c);
  eq(c.clientGroup({ clientKey: 'Ninth', client: 'Ninth Co' }), 'AllOther');
  eq(c.clientGroup({ clientKey: 'Crown', client: 'Crown Pipeline' }), 'Crown');
  eq(c.clientGroup({ clientKey: 'Residential', residential: true }), 'Residential');
});
test('Stage mode: residential jobs are only in the Residential chip, never in a stage or a list', function () {
  const c = sandbox();
  vm.runInContext(extractFunction(APP, 'matchesKey') + '\nvar LIST = { pavers: { predicate: function (e) { return e.pavers === "req"; } } };' +
    '\nfunction isListKey(k) { return k === "pavers"; }', c);
  const res = { clientKey: 'Residential', residential: true, eff: Stages.effective(null, { pavers: true }) };
  const com = { clientKey: 'Crown', client: 'Crown Pipeline', eff: Stages.effective({ stage: 'poured' }, { pavers: true }) };
  eq([c.matchesKey(res, 'residential'), c.matchesKey(res, 'ready'), c.matchesKey(res, 'pavers')], [true, false, false], 'residential');
  eq([c.matchesKey(com, 'residential'), c.matchesKey(com, 'poured'), c.matchesKey(com, 'pavers')], [false, true, true], 'commercial');
  const old = { clientKey: 'Other', client: 'Leanne Docking', eff: Stages.effective(null) };
  eq([c.matchesKey(old, 'ready'), c.matchesKey(old, 'residential')], [false, true], 'old "Other" record = residential until the next sync');
});
test('awaitingOk: a closed residential job asks only when it was kept (Restore stored keep)', function () {
  const c = sandbox();
  function job(entry) { const x = { jobNumber: 712, closed: true, clientKey: 'Residential', residential: true, hints: { pavers: true } }; x.eff = Stages.effective(entry, x.hints, 712); return x; }
  assert(!c.awaitingOk(job(null)), 'no keep: the sync removes it, never asked');
  assert(c.awaitingOk(job({ keep: true })), 'kept: waits for Completed (its pavers hint does not count: no items)');
  assert(!c.awaitingOk(job({ keep: true, removed: true })), 'Completed');
  const open = job({ keep: true }); open.closed = false;
  assert(!c.awaitingOk(open), 'still active in Jobber');
});
test('residential job sheet: no stage slider, no items; Restore of a residential job stores keep; "Other" selection migrates', function () {
  assert(/<div class="card" id="dStageCard">[\s\S]*?id="dStage"/.test(HTML), 'the stage card has an id');
  const rd = extractFunction(APP, 'refreshDetail');
  assert(/\$\('dStageCard'\)\.hidden = res;/.test(rd) && /if \(!res\) detailSlider\.set\(x\);/.test(rd), 'slider hidden for residential');
  assert(/if \(isRes\(x\)\) \{ \$\('dItems'\)\.hidden = true; return; \}/.test(extractFunction(APP, 'paintItems')), 'items hidden for residential');
  assert(/res \? \{ keep: true, removed: null \} : \{ removed: null \}/.test(APP), 'Restore patch');
  assert(/if \(isRes\(x\)\) return;/.test(extractFunction(APP, 'moveStage')), 'no stage moves on a residential job');
  const ctx = { CLIENT: { Crown: {}, Residential: {}, AllOther: {} }, RES_KEY: 'Residential', stored: ['Other', 'Crown', 'Other', 'Gone', 5, 'bad key'], CLIENT_KEY_RE: /^[A-Za-z][A-Za-z0-9]{0,31}$/ };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(APP, 'has') + '\n' + extractFunction(APP, 'loadClientSel') + '\nfunction lsJSON() { return stored; }', ctx);
  eq(ctx.loadClientSel(), ['Residential', 'Crown', 'Gone'], 'Other -> Residential; a key only the client file may name waits for it; junk dropped');
  assert(/if \(res\[3\]\) setClients\(res\[3\]\);\s*SEL\.client = SEL\.client\.filter\(function \(k\) \{ return has\(CLIENT, k\); \}\);/.test(APP),
    'after the client file (or its failed read), unknown keys leave the view');
  assert(!/\bCOL\[|\bLABEL\[|\bSHORT\[|CLIENT_KEYS/.test(APP), 'the old constants block is gone (one place: BUILTIN_CLIENTS / data/commercial_clients.json)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
