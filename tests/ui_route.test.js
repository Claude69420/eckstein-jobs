/* Tests for the R-3 Route tab (r3-plan B + F; builder "ui-part-2") - plain Node, no dependencies.
 * Run: node tests/ui_route.test.js   (exit code 1 on any failure)
 *
 *  - static contracts: two tabs (Jobs · Route), no Plan / Routes view left, js/routes.js loaded before js/app.js and in
 *    the service worker shell, the Rule 14 build id / cache name, Settings -> Routes (Your name, Old route maps);
 *  - the pure route-start helpers, extracted from js/app.js by name and run in a sandbox with the real js/tsp.js and
 *    js/routes.js: routePath (start modes, numbering, Return to shop), Re-optimize keeping the start first, the GPS
 *    error texts, the saved-route helpers (Mine / Team, device routes -> synced routes, never a GPS position).
 * Browser behaviour (switch, GPS stub, save / open / delete, old maps) is verified in the Browser pane (APP_MASTER §7.12). */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('index.html'), APP = read('js/app.js'), UIJS = read('js/ui.js'), CSS = read('css/components.css'), SW = read('sw.js');
const TSP = require(path.join(ROOT, 'js', 'tsp.js'));
const SavedRoutes = require(path.join(ROOT, 'js', 'routes.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { const info = fn(); passed++; console.log('PASS  ' + name + (info ? '  (' + info + ')' : '')); }
  catch (err) { failed++; console.log('FAIL  ' + name + '  -> ' + (err && err.message ? err.message : err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error((msg || 'not equal') + ': ' + x + ' vs ' + y); }

/* one named function out of js/app.js (same scanner as tests/ui.test.js) */
function extractFunction(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function ' + name + ' not found in js/app.js');
  let depth = 0, j = src.indexOf('{', i), inStr = null;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (inStr) { if (c === '\\') { k++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === '/' && /[(,=:]\s*$/.test(src.slice(Math.max(0, k - 3), k))) {
      for (k++; k < src.length && src[k] !== '/'; k++) if (src[k] === '\\' || src[k] === '[') { if (src[k] === '[') { while (src[k] !== ']') k++; } else k++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced function ' + name);
}
function extractBlock(src, start, end) {             // from the text `start` up to (not including) `end`
  const i = src.indexOf(start); if (i < 0) throw new Error(start + ' not found');
  const j = src.indexOf(end, i); if (j < 0) throw new Error(end + ' not found');
  return src.slice(i, j);
}

function sandbox() {
  const ctx = { TSP, SR: SavedRoutes, console, ED: null };
  vm.createContext(ctx);
  const fns = ['routePath', 'model', 'origin', 'included', 'skippedStops', 'optimizeStops', 'gpsError', 'oneLine', 'isMine',
    'splitSaved', 'validStop', 'startForSave', 'localMode', 'localToSynced', 'inMB'];
  const code = [
    'var MB_BOX = { s: 48.9, n: 50.9, w: -99.8, e: -95.3 };',
    extractBlock(APP, 'var GPS_ERR = {', 'function gpsError('),
    fns.map((n) => extractFunction(APP, n)).join('\n')
  ].join('\n');
  vm.runInContext(code, ctx);
  return ctx;
}
const SHOP = { name: 'Shop', lat: 49.8401, lon: -97.2546, shop: true, _id: 1 };
function stop(n, lat, lon) { return { name: 'S' + n, lat: lat, lon: lon, _id: 100 + n }; }

/* ---------- static contracts ---------- */
test('two tabs: Jobs · Route (the Plan view renamed, the Routes view gone)', function () {
  const tabs = [...HTML.matchAll(/class="tab pressable[^"]*"[^>]*data-v="([a-z]+)"[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => m[1] + ':' + m[2]);
  eq(tabs, ['jobs:Jobs', 'route:Route']);
  const panel = [...HTML.matchAll(/class="icon-btn pressable" data-v="([a-z]+)" aria-label="([^"]+)"/g)].map((m) => m[1] + ':' + m[2]);
  eq(panel, ['jobs:Jobs', 'route:Route', 'settings:Settings']);
  assert(HTML.indexOf('id="v-route"') >= 0 && HTML.indexOf('id="v-plan"') < 0 && HTML.indexOf('id="v-routes"') < 0 && HTML.indexOf('id="rlist"') < 0, 'views');
  assert(!/>Plan<|Plan a route|data-v="plan"|data-v="routes"/.test(HTML), 'no Plan / Routes left in index.html');
  assert(/var TITLES = \{ jobs: 'Jobs', route: 'Route', settings: 'Settings' \};/.test(UIJS) && /var TAB_ORDER = \['jobs', 'route'\];/.test(UIJS), 'ui.js views');
  assert(!/'plan'|(?:openList|showView)\('routes'|=== 'routes'/.test(APP), "app.js never opens the 'plan' / 'routes' view");
  assert(/grid-template-columns:repeat\(2, 1fr\)/.test(CSS) && /width:calc\(\(100% - 8px\) \/ 2\)/.test(CSS), 'tab bar: 2 columns, blob half width');
  assert(/\.sheet\[data-view="route"\] \.sheet-sub/.test(CSS) && !/data-view="plan"/.test(CSS), 'route view CSS');
});
test('js/routes.js: loaded after prices.js and before ui.js / app.js, in the SW shell; Rule 14 bump (r3.1, ej-v5)', function () {
  const order = [...HTML.matchAll(/<script src="(js\/[a-z]+\.js)\?v=([^"]+)"/g)].map((m) => m[1]);
  eq(order, ['js/tsp.js', 'js/stages.js', 'js/prices.js', 'js/routes.js', 'js/ui.js', 'js/app.js']);
  const ids = new Set([...HTML.matchAll(/(?:href|src)="(?:css|js)\/[^"?]+\?v=([^"]+)"/g)].map((m) => m[1]));
  eq([...ids], ['r3.1']);
  assert(/const C = 'ej-v5';/.test(SW) && /const PREFIX = 'ej-';/.test(SW), 'cache ej-v5, prefix ej-');
  assert(/'js\/routes\.js',/.test(SW), 'routes.js in SHELL');
  assert(/k\.indexOf\(PREFIX\) === 0 && k !== C/.test(SW), 'prefix-scoped cleanup unchanged');
});
test('Settings -> Routes: Your name + Old route maps; the saved list and its status line', function () {
  ['setRtH', 'rtName', 'omBox', 'omTgl', 'omN', 'omPane', 'omList', 'savedlist', 'srStatus'].forEach(function (id) { assert(HTML.indexOf('id="' + id + '"') >= 0, id); });
  assert(/<input id="rtName" type="text" maxlength="40"/.test(HTML), 'name field <= 40');
  assert(/routes: 'setRtH'/.test(UIJS), 'openSettings("routes")');
  assert(/lsGet\('user_name', ''\)/.test(APP) && /lsSet\('user_name_asked', '1'\)/.test(APP), 'ns + user_name, asked once');
});
test('GPS: high accuracy, 10 s timeout; the position is never saved', function () {
  assert(/enableHighAccuracy: true, timeout: 10000/.test(APP), 'geolocation options');
  const f = extractFunction(APP, 'startForSave');
  assert(!/lat|lon/.test(f), 'startForSave never writes coordinates');
});

/* ---------- pure helpers ---------- */
test('routePath: shop start "S", stops #1..n, Return to shop = one S (round trip)', function () {
  const c = sandbox(), a = stop(1, 49.9, -97.1), b = stop(2, 49.88, -97.15);
  let m = c.routePath('shop', SHOP, null, [a, b], false);
  eq(m.labels, ['S', '1', '2']); eq(m.off, 0); assert(m.origin === SHOP && m.end === null, 'origin shop, no end');
  m = c.routePath('shop', SHOP, null, [a, b], true);
  eq(m.labels, ['S', '1', '2', 'S']); assert(m.path[3] === SHOP, 'ends at the shop');
  eq(TSP.legs(m.path, false).map((l) => l.km.toFixed(3)), TSP.legs([SHOP, a, b], true).map((l) => l.km.toFixed(3)), 'same legs as R-2 (rt)');
  eq(TSP.gmapsParts(m.path, false), TSP.gmapsParts([SHOP, a, b], true), 'same Google Maps link as R-2');
  m = c.routePath('shop', SHOP, null, [], true);
  eq(m.labels, ['S'], 'no stops: no return leg');
});
test('routePath: shop switch off -> stop 1 is the start (Rule 6); Return to shop still ends at the shop', function () {
  const c = sandbox(), a = stop(1, 49.9, -97.1), b = stop(2, 49.88, -97.15);
  let m = c.routePath('stop', SHOP, null, [a, b], false);
  eq(m.labels, ['1', '2']); eq(m.off, -1); assert(m.origin === null && m.path[0] === a, 'starts at stop 1');
  m = c.routePath('stop', SHOP, null, [a, b], true);
  eq(m.labels, ['1', '2', 'S']); assert(m.end === SHOP, 'Return to shop = the shop');
  assert(TSP.gmapsParts(m.path, false)[0].indexOf('/dir/49.9,-97.1/') > 0, 'Google Maps starts at stop 1');
});
test('routePath: "Me" start; not located yet behaves like stop 1', function () {
  const c = sandbox(), a = stop(1, 49.9, -97.1), me = { name: 'My location', lat: 49.8951, lon: -97.1384, me: true, _id: 9 };
  let m = c.routePath('gps', SHOP, me, [a], true);
  eq(m.labels, ['Me', '1', 'S']); assert(m.origin === me, 'origin me');
  assert(TSP.gmapsParts(m.path, false)[0].indexOf('/dir/49.8951,-97.1384/') > 0, 'Google Maps starts at my location');
  m = c.routePath('gps', SHOP, null, [a], false);
  eq(m.labels, ['1']); assert(m.origin === null, 'no position yet: stop 1 starts');
});
test('Re-optimize keeps the start first in every mode (and the shop last with Return to shop)', function () {
  const c = sandbox();
  const far = stop(1, 49.95, -97.0), s2 = stop(2, 49.84, -97.24), s3 = stop(3, 49.9, -97.1), s4 = stop(4, 49.86, -97.2);
  const inc = [far, s2, s3, s4];
  const me = { name: 'My location', lat: 49.97, lon: -96.98, me: true, _id: 9 };
  [['shop', null, false], ['shop', null, true], ['stop', null, false], ['stop', null, true], ['gps', me, false], ['gps', me, true]].forEach(function (t) {
    c.ED = { mode: t[0], shop: SHOP, me: t[1], stops: inc.slice(), rt: t[2] };
    const out = c.optimizeStops(inc);
    assert(out.length === inc.length && inc.every((s) => out.indexOf(s) >= 0), t[0] + ': same stops');
    if (t[0] === 'stop') assert(out[0] === far, 'stop mode: stop 1 stays first');
    const pathKm = TSP.pathKm(c.routePath(t[0], SHOP, t[1], out, t[2]).path, false);
    const orig = TSP.pathKm(c.routePath(t[0], SHOP, t[1], inc, t[2]).path, false);
    assert(pathKm <= orig + 1e-9, t.join('/') + ': never longer');
  });
  c.ED = { mode: 'stop', shop: SHOP, me: null, stops: inc.slice(), rt: false };
  eq(c.optimizeStops(inc).map((s) => s.name), ['S1', 'S3', 'S4', 'S2'], 'from the far stop: nearest chain');
});
test('GPS error texts are specific (permission, no fix, timeout) and have a fallback', function () {
  const c = sandbox();
  assert(/blocked/.test(c.gpsError(1)) && /Location Services/.test(c.gpsError(1)), 'permission');
  assert(/position/.test(c.gpsError(2)), 'unavailable');
  assert(/10 seconds/.test(c.gpsError(3)), 'timeout');
  assert(/Try again/.test(c.gpsError(undefined)), 'fallback');
});
test('Mine / Team: owner matches "Your name" (trimmed, any case); no name -> everything is Team', function () {
  const c = sandbox(), list = [{ id: 'r1', owner: 'Riley ' }, { id: 'r2', owner: 'Claude' }, { id: 'r3', owner: '' }, { id: 'r4', owner: 'riley' }];
  const s = c.splitSaved(list, 'Riley');
  eq(s.mine.map((r) => r.id), ['r1', 'r4']); eq(s.team.map((r) => r.id), ['r2', 'r3']);
  eq(c.splitSaved(list, '').mine.length, 0);
  eq(c.oneLine('  a\n b\t c ', 40), 'a b c');
});
test('device routes -> synced routes: R-2 shop start, a site start, a GPS start (never its position)', function () {
  const c = sandbox();
  const shopStart = { name: 'Old', when: '2026-09-20T15:00:00.000Z', rt: true,
    seq: [{ name: 'Shop', lat: 49.8401, lon: -97.2546, shop: true }, { name: 'A', lat: 49.89, lon: -97.13 }, { name: 'B', lat: 49.87, lon: -97.18, jobNumber: 702 }] };
  let r = c.localToSynced(shopStart, 'Tester');
  eq([r.start, r.owner, r.rt, r.seq.map((s) => s.name), r.seq[1].jobNumber], [{ mode: 'shop' }, 'Tester', true, ['A', 'B'], 702]);
  assert(SavedRoutes.ID_RE.test(r.id), 'a new id');
  eq(c.localMode(shopStart), 'shop');
  const r2Site = { name: 'R-2 site start', when: '2026-09-21T15:00:00.000Z', seq: [{ name: 'A', lat: 49.89, lon: -97.13 }, { name: 'B', lat: 49.87, lon: -97.18 }] };
  r = c.localToSynced(r2Site, '');
  eq([r.start, r.seq.length], [{ mode: 'stop' }, 2]); eq(c.localMode(r2Site), 'stop');
  const gps = { name: 'From me', when: '2026-09-30T15:00:00.000Z', start: { mode: 'gps' }, seq: [{ name: 'A', lat: 49.89, lon: -97.13 }] };
  r = c.localToSynced(gps, 'Tester');
  eq(r.start, { mode: 'gps' }); eq(c.localMode(gps), 'gps');
  eq(c.startForSave('gps'), { mode: 'gps' }); eq(c.startForSave('stop'), { mode: 'stop' }); eq(c.startForSave('x'), { mode: 'shop' });
  eq(c.localToSynced({ name: 'only the shop', seq: [{ name: 'Shop', lat: 49.8401, lon: -97.2546, shop: true }] }, ''), null, 'nothing to route');
  eq(c.localToSynced({ name: 'Toronto', seq: [{ name: 'T', lat: 43.6, lon: -79.4 }] }, ''), null, 'outside Manitoba');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
