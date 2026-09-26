/* Eckstein Jobs - route optimizer, leg estimates and Google Maps link chunking (R-1).
 *
 * Plain browser script (defines the global `TSP`) that also loads in Node for tests
 * (`module.exports`). No dependencies, no build step, ES2017.
 *
 * Points are objects with numeric `lat` and `lon`; other properties are left untouched and
 * every function returns the SAME object references it was given (never copies).
 *
 *   TSP.hav(a, b)                         great-circle km (R = 6371)
 *   TSP.pathKm(seq, rt)                   sum of hav over the legs (+ closing leg when rt)
 *   TSP.optimize(stops, fixedStart, fixedEnd, returnToStart)
 *                                         shortest visiting order (a new array)
 *   TSP.WPG, TSP.inWinnipeg(p)            the Winnipeg box used by the rural-leg rule
 *   TSP.legs(seq, rt)                     per-leg ~km / ~min estimates (no live traffic)
 *   TSP.gmapsParts(seq, rt)               Google Maps /dir/ URLs of at most 10 points each
 *
 * optimize():
 *   - fewer than 3 stops: a copy of the input;
 *   - fixedStart keeps stops[0] first; fixedEnd keeps stops[last] last (ignored when
 *     returnToStart); returnToStart adds the closing leg (last -> first) to the objective.
 *     A round trip without a fixed start is rotation-invariant, so stops[0] is used as the
 *     anchor (it comes back first);
 *   - <= 8 free stops: exact optimum (Held-Karp dynamic programming, O(2^m * m^2));
 *   - more: nearest-neighbour seed, then 2-opt + or-opt (segments of 1-3, both directions)
 *     local search, iterated with double-bridge kicks and a few restarts from randomized
 *     nearest-neighbour tours. Every random choice comes from a seeded PRNG (mulberry32),
 *     so the same input always gives the same order. ~25-70 ms for 60 stops on a PC.
 */
var TSP = (function () {
  'use strict';

  var R_KM = 6371;
  var RAD = Math.PI / 180;
  var ROAD_FACTOR = 1.39;     // haversine km -> estimated road km (APP_MASTER rule 6)
  var URBAN_KMH = 40;
  var RURAL_KMH = 70;
  var RURAL_MIN_KM = 15;      // rural leg: road km > 15 and at least one end outside WPG
  var EXACT_MAX = 8;          // free stops solved exactly
  var MAPS_MAX_POINTS = 10;   // Google Maps /dir/ URL: origin + up to 9 more points
  var EPS = 1e-9;             // km; a move must improve by more than this
  var BAD_KM = 1e5;           // stand-in for a distance involving non-numeric coordinates
  var RESTARTS = 4;           // local-search restarts (1 plain NN + randomized NN seeds)
  var WPG = Object.freeze({ s: 49.71, n: 50.00, w: -97.36, e: -96.94 });

  /* ---------- geometry ---------- */

  function hav(a, b) {
    var sLat = Math.sin((b.lat - a.lat) * RAD / 2);
    var sLon = Math.sin((b.lon - a.lon) * RAD / 2);
    var h = sLat * sLat + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * sLon * sLon;
    if (h > 1) h = 1;
    return 2 * R_KM * Math.asin(Math.sqrt(h));
  }

  function pathKm(seq, rt) {
    var n = seq ? seq.length : 0, s = 0;
    for (var i = 0; i + 1 < n; i++) s += hav(seq[i], seq[i + 1]);
    if (rt && n > 1) s += hav(seq[n - 1], seq[0]);
    return s;
  }

  function inWinnipeg(p) {
    return !!p && p.lat >= WPG.s && p.lat <= WPG.n && p.lon >= WPG.w && p.lon <= WPG.e;
  }

  /* Symmetric distance matrix, D[i * n + j]. */
  function matrix(pts) {
    var n = pts.length, D = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var d = hav(pts[i], pts[j]);
        if (!(d >= 0 && d < BAD_KM)) d = BAD_KM;   // NaN/undefined coordinates: keep it a valid tour
        D[i * n + j] = d;
        D[j * n + i] = d;
      }
    }
    return D;
  }

  /* Deterministic PRNG (mulberry32). */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- exact solver (Held-Karp) ----------
   * c = {D, n, s, e, rt}: s / e are the fixed first / last indices or -1.
   * Returns the visiting order as indices into the stop list. */
  function exact(c, free) {
    var D = c.D, n = c.n, s = c.s, e = c.e, rt = c.rt;
    var m = free.length, full = (1 << m) - 1, size = (full + 1) * m;
    var dp = new Float64Array(size), par = new Int8Array(size);
    var mask, j, k;
    for (var x = 0; x < size; x++) { dp[x] = Infinity; par[x] = -1; }
    for (j = 0; j < m; j++) dp[(1 << j) * m + j] = s >= 0 ? D[s * n + free[j]] : 0;
    for (mask = 1; mask <= full; mask++) {
      for (j = 0; j < m; j++) {
        if (!(mask & (1 << j))) continue;
        var cur = dp[mask * m + j];
        if (cur === Infinity) continue;
        var row = free[j] * n;
        for (k = 0; k < m; k++) {
          if (mask & (1 << k)) continue;
          var idx = (mask | (1 << k)) * m + k, v = cur + D[row + free[k]];
          if (v < dp[idx]) { dp[idx] = v; par[idx] = j; }
        }
      }
    }
    var best = Infinity, bj = 0;
    for (j = 0; j < m; j++) {
      var total = dp[full * m + j];
      if (e >= 0) total += D[free[j] * n + e];
      if (rt) total += D[free[j] * n + s];
      if (total < best) { best = total; bj = j; }
    }
    var mid = [];
    mask = full;
    j = bj;
    while (j >= 0) {
      mid.push(free[j]);
      var p = par[mask * m + j];
      mask &= ~(1 << j);
      j = p;
    }
    mid.reverse();
    return (s >= 0 ? [s] : []).concat(mid, e >= 0 ? [e] : []);
  }

  /* ---------- heuristic ----------
   * A tour t is an array of n stop indices. Positions lo..hi may move; t[0] is the fixed
   * start when s >= 0 and t[n-1] the fixed end when e >= 0. With rt the closing leg
   * t[n-1] -> t[0] counts (rt always has a start, fixed or anchored). */

  function tourCost(c, t) {
    var D = c.D, n = c.n, sum = 0;
    for (var i = 0; i + 1 < n; i++) sum += D[t[i] * n + t[i + 1]];
    if (c.rt) sum += D[t[n - 1] * n + t[0]];
    return sum;
  }

  /* Nearest-neighbour path from `start` over `pool` (ties -> earlier in pool). With rnd,
   * each step picks among the 3 nearest (weighted towards the nearest). */
  function nnPath(c, start, pool, rnd) {
    var D = c.D, n = c.n, rest = pool.slice(), cur = start;
    if (cur < 0) cur = rest.splice(rnd ? Math.floor(rnd() * rest.length) : 0, 1)[0];
    var path = [cur];
    while (rest.length) {
      var row = cur * n, b0 = -1, b1 = -1, b2 = -1, d0 = Infinity, d1 = Infinity, d2 = Infinity;
      for (var i = 0; i < rest.length; i++) {
        var d = D[row + rest[i]];
        if (d < d0) { b2 = b1; d2 = d1; b1 = b0; d1 = d0; b0 = i; d0 = d; }
        else if (d < d1) { b2 = b1; d2 = d1; b1 = i; d1 = d; }
        else if (d < d2) { b2 = i; d2 = d; }
      }
      var pick = b0;
      if (rnd) {
        var r = rnd();
        if (r > 0.9 && b2 >= 0) pick = b2;
        else if (r > 0.65 && b1 >= 0) pick = b1;
      }
      cur = rest.splice(pick, 1)[0];
      path.push(cur);
    }
    if (c.e >= 0) path.push(c.e);
    return path;
  }

  function seedTour(c, free, rnd) {
    if (c.s >= 0 || rnd) return nnPath(c, c.s, free, rnd);
    // Open start: try every free stop as the first one, keep the shortest.
    var best = null, bestCost = Infinity;
    for (var i = 0; i < free.length; i++) {
      var pool = free.slice(0, i).concat(free.slice(i + 1));
      var t = nnPath(c, -1, [free[i]].concat(pool), null);
      var cost = tourCost(c, t);
      if (cost < bestCost - EPS) { best = t; bestCost = cost; }
    }
    return best;
  }

  function reverse(t, i, k) {
    while (i < k) { var tmp = t[i]; t[i] = t[k]; t[k] = tmp; i++; k--; }
  }

  /* 2-opt: reverse t[i..k]. D is symmetric, so only the two boundary edges change. */
  function twoOpt(c, t) {
    var D = c.D, n = c.n, rt = c.rt, lo = c.lo, hi = c.hi, improved = false;
    for (var i = lo; i < hi; i++) {
      var a = i > 0 ? t[i - 1] : -1;
      for (var k = i + 1; k <= hi; k++) {
        var b = k < n - 1 ? t[k + 1] : (rt ? t[0] : -1);
        var ti = t[i], tk = t[k], delta = 0;
        if (a >= 0) delta += D[a * n + tk] - D[a * n + ti];
        if (b >= 0) delta += D[ti * n + b] - D[tk * n + b];
        if (delta < -EPS) { reverse(t, i, k); improved = true; }
      }
    }
    return improved;
  }

  /* Or-opt: move a segment of 1-3 stops (either direction) to its best other gap. */
  function orOpt(c, t) {
    var D = c.D, n = c.n, rt = c.rt, lo = c.lo, hi = c.hi, improved = false;
    for (var len = 1; len <= 3; len++) {
      var R = n - len;                                  // stops left after removing the segment
      var glo = c.s >= 0 ? 1 : 0, ghi = c.e >= 0 ? R - 1 : R;
      for (var i = lo; i + len - 1 <= hi; i++) {
        var j = i + len - 1;
        var a = i > 0 ? t[i - 1] : -1;
        var b = j < n - 1 ? t[j + 1] : (rt ? t[0] : -1);
        if (a < 0 && b < 0) continue;
        var f = t[i], g = t[j];
        var gain = (a >= 0 ? D[a * n + f] : 0) + (b >= 0 ? D[g * n + b] : 0) -
          (a >= 0 && b >= 0 ? D[a * n + b] : 0);
        var bestDelta = -EPS, bestGap = -1, bestRev = false;
        for (var gp = glo; gp <= ghi; gp++) {
          if (gp === i) continue;                          // the segment's own gap
          // Gap gp sits between r[gp-1] and r[gp] of the list without the segment.
          var p = gp > 0 ? t[gp - 1 < i ? gp - 1 : gp - 1 + len] : -1;
          var q = gp < R ? t[gp < i ? gp : gp + len] : (rt ? t[0] : -1);
          var base = p >= 0 && q >= 0 ? D[p * n + q] : 0;
          var fwd = (p >= 0 ? D[p * n + f] : 0) + (q >= 0 ? D[g * n + q] : 0) - base - gain;
          if (fwd < bestDelta) { bestDelta = fwd; bestGap = gp; bestRev = false; }
          if (len > 1) {
            var rev = (p >= 0 ? D[p * n + g] : 0) + (q >= 0 ? D[f * n + q] : 0) - base - gain;
            if (rev < bestDelta) { bestDelta = rev; bestGap = gp; bestRev = true; }
          }
        }
        if (bestGap >= 0) {
          var seg = t.splice(i, len);
          if (bestRev) seg.reverse();
          Array.prototype.splice.apply(t, [bestGap, 0].concat(seg));
          improved = true;
        }
      }
    }
    return improved;
  }

  /* 2-opt to convergence (cheap: n^2/2 checks), then one or-opt pass (~3n^2); repeat until
   * neither finds anything. Every accepted move gains > EPS, so this always ends. */
  function localSearch(c, t) {
    for (var pass = 0; pass < 1000; pass++) {
      for (var k = 0; k < 1000 && twoOpt(c, t); k++) { /* until no 2-opt move helps */ }
      if (!orOpt(c, t)) break;
    }
    return t;
  }

  /* Double-bridge kick on the movable range: A B C D -> A C B D. */
  function doubleBridge(c, t, rnd) {
    var span = c.hi - c.lo, cut = [];
    while (cut.length < 3) {
      var x = c.lo + 1 + Math.floor(rnd() * span);
      if (cut.indexOf(x) < 0) cut.push(x);
    }
    cut.sort(function (u, v) { return u - v; });
    return t.slice(0, cut[0]).concat(t.slice(cut[1], cut[2]), t.slice(cut[0], cut[1]), t.slice(cut[2]));
  }

  function heuristic(c, free) {
    var n = c.n;
    var rnd = mulberry32(0x2545F491 ^ Math.imul(n, 0x9E3779B1));
    // Kicks per restart: plenty for small routes, bounded work (each local search is ~n^2) for
    // big ones: 40 up to ~36 stops, 15 at 60, 5 at 100, 2 from ~165.
    var kicks = Math.max(2, Math.min(40, Math.round(54000 / (n * n))));
    var best = null, bestCost = Infinity;
    for (var r = 0; r < RESTARTS; r++) {
      var cur = localSearch(c, seedTour(c, free, r === 0 ? null : rnd));
      var curCost = tourCost(c, cur);
      for (var k = 0; k < kicks; k++) {
        var cand = localSearch(c, doubleBridge(c, cur, rnd));
        var candCost = tourCost(c, cand);
        if (candCost < curCost - EPS) { cur = cand; curCost = candCost; }
      }
      if (curCost < bestCost - EPS) { best = cur; bestCost = curCost; }
    }
    return best;
  }

  function isValidOrder(order, n, s, e) {
    if (!order || order.length !== n) return false;
    var seen = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var v = order[i];
      if (!(v >= 0 && v < n) || seen[v]) return false;
      seen[v] = 1;
    }
    return (s < 0 || order[0] === s) && (e < 0 || order[n - 1] === e);
  }

  function optimize(stops, fixedStart, fixedEnd, returnToStart) {
    var list = stops ? Array.prototype.slice.call(stops) : [];
    var n = list.length;
    if (n < 3) return list;
    var rt = !!returnToStart;
    var s = (fixedStart || rt) ? 0 : -1;             // round trip: anchor stops[0] (rotation-invariant)
    var e = (fixedEnd && !rt) ? n - 1 : -1;
    var free = [];
    for (var i = 0; i < n; i++) if (i !== s && i !== e) free.push(i);
    var c = { D: matrix(list), n: n, s: s, e: e, rt: rt, lo: s >= 0 ? 1 : 0, hi: e >= 0 ? n - 2 : n - 1 };
    var order = free.length <= EXACT_MAX ? exact(c, free) : heuristic(c, free);
    if (!isValidOrder(order, n, s, e)) return list;    // defensive: never lose or duplicate a stop
    var out = new Array(n);
    for (i = 0; i < n; i++) out[i] = list[order[i]];
    return out;
  }

  /* ---------- estimates ---------- */

  function legs(seq, rt) {
    var n = seq ? seq.length : 0, out = [];
    function leg(a, b) {
      var hkm = hav(a, b), km = hkm * ROAD_FACTOR;
      var rural = km > RURAL_MIN_KM && (!inWinnipeg(a) || !inWinnipeg(b));
      return { from: a, to: b, hkm: hkm, km: km, min: km / (rural ? RURAL_KMH : URBAN_KMH) * 60, rural: rural };
    }
    for (var i = 0; i + 1 < n; i++) out.push(leg(seq[i], seq[i + 1]));
    if (rt && n > 1) out.push(leg(seq[n - 1], seq[0]));
    return out;
  }

  /* ---------- Google Maps ---------- */

  function coord(x) {
    var v = Number(Number(x).toFixed(6));             // at most 6 decimals, no trailing zeros
    return String(v === 0 ? 0 : v);                   // never "-0"
  }

  function dirUrl(pts) {
    return 'https://www.google.com/maps/dir/' + pts.map(function (p) {
      return coord(p.lat) + ',' + coord(p.lon);
    }).join('/');
  }

  /* One URL for <= 10 points; otherwise consecutive parts of <= 10 points where each part
   * starts at the previous part's last point. rt appends seq[0] (only for 2+ stops, like legs). */
  function gmapsParts(seq, rt) {
    var pts = seq ? Array.prototype.slice.call(seq) : [];
    if (rt && pts.length > 1) pts.push(pts[0]);
    var urls = [];
    if (!pts.length) return urls;
    var start = 0;
    for (;;) {
      var end = Math.min(start + MAPS_MAX_POINTS, pts.length);
      urls.push(dirUrl(pts.slice(start, end)));
      if (end >= pts.length) break;
      start = end - 1;                                 // next part starts where this one ends
    }
    return urls;
  }

  return {
    hav: hav,
    pathKm: pathKm,
    optimize: optimize,
    WPG: WPG,
    inWinnipeg: inWinnipeg,
    legs: legs,
    gmapsParts: gmapsParts,
    ROAD_FACTOR: ROAD_FACTOR,
    URBAN_KMH: URBAN_KMH,
    RURAL_KMH: RURAL_KMH,
    RURAL_MIN_KM: RURAL_MIN_KM,
    EXACT_MAX: EXACT_MAX,
    MAPS_MAX_POINTS: MAPS_MAX_POINTS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TSP;
