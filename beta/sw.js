// EJ Beta RETIRE worker (2026-09-26): R-2 is now the main app at the site root (docs/r2-plan.md section 9 "Promotion").
// Hand-written, NOT generated (tools/build_beta.py refuses to overwrite a retired beta/ unless --force).
// A device that still has the old beta worker (scope /eckstein-jobs/beta/, caches "ejb-v1") fetches this file on its
// next visit to /beta/ (the browser's update check). It then: installs at once; on activate deletes the beta's
// caches ("ejb-v<N>"; never the main app's "ej-" caches or another project's), unregisters itself, and reloads the
// open /beta/ pages so they show the static notice without a worker. The reload goes to the scope URL with a unique
// ?retired= query: GitHub Pages sends max-age=600, so the same URL could come back as the HTTP-cached OLD beta page
// (which would register this worker again). No fetch handler: nothing is intercepted or cached any more.
'use strict';

const OURS = /^ejb-v\d+$/;

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  const scope = self.registration.scope;
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return OURS.test(k); })
        .map(function (k) { return caches.delete(k).catch(function () {}); }));
    }).catch(function () {})
      .then(function () { return self.registration.unregister().catch(function () {}); })
      .then(function () { return self.clients.matchAll({ type: 'window', includeUncontrolled: true }); })
      .then(function (list) {
        return Promise.all(list.filter(function (c) { return c.url.indexOf(scope) === 0; }).map(function (c) {
          try { return c.navigate(scope + '?retired=' + Date.now()).catch(function () {}); } catch (err) { return undefined; }
        }));
      })
      .catch(function () {})
  );
});
