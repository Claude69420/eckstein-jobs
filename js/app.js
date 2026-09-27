/* app.js — Eckstein Jobs app logic (R-1, R-2): data, stages + job items, Client|Stage filters (stage + list chips),
 * pins, list, detail + hover card, stage moves and item switches (gated), one-click stage/list route, the route
 * planner on the single map, published routes, Jobber totals behind the pricing key ($ toggle) and Settings.
 * Plain ES2017 script, no modules. Needs Leaflet (L), js/tsp.js (TSP), js/stages.js (Stages) and js/ui.js (UI);
 * js/prices.js (Prices) is optional (without it the app simply shows no prices).
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
  var ROUTE_CONFIRM_ABOVE = 25;
  /* ===================================================================================================== */

  /* ---------------- channel config (docs/r2-plan.md sec. 9 "Beta channel") ----------------
   * window.EJ_CONFIG is set only by beta/index.html (an inline script before every other script; tools/build_beta.py).
   * Missing fields = the main app: localStorage keys NS + suffix ("ej_mode"...), data/ and routes/ under BASE ("").
   * The beta: channel "beta", BASE "../" (it reads the root site's data), NS "ejb_" (never shares keys with v1).
   * js/stages.js and js/prices.js read the same object themselves. Validation is Stages.resolveConfig's (a bad config
   * locks the stage store read-only). ns: the same NS_RE as stages.js / prices.js / the index.html boot script; a
   * given but invalid ns becomes the quarantine prefix "ejx_" there too, so UI prefs never land on v1's "ej_" keys. */
  var NS_RE = /^[A-Za-z0-9_]{1,16}$/;
  var STAGES_OK = !!(window.Stages && typeof window.Stages.resolveConfig === 'function' && typeof window.Stages.createStore === 'function');
  var CFG = (function () {
    var c; try { c = window.EJ_CONFIG; } catch (e) { c = undefined; }
    // js/stages.js missing or from another build (e.g. an HTTP-cached copy): lock (read-only NULL_STORE below)
    // instead of throwing, and never fall back onto v1's "ej_" keys for a page that set its own config.
    var r = STAGES_OK ? window.Stages.resolveConfig(c) : { channel: c && c.channel === 'beta' ? 'beta' : 'main',
      base: c && typeof c.base === 'string' ? c.base : '', ns: c ? 'ejx_' : 'ej_', locked: 'js/stages.js did not load' };
    var given = !!c && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, 'ns');
    return { channel: r.channel, base: r.base, ns: given && !NS_RE.test(c.ns) ? 'ejx_' : r.ns, locked: r.locked || null };
  })();
  var BETA = CFG.channel === 'beta', NS = CFG.ns, BASE = CFG.base;
  var APP_URL = 'https://claude69420.github.io/eckstein-jobs/' + (BETA ? 'beta/' : '');
  var APP_NAME = BETA ? 'EJ Beta' : 'Eckstein Jobs';
  // Promotion (r2-plan sec. 9): the main app copies the retired beta's per-device keys (ejb_gh_token, ejb_price_key,
  // ejb_show_prices, ejb_device unless it says "beta") into missing ej_ keys and merges ejb_routes into ej_routes ONCE,
  // before the stage and price stores read them, then removes the beta's copies of the two secrets. Main channel only;
  // values are never read here, logged or shown (Stages.migrateFromBeta).
  if (STAGES_OK && CFG.channel === 'main' && !CFG.locked && window.Stages.migrateFromBeta) {
    try { window.Stages.migrateFromBeta(window.localStorage, window.EJ_CONFIG); } catch (e) { /* storage blocked: skip */ }
  }

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
  // localStorage: k is the key SUFFIX ('mode' -> "ej_mode" / beta "ejb_mode"); every read/write is guarded.
  function lsGet(k, def) { try { var v = localStorage.getItem(NS + k); return v == null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(NS + k, v); } catch (e) {} }
  function lsJSON(k, def) { try { var v = JSON.parse(localStorage.getItem(NS + k)); return v == null ? def : v; } catch (e) { return def; } }
  function bust() { return '?t=' + Date.now(); }
  function getJSON(u) { return fetch(u, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function mappedJob(x) { return !!(x && x.ok && typeof x.lat === 'number' && typeof x.lon === 'number' && isFinite(x.lat) && isFinite(x.lon)); }
  function isWpg(x) { return String(x.city || 'Winnipeg').trim().toLowerCase() === 'winnipeg'; }
  function clientGroup(x) { return CLIENT_KEYS.indexOf(x.clientKey) >= 0 ? x.clientKey : 'Other'; }
  function clientLabel(x) { return LABEL[clientGroup(x)] || x.client || 'Other'; }
  function fmtTime(d) { return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

  /* ---------------- stages + job items (R-2: js/stages.js v2 API; r2-plan sec. 1, 2a) ----------------
   * STAGEMAP holds the STORED entries exactly as store.peek()/load()/onChange() hand them out (never replaced by
   * {stage,at,by}). Every job carries x.eff = Stages.effective(STAGEMAP[jn], x.hints, jn) (refreshEff; jn -> assess
   * "prior" for jobs that existed before the beta, r2-plan sec. 10) and, for R-1 code,
   * x.stage = x.eff.stage. Builders B/C: read x.eff, never STAGEMAP directly for values. */
  var SG = window.Stages || null;
  var HAS_STAGES = !!(SG && SG.STAGES && SG.stageIndex && SG.effective);
  var STAGES = HAS_STAGES ? SG.STAGES : [
    { key: 'ready', label: 'Ready to start', short: 'Ready' }, { key: 'setup', label: 'Setup', short: 'Setup' },
    { key: 'excavation', label: 'Excavation', short: 'Excav.' }, { key: 'base', label: 'Base', short: 'Base' },
    { key: 'prep', label: 'Prep', short: 'Prep' }, { key: 'inspected', label: 'Passed inspection', short: 'Passed' },
    { key: 'poured', label: 'Poured', short: 'Poured' }];
  var STAGE_KEYS = STAGES.map(function (s) { return s.key; });
  var ITEMS = (HAS_STAGES && SG.ITEMS) || [];                // item switches (order = row order in the detail)
  var LISTS = (HAS_STAGES && SG.LISTS) || [];                // item lists = Stage-mode list chips
  var LIST_KEYS = LISTS.map(function (l) { return l.key; }), LIST = {};
  LISTS.forEach(function (l) { LIST[l.key] = l; });
  function isListKey(k) { return LIST_KEYS.indexOf(k) >= 0; }
  function stageIndex(k) { if (HAS_STAGES) return SG.stageIndex(k); var i = STAGE_KEYS.indexOf(k); return i < 0 ? 0 : i; }
  function stageOf(x) { return STAGES[stageIndex(x.stage)]; }
  var stageVars = UI.stageVars;                               // '--c:var(--stage-N);--on-c:var(--stage-on-N)'
  function normStage(entry) { return STAGES[stageIndex(entry && entry.stage)].key; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  var NO_EFF = { stage: 'ready', assess: 'no', lane: { s: 'na' }, cut: 'na', asphalt: 'na', pavers: 'na', cleanup: 'todo', removed: false };
  function refreshEff(x) {                                    // recompute after STAGEMAP[jn] or x.hints changed
    var e = STAGEMAP[x.jobNumber] || null;
    x.eff = HAS_STAGES ? SG.effective(e, x.hints, x.jobNumber) : Object.assign({}, NO_EFF, { stage: normStage(e) });
    x.stage = x.eff.stage; x._hay = null;
    return x.eff;
  }
  function effOf(x) { return x.eff || refreshEff(x); }
  function canMoveX(x, key) { return HAS_STAGES ? SG.canMove(STAGEMAP[x.jobNumber] || null, key, x.hints) : { ok: true }; }
  function canSetX(x, item, v) { return HAS_STAGES ? SG.canSetItem(STAGEMAP[x.jobNumber] || null, item, v, x.hints) : { ok: true }; }
  function itemShownX(x, item) {                              // + a BOOKED lane stays visible (dates editable, red once late) until Poured
    if (!HAS_STAGES) return false;
    var e = effOf(x);
    return SG.itemShown(e, item) || (item === 'lane' && !!e.lane && e.lane.s === 'booked' && e.stage !== 'poured');
  }
  function fieldDone(x) { return HAS_STAGES && SG.fieldWorkDone(effOf(x)); }
  function isHidden(x) { return !!x.closed && effOf(x).removed === true; }   // closed in Jobber AND removed: gone everywhere
  function matchesKey(x, k) { return isListKey(k) ? LIST[k].predicate(effOf(x)) : effOf(x).stage === k; }
  function keyLabel(k) { return isListKey(k) ? LIST[k].label : STAGES[stageIndex(k)].label; }
  function itemVal(e, key) { return key === 'lane' ? (e.lane && e.lane.s) : e[key]; }
  function isoDay(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function fmtDay(iso) { var p = String(iso || '').split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
  function laneRange(l) {                                     // "Oct 6 – Oct 8", "from Oct 6", "until Oct 8", ""
    if (!l || l.s !== 'booked') return '';
    if (l.from && l.to) return l.from === l.to ? fmtDay(l.from) : fmtDay(l.from) + ' – ' + fmtDay(l.to);
    return l.from ? 'from ' + fmtDay(l.from) : l.to ? 'until ' + fmtDay(l.to) : '';
  }
  function dayNum(iso) { var p = String(iso).split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 864e5); }   // UTC day index
  function addDays(iso, n) { var d = new Date((dayNum(iso) + n) * 864e5); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function laneLate(e) { return !!(e && e.lane && e.lane.s === 'booked' && e.lane.to && e.lane.to < isoDay(new Date()) && e.stage !== 'poured'); }
  var ICON_CHECK = ['M5 12.5l4.3 4.3L19 7'], ICON_LIST = ['M9 7h10M9 12h10M9 17h10', 'M5 7h.01M5 12h.01M5 17h.01'];

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
  try { if (STAGES_OK) store = window.Stages.createStore() || NULL_STORE; } catch (e) { store = NULL_STORE; }
  function writable() { return !!store.writable; }

  /* ---------------- R-2 prices (js/prices.js; r2-plan sec. 5; APP_MASTER sec. 11 R-2 Q4/Q5) ----------------
   * Only Riley's devices: a separate pricing key (Settings -> Pricing) decrypts data/prices.json. PRICES = {jobNumber:
   * {t: Jobber total, u: uninvoiced}} from the last good decrypt, in memory only. priceOf(x) is null unless the key is
   * saved, prices are loaded AND the $ toggle is on, so a device without the key shows no price and no $ button anywhere.
   * Never on map pins. Labelled "Jobber total" (Jobber's tax status is mixed, so never "pre-tax"). This file never reads
   * the key itself (Prices keeps it; APP_MASTER Rule 1) and never logs it. */
  var PR = window.Prices || null, pstore = null;
  try { if (PR && PR.createPriceStore) pstore = PR.createPriceStore(); } catch (e) { pstore = null; }
  var PRICES = null, PKEY = false, SHOWP = false, priceGen = 0;
  function priceKey() { try { return !!(pstore && pstore.hasKey()); } catch (e) { return false; } }
  PKEY = priceKey();
  try { SHOWP = !!(pstore && pstore.getShow()); } catch (e) { SHOWP = false; }
  function pricesOn() { return !!(PRICES && SHOWP && PKEY); }
  function priceOf(x) {                                       // {t, u?} for a job with a positive total, else null (shows nothing)
    if (!x || !pricesOn() || !has(PRICES, x.jobNumber)) return null;
    var p = PRICES[x.jobNumber];
    return p && typeof p.t === 'number' && isFinite(p.t) && p.t > 0 ? p : null;
  }
  function sumPrices(list) {                                  // {v: total of the priced jobs, n: how many had a price}
    var v = 0, n = 0;
    if (pricesOn()) list.forEach(function (x) { var p = priceOf(x); if (p) { v += p.t; n++; } });
    return { v: v, n: n };
  }
  function fmtP(n) { return PR && PR.fmt ? PR.fmt(n) : ''; }        // "$12,345"
  function fmtPS(n) { return PR && PR.fmtShort ? PR.fmtShort(n) : ''; }   // "$12.3k"

  /* ---------------- state ---------------- */
  // ALL = every job in jobs.json; JOBS = the ones shown anywhere (not closed-in-Jobber + removed). byNum covers ALL.
  var ALL = [], JOBS = [], byNum = {}, dataLoaded = false, firstFit = false, stagesLoaded = false;
  function rebuildVisible() { JOBS = ALL.filter(function (x) { x._hidden = isHidden(x); return !x._hidden; }); paintUpd(); }
  var STAGEMAP = (function () {                               // cached last good stages: the first render is already right
    try { return (store.peek && store.peek()) || {}; } catch (e) { return {}; }
  })();
  var MODE = lsGet('mode', 'client') === 'stage' ? 'stage' : 'client';
  function loadSel(key, allowed) {
    var a = lsJSON(key, []); if (!Array.isArray(a)) a = [];
    return a.filter(function (k, i) { return allowed.indexOf(k) >= 0 && a.indexOf(k) === i; });
  }
  var SEL = { client: loadSel('vis_client', CLIENT_KEYS), stage: loadSel('vis_stage', STAGE_KEYS.concat(LIST_KEYS)) };
  function saveFilter() {
    lsSet('mode', MODE);
    lsSet('vis_client', JSON.stringify(SEL.client));
    lsSet('vis_stage', JSON.stringify(SEL.stage));
  }
  function sel() { return SEL[MODE]; }
  /* Stage mode: SEL.stage mixes stage keys and list keys ("solo, then add" across all chips); a job is shown when it
   * matches ANY selected key (Setup + Cuts & cleanup = the setup/cleanup crew's day). In the list a job sits under the
   * first selected LIST it is in (more specific), otherwise under its stage. */
  function groupOf(x) {
    if (MODE === 'client') return clientGroup(x);
    var s = SEL.stage, e = effOf(x);
    for (var i = 0; i < LIST_KEYS.length; i++) if (s.indexOf(LIST_KEYS[i]) >= 0 && LIST[LIST_KEYS[i]].predicate(e)) return LIST_KEYS[i];
    return e.stage;
  }
  function inFilter(x) {
    var s = sel(); if (!s.length) return true;
    if (MODE === 'client') return s.indexOf(clientGroup(x)) >= 0;
    return s.some(function (k) { return matchesKey(x, k); });
  }
  function hay(x) {                                           // reset by refreshEff (x._hay = null) on every stage/item change
    if (x._hay == null) {
      var st = stageOf(x), e = effOf(x), bits = [x.street, x.permit, x.jobNumber, x.title, x.city, x.client, clientLabel(x), st.label, st.short];
      LISTS.forEach(function (l) { if (l.predicate(e)) bits.push(l.label); });              // "book lane", "street cuts", "asphalt"…
      ITEMS.forEach(function (it) { if (itemVal(e, it.key) === 'req') bits.push(it.label + ' required'); });
      if (e.lane && e.lane.s === 'booked') bits.push('lane booked');
      if (x.closed) bits.push('closed in jobber');
      if (fieldDone(x)) bits.push('field work done');
      x._hay = bits.join(' ').toLowerCase();
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
      (x.jobNumber === selectedJn ? ' is-selected' : '') + '" style="' + vars + '">' + (st ? (k + 1) : '') + (fieldDone(x) ? PIN_DONE : '') + '</div>';
  }
  var PIN_DONE = '<span class="done-badge" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.3 4.3L19 7"/></svg></span>';   // constant markup
  function pinSig(x) { return MODE + '|' + (MODE === 'stage' ? x.stage : clientGroup(x)) + '|' + !!x.unscheduled + !!x.pending + '|' + fieldDone(x); }   // selection is a class toggle, not a rebuild
  function pinLabel(x) { return '#' + x.jobNumber + ' ' + (x.street || x.title || '') + ', ' + stageOf(x).label + (x.closed ? ', closed in Jobber' : '') + (fieldDone(x) ? ', field work done' : ''); }
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
  function groupsForMode() {                                  // list groups (and their order) for the current mode
    if (MODE === 'client') {
      return CLIENT_KEYS.filter(function (k) { return JOBS.some(function (x) { return clientGroup(x) === k; }) || SEL.client.indexOf(k) >= 0; })
        .map(function (k) { return { k: k, label: LABEL[k], short: LABEL[k], vars: '--c:' + COL[k], digit: '' }; });
    }
    var g = STAGES.map(function (s, i) { return { k: s.key, label: s.label, short: s.short, vars: stageVars(i), digit: String(i + 1) }; });
    LISTS.forEach(function (l) { if (SEL.stage.indexOf(l.key) >= 0) g.push({ k: l.key, label: l.label, short: l.label, list: true }); });
    return g;
  }
  function groupCount(k) {                                    // chip counts (ignore search): jobs in that client / stage / list
    var n = 0;
    if (MODE === 'client') JOBS.forEach(function (x) { if (clientGroup(x) === k) n++; });
    else JOBS.forEach(function (x) { if (matchesKey(x, k)) n++; });
    return n;
  }
  function groupSum(k) {                                      // R-2 prices: chip totals (ignore search, like the counts); '' = All
    if (!pricesOn()) return { v: 0, n: 0 };
    return sumPrices(!k ? JOBS : JOBS.filter(MODE === 'client' ? function (x) { return clientGroup(x) === k; } : function (x) { return matchesKey(x, k); }));
  }
  function sumText(s) { return s && s.n ? '· ' + fmtPS(s.v) : ''; }   // visible chip / header total, '' when nothing is priced
  function listDot() { return h('span', { class: 'dot dot--list', 'aria-hidden': 'true' }, [svgIcon(ICON_LIST)]); }
  /* R-2 Stage mode: [All + 7 stage chips] | hairline | [list chips that have jobs (or are selected)]. Layout per device in
   * components.css ("Stage-mode chips"). A list chip appearing/disappearing re-renders the chips row only. */
  var listChipSig = '';
  function listChipKeys() { return LIST_KEYS.filter(function (k) { return SEL.stage.indexOf(k) >= 0 || groupCount(k) > 0; }); }
  function renderChips() {
    chipsEl.textContent = '';
    var s = sel(), q = $('q').value.trim(), stage = MODE === 'stage';
    chipsEl.classList.toggle('chips--stage', stage); chipsEl.classList.remove('has-lists');
    // An active search stays visible when the iPhone sheet (which holds the search field) is closed.
    if (q) chipsEl.appendChild(h('button', { type: 'button', class: 'chip chip--q pressable', 'data-q': '1', 'aria-label': 'Clear search “' + q + '”', title: 'Clear search' },
      [h('span', { class: 'q-text', text: '“' + q + '”' }), h('span', { class: 'n', 'aria-hidden': 'true', text: '✕' })]));
    if (!stage) {
      chipsEl.appendChild(h('button', { type: 'button', class: 'chip pressable', 'data-k': '', 'aria-pressed': s.length ? 'false' : 'true' },
        ['All ', h('span', { class: 'n', text: String(JOBS.length) })]));
      groupsForMode().forEach(function (g) {
        chipsEl.appendChild(h('button', { type: 'button', class: 'chip pressable', 'data-k': g.k, 'aria-pressed': s.indexOf(g.k) >= 0 ? 'true' : 'false', title: g.label },
          [h('span', { class: 'dot', style: g.vars, 'aria-hidden': 'true' }), g.short + ' ', h('span', { class: 'n', text: String(groupCount(g.k)) })]));
      });
      listChipSig = '';
      return;
    }
    // Short stage names and no per-stage counts on every device (7 stages + the lists must stay compact): the full name
    // and count are in the tooltip / aria-label, the Route menu and the list group headers. List chips keep their counts.
    var setS = h('span', { class: 'chip-set chip-set--stages' });
    var allLbl = chipLabel('All', JOBS.length, groupSum(''));
    setS.appendChild(h('button', { type: 'button', class: 'chip pressable', 'data-k': '', 'data-label': 'All', 'aria-pressed': s.length ? 'false' : 'true',
      'aria-label': allLbl, title: allLbl }, ['All']));
    STAGES.forEach(function (st, i) {
      var lb = chipLabel(st.label, groupCount(st.key), groupSum(st.key));
      setS.appendChild(h('button', { type: 'button', class: 'chip pressable', 'data-k': st.key, 'data-label': st.label, 'aria-pressed': s.indexOf(st.key) >= 0 ? 'true' : 'false',
        title: lb, 'aria-label': lb },
        [h('span', { class: 'dot', style: stageVars(i), 'aria-hidden': 'true', text: String(i + 1) }), h('span', { class: 'lbl', text: st.short })]));
    });
    chipsEl.appendChild(setS);
    var lk = listChipKeys(); listChipSig = lk.join();
    if (!lk.length) return;
    chipsEl.classList.add('has-lists');                       // iPhone sheet: the lists continue beside the stage grid
    chipsEl.appendChild(h('span', { class: 'chip-div', 'aria-hidden': 'true' }));
    var setL = h('span', { class: 'chip-set chip-set--lists' });
    lk.forEach(function (k) {
      var sm = groupSum(k);
      setL.appendChild(h('button', { type: 'button', class: 'chip chip--list pressable', 'data-k': k, 'aria-pressed': s.indexOf(k) >= 0 ? 'true' : 'false', title: listChipTitle(k, sm) },
        [h('span', { class: 'lbl', text: LIST[k].label }), ' ', h('span', { class: 'n', text: String(groupCount(k)) }), h('span', { class: 'v', text: sumText(sm), hidden: !sm.n })]));
    });
    chipsEl.appendChild(setL);
  }
  function chipLabel(label, n, sm) { return label + ', ' + plural(n, 'job') + (sm && sm.n ? ', Jobber total ' + fmtP(sm.v) : ''); }
  function listChipTitle(k, sm) { return LIST[k].label + ' list' + (sm && sm.n ? ' · Jobber total ' + fmtP(sm.v) : ''); }
  function revealSelectedChip() {
    var c = chipsEl.querySelector('.chip[aria-pressed="true"]:not([data-k=""])');
    if (!c || DESK.matches || chipsEl.scrollWidth <= chipsEl.clientWidth) return;
    var cb = c.getBoundingClientRect(), pb = chipsEl.getBoundingClientRect();
    if (cb.left < pb.left + 12 || cb.right > pb.right - 12) chipsEl.scrollLeft = Math.max(0, chipsEl.scrollLeft + cb.left - pb.left - 12);
  }
  window.onFilterbarMoved = function () {                    // accessory row <-> sheet band: start at the stages
    chipsEl.scrollLeft = 0; revealSelectedChip();
  };
  function updateChipCounts() {
    if (MODE === 'stage' && listChipKeys().join() !== listChipSig) {   // a list chip appears / disappears
      var sl = chipsEl.scrollLeft; renderChips(); chipsEl.scrollLeft = sl; return;
    }
    chipsEl.querySelectorAll('.chip').forEach(function (c) {
      if (c.hasAttribute('data-q')) return;
      var k = c.getAttribute('data-k'), n = c.querySelector('.n'), v = c.querySelector('.v'), cnt = k ? groupCount(k) : JOBS.length;
      if (n) n.textContent = String(cnt);
      if (v) { var sm = groupSum(k); v.textContent = sumText(sm); v.hidden = !sm.n; c.title = listChipTitle(k, sm); }
      else if (!n && c.hasAttribute('data-label')) { var lb = chipLabel(c.getAttribute('data-label'), cnt, groupSum(k)); c.setAttribute('aria-label', lb); c.title = lb; }
    });
  }
  function routeCounts(list) {                                // mapped jobs a shop route uses by default (Winnipeg) vs out of town
    var c = { wpg: 0, out: 0 };
    list.forEach(function (x) { if (x.ok && typeof x.lat === 'number') { if (isWpg(x)) c.wpg++; else c.out++; } });
    return c;
  }
  function selTitle() {
    return sel().map(function (k) { return MODE === 'stage' ? keyLabel(k) : (LABEL[k] || k); }).join(' + ');
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
  function rowLead(x) {                                       // stage/client dot; R-2: a small green check when field work is done
    var k = stageIndex(x.stage);
    var d = MODE === 'stage' ? h('span', { class: 'dot', style: stageVars(k), 'aria-hidden': 'true', text: String(k + 1) })
      : h('span', { class: 'dot', style: '--c:' + COL[clientGroup(x)], 'aria-hidden': 'true' });
    var done = fieldDone(x);
    return h('span', { class: 'lead', title: done ? 'Field work done' : null }, [d, done ? h('span', { class: 'done-badge', 'aria-hidden': 'true' }, [svgIcon(ICON_CHECK)]) : null]);
  }
  function rowAria(x) {
    var p = priceOf(x);
    return '#' + x.jobNumber + ' ' + (x.street || x.title || '') + ', ' + stageOf(x).label + (x.ok ? '' : ', not mapped') +
      (x.closed ? ', closed in Jobber' : '') + (fieldDone(x) ? ', field work done' : '') + (p ? ', Jobber total ' + fmtP(p.t) : '');
  }
  function rowTrail(x) {                                      // pill, and under it (prices shown) the job's Jobber total, short
    var p = priceOf(x);
    return h('span', { class: 'trail' }, [rowPill(x), p ? h('span', { class: 'price', title: 'Jobber total ' + fmtP(p.t), text: fmtPS(p.t) }) : null]);
  }
  function rowPill(x) {
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
    if (x.closed) bits.push(h('span', { class: 'tag closed', text: 'Closed in Jobber' }));
    var e = effOf(x);
    if (e.lane && e.lane.s === 'booked' && e.stage !== 'poured') {                   // booked lane: its dates (red once late)
      var lr = laneRange(e.lane);
      bits.push(h('span', { class: 'tag lane' + (laneLate(e) ? ' is-late' : ''), text: 'Lane ' + (lr || 'booked') }));
    }
    var tail = [x.permit, isWpg(x) ? '' : x.city].filter(Boolean).join(' · ');
    if (tail) bits.push(' · ' + tail);
    return h('div', { class: 's' }, bits);
  }
  function makeRow(x) {
    var r = h('div', { class: 'job-row' + (x.jobNumber === selectedJn ? ' is-selected' : ''), role: 'listitem', tabindex: '0', 'data-jn': String(x.jobNumber) },
      [rowLead(x), h('div', {}, [h('div', { class: 't', text: x.street || x.title || '(no address)' }), rowSub(x)]), rowTrail(x)]);
    r.setAttribute('aria-label', rowAria(x));
    rows[x.jobNumber] = r;
    return r;
  }
  function patchRow(x) {                                      // in place: lead, sub line, trailing pill, label
    var r = rows[x.jobNumber]; if (!r) return;
    r.replaceChild(rowLead(x), r.firstChild);
    var mid = r.children[1]; mid.replaceChild(rowSub(x), mid.lastChild);
    r.replaceChild(rowTrail(x), r.lastChild);
    r.setAttribute('aria-label', rowAria(x));
  }
  var grpCounts = {}, grpSums = {};                           // group key -> its "(n)" / "· $48.2k" spans in the list headers
  function paintGrpSum(el, sm) { el.textContent = sumText(sm); el.hidden = !sm.n; el.title = sm.n ? 'Jobber total ' + fmtP(sm.v) : ''; }
  function renderList(shown) {
    rows = {}; grpCounts = {}; grpSums = {}; listEl.textContent = '';
    if (!dataLoaded) return;
    if (!shown.length) { listEl.appendChild(h('div', { class: 'muted', text: JOBS.length ? 'No jobs match.' : 'No jobs.' })); return; }
    var frag = document.createDocumentFragment();
    groupsForMode().forEach(function (g) {
      var list = shown.filter(function (x) { return groupOf(x) === g.k; }); if (!list.length) return;
      var n = grpCounts[g.k] = h('span', { class: 'grp-n', text: '(' + list.length + ')' });
      var sv = grpSums[g.k] = h('span', { class: 'grp-sum' }); paintGrpSum(sv, sumPrices(list));
      frag.appendChild(h('div', { class: 'grp', role: 'presentation' }, [g.list ? listDot() : h('span', { class: 'dot', style: g.vars, 'aria-hidden': 'true', text: g.digit }),
        h('span', { text: g.label }), n, sv,
        h('button', { type: 'button', class: 'grp-route pressable', 'data-route': g.k, title: 'Route every ' + g.label + ' job from the shop', 'aria-label': 'Route ' + g.label + ' jobs from the shop', text: 'Route' })]));
      list.forEach(function (x) { frag.appendChild(makeRow(x)); });
    });
    listEl.appendChild(frag);
  }
  function updateGroupCounts() {                              // a stage move keeps the row in place but the counts (and totals) follow the truth
    var c = {}, m = {};
    Object.keys(shownSet).forEach(function (jn) { var x = byNum[jn]; if (x) { var k = groupOf(x); c[k] = (c[k] || 0) + 1; (m[k] = m[k] || []).push(x); } });
    Object.keys(grpCounts).forEach(function (k) { grpCounts[k].textContent = '(' + (c[k] || 0) + ')'; });
    Object.keys(grpSums).forEach(function (k) { paintGrpSum(grpSums[k], sumPrices(m[k] || [])); });
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
  var SLIDER_OPTS = { gate: function (x, key) { return canMoveX(x, key); }, onBlocked: function (x, key, r) { blockedMove(x, key, r); } };
  var detailSlider = UI.StageSlider($('dStage'), moveStage, SLIDER_OPTS), detailJn = null;
  function select(x) {
    var prev = selectedJn; selectedJn = x ? x.jobNumber : null;
    if (prev != null && byNum[prev]) updatePin(byNum[prev]);
    if (x) updatePin(x);
    listEl.querySelectorAll('.job-row.is-selected').forEach(function (r) { r.classList.remove('is-selected'); });
    if (x && rows[x.jobNumber]) rows[x.jobNumber].classList.add('is-selected');
  }
  window.clearSelection = function (scrollToRow) {
    var jn = selectedJn; detailJn = null; select(null); paintDetailPrice(null);   // no price text left in a closed sheet
    if (scrollToRow && jn != null && rows[jn]) { rows[jn].classList.add('is-selected'); try { rows[jn].scrollIntoView({ block: 'nearest' }); } catch (e) {} setTimeout(function () { if (rows[jn] && selectedJn == null) rows[jn].classList.remove('is-selected'); }, 1200); }
  };
  function lockSliders() {
    var ro = !writable();
    detailSlider.lock(ro); cardSlider.lock(ro);
    $('dLock').hidden = !ro; $('mcLock').hidden = !ro;
    if (detailJn != null && byNum[detailJn]) paintItems(byNum[detailJn]);
  }
  window.fillDetail = function (x) {                          // static parts once per open; live parts in refreshDetail
    var same = detailJn === x.jobNumber;                      // a data reload refills the job already shown
    select(x); detailJn = x.jobNumber;
    $('dTitle').textContent = x.street || x.title || '(no address)';
    $('dSub').textContent = [clientLabel(x), '#' + x.jobNumber, x.permit ? 'Permit ' + x.permit : ''].filter(Boolean).join(' · ');
    var dir = $('dDir'), la = Number(x.lat), lo = Number(x.lon);
    if (x.ok && isFinite(la) && isFinite(lo)) { dir.href = 'https://www.google.com/maps/dir/?api=1&destination=' + la + ',' + lo; dir.removeAttribute('aria-disabled'); dir.removeAttribute('tabindex'); }
    else { dir.href = '#'; dir.setAttribute('aria-disabled', 'true'); dir.setAttribute('tabindex', '-1'); }
    $('dAdd').disabled = !mappedJob(x);
    paintDetailPrice(x);
    var info = $('dInfo'); info.textContent = '';
    info.appendChild(h('div', { class: 'info-line', text: x.title || '' }));
    info.appendChild(h('div', { class: 'info-line', text: [x.street, x.city].filter(Boolean).join(', ') + (x.client ? ' · ' + x.client : '') }));
    info.appendChild(h('div', { class: 'info-line', id: 'dStageInfo' }));
    if (!same) itemsJn = null;                                // rebuild the item rows only for another job (never under a focused date)
    refreshDetail(x); lockSliders();
  };
  function refreshDetail(x) {                                 // tags, slider, items, remove box, "Updated …": in place
    if (detailJn !== x.jobNumber) return;
    var tags = $('dTags'); tags.textContent = '';
    if (x.pending) tags.appendChild(h('span', { class: 'tag pend', text: 'PENDING · not in Jobber yet' }));
    if (x.unscheduled) tags.appendChild(h('span', { class: 'tag uns', text: 'UNSCHEDULED' }));
    if (!x.ok) tags.appendChild(h('span', { class: 'tag unm', text: 'not mapped' }));
    if (!isWpg(x)) tags.appendChild(h('span', { class: 'tag', text: x.city }));
    if (x.closed) tags.appendChild(h('span', { class: 'tag closed', text: 'Closed in Jobber' }));
    if (fieldDone(x)) tags.appendChild(h('span', { class: 'tag done' }, [svgIcon(ICON_CHECK), 'Field work done']));
    tags.hidden = !tags.firstChild;
    detailSlider.set(x);
    paintItems(x);
    $('dRemoveBox').hidden = !x.closed;
    renderStageInfo(x);
  }
  /* R-2 prices: "Jobber total $12,345 · Uninvoiced $3,400" under the sub line (the second part only when u < t). */
  function paintDetailPrice(x) {
    var el = $('dPrice'), p = priceOf(x);
    el.textContent = ''; el.hidden = !p;
    if (!p) return;
    el.appendChild(document.createTextNode('Jobber total '));
    el.appendChild(h('b', { text: fmtP(p.t) }));
    if (typeof p.u === 'number' && isFinite(p.u) && p.u < p.t) {
      el.appendChild(h('span', { class: 'u', text: ' · ' + (p.u > 0 ? 'Uninvoiced ' + fmtP(p.u) : 'Fully invoiced') }));
    }
  }
  function renderStageInfo(x) {                               // "Updated <time> by <device>" from the stored entry
    var el = $('dStageInfo'); if (!el || detailJn !== x.jobNumber) return;
    var entry = STAGEMAP[x.jobNumber], d = entry && entry.at ? new Date(entry.at) : null;
    el.textContent = d && !isNaN(d) ? 'Updated ' + fmtTime(d) + (entry.by ? ' by ' + String(entry.by).slice(0, 40) : '') : '';
    el.hidden = !el.textContent;
  }

  /* ---------------- R-2 job items in the detail sheet (#dItems): one compact row per shown item ----------------
   * Row = name (+ tiny caption) and an iOS-style segmented switch (ITEMS value labels). Lane "Booked" reveals Start/End
   * native date inputs. "Done" that canSetItem refuses (before Poured) is dimmed; tapping it says why. Built once per
   * opened job, then painted in place (never rebuilt under the finger / a focused date field). */
  var itemsEl = $('dItemList'), itemRows = {}, itemsJn = null;
  function toneOf(v) { return v === 'req' ? 'req' : (v === 'done' || v === 'booked') ? 'done' : ''; }
  function buildItems(x) {
    itemsEl.textContent = ''; itemRows = {}; itemsJn = x.jobNumber;
    ITEMS.forEach(function (it) {
      var seg = h('div', { class: 'seg seg--item', role: 'radiogroup', 'aria-label': it.label, 'data-item': it.key, style: '--n:' + it.values.length + ';--i:0' });
      it.values.forEach(function (v) {
        seg.appendChild(h('button', { type: 'button', class: 'pressable', role: 'radio', 'aria-checked': 'false', 'data-v': v, 'data-tone': toneOf(v), text: it.labels[v] }));
      });
      seg.appendChild(h('span', { class: 'seg-thumb', 'aria-hidden': 'true' }));
      var cap = h('span', { class: 'item-cap', hidden: true });
      var row = h('div', { class: 'item', 'data-item': it.key, hidden: true }, [h('div', { class: 'item-name' }, [h('span', { text: it.label }), cap]), seg]);
      var dates = null;
      if (it.dates) {
        dates = h('div', { class: 'item-dates', hidden: true }, [
          h('label', {}, ['Start', h('input', { type: 'date', 'data-d': 'from', 'aria-label': 'Lane closure start date' })]),
          h('label', {}, ['End', h('input', { type: 'date', 'data-d': 'to', 'aria-label': 'Lane closure end date' })])]);
        row.appendChild(dates);
      }
      itemRows[it.key] = { row: row, seg: seg, cap: cap, dates: dates };
      itemsEl.appendChild(row);
    });
  }
  function paintItems(x) {
    if (!itemsEl || detailJn !== x.jobNumber) return;
    if (itemsJn !== x.jobNumber) buildItems(x);
    var e = effOf(x), entry = STAGEMAP[x.jobNumber] || null, ro = !writable(), any = false;
    ITEMS.forEach(function (it) {
      var r = itemRows[it.key], shown = itemShownX(x, it.key);
      r.row.hidden = !shown; if (!shown) return;
      any = true;
      var v = itemVal(e, it.key), idx = it.values.indexOf(v);   // -1: assess "prior" (no segment selected)
      r.seg.style.setProperty('--i', Math.max(0, idx));
      r.seg.classList.toggle('is-none', idx < 0);
      r.seg.setAttribute('data-tone', toneOf(v));              // tinted thumb for Required / Done / Booked
      r.seg.classList.toggle('is-ro', ro);
      r.seg.querySelectorAll('button').forEach(function (b) {
        var bv = b.getAttribute('data-v'), on = bv === v;
        b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on || (idx < 0 && bv === it.values[0]) ? 0 : -1;
        var g = on ? { ok: true } : priorNo(x, it.key, bv) ? PRIOR_NO : canSetX(x, it.key, it.key === 'lane' ? { s: bv } : bv);
        if (!g.ok && (g.reason === 'poured' || g.reason === 'prior')) { b.setAttribute('aria-disabled', 'true'); b.title = g.message; }
        else { b.removeAttribute('aria-disabled'); b.removeAttribute('title'); }
      });
      r.row.classList.toggle('is-quiet', v === 'na');
      var cap = '', late = false;
      if (it.hint && !has(entry, it.key) && x.hints && x.hints[it.key] === true) cap = 'from Jobber';
      else if (idx < 0 && it.labels[v]) cap = v === 'prior' ? PRIOR_CAP : it.labels[v];   // r2-plan sec. 10
      r.cap.textContent = cap; r.cap.hidden = !cap; r.cap.classList.toggle('is-late', late);
      if (r.dates) {
        var booked = v === 'booked';
        r.dates.hidden = !booked;
        r.dates.classList.toggle('is-late', laneLate(e));
        r.dates.querySelectorAll('input').forEach(function (inp) {
          inp.disabled = ro;
          if (document.activeElement !== inp) inp.value = (booked && e.lane[inp.getAttribute('data-d')]) || '';
        });
      }
    });
    $('dItems').hidden = !any;
  }
  function nudge(seg) { if (!seg) return; seg.classList.remove('is-nudge'); void seg.offsetWidth; seg.classList.add('is-nudge'); setTimeout(function () { seg.classList.remove('is-nudge'); }, 420); }
  function readOnlyToast() { toast('Stages are read-only on this device', openStageSettings, { action: 'Settings' }); }
  /* A job from before the beta (Stages.priorAssessed, r2-plan sec. 10) cannot be set to "Not yet", whether it shows
   * "Assessed before beta" or a stored Virtual / On site: "no" is the default and is never stored, so the tap would
   * only clear the stored value and the job would show "prior" again. Dimmed like a refused "Done"; tapping says why
   * (Undo still takes back a Virtual / On site tapped by mistake). Based on the jobNumber, not the current value. */
  // The crew never used the beta, so the promoted main app words it as "this update" (the beta keeps its wording).
  var PRIOR_CAP = BETA ? 'Assessed before beta' : 'Assessed before this update';
  var PRIOR_NO = { ok: false, reason: 'prior', message: BETA ? 'Jobs from before the beta count as assessed' : 'Jobs from before this update count as assessed' };
  function priorNo(x, key, v) { return key === 'assess' && v === 'no' && !!(SG && SG.priorAssessed && SG.priorAssessed(x.jobNumber)); }
  function setItemFromUI(x, key, v, seg) {
    var it = ITEMS.filter(function (d) { return d.key === key; })[0]; if (!it) return;
    if (!writable()) { nudge(seg); readOnlyToast(); return; }
    var e = effOf(x); if (itemVal(e, key) === v) return;
    if (priorNo(x, key, v)) { nudge(seg); toast(PRIOR_NO.message); return; }
    var val = v;
    if (key === 'lane') { val = { s: v }; if (v === 'booked') { if (e.lane.from) val.from = e.lane.from; if (e.lane.to) val.to = e.lane.to; } }
    var g = canSetX(x, key, val);
    if (!g.ok) { nudge(seg); toast(g.message || 'Not possible yet'); return; }
    var patch = {}; patch[key] = val;
    changeJob(x, patch, { msg: it.label + ': ' + it.labels[v] });
  }
  itemsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.seg--item > button'); if (!b) return;
    var x = byNum[detailJn]; if (!x) return;
    setItemFromUI(x, b.parentNode.getAttribute('data-item'), b.getAttribute('data-v'), b.parentNode);
  });
  itemsEl.addEventListener('keydown', function (e) {           // radiogroup arrows move the selection
    var b = e.target.closest && e.target.closest('.seg--item > button'); if (!b) return;
    var d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!d) return;
    e.preventDefault();
    var bs = [].slice.call(b.parentNode.querySelectorAll('button')), n = bs[bs.indexOf(b) + d];
    if (n) { n.click(); n.focus(); }
  });
  /* Lane dates: the iPhone wheel commits on change; on the PC typing a year passes through 0002, 0020… so a change
   * is committed after a pause (or on blur) and only with a plausible year. */
  var dateT = 0;
  function plausible(v) { var y = +String(v).slice(0, 4); return !v || (y >= 2020 && y <= 2100); }
  function commitLaneDates(force) {
    clearTimeout(dateT);
    var x = byNum[detailJn], r = itemRows.lane; if (!x || !r || !r.dates) return;
    var e = effOf(x); if (!e.lane || e.lane.s !== 'booked') return;
    var from = r.dates.querySelector('[data-d="from"]').value, to = r.dates.querySelector('[data-d="to"]').value;
    if ((from || '') === (e.lane.from || '') && (to || '') === (e.lane.to || '')) return;
    function revert(msg) { if (msg) toast(msg); r.dates.querySelectorAll('input').forEach(function (i) { i.value = e.lane[i.getAttribute('data-d')] || ''; }); }
    if (!writable()) { revert(); readOnlyToast(); return; }
    if (!plausible(from) || !plausible(to)) { if (force) revert('Pick a date between 2020 and 2100'); return; }
    if (from && to && from > to && from !== (e.lane.from || '')) {   // rescheduled by its Start: shift the End, same length
      var len = e.lane.from && e.lane.to ? Math.max(0, dayNum(e.lane.to) - dayNum(e.lane.from)) : 0;
      to = addDays(from, len);
      r.dates.querySelector('[data-d="to"]').value = to;
    }
    var val = { s: 'booked' }; if (from) val.from = from; if (to) val.to = to;
    var g = canSetX(x, 'lane', val);
    if (!g.ok) { if (force || g.reason !== 'dates' || !r.dates.contains(document.activeElement)) revert(g.message); return; }
    changeJob(x, { lane: val }, { msg: 'Lane closure: ' + (laneRange(val) || 'Booked') });
  }
  itemsEl.addEventListener('change', function (e) {
    if (!e.target.closest('.item-dates input')) return;
    clearTimeout(dateT);
    if (document.activeElement === e.target && FINE.matches) dateT = setTimeout(function () { commitLaneDates(false); }, 900);
    else commitLaneDates(true);
  });
  itemsEl.addEventListener('focusout', function (e) {
    if (!e.target.closest || !e.target.closest('.item-dates input')) return;
    setTimeout(function () { if (!itemsEl.contains(document.activeElement) || !document.activeElement.closest('.item-dates')) commitLaneDates(true); }, 0);
  });
  /* A blocked stage move: toast with the reason and point at the item that blocks it (never silently ignored). */
  function flagEl(el) { if (!el) return; el.classList.remove('is-flagged'); void el.offsetWidth; el.classList.add('is-flagged'); setTimeout(function () { el.classList.remove('is-flagged'); }, 1900); }
  function flagItem(key) {
    var r = key && itemRows[key]; if (!r || r.row.hidden) return;
    var body = $('detail').querySelector('.sheet-body');      // scroll the sheet body only (never the page: iOS would pan)
    var rb = r.row.getBoundingClientRect(), bb = body.getBoundingClientRect();
    if (rb.bottom > bb.bottom - 12 || rb.top < bb.top) body.scrollTop = Math.max(0, body.scrollTop + rb.top - bb.top - Math.max(16, bb.height / 3));
    flagEl(r.row);
  }
  function blockedMove(x, key, res) {
    var item = res && (res.reason === 'lane' || res.reason === 'cut') ? res.reason : null;
    var msg = (res && res.message) || 'Can’t move to ' + keyLabel(key) + ' yet';
    if (detailJn === x.jobNumber && UI.isDetailOpen()) { flagItem(item); toast(msg); return; }
    if (cardJob === x) flagEl($('mcItems'));
    toast(msg, function () { closeCard(true); openJob(x, false); setTimeout(function () { flagItem(item); }, DESK.matches ? 60 : 450); }, { action: 'Details' });
  }
  function focusJob(x, zoomIn) { if (x.ok) focusPoint(x.lat, x.lon, zoomIn); }
  function focusPoint(lat, lon, zoomIn) {                     // bring a point into the part of the map not covered by glass
    if (!HAS_MAP) return;
    var ll = L.latLng(lat, lon), pad = UI.mapPadding(), size = map.getSize();
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
    var x = byNum[detailJn]; if (!mappedJob(x)) return;
    toast(addJobToRoute(x), function () { UI.openList('plan', 'medium'); }, { action: 'Open' });   // R-2: into the route editor
  });
  $('dCopy').addEventListener('click', function () {
    var x = byNum[detailJn]; if (!x) return;
    var text = [x.street || x.title, x.city].filter(Boolean).join(', ') + (x.city ? ', MB' : '');
    copyText(text).then(function () { toast('Address copied'); }, function () { toast('Couldn’t copy', null, { error: true }); });
  });
  $('dDir').addEventListener('click', function (e) { if (this.getAttribute('aria-disabled') === 'true') e.preventDefault(); });
  $('dRemove').addEventListener('click', function () {        // R-2: only offered for jobs closed in Jobber
    var x = byNum[detailJn]; if (!x || !x.closed) return;
    if (!writable()) { readOnlyToast(); return; }
    if (!confirm('Remove “' + (x.street || x.title || '#' + x.jobNumber) + '” from the app? It is closed in Jobber; it disappears on every device.')) return;
    changeJob(x, { removed: true }, { msg: 'Removed from app' });
  });
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    return new Promise(function (res, rej) {
      try { var ta = h('textarea', { style: 'position:fixed;top:-100px;left:0;opacity:0' }); ta.value = t; document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); document.body.removeChild(ta); if (ok) res(); else rej(new Error('copy')); } catch (e) { rej(e); }
    });
  }

  /* ---------------- desktop hover card (fine pointer only) ---------------- */
  var card = $('map-card'), cardJob = null, showT = 0, hideT = 0;
  var cardSlider = UI.StageSlider($('mcStage'), function (x, key) { card.classList.add('is-pinned'); moveStage(x, key); }, SLIDER_OPTS);
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
  /* R-2: at most ONE short line of open items under the title (closed / field work done first). */
  function paintCardItems(x) {
    var el = $('mcItems'), e = effOf(x), bits = [];
    if (fieldDone(x)) bits.push(h('span', { class: 'ok', text: '✓ Field work done' }));
    if (e.lane.s === 'req') bits.push(h('span', { class: 'req', text: 'Lane closure required' }));
    else if (e.lane.s === 'booked' && e.stage !== 'poured') bits.push(h('span', { class: laneLate(e) ? 'req' : '', text: 'Lane booked' + (laneRange(e.lane) ? ' ' + laneRange(e.lane) : '') }));
    if (e.cut === 'req') bits.push(h('span', { class: 'req', text: 'Street cut required' }));
    if (e.asphalt === 'req') bits.push(h('span', { text: 'Asphalt required' }));
    if (e.pavers === 'req') bits.push(h('span', { text: 'Pavers required' }));
    if (e.stage === 'poured' && e.cleanup === 'todo') bits.push(h('span', { text: 'Cuts & cleanup to do' }));
    el.textContent = '';
    if (x.closed) el.appendChild(h('span', { class: 'tag closed', style: 'margin-left:0;margin-right:6px', text: 'Closed in Jobber' }));
    bits.forEach(function (b, i) { if (i) el.appendChild(document.createTextNode(' · ')); el.appendChild(b); });
    el.hidden = !x.closed && !bits.length;
    el.title = el.textContent;
  }
  function openCard(x) {
    if (!x.ok || !FINE.matches) return;
    if (!cardJob || cardJob.jobNumber !== x.jobNumber) card.classList.remove('is-pinned');   // a new job starts unpinned (a reload keeps it)
    cardJob = x; card.hidden = false;
    $('mcTitle').textContent = x.street || x.title || '(no address)';
    $('mcSub').textContent = clientLabel(x) + ' · #' + x.jobNumber + (x.permit ? ' · ' + x.permit : '');
    paintCardItems(x); paintCardPrice(x);
    cardSlider.set(x); lockSliders();
    cardH = card.offsetHeight || 150;                         // measured once per open, not on every map move
    placeCard(); card.classList.add('is-open');
  }
  function paintCardPrice(x) {                                // R-2 prices: the job's Jobber total on the title line
    var el = $('mcPrice'), p = priceOf(x);
    el.textContent = p ? fmtP(p.t) : ''; el.hidden = !p; el.title = p ? 'Jobber total' : '';
  }
  function refreshCard(x) { if (cardJob !== x) return; paintCardItems(x); cardSlider.set(x); cardH = card.offsetHeight || cardH; }
  function closeCard(force) {
    clearTimeout(showT);
    if (!cardJob && !card.classList.contains('is-open')) return false;
    if (!force && cardSlider.isDragging()) return false;
    card.classList.remove('is-open', 'is-pinned'); cardJob = null; clearTimeout(showT); clearTimeout(hideT); paintCardPrice(null);
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

  /* ---------------- R-2 job changes (stage moves AND item switches): optimistic, undoable, never re-filters ----------------
   * changeJob(x, patch, {msg}) = compute the new STORED entry locally (Stages._util.applyFields), update pin/row/chips/
   * counts/detail/card in place, show "<msg>" + Undo, then store.set(jobNumber, patch, {label}). A rejected save rolls
   * back only the fields it wrote that nobody changed since (per job+field in-flight bookkeeping, like R-1's per job).
   * Only closed-in-Jobber + removed changes the visible set (then the list is re-rendered and the job's sheet closes). */
  var inflight = {};                                          // 'jn|field' -> {base: stored value or undefined, seq}
  var undoToast = null;                                       // {jn, fn, until} of the Undo toast on screen
  function cloneVal(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
  function sameVal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function entryWith(entry, f, v) {                           // stored entry with field f set to v (undefined = delete) or null
    var o = entry ? JSON.parse(JSON.stringify(entry)) : {};
    if (v === undefined) delete o[f]; else o[f] = cloneVal(v);
    return Object.keys(o).some(function (k) { return k !== 'at' && k !== 'by'; }) ? o : null;
  }
  function refreshJob(x) {                                    // after STAGEMAP[jn] changed: everything that shows this job
    var wasHidden = !!x._hidden;
    refreshEff(x);
    if (isHidden(x) !== wasHidden) {                          // removed from the app (or back): the visible set changes
      rebuildVisible();
      if (x._hidden) { if (detailJn === x.jobNumber) UI.closeDetail(); if (cardJob === x) closeCard(true); }
      renderAll(); refreshOpenJob();
      return;
    }
    updatePin(x); patchRow(x); updateChipCounts(); updateGroupCounts(); updateCount();
    if (detailJn === x.jobNumber) refreshDetail(x);
    if (cardJob === x) refreshCard(x);
  }
  function openStageSettings() { UI.openSettings('stages'); }
  function moveStage(x, key) {                                // slider commit (gates already checked by the slider)
    key = STAGES[stageIndex(key)].key;
    if (key === x.stage) return;
    if (!writable()) { readOnlyToast(); if (detailJn === x.jobNumber) detailSlider.set(x); if (cardJob === x) cardSlider.set(x); return; }
    var g = canMoveX(x, key); if (!g.ok) { if (detailJn === x.jobNumber) detailSlider.set(x); if (cardJob === x) cardSlider.set(x); blockedMove(x, key, g); return; }
    changeJob(x, { stage: key }, { stage: true });
  }
  function changeJob(x, patch, opts) {
    opts = opts || {};
    var jn = x.jobNumber;
    if (!writable()) { readOnlyToast(); refreshJob(x); return; }
    var fields = HAS_STAGES && SG._util && SG._util.cleanPatch ? SG._util.cleanPatch(patch) : null;
    if (!fields) { toast('Couldn’t make that change', null, { error: true }); refreshJob(x); return; }
    var before = STAGEMAP[jn] || null, undoPatch = {}, my = {};
    Object.keys(fields).forEach(function (f) {
      var had = has(before, f);
      undoPatch[f] = had ? cloneVal(before[f]) : null;        // null = back to the default (asphalt/pavers: the Jobber hint)
      var k = jn + '|' + f, fl = inflight[k] || (inflight[k] = { base: had ? cloneVal(before[f]) : undefined, seq: 0 });
      my[f] = ++fl.seq;
    });
    var next = SG._util.applyFields(before, fields);
    if (!Object.keys(next).some(function (k) { return k !== 'at' && k !== 'by'; })) next = null;
    else { next.at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); next.by = store.deviceLabel ? store.deviceLabel() : ''; }
    if (next) STAGEMAP[jn] = next; else delete STAGEMAP[jn];
    refreshJob(x);
    var msg = opts.msg || (opts.stage ? (opts.isUndo ? 'Moved back to ' : 'Moved to ') + STAGES[stageIndex(fields.stage)].label : 'Saved');
    if (opts.isUndo) { undoToast = null; toast(msg); }
    else {
      var undo = function () {
        var j = byNum[jn] || x;
        if (has(undoPatch, 'stage')) {                        // moving forward again: the gates apply to an Undo too
          var to = undoPatch.stage || 'ready', gm = canMoveX(j, to);
          if (!gm.ok) { blockedMove(j, to, gm); return; }
        }
        var bad = Object.keys(undoPatch).filter(function (f) {  // e.g. "Done" again after the job left Poured
          return f !== 'stage' && f !== 'removed' && undoPatch[f] != null && !canSetX(j, f, undoPatch[f]).ok;
        })[0];
        if (bad) { toast(canSetX(j, bad, undoPatch[bad]).message || 'Can’t undo that now', null, { error: true }); return; }
        changeJob(j, undoPatch, { isUndo: true, stage: opts.stage, msg: opts.stage ? null : has(fields, 'removed') ? 'Back in the app' : 'Undone' });
      };
      undoToast = { jn: jn, fn: undo, until: Date.now() + 5000 };
      toast(msg, undo);
    }
    var p;
    try { p = store.set(jn, patch, { label: x.street || x.title || '' }); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(function (r) {
      Object.keys(my).forEach(function (f) {
        var k = jn + '|' + f, fl = inflight[k];
        if (fl && fl.seq === my[f]) delete inflight[k];
        else if (fl) fl.base = has(next, f) ? cloneVal(next[f]) : undefined;   // saved: a later overlapping change rolls back to THIS
      });
      if (r && r.status === 'queued') {                       // keep the Undo of this change reachable for its full 5 s
        var u = undoToast, left = u && u.jn === jn ? u.until - Date.now() : 0;
        // reason "format": stages.json is in another app version's format (promotion in progress, or reopen to update)
        var qm = r.reason === 'format' ? 'Saved on this device — syncs after the app update' : 'Saved offline — will sync';
        if (left > 500) toast(qm, u.fn, { ms: left });
        else toast(qm);
      }
    }, function (err) {
      var cur = STAGEMAP[jn] || null;
      Object.keys(my).forEach(function (f) {
        var k = jn + '|' + f, fl = inflight[k], base = fl ? fl.base : (has(before, f) ? before[f] : undefined);
        if (fl && fl.seq === my[f]) delete inflight[k];
        var mine = has(next, f) ? next[f] : undefined, now = has(cur, f) ? cur[f] : undefined;
        if (sameVal(mine, now)) cur = entryWith(cur, f, base);  // only if nobody changed the field since
      });
      if (cur) STAGEMAP[jn] = cur; else delete STAGEMAP[jn];
      refreshJob(byNum[jn] || x);
      var code = err && err.code;
      var emsg = code === 'auth' ? 'Edit key rejected — Settings → Stages'
        : code === 'readonly' ? 'Stages are read-only on this device'
        : code === 'conflict' ? 'Couldn’t save (changed elsewhere) — try again'
        : (opts.stage ? 'Couldn’t save stage — try again' : 'Couldn’t save — try again');
      toast(emsg, (code === 'auth' || code === 'readonly') ? openStageSettings : null, { error: true, action: 'Settings' });
      lockSliders();
    });
  }

  function mergeStages(m) {                                   // a full stored map (load): recompute every job
    STAGEMAP = m || {};
    ALL.forEach(refreshEff); rebuildVisible();
  }
  store.onChange(function (m) {                               // poll result / replay rollback / key change: update IN PLACE
    STAGEMAP = m || {};
    var changed = false;
    ALL.forEach(function (x) { var hb = !!x._hidden; refreshEff(x); if (isHidden(x) !== hb) changed = true; });
    if (changed) {                                            // a job was removed (or restored) elsewhere
      rebuildVisible();
      var d = detailJn != null && byNum[detailJn];
      if (d && d._hidden) UI.closeDetail();
      if (cardJob && cardJob._hidden) closeCard(true);
      renderAll();
    } else {
      JOBS.forEach(function (x) { updatePin(x); patchRow(x); });
      updateChipCounts(); updateGroupCounts(); updateCount();
    }
    if (detailJn != null && byNum[detailJn] && UI.isDetailOpen()) refreshDetail(byNum[detailJn]);
    if (cardJob) refreshCard(cardJob);
  });
  var lastMode = store.mode;
  store.onStatus(function (st) {
    renderStageStatus(st);
    lockSliders();
    if (st && st.mode === 'invalid' && lastMode !== 'invalid') toast('Edit key rejected — Settings → Stages', openStageSettings, { error: true, action: 'Settings' });
    lastMode = st && st.mode;
  });

  /* ---------------- data loading ----------------
   * data/jobs.json = Jobber's active + pending jobs (the same set v1 shows). data/closed_jobs.json (sync, R-2 beta
   * contract) = jobs closed in Jobber that are kept because field work remains; every one is merged with closed:true.
   * Always asked for (contract rule 3): a 404 (an older sync that never wrote it) means none; any other failure keeps
   * the closed jobs from the last good load. */
  var loading = false, fitBeforeStages = false, lastClosed = [], lastMeta = null, updFailed = false;
  function loadClosed() {
    return getJSON(BASE + 'data/closed_jobs.json' + bust()).then(function (c) {
      return Array.isArray(c) ? c : [];
    }, function (e) { return /^HTTP 404$/.test(e && e.message) ? [] : null; });
  }
  function mergeClosed(active, closed) {                     // active wins on a duplicate job number
    var seen = {};
    active.forEach(function (x) { seen[String(x.jobNumber)] = 1; });
    var out = [];
    (closed || []).forEach(function (x) {
      if (!x || typeof x !== 'object' || x.jobNumber == null || seen[String(x.jobNumber)]) return;
      seen[String(x.jobNumber)] = 1;
      x.closed = true; out.push(x);
    });
    return active.concat(out);
  }
  function setUpd(t) { $('upd').textContent = t; $('setUpd').textContent = t; }
  /** "mapped/total mapped · updated ...": meta.json counts jobs.json only (v1 reads it unchanged), so the closed-in-
   *  Jobber jobs this app shows (not removed) are added here. Repainted whenever the visible set changes. */
  function paintUpd() {
    if (!dataLoaded || updFailed) return;
    var m = lastMeta, closed = JOBS.filter(function (x) { return x.closed; });
    var closedOk = closed.filter(function (x) { return x.ok; }).length;
    if (m && m.updated_utc) {
      var d = new Date(m.updated_utc);
      var mapped = m.mapped != null ? m.mapped + closedOk : JOBS.filter(function (x) { return x.ok; }).length;
      var total = m.total != null ? m.total + closed.length : JOBS.length;
      setUpd(mapped + '/' + total + ' mapped · updated ' + (isNaN(d) ? m.updated_utc : fmtTime(d)));
    } else setUpd(JOBS.length + ' jobs');
  }
  function loadData() {
    if (loading) return Promise.resolve();
    loading = true; $('rf').classList.add('is-spinning');
    if (!dataLoaded) countEl.textContent = 'Loading…';
    var metaP = getJSON(BASE + 'data/meta.json' + bust()).catch(function () { return null; });
    var jobsP = Promise.all([getJSON(BASE + 'data/jobs.json' + bust()), metaP, loadClosed()])
      .then(function (res) {
        var j = res[0];
        if (!Array.isArray(j)) throw new Error('bad jobs.json');
        if (res[2]) lastClosed = res[2];
        ALL = mergeClosed(j.filter(function (x) { return x && x.jobNumber != null; }), lastClosed);
        byNum = {}; ALL.forEach(function (x) { byNum[x.jobNumber] = x; refreshEff(x); });
        dataLoaded = true; updFailed = false; lastMeta = res[1];
        rebuildVisible();                                      // R-2: closed-in-Jobber + removed jobs are hidden everywhere (+ header)
        renderAll();
        if (!firstFit) { firstFit = true; fitAll(); fitBeforeStages = !stagesLoaded; }
        refreshOpenJob();
      })
      .catch(function (e) {
        if (!dataLoaded) countEl.textContent = 'Couldn’t load';
        updFailed = true; setUpd('failed to load data'); toast('Couldn’t load job data', null, { error: true });
        if (window.console) console.error('jobs load failed', e && e.message);
      });
    loadPrices();                                             // R-2: in parallel, painted in place when it lands
    var stagesP = Promise.resolve().then(function () { return store.load(); }).then(function (m) { return m || {}; }, function () { return STAGEMAP; });
    var routesP = getJSON(BASE + 'routes/index.json' + bust()).then(renderRoutes, function () { renderRoutes([]); });
    return Promise.all([jobsP, stagesP]).then(function (r) {
      var before = Object.keys(shownSet).join();
      var cur = null; try { cur = store.peek ? store.peek() : null; } catch (e) { cur = null; }
      mergeStages(cur || r[1]); stagesLoaded = true;           // peek = remote + unsaved changes NOW, not when load() settled
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
    if (detailJn != null && UI.isDetailOpen()) { var x = byNum[detailJn]; if (x && !x._hidden) window.fillDetail(x); else UI.closeDetail(); }
    if (cardJob) { var c = byNum[cardJob.jobNumber]; if (c && !c._hidden) openCard(c); else closeCard(true); }
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
      var a = h('a', { class: 'card', href: BASE + 'routes/' + encodeURIComponent(x.file) }, [h('b', { text: x.title || x.file }), h('div', { class: 'd', text: x.date || '' })]);
      if (standalone) { a.target = '_blank'; a.rel = 'noopener'; }   // Home Screen app: open in a viewer with a Done button
      el.appendChild(a);
    });
  }

  /* ================= R-2 route editor (builder B): the ONE route editor in the Plan view, drawn on the single map =================
   * r2-plan sec. 4; APP_MASTER sec. 11 R-2 (Riley: "all jobs in the respective stage by default but I should be able to
   * deselect individual jobs ... or add custom stops ... drag the stops around like in apple maps ... a button for reoptimize").
   * Used by the one-click route (Route button, route menu, group-header Route) AND manual planning (Plan tab, "Add to route").
   *   ED.start   fixed first stop: the shop "S" (an old saved route that started elsewhere keeps that start, numbered 1)
   *   ED.stops   ordered stops {_id, name, lat, lon, jobNumber?, match?, shop?, oot?, skip?}. Included = no skip, in array
   *              order (numbered, routed); skipped ones are listed grey under "Skipped" and never routed.
   *   ED.rt      Return to shop · ED.title caption · ED.unmapped jobs listed under "Not mapped, not included".
   *   ED.dirty   the user changed something since the route was built / loaded / saved -> replacing it asks first (+ Undo).
   * Every change goes through edChanged(): live recompute of numbers, legs, totals, map line + pins and Google Maps parts.
   * Manual order is kept until Re-optimize. An added stop goes to its cheapest spot; the other stops keep their order.
   * Drag: hand-rolled pointer events on the row handle only (touch-action:none there, so the sheet still scrolls
   * everywhere else on iPhone), auto-scroll near the edges; keyboard: Alt/Option + Up/Down on a row, or the row's actions. */
  var HAS_TSP = !!(window.TSP && TSP.optimize && TSP.legs && TSP.gmapsParts && TSP.hav);
  var MB_RE = /\b(mb|manitoba|winnipeg)\b/i;
  var ICON_GRIP = ['M5 8h14M5 12h14M5 16h14'], ICON_PIN = ['M12 21s-6.5-5.6-6.5-10.8a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z', 'M12 8v4M10 10h4'];
  var ICON_TRASH = ['M5 7h14', 'M10 11v6M14 11v6', 'M6.5 7l1 12.5h9l1-12.5', 'M9.5 7V4.5h5V7'];
  var edList = $('edList'), edUid = 0, openActs = null, partsOpen = false, optBusy = false, edParts = [];
  var routeLines = [], routeMarkers = {};
  function sid(s) { s._id = ++edUid; return s; }
  function blankEditor(rt) { return { start: sid(Object.assign({}, SHOP)), stops: [], rt: !!rt, title: '', unmapped: [], dirty: false }; }
  var ED = blankEditor(false);
  function jobStop(x) {
    var s = { name: x.street || x.title || ('#' + x.jobNumber), lat: x.lat, lon: x.lon, jobNumber: x.jobNumber };
    if (!isWpg(x)) s.oot = true;
    return sid(s);
  }
  function included() { return ED.stops.filter(function (s) { return !s.skip; }); }
  function skippedStops() { return ED.stops.filter(function (s) { return !!s.skip; }); }
  function routeSeq() { return [ED.start].concat(included()); }
  function isEmptyEditor() { return !ED.stops.length && !!ED.start.shop && !ED.unmapped.length; }
  function stopById(id) { id = +id; for (var i = 0; i < ED.stops.length; i++) if (ED.stops[i]._id === id) return ED.stops[i]; return null; }
  function lblFn() { var shop = !!ED.start.shop; return function (i) { return shop ? (i === 0 ? 'S' : String(i)) : String(i + 1); }; }
  function fmtMin(m) { return m < 10 ? m.toFixed(1) : String(Math.round(m)); }
  function legText(l) { return '+~' + fmtMin(l.min) + ' min · ~' + l.km.toFixed(1) + ' km' + (l.rural ? ' · rural' : ''); }
  function copyEd(e) {
    function c(s) { return Object.assign({}, s); }
    return { start: c(e.start), stops: e.stops.map(c), rt: e.rt, title: e.title, unmapped: e.unmapped.slice(), dirty: e.dirty, keys: e.keys || null };
  }
  function restore(s) { ED = copyEd(s); openActs = null; edChanged({ fit: true, clean: true }); }
  function replaceSnapshot() { return ED.dirty && !isEmptyEditor() ? copyEd(ED) : null; }   // work worth an Undo
  function confirmReplace(what) {
    if (!ED.dirty || isEmptyEditor()) return true;
    return confirm('Replace your edited route (' + plural(included().length, 'stop') + ') with ' + what + '? You can undo right after.');
  }
  var liveT = 0;
  function announce(t) { var el = $('edLive'); clearTimeout(liveT); el.textContent = ''; liveT = setTimeout(function () { el.textContent = t; }, 40); }

  /* ---- stop text ---- */
  function stopJob(s) { return s && s.jobNumber != null ? byNum[s.jobNumber] || null : null; }
  function stopName(s) {
    var x = stopJob(s), n = String(s.name || ''), p = x && x.permit ? ' · ' + x.permit : '';
    if (p && n.length > p.length && n.slice(-p.length) === p) n = n.slice(0, -p.length);   // R-1 names carried the permit
    return n || (x ? x.street || x.title || '' : '') || (s.shop ? 'Shop' : 'Stop');
  }
  function stopIdent(s) {
    var x = stopJob(s);
    if (s.jobNumber != null) return '#' + s.jobNumber + (x && x.permit ? ' · ' + x.permit : '');
    if (s.shop) return 'Shop';
    return s.match || (typeof s.lat === 'number' ? s.lat.toFixed(4) + ', ' + s.lon.toFixed(4) : '');
  }
  function ootCaption(s) {
    var x = stopJob(s);
    if (x) return isWpg(x) ? '' : 'Out of town · ' + x.city;
    return s.oot ? 'Out of town' : '';
  }

  /* ---- render (list + header + footer); the map follows in drawRoute ---- */
  function edRowPin(label, cls) { return h('span', { class: 'rpin' + (cls || ''), 'aria-hidden': 'true', text: label }); }
  function fixedRow(kind, label, sub) {                       // the start row (kind 'start')
    var s = ED.start, name = stopName(s);
    var r = h('div', { class: 'ed-row is-fixed', role: 'listitem', tabindex: '0', 'data-fixed': kind },
      [edRowPin(label, s.shop ? ' is-shop' : ''), h('div', { class: 'ed-tx ed-tx--wide' }, [h('div', { class: 't', text: name }), h('div', { class: 's', text: sub })])]);
    r.setAttribute('aria-label', 'Start ' + label + ': ' + name + (sub ? ', ' + sub : ''));
    return r;
  }
  /* Last row of the route: "Return to shop" with the same include switch as a stop (a labelled control, never an icon).
   * On: numbered like the start, with the last leg. Off: grey, "Open end". */
  function returnRow(leg, n) {
    var s = ED.start, on = !!ED.rt, name = 'Return to ' + (s.shop ? 'shop' : stopName(s));
    var sub = on ? (leg ? legText(leg) : '') : 'Off · the route ends at stop ' + n;
    var sw = h('input', { type: 'checkbox', class: 'switch switch--sm', role: 'switch', 'aria-label': name + ' at the end' });
    sw.checked = on;
    var r = h('div', { class: 'ed-row is-fixed is-return' + (on ? '' : ' is-skip'), role: 'listitem', tabindex: '0', 'data-fixed': 'return' }, [
      edRowPin(on ? lblFn()(0) : '', on ? (s.shop ? ' is-shop' : '') : ' is-skip'),
      h('div', { class: 'ed-tx', title: name + (sub ? '\n' + sub : '') }, [h('div', { class: 't', text: name }), h('div', { class: 's', text: sub })]),
      h('label', { class: 'ed-sw', title: on ? 'End at the last stop instead' : 'Come back at the end' }, [sw]),
      h('span', { class: 'ed-grip is-off', 'aria-hidden': 'true' })]);
    r.setAttribute('aria-label', name + (on ? ', on' + (sub ? ', ' + sub : '') : ', off, the route ends at stop ' + n));
    return r;
  }
  function actsFor(s, idx, n) {
    function b(a, text, dis, cls) { return h('button', { type: 'button', class: 'btn btn--sm pressable' + (cls || ''), 'data-a': a, disabled: !!dis, text: text }); }
    return h('div', { class: 'ed-acts' }, [
      s.skip ? null : b('up', 'Move up', idx <= 0), s.skip ? null : b('down', 'Move down', idx >= n - 1),
      stopJob(s) ? b('details', 'Details') : null, b('remove', 'Remove', false, ' btn--danger')]);
  }
  var REASON = { unassessed: 'Unassessed', booklane: 'Book lane', streetcuts: 'Street cut', cleanup: 'Cleanup', asphalt: 'Asphalt', pavers: 'Pavers' };
  function stopReason(s) {                                    // combined route: which of its stages / lists put this job on it
    var x = ED.keys && stopJob(s); if (!x) return '';
    var ks = ED.keys.filter(isListKey).concat(ED.keys.filter(function (k) { return !isListKey(k); }));   // lists first, like groupOf
    for (var i = 0; i < ks.length; i++) if (matchesKey(x, ks[i])) return isListKey(ks[i]) ? (REASON[ks[i]] || LIST[ks[i]].label) : STAGES[stageIndex(ks[i])].short;
    return '';
  }
  function stopRow(s, label, leg, idx, n, last) {
    var skip = !!s.skip, name = stopName(s), oot = ootCaption(s), why = stopReason(s);
    var sub = (skip ? [why, oot, stopIdent(s)] : [why, leg ? legText(leg) : '', oot, stopIdent(s)]).filter(Boolean).join(' · ');
    var sw = h('input', { type: 'checkbox', class: 'switch switch--sm', role: 'switch', 'aria-label': 'Include ' + name + ' in the route' });
    sw.checked = !skip;
    var r = h('div', { class: 'ed-row' + (skip ? ' is-skip' : '') + (openActs === s._id ? ' is-open' : ''), role: 'listitem', tabindex: '0',
      'data-id': String(s._id), 'data-inc': skip ? null : String(idx) }, [
      edRowPin(label, skip ? ' is-skip' : last ? ' is-end' : ''),
      h('div', { class: 'ed-tx', title: name + (sub ? '\n' + sub : '') }, [h('div', { class: 't', text: name }), h('div', { class: 's', text: sub })]),
      h('label', { class: 'ed-sw', title: skip ? 'Include in the route' : 'Skip this stop' }, [sw]),
      skip ? h('span', { class: 'ed-grip is-off', 'aria-hidden': 'true' })
        : h('button', { type: 'button', class: 'ed-grip', 'aria-label': 'Reorder ' + name, 'aria-describedby': 'edHint', title: 'Drag to reorder (or Alt + ↑ / ↓)' }, [svgIcon(ICON_GRIP)])
    ]);
    r.setAttribute('aria-label', (skip ? 'Skipped: ' : 'Stop ' + label + ' of ' + n + ': ') + name + (sub ? ', ' + sub : ''));
    if (openActs === s._id) r.appendChild(actsFor(s, idx, n));
    return r;
  }
  function edBusy(msg) {
    edList.textContent = '';
    edList.appendChild(h('div', { class: 'spinner-line' }, [h('span', { class: 'spinner', 'aria-hidden': 'true' }), msg]));
  }
  function renderEditor() {
    var inc = included(), seq = [ED.start].concat(inc), lbl = lblFn();
    var legs = HAS_TSP && seq.length > 1 ? TSP.legs(seq, ED.rt) : [];
    var tm = 0, tk = 0, rural = false;
    legs.forEach(function (l) { tm += l.min; tk += l.km; if (l.rural) rural = true; });
    var f = document.createDocumentFragment();
    f.appendChild(fixedRow('start', lbl(0), ED.start.shop ? 'Start' : 'Start · ' + stopIdent(ED.start)));
    inc.forEach(function (s, i) { f.appendChild(stopRow(s, lbl(i + 1), legs[i], i, inc.length, i === inc.length - 1 && !ED.rt)); });
    if (!inc.length) f.appendChild(h('div', { class: 'ed-empty', text: ED.stops.length ? 'Every stop is skipped. Switch one on to route it.' : 'No stops yet. Add one below, or tap Route on a stage in Jobs.' }));
    if (inc.length) f.appendChild(returnRow(ED.rt && legs.length ? legs[legs.length - 1] : null, inc.length));
    var sk = skippedStops();
    if (sk.length) {
      f.appendChild(h('div', { class: 'group-title ed-grp', role: 'presentation', text: 'Skipped (' + sk.length + ')' }));
      sk.forEach(function (s) { f.appendChild(stopRow(s, '', null, -1, inc.length, false)); });
    }
    if (ED.unmapped.length) {
      f.appendChild(h('div', { class: 'group-title ed-grp', role: 'presentation', text: 'Not mapped, not included (' + ED.unmapped.length + ')' }));
      ED.unmapped.forEach(function (x) {
        var nm = x.street || x.title || '#' + x.jobNumber, sub = '#' + x.jobNumber + (isWpg(x) ? '' : ' · ' + x.city) + ' · no map location';
        var r = h('div', { class: 'ed-row is-skip is-unmapped', role: 'listitem' }, [edRowPin('', ' is-skip'),
          h('div', { class: 'ed-tx ed-tx--wide' }, [h('div', { class: 't', text: nm }), h('div', { class: 's', text: sub })])]);
        r.setAttribute('aria-label', 'Not mapped: ' + nm + ', ' + sub);
        f.appendChild(r);
      });
    }
    edList.textContent = ''; edList.appendChild(f);
    paintHead(inc, tm, tk, rural); paintFoot(seq);
    return seq;
  }
  function paintHead(inc, tm, tk, rural) {
    $('edHead').hidden = isEmptyEditor();
    var tot = $('edTotal');
    tot.textContent = inc.length ? '~' + Math.round(tm) + ' min · ~' + tk.toFixed(1) + ' km' : 'No stops included';
    tot.title = 'Estimate: straight-line ×1.39 at 40 km/h' + (rural ? ' (70 km/h rural legs)' : '') + ' · no live traffic';
    paintEdCap(inc);
    var o = $('edOpt'); o.disabled = optBusy || inc.length < 2; o.textContent = optBusy ? 'Optimizing…' : 'Re-optimize';
  }
  function edValue(inc) {                                     // R-2 prices: Jobber total of the routed job stops (start included)
    var jobs = [];
    [ED.start].concat(inc).forEach(function (s) { var x = stopJob(s); if (x && jobs.indexOf(x) < 0) jobs.push(x); });
    return sumPrices(jobs);
  }
  function paintEdCap(inc) {                                  // caption: N stops · $value · round trip · title · no live traffic
    var cap = $('edCap'), sv = edValue(inc);                  // count (and value) lead, so a phone never ellipsizes them away
    cap.textContent = [plural(inc.length, 'stop'), sv.n ? fmtPS(sv.v) : '', ED.rt ? 'round trip' : '', ED.title, 'no live traffic']
      .filter(Boolean).join(' · ');
    cap.title = cap.textContent + (sv.n ? '\nJobber total of the ' + plural(sv.n, 'priced stop') + ': ' + fmtP(sv.v) : '');
  }
  function paintFoot(seq) {
    var n = seq.length - 1, maps = $('edMaps');
    edParts = HAS_TSP && n >= 1 ? TSP.gmapsParts(seq, ED.rt) : [];
    maps.hidden = !edParts.length; $('edSave').hidden = !n; $('edClear').hidden = isEmptyEditor();
    if (edParts.length === 1) {
      maps.href = edParts[0]; maps.target = '_blank'; maps.removeAttribute('role'); maps.removeAttribute('aria-expanded');
      maps.textContent = 'Google Maps'; maps.title = 'Open the route in Google Maps';
    } else if (edParts.length > 1) {
      maps.href = '#'; maps.removeAttribute('target'); maps.setAttribute('role', 'button');
      maps.textContent = 'Google Maps'; maps.appendChild(svgIcon(['M7 10l5 5 5-5']));
      maps.title = edParts.length + ' Google Maps links (up to 10 stops each)';
    }
    paintParts();
  }
  function paintParts() {
    var box = $('edParts'), multi = edParts.length > 1;
    if (multi) $('edMaps').setAttribute('aria-expanded', partsOpen ? 'true' : 'false');
    box.textContent = ''; box.hidden = !(partsOpen && multi);
    if (box.hidden) return;
    var seq = routeSeq(), lbl = lblFn(), total = seq.length + (ED.rt && seq.length > 1 ? 1 : 0);
    function at(p) { return p >= seq.length ? lbl(0) : lbl(p); }
    edParts.forEach(function (u, i) {
      var a = 9 * i, b = Math.min(a + 9, total - 1);
      box.appendChild(h('a', { class: 'btn btn--sm btn--tinted pressable', href: u, target: '_blank', rel: 'noopener',
        'aria-label': 'Google Maps part ' + (i + 1) + ' of ' + edParts.length + ', stops ' + at(a) + ' to ' + at(b), text: 'Part ' + (i + 1) + ' · ' + at(a) + '–' + at(b) }));
    });
    box.appendChild(h('p', { class: 'ed-note', text: 'Up to 10 stops per link; each part starts where the last one ended.' }));
  }
  function edChanged(opts) {                                  // THE recompute: list, header, footer, map
    opts = opts || {};
    if (!opts.clean) ED.dirty = true;
    drawRoute(renderEditor(), !!opts.fit);
  }

  /* ---- map: line + numbered .rpin markers in routeLayer (job pins hidden while the Plan view shows a route) ---- */
  function styleRouteLines() {
    if (!routeLines.length) return;
    routeLines[0].setStyle({ color: cssVar('--route-casing', '#fff') });
    routeLines[1].setStyle({ color: cssVar('--route', '#0088ff') });
  }
  function drawRoute(seq, fit) {
    if (!HAS_MAP) return;
    routeLayer.clearLayers(); routeLines = []; routeMarkers = {};
    var sk = skippedStops();
    if (seq.length < 2 && !sk.length) { if (window.onViewChange) window.onViewChange(UI.currentView()); return; }
    var lbl = lblFn(), pts = seq.map(function (s) { return [s.lat, s.lon]; });
    if (seq.length > 1) {
      var line = pts.slice(); if (ED.rt) line.push(pts[0]);
      routeLines = [
        L.polyline(line, { color: cssVar('--route-casing', '#fff'), weight: 8, opacity: 1, interactive: false, lineJoin: 'round' }),
        L.polyline(line, { color: cssVar('--route', '#0088ff'), weight: 5, opacity: 1, interactive: false, lineJoin: 'round' })];
      routeLines.forEach(function (l) { routeLayer.addLayer(l); });
    }
    sk.forEach(function (s) {                                 // skipped: small grey dots (tap -> its row), never in the fit
      var m = L.marker([s.lat, s.lon], { icon: L.divIcon({ html: '<div class="rpin rpin--dot"></div>', className: '', iconSize: [16, 16], iconAnchor: [8, 8] }),
        title: 'Skipped · ' + stopName(s), zIndexOffset: -200 });
      m.on('click', function () { revealRow(s._id); });
      routeMarkers[s._id] = m; routeLayer.addLayer(m);
    });
    seq.forEach(function (s, i) {
      var last = i === seq.length - 1 && !ED.rt && i > 0, id = i === 0 ? 'start' : s._id;
      var m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ html: '<div class="rpin' + (i === 0 && s.shop ? ' is-shop' : '') + (last ? ' is-end' : '') + (id === openActs ? ' is-selected' : '') + '">' + esc(lbl(i)) + '</div>', className: '', iconSize: [26, 26], iconAnchor: [13, 13] }),
        title: lbl(i) + ' · ' + stopName(s), zIndexOffset: i === 0 ? 500 : 0
      });
      m.on('click', function () { revealRow(id); });
      routeMarkers[id] = m; routeLayer.addLayer(m);
    });
    if (window.onViewChange) window.onViewChange(UI.currentView());
    if (fit) {
      var fp = seq.length > 1 ? pts : pts.concat(sk.map(function (s) { return [s.lat, s.lon]; }));
      var pad = UI.mapPadding(); pad.maxZoom = 15; map.fitBounds(fp, pad);
    }
  }
  function markRoutePin(id) {                                 // the stop whose actions are open is scaled up on the map
    Object.keys(routeMarkers).forEach(function (k) {
      var el = routeMarkers[k].getElement && routeMarkers[k].getElement(), p = el && el.firstElementChild;
      if (p) p.classList.toggle('is-selected', String(k) === String(id));
    });
  }
  window.onViewChange = function (v) {                        // show the route instead of job pins while the editor has one
    closeRouteMenu();
    if (!HAS_MAP) return;
    var route = v === 'plan' && routeLayer.getLayers().length > 0;
    if (route) { closeCard(true); if (map.hasLayer(jobLayer)) map.removeLayer(jobLayer); if (!map.hasLayer(routeLayer)) routeLayer.addTo(map); }
    else { if (map.hasLayer(routeLayer)) map.removeLayer(routeLayer); if (!map.hasLayer(jobLayer)) jobLayer.addTo(map); }
  };
  window.onLayout = function () {
    if (HAS_MAP) setTimeout(function () { map.invalidateSize(); placeCard(); }, 60);
    closeCard(true); closeRouteMenu();
    if (dataLoaded) renderChips();                            // chips row: accessory (iPhone) vs panel layout
  };
  function sheetBody() { return $('v-plan').closest('.sheet-body'); }
  function scrollIntoBody(el) {                               // scroll the sheet body only (never the page: iOS would pan)
    var body = sheetBody(); if (!body || !el) return;
    var bb = body.getBoundingClientRect(), rb = el.getBoundingClientRect();
    var top = bb.top + 12, bottom = Math.min(bb.bottom, innerHeight - (parseFloat(getComputedStyle(body).getPropertyValue('--kb')) || 0)) - 16;
    if (rb.top < top) body.scrollTop -= top - rb.top;
    else if (rb.bottom > bottom) body.scrollTop += Math.min(rb.bottom - bottom, rb.top - top);
  }
  function rowEl(id) { return id === 'start' ? edList.querySelector('[data-fixed="start"]') : edList.querySelector('.ed-row[data-id="' + id + '"]'); }
  function revealRow(id) {                                    // a route pin was tapped: bring its row into view and flash it
    var ready = UI.currentView() === 'plan' && UI.listSheetOpen() && !UI.isDetailOpen();
    if (!ready) UI.openList('plan', 'medium');
    setTimeout(function () {
      var r = rowEl(id); if (!r) return;
      scrollIntoBody(r);
      r.classList.remove('is-flash'); void r.offsetWidth; r.classList.add('is-flash');
      setTimeout(function () { r.classList.remove('is-flash'); }, 1600);
      try { r.focus({ preventScroll: true }); } catch (e) {}
    }, ready || DESK.matches ? 0 : 480);
  }
  function focusRowPart(id, sel) {
    var r = rowEl(id); if (!r) return;
    var t = (sel && r.querySelector(sel)) || r;
    try { t.focus({ preventScroll: true }); } catch (e) { t.focus(); }
    scrollIntoBody(r);
  }

  /* ---- editing ---- */
  function moveIncluded(from, to) {                           // included index -> included index; skipped rows keep their place
    var inc = included(), s = inc[from]; if (!s || from === to || to < 0 || to >= inc.length) return false;
    var arr = ED.stops; arr.splice(arr.indexOf(s), 1);
    var rest = arr.filter(function (x) { return !x.skip; });
    var at = to < rest.length ? arr.indexOf(rest[to]) : (rest.length ? arr.indexOf(rest[rest.length - 1]) + 1 : 0);
    arr.splice(at, 0, s);
    edChanged();
    announce(stopName(s) + ' moved to stop ' + (to + 1) + ' of ' + inc.length);
    return true;
  }
  function insertStop(s) {                                    // cheapest insertion; returns its stop number
    var inc = included(), seq = [ED.start].concat(inc), best = inc.length, bestD = Infinity;
    if (HAS_TSP) {
      for (var i = 0; i <= inc.length; i++) {
        var a = seq[i], b = i < inc.length ? seq[i + 1] : (ED.rt ? ED.start : null);
        var d = TSP.hav(a, s) + (b ? TSP.hav(s, b) - TSP.hav(a, b) : 0);
        if (d < bestD - 1e-9) { bestD = d; best = i; }
      }
    }
    var at = best < inc.length ? ED.stops.indexOf(inc[best]) : (inc.length ? ED.stops.indexOf(inc[inc.length - 1]) + 1 : 0);
    ED.stops.splice(at, 0, s);
    edChanged();
    return best + 1;
  }
  /* A skipped stop keeps its array place. Switched back on, it returns there only if it was skipped after the last
   * Re-optimize (the place still means something); otherwise (skipped before a Re-optimize, which moves skipped stops to
   * the end, or an out-of-town / saved skipped stop that never had a place) it goes to its cheapest spot, like "+ Add stop". */
  var optGen = 0;
  function skipStop(s) { s.skip = true; s._gen = optGen; }
  function includeStop(s) {                                   // -> its stop number; calls edChanged
    var keep = s._gen === optGen;
    delete s.skip; delete s._gen;
    if (keep) { edChanged(); return included().indexOf(s) + 1; }
    ED.stops.splice(ED.stops.indexOf(s), 1);
    return insertStop(s);
  }
  function addJobToRoute(x) {                                 // -> message for the toast
    var nm = x.street || x.title || '#' + x.jobNumber;
    var ex = ED.stops.filter(function (s) { return s.jobNumber != null && String(s.jobNumber) === String(x.jobNumber); })[0];
    if (ex && !ex.skip) return nm + ' is already stop ' + (included().indexOf(ex) + 1);
    if (ex) return 'Included ' + nm + ' as stop ' + includeStop(ex);
    if (ED.start.jobNumber != null && String(ED.start.jobNumber) === String(x.jobNumber)) return nm + ' is the start of this route';
    return 'Added ' + nm + ' as stop ' + insertStop(jobStop(x));
  }
  function rowAction(s, a, btn) {
    var inc = included(), i = inc.indexOf(s);
    if (a === 'up' || a === 'down') {
      if (moveIncluded(i, i + (a === 'up' ? -1 : 1))) {
        var j = included().indexOf(s), again = (a === 'up' && j > 0) || (a === 'down' && j < inc.length - 1);
        focusRowPart(s._id, again ? '[data-a="' + a + '"]' : null);
      }
    } else if (a === 'details') {
      var x = stopJob(s); if (x) openJob(x, false);
    } else if (a === 'remove') {
      var before = copyEd(ED); ED.stops.splice(ED.stops.indexOf(s), 1); openActs = null;
      edChanged(); toast('Removed ' + stopName(s), function () { restore(before); });
      var next = edList.querySelector('.ed-row[data-inc="' + Math.min(i, included().length - 1) + '"]');
      if (next) try { next.focus({ preventScroll: true }); } catch (e) {}
    }
  }
  function toggleActs(row, s) {                               // inline row actions (no popover: never glass on glass)
    var old = edList.querySelector('.ed-acts'); if (old) old.parentNode.removeChild(old);
    edList.querySelectorAll('.ed-row.is-open').forEach(function (r) { r.classList.remove('is-open'); });
    openActs = openActs === s._id ? null : s._id;
    if (openActs != null) { var inc = included(); row.appendChild(actsFor(s, inc.indexOf(s), inc.length)); row.classList.add('is-open'); scrollIntoBody(row); }
    markRoutePin(openActs);
  }
  function tapRow(row, s) {
    var p = row.getAttribute('data-fixed') ? ED.start : s;
    if (p && typeof p.lat === 'number') focusPoint(p.lat, p.lon, true);
    if (s) toggleActs(row, s);
  }
  edList.addEventListener('change', function (e) {
    var sw = e.target.closest && e.target.closest('.switch'); if (!sw) return;
    if (sw.closest('[data-fixed="return"]')) {                // "Return to shop" row
      ED.rt = sw.checked; edChanged();
      announce(ED.rt ? 'Returns to the start at the end' : 'Open end');
      var rs = edList.querySelector('[data-fixed="return"] .switch'); if (rs) try { rs.focus({ preventScroll: true }); } catch (err) {}
      return;
    }
    var s = stopById(sw.closest('.ed-row').getAttribute('data-id')); if (!s) return;
    var kbd = false; try { kbd = sw.matches(':focus-visible'); } catch (err) {}
    var at = [].slice.call(edList.querySelectorAll('.switch')).indexOf(sw);
    if (openActs === s._id) openActs = null;
    if (sw.checked) includeStop(s); else { skipStop(s); edChanged(); }   // the row moves to / from "Skipped"; the list stays put
    announce((s.skip ? 'Skipped ' : 'Included ') + stopName(s));
    if (kbd) {                                                // keyboard: stay on the switch now in the same place
      var sws = edList.querySelectorAll('.switch'), n = sws[Math.min(at, sws.length - 1)];
      if (n) try { n.focus({ preventScroll: true }); } catch (err) {}
    }
  });
  edList.addEventListener('click', function (e) {
    if (e.target.closest('.ed-sw, .ed-grip')) return;         // the switch has its change event; the handle drags
    var row = e.target.closest('.ed-row'); if (!row || row.classList.contains('is-unmapped')) return;
    var s = stopById(row.getAttribute('data-id')), a = e.target.closest('[data-a]');
    if (a) { if (s && !a.disabled) rowAction(s, a.getAttribute('data-a'), a); return; }
    if (e.target.closest('.ed-acts') || drag) return;
    tapRow(row, s);
  });
  edList.addEventListener('keydown', function (e) {
    var row = e.target.closest && e.target.closest('.ed-row'); if (!row || drag) return;
    var s = stopById(row.getAttribute('data-id')), up = e.key === 'ArrowUp', dn = e.key === 'ArrowDown';
    var onGrip = !!e.target.closest('.ed-grip');
    if ((up || dn) && s && !s.skip && (e.altKey || onGrip)) {    // Alt/Option + Up/Down (or arrows on the handle) moves the stop
      e.preventDefault();
      var i = included().indexOf(s);
      if (moveIncluded(i, i + (up ? -1 : 1))) focusRowPart(s._id, onGrip ? '.ed-grip' : null);
      return;
    }
    if (e.target !== row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapRow(row, s); }
    else if (up || dn) {                                        // plain arrows walk the rows
      e.preventDefault();
      var rows = [].slice.call(edList.querySelectorAll('.ed-row[tabindex]')), n = rows[rows.indexOf(row) + (up ? -1 : 1)];
      if (n) { try { n.focus({ preventScroll: true }); } catch (err) {} scrollIntoBody(n); }
    }
  });

  /* ---- drag to reorder (Apple Maps style): pointer events on the handle; touch, pen and mouse alike ---- */
  var drag = null;
  edList.addEventListener('pointerdown', function (e) {
    var g = e.target.closest && e.target.closest('button.ed-grip'); if (!g || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var row = g.closest('.ed-row'), rows = [].slice.call(edList.querySelectorAll('.ed-row[data-inc]'));
    var from = rows.indexOf(row); if (from < 0 || rows.length < 2) return;
    e.preventDefault();                                       // no text selection, no scroll, no emulated mouse events
    var old = edList.querySelector('.ed-acts');               // actions collapse first so every row has its resting height
    if (old) { old.parentNode.removeChild(old); edList.querySelectorAll('.ed-row.is-open').forEach(function (r) { r.classList.remove('is-open'); }); openActs = null; markRoutePin(null); }
    var body = sheetBody(), bt = body.getBoundingClientRect().top, st = body.scrollTop;
    drag = { row: row, grip: g, rows: rows, from: from, to: from, body: body, pid: e.pointerId, lastY: e.clientY, raf: 0,
      tops: rows.map(function (r) { return r.getBoundingClientRect().top - bt + st; }),
      hs: rows.map(function (r) { return r.getBoundingClientRect().height; }),
      pins: rows.map(function (r) { return r.querySelector('.rpin'); }), lbl: lblFn() };
    drag.y0 = e.clientY - bt + st;
    try { g.setPointerCapture(e.pointerId); } catch (err) {}
    edList.classList.add('is-sorting'); row.classList.add('is-lifted');
    g.addEventListener('pointermove', dragMove); g.addEventListener('pointerup', dragEnd); g.addEventListener('pointercancel', dragEnd);
    g.addEventListener('lostpointercapture', dragEnd);
    g.addEventListener('touchmove', noPan, { passive: false });  // scoped to this touch: list scrolling stays passive
    drag.raf = requestAnimationFrame(autoScroll);
  });
  function noPan(e) { if (drag) e.preventDefault(); }          // iOS: never pan mid-drag (the handle's touch-action:none is the main guard)
  function dragMove(e) { if (!drag || e.pointerId !== drag.pid) return; drag.lastY = e.clientY; dragTo(e.clientY); }
  function dragTo(clientY) {
    var d = drag, n = d.rows.length, f = d.from;
    var y = clientY - d.body.getBoundingClientRect().top + d.body.scrollTop;
    var min = d.tops[0] - d.tops[f], max = d.tops[n - 1] + d.hs[n - 1] - d.tops[f] - d.hs[f];
    var dy = Math.max(min - 10, Math.min(max + 10, y - d.y0));
    d.row.style.translate = '0 ' + dy + 'px';
    var c = d.tops[f] + d.hs[f] / 2 + dy, to = 0;
    for (var j = 0; j < n; j++) if (j !== f && c > d.tops[j] + d.hs[j] / 2) to++;
    if (to === d.to) return;
    d.to = to;
    for (j = 0; j < n; j++) {                                  // the others slide to open a gap; numbers follow live
      if (j === f) continue;
      var shift = 0, k = j;
      if (f < to && j > f && j <= to) { shift = -d.hs[f]; k = j - 1; }
      else if (to < f && j >= to && j < f) { shift = d.hs[f]; k = j + 1; }
      d.rows[j].style.translate = shift ? '0 ' + shift + 'px' : '';
      if (d.pins[j]) d.pins[j].textContent = d.lbl(k + 1);
    }
    if (d.pins[f]) d.pins[f].textContent = d.lbl(to + 1);
  }
  function autoScroll() {                                     // near the top/bottom of the visible list: scroll it
    var d = drag; if (!d) return;
    var r = d.body.getBoundingClientRect(), top = Math.max(r.top, 0), bot = Math.min(r.bottom, innerHeight), EDGE = 56, v = 0;
    if (d.lastY < top + EDGE) v = -Math.min(18, Math.ceil((top + EDGE - d.lastY) / 3));
    else if (d.lastY > bot - EDGE) v = Math.min(18, Math.ceil((d.lastY - (bot - EDGE)) / 3));
    if (v) { var b = d.body.scrollTop; d.body.scrollTop = b + v; if (d.body.scrollTop !== b) dragTo(d.lastY); }
    d.raf = requestAnimationFrame(autoScroll);
  }
  function dragEnd(e) {
    var d = drag; if (!d || (e.pointerId != null && e.pointerId !== d.pid)) return;
    drag = null; cancelAnimationFrame(d.raf);
    ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) { d.grip.removeEventListener(t, t === 'pointermove' ? dragMove : dragEnd); });
    d.grip.removeEventListener('touchmove', noPan, { passive: false });
    try { d.grip.releasePointerCapture(d.pid); } catch (err) {}
    var to = e.type === 'pointercancel' ? d.from : d.to, f = d.from;
    var end = to > f ? d.tops[to] + d.hs[to] - d.tops[f] - d.hs[f] : to < f ? d.tops[to] - d.tops[f] : 0;
    d.row.classList.add('is-dropping'); d.row.style.translate = '0 ' + end + 'px';   // settle into the gap, then commit
    setTimeout(function () {
      edList.classList.remove('is-sorting');
      var id = d.row.getAttribute('data-id');
      if (to !== f) {
        var before = copyEd(ED), s = included()[f];
        if (moveIncluded(f, to) && s) toast('Moved ' + stopName(s) + ' to stop ' + (to + 1), function () { restore(before); });
      } else renderEditor();
      if (e.pointerType !== 'mouse' || document.activeElement === d.grip) focusRowPart(id, '.ed-grip');
    }, 190);
  }

  /* ---- header + footer controls ---- */
  $('edOpt').addEventListener('click', function () {
    var inc = included(); if (inc.length < 2 || optBusy) return;
    if (!HAS_TSP) { toast('Route optimizer failed to load — reload the app', null, { error: true }); return; }
    var before = copyEd(ED), mins = function () { var t = 0; TSP.legs(routeSeq(), ED.rt).forEach(function (l) { t += l.min; }); return t; }, m0 = mins();
    optBusy = true; paintHead(inc, 0, 0, false); $('edTotal').textContent = 'Optimizing ' + plural(inc.length, 'stop') + '…';
    setTimeout(function () {                                  // let "Optimizing…" paint first (~0.1 s for 60 stops)
      var seq = null;
      try { seq = TSP.optimize([ED.start].concat(inc), true, false, ED.rt); } catch (e) { seq = null; }
      optBusy = false;
      if (!seq || seq.length !== inc.length + 1) { renderEditor(); toast('Couldn’t optimize this route', null, { error: true }); return; }
      var same = seq.every(function (s, i) { return i === 0 || s === inc[i - 1]; });
      ED.stops = seq.slice(1).concat(skippedStops()); openActs = null; optGen++;   // skipped stops lose their places
      edChanged({ fit: true, clean: same && !before.dirty });
      var saved = m0 - mins();
      if (same) toast('Already the shortest order found');
      else toast(saved >= 0.5 ? 'Re-optimized · ~' + Math.round(saved) + ' min shorter' : 'Re-optimized', function () { restore(before); });
    }, 30);
  });
  $('edMaps').addEventListener('click', function (e) {
    if (edParts.length === 1) return;                         // a plain link
    e.preventDefault();
    if (edParts.length > 1) { partsOpen = !partsOpen; paintParts(); if (partsOpen) scrollIntoBody($('edParts')); }
  });
  $('edSave').addEventListener('click', saveRoute);
  $('edClear').addEventListener('click', function () {
    if (isEmptyEditor()) return;
    var before = copyEd(ED); ED = blankEditor(ED.rt); openActs = null; partsOpen = false; closeAddBox();
    edChanged({ clean: true });
    toast('Route cleared', function () { restore(before); });
  });

  /* ---- + Add stop: ONE field for an address / intersection (Esri geocoder) or a job (number, street, client…) ---- */
  var addBox = $('edAddBox'), addInp = $('addr'), suggBox = $('edSugg'), sugg = [], suggHi = 0, suggQ = '', sgT = 0;
  function openAddBox() {
    addBox.hidden = false; $('edAdd').setAttribute('aria-expanded', 'true');
    if (UI.sheetLarge) UI.sheetLarge();                       // iPhone: large detent before the keyboard opens
    try { addInp.focus({ preventScroll: true }); } catch (e) { addInp.focus(); }
    if (DESK.matches) scrollIntoBody(addBox);
    else setTimeout(function () {                             // iPhone: field at the top of the sheet, suggestions below it, above the keyboard
      var body = sheetBody(); if (body && !addBox.hidden) body.scrollTop += addBox.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    }, 350);
    renderSugg();
  }
  function closeAddBox() {
    addBox.hidden = true; $('edAdd').setAttribute('aria-expanded', 'false');
    addInp.value = ''; suggBox.textContent = ''; sugg = []; suggQ = ''; addInp.removeAttribute('aria-activedescendant');
  }
  $('edAdd').addEventListener('click', function () { if (addBox.hidden) openAddBox(); else closeAddBox(); });
  function findStopFor(x) { return ED.stops.filter(function (s) { return s.jobNumber != null && String(s.jobNumber) === String(x.jobNumber); })[0] || null; }
  function suggEl(it, i) {
    var id = 'edSg' + i;
    if (it.addr) return h('button', { type: 'button', class: 'ed-opt', role: 'option', id: id, 'data-i': String(i) }, [
      h('span', { class: 'ed-opt-ico', 'aria-hidden': 'true' }, [svgIcon(ICON_PIN)]),
      h('span', { class: 'tx' }, [h('span', { class: 't', text: 'Find “' + it.addr + '”' }), h('span', { class: 's', text: 'Address or intersection' })])]);
    var x = it.job, ex = findStopFor(x), state = ex ? (ex.skip ? 'Skipped' : 'In route') : '';
    var vars = MODE === 'stage' ? stageVars(stageIndex(x.stage)) : '--c:' + COL[clientGroup(x)];
    return h('button', { type: 'button', class: 'ed-opt', role: 'option', id: id, 'data-i': String(i) }, [
      h('span', { class: 'dot dot--xs', style: vars, 'aria-hidden': 'true', text: MODE === 'stage' ? String(stageIndex(x.stage) + 1) : '' }),
      h('span', { class: 'tx' }, [h('span', { class: 't', text: '#' + x.jobNumber + ' ' + (x.street || x.title || '') }),
        h('span', { class: 's', text: [clientLabel(x), stageOf(x).label, isWpg(x) ? '' : x.city].filter(Boolean).join(' · ') })]),
      state ? h('span', { class: 'tag', text: state }) : null]);
  }
  function renderSugg() {
    var q = addInp.value.trim(); suggQ = q; suggBox.textContent = ''; sugg = []; suggHi = 0;
    if (!q) { addInp.removeAttribute('aria-activedescendant'); return; }
    var ql = q.toLowerCase(), num = /^#?\d{1,6}$/.test(q), qn = ql.replace(/^#/, '');
    var jobs = JOBS.filter(function (x) {
      return mappedJob(x) && (num ? String(x.jobNumber).indexOf(qn) === 0 : hay(x).indexOf(ql) >= 0);
    }).slice(0, 6).map(function (x) { return { job: x }; });
    var addr = q.length >= 3 ? [{ addr: q }] : [];
    sugg = num ? jobs.concat(addr) : addr.concat(jobs);        // a number is usually a job; words usually an address
    sugg.forEach(function (it, i) { suggBox.appendChild(suggEl(it, i)); });
    paintHi();
  }
  function paintHi() {
    suggBox.querySelectorAll('.ed-opt').forEach(function (b, i) { b.setAttribute('aria-selected', i === suggHi ? 'true' : 'false'); });
    if (sugg.length) addInp.setAttribute('aria-activedescendant', 'edSg' + suggHi); else addInp.removeAttribute('aria-activedescendant');
  }
  function pickSugg(i) {
    if (addInp.value.trim() !== suggQ) renderSugg();          // typed faster than the rAF: use what is in the field now
    var it = sugg[i];
    if (!it) { var q = addInp.value.trim(); if (q.length < 3) { if (q) toast('Type at least 3 letters of the address'); return; } it = { addr: q }; }
    if (it.job) {
      toast(addJobToRoute(it.job)); addInp.value = ''; renderSugg();
      if (FINE.matches) addInp.focus();
      return;
    }
    var b = $('addAddr'); if (b.disabled) return;
    b.disabled = true; b.textContent = '…';
    geocode(it.addr).then(function (g) {
      var no = insertStop(sid({ name: it.addr, lat: g.lat, lon: g.lon, match: g.match }));
      addInp.value = ''; renderSugg();
      toast('Added ' + (g.match || it.addr) + ' as stop ' + no);
    }, function () { toast('Couldn’t find: ' + it.addr, null, { error: true }); })
      .then(reset, function () { reset(); toast('Couldn’t add that stop', null, { error: true }); });
    function reset() { b.disabled = false; b.textContent = 'Add'; }
  }
  addInp.addEventListener('input', function () { cancelAnimationFrame(sgT); sgT = requestAnimationFrame(renderSugg); });
  addInp.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (addInp.value.trim() !== suggQ) renderSugg();
      if (!sugg.length) return;
      e.preventDefault(); suggHi = (suggHi + (e.key === 'ArrowDown' ? 1 : sugg.length - 1)) % sugg.length; paintHi();
      var hb = $('edSg' + suggHi); if (hb) scrollIntoBody(hb);
    } else if (e.key === 'Enter') { e.preventDefault(); pickSugg(suggHi); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAddBox(); $('edAdd').focus(); }
  });
  suggBox.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the field focused (desktop)
  suggBox.addEventListener('click', function (e) { var b = e.target.closest('.ed-opt'); if (b) pickSugg(+b.getAttribute('data-i')); });
  $('addAddr').addEventListener('click', function () { pickSugg(suggHi); });
  function geocode(text) {
    var u = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&maxLocations=1&countryCode=CAN' +
      '&searchExtent=-98.6,49.0,-95.8,50.7&outFields=Match_addr&singleLine=' + encodeURIComponent(text + (MB_RE.test(text) ? '' : ', Winnipeg, MB'));
    return fetch(u).then(function (r) { return r.json(); }).then(function (r) {
      var c = (r && r.candidates || [])[0];
      var lc = c && c.location;
      if (!lc || typeof lc.x !== 'number' || typeof lc.y !== 'number' || !isFinite(lc.x) || !isFinite(lc.y)) throw new Error('not found');
      return { name: text, lat: c.location.y, lon: c.location.x, match: (c.attributes && c.attributes.Match_addr) || c.address || '' };
    });
  }

  /* ---- one-click route: every job in the selection / stage / list, from the shop, shown at once in the editor ---- */
  function startShopRoute(jobs, title, keys) {
    if (!jobs.length) return;
    if (!HAS_TSP) { toast('Route optimizer failed to load — reload the app', null, { error: true }); return; }
    var mapped = [], unmapped = [];
    jobs.forEach(function (x) { (mappedJob(x) ? mapped : unmapped).push(x); });
    var inTown = mapped.filter(isWpg), out = mapped.filter(function (x) { return !isWpg(x); });
    var use = inTown.length ? inTown : out, rt = ED.rt;       // out of town start skipped (unless there is nothing else)
    var prev = replaceSnapshot();
    if (!confirmReplace(title)) return;
    if (use.length > ROUTE_CONFIRM_ABOVE &&
        !confirm('Build a route with ' + plural(use.length, 'job') + ' from the shop? It will need ' + Math.ceil((use.length + (rt ? 1 : 0)) / 9) + ' Google Maps links.')) return;
    UI.openList('plan', 'medium');
    closeAddBox(); openActs = null; partsOpen = false;
    edBusy('Optimizing ' + plural(use.length, 'job') + ' from the shop…');
    setTimeout(function () {                                  // let the spinner paint first
      var start = sid(Object.assign({}, SHOP)), seq = [start];
      if (use.length) { try { seq = TSP.optimize([start].concat(use.map(jobStop)), true, false, rt); } catch (e) { seq = null; } }
      if (!seq) { renderEditor(); toast('Couldn’t optimize this route', null, { error: true }); return; }
      var skipped = use === inTown ? out.map(function (x) { var s = jobStop(x); s.skip = true; return s; }) : [];
      ED = { start: seq[0], stops: seq.slice(1).concat(skipped), rt: rt, title: title, unmapped: unmapped, dirty: false,
        keys: keys && keys.length > 1 ? keys.slice() : null };   // a combined route (Setup + Cuts & cleanup): rows say why
      edChanged({ fit: true, clean: true });
      var body = sheetBody(); if (body) body.scrollTop = 0;
      if (prev) toast('Route replaced', function () { restore(prev); });
    }, 30);
  }

  /* ---- saved routes (NS + 'routes', "ej_routes"): {name, when, seq:[start + included, in order], rt, skipped?:[{…, skip:true}]} ----
   * seq keeps the R-1 shape, so R-1 and pre-R-1 entries load unchanged (their first stop is the start). */
  function cleanStop(s) {
    var o = { name: String(s.name || ''), lat: +s.lat, lon: +s.lon };
    if (s.shop) o.shop = true; if (s.jobNumber != null) o.jobNumber = s.jobNumber; if (s.match) o.match = String(s.match);
    if (s.oot) o.oot = true; if (s.skip) o.skip = true;
    return o;
  }
  function validStop(s) { return !!s && typeof s.lat === 'number' && typeof s.lon === 'number' && isFinite(s.lat) && isFinite(s.lon); }
  function fromSaved(s, skip) { var o = cleanStop(s); delete o.skip; if (skip) o.skip = true; return sid(o); }
  function saveRoute() {
    var inc = included(); if (!inc.length) return;
    var nm = prompt('Name this route:', ED.title || new Date().toLocaleDateString()); if (nm == null) return;
    nm = String(nm).trim(); if (!nm) return;
    var all = lsJSON('routes', []); if (!Array.isArray(all)) all = [];
    var entry = { name: nm.slice(0, 120), when: new Date().toISOString(), seq: [ED.start].concat(inc).map(cleanStop), rt: !!ED.rt };
    var sk = skippedStops(); if (sk.length) entry.skipped = sk.map(cleanStop);
    all.unshift(entry);
    try { localStorage.setItem(NS + 'routes', JSON.stringify(all.slice(0, 50))); }
    catch (e) { toast('Couldn’t save (storage full or blocked)', null, { error: true }); return; }
    ED.title = entry.name; ED.dirty = false; renderEditor();
    toast('Route saved'); renderSaved();
  }
  function loadSaved(r) {
    var seq = (Array.isArray(r.seq) ? r.seq : []).filter(validStop); if (!seq.length) return;
    var name = String(r.name || 'Route').slice(0, 120), prev = replaceSnapshot();
    if (!confirmReplace('“' + name + '”')) return;
    var sk = (Array.isArray(r.skipped) ? r.skipped : []).filter(validStop);
    ED = { start: fromSaved(seq[0]), stops: seq.slice(1).map(function (s) { return fromSaved(s); }).concat(sk.map(function (s) { return fromSaved(s, true); })),
      rt: !!r.rt, title: name, unmapped: [], dirty: false };
    openActs = null; partsOpen = false; closeAddBox();
    edChanged({ fit: true, clean: true });
    var body = sheetBody(); if (body) body.scrollTop = 0;
    toast('Loaded “' + name + '”', prev ? function () { restore(prev); } : null);
  }
  function renderSaved() {
    var all = lsJSON('routes', []), el = $('savedlist');
    if (!Array.isArray(all)) all = [];
    all = all.filter(function (r) { return r && Array.isArray(r.seq) && r.seq.some(validStop); });
    el.textContent = '';
    if (!all.length) { el.className = 'muted'; el.textContent = 'None yet.'; return; }
    el.className = '';
    all.forEach(function (r) {
      var ok = r.seq.filter(validStop), when = new Date(r.when), n = Math.max(0, ok.length - (ok[0] && ok[0].shop ? 1 : 0));
      var sk = Array.isArray(r.skipped) ? r.skipped.filter(validStop).length : 0;
      var c = h('div', { class: 'card is-link', role: 'button', tabindex: '0' }, [
        h('b', { text: r.name || 'Route' }),
        h('div', { class: 'd', text: plural(n, 'stop') + (sk ? ' · ' + sk + ' skipped' : '') + (r.rt ? ' · round trip' : '') + (isNaN(when) ? '' : ' · ' + when.toLocaleString()) })
      ]);
      var del = h('button', { type: 'button', class: 'btn btn--sm btn--danger pressable', style: 'margin-top:6px', text: 'Delete' });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Delete saved route “' + (r.name || 'Route') + '”?')) return;
        var cur = lsJSON('routes', []); if (!Array.isArray(cur)) cur = [];
        var idx = -1; cur.forEach(function (x, j) { if (idx < 0 && x && x.when === r.when && x.name === r.name) idx = j; });
        if (idx >= 0) cur.splice(idx, 1);
        lsSet('routes', JSON.stringify(cur)); renderSaved();
      });
      c.addEventListener('click', function () { loadSaved(r); });
      c.addEventListener('keydown', function (e) { if (e.target === c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); loadSaved(r); } });
      c.appendChild(del); el.appendChild(c);
    });
  }

  /* ================= One-click route of the selected jobs from the shop ================= */
  // R-2: startShopRoute (the route editor above) builds the route; these are the ways to start one.
  function queryTitle() { return query() ? ' matching “' + $('q').value.trim() + '”' : ''; }
  routeBtn.addEventListener('click', function (e) {
    if (!sel().length) { toggleRouteMenu(e.detail === 0); return; }   // nothing picked: choose a stage instead
    closeRouteMenu(); startShopRoute(currentJobs(), selTitle() + queryTitle() + ' from shop', MODE === 'stage' ? sel().slice() : null);
  });
  /* R-2: a "key" is a stage key or a list key (Stages.LISTS); keyJobs = every shown job in it, plus search. */
  function keyJobs(k) { var q = query(); return JOBS.filter(function (x) { return matchesKey(x, k) && (!q || hay(x).indexOf(q) >= 0); }); }
  function routeKey(k) { startShopRoute(keyJobs(k), keyLabel(k) + queryTitle() + ' from shop'); }

  /* Route menu: every stage, then the lists that have jobs; always one tap away from the Route chevron (whatever the
   * mode, chips or list scroll). Counts = routable jobs (mapped, Winnipeg-first), so they can differ from chip counts. */
  function rmItem(k, label, lead) {
    var list = keyJobs(k), c = routeCounts(list), n = c.wpg || c.out, sm = sumPrices(list);   // $ = the whole stage / list (+ search)
    return h('button', { type: 'button', class: 'rm-item pressable', role: 'menuitem', 'data-key': k, disabled: !list.length,
      'aria-label': 'Route ' + label + ', ' + plural(n, 'job') + (sm.n ? '; ' + label + ' Jobber total ' + fmtP(sm.v) : ''),
      title: !list.length ? 'No ' + label + ' jobs' : 'Route ' + plural(c.wpg, 'Winnipeg job') + ' in ' + label + ' from the shop' + (c.out ? '; ' + c.out + ' out of town can be added' : '') },
      [lead, h('span', { text: label }), h('span', { class: 'n', text: String(n) + (sm.n ? ' · ' + fmtPS(sm.v) : '') })]);
  }
  function fillRouteMenu() {
    rmenu.textContent = '';
    rmenu.appendChild(h('div', { class: 'rm-hd', 'aria-hidden': 'true', text: 'Route a stage from the shop' + queryTitle() }));
    STAGES.forEach(function (s, i) {
      rmenu.appendChild(rmItem(s.key, s.label, h('span', { class: 'dot', style: stageVars(i), 'aria-hidden': 'true', text: String(i + 1) })));
    });
    var lists = LISTS.filter(function (l) { return JOBS.some(function (x) { return l.predicate(effOf(x)); }); });
    if (!lists.length) return;
    rmenu.appendChild(h('div', { class: 'rm-sep', role: 'separator' }));
    rmenu.appendChild(h('div', { class: 'rm-hd', 'aria-hidden': 'true', text: 'Route a list' }));
    lists.forEach(function (l) { rmenu.appendChild(rmItem(l.key, l.label, listDot())); });
  }
  var safeProbe = null;
  function safeTop() {                                        // env(safe-area-inset-top) in px (iPhone status bar / notch)
    if (!safeProbe) { safeProbe = h('div', { 'aria-hidden': 'true', style: 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none' }); document.body.appendChild(safeProbe); }
    return safeProbe.offsetHeight || 0;
  }
  function placeRouteMenu() {
    // Never taller than the room beside its anchor: it scrolls instead of covering the Route button or (iPhone) the
    // accessory glass it opens from (7 stages + up to 6 lists no longer fit above the accessory).
    var b = routeMore.getBoundingClientRect(), w = rmenu.offsetWidth, accEl = routeMore.closest('#accessory');
    var top = accEl ? Math.min(b.top, accEl.getBoundingClientRect().top) : b.top;
    var up = b.top > innerHeight / 2, room = up ? top - 16 - Math.max(0, safeTop()) : innerHeight - b.bottom - 16 - 8;
    rmenu.style.maxHeight = Math.max(160, Math.floor(room)) + 'px';
    var hgt = rmenu.offsetHeight;
    var x = Math.max(8, Math.min(innerWidth - w - 8, b.right - w));
    var y = up ? Math.max(8 + safeTop(), top - hgt - 8) : Math.min(innerHeight - hgt - 8, b.bottom + 8);
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
    if (refocus || rmenu.contains(document.activeElement)) routeMore.focus();   // never strand focus in a removed row
    rmenu.classList.remove('is-open'); rmenu.hidden = true; routeMore.setAttribute('aria-expanded', 'false');
    rmenu.textContent = '';                                   // no stale Jobber totals left in a closed menu (refilled on open)
    return true;
  }
  function toggleRouteMenu(kbd) { if (!rmenu.hidden) closeRouteMenu(); else openRouteMenu(kbd); }
  routeMore.addEventListener('click', function (e) { toggleRouteMenu(e.detail === 0); });
  rmenu.addEventListener('click', function (e) {
    var b = e.target.closest('.rm-item'); if (!b || b.disabled) return;
    closeRouteMenu(); routeKey(b.getAttribute('data-key'));
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
    if (!rmenu.hidden && !rmenu.contains(e.target) && !(e.target.closest && e.target.closest('#routeMore, #routeSel'))) closeRouteMenu();
  }, true);
  addEventListener('resize', function () { closeRouteMenu(); });
  function routeGroup(k) {                                    // one click from a list group header: every job in that stage / list / client
    var q = query(), g = groupsForMode().filter(function (x) { return x.k === k; })[0]; if (!g) return;
    if (MODE === 'stage') { routeKey(k); return; }            // the whole stage / list, not only the rows grouped under it
    startShopRoute(JOBS.filter(function (x) { return groupOf(x) === k && (!q || hay(x).indexOf(q) >= 0); }), g.label + queryTitle() + ' from shop');
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
    if (BETA) {                                                // v1's stages.json overlay (read-only): its note says why v1 moves are not shown
      var ovNote = st.overlay && st.overlay.note;
      bits.push(ovNote ? 'Beta stages file · ' + String(ovNote) : 'Beta stages file; shows v1 moves automatically');
    }
    if (bits.length) el.appendChild(h('small', { text: bits.join(' · ') }));
    var hasK = false; try { hasK = !!store.hasKey(); } catch (e) {}
    $('stShare').hidden = !hasK; $('stRemove').hidden = !hasK;
    $('stKey').placeholder = hasK ? 'Key saved — paste a new one to replace it' : 'Paste edit key';
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
    var text = APP_NAME + ' — stage edit access\n\n' +
      'App: ' + APP_URL + '\n' +
      'Edit key: ' + key + '\n\n' +
      'iPhone: open the link in Safari → Share → Add to Home Screen → open ' + (BETA ? 'the EJ Beta app' : 'the app') + ' from the Home Screen → Settings → Stages → paste the key → Save.\n' +
      'PC: open the link → Settings → Stages → paste the key → Save.\n' +
      'Keep this key private; anyone with it can move job stages.';
    function fallback() { copyText(text).then(function () { toast('Copied — paste it into a message'); }, function () { toast('Couldn’t share or copy', null, { error: true }); }); }
    if (navigator.share) navigator.share({ title: APP_NAME + ' edit access', text: text }).catch(function (err) { if (!err || err.name !== 'AbortError') fallback(); });
    else fallback();
  });
  var devInp = $('stDevice');
  try { devInp.value = store.deviceLabel() || ''; } catch (e) {}
  function saveDevice() { var v = devInp.value.trim(); if (!v) return; try { store.setDeviceLabel(v); } catch (e) {} }
  devInp.addEventListener('change', saveDevice);
  devInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveDevice(); devInp.blur(); toast('Device name saved'); } });

  /* ================= R-2 pricing: load, $ toggle, in-place paint, Settings -> Pricing ================= */
  function loadPrices() {                                     // never rejects; a failed load keeps the last good prices
    var my = ++priceGen;
    PKEY = priceKey();
    if (!PKEY) { PRICES = null; paintPrices(); return Promise.resolve(); }
    renderPriceStatus();
    return Promise.resolve().then(function () { return pstore.load(); }).then(function (m) {
      if (my !== priceGen) return;                            // a newer load / key change won
      if (m) PRICES = m;
      paintPrices();
    }, function () { if (my === priceGen) paintPrices(); });
  }
  /* Everything that shows a price, updated in place (no re-render): $ button, rows, group headers, chips, route menu,
   * detail, hover card, route editor caption, Settings status. Called on toggle, key change and every prices load. */
  function paintPrices() {
    PKEY = priceKey();
    if (!PKEY) PRICES = null;
    var tg = $('prTgl'), on = PKEY && SHOWP;
    tg.hidden = !PKEY;
    tg.setAttribute('aria-pressed', on ? 'true' : 'false');
    tg.title = on ? 'Hide prices' : 'Show prices';
    if (dataLoaded) {
      Object.keys(rows).forEach(function (jn) {
        var x = byNum[jn], r = rows[jn]; if (!x || !r) return;
        r.replaceChild(rowTrail(x), r.lastChild); r.setAttribute('aria-label', rowAria(x));
      });
      updateGroupCounts(); updateChipCounts();
    }
    if (detailJn != null && byNum[detailJn]) paintDetailPrice(byNum[detailJn]); else paintDetailPrice(null);
    if (cardJob) { paintCardPrice(cardJob); cardH = card.offsetHeight || cardH; } else paintCardPrice(null);
    paintEdCap(included());
    if (!rmenu.hidden) {                                      // open route menu: refill, keep the focused row
      var fk = document.activeElement && rmenu.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
      fillRouteMenu(); placeRouteMenu();
      var fb = fk && rmenu.querySelector('.rm-item[data-key="' + fk + '"]'); if (fb) fb.focus();
    }
    renderPriceStatus();
  }
  $('prTgl').addEventListener('click', function () {
    if (!priceKey()) { paintPrices(); return; }
    SHOWP = !SHOWP;
    try { pstore.setShow(SHOWP); } catch (e) {}
    paintPrices();
    if (!SHOWP) toast('Prices hidden');
    else if (PRICES) toast('Prices shown');
    else toast('Prices shown — none loaded yet', function () { UI.openSettings('pricing'); }, { action: 'Settings' });
  });
  function relAge(iso) {                                      // "just now", "12 min ago", "3 h ago", "2 days ago", "Sep 12"
    var d = new Date(iso); if (isNaN(d)) return '';
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var hr = Math.round(m / 60); if (hr < 24) return hr + ' h ago';
    var dy = Math.round(hr / 24); if (dy < 7) return plural(dy, 'day') + ' ago';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function renderPriceStatus() {
    var el = $('prStatus'), k = PKEY, cls = '', text, small = '';
    var info = null, err = null;
    if (pstore && k) { try { info = pstore.info(); err = pstore.lastError(); } catch (e) {} }
    if (!pstore) { cls = 'is-err'; text = 'Pricing didn’t load — reload the app'; }
    else if (!k) text = 'Locked — no pricing key on this device';
    else if (info) {
      cls = err ? 'is-local' : 'is-on';
      text = plural(info.count, 'price') + (info.at && relAge(info.at) ? ', updated ' + relAge(info.at) : '');
      small = err ? String(err) : SHOWP ? 'Shown — the $ button next to the map hides them' : 'Hidden — the $ button next to the map shows them';
    } else if (err) {
      cls = /^No prices yet/.test(err) ? 'is-local' : 'is-err';
      text = String(err);
    } else text = 'Key saved — checking…';
    el.textContent = '';
    el.appendChild(h('span', { class: 'status-dot ' + cls, 'aria-hidden': 'true' }));
    el.appendChild(document.createTextNode(text));
    if (small) el.appendChild(h('small', { text: small }));
    $('prRemove').hidden = !k;
    $('prStatusBox').hidden = !k && !!pstore;                   // no key (crew devices): just the field and one line
    $('prNote').textContent = k ? 'Separate from the edit key. Job prices are published encrypted; only a device with this key can read them. The key stays on this device. The $ button next to the map shows or hides prices.'
      : 'Optional. Shows Jobber totals on this device only.';
    $('prKey').placeholder = k ? 'Key saved — paste a new one to replace it' : 'Paste pricing key';
    $('prSave').disabled = !pstore;
  }
  function prMsg(t, kind) { var m = $('prMsg'); m.textContent = t || ''; m.className = 'set-note' + (kind ? ' is-' + kind : ''); }
  $('prSave').addEventListener('click', function () {        // the key goes straight to Prices.setKey: never logged or shown
    var inp = $('prKey'), b = $('prSave');
    if (!pstore) { prMsg('Pricing didn’t load — reload the app.', 'err'); return; }
    if (!inp.value || !inp.value.trim()) { prMsg('Paste the pricing key first.', 'err'); return; }
    b.disabled = true; prMsg('Checking the key…');
    Promise.resolve().then(function () { return pstore.setKey(inp.value); }).then(function (r) {
      if (r && r.ok) {
        inp.value = ''; PRICES = null; priceGen++;
        try { SHOWP = !!pstore.getShow(); } catch (e) {}
        if (r.pending) prMsg('Key saved. ' + (r.reason || 'No prices yet') + '.');
        else prMsg('Key saved — ' + plural(r.count || 0, 'price') + ' unlocked.', 'ok');
        toast('Pricing key saved');
        return loadPrices();
      }
      prMsg('Not saved: ' + ((r && r.reason) || 'the key could not be checked') + '.', 'err');
    }, function () { prMsg('Not saved: the key could not be checked. Try again.', 'err'); })
      .then(function () { b.disabled = false; paintPrices(); });
  });
  $('prKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('prSave').click(); } });
  $('prRemove').addEventListener('click', function () {
    if (!confirm('Remove the pricing key from this device? Prices are hidden here until a key is pasted again.')) return;
    try { pstore.removeKey(); } catch (e) {}
    PRICES = null; priceGen++;
    prMsg('Pricing key removed from this device.'); paintPrices();
  });

  /* ================= boot ================= */
  if (BETA) {                                                 // beta marks (r2-plan sec. 9): a pill by the sheet/panel title, the
    // job detail title (where stages move) and the collapsed phone capsule, so a beta move is never mistaken for v1's; About
    var betaTip = 'EJ Beta: the R-2 trial next to v1 (stage moves here do not show in v1)';
    var ttl = document.querySelector('#sheet .sheet-title');
    if (ttl && !document.getElementById('betaPill')) ttl.insertAdjacentElement('afterend', h('span', { class: 'beta-pill', id: 'betaPill', title: betaTip, text: 'Beta' }));
    var dT = $('dTitle');
    if (dT && !document.getElementById('betaPillDetail')) dT.insertAdjacentElement('beforebegin', h('span', { class: 'beta-pill beta-pill--eyebrow', id: 'betaPillDetail', title: betaTip, text: 'Beta' }));
    var acc = $('accessory');
    if (acc && !document.getElementById('betaPillAcc')) acc.insertAdjacentElement('afterbegin', h('span', { class: 'beta-pill beta-pill--acc', id: 'betaPillAcc', title: betaTip, text: 'Beta' }));
    $('aboutVer').textContent = 'Eckstein Jobs · R-2 beta';
  }
  syncModeSeg(); renderEditor(); renderSaved(); renderStageStatus(); lockSliders(); paintPrices();
  if (!HAS_MAP) { setUpd('map library failed to load — check the connection and reload'); }
  loadData().then(function () { try { store.start(); } catch (e) {} });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});

  window.EJ = {                                               // debugging / verification hooks (no secrets)
    get jobs() { return JOBS; }, get allJobs() { return ALL; }, get stageMap() { return STAGEMAP; },
    get mode() { return MODE; }, get sel() { return SEL; }, map: map, config: { channel: CFG.channel, base: BASE, ns: NS },
    store: {                                                  // facade: never setKey / removeKey / getKeyForShare (APP_MASTER Rule 1)
      get mode() { return store.mode; }, get writable() { return !!store.writable; },
      status: function () { return store.status ? store.status() : null; }, peek: function () { return store.peek ? store.peek() : {}; },
      load: function () { return store.load(); }, set: function (jn, p, m) { return store.set(jn, p, m); },
      flush: function () { return store.flush ? store.flush() : Promise.resolve(); }, hasKey: function () { return !!store.hasKey(); }
    },
    /* R-2 verification: after editing jobs' hints / closed in the console, recompute and redraw everything */
    refreshAll: function () { ALL.forEach(refreshEff); rebuildVisible(); renderAll(); refreshOpenJob(); },
    reload: reloadData, esc: esc, get stops() { return ED.stops; }, get editor() { return ED; }, get routeSeq() { return routeSeq(); }
  };
})();
