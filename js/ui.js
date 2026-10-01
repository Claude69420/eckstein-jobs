/* ui.js — Eckstein Jobs shell: press glow, views, sheets (iPhone detents / desktop panel), accessory, toast, Settings groups,
 * the 7-stop StageSlider (R-2: gates + lock glyph) and the desktop refraction gate (hyalite). Plain ES2017 script, no modules.
 * app.js (loaded after this file) provides window.fillDetail, window.clearSelection and window.onViewChange.
 * Exposes window.UI.
 */
(function () {
  'use strict';

  function mq(q) {
    var m; try { m = window.matchMedia(q); } catch (e) { m = null; }
    if (!m) m = { matches: false };
    m.on = function (fn) { if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn); };
    return m;
  }
  var DESK = mq('(min-width: 900px)'), FINE = mq('(hover: hover) and (pointer: fine)');
  var root = document.documentElement,
      acc = document.getElementById('accessory'), tabs = document.getElementById('tabs'),
      ctl = document.getElementById('ctl'), scrim = document.getElementById('scrim'),
      filterbar = document.getElementById('filterbar'),
      listEl = document.getElementById('sheet'), detailEl = document.getElementById('detail'),
      toastEl = document.getElementById('toast');
  // R-3: two tabs, Jobs · Route. The R-2 "Plan" view is now "Route"; the published-routes view is retired (its list is
  // Settings -> Routes -> "Old route maps"). An old view name (a stale call) falls back to Jobs.
  var TITLES = { jobs: 'Jobs', route: 'Route', settings: 'Settings' };
  var TAB_ORDER = ['jobs', 'route'];
  var activeSheet = null, returnTo = null;

  /* ---------------- Press, glow and scale ---------------- */
  /* R-3 (r3-plan D): a touch on a chip inside the sideways-scrolling chip row changes NOTHING at touchstart (no scale,
   * no glass glow, no custom-property write on the accessory): like iOS's delaysContentTouches, the press shows after
   * ~110 ms, or as a short flash on a quick tap, and never once the finger has moved (a swipe scrolls the row). */
  var PRESS_DELAY = 110;
  document.addEventListener('pointerdown', function (e) {
    var t = e.target.closest && e.target.closest('.pressable'); if (!t || t.disabled) return;
    var g = t.closest('.glass'); if (g && g.classList.contains('sheet')) g = null;   // no glow on big sheets
    var lazy = e.pointerType === 'touch' && !!t.closest('.chips'), x0 = e.clientX, y0 = e.clientY, timer = 0, on = false;
    function press() {
      timer = 0; on = true;
      if (g) {
        var r = g.getBoundingClientRect();
        g.style.setProperty('--px', (x0 - r.left) + 'px'); g.style.setProperty('--py', (y0 - r.top) + 'px');
        g.classList.add('is-lit');
      }
      t.classList.add('is-pressed');
    }
    function release() { on = false; t.classList.remove('is-pressed'); if (g) g.classList.remove('is-lit'); }
    function done() {
      removeEventListener('pointerup', up, true); removeEventListener('pointercancel', cancel, true);
      removeEventListener('pointermove', move, true);
    }
    function up() {
      done();
      if (timer) { clearTimeout(timer); press(); setTimeout(release, 130); return; }   // quick tap: a short flash
      release();
    }
    function cancel() { done(); clearTimeout(timer); timer = 0; release(); }
    function move(ev) {                                       // the finger moved: it is a swipe, not a press
      var mx = ev.clientX - x0, my = ev.clientY - y0;           // iOS-like tap slop: 10 px in a straight line
      if (ev.pointerId !== e.pointerId || mx * mx + my * my < 100) return;
      cancel();
    }
    if (lazy) { timer = setTimeout(press, PRESS_DELAY); addEventListener('pointermove', move, true); }
    else press();
    addEventListener('pointerup', up, true); addEventListener('pointercancel', cancel, true);
  }, { passive: true });

  /* ---------------- Views ---------------- */
  function placeFilterbar(inSheet) {
    var host = inSheet ? listEl.querySelector('.sheet-head') : acc.querySelector('.acc-slot');
    if (filterbar.parentNode === host) return;
    if (inSheet) host.insertBefore(filterbar, document.getElementById('q')); else host.appendChild(filterbar);
    // R-2: the chips row has a different shape in the accessory (one row) and the sheet (2-row band): app.js re-aims it
    if (typeof window.onFilterbarMoved === 'function') window.onFilterbarMoved(inSheet);
  }
  // --attr-b is written on the attribution corner itself: a custom property on <html> restyles the whole document.
  function attrB(v) {
    var a = document.querySelector('.leaflet-bottom.leaflet-right'); if (!a) return;
    if (v == null) a.style.removeProperty('--attr-b'); else a.style.setProperty('--attr-b', v + 'px');
  }
  function chrome(show) {                                    // accessory + tab bar = the collapsed state (iPhone)
    acc.hidden = !show; tabs.hidden = !show;
    if (show) { attrB(null); placeFilterbar(false); measureAcc(); }
  }
  var accH = 0;
  function measureAcc() {
    var h = !acc.hidden && acc.offsetHeight; if (!h || h === accH) return;   // rarely changes: skip no-op root writes
    accH = h; root.style.setProperty('--acc-h', h + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(measureAcc).observe(acc);

  function currentView() { return listEl.dataset.view || 'jobs'; }
  function showView(v) {                                     // v = jobs | route | settings
    if (!Object.prototype.hasOwnProperty.call(TITLES, v)) v = 'jobs';
    listEl.dataset.view = v; listEl.setAttribute('aria-label', TITLES[v]);
    listEl.querySelector('.sheet-title').textContent = TITLES[v];
    listEl.querySelectorAll('.sheet-body > .view').forEach(function (n) { n.classList.toggle('on', n.id === 'v-' + v); });
    var ti = TAB_ORDER.indexOf(v);
    tabs.querySelectorAll('.tab').forEach(function (b) {
      var on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (ti >= 0) tabs.style.setProperty('--i', ti);
    tabs.classList.toggle('no-tab', ti < 0);
    listEl.querySelectorAll('.panel-views [data-v]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false'); });
    placeFilterbar(v === 'jobs' && (DESK.matches || !listEl.hidden));
    var body = listEl.querySelector('.sheet-body'); if (body) body.scrollTop = 0;
    if (typeof window.onViewChange === 'function') window.onViewChange(v);   // app.js: route layer vs job layer
  }

  /* ---------------- Sheet with detents (iPhone). Finger is followed in JS; spring only on release. ---------------- */
  function Sheet(el) {
    var self = this, head = el.querySelector('.sheet-head'), startTop = 0;
    function curY() { return parseFloat(el.style.getPropertyValue('--y')) || 0; }
    function setY(y) { el.style.setProperty('--y', y + 'px'); }
    // While the finger drags, write the transform directly: --y inherits, so writing it restyles every row in the sheet.
    function dragTo(y) { el.style.transform = 'translate3d(0,' + y + 'px,0)'; }
    function endDrag(y) { setY(y); el.style.removeProperty('transform'); }
    function Y(name) {
      if (name === 'large') return 0;
      if (name === 'medium') return Math.max(0, el.offsetHeight - Math.round(innerHeight * 0.52));
      return startTop - el.offsetTop;                        // 'closed' = the edge it grew from
    }
    self.Y = Y;
    function settle() {                                       // end of a snap (transitionend OR no movement)
      if (el.dataset.detent === 'large') el.classList.add('is-opaque');
      if (el.dataset.detent === 'closed' && !el.hidden) { el.hidden = true; if (self.onClosed) self.onClosed(); }
    }
    self.snap = function (name, instant) {                  // instant: jump with no spring (before iOS pans for the keyboard)
      if (DESK.matches) return;
      var y = Y(name), moved = Math.abs(curY() - y) > 0.5;
      el.dataset.detent = name;
      el.classList.toggle('is-large', name === 'large');
      if (name !== 'large') el.classList.remove('is-opaque');
      scrim.classList.toggle('is-on', name === 'large');
      ctl.hidden = (name === 'large');
      toastEl.classList.toggle('is-low', name === 'large');  // at large the top toast would cover the sheet's title
      el.style.setProperty('--hidden', (name === 'medium' ? y : 0) + 'px');   // keeps the last rows reachable
      if (name === 'medium') attrB(Math.max(0, innerHeight - el.offsetTop - y + 10));
      if (instant && moved) { el.classList.add('is-dragging'); setY(y); void el.offsetHeight; el.classList.remove('is-dragging'); moved = false; }
      else setY(y);
      if (!moved) settle();                                   // no transform change -> no transitionend
      else clearTimeout(self._t), self._t = setTimeout(function () { if (el.dataset.detent === name) settle(); }, 1200); // safety net
    };
    self.open = function (detent) {
      startTop = acc.hidden ? innerHeight : acc.getBoundingClientRect().top;   // measure BEFORE hiding
      chrome(false);
      el.hidden = false; activeSheet = self;
      el.classList.add('is-dragging'); setY(Y('closed')); void el.offsetHeight; el.classList.remove('is-dragging');
      self.snap(detent || 'medium');
    };
    self.close = function () { self.snap('closed'); };
    self.isOpen = function () { return !el.hidden && el.dataset.detent !== 'closed'; };
    el.addEventListener('transitionend', function (e) {
      if (e.target === el && e.propertyName === 'transform') settle();
    });
    head.addEventListener('pointerdown', function (e) {
      if (DESK.matches || e.button > 0 || e.target.closest('button, input, a, .chips, .seg, .stage')) return;
      var y0 = curY(), p0 = e.clientY, s = [{ y: e.clientY, t: e.timeStamp }];
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
      el.classList.add('is-dragging'); el.classList.remove('is-opaque');
      var lastY = y0;
      function move(ev) {
        var y = y0 + ev.clientY - p0; lastY = y < 0 ? y / 3 : y; dragTo(lastY);
        s.push({ y: ev.clientY, t: ev.timeStamp }); if (s.length > 5) s.shift();
      }
      function end(ev) {                                      // remove ALL three listeners
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', end);
        head.removeEventListener('pointercancel', end);
        endDrag(lastY);                                       // still .is-dragging: the hand-over has no transition
        el.classList.remove('is-dragging');
        if (ev.type === 'pointercancel') return self.snap(el.dataset.detent);
        if (Math.abs(ev.clientY - p0) < 4) return self.snap(el.dataset.detent === 'large' ? 'medium' : 'large'); // grabber tap cycles
        var a = s[0], b = s[s.length - 1], v = (b.y - a.y) / Math.max(1, b.t - a.t);    // px/ms, + = down
        var target = y0 + ev.clientY - p0 + v * 200;
        self.snap(['large', 'medium', 'closed'].reduce(function (m, n) {
          return Math.abs(Y(n) - target) < Math.abs(Y(m) - target) ? n : m;
        }));
      }
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
    });
  }

  var listSheet = new Sheet(listEl), detailSheet = new Sheet(detailEl);
  function openList(view, detent) {
    if (DESK.matches) { if (!detailEl.hidden) closeDetail(); showView(view); return; }
    if (!detailEl.hidden) { returnTo = null; detailEl.hidden = true; detailEl.dataset.detent = 'closed'; if (window.clearSelection) window.clearSelection(); }
    if (listSheet.isOpen()) { showView(view); listSheet.snap(detent || listEl.dataset.detent || 'medium'); return; }
    listSheet.open(detent); showView(view);
  }
  listSheet.onClosed = function () {
    activeSheet = null; chrome(true); toastEl.classList.remove('is-low');
    if (currentView() === 'settings') showView('jobs');
  };
  detailSheet.onClosed = function () {
    if (window.clearSelection) window.clearSelection();
    if (returnTo) { var d = returnTo; returnTo = null; openList(currentView(), d); }
    else { activeSheet = null; chrome(true); toastEl.classList.remove('is-low'); }
  };
  scrim.addEventListener('click', function () { if (activeSheet) activeSheet.snap('medium'); });
  addEventListener('resize', function () {
    if (!DESK.matches && activeSheet) activeSheet.snap(activeSheet === listSheet ? listEl.dataset.detent : detailEl.dataset.detent);
  });

  /* Accessory: tap empty area or swipe up -> Jobs sheet */
  acc.addEventListener('pointerdown', function (e) {
    if (e.target.closest('button, .chips, .seg, a, input')) return;
    var y0 = e.clientY;
    function end(ev) {
      acc.removeEventListener('pointerup', end); acc.removeEventListener('pointercancel', end);
      var dy = y0 - ev.clientY;
      if (ev.type === 'pointerup' && (dy > 24 || Math.abs(dy) < 6)) openList('jobs', 'medium');
    }
    acc.addEventListener('pointerup', end); acc.addEventListener('pointercancel', end);
  });
  tabs.addEventListener('click', function (e) {
    var b = e.target.closest('.tab'); if (!b) return;
    openList(b.dataset.v, 'medium');
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
    switch (b.dataset.act) {
      case 'settings':     openSettings(b.dataset.section); break;
      case 'collapse':     listSheet.close(); break;
      case 'close-detail': closeDetail(); break;
      /* zoom-in / zoom-out / locate / reload are handled in app.js */
    }
  });
  function openSettings(section) {                          // section 'stages' / 'pricing' / 'routes' scrolls to that Settings group
    if (DESK.matches) { if (!detailEl.hidden) closeDetail(); showView('settings'); }
    else openList('settings', 'large');
    var hd = { stages: 'setStH', pricing: 'setPrH', routes: 'setRtH' }[section];
    hd = hd && document.getElementById(hd);
    if (!hd) return;
    requestAnimationFrame(function () {                       // scroll the sheet body only (never the page: iOS would pan)
      var body = listEl.querySelector('.sheet-body');
      body.scrollTop = Math.max(0, hd.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8);
    });
  }
  listEl.querySelector('.panel-views').addEventListener('click', function (e) {
    var b = e.target.closest('[data-v]'); if (!b) return;
    if (!detailEl.hidden) closeDetail();
    showView(b.dataset.v);
  });
  /* iPhone text fields (search, address, edit key, device name): jump to the large detent on the touch itself,
   * before focus, so the field already sits above the keyboard when iOS decides whether to pan the page. */
  var TEXT_SEL = 'input[type=search], input[type=text], input[type=password]';
  listEl.addEventListener('pointerdown', function (e) {
    if (DESK.matches || !e.target.closest || !e.target.closest(TEXT_SEL)) return;
    if (listSheet.isOpen() && listEl.dataset.detent !== 'large') listSheet.snap('large', true);
  }, true);
  detailEl.addEventListener('pointerdown', function (e) {    // R-3: the "Edit name & location" fields in the job sheet
    if (DESK.matches || !e.target.closest || !e.target.closest(TEXT_SEL)) return;
    if (detailSheet.isOpen() && detailEl.dataset.detent !== 'large') detailSheet.snap('large', true);
  }, true);
  document.getElementById('q').addEventListener('focus', function () { if (!DESK.matches && listSheet.isOpen()) listSheet.snap('large'); });
  document.addEventListener('focusout', function (e) {       // clear any pan iOS left behind once the keyboard closes
    if (DESK.matches || !e.target.matches || !e.target.matches(TEXT_SEL)) return;
    setTimeout(function () {
      var a = document.activeElement;
      if (a && a.matches && a.matches(TEXT_SEL)) return;      // moved to another field: the keyboard stays
      if (window.visualViewport && visualViewport.offsetTop > 0) scrollTo(0, 0);
    }, 50);
  });

  /* Keyboard: iOS resizes only the visual viewport. --kb lives on the two sheets (its only readers), once per frame. */
  if (window.visualViewport) {
    var kbRaf = 0, kbLast = -1;
    var kb = function () {
      kbRaf = 0;
      var v = Math.max(0, Math.round(innerHeight - visualViewport.height - visualViewport.offsetTop));
      if (v === kbLast) return;
      kbLast = v; listEl.style.setProperty('--kb', v + 'px'); detailEl.style.setProperty('--kb', v + 'px');
    };
    var kbSoon = function () { if (!kbRaf) kbRaf = requestAnimationFrame(kb); };
    visualViewport.addEventListener('resize', kbSoon); visualViewport.addEventListener('scroll', kbSoon);
  }

  /* ---------------- Detail open/close (both layouts) ---------------- */
  function isDetailOpen() { return !detailEl.hidden && (DESK.matches || detailEl.dataset.detent !== 'closed'); }
  function openDetail(job) {                                 // called by app.js with a job record
    if (window.fillDetail) window.fillDetail(job);
    if (DESK.matches) {
      var was = detailEl.hidden;
      listEl.hidden = true; detailEl.hidden = false;
      if (was) { detailEl.querySelector('.sheet-body').scrollTop = 0; refreshLens(detailEl); }
      return;
    }
    if (detailSheet.isOpen()) return;                        // already open: just refilled in place
    returnTo = listEl.hidden ? null : (listEl.dataset.detent === 'large' ? 'medium' : listEl.dataset.detent);
    if (!listEl.hidden) { listEl.hidden = true; listEl.dataset.detent = 'closed'; }
    detailSheet.open('medium');
    detailEl.querySelector('.sheet-body').scrollTop = 0;
  }
  function closeDetail() {
    if (DESK.matches) {
      if (detailEl.hidden) return;
      detailEl.hidden = true; listEl.hidden = false; refreshLens(listEl);
      if (window.clearSelection) window.clearSelection(true);
      return;
    }
    detailSheet.close();
  }

  /* ---------------- Desktop <-> iPhone ---------------- */
  function layout() {
    if (DESK.matches) {
      chrome(false); scrim.classList.remove('is-on'); ctl.hidden = false; activeSheet = null; returnTo = null;
      [listEl, detailEl].forEach(function (s) {
        s.classList.remove('is-large', 'is-opaque', 'is-dragging');
        s.style.removeProperty('--y'); s.style.removeProperty('--hidden'); s.dataset.detent = 'desktop';
      });
      attrB(null); toastEl.classList.remove('is-low');
      listEl.hidden = !detailEl.hidden;                       // the detail replaces the list while open
      placeFilterbar(currentView() === 'jobs');
    } else {
      var wasDetail = !detailEl.hidden;
      listEl.hidden = true; detailEl.hidden = true; listEl.dataset.detent = detailEl.dataset.detent = 'closed';
      scrim.classList.remove('is-on'); ctl.hidden = false;
      activeSheet = null; returnTo = null; chrome(true);
      if (wasDetail && window.clearSelection) window.clearSelection();
    }
    if (typeof window.onLayout === 'function') window.onLayout(DESK.matches);
  }
  DESK.on(layout); layout();

  /* Esc: close card/detail/sheet */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (window.closeCard && window.closeCard()) return;
    if (isDetailOpen()) { closeDetail(); return; }
    if (!DESK.matches && listSheet.isOpen()) listSheet.close();
  });

  /* ---------------- Toast with optional Undo ---------------- */
  var toastT = 0, undoFn = null;
  function toast(msg, undo, opts) {
    opts = opts || {};
    toastEl.querySelector('.msg').textContent = msg;
    var b = toastEl.querySelector('.btn');
    b.hidden = !undo; b.textContent = opts.action || 'Undo'; undoFn = undo || null;
    toastEl.classList.toggle('is-err', !!opts.error);
    toastEl.classList.add('is-on'); clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('is-on'); undoFn = null; }, opts.ms || (undo ? 5000 : 3200));
  }
  toastEl.querySelector('.btn').addEventListener('click', function () {
    var f = undoFn; undoFn = null; toastEl.classList.remove('is-on'); if (f) f();
  });

  /* ---------------- Stage slider: mount once per .stage element, rebind with .set(job) ----------------
   * R-2: the stops (ticks, labels, "of N") are generated from Stages.STAGES (7), never hard-coded in the HTML.
   * opts.gate(job, key) -> {ok, reason, message} (Stages.canMove); blocked stops are dimmed, a lock glyph sits on the
   * first blocked tick, a drag resists past it (rubber band), and a tap/drag/key onto a blocked stop shakes the thumb,
   * springs back and calls opts.onBlocked(job, key, result) (app.js: toast + highlight the blocking item row).
   * Nothing is ever silently ignored. */
  var ST = (window.Stages && window.Stages.STAGES) || [
    { key: 'ready', label: 'Ready to start', short: 'Ready' }, { key: 'setup', label: 'Setup', short: 'Setup' },
    { key: 'excavation', label: 'Excavation', short: 'Excav.' }, { key: 'base', label: 'Base', short: 'Base' },
    { key: 'prep', label: 'Prep', short: 'Prep' }, { key: 'inspected', label: 'Passed inspection', short: 'Passed' },
    { key: 'poured', label: 'Poured', short: 'Poured' }];
  var LAST = ST.length - 1;
  function stageIndex(key) {
    if (window.Stages && window.Stages.stageIndex) return window.Stages.stageIndex(key);
    for (var i = 0; i < ST.length; i++) if (ST[i].key === key) return i; return 0;
  }
  /** Inline style for a stage colour + its glyph ink (tokens --stage-N / --stage-on-N; N = index + 1). */
  function stageVars(k) { return '--c:var(--stage-' + (k + 1) + ');--on-c:var(--stage-on-' + (k + 1) + ')'; }

  function StageSlider(el, onCommit, opts) {                 // onCommit(job, newKey)
    opts = opts || {};
    var track = el.querySelector('.stage-track'), now = el.querySelector('.stage-now'), job = null, pendingSet = null;
    var thumb = track.querySelector('.stage-thumb'), lens = thumb.querySelector('.stage-lens'), labels = el.querySelector('.stage-labels');
    /* Build the stops once from ST (track + the lens clone under the thumb + label buttons). */
    el.style.setProperty('--n', ST.length);
    el.setAttribute('aria-valuemin', '1'); el.setAttribute('aria-valuemax', String(ST.length));
    [track, lens].forEach(function (host) {
      host.querySelectorAll('.stage-tick').forEach(function (t) { t.parentNode.removeChild(t); });
      ST.forEach(function (s, k) {
        var t = document.createElement('i'); t.className = 'stage-tick'; t.setAttribute('data-k', k); t.style.setProperty('--k', k);
        if (host === track) track.insertBefore(t, thumb); else lens.appendChild(t);
      });
    });
    if (labels) {
      labels.textContent = '';
      ST.forEach(function (s, k) {
        var li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button'; b.tabIndex = -1; b.setAttribute('data-k', k); b.style.setProperty('--k', k); b.textContent = s.short;
        b.title = s.label; li.appendChild(b); labels.appendChild(li);
      });
    }
    var gates = [], firstBlocked = ST.length;               // gates[k] = gate result; firstBlocked = first locked stop
    function computeGates() {
      gates = []; firstBlocked = ST.length;
      ST.forEach(function (s, k) {
        var r = { ok: true };
        if (job && opts.gate) { try { r = opts.gate(job, s.key) || { ok: true }; } catch (e) { r = { ok: true }; } }
        gates[k] = r; if (!r.ok && k < firstBlocked) firstBlocked = k;
      });
      el.querySelectorAll('.stage-tick').forEach(function (t) {
        var k = +t.dataset.k; t.classList.toggle('is-locked', k >= firstBlocked); t.classList.toggle('is-barrier', k === firstBlocked);
      });
      el.querySelectorAll('.stage-labels button').forEach(function (b) {
        var k = +b.dataset.k, lk = k >= firstBlocked;
        b.classList.toggle('is-locked', lk);
        b.title = lk ? ST[k].label + ' (locked: ' + (gates[k].message || 'blocked') + ')' : ST[k].label;
      });
      el.classList.toggle('has-lock', firstBlocked < ST.length);
    }
    function maxOk() { return Math.max(0, firstBlocked - 1); }
    function measure() { el.style.setProperty('--tw', track.clientWidth + 'px'); }
    if (window.ResizeObserver) new ResizeObserver(measure).observe(track);
    function locked() { return !job || el.getAttribute('aria-disabled') === 'true'; }
    var previewK = -1;
    function paint(k, note) {
      var s = ST[k];
      el.style.setProperty('--c', 'var(--stage-' + (k + 1) + ')');
      el.style.setProperty('--c-real', 'var(--stage-' + (k + 1) + ')');
      el.style.setProperty('--on-c', 'var(--stage-on-' + (k + 1) + ')');
      el.setAttribute('aria-valuenow', k + 1); el.setAttribute('aria-valuetext', s.label);
      el.querySelectorAll('.stage-tick').forEach(function (t) { t.classList.toggle('is-done', +t.dataset.k <= k); });
      el.querySelectorAll('.stage-labels button').forEach(function (b) {
        if (+b.dataset.k === k) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      });
      var dot = now.querySelector('.dot'); dot.textContent = k + 1; dot.removeAttribute('style');
      now.querySelector('.name').textContent = s.label;
      var sm = now.querySelector('small'); sm.textContent = note || ('Stage ' + (k + 1) + ' of ' + ST.length); sm.classList.toggle('is-lock-note', !!note);
      sm.title = note || '';
      previewK = -1;
    }
    /* Mouse hover over the track names the stage under the pointer (nothing is saved until a click). */
    function preview(k) {
      if (k === previewK) return;
      var cur = stageIndex(job.stage);
      if (k === cur) { paint(cur); return; }
      previewK = k;
      var dot = now.querySelector('.dot');
      dot.textContent = k + 1; dot.setAttribute('style', stageVars(k) + ';background:var(--c);color:var(--on-c)');
      now.querySelector('.name').textContent = ST[k].label;
      var sm = now.querySelector('small'), lk = !!(gates[k] && !gates[k].ok);
      sm.textContent = lk ? 'Locked · ' + (gates[k].message || '') : 'Click to move here'; sm.classList.toggle('is-lock-note', lk);
      sm.title = lk ? sm.textContent : '';                   // one line (ellipsis): the full reason is in the tooltip
    }
    track.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse' || locked() || el.classList.contains('is-dragging')) return;
      var r = track.getBoundingClientRect();
      preview(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * LAST));
    });
    track.addEventListener('pointerleave', function () {
      if (previewK >= 0 && job && !el.classList.contains('is-dragging')) paint(stageIndex(job.stage));
    });
    function place(k) { el.style.setProperty('--p', k / LAST); paint(k); }
    var shakeT = 0;
    function refuse(k) {                                       // blocked stop: spring back, shake, tell the app why
      place(stageIndex(job.stage));
      el.classList.remove('is-shake'); void thumb.offsetWidth; el.classList.add('is-shake');
      clearTimeout(shakeT); shakeT = setTimeout(function () { el.classList.remove('is-shake'); }, 520);
      if (opts.onBlocked) opts.onBlocked(job, ST[k].key, gates[k] || { ok: false });
    }
    function commit(k) {
      if (!job) return;
      if (ST[k].key !== job.stage && gates[k] && !gates[k].ok) { refuse(k); return; }
      place(k); if (ST[k].key !== job.stage) onCommit(job, ST[k].key);
    }
    track.addEventListener('pointerdown', function (e) {
      if (locked() || e.button > 0) return;
      e.preventDefault();
      try { track.setPointerCapture(e.pointerId); } catch (err) {}
      measure(); el.classList.add('is-dragging');
      var r = track.getBoundingClientRect(), raf = 0, raw, pA = maxOk() / LAST;
      function at(x) { return Math.min(1, Math.max(0, (x - r.left) / r.width)); }
      function draw() {                                        // past the lock the thumb resists (rubber band)
        raf = 0;
        var p = raw > pA ? pA + (raw - pA) * 0.18 : raw, want = Math.round(raw * LAST);
        el.style.setProperty('--p', p);
        if (want > maxOk()) paint(maxOk(), 'Locked');          // short, one line (never reflows under the finger); the reason
                                                               // comes with the refusal toast and the flagged item row
        else paint(want);
      }
      raw = at(e.clientX); draw();
      function move(ev) { raw = at(ev.clientX); if (!raf) raf = requestAnimationFrame(draw); }
      function end(ev) {
        track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', end);
        track.removeEventListener('pointercancel', end);
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        el.classList.remove('is-dragging');
        if (ev.type === 'pointercancel' || !job) { if (job) place(stageIndex(job.stage)); }
        else commit(Math.round(raw * LAST));
        if (pendingSet) { var j = pendingSet; pendingSet = null; api.set(j); }
      }
      track.addEventListener('pointermove', move); track.addEventListener('pointerup', end);
      track.addEventListener('pointercancel', end);
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.stage-labels button'); if (!b || locked()) return;
      commit(+b.dataset.k);
    });
    el.addEventListener('keydown', function (e) {
      if (locked()) return;
      var k = stageIndex(job.stage), d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (e.key === 'Home') d = -k; if (e.key === 'End') d = LAST - k;
      if (d) { e.preventDefault(); commit(Math.min(LAST, Math.max(0, k + d))); }
    });
    var api = {
      set: function (j) {
        if (el.classList.contains('is-dragging')) { pendingSet = j; job = j; return; }
        job = j; computeGates(); if (j) place(stageIndex(j.stage));
      },
      lock: function (on) { el.setAttribute('aria-disabled', on ? 'true' : 'false'); },
      isDragging: function () { return el.classList.contains('is-dragging'); },
      job: function () { return job; }
    };
    return api;
  }

  /* ---------------- Refraction gate (desktop Chromium only; hyalite loaded lazily, app works without it) ---------------- */
  var hyaliteState = 'idle';                                 // idle | loading | ready | failed
  function refractGate() {
    var d = document.documentElement, want = false;
    try {
      want = !!(navigator.userAgentData && navigator.userAgentData.brands &&
                navigator.userAgentData.brands.some(function (b) { return /Chromium/i.test(b.brand); })) &&
             mq('(hover: hover) and (pointer: fine) and (min-width: 900px)').matches &&
             !mq('(prefers-contrast: more)').matches && !mq('(prefers-reduced-transparency: reduce)').matches &&
             d.getAttribute('data-glass') === 'liquid';
    } catch (e) { want = false; }
    if (!want) {
      try { if (window.Hyalite && window.Hyalite.unwatch) window.Hyalite.unwatch(); } catch (e) {}
      d.classList.remove('lg-refract'); return;
    }
    function go() {
      try {
        var H = window.Hyalite;
        if (!H || !H.supported || !H.supported()) { d.classList.remove('lg-refract'); return; }
        H.unwatch();                                        // stops every watcher; attached elements are detached
        H.watch(document.body, '.lens-panel', { blur: 12, dispersion: 0, slope: 0.9, settle: 150, materialize: 240 });
        H.watch(document.body, '.lens-ctl', { blur: 3, slope: 0.9 });
        d.classList.add('lg-refract');
      } catch (e) { d.classList.remove('lg-refract'); }
    }
    if (window.Hyalite) return go();
    if (hyaliteState === 'loading' || hyaliteState === 'failed') return;
    hyaliteState = 'loading';
    var s = document.createElement('script'); s.src = 'vendor/hyalite.js'; s.async = true;
    s.onload = function () { hyaliteState = 'ready'; refractGate(); };
    s.onerror = function () { hyaliteState = 'failed'; d.classList.remove('lg-refract'); };
    document.head.appendChild(s);
  }
  function refreshLens(el) {                                 // call right after un-hiding a .lens-panel
    try { if (window.Hyalite && root.classList.contains('lg-refract')) window.Hyalite.refresh(el); } catch (e) {}
  }
  addEventListener('uiprefs', refractGate); DESK.on(refractGate); FINE.on(refractGate);   // e.g. Surface tablet <-> laptop
  mq('(prefers-contrast: more)').on(refractGate); mq('(prefers-reduced-transparency: reduce)').on(refractGate);
  if (document.readyState === 'complete') refractGate(); else addEventListener('load', refractGate);

  /* ---------------- Sheet padding helper for fitBounds / panInside ---------------- */
  function mapPadding() {
    if (DESK.matches) {
      var left = listEl.hidden && detailEl.hidden ? 24 : 12 + listEl.offsetWidth + 24;
      if (!listEl.hidden || !detailEl.hidden) left = 12 + (listEl.offsetWidth || detailEl.offsetWidth || 380) + 24;
      return { paddingTopLeft: [left, 24], paddingBottomRight: [80, 24] };
    }
    var bottom;
    if (activeSheet && activeSheet.isOpen()) {
      var el = activeSheet === listSheet ? listEl : detailEl;
      bottom = el.dataset.detent === 'large' ? innerHeight * 0.3 : Math.round(innerHeight * 0.52) + 16;
    } else {
      var top = acc.hidden ? innerHeight : acc.getBoundingClientRect().top;
      bottom = innerHeight - top + 24;
    }
    return { paddingTopLeft: [24, 72], paddingBottomRight: [72, Math.max(24, bottom)] };
  }

  window.UI = {
    DESK: DESK, FINE: FINE, showView: showView, openList: openList, openDetail: openDetail, closeDetail: closeDetail,
    isDetailOpen: isDetailOpen, openSettings: openSettings, currentView: currentView, toast: toast,
    StageSlider: StageSlider, stageVars: stageVars, refreshLens: refreshLens, mapPadding: mapPadding, refractGate: refractGate,
    collapse: function () { if (!DESK.matches && listSheet.isOpen()) listSheet.close(); },
    /* R-2 route editor: jump the iPhone list sheet to the large detent (no spring) before a text field takes focus */
    sheetLarge: function () { if (!DESK.matches && listSheet.isOpen() && listEl.dataset.detent !== 'large') listSheet.snap('large', true); },
    listSheetOpen: function () { return DESK.matches ? !listEl.hidden : listSheet.isOpen(); },
    /* R-3: iPhone job sheet detent ('medium' shows the map above it: the edit preview pin; 'large' before a text field) */
    detailDetent: function (name, instant) { if (!DESK.matches && detailSheet.isOpen() && detailEl.dataset.detent !== name) detailSheet.snap(name, !!instant); }
  };
  window.openDetail = openDetail; window.closeDetail = closeDetail; window.toast = toast;
})();
