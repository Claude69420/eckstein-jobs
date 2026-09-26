/* app.js — Eckstein Jobs app logic (R-1): data, stages, Client|Stage filters, pins, list, detail + hover card,
 * stage moves, one-click stage route, the route planner on the single map, published routes and Settings.
 * Plain ES2017 script, no modules. Needs Leaflet (L), js/tsp.js (TSP), js/stages.js (Stages) and js/ui.js (UI).
 * Every job/route/geocoder string reaches the DOM through textContent or esc(); never raw innerHTML.
 */
(function () {
  'use strict';

  /* =====================================================================================================
   * CONSTANTS — the ONE place for client keys, colours, labels and the shop (APP_MASTER Rule 12 / §7.8).
   * A new client: add its key to CLIENT_KEYS and give it a COL colour, a LABEL and a SHORT name here (nowhere else).
   * ===================================================================================================== */
  var CLIENT_KEYS = ['Crown', 'Harris', 'ACV', 'MyTec', 'NoLimits', 'Other'];
  var COL = { Crown: '#2563eb', Harris: '#dc2626', ACV: '#16a34a', MyTec: '#7c3aed', NoLimits: '#0d9488', Other: '#f59e0b' };
  var LABEL = { Crown: 'Crown Pipeline', Harris: 'Harris Holdings', ACV: 'ACV Sewer & Water', MyTec: 'MyTec', NoLimits: 'No Limits Underground', Other: 'Other / Residential' };
  var SHORT = { Crown: 'Crown', Harris: 'Harris', ACV: 'ACV', MyTec: 'MyTec', NoLimits: 'No Limits', Other: 'Other' };   // list-row badges
  var SHOP = { name: 'Shop (1279 Loudoun Rd)', lat: 49.8401, lon: -97.2546, shop: true };
  var APP_URL = 'https://claude69420.github.io/eckstein-jobs/';
  var ROUTE_CONFIRM_ABOVE = 25;
  /* ===================================================================================================== */

  var UI = window.UI, DESK = UI.DESK, FINE = UI.FINE, toast = UI.toast;
  function $(id) { return document.getElementById(id); }

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function h(tag, props, kids) {                              // tiny DOM builder (text via textContent only)
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k]; if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c == null || c === false) return; el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); });
    return el;
  }
  function svgIcon(d) {                                        // d: our own constant path data only
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ico'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    d.forEach(function (p) { var e = document.createElementNS('http://www.w3.org/2000/svg', 'path'); e.setAttribute('d', p); s.appendChild(e); });
    return s;
  }
  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsJSON(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function bust() { return '?t=' + Date.now(); }
  function getJSON(u) { return fetch(u, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function isWpg(x) { return String(x.city || 'Winnipeg').trim().toLowerCase() === 'winnipeg'; }
  function clientGroup(x) { return CLIENT_KEYS.indexOf(x.clientKey) >= 0 ? x.clientKey : 'Other'; }
  function clientLabel(x) { return LABEL[clientGroup(x)] || x.client || 'Other'; }
  function fmtTime(d) { return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

  /* ---------------- stages ---------------- */
  var HAS_STAGES = !!(window.Stages && window.Stages.STAGES && window.Stages.stageIndex);
  var STAGES = HAS_STAGES ? window.Stages.STAGES : [
    { key: 'ready', label: 'Ready to start', short: 'Ready' }, { key: 'excavation', label: 'Excavation', short: 'Excav.' },
    { key: 'base', label: 'Base', short: 'Base' }, { key: 'prep', label: 'Prep', short: 'Prep' },
    { key: 'inspected', label: 'Passed inspection', short: 'Passed' }, { key: 'poured', label: 'Poured', short: 'Poured' }];
  var STAGE_KEYS = STAGES.map(function (s) { return s.key; });
  function stageIndex(k) { if (HAS_STAGES) return window.Stages.stageIndex(k); var i = STAGE_KEYS.indexOf(k); return i < 0 ? 0 : i; }
  function stageOf(x) { return STAGES[stageIndex(x.stage)]; }
  function stageVars(k) { return '--c:var(--stage-' + (k + 1) + ')' + (k === 3 ? ';--on-c:#000' : ';--on-c:#fff'); }
  function normStage(entry) { return STAGES[stageIndex(entry && entry.stage)].key; }

  var NULL_STORE = {                                          // used only if js/stages.js failed to load
    mode: 'readonly', writable: false,
    hasKey: function () { return false; }, load: function () { return Promise.resolve({}); },
    set: function () { var e = new Error('Stage storage unavailable'); e.code = 'readonly'; return Promise.reject(e); },
    onChange: function () {}, onStatus: function () {}, start: function () {}, stop: function () {},
    setKey: function () { return Promise.resolve({ ok: false, reason: 'Stage storage did not load. Reload the app.' }); },
    removeKey: function () {}, getKeyForShare: function () { return null; },
    deviceLabel: function () { return 'browser'; }, setDeviceLabel: function () {}
  };
  var store = NULL_STORE;
  try { if (window.Stages && window.Stages.createStore) store = window.Stages.createStore() || NULL_STORE; } catch (e) { store = NULL_STORE; }
  function writable() { return !!store.writable; }

  /* ---------------- state ---------------- */
  var JOBS = [], byNum = {}, dataLoaded = false, firstFit = false, stagesLoaded = false;
  var STAGEMAP = (function () {                               // cached last good stages: the first render is already right
    try { return (store.peek && store.peek()) || {}; } catch (e) { return {}; }
  })();
  var MODE = lsGet('ej_mode', 'client') === 'stage' ? 'stage' : 'client';
  function loadSel(key, allowed) {
    var a = lsJSON(key, []); if (!Array.isArray(a)) a = [];
    return a.filter(function (k, i) { return allowed.indexOf(k) >= 0 && a.indexOf(k) === i; });
  }
  var SEL = { client: loadSel('ej_vis_client', CLIENT_KEYS), stage: loadSel('ej_vis_stage', STAGE_KEYS) };
  function saveFilter() {
    lsSet('ej_mode', MODE);
    lsSet('ej_vis_client', JSON.stringify(SEL.client));
    lsSet('ej_vis_stage', JSON.stringify(SEL.stage));
  }
  function sel() { return SEL[MODE]; }
  function groupOf(x) { return MODE === 'client' ? clientGroup(x) : stageOf(x).key; }
  function inFilter(x) { var s = sel(); return !s.length || s.indexOf(groupOf(x)) >= 0; }
  function hay(x) {
    if (x._hay == null || x._hayStage !== x.stage) {
      var st = stageOf(x);
      x._hayStage = x.stage;
      x._hay = [x.street, x.permit, x.jobNumber, x.title, x.city, x.client, clientLabel(x), st.label, st.short].join(' ').toLowerCase();
    }
    return x._hay;
  }
  function query() { return ($('q').value || '').trim().toLowerCase(); }
  function currentJobs() { var q = query(); return JOBS.filter(function (x) { return inFilter(x) && (!q || hay(x).indexOf(q) >= 0); }); }
  var shownSet = {};                                          // jobNumber -> true for the last render (moves never re-filter)

  /* ---------------- map + basemaps ---------------- */
  var HAS_MAP = typeof window.L !== 'undefined';
  var map = null, jobLayer = null, routeLayer = null, markers = {};
  if (HAS_MAP) {
    map = L.map('jmap', { zoomControl: false, attributionControl: true, zoomSnap: 0.5, worldCopyJump: false });
    map.setView([49.8951, -97.1384], 11);
    jobLayer = L.layerGroup().addTo(map); routeLayer = L.layerGroup();
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450;                 // above route lines (overlayPane 400), below markers (600)
    map.getPane('labels').style.pointerEvents = 'none';
  }
  var ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community';
  function esri(name, pane) {
    return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/' + name + '/MapServer/tile/{z}/{y}/{x}',
      { maxNativeZoom: 16, maxZoom: 19, pane: pane || 'tilePane', attribution: pane ? '' : ESRI_ATTR });
  }
  var BASEMAPS = HAS_MAP ? {
    light: [esri('World_Light_Gray_Base'), esri('World_Light_Gray_Reference', 'labels')],
    dark: [esri('World_Dark_Gray_Base'), esri('World_Dark_Gray_Reference', 'labels')]
  } : null;
  var currentTheme = null, baseGen = 0;
  function setBasemap(theme) {
    if (!HAS_MAP) return;
    theme = theme === 'dark' ? 'dark' : 'light';
    if (theme === currentTheme) return;
    var next = BASEMAPS[theme], my = ++baseGen; currentTheme = theme;
    next.forEach(function (l) { if (!map.hasLayer(l)) l.addTo(map); l.bringToFront(); });
    function sweep() {                                        // remove the other theme only once the new base has loaded
      if (my !== baseGen) return;                             // a newer toggle won: do nothing
      Object.keys(BASEMAPS).forEach(function (t) {
        if (t !== theme) BASEMAPS[t].forEach(function (l) { if (map.hasLayer(l)) map.removeLayer(l); });
      });
    }
    if (next[0].isLoading && next[0].isLoading()) { next[0].once('load', sweep); setTimeout(sweep, 4000); } else sweep();
  }
  addEventListener('uiprefs', function (e) {
    setBasemap(e.detail && e.detail.theme);
    styleRouteLines();
    syncSettingsSegs();
  });
  setBasemap(document.documentElement.getAttribute('data-theme'));

  function cssVar(n, d) { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return (v && v.trim()) || d; }

  /* ---------------- pins ---------------- */
  var selectedJn = null;
  function pinHtml(x) {
    var st = MODE === 'stage', k = stageIndex(x.stage);
    var vars = st ? stageVars(k) : '--c:' + COL[clientGroup(x)];
    return '<div class="jpin' + (x.unscheduled ? ' is-uns' : '') + (x.pending ? ' is-pend' : '') +
      (x.jobNumber === selectedJn ? ' is-selected' : '') + '" style="' + vars + '">' + (st ? (k + 1) : '') + '</div>';
  }
  function pinSig(x) { return MODE + '|' + (MODE === 'stage' ? x.stage : clientGroup(x)) + '|' + !!x.unscheduled + !!x.pending; }   // selection is a class toggle, not a rebuild
  function pinLabel(x) { return '#' + x.jobNumber + ' ' + (x.street || x.title || '') + ', ' + stageOf(x).label; }
  function iconFor(x) { return L.divIcon({ html: pinHtml(x), className: '', iconSize: [22, 22], iconAnchor: [11, 11] }); }
  function labelMarker(m, x) { var el = m.getElement && m.getElement(); if (el) el.setAttribute('aria-label', pinLabel(x)); }
  function markSelected(m) {                                  // toggle on the live element so the scale spring animates
    var on = m._jn === selectedJn, el = m.getElement && m.getElement(), pin = el && el.firstElementChild;
    if (pin) pin.classList.toggle('is-selected', on);
    m.setZIndexOffset(on ? 1000 : 0);
  }
  function updatePin(x) {
    var m = markers[x.jobNumber]; if (!m) return;
    var s = pinSig(x);
    if (m._sig !== s) { m._sig = s; m.setIcon(iconFor(x)); }
    labelMarker(m, x); markSelected(m);
  }
  function makeMarker(x) {
    var m = L.marker([x.lat, x.lon], { icon: iconFor(x), keyboard: true, riseOnHover: true });
    m._jn = x.jobNumber; m._sig = pinSig(x);
    m.on('add', function () { var j = byNum[m._jn]; if (j) labelMarker(m, j); markSelected(m); });
    m.on('click', function () {
      var j = byNum[m._jn]; if (!j) return;
      closeCard(true);
      openJob(j, false);
    });
    m.on('mouseover', function () {
      if (!FINE.matches) return;
      var j = byNum[m._jn]; if (!j) return;
      if (cardJob === j || cardSlider.isDragging()) { clearTimeout(hideT); return; }   // a pinned card gives way to the next dot
      clearTimeout(hideT); clearTimeout(showT);
      showT = setTimeout(function () { openCard(j); }, 120);
    });
    m.on('mouseout', function () {
      clearTimeout(showT);
      if (!card.classList.contains('is-pinned')) { clearTimeout(hideT); hideT = setTimeout(maybeCloseCard, 250); }
    });
    markers[x.jobNumber] = m;
    return m;
  }
  function syncMarkers() {
    if (!HAS_MAP) return;
    var seen = {};
    JOBS.forEach(function (x) {
      if (!x.ok || typeof x.lat !== 'number' || typeof x.lon !== 'number') return;
      seen[x.jobNumber] = true;
      var m = markers[x.jobNumber];
      if (!m) m = makeMarker(x);
      else {
        var ll = m.getLatLng(); if (ll.lat !== x.lat || ll.lng !== x.lon) m.setLatLng([x.lat, x.lon]);
        updatePin(x);
      }
      var on = !!shownSet[x.jobNumber];
      if (on && !jobLayer.hasLayer(m)) jobLayer.addLayer(m);
      else if (!on && jobLayer.hasLayer(m)) jobLayer.removeLayer(m);
    });
    Object.keys(markers).forEach(function (jn) {
      if (!seen[jn]) { jobLayer.removeLayer(markers[jn]); delete markers[jn]; }
    });
  }

  /* ---------------- chips, count, route button ---------------- */
  var chipsEl = $('chips'), countEl = $('count'), routeBtn = $('routeSel'), routeMore = $('routeMore'), rmenu = $('route-menu'), modeEl = $('mode');
  function groupsForMode() {
    if (MODE === 'client') {
      return CLIENT_KEYS.filter(function (k) { return JOBS.some(function (x) { return clientGroup(x) === k; }) || SEL.client.indexOf(k) >= 0; })
        .map(function (k) { return { k: k, label: LABEL[k], short: LABEL[k], vars: '--c:' + COL[k], digit: '' }; });
    }
    return STAGES.map(function (s, i) { return { k: s.key, label: s.label, short: s.short, vars: stageVars(i), digit: String(i + 1) }; });
  }
  function groupCount(k) { var n = 0; JOBS.forEach(function (x) { if (groupOf(x) === k) n++; }); return n; }
  function renderChips() {
    chipsEl.textContent = '';
    var s = sel(), q = $('q').value.trim();
    // An active search stays visible when the iPhone sheet (which holds the search field) is closed.
    if (q) chipsEl.appendChild(h('button', { type: 'button', class: 'chip chip--q pressable', 'data-q': '1', 'aria-label': 'Clear search “' + q + '”', title: 'Clear search' },
      [h('span', { class: 'q-text', text: '“' + q + '”' }), h('span', { class: 'n', 'aria-hidden': 'true', text: '✕' })]));
    chipsEl.appendChild(h('button', { type: 'button', class: 'chip pressable', 'data-k': '', 'aria-pressed': s.length ? 'false' : 'true' },
      ['All ', h('span', { class: 'n', text: String(JOBS.length) })]));
    var full = MODE === 'stage' && DESK.matches;               // iPhone: short stage names, no counts, two rows: all 7 chips in view
    var wrap = MODE === 'stage' && !DESK.matches;
    chipsEl.classList.toggle('chips--wrap', wrap);
    groupsForMode().forEach(function (g) {
      var n = groupCount(g.k);
      chipsEl.appendChild(h('button', { type: 'button', class: 'chip pressable', 'data-k': g.k, 'aria-pressed': s.indexOf(g.k) >= 0 ? 'true' : 'false', title: g.label,
        'aria-label': wrap ? chipLabel(g.label, n) : null },
        [h('span', { class: 'dot', style: g.vars, 'aria-hidden': 'true', text: g.digit }), (full ? g.label : g.short) + (wrap ? '' : ' '),
         wrap ? null : h('span', { class: 'n', text: String(n) })]));
    });
  }
  function chipLabel(label, n) { return label + ', ' + plural(n, 'job'); }
  function revealSelectedChip() {
    var c = chipsEl.querySelector('.chip[aria-pressed="true"]:not([data-k=""])');
    if (!c || DESK.matches || chipsEl.scrollWidth <= chipsEl.clientWidth) return;
    var cb = c.getBoundingClientRect(), pb = chipsEl.getBoundingClientRect();
    if (cb.left < pb.left + 12 || cb.right > pb.right - 12) chipsEl.scrollLeft = Math.max(0, chipsEl.scrollLeft + cb.left - pb.left - 12);
  }
  function updateChipCounts() {
    chipsEl.querySelectorAll('.chip').forEach(function (c) {
      var k = c.getAttribute('data-k'), n = c.querySelector('.n');
      if (n) n.textContent = String(k ? groupCount(k) : JOBS.length);
      else if (k && c.hasAttribute('aria-label')) c.setAttribute('aria-label', chipLabel(c.title, groupCount(k)));
    });
  }
  function routeCounts(list) {                                // mapped jobs a shop route uses by default (Winnipeg) vs out of town
    var c = { wpg: 0, out: 0 };
    list.forEach(function (x) { if (x.ok && typeof x.lat === 'number') { if (isWpg(x)) c.wpg++; else c.out++; } });
    return c;
  }
  function selTitle() {
    return sel().map(function (k) { return MODE === 'stage' ? STAGES[stageIndex(k)].label : (LABEL[k] || k); }).join(' + ');
  }
  function updateCount() {
    if (!dataLoaded) return;
    var shown = Object.keys(shownSet).length;
    countEl.textContent = plural(shown, 'job');
    var c = routeCounts(currentJobs()), n = c.wpg || c.out;  // the number the route will actually contain
    var any = sel().length > 0;                               // nothing picked: the main half opens the stage menu too
    routeBtn.textContent = any ? 'Route ' + n : 'Route';
    routeBtn.disabled = any ? !n : !JOBS.length;
    if (any) routeBtn.removeAttribute('aria-haspopup'); else routeBtn.setAttribute('aria-haspopup', 'menu');
    routeBtn.title = !any ? 'Pick a stage to route from the shop'
      : !n ? 'No mapped jobs in ' + selTitle() + ' to route'
      : 'Route ' + plural(c.wpg, 'Winnipeg job') + ' (' + selTitle() + ') from the shop' + (c.out ? '; ' + c.out + ' out of town can be added' : '');
    routeMore.disabled = !JOBS.length;
  }
  function syncModeSeg() {
    modeEl.style.setProperty('--i', MODE === 'client' ? 0 : 1);
    modeEl.querySelectorAll('[data-mode]').forEach(function (n) { n.setAttribute('aria-checked', n.dataset.mode === MODE ? 'true' : 'false'); });
  }

  /* ---------------- list ---------------- */
  var listEl = $('jlist'), rows = {};
  function rowLead(x) {
    if (MODE === 'stage') { var k = stageIndex(x.stage); return h('span', { class: 'dot', style: stageVars(k), 'aria-hidden': 'true', text: String(k + 1) }); }
    return h('span', { class: 'dot', style: '--c:' + COL[clientGroup(x)], 'aria-hidden': 'true' });
  }
  function rowTrail(x) {
    if (MODE === 'stage') { var g = clientGroup(x); return h('span', { class: 'pill pill--client', style: '--c:' + COL[g], title: g === 'Other' ? (x.client || LABEL.Other) : LABEL[g], text: g === 'Other' ? (x.client || SHORT.Other) : (SHORT[g] || LABEL[g] || g) }); }
    var k = stageIndex(x.stage);
    return h('span', { class: 'pill', style: stageVars(k), title: STAGES[k].label },
      [h('span', { class: 'dot dot--xs', style: stageVars(k), text: String(k + 1) }), STAGES[k].short]);
  }
  function rowSub(x) {
    var bits = [h('span', { text: '#' + x.jobNumber })];
    if (x.pending) bits.push(h('span', { class: 'tag pend', text: 'PENDING' }));
    if (x.unscheduled) bits.push(h('span', { class: 'tag uns', text: 'UNSCHED' }));
    if (!x.ok) bits.push(h('span', { class: 'tag unm', text: 'not mapped' }));
    var tail = [x.permit, isWpg(x) ? '' : x.city].filter(Boolean).join(' · ');
    if (tail) bits.push(' · ' + tail);
    return h('div', { class: 's' }, bits);
  }
  function makeRow(x) {
    var r = h('div', { class: 'job-row' + (x.jobNumber === selectedJn ? ' is-selected' : ''), role: 'listitem', tabindex: '0', 'data-jn': String(x.jobNumber) },
      [rowLead(x), h('div', {}, [h('div', { class: 't', text: x.street || x.title || '(no address)' }), rowSub(x)]), rowTrail(x)]);
    r.setAttribute('aria-label', '#' + x.jobNumber + ' ' + (x.street || x.title || '') + ', ' + stageOf(x).label + (x.ok ? '' : ', not mapped'));
    rows[x.jobNumber] = r;
    return r;
  }
  function patchRow(x) {
    var r = rows[x.jobNumber]; if (!r) return;
    r.replaceChild(rowLead(x), r.firstChild);
    r.replaceChild(rowTrail(x), r.lastChild);
    r.setAttribute('aria-label', '#' + x.jobNumber + ' ' + (x.street || x.title || '') + ', ' + stageOf(x).label + (x.ok ? '' : ', not mapped'));
  }
  var grpCounts = {};                                         // group key -> its "(n)" span in the list headers
  function renderList(shown) {
    rows = {}; grpCounts = {}; listEl.textContent = '';
    if (!dataLoaded) return;
    if (!shown.length) { listEl.appendChild(h('div', { class: 'muted', text: JOBS.length ? 'No jobs match.' : 'No jobs.' })); return; }
    var frag = document.createDocumentFragment();
    groupsForMode().forEach(function (g) {
      var list = shown.filter(function (x) { return groupOf(x) === g.k; }); if (!list.length) return;
      var n = grpCounts[g.k] = h('span', { class: 'grp-n', text: '(' + list.length + ')' });
      frag.appendChild(h('div', { class: 'grp', role: 'presentation' }, [h('span', { class: 'dot', style: g.vars, 'aria-hidden': 'true', text: g.digit }),
        h('span', { text: g.label }), n,
        h('button', { type: 'button', class: 'grp-route pressable', 'data-route': g.k, title: 'Route every ' + g.label + ' job from the shop', 'aria-label': 'Route ' + g.label + ' jobs from the shop', text: 'Route' })]));
      list.forEach(function (x) { frag.appendChild(makeRow(x)); });
    });
    listEl.appendChild(frag);
  }
  function updateGroupCounts() {                              // a stage move keeps the row in place but the counts follow the truth
    var c = {};
    Object.keys(shownSet).forEach(function (jn) { var x = byNum[jn]; if (x) { var k = groupOf(x); c[k] = (c[k] || 0) + 1; } });
    Object.keys(grpCounts).forEach(function (k) { grpCounts[k].textContent = '(' + (c[k] || 0) + ')'; });
  }
  listEl.addEventListener('click', function (e) {
    var gb = e.target.closest('.grp-route');
    if (gb) { routeGroup(gb.getAttribute('data-route')); return; }
    var r = e.target.closest('.job-row'); if (!r) return;
    var x = byNum[r.getAttribute('data-jn')]; if (x) openJob(x, true);
  });
  listEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var r = e.target.closest('.job-row'); if (!r) return;
    e.preventDefault(); var x = byNum[r.getAttribute('data-jn')]; if (x) openJob(x, true);
  });

  /* ---------------- render ---------------- */
  function renderAll() {
    var shown = currentJobs();
    shownSet = {}; shown.forEach(function (x) { shownSet[x.jobNumber] = true; });
    var sl = chipsEl.scrollLeft;
    syncModeSeg(); renderChips(); syncMarkers(); renderList(shown); updateCount();
    chipsEl.scrollLeft = sl; revealSelectedChip();
  }
  var qT = 0;
  $('q').addEventListener('input', function () { cancelAnimationFrame(qT); qT = requestAnimationFrame(renderAll); });

  function ensureJobsView() { if (UI.currentView() !== 'jobs') UI.showView('jobs'); }
  chipsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return;
    if (b.hasAttribute('data-q')) { $('q').value = ''; renderAll(); return; }   // clear the search
    var k = b.getAttribute('data-k'), s = SEL[MODE];
    if (!k) s.length = 0;                                     // All resets
    else { var i = s.indexOf(k); if (i >= 0) s.splice(i, 1); else s.push(k); }   // solo first (All -> [k]), then add/remove
    saveFilter(); ensureJobsView(); renderAll(); fitVisible();
  });
  modeEl.addEventListener('click', function (e) {
    var b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === MODE) return;
    MODE = b.dataset.mode === 'stage' ? 'stage' : 'client'; saveFilter();
    ensureJobsView(); renderAll();
    if (sel().length) fitVisible();
  });

  function fitVisible() {                                     // same rule as fitAll: the shown Winnipeg jobs (out-of-town pins stay on the map)
    if (!HAS_MAP) return;
    var shown = JOBS.filter(function (x) { return x.ok && shownSet[x.jobNumber]; });
    var pts = shown.filter(isWpg).map(function (x) { return [x.lat, x.lon]; });
    if (!pts.length) pts = shown.map(function (x) { return [x.lat, x.lon]; });
    if (!pts.length) return;
    var pad = UI.mapPadding(); pad.maxZoom = 15;
    map.fitBounds(pts, pad);
  }

  /* ---------------- selection + detail ---------------- */
  var detailSlider = UI.StageSlider($('dStage'), moveStage), detailJn = null;
  function select(x) {
    var prev = selectedJn; selectedJn = x ? x.jobNumber : null;
    if (prev != null && byNum[prev]) updatePin(byNum[prev]);
    if (x) updatePin(x);
    listEl.querySelectorAll('.job-row.is-selected').forEach(function (r) { r.classList.remove('is-selected'); });
    if (x && rows[x.jobNumber]) rows[x.jobNumber].classList.add('is-selected');
  }
  window.clearSelection = function (scrollToRow) {
    var jn = selectedJn; detailJn = null; select(null);
    if (scrollToRow && jn != null && rows[jn]) { rows[jn].classList.add('is-selected'); try { rows[jn].scrollIntoView({ block: 'nearest' }); } catch (e) {} setTimeout(function () { if (rows[jn] && selectedJn == null) rows[jn].classList.remove('is-selected'); }, 1200); }
  };
  function lockSliders() {
    var ro = !writable();
    detailSlider.lock(ro); cardSlider.lock(ro);
    $('dLock').hidden = !ro; $('mcLock').hidden = !ro;
  }
  function fillDetailStage(x) { detailSlider.set(x); }
  window.fillDetail = function (x) {
    select(x); detailJn = x.jobNumber;
    $('dTitle').textContent = x.street || x.title || '(no address)';
    $('dSub').textContent = [clientLabel(x), '#' + x.jobNumber, x.permit ? 'Permit ' + x.permit : ''].filter(Boolean).join(' · ');
    var tags = $('dTags'); tags.textContent = '';
    if (x.pending) tags.appendChild(h('span', { class: 'tag pend', text: 'PENDING · not in Jobber yet' }));
    if (x.unscheduled) tags.appendChild(h('span', { class: 'tag uns', text: 'UNSCHEDULED' }));
    if (!x.ok) tags.appendChild(h('span', { class: 'tag unm', text: 'not mapped' }));
    if (!isWpg(x)) tags.appendChild(h('span', { class: 'tag', text: x.city }));
    fillDetailStage(x); lockSliders();
    var dir = $('dDir');
    if (x.ok) { dir.href = 'https://www.google.com/maps/dir/?api=1&destination=' + x.lat + ',' + x.lon; dir.removeAttribute('aria-disabled'); dir.removeAttribute('tabindex'); }
    else { dir.href = '#'; dir.setAttribute('aria-disabled', 'true'); dir.setAttribute('tabindex', '-1'); }
    $('dAdd').disabled = !x.ok;
    var info = $('dInfo'); info.textContent = '';
    info.appendChild(h('div', { class: 'info-line', text: x.title || '' }));
    info.appendChild(h('div', { class: 'info-line', text: [x.street, x.city].filter(Boolean).join(', ') + (x.client ? ' · ' + x.client : '') }));
    info.appendChild(h('div', { class: 'info-line', id: 'dStageInfo' }));
    renderStageInfo(x);
  };
  function renderStageInfo(x) {                               // "Stage set <time> by <device>" from STAGEMAP (kept current by moves)
    var el = $('dStageInfo'); if (!el || detailJn !== x.jobNumber) return;
    var entry = STAGEMAP[x.jobNumber], d = entry && entry.at ? new Date(entry.at) : null;
    el.textContent = d && !isNaN(d) ? 'Stage set ' + fmtTime(d) + (entry.by ? ' by ' + String(entry.by).slice(0, 40) : '') : '';
    el.hidden = !el.textContent;
  }
  function focusJob(x, zoomIn) {                             // bring the pin into the part of the map not covered by glass
    if (!HAS_MAP || !x.ok) return;
    var ll = L.latLng(x.lat, x.lon), pad = UI.mapPadding(), size = map.getSize();
    var l = pad.paddingTopLeft[0], t = pad.paddingTopLeft[1], r = pad.paddingBottomRight[0], b = pad.paddingBottomRight[1];
    if (size.x - l - r < 40 || size.y - t - b < 40) { l = t = r = b = 0; }
    var cur = map.getZoom(), cp = map.latLngToContainerPoint(ll);
    var visible = cp.x >= l && cp.x <= size.x - r && cp.y >= t && cp.y <= size.y - b;
    if (visible) return;                                      // never move (or zoom) the map under a visible pin
    // A pin tap keeps the zoom (Riley moves many jobs in a row); a list row whose pin is off-screen may zoom in.
    var z = zoomIn && cur < 14 ? 15 : cur;
    var want = L.point((l + size.x - r) / 2, (t + size.y - b) / 2);           // centre of the visible area
    var c = map.project(ll, z).subtract(want.subtract(size.divideBy(2)));
    map.setView(map.unproject(c, z), z, { animate: true });
  }
  function openJob(x, fromList) {
    UI.openDetail(x);
    setTimeout(function () { focusJob(x, !!fromList); }, DESK.matches ? 0 : 60);
  }
  $('dAdd').addEventListener('click', function () {
    var x = byNum[detailJn]; if (!x || !x.ok) return;
    stops.push(jobStop(x)); renderStops();
    toast('Added to Plan · ' + plural(stops.length, 'stop'), function () { UI.openList('plan', 'medium'); }, { action: 'Open' });
  });
  $('dCopy').addEventListener('click', function () {
    var x = byNum[detailJn]; if (!x) return;
    var text = [x.street || x.title, x.city].filter(Boolean).join(', ') + (x.city ? ', MB' : '');
    copyText(text).then(function () { toast('Address copied'); }, function () { toast('Couldn’t copy', null, { error: true }); });
  });
  $('dDir').addEventListener('click', function (e) { if (this.getAttribute('aria-disabled') === 'true') e.preventDefault(); });
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    return new Promise(function (res, rej) {
      try { var ta = h('textarea', { style: 'position:fixed;top:-100px;left:0;opacity:0' }); ta.value = t; document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); document.body.removeChild(ta); if (ok) res(); else rej(new Error('copy')); } catch (e) { rej(e); }
    });
  }

  /* ---------------- desktop hover card (fine pointer only) ---------------- */
  var card = $('map-card'), cardJob = null, showT = 0, hideT = 0;
  var cardSlider = UI.StageSlider($('mcStage'), function (x, key) { card.classList.add('is-pinned'); moveStage(x, key); });
  var cardH = 150, cardRaf = 0;
  card.hidden = !FINE.matches;                                // touch devices never use the card: keep its glass out of the render tree
  FINE.on(function () { if (!FINE.matches) closeCard(true); card.hidden = !FINE.matches; });
  function placeCardAt(p) {
    var minX = (DESK.matches ? 12 + 380 + 12 : 8) + 158, maxX = innerWidth - 158 - (DESK.matches ? 72 : 8);
    var cx = Math.max(minX, Math.min(maxX, p.x));
    card.style.setProperty('--cx', cx + 'px'); card.style.setProperty('--cy', p.y + 'px');
    card.classList.toggle('is-below', p.y < cardH + 40);
  }
  function placeCard() {
    cardRaf = 0;
    if (!cardJob || !HAS_MAP) return;
    placeCardAt(map.latLngToContainerPoint([cardJob.lat, cardJob.lon]));
  }
  function openCard(x) {
    if (!x.ok || !FINE.matches) return;
    if (cardJob !== x) card.classList.remove('is-pinned');   // a new job starts unpinned
    cardJob = x; card.hidden = false;
    $('mcTitle').textContent = x.street || x.title || '(no address)';
    $('mcSub').textContent = clientLabel(x) + ' · #' + x.jobNumber + (x.permit ? ' · ' + x.permit : '');
    cardSlider.set(x); lockSliders();
    cardH = card.offsetHeight || 150;                         // measured once per open, not on every map move
    placeCard(); card.classList.add('is-open');
  }
  function closeCard(force) {
    clearTimeout(showT);
    if (!cardJob && !card.classList.contains('is-open')) return false;
    if (!force && cardSlider.isDragging()) return false;
    card.classList.remove('is-open', 'is-pinned'); cardJob = null; clearTimeout(showT); clearTimeout(hideT);
    return true;
  }
  function maybeCloseCard() { if (!card.classList.contains('is-pinned') && !cardSlider.isDragging() && !card.matches(':hover')) closeCard(); }
  window.closeCard = function () { return closeCard(true); };
  card.addEventListener('pointerenter', function () { clearTimeout(hideT); clearTimeout(showT); });
  card.addEventListener('pointerleave', function () { if (!card.classList.contains('is-pinned')) { clearTimeout(hideT); hideT = setTimeout(maybeCloseCard, 250); } });
  card.addEventListener('pointerdown', function () { card.classList.add('is-pinned'); });   // interacting pins it
  $('mcMore').addEventListener('click', function () { var x = cardJob; if (!x) return; closeCard(true); openJob(x, false); });
  if (HAS_MAP) {
    map.on('move', function () { if (cardJob) placeCard(); });           // Leaflet already fires 'move' once per frame
    map.on('zoom', function () { if (cardJob && !cardRaf) cardRaf = requestAnimationFrame(placeCard); });
    map.on('zoomanim', function (e) {                                     // glide with the pin during the CSS zoom animation
      if (!cardJob) return;
      try {
        var lp = map._latLngToNewLayerPoint(L.latLng(cardJob.lat, cardJob.lon), e.zoom, e.center);
        card.classList.add('is-zooming'); placeCardAt(lp.add(map._getMapPanePos()));
      } catch (err) { /* private API changed: 'zoom'/'zoomend' still place the card */ }
    });
    map.on('zoomend', function () { card.classList.remove('is-zooming'); if (cardJob) placeCard(); });
    map.on('click', function () { closeCard(true); });
  }

  /* ---------------- stage moves: optimistic, undoable, persisted through the store; never re-filters ---------------- */
  var inflight = {};                                          // jobNumber -> {base, baseEntry, seq}: what a failed save rolls back to
  var undoToast = null;                                       // {jn, fn, until} of the Undo toast on screen
  function applyStage(x, key) {
    key = STAGES[stageIndex(key)].key;
    if (x.stage === key) return;
    x.stage = key; x._hay = null;
    updatePin(x); patchRow(x); updateChipCounts(); updateGroupCounts(); updateCount();
    if (detailJn === x.jobNumber) fillDetailStage(x);
    if (cardJob === x) cardSlider.set(x);
  }
  function setStageEntry(jn, entry) {                         // keep STAGEMAP (the "Stage set … by …" line) in step with moves
    if (entry) STAGEMAP[jn] = entry; else delete STAGEMAP[jn];
    var x = byNum[jn]; if (x) renderStageInfo(x);
  }
  function openStageSettings() { UI.openSettings('stages'); }
  function moveStage(x, key, isUndo) {
    if (!writable()) {
      toast('Stages are read-only on this device', openStageSettings, { action: 'Settings' });
      if (detailJn === x.jobNumber) detailSlider.set(x); if (cardJob === x) cardSlider.set(x);
      return;
    }
    var prev = x.stage; key = STAGES[stageIndex(key)].key; if (prev === key) return;
    var jn = x.jobNumber, prevEntry = STAGEMAP[jn] || null;
    var f = inflight[jn] || (inflight[jn] = { base: prev, baseEntry: prevEntry, seq: 0 }), my = ++f.seq;
    var entry = key === 'ready' ? null : { stage: key, at: new Date().toISOString(), by: store.deviceLabel ? store.deviceLabel() : '' };
    applyStage(x, key); setStageEntry(jn, entry);
    var label = STAGES[stageIndex(key)].label;
    if (isUndo) { undoToast = null; toast('Moved back to ' + label); }
    else {
      var undo = function () { var j = byNum[jn] || x; moveStage(j, prev, true); };
      undoToast = { jn: jn, fn: undo, until: Date.now() + 5000 };
      toast('Moved to ' + label, undo);
    }
    var p;
    try { p = store.set(jn, key, { label: x.street || x.title || '' }); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(function (r) {
      var fl = inflight[jn];
      if (fl && fl.seq === my) delete inflight[jn];
      else if (fl) { fl.base = key; fl.baseEntry = entry; }  // saved: a later overlapping move rolls back to THIS stage
      if (r && r.status === 'queued') {                       // keep the Undo of this move reachable for its full 5 s
        var u = undoToast, left = u && u.jn === jn ? u.until - Date.now() : 0;
        if (left > 500) toast('Saved offline — will sync', u.fn, { ms: left });
        else toast('Saved offline — will sync');
      }
    }, function (err) {
      var cur = byNum[jn] || x, fl = inflight[jn];
      var base = fl ? fl.base : prev, baseEntry = fl ? fl.baseEntry : prevEntry;
      if (fl && fl.seq === my) delete inflight[jn];
      if (cur.stage === key) { applyStage(cur, base); setStageEntry(jn, baseEntry); }
      var code = err && err.code;
      var msg = code === 'auth' ? 'Edit key rejected — Settings → Stages'
        : code === 'readonly' ? 'Stages are read-only on this device'
        : code === 'conflict' ? 'Couldn’t save (changed elsewhere) — try again'
        : 'Couldn’t save stage — try again';
      toast(msg, (code === 'auth' || code === 'readonly') ? openStageSettings : null, { error: true, action: 'Settings' });
      lockSliders();
    });
  }

  function mergeStages(m) {
    STAGEMAP = m || {};
    JOBS.forEach(function (x) { x.stage = normStage(STAGEMAP[x.jobNumber]); x._hay = null; });
  }
  store.onChange(function (m) {                               // poll result / replay rollback / key change: update IN PLACE
    STAGEMAP = m || {};
    JOBS.forEach(function (x) { applyStage(x, normStage(STAGEMAP[x.jobNumber])); });
    if (detailJn != null && byNum[detailJn] && UI.isDetailOpen()) window.fillDetail(byNum[detailJn]);
  });
  var lastMode = store.mode;
  store.onStatus(function (st) {
    renderStageStatus(st);
    lockSliders();
    if (st && st.mode === 'invalid' && lastMode !== 'invalid') toast('Edit key rejected — Settings → Stages', openStageSettings, { error: true, action: 'Settings' });
    lastMode = st && st.mode;
  });

  /* ---------------- data loading ---------------- */
  var loading = false, fitBeforeStages = false;
  function setUpd(t) { $('upd').textContent = t; $('setUpd').textContent = t; }
  function loadData() {
    if (loading) return Promise.resolve();
    loading = true; $('rf').classList.add('is-spinning');
    if (!dataLoaded) countEl.textContent = 'Loading…';
    var jobsP = Promise.all([getJSON('data/jobs.json' + bust()), getJSON('data/meta.json' + bust()).catch(function () { return null; })])
      .then(function (res) {
        var j = res[0], m = res[1];
        if (!Array.isArray(j)) throw new Error('bad jobs.json');
        JOBS = j.filter(function (x) { return x && x.jobNumber != null; });
        byNum = {}; JOBS.forEach(function (x) { byNum[x.jobNumber] = x; x.stage = normStage(STAGEMAP[x.jobNumber]); });
        dataLoaded = true;
        if (m && m.updated_utc) {
          var d = new Date(m.updated_utc);
          setUpd((m.mapped != null ? m.mapped : JOBS.filter(function (x) { return x.ok; }).length) + '/' + (m.total != null ? m.total : JOBS.length) + ' mapped · updated ' + (isNaN(d) ? m.updated_utc : fmtTime(d)));
        } else setUpd(JOBS.length + ' jobs');
        renderAll();
        if (!firstFit) { firstFit = true; fitAll(); fitBeforeStages = !stagesLoaded; }
        refreshOpenJob();
      })
      .catch(function (e) {
        if (!dataLoaded) countEl.textContent = 'Couldn’t load';
        setUpd('failed to load data'); toast('Couldn’t load job data', null, { error: true });
        if (window.console) console.error('jobs load failed', e && e.message);
      });
    var stagesP = Promise.resolve().then(function () { return store.load(); }).then(function (m) { return m || {}; }, function () { return STAGEMAP; });
    var routesP = getJSON('routes/index.json' + bust()).then(renderRoutes, function () { renderRoutes([]); });
    return Promise.all([jobsP, stagesP]).then(function (r) {
      var before = Object.keys(shownSet).join();
      mergeStages(r[1]); stagesLoaded = true;
      if (dataLoaded) {
        renderAll(); refreshOpenJob();
        // The first fit ran on cached/unknown stages: re-frame once if a stage filter now shows different jobs.
        if (fitBeforeStages && MODE === 'stage' && sel().length && Object.keys(shownSet).join() !== before) fitAll();
        fitBeforeStages = false;
      }
      renderStageStatus();
    }).then(function () { return routesP; }).then(function () { loading = false; $('rf').classList.remove('is-spinning'); },
      function () { loading = false; $('rf').classList.remove('is-spinning'); });
  }
  function fitAll() {                                         // first view: the shown jobs in Winnipeg (out-of-town pins stay on the map)
    if (!HAS_MAP) return;
    var shown = JOBS.filter(function (x) { return x.ok && shownSet[x.jobNumber]; });
    var pts = shown.filter(isWpg).map(function (x) { return [x.lat, x.lon]; });
    if (!pts.length) pts = shown.map(function (x) { return [x.lat, x.lon]; });
    if (!pts.length) pts = JOBS.filter(function (x) { return x.ok && isWpg(x); }).map(function (x) { return [x.lat, x.lon]; });
    if (pts.length) { var pad = UI.mapPadding(); pad.maxZoom = 14; map.fitBounds(pts, pad); }
  }
  function refreshOpenJob() {
    if (detailJn != null && UI.isDetailOpen()) { var x = byNum[detailJn]; if (x) window.fillDetail(x); else UI.closeDetail(); }
    if (cardJob) { var c = byNum[cardJob.jobNumber]; if (c) openCard(c); else closeCard(true); }
  }
  function reloadData() { if (loading) return Promise.resolve(); setUpd('refreshing…'); return loadData(); }
  $('rf').addEventListener('click', reloadData);

  /* ---------------- generic actions ---------------- */
  var meMarker = null;
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
    var a = b.dataset.act;
    if (a === 'zoom-in' && HAS_MAP) map.zoomIn();
    else if (a === 'zoom-out' && HAS_MAP) map.zoomOut();
    else if (a === 'reload') reloadData();
    else if (a === 'locate') locate();
  });
  function locate() {
    if (!navigator.geolocation || !HAS_MAP) { toast('Location isn’t available here'); return; }
    navigator.geolocation.getCurrentPosition(function (p) {
      var ll = [p.coords.latitude, p.coords.longitude];
      if (!meMarker) meMarker = L.marker(ll, { icon: L.divIcon({ html: '<div class="me-dot"></div>', className: '', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map);
      else meMarker.setLatLng(ll);
      map.setView(ll, Math.max(map.getZoom(), 14));
    }, function () { toast('Couldn’t get your location', null, { error: true }); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }

  /* ---------------- published routes ---------------- */
  function renderRoutes(r) {
    var el = $('rlist'); el.textContent = '';
    if (!Array.isArray(r) || !r.length) { el.className = 'muted'; el.textContent = 'No routes published yet.'; return; }
    el.className = '';
    var standalone = document.documentElement.classList.contains('is-standalone');
    r.forEach(function (x) {
      if (!x || !x.file) return;
      var a = h('a', { class: 'card', href: 'routes/' + encodeURIComponent(x.file) }, [h('b', { text: x.title || x.file }), h('div', { class: 'd', text: x.date || '' })]);
      if (standalone) { a.target = '_blank'; a.rel = 'noopener'; }   // Home Screen app: open in a viewer with a Done button
      el.appendChild(a);
    });
  }

  /* ================= Planner (single map: routeLayer) ================= */
  var stops = [], lastResult = null, SR = null, routeLines = [];
  var MB_RE = /\b(mb|manitoba|winnipeg)\b/i;
  function jobStop(x) { return { name: (x.street || x.title || ('#' + x.jobNumber)) + (x.permit ? ' · ' + x.permit : ''), lat: x.lat, lon: x.lon, jobNumber: x.jobNumber }; }
  function renderStops() {
    var ul = $('stops'); ul.textContent = '';
    if (!stops.length) { ul.appendChild(h('li', { class: 'empty', text: 'No stops yet — add an address, the shop, or pick from the jobs list.' })); return; }
    stops.forEach(function (s, i) {
      var sub = s.match ? s.match : (typeof s.lat === 'number' ? s.lat.toFixed(4) + ', ' + s.lon.toFixed(4) : '');
      var li = h('li', {}, [
        h('span', { class: 'n' + (s.shop ? ' is-shop' : ''), text: String(i + 1) }),
        h('div', { class: 'tx' }, [s.name || '', h('small', { text: sub })]),
        h('button', { type: 'button', class: 'mini', 'aria-label': 'Move up', 'data-a': 'up', 'data-i': String(i), text: '▲' }),
        h('button', { type: 'button', class: 'mini', 'aria-label': 'Move down', 'data-a': 'dn', 'data-i': String(i), text: '▼' }),
        h('button', { type: 'button', class: 'mini', 'aria-label': 'Remove stop', 'data-a': 'x', 'data-i': String(i), text: '✕' })
      ]);
      ul.appendChild(li);
    });
  }
  $('stops').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-a]'); if (!b) return;
    var i = +b.getAttribute('data-i'), a = b.getAttribute('data-a'), t;
    if (a === 'x') stops.splice(i, 1);
    else if (a === 'up' && i > 0) { t = stops[i - 1]; stops[i - 1] = stops[i]; stops[i] = t; }
    else if (a === 'dn' && i < stops.length - 1) { t = stops[i + 1]; stops[i + 1] = stops[i]; stops[i] = t; }
    renderStops();
  });
  function geocode(text) {
    var u = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&countryCode=CAN' +
      '&searchExtent=-98.6,49.0,-95.8,50.7&outFields=Match_addr&singleLine=' + encodeURIComponent(text + (MB_RE.test(text) ? '' : ', Winnipeg, MB'));
    return fetch(u).then(function (r) { return r.json(); }).then(function (r) {
      var c = (r && r.candidates || [])[0];
      if (!c || !c.location || typeof c.location.y !== 'number') throw new Error('not found');
      return { name: text, lat: c.location.y, lon: c.location.x, match: (c.attributes && c.attributes.Match_addr) || c.address || '' };
    });
  }
  $('addAddr').addEventListener('click', function () {
    var inp = $('addr'), t = inp.value.trim(), b = $('addAddr'); if (!t || b.disabled) return;
    b.disabled = true; b.textContent = '…';
    geocode(t).then(function (g) {
      stops.push({ name: t, lat: g.lat, lon: g.lon, match: g.match }); inp.value = ''; renderStops();
      toast('Added: ' + (g.match || t));
    }, function () { toast('Couldn’t find: ' + t, null, { error: true }); })
      .then(function () { b.disabled = false; b.textContent = 'Add'; });
  });
  $('addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('addAddr').click(); } });
  $('addShop').addEventListener('click', function () { stops.push(Object.assign({}, SHOP)); renderStops(); });
  $('clearStops').addEventListener('click', function () { stops = []; renderStops(); clearResult(); });

  /* Job picker: multi-select, respects the current filter + search */
  var pickbox = $('pickbox');
  $('pickJob').addEventListener('click', function () {
    if (!pickbox.hidden) { pickbox.hidden = true; $('pickJob').setAttribute('aria-expanded', 'false'); return; }
    buildPicker(); pickbox.hidden = false; $('pickJob').setAttribute('aria-expanded', 'true');
  });
  function buildPicker() {
    pickbox.textContent = '';
    var list = currentJobs().filter(function (x) { return x.ok; });
    var addBtn = h('button', { type: 'button', class: 'btn btn--sm btn--prominent pressable', disabled: true, text: 'Add' });
    var allBtn = h('button', { type: 'button', class: 'btn btn--sm pressable', text: 'All' });
    var desc = (sel().length ? selTitle() : 'All jobs') + (query() ? ' matching “' + $('q').value.trim() + '”' : '');
    pickbox.appendChild(h('div', { class: 'pick-head' }, [h('span', { text: plural(list.length, 'mapped job') + ' · ' + desc }), allBtn, addBtn]));
    var box = h('div', { class: 'pick-list' });
    if (!list.length) box.appendChild(h('div', { class: 'muted', text: 'No mapped jobs in the current filter.' }));
    list.forEach(function (x) {
      var vars = MODE === 'stage' ? stageVars(stageIndex(x.stage)) : '--c:' + COL[clientGroup(x)];
      var cb = h('input', { type: 'checkbox', 'data-jn': String(x.jobNumber) });
      box.appendChild(h('label', { class: 'pick-item' }, [cb, h('span', { class: 'dot dot--xs', style: vars, 'aria-hidden': 'true', text: MODE === 'stage' ? String(stageIndex(x.stage) + 1) : '' }),
        h('span', { class: 'tx' }, ['#' + x.jobNumber + ' ' + (x.street || x.title || ''), isWpg(x) ? '' : ' (' + x.city + ')', x.permit ? h('small', { text: ' ' + x.permit }) : null])]));
    });
    pickbox.appendChild(box);
    function checked() { return Array.prototype.slice.call(box.querySelectorAll('input:checked')); }
    box.addEventListener('change', function () { var n = checked().length; addBtn.disabled = !n; addBtn.textContent = n ? 'Add ' + n : 'Add'; });
    allBtn.addEventListener('click', function () {
      var cbs = box.querySelectorAll('input'), any = checked().length < cbs.length;
      cbs.forEach(function (c) { c.checked = any; }); box.dispatchEvent(new Event('change'));
    });
    addBtn.addEventListener('click', function () {
      var n = 0;
      checked().forEach(function (c) { var x = byNum[c.getAttribute('data-jn')]; if (x) { stops.push(jobStop(x)); n++; } });
      pickbox.hidden = true; $('pickJob').setAttribute('aria-expanded', 'false'); renderStops();
      if (n) toast('Added ' + plural(n, 'stop'));
    });
  }

  /* fixed end is meaningless with return-to-start: disable it while rt is ticked */
  function syncFxe() { var rt = $('rt').checked; $('fxe').disabled = rt; $('fxeRow').classList.toggle('is-disabled', rt); }
  $('rt').addEventListener('change', syncFxe); syncFxe();

  $('opt').addEventListener('click', function () {
    if (stops.length < 2) { toast('Add at least 2 stops'); return; }
    var fxs = $('fxs').checked, rt = $('rt').checked, fxe = $('fxe').checked && !rt;
    SR = null;
    runOptimize(stops.slice(), fxs, fxe, rt, null);
  });
  function busy(msg) { var p = $('pres'); p.textContent = ''; p.appendChild(h('div', { class: 'spinner-line' }, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), msg])); }
  function runOptimize(list, fxs, fxe, rt, name, extra) {
    if (!window.TSP || !TSP.optimize) { toast('Route optimizer failed to load — reload the app', null, { error: true }); return; }
    busy('Optimizing ' + (extra ? plural(list.length - 1, 'job') + ' from the shop' : plural(list.length, 'stop')) + '…');
    setTimeout(function () {                                 // let the spinner paint first
      var seq;
      try { seq = TSP.optimize(list, fxs, fxe, rt); } catch (e) { $('pres').textContent = ''; toast('Couldn’t optimize this route', null, { error: true }); return; }
      if (!extra) { stops = seq.slice(); renderStops(); }     // a stage route never touches the Plan's own stops
      showResult(seq, rt, name, extra);
    }, 30);
  }
  function lblFor(seq) { var startShop = !!(seq[0] && seq[0].shop); return function (i) { return startShop ? (i === 0 ? 'S' : String(i)) : String(i + 1); }; }
  function fmtMin(m) { return m < 10 ? m.toFixed(1) : String(Math.round(m)); }
  function clearResult() {
    lastResult = null; SR = null; $('pres').textContent = '';
    if (routeLayer) routeLayer.clearLayers(); routeLines = [];
    if (window.onViewChange) window.onViewChange(UI.currentView());
  }
  function showResult(seq, rt, name, extra) {
    lastResult = { seq: seq, rt: !!rt, name: name || '' };
    var legs = TSP.legs(seq, rt), parts = TSP.gmapsParts(seq, rt), lbl = lblFor(seq);
    var tm = 0, tk = 0, anyRural = false;
    legs.forEach(function (l) { tm += l.min; tk += l.km; if (l.rural) anyRural = true; });
    var pres = $('pres'); pres.textContent = '';
    var res = h('div', { class: 'res' });
    var hd = h('div', { class: 'res-hd' }, [
      name ? h('div', { class: 'res-title', text: name }) : null,
      h('div', { class: 'res-total', text: '~' + Math.round(tm) + ' min · ~' + tk.toFixed(1) + ' km' }),
      h('div', { class: 'res-cap', text: (extra ? plural(seq.length - 1, 'job') + ' + shop' : plural(seq.length, 'stop')) + (rt ? ' · round trip' : ' · open end') + ' · ~ straight-line ×1.39 at 40 km/h' + (anyRural ? ' (70 km/h rural legs)' : '') + ' · no live traffic' })
    ]);
    res.appendChild(hd);
    var btns = h('div', { class: 'res-btns' });
    parts.forEach(function (u, i) {
      btns.appendChild(h('a', { class: 'btn btn--sm btn--tinted pressable', href: u, target: '_blank', rel: 'noopener', text: parts.length === 1 ? 'Google Maps' : 'Part ' + (i + 1) + '/' + parts.length }));
    });
    btns.appendChild(h('button', { type: 'button', class: 'btn btn--sm pressable', id: 'saveR', text: 'Save', onclick: saveRoute }));
    if (extra) btns.appendChild(h('button', { type: 'button', class: 'btn btn--sm pressable', text: 'Edit stops', title: 'Copy this route into the stop list above to change it', onclick: function () { editAsStops(seq, rt); } }));
    res.appendChild(btns);
    if (extra) res.appendChild(stageRouteExtras(extra));
    var pl = h('div', { id: 'plist' });
    seq.forEach(function (s, i) {
      var leg = i > 0 ? legs[i - 1] : null;
      var row = h('div', { class: 'pl-row', 'data-i': String(i) }, [
        h('div', { class: 'rpin' + (s.shop ? ' is-shop' : ''), text: lbl(i) }),
        h('div', { class: 'tx' }, [s.name || '', leg ? h('div', { class: 'leg', text: '+~' + fmtMin(leg.min) + ' min · ~' + leg.km.toFixed(1) + ' km' + (leg.rural ? ' · rural' : '') }) : null])
      ]);
      pl.appendChild(row);
    });
    if (rt && seq.length > 1) {
      var bl = legs[legs.length - 1];
      pl.appendChild(h('div', { class: 'pl-row', 'data-i': '0' }, [h('div', { class: 'rpin' + (seq[0].shop ? ' is-shop' : ''), text: lbl(0) }),
        h('div', { class: 'tx' }, ['Return to ' + (seq[0].name || 'start'), h('div', { class: 'leg', text: '+~' + fmtMin(bl.min) + ' min · ~' + bl.km.toFixed(1) + ' km' + (bl.rural ? ' · rural' : '') })])]));
    }
    pl.addEventListener('click', function (e) {
      var r = e.target.closest('.pl-row'); if (!r || !HAS_MAP) return;
      var s = seq[+r.getAttribute('data-i')]; if (!s) return;
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), 15));
    });
    res.appendChild(pl);
    if (extra && extra.outList && extra.outList.length && !SR.oot) {
      res.appendChild(h('div', { class: 'res-note' }, [h('b', { text: 'Out of town, not included:' }),
        h('ul', { class: 'oot-list' }, extra.outList.map(function (x) { return h('li', { text: '#' + x.jobNumber + ' ' + (x.street || x.title || '') + ' · ' + x.city }); }))]));
    }
    pres.appendChild(res);
    drawRoute(seq, rt, lbl);
    var body = pres.closest('.sheet-body');                   // bring the result into view (stops list can be long)
    if (body && UI.currentView() === 'plan') {
      var top = pres.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8;
      try { body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }); } catch (e) { body.scrollTop = Math.max(0, top); }
    }
  }
  function stageRouteExtras(extra) {
    var wrap = h('div', { class: 'res-opts' });
    var rtCb = h('input', { type: 'checkbox', class: 'switch', id: 'srRt' }); rtCb.checked = !!SR.rt;
    var ootCb = h('input', { type: 'checkbox', class: 'switch', id: 'srOot' }); ootCb.checked = !!SR.oot; ootCb.disabled = !extra.outList.length;
    wrap.appendChild(h('label', { class: 'opt' }, [h('span', { text: 'Return to shop' }), rtCb]));
    wrap.appendChild(h('label', { class: 'opt' + (extra.outList.length ? '' : ' is-disabled') }, [h('span', { text: 'Include out-of-town (' + extra.outList.length + ')' }), ootCb]));
    rtCb.addEventListener('change', function () { SR.rt = rtCb.checked; buildStageRoute(); });
    ootCb.addEventListener('change', function () { SR.oot = ootCb.checked; if (!buildStageRoute()) { SR.oot = !SR.oot; ootCb.checked = SR.oot; } });
    if (extra.unmapped && extra.unmapped.length) {
      wrap.appendChild(h('div', { class: 'res-note' }, [h('b', { text: 'Not mapped, not included:' }),
        h('ul', { class: 'oot-list' }, extra.unmapped.map(function (x) { return h('li', { text: '#' + x.jobNumber + ' ' + (x.street || x.title || '') + (isWpg(x) ? '' : ' · ' + x.city) }); }))]));
    }
    if (SR.oot && extra.outList.length) wrap.appendChild(h('div', { class: 'res-note', text: 'Out-of-town jobs included; legs over 15 km use 70 km/h.' }));
    return wrap;
  }
  function styleRouteLines() {
    if (!routeLines.length) return;
    routeLines[0].setStyle({ color: cssVar('--route-casing', '#fff') });
    routeLines[1].setStyle({ color: cssVar('--route', '#0088ff') });
  }
  function drawRoute(seq, rt, lbl) {
    if (!HAS_MAP) return;
    routeLayer.clearLayers();
    var pts = seq.map(function (s) { return [s.lat, s.lon]; }); if (rt && seq.length > 1) pts.push([seq[0].lat, seq[0].lon]);
    routeLines = [
      L.polyline(pts, { color: cssVar('--route-casing', '#fff'), weight: 8, opacity: 1, interactive: false, lineJoin: 'round' }),
      L.polyline(pts, { color: cssVar('--route', '#0088ff'), weight: 5, opacity: 1, interactive: false, lineJoin: 'round' })
    ];
    routeLines.forEach(function (l) { routeLayer.addLayer(l); });
    seq.forEach(function (s, i) {
      var last = i === seq.length - 1 && !rt && i > 0;
      var m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ html: '<div class="rpin' + (s.shop ? ' is-shop' : '') + (last ? ' is-end' : '') + '">' + esc(lbl(i)) + '</div>', className: '', iconSize: [26, 26], iconAnchor: [13, 13] }),
        title: lbl(i) + ' · ' + (s.name || ''), zIndexOffset: s.shop ? 500 : 0
      });
      if (s.jobNumber != null) m.on('click', function () { var x = byNum[s.jobNumber]; if (x) openJob(x, false); });
      routeLayer.addLayer(m);
    });
    var v = UI.currentView();
    if (window.onViewChange) window.onViewChange(v);
    var pad = UI.mapPadding(); pad.maxZoom = 15;
    if (pts.length) map.fitBounds(pts, pad);
  }
  window.onViewChange = function (v) {                        // show the route instead of job pins while a result exists
    closeRouteMenu();
    if (!HAS_MAP) return;
    var route = v === 'plan' && routeLayer.getLayers().length > 0;
    if (route) { closeCard(true); if (map.hasLayer(jobLayer)) map.removeLayer(jobLayer); if (!map.hasLayer(routeLayer)) routeLayer.addTo(map); }
    else { if (map.hasLayer(routeLayer)) map.removeLayer(routeLayer); if (!map.hasLayer(jobLayer)) jobLayer.addTo(map); }
    if (v === 'plan' && !pickbox.hidden) buildPicker();
  };
  window.onLayout = function () {
    if (HAS_MAP) setTimeout(function () { map.invalidateSize(); placeCard(); }, 60);
    closeCard(true); closeRouteMenu();
    if (dataLoaded) renderChips();                            // stage chips: full names on the PC, short on the iPhone
  };

  function cleanStop(s) {
    var o = { name: String(s.name || ''), lat: +s.lat, lon: +s.lon };
    if (s.shop) o.shop = true; if (s.jobNumber != null) o.jobNumber = s.jobNumber; if (s.match) o.match = String(s.match);
    return o;
  }
  function saveRoute() {
    if (!lastResult) return;
    var nm = prompt('Name this route:', lastResult.name || new Date().toLocaleDateString()); if (!nm) return;
    var all = lsJSON('ej_routes', []); if (!Array.isArray(all)) all = [];
    all.unshift({ name: nm.slice(0, 120), when: new Date().toISOString(), seq: lastResult.seq.map(cleanStop), rt: lastResult.rt });
    try { localStorage.setItem('ej_routes', JSON.stringify(all.slice(0, 50))); toast('Route saved'); }
    catch (e) { toast('Couldn’t save (storage full or blocked)', null, { error: true }); }
    renderSaved();
  }
  function renderSaved() {
    var all = lsJSON('ej_routes', []), el = $('savedlist');
    if (!Array.isArray(all)) all = [];
    all = all.filter(function (r) { return r && Array.isArray(r.seq) && r.seq.length; });
    el.textContent = '';
    if (!all.length) { el.className = 'muted'; el.textContent = 'None yet.'; return; }
    el.className = '';
    all.forEach(function (r, i) {
      var when = new Date(r.when);
      var c = h('div', { class: 'card is-link', role: 'button', tabindex: '0' }, [
        h('b', { text: r.name || 'Route' }),
        h('div', { class: 'd', text: plural(r.seq.length, 'stop') + (isNaN(when) ? '' : ' · ' + when.toLocaleString()) + (r.rt ? ' · round trip' : '') })
      ]);
      var del = h('button', { type: 'button', class: 'btn btn--sm btn--danger pressable', style: 'margin-top:6px', text: 'Delete' });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Delete saved route “' + (r.name || 'Route') + '”?')) return;
        var cur = lsJSON('ej_routes', []); if (!Array.isArray(cur)) cur = [];
        var idx = -1; cur.forEach(function (x, j) { if (idx < 0 && x && x.when === r.when && x.name === r.name) idx = j; });
        if (idx >= 0) cur.splice(idx, 1);
        lsSet('ej_routes', JSON.stringify(cur)); renderSaved();
      });
      function load() {
        var seq = r.seq.filter(function (s) { return s && typeof s.lat === 'number' && typeof s.lon === 'number'; }).map(function (s) { return Object.assign({}, s); });
        if (!seq.length) return;
        stops = seq.slice(); renderStops(); SR = null; $('rt').checked = !!r.rt; syncFxe();
        showResult(seq, !!r.rt, r.name);
        var body = document.querySelector('#sheet .sheet-body'); if (body) body.scrollTop = 0;
      }
      c.addEventListener('click', load);
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
      c.appendChild(del); el.appendChild(c);
    });
  }

  /* ================= One-click route of the selected jobs from the shop ================= */
  // Its result lives in #pres / lastResult only: the Plan's own stops and switches are never touched ("Edit stops" copies it over).
  function queryTitle() { return query() ? ' matching “' + $('q').value.trim() + '”' : ''; }
  function startShopRoute(jobs, title) {
    if (!jobs.length) return;
    SR = { jobs: jobs, rt: false, oot: false, confirmed: 0, title: title };
    buildStageRoute();
  }
  routeBtn.addEventListener('click', function (e) {
    if (!sel().length) { toggleRouteMenu(e.detail === 0); return; }   // nothing picked: choose a stage instead
    closeRouteMenu(); startShopRoute(currentJobs(), selTitle() + queryTitle() + ' from shop');
  });
  function stageJobs(k) { var q = query(); return JOBS.filter(function (x) { return stageOf(x).key === k && (!q || hay(x).indexOf(q) >= 0); }); }
  function routeStage(k) { startShopRoute(stageJobs(k), STAGES[stageIndex(k)].label + queryTitle() + ' from shop'); }

  /* Route menu: every stage, always one tap away from the Route chevron (whatever the mode, chips or list scroll) */
  function fillRouteMenu() {
    rmenu.textContent = '';
    rmenu.appendChild(h('div', { class: 'rm-hd', 'aria-hidden': 'true', text: 'Route a stage from the shop' + queryTitle() }));
    STAGES.forEach(function (s, i) {
      var list = stageJobs(s.key), c = routeCounts(list), n = c.wpg || c.out;
      rmenu.appendChild(h('button', { type: 'button', class: 'rm-item pressable', role: 'menuitem', 'data-stage': s.key, disabled: !list.length,
        'aria-label': 'Route ' + s.label + ', ' + plural(n, 'job'),
        title: !list.length ? 'No ' + s.label + ' jobs' : 'Route ' + plural(c.wpg, 'Winnipeg job') + ' in ' + s.label + ' from the shop' + (c.out ? '; ' + c.out + ' out of town can be added' : '') },
        [h('span', { class: 'dot', style: stageVars(i), 'aria-hidden': 'true', text: String(i + 1) }), h('span', { text: s.label }), h('span', { class: 'n', text: String(n) })]));
    });
  }
  function placeRouteMenu() {
    var b = routeMore.getBoundingClientRect(), w = rmenu.offsetWidth, hgt = rmenu.offsetHeight;
    var x = Math.max(8, Math.min(innerWidth - w - 8, b.right - w)), up = b.top > innerHeight / 2;
    var y = up ? Math.max(8, b.top - hgt - 8) : Math.min(innerHeight - hgt - 8, b.bottom + 8);
    rmenu.style.setProperty('--mx', x + 'px'); rmenu.style.setProperty('--my', y + 'px');
    rmenu.style.setProperty('--ox', (b.left + b.width / 2 - x) + 'px'); rmenu.style.setProperty('--oy', up ? '100%' : '0%');
  }
  function openRouteMenu(focusFirst) {
    if (!dataLoaded || !JOBS.length) return;
    closeCard(true); fillRouteMenu();
    rmenu.hidden = false; placeRouteMenu();
    void rmenu.offsetWidth;                                   // commit the closed scale so the open springs
    rmenu.classList.add('is-open'); routeMore.setAttribute('aria-expanded', 'true');
    if (focusFirst) { var f = rmenu.querySelector('.rm-item:not(:disabled)'); if (f) f.focus(); }
  }
  function closeRouteMenu(refocus) {
    if (rmenu.hidden) return false;
    rmenu.classList.remove('is-open'); rmenu.hidden = true; routeMore.setAttribute('aria-expanded', 'false');
    if (refocus) routeMore.focus();
    return true;
  }
  function toggleRouteMenu(kbd) { if (!rmenu.hidden) closeRouteMenu(); else openRouteMenu(kbd); }
  routeMore.addEventListener('click', function (e) { toggleRouteMenu(e.detail === 0); });
  rmenu.addEventListener('click', function (e) {
    var b = e.target.closest('.rm-item'); if (!b || b.disabled) return;
    closeRouteMenu(); routeStage(b.getAttribute('data-stage'));
  });
  rmenu.addEventListener('keydown', function (e) {
    var items = [].slice.call(rmenu.querySelectorAll('.rm-item:not(:disabled)')), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); if (items.length) items[e.key === 'Home' ? 0 : items.length - 1].focus(); }
    else if (e.key === 'Tab') closeRouteMenu();
  });
  addEventListener('keydown', function (e) {                  // capture: Esc closes the menu only, not the sheet behind it
    if (e.key === 'Escape' && closeRouteMenu(true)) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (!rmenu.hidden && !rmenu.contains(e.target) && !e.target.closest('#routeMore, #routeSel')) closeRouteMenu();
  }, true);
  addEventListener('resize', function () { closeRouteMenu(); });
  function routeGroup(k) {                                    // one click from a list group header: every job in that stage / client
    var q = query(), g = groupsForMode().filter(function (x) { return x.k === k; })[0]; if (!g) return;
    startShopRoute(JOBS.filter(function (x) { return groupOf(x) === k && (!q || hay(x).indexOf(q) >= 0); }), g.label + queryTitle() + ' from shop');
  }
  function editAsStops(seq, rt) {
    if (stops.length && !confirm('Replace the ' + plural(stops.length, 'stop') + ' in your plan with this route?')) return;
    var before = stops.slice(), fx = [$('fxs').checked, $('fxe').checked, $('rt').checked];
    stops = seq.map(function (s) { return Object.assign({}, s); }); renderStops();
    $('fxs').checked = true; $('rt').checked = !!rt; syncFxe();
    var body = $('stops').closest('.sheet-body'); if (body) body.scrollTop = 0;
    if (before.length) toast('Plan stops replaced', function () {
      stops = before; renderStops(); $('fxs').checked = fx[0]; $('fxe').checked = fx[1]; $('rt').checked = fx[2]; syncFxe();
    });
  }
  function buildStageRoute() {                                // returns false if the user cancelled
    if (!SR) return false;
    var mapped = SR.jobs.filter(function (x) { return x.ok && typeof x.lat === 'number'; });
    var unmapped = SR.jobs.filter(function (x) { return mapped.indexOf(x) < 0; });
    var inTown = mapped.filter(isWpg), outList = mapped.filter(function (x) { return !isWpg(x); });
    var use = SR.oot ? mapped : inTown;
    if (!use.length) {
      lastResult = null; routeLines = []; if (routeLayer) routeLayer.clearLayers();   // no stale route under "nothing to route"
      UI.openList('plan', 'medium');
      var p = $('pres'); p.textContent = '';
      p.appendChild(h('div', { class: 'res' }, [h('div', { class: 'res-hd' }, [h('div', { class: 'res-title', text: SR.title }),
        h('div', { class: 'res-cap', text: 'No mapped Winnipeg jobs to route.' })]),
        (outList.length || unmapped.length) ? stageRouteExtras({ unmapped: unmapped, outList: outList }) : null]));
      if (window.onViewChange) window.onViewChange(UI.currentView());
      return true;
    }
    if (use.length > ROUTE_CONFIRM_ABOVE && use.length > SR.confirmed &&
        !confirm('Build a route with ' + plural(use.length, 'job') + ' from the shop? It will need ' + Math.ceil((use.length + 1 + (SR.rt ? 1 : 0) - 1) / 9) + ' Google Maps links.')) return false;
    SR.confirmed = Math.max(SR.confirmed, use.length);
    var list = [Object.assign({}, SHOP)].concat(use.map(jobStop));
    UI.openList('plan', 'medium');
    runOptimize(list, true, false, !!SR.rt, SR.title, { unmapped: unmapped, outList: outList });
    return true;
  }

  /* ================= Settings ================= */
  function segBind(el, get, set) {
    function paint() {
      var v = get(), btns = el.querySelectorAll('[data-val]');
      btns.forEach(function (b, i) { var on = b.getAttribute('data-val') === v; b.setAttribute('aria-checked', on ? 'true' : 'false'); if (on) el.style.setProperty('--i', i); });
    }
    el.addEventListener('click', function (e) { var b = e.target.closest('[data-val]'); if (!b) return; set(b.getAttribute('data-val')); paint(); });
    paint(); return paint;
  }
  var paintTheme = segBind($('setTheme'), function () { return window.getUiPrefs ? getUiPrefs().theme : 'auto'; }, function (v) { if (window.setUiPrefs) setUiPrefs({ theme: v }); });
  var paintGlass = segBind($('setGlass'), function () { return window.getUiPrefs ? getUiPrefs().glass : 'liquid'; }, function (v) { if (window.setUiPrefs) setUiPrefs({ glass: v }); });
  function syncSettingsSegs() { if (paintTheme) paintTheme(); if (paintGlass) paintGlass(); }

  function renderStageStatus(st) {
    if (!st) { try { st = store.status ? store.status() : null; } catch (e) { st = null; } }
    st = st || {};
    var mode = st.mode || store.mode, pending = st.pending || 0, lastSync = st.lastSync, lastError = st.lastError;
    var el = $('stStatus'); el.textContent = '';
    var cls = mode === 'github' ? 'is-on' : mode === 'local' ? 'is-local' : mode === 'invalid' ? 'is-err' : '';
    var text = {
      github: 'Shared on GitHub — edits on',
      readonly: 'Read-only — no edit key on this device',
      local: 'Saved on this device only (local preview)',
      invalid: 'Edit key rejected — stages are read-only'
    }[mode] || String(mode || 'Unknown');
    el.appendChild(h('span', { class: 'status-dot ' + cls, 'aria-hidden': 'true' }));
    el.appendChild(document.createTextNode(text));
    var bits = [];
    if (pending) bits.push(plural(pending, 'change') + ' waiting to sync');
    if (lastSync) { var d = new Date(lastSync); if (!isNaN(d)) bits.push('Last sync ' + fmtTime(d)); }
    if (lastError && !(mode === 'invalid' && /^Edit key rejected/.test(lastError))) bits.push(String(lastError));
    if (mode === 'invalid' && !/read but not write/.test(lastError || '')) bits.push('Check the key hasn’t expired and has Contents: Read and write on eckstein-jobs-state, then paste it again.');
    if (mode === 'local') bits.push('Saved on this device only. Paste an edit key to share stages with other devices.');
    if (bits.length) el.appendChild(h('small', { text: bits.join(' · ') }));
    var has = false; try { has = !!store.hasKey(); } catch (e) {}
    $('stShare').hidden = !has; $('stRemove').hidden = !has;
    $('stKey').placeholder = has ? 'Key saved — paste a new one to replace it' : 'Paste edit key';
  }
  function stMsg(t, kind) { var m = $('stMsg'); m.textContent = t || ''; m.className = 'set-note' + (kind ? ' is-' + kind : ''); }
  $('stSave').addEventListener('click', function () {
    var inp = $('stKey'), v = inp.value, b = $('stSave');
    if (!v || !v.trim()) { stMsg('Paste the edit key first.', 'err'); return; }
    b.disabled = true; stMsg('Checking the key with GitHub…');
    Promise.resolve().then(function () { return store.setKey(v); }).then(function (r) {
      if (r && r.ok) { inp.value = ''; stMsg('Key saved — GitHub accepted it. Stage edits are on and sync across devices; your first move confirms write access.', 'ok'); toast('Edit key saved'); }
      else stMsg('Not saved: ' + ((r && r.reason) || 'the key could not be checked.'), 'err');
    }, function () { stMsg('Not saved: the key could not be checked. Try again.', 'err'); })
      .then(function () { b.disabled = false; renderStageStatus(); lockSliders(); });
  });
  $('stKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('stSave').click(); } });
  $('stRemove').addEventListener('click', function () {
    if (!confirm('Remove the edit key from this device? Stages become read-only here.')) return;
    try { store.removeKey(); } catch (e) {}
    stMsg('Key removed from this device.'); renderStageStatus(); lockSliders();
  });
  $('stShare').addEventListener('click', function () {
    var key = null; try { key = store.getKeyForShare(); } catch (e) {}
    if (!key) { stMsg('No key saved on this device.', 'err'); return; }
    var text = 'Eckstein Jobs — stage edit access\n\n' +
      'App: ' + APP_URL + '\n' +
      'Edit key: ' + key + '\n\n' +
      'iPhone: open the link in Safari → Share → Add to Home Screen → open the app from the Home Screen → Settings → Stages → paste the key → Save.\n' +
      'PC: open the link → Settings → Stages → paste the key → Save.\n' +
      'Keep this key private; anyone with it can move job stages.';
    function fallback() { copyText(text).then(function () { toast('Copied — paste it into a message'); }, function () { toast('Couldn’t share or copy', null, { error: true }); }); }
    if (navigator.share) navigator.share({ title: 'Eckstein Jobs edit access', text: text }).catch(function (err) { if (!err || err.name !== 'AbortError') fallback(); });
    else fallback();
  });
  var devInp = $('stDevice');
  try { devInp.value = store.deviceLabel() || ''; } catch (e) {}
  function saveDevice() { var v = devInp.value.trim(); if (!v) return; try { store.setDeviceLabel(v); } catch (e) {} }
  devInp.addEventListener('change', saveDevice);
  devInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveDevice(); devInp.blur(); toast('Device name saved'); } });

  /* ================= boot ================= */
  syncModeSeg(); renderStops(); renderSaved(); renderStageStatus(); lockSliders();
  if (!HAS_MAP) { setUpd('map library failed to load — check the connection and reload'); }
  loadData().then(function () { try { store.start(); } catch (e) {} });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});

  window.EJ = {                                               // debugging / verification hooks (no secrets)
    get jobs() { return JOBS; }, get mode() { return MODE; }, get sel() { return SEL; }, store: store, map: map,
    reload: reloadData, esc: esc, get stops() { return stops; }, get lastResult() { return lastResult; }
  };
})();
