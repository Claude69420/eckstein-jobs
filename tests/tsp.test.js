/* Tests for js/tsp.js - plain Node, no dependencies.
 * Run: node tests/tsp.test.js   (exit code 1 on any failure)
 *
 * The references below (haversine, brute force, Held-Karp) are written independently of
 * js/tsp.js so a shared bug cannot hide itself. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'js', 'tsp.js');
const TSP = require(SRC);

let passed = 0, failed = 0;
function test(name, fn) {
  const t0 = performance.now();
  const took = () => ' [' + ((performance.now() - t0) / 1000).toFixed(2) + ' s]';
  try {
    const info = fn();
    passed++;
    console.log('PASS  ' + name + (info ? '  (' + info + ')' : '') + took());
  } catch (err) {
    failed++;
    console.log('FAIL  ' + name + '  -> ' + (err && err.message ? err.message : err) + took());
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'values differ') + ': ' + a + ' vs ' + b);
}

/* ---------- independent references ---------- */

function mulberry(seed) {            // test-side PRNG for instance generation
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function refHav(a, b) {              // atan2 form, R = 6371 km
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function refCost(seq, rt) {
  let c = 0;
  for (let i = 1; i < seq.length; i++) c += refHav(seq[i - 1], seq[i]);
  if (rt && seq.length > 1) c += refHav(seq[seq.length - 1], seq[0]);
  return c;
}

function refMatrix(pts) {
  return pts.map(a => pts.map(b => refHav(a, b)));
}

/* Fixed indices for a mode: start (-1 if free) and end (-1 if free / ignored). */
function fixedIdx(n, mode) {
  return { s: mode.fs ? 0 : -1, e: mode.fe && !mode.rt ? n - 1 : -1 };
}

/* Plain brute force: every permutation of the free stops (all stops when nothing is fixed). */
function bruteForce(pts, mode) {
  const n = pts.length, D = refMatrix(pts), { s, e } = fixedIdx(n, mode);
  const freeIdx = [];
  for (let i = 0; i < n; i++) if (i !== s && i !== e) freeIdx.push(i);
  const used = freeIdx.map(() => false), seq = [];
  let best = Infinity;
  (function rec() {
    if (seq.length === freeIdx.length) {
      const order = (s >= 0 ? [s] : []).concat(seq, e >= 0 ? [e] : []);
      let c = 0;
      for (let i = 1; i < order.length; i++) c += D[order[i - 1]][order[i]];
      if (mode.rt) c += D[order[order.length - 1]][order[0]];
      if (c < best) best = c;
      return;
    }
    for (let k = 0; k < freeIdx.length; k++) {
      if (used[k]) continue;
      used[k] = true; seq.push(freeIdx[k]);
      rec();
      seq.pop(); used[k] = false;
    }
  })();
  return best;
}

/* Exact reference for larger instances: top-down Held-Karp ("cost to finish" memo).
 * A round trip without a fixed start is anchored at stop 0 (a cycle's length is rotation-free). */
function heldKarp(pts, mode) {
  const n = pts.length, D = refMatrix(pts);
  let { s, e } = fixedIdx(n, mode);
  if (mode.rt && s < 0) s = 0;
  const freeIdx = [];
  for (let i = 0; i < n; i++) if (i !== s && i !== e) freeIdx.push(i);
  const m = freeIdx.length, FULL = (1 << m) - 1;
  const memo = new Float64Array((FULL + 1) * m).fill(-1);
  function go(mask, j) {
    const u = freeIdx[j];
    if (mask === FULL) return (e >= 0 ? D[u][e] : 0) + (mode.rt ? D[u][s] : 0);
    const key = mask * m + j;
    if (memo[key] >= 0) return memo[key];
    let best = Infinity;
    for (let k = 0; k < m; k++) {
      if (mask & (1 << k)) continue;
      const v = D[u][freeIdx[k]] + go(mask | (1 << k), k);
      if (v < best) best = v;
    }
    memo[key] = best;
    return best;
  }
  let best = Infinity;
  for (let j = 0; j < m; j++) {
    const v = (s >= 0 ? D[s][freeIdx[j]] : 0) + go(1 << j, j);
    if (v < best) best = v;
  }
  return best;
}

/* ---------- instances ---------- */

const MODES = [
  { name: 'start fixed', fs: true, fe: false, rt: false },
  { name: 'start+end fixed', fs: true, fe: true, rt: false },
  { name: 'start fixed + return', fs: true, fe: false, rt: true },
  { name: 'fully open', fs: false, fe: false, rt: false },
  { name: 'end fixed only', fs: false, fe: true, rt: false },
  { name: 'return, start not fixed', fs: false, fe: false, rt: true },
  { name: 'start+end fixed + return (end ignored)', fs: true, fe: true, rt: true }
];
const MAIN_MODES = MODES.slice(0, 4);

function stopCount(freeCount, mode) {
  return freeCount + (mode.fs ? 1 : 0) + (mode.fe && !mode.rt ? 1 : 0);
}

/* Points in Winnipeg (lat 49.75..49.97, lon -97.35..-96.95); some instances get 1-2 stops
 * "around" Winnipeg (Selkirk / Steinbach / Portage / Altona range) to create rural legs. */
function makePoints(rng, n, withRural) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    let lat = 49.75 + rng() * 0.22, lon = -97.35 + rng() * 0.40;
    if (withRural && i > 0 && rng() < 0.2) { lat = 49.0 + rng() * 1.2; lon = -98.4 + rng() * 2.0; }
    pts.push({ lat, lon, id: i, name: 'Stop ' + i, jobNumber: 600 + i });
  }
  return pts;
}

/* Output is a permutation of the input's references, input untouched, fixed ends kept. */
function checkResult(input, snapshot, out, mode) {
  const n = input.length;
  assert(Array.isArray(out), 'result is not an array');
  assert(out !== input, 'result must be a new array');
  assert(out.length === n, 'length ' + out.length + ' != ' + n);
  for (let i = 0; i < n; i++) assert(input[i] === snapshot[i], 'input array was mutated');
  const want = new Map();
  input.forEach(p => want.set(p, (want.get(p) || 0) + 1));
  out.forEach(p => {
    assert(want.has(p), 'result contains an object that is not an input reference');
    want.set(p, want.get(p) - 1);
  });
  want.forEach((v) => assert(v === 0, 'a stop was lost or duplicated'));
  if (n >= 1 && mode.fs) assert(out[0] === input[0], 'fixed start moved');
  if (n >= 3 && mode.fe && !mode.rt) assert(out[n - 1] === input[n - 1], 'fixed end moved');
}

function runMode(pts, mode) {
  const snap = pts.slice();
  const out = TSP.optimize(pts, mode.fs, mode.fe, mode.rt);
  checkResult(pts, snap, out, mode);
  return out;
}

function nearestNeighbourKm(pts, rt) {        // naive baseline for reporting only
  const rest = pts.slice(1), seq = [pts[0]];
  while (rest.length) {
    const last = seq[seq.length - 1];
    let bi = 0;
    rest.forEach((p, i) => { if (refHav(last, p) < refHav(last, rest[bi])) bi = i; });
    seq.push(rest.splice(bi, 1)[0]);
  }
  return refCost(seq, rt);
}

/* ---------- tests ---------- */

// Performance first, so the first run is as cold (un-JITted) as it is in the app.
test('60 stops: < 300 ms per run and deterministic (3 runs, identical order)', () => {
  const rng = mulberry(60);
  const pts = makePoints(rng, 60, true);
  pts[0] = { lat: 49.8951, lon: -97.1384, id: 'shop', name: 'Shop', shop: true };
  const report = [];
  for (const mode of [MODES[0], MODES[2], MODES[3]]) {
    const times = [], orders = [];
    let out;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      out = runMode(pts, mode);
      times.push(performance.now() - t0);
      orders.push(out.map(p => p.id).join(','));
    }
    assert(orders[0] === orders[1] && orders[1] === orders[2], mode.name + ': order differs between runs');
    const worst = Math.max.apply(null, times);
    assert(worst < 300, mode.name + ': ' + worst.toFixed(1) + ' ms >= 300 ms');
    const km = refCost(out, mode.rt), nn = nearestNeighbourKm(pts, mode.rt);
    assert(km <= nn + 1e-9, mode.name + ': worse than plain nearest neighbour');
    report.push(mode.name + ' ' + times.map(t => t.toFixed(1)).join('/') + ' ms, ' +
      km.toFixed(1) + ' km vs NN ' + nn.toFixed(1));
  }
  return report.join('; ');
});

test('100 stops (headroom check): < 1000 ms', () => {
  const pts = makePoints(mulberry(100), 100, true);
  const t0 = performance.now();
  runMode(pts, MODES[0]);
  const ms = performance.now() - t0;
  assert(ms < 1000, ms.toFixed(1) + ' ms');
  return ms.toFixed(1) + ' ms';
});

test('loads as a plain browser script (global TSP, no module object)', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'tsp.js' });
  assert(ctx.TSP && typeof ctx.TSP.optimize === 'function', 'global TSP missing');
  ['hav', 'pathKm', 'optimize', 'inWinnipeg', 'legs', 'gmapsParts'].forEach(k =>
    assert(typeof ctx.TSP[k] === 'function', 'TSP.' + k + ' missing'));
});

test('hav: 1 degree of latitude = 111.195 km, symmetric, zero for the same point', () => {
  const a = { lat: 49, lon: -97 }, b = { lat: 50, lon: -97 }, c = { lat: 49.8951, lon: -97.1384 };
  near(TSP.hav(a, b), 6371 * Math.PI / 180, 1e-9, '1 degree');
  near(TSP.hav(a, c), TSP.hav(c, a), 1e-12, 'symmetry');
  assert(TSP.hav(c, c) === 0, 'same point');
  const rng = mulberry(7);
  for (let i = 0; i < 500; i++) {
    const p = makePoints(rng, 2, true);
    near(TSP.hav(p[0], p[1]), refHav(p[0], p[1]), 1e-9, 'vs reference');
  }
});

test('pathKm: sum of legs, closing leg only when rt', () => {
  const [a, b, c] = makePoints(mulberry(3), 3, false);
  near(TSP.pathKm([a, b, c], false), refHav(a, b) + refHav(b, c), 1e-9, 'open');
  near(TSP.pathKm([a, b, c], true), refHav(a, b) + refHav(b, c) + refHav(c, a), 1e-9, 'round trip');
  assert(TSP.pathKm([a], true) === 0 && TSP.pathKm([], true) === 0, 'degenerate');
});

test('reference Held-Karp agrees with brute force (validates the reference)', () => {
  const rng = mulberry(11);
  let count = 0;
  for (let m = 3; m <= 7; m++) {
    for (const mode of MODES) {
      for (let k = 0; k < 4; k++) {
        const pts = makePoints(rng, stopCount(m, mode), k % 2 === 1);
        near(heldKarp(pts, mode), bruteForce(pts, mode), 1e-9, mode.name + ' m=' + m);
        count++;
      }
    }
  }
  return count + ' instances';
});

test('exact optimum for 3..8 free stops in every mode (vs brute force, 1e-9 km)', () => {
  const rng = mulberry(2026);
  let count = 0, worstGap = 0;
  const perMode = {};
  for (const mode of MODES) {
    perMode[mode.name] = 0;
    for (let m = 3; m <= 8; m++) {
      const reps = m <= 6 ? 40 : m === 7 ? 20 : 10;
      for (let k = 0; k < reps; k++) {
        const pts = makePoints(rng, stopCount(m, mode), k % 3 === 2);
        const out = runMode(pts, mode);
        const got = refCost(out, mode.rt), best = bruteForce(pts, mode);
        near(TSP.pathKm(out, mode.rt), got, 1e-9, 'pathKm vs reference cost');
        const gap = got - best;
        if (gap > worstGap) worstGap = gap;
        assert(gap <= 1e-9, mode.name + ', ' + m + ' free: ' + got + ' km vs optimum ' + best);
        count++;
        perMode[mode.name]++;
      }
    }
  }
  return count + ' instances across ' + MODES.length + ' modes, worst gap ' + worstGap.toExponential(1) + ' km';
});

test('heuristic (9..12 free stops) within 3% of the exact optimum', () => {
  const rng = mulberry(9001);
  let worst = 1, count = 0, optimal = 0, worstAt = '';
  for (const mode of MODES) {
    for (let m = 9; m <= 12; m++) {
      for (let k = 0; k < 12; k++) {
        const pts = makePoints(rng, stopCount(m, mode), k % 3 === 2);
        const out = runMode(pts, mode);
        const ratio = refCost(out, mode.rt) / heldKarp(pts, mode);
        if (ratio > worst) { worst = ratio; if (ratio > 1 + 1e-9) worstAt = mode.name + ', ' + m + ' free'; }
        if (ratio < 1 + 1e-9) optimal++;
        count++;
      }
    }
  }
  assert(worst <= 1.03, 'worst ratio ' + worst.toFixed(4) + ' at ' + worstAt);
  return 'worst ratio ' + worst.toFixed(4) + (worstAt ? ' (' + worstAt + ')' : '') + ', ' +
    optimal + '/' + count + ' exactly optimal';
});

test('heuristic (14 and 16 free stops) within 3% of the exact optimum', () => {
  const rng = mulberry(1416);
  let worst = 1, count = 0, optimal = 0;
  for (const mode of MAIN_MODES) {
    for (const m of [14, 16]) {
      for (let k = 0; k < 2; k++) {
        const pts = makePoints(rng, stopCount(m, mode), k === 1);
        const ratio = refCost(runMode(pts, mode), mode.rt) / heldKarp(pts, mode);
        worst = Math.max(worst, ratio);
        if (ratio < 1 + 1e-9) optimal++;
        count++;
      }
    }
  }
  assert(worst <= 1.03, 'worst ratio ' + worst.toFixed(4));
  return 'worst ratio ' + worst.toFixed(4) + ', ' + optimal + '/' + count + ' exactly optimal';
});

test('fewer than 3 stops: a copy with the same references', () => {
  const [a, b] = makePoints(mulberry(1), 2, false);
  for (const input of [[], [a], [a, b], [b, a]]) {
    for (const mode of MODES) {
      const out = TSP.optimize(input, mode.fs, mode.fe, mode.rt);
      assert(out !== input && out.length === input.length, 'not a copy');
      out.forEach((p, i) => assert(p === input[i], 'order or reference changed'));
    }
  }
});

test('fixed start / fixed end / return semantics', () => {
  // S at the west end; A, B, C due east at 0.1 degree steps. Input order puts B last.
  const S = { lat: 49.80, lon: -97.30, id: 'S' }, A = { lat: 49.80, lon: -97.20, id: 'A' };
  const B = { lat: 49.80, lon: -97.10, id: 'B' }, C = { lat: 49.80, lon: -97.00, id: 'C' };
  const ids = seq => seq.map(p => p.id).join('');
  assert(ids(TSP.optimize([S, A, C, B], true, false, false)) === 'SABC', 'start fixed');
  assert(ids(TSP.optimize([S, A, C, B], true, true, false)) === 'SACB', 'start+end fixed keeps B last');
  const open = ids(TSP.optimize([B, S, C, A], false, false, false));
  assert(open === 'SABC' || open === 'CBAS', 'fully open should run end to end, got ' + open);
  assert(ids(TSP.optimize([A, S, C, B], false, true, false)) === 'SACB', 'end fixed only');
  // Return to start: a fixed end is ignored, so B (input last) must not stay last.
  const rtEnd = TSP.optimize([S, A, C, B], true, true, true);
  const rtNoEnd = TSP.optimize([S, A, C, B], true, false, true);
  assert(ids(rtEnd) === ids(rtNoEnd), 'fixedEnd must be ignored when returnToStart');
  assert(rtEnd[0] === S && rtEnd[3] !== B, 'round trip should be S-A-B-C or S-C-B-A, got ' + ids(rtEnd));
  near(TSP.pathKm(rtEnd, true), refCost([S, A, B, C], true), 1e-9, 'round trip length');
  // Same checks on random instances large enough for the heuristic path.
  const rng = mulberry(77);
  for (const mode of MODES) {
    for (let k = 0; k < 5; k++) runMode(makePoints(rng, 25 + k * 7, k % 2 === 0), mode);
  }
});

test('same references back: extra properties, duplicates and identical coordinates', () => {
  const rng = mulberry(5);
  const pts = makePoints(rng, 7, false);
  pts.forEach(p => { p.extra = { keep: p.id }; });
  const twin = { lat: pts[2].lat, lon: pts[2].lon, id: 'twin' };          // same place, other object
  const withDup = [pts[0], pts[1], pts[2], pts[3], pts[1], twin, pts[4], pts[5], pts[6]];
  const big = withDup.concat(makePoints(rng, 12, true), [pts[3]]);      // heuristic path, dup at end
  for (const input of [withDup, big]) {
    for (const mode of MODES) {
      const out = runMode(input, mode);
      out.forEach(p => assert(!p.extra || p.extra.keep === p.id, 'properties changed'));
    }
  }
});

test('non-numeric coordinates never lose a stop (robustness)', () => {
  const rng = mulberry(9);
  for (const n of [5, 14]) {
    const pts = makePoints(rng, n, false);
    pts[2] = { lat: NaN, lon: undefined, id: 'bad' };
    for (const mode of MODES) runMode(pts, mode);
  }
});

test('legs: km = hav x 1.39, 40 km/h urban / 70 km/h rural rule, closing leg when rt', () => {
  const shop = { lat: 49.8951, lon: -97.1384 };
  const altona = { lat: 49.1044, lon: -97.5594 };
  const wpgSW = { lat: 49.72, lon: -97.35 }, wpgNE = { lat: 49.99, lon: -96.95 };
  const inside = { lat: 49.75, lon: -97.0 };
  const out16 = { lat: 49.75 - (16 / 1.39) / (6371 * Math.PI / 180), lon: -97.0 };  // 16 road km south
  const out14 = { lat: 49.75 - (14 / 1.39) / (6371 * Math.PI / 180), lon: -97.0 };  // 14 road km south
  assert(TSP.inWinnipeg(shop) && TSP.inWinnipeg(wpgSW) && TSP.inWinnipeg(wpgNE), 'inside points');
  assert(!TSP.inWinnipeg(altona) && !TSP.inWinnipeg(out16) && !TSP.inWinnipeg(out14), 'outside points');
  assert(TSP.WPG.s === 49.71 && TSP.WPG.n === 50.00 && TSP.WPG.w === -97.36 && TSP.WPG.e === -96.94, 'WPG box');

  const check = (a, b, rural) => {
    const [l] = TSP.legs([a, b], false);
    assert(l.from === a && l.to === b, 'from/to must be the same references');
    near(l.hkm, refHav(a, b), 1e-9, 'hkm');
    near(l.km, refHav(a, b) * 1.39, 1e-9, 'km');
    assert(l.rural === rural, 'rural flag for ' + l.km.toFixed(2) + ' km should be ' + rural);
    near(l.min, l.km / (rural ? 70 : 40) * 60, 1e-9, 'minutes');
    return l;
  };
  const longCity = check(wpgSW, wpgNE, false);                // > 15 km but both ends inside: 40 km/h
  assert(longCity.km > 15, 'long city leg should be > 15 km');
  check(shop, altona, true);                                   // out of town: 70 km/h
  check(altona, shop, true);
  const l16 = check(inside, out16, true);                      // > 15 km, one end outside
  const l14 = check(inside, out14, false);                     // <= 15 km: still 40 km/h
  near(l16.km, 16, 1e-3, '16 km leg');
  near(l14.km, 14, 1e-3, '14 km leg');

  const seq = [shop, wpgSW, altona, wpgNE];
  const open = TSP.legs(seq, false), round = TSP.legs(seq, true);
  assert(open.length === 3 && round.length === 4, 'leg counts ' + open.length + '/' + round.length);
  assert(round[3].from === wpgNE && round[3].to === shop, 'closing leg goes back to the start');
  near(open.reduce((s, l) => s + l.km, 0), TSP.pathKm(seq, false) * 1.39, 1e-9, 'open total');
  near(round.reduce((s, l) => s + l.km, 0), TSP.pathKm(seq, true) * 1.39, 1e-9, 'round total');
  assert(TSP.legs([shop], true).length === 0 && TSP.legs([], false).length === 0, 'degenerate');
});

test('gmapsParts: <= 10 points per part, overlapping endpoints, rt, URL format', () => {
  const URL_RE = /^https:\/\/www\.google\.com\/maps\/dir\/(-?\d+(\.\d{1,6})?,-?\d+(\.\d{1,6})?)(\/-?\d+(\.\d{1,6})?,-?\d+(\.\d{1,6})?)*$/;
  const fmt = x => String(Number(x.toFixed(6)));
  const parse = url => url.slice('https://www.google.com/maps/dir/'.length).split('/');
  const line = n => Array.from({ length: n }, (_, i) => ({ lat: 49.8 + i * 0.001234567, lon: -97.1 - i * 0.002345678 }));
  const expectParts = p => (p <= 10 ? 1 : Math.ceil((p - 1) / 9));

  const report = [];
  for (const [n, rt] of [[1, false], [10, false], [11, false], [19, false], [20, false], [61, false],
    [5, true], [9, true], [10, true], [19, true], [60, true]]) {
    const seq = line(n), pts = rt && n > 1 ? seq.concat([seq[0]]) : seq;
    const urls = TSP.gmapsParts(seq, rt);
    assert(urls.length === expectParts(pts.length), n + ' stops rt=' + rt + ': ' + urls.length + ' parts');
    const joined = [];
    urls.forEach((u, k) => {
      assert(URL_RE.test(u), 'bad URL format: ' + u);
      const parts = parse(u);
      assert(parts.length <= 10, 'part has ' + parts.length + ' points');
      if (pts.length > 1) assert(parts.length >= 2, 'part with a single point');
      if (k > 0) {
        const prev = parse(urls[k - 1]);
        assert(parts[0] === prev[prev.length - 1], 'part ' + (k + 1) + ' must start at the previous end');
        parts.shift();
      }
      joined.push.apply(joined, parts);
    });
    const want = pts.map(p => fmt(p.lat) + ',' + fmt(p.lon));
    assert(joined.join('/') === want.join('/'), n + ' stops: parts do not rebuild the full route');
    if (rt && n > 1) {
      const last = parse(urls[urls.length - 1]);
      assert(last[last.length - 1] === want[0], 'round trip must end at the start point');
    }
    report.push(pts.length + 'pt->' + urls.length);
  }
  const [u] = TSP.gmapsParts([{ lat: 49.123456789, lon: -97.987654321 }, { lat: 49.8, lon: -97 }], false);
  assert(u === 'https://www.google.com/maps/dir/49.123457,-97.987654/49.8,-97', 'rounding / format: ' + u);
  assert(TSP.gmapsParts([], false).length === 0 && TSP.gmapsParts([], true).length === 0, 'empty route');
  return report.join(' ');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
