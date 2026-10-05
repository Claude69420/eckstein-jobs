// Eckstein Jobs service worker (cache "ej-v5", R-3.1 soft update 2026-10-04; "ej-v4" in R-3, "ej-v3" in R-2).
// - Same-origin GET: network-first so twice-daily data and new deploys always show; offline falls back
//   to the last good copy of that PATH (stored without the query string; matched with ignoreSearch,
//   so the app's ?t= cache-busters never grow the cache). No slow-network timer (it could mix app versions).
// - unpkg.com (version-pinned Leaflet): cache-first, so the map still starts offline. SRI is still
//   checked by the page against whatever we return.
// - Every other cross-origin request (GitHub API / raw, Esri tiles, geocoders...) is NOT intercepted:
//   no respondWith, straight to the network, never cached. Stage data, saved routes (routes.json, R-3) and the edit key never touch
//   this cache. data/prices.json (R-2) is same-origin and ENCRYPTED: its last good copy is kept like any
//   data file, so prices still decrypt offline; the pricing key itself never reaches this worker.
// - Install precaches the app shell tolerantly (a missing file never fails install); activate deletes
//   only OUR old caches (name starts with PREFIX and is not C: R-3's ej-v4, R-2's ej-v3, R-1's ej-v2 and older ej-v1 go) and then claims
//   open pages. Never an "ejb-" cache: those belong to the retired beta at /beta/ (R-2 promoted 2026-09-26), whose
//   retire worker (beta/sw.js) and notice page delete them and unregister the beta worker ("ejb-v1" does not start
//   with "ej-"). This worker's scope (/eckstein-jobs/) also covers /beta/ once the beta worker is gone: harmless,
//   the notice page is then just cached network-first like any page.
'use strict';

const C = 'ej-v5';
const PREFIX = 'ej-';

const SHELL = [
  './',
  'index.html',
  'css/tokens.css',
  'css/glass.css',
  'css/components.css',
  'js/tsp.js',
  'js/stages.js',
  'js/prices.js',
  'js/routes.js',                // R-3: synced saved routes (SavedRoutes)
  'js/ui.js',
  'js/app.js',
  'manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'vendor/hyalite.js'            // optional: only loaded behind the desktop refraction gate
];

const CDN = [                    // must match the <link>/<script> URLs in index.html to be useful offline
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

const NEVER = ['api.github.com', 'raw.githubusercontent.com'];

function pathKey(url) {          // same-origin cache key: origin + path, no query, no hash
  const u = new URL(url, self.location.href);
  return u.origin + u.pathname;
}

function cacheable(r, types) {   // full 200 only (never 206/opaque), never a redirected response:
  return !!r && r.status === 200 && !r.redirected && types.indexOf(r.type) !== -1;   // Safari rejects those for navigations
}

function safePut(cache, key, response) {
  return cache.put(key, response).catch(function () {});   // quota / Vary:* etc. must never break a fetch
}

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(function (cache) {
    const shell = SHELL.map(function (p) {
      return fetch(new Request(p, { cache: 'reload' })).then(function (r) {
        if (cacheable(r, ['basic'])) return safePut(cache, pathKey(r.url || p), r);
      }).catch(function () {});                              // missing / offline: skip, install still succeeds
    });
    const cdn = CDN.map(function (u) {
      return fetch(new Request(u, { mode: 'cors', credentials: 'omit', cache: 'reload' })).then(function (r) {
        if (cacheable(r, ['cors'])) return safePut(cache, u, r);
      }).catch(function () {});
    });
    return Promise.all(shell.concat(cdn));
  }).catch(function () {}));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== C; }).map(function (k) { return caches.delete(k); }));
  }).catch(function () {}).then(function () { return self.clients.claim(); }));
});

function cachedCopy(req, u) {    // last good copy of this path (the scope root and index.html are the same page)
  return caches.open(C).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      const scope = new URL('./', self.location.href).pathname;
      if (req.mode === 'navigate' && (u.pathname === scope || u.pathname === scope + 'index.html')) {
        return c.match(u.origin + scope).then(function (h) { return h || c.match(u.origin + scope + 'index.html'); });
      }
      return undefined;
    });
  }).catch(function () { return undefined; });
}

function networkFirst(e, u) {
  const req = e.request;
  const key = u.origin + u.pathname;
  const net = fetch(req).then(function (r) {
    if (cacheable(r, ['basic'])) {
      const copy = r.clone();
      try { e.waitUntil(caches.open(C).then(function (c) { return safePut(c, key, copy); })); } catch (err) {}
    }
    return r;
  });
  // Plain network-first for everything same-origin (page, css, js, data). No "slow network" timer: serving a
  // cached page while fresh css/js arrive (or the reverse) could mix two app versions right after a deploy.
  return net.catch(function () { return cachedCopy(req, u).then(function (hit) { return hit || Response.error(); }); });
}

function cdnCacheFirst(e) {
  const req = e.request;
  return caches.open(C).then(function (c) {
    return c.match(req, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (r) {
        if (cacheable(r, ['cors', 'basic'])) {
          try { e.waitUntil(safePut(c, req, r.clone())); } catch (err) {}
        }
        return r;
      });
    });
  }, function () { return fetch(req); });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  let u;
  try { u = new URL(req.url); } catch (err) { return; }
  if (NEVER.indexOf(u.hostname) !== -1) return;              // stage data: never intercepted, never cached
  if (u.origin === self.location.origin) { e.respondWith(networkFirst(e, u)); return; }
  // Only version-pinned unpkg files (".../pkg@1.2.3/...") are immutable enough for cache-first.
  if (u.hostname === 'unpkg.com' && /@\d/.test(u.pathname)) { e.respondWith(cdnCacheFirst(e)); return; }
  // Everything else cross-origin: no respondWith, the browser goes straight to the network.
});
