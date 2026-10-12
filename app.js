/* ============================================================
   LWH Fleet View — client (v1.2, Google Maps layout)
   Talks only to the fleet-live edge function. No Samsara token here.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.FLEET_CONFIG;
  var MOVING_MPH = 5;
  var APPROACH_DEG = 50;     // heading within this of the bearing to your site = "headed your way"
  var ROAD_FACTOR = 1.25;    // straight-line miles -> rough road miles
  var ETA_MAX_MI = 150;      // no ETA beyond this
  var TRAIL_HOURS = 8;
  var GLIDE_MS = 2000;       // how long a truck takes to slide to its new position
  var CLUSTER_PX = 48;       // markers closer than this on screen get grouped
  var CLUSTER_MIN = 3;       // smallest group worth a bubble
  var CLUSTER_BELOW_ZOOM = 18; // zoomed in this far, everything shows individually
  var SITE_TAGS_FROM_ZOOM = 14; // site name tags show from this zoom in
  var PEEK_PX = 96;          // phone sheet "peek" height (matches styles.css)

  var S = {
    pin: store('fv_pin') || '',
    user: store('fv_user') || '',
    siteName: store('fv_site') || '',
    data: null, lastOk: 0, loading: false,
    filters: { trucks: true, trailers: true, empty: false, dead: false, lowfuel: false, q: '' },
    map: null, markers: {}, sitesDrawn: false, centeredOnce: false, clusters: [], siteTags: {}, proj: null,
    info: null, infoKey: null, selKey: null,
    trail: null, trailInfo: {},
    pendingLoad: {},
    focusKey: null, follow: true
  };

  // ---------------- small helpers ----------------
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* private mode */ }
    return null;
  }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isDesktop() { return window.matchMedia('(min-width: 900px)').matches; }
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function rad(d) { return d * Math.PI / 180; }
  function milesBetween(a, b, c, d) {
    var dLat = rad(c - a), dLng = rad(d - b);
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 3958.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function bearing(a, b, c, d) {
    var y = Math.sin(rad(d - b)) * Math.cos(rad(c));
    var x = Math.cos(rad(a)) * Math.sin(rad(c)) - Math.sin(rad(a)) * Math.cos(rad(c)) * Math.cos(rad(d - b));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function headingDiff(a, b) {
    var d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  }
  function ageMin(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    return isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  function agoText(min) {
    if (min == null) return 'unknown';
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' hr ago';
    var d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }
  function clock(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function shortLabel(name) {
    var m = String(name || '').match(/^\s*(\d+)/);
    if (m) return m[1];
    var s = String(name || '').trim();
    return s.length > 8 ? s.slice(0, 8) : s;
  }
  // "1700" -> "Truck 1700", but "Dodge Shop Truck" stays as is
  function displayName(kind, name) {
    var n = String(name || '').trim();
    return /^\d/.test(n) ? (kind === 'truck' ? 'Truck ' : 'Trailer ') + n : n;
  }
  function fmtMi(mi) { return mi < 10 ? mi.toFixed(1) : String(Math.round(mi)); }
  function fmtEta(min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' hr' + (m ? ' ' + m + ' min' : '');
  }
  function fmtStop(min) { return min < 60 ? min + ' min' : Math.floor(min / 60) + ' hr ' + (min % 60) + ' min'; }
  // ---- fuel ----
  var FUEL_ICON = '<svg class="fuel-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9v18H5zM7 5v5h5V5zM15 8l3 3v7a1.5 1.5 0 0 0 3 0v-8l-3-3-1 1 2 2v2h-1z"/></svg>';
  function fuelLevel(pct) {
    if (pct == null) return '';
    return pct < (CFG.FUEL_CRITICAL_PCT || 15) ? 'crit' : pct < (CFG.FUEL_LOW_PCT || 25) ? 'low' : 'ok';
  }
  function isLowFuel(t) { return t.fuel != null && t.fuel < (CFG.FUEL_LOW_PCT || 25) && !isInactiveTruck(t); }
  function fuelRow(t) {
    if (t.fuel == null && t.mpg7 == null) return '';
    var lv = fuelLevel(t.fuel);
    var h = '<div class="fuel">';
    if (t.fuel != null) {
      h += '<span class="fuel-pct ' + lv + '">' + FUEL_ICON + t.fuel + '%</span>' +
        '<span class="fuel-bar" aria-hidden="true"><span class="' + lv + '" style="width:' + Math.max(3, Math.min(100, t.fuel)) + '%"></span></span>';
    }
    if (t.mpg7 != null) h += '<span class="mpg">' + t.mpg7.toFixed(1) + ' mpg, last 7 days</span>';
    return h + '</div>';
  }
  function speedClass(mph) { return mph >= 70 ? 'hi' : mph >= 60 ? 'mid' : ''; }

  var ICON_TRUCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6h11v9H2zM13 9h4l3 3.5V15h-7zM6 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zm11 0a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>';
  var ICON_TRAILER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 6h17v9H2zM19 12h3v1.5h-3zM6 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zm5 0a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z"/></svg>';

  // ---------------- API ----------------
  function api(action, extra, pinOverride) {
    var body = Object.assign({ action: action }, extra || {});
    return fetch(CFG.FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fleet-pin': pinOverride || S.pin },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Bad response (' + r.status + ')' }; })
        .then(function (j) { j._status = r.status; return j; });
    });
  }

  // ---------------- sign in ----------------
  function showLogin(msg) {
    $('app').hidden = true;
    $('login').hidden = false;
    $('loginName').value = S.user || '';
    $('loginErr').textContent = msg || '';
    setTimeout(function () { (S.user ? $('loginPin') : $('loginName')).focus(); }, 50);
  }

  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('loginName').value.trim();
    var pin = $('loginPin').value.trim();
    if (!name || !pin) return;
    var btn = $('loginBtn');
    btn.disabled = true; btn.textContent = 'Checking';
    $('loginErr').textContent = '';
    api('ping', null, pin).then(function (j) {
      if (j.ok) {
        S.pin = pin; S.user = name;
        store('fv_pin', pin); store('fv_user', name);
        $('loginPin').value = '';
        startApp();
      } else {
        $('loginErr').textContent = j._status === 401 ? 'That PIN did not work.' : (j.error || 'Could not sign in.');
      }
    }).catch(function () {
      $('loginErr').textContent = 'No connection. Check signal and try again.';
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Sign in';
    });
  });

  // ---------------- menu ----------------
  function closeMenu() { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false'); }
  $('menuBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = $('menu').hidden;
    $('menuWho').textContent = 'Signed in as ' + (S.user || '');
    $('menu').hidden = !open;
    $('menuBtn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.menu')) closeMenu(); });
  $('menu').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.getAttribute('data-menu') === 'refresh') refresh(true);
    if (b.getAttribute('data-menu') === 'signout') {
      if (!confirm('Sign out of Fleet View on this device?')) return;
      S.pin = ''; store('fv_pin', null);
      showLogin('');
    }
  });

  // ---------------- start ----------------
  var timers = { refresh: null, tick: null };

  function startApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    initMap();
    refresh();
    clearInterval(timers.refresh); clearInterval(timers.tick);
    timers.refresh = setInterval(function () {
      if (document.visibilityState === 'visible') refresh();
    }, (CFG.REFRESH_SECONDS || 30) * 1000);
    timers.tick = setInterval(updateClock, 1000);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.pin && Date.now() - S.lastOk > 15000) refresh();
  });

  // ---------------- toast ----------------
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(function () { t.hidden = true; }, ms);
  }
  function hideToast() { $('toast').hidden = true; }

  // ---------------- data ----------------
  function refresh(manual) {
    if (S.loading) return;
    S.loading = true;
    if (manual) $('updated').textContent = 'Refreshing';
    api('live').then(function (j) {
      if (j._status === 401) { S.pin = ''; store('fv_pin', null); showLogin('The PIN changed. Sign in again.'); return; }
      if (!j.ok) { toast('Fleet data did not load: ' + (j.error || 'unknown error') + '. Showing the last good data.'); return; }
      S.data = j;
      S.lastOk = Date.now();
      hideToast();
      fillSitePicker();
      render();
    }).catch(function () {
      toast('No connection. Showing the last good data until signal returns.');
    }).then(function () {
      S.loading = false;
      updateClock();
    });
  }

  function updateClock() {
    var el = $('updated');
    if (!S.lastOk) { if (!S.loading) el.textContent = 'Not loaded'; return; }
    var s = Math.round((Date.now() - S.lastOk) / 1000);
    el.textContent = 'Updated ' + (s < 5 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago');
    el.classList.toggle('stale', s > 120);
    var pt = $('peekTime');
    if (pt) pt.textContent = s < 5 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago';
  }

  function fillSitePicker() {
    var sel = $('sitePick');
    var sites = (S.data.sites || []).filter(function (s) { return s.center; });
    sites.sort(function (a, b) { return (b.isHome ? 1 : 0) - (a.isHome ? 1 : 0); });
    var names = sites.map(function (s) { return s.name; });
    if (!S.siteName || names.indexOf(S.siteName) === -1) {
      S.siteName = names[0] || '';
      store('fv_site', S.siteName);
    }
    var html = sites.map(function (s) {
      return '<option value="' + esc(s.name) + '"' + (s.name === S.siteName ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
  }

  function currentSite() {
    if (!S.data) return null;
    for (var i = 0; i < S.data.sites.length; i++) if (S.data.sites[i].name === S.siteName) return S.data.sites[i];
    return null;
  }

  $('sitePick').addEventListener('change', function (e) {
    S.siteName = e.target.value;
    store('fv_site', S.siteName);
    render();
    centerOnSite();
  });

  // ---------------- filters ----------------
  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
    c.addEventListener('click', function () {
      var f = c.getAttribute('data-filter');
      S.filters[f] = !S.filters[f];
      c.classList.toggle('on', S.filters[f]);
      render();
    });
  });
  // ---------------- search: Google-style suggestions, pick one to focus ----------------
  var searchTimer = null, sgItems = [], sgActive = -1;
  $('search').addEventListener('input', function (e) {
    if (S.focusKey) exitFocus(true);
    $('clearBtn').hidden = !e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      S.filters.q = e.target.value.trim().toLowerCase();
      render();
      showSuggest();
    }, 120);
  });
  $('search').addEventListener('focus', function () { if (!S.focusKey && $('search').value) showSuggest(); });
  $('search').addEventListener('blur', function () { setTimeout(hideSuggest, 150); });
  $('search').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!sgItems.length) return;
      e.preventDefault();
      sgActive = (sgActive + (e.key === 'ArrowDown' ? 1 : -1) + sgItems.length) % sgItems.length;
      Array.prototype.forEach.call($('suggest').querySelectorAll('.sg-item'), function (b, i) { b.classList.toggle('active', i === sgActive); });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var pick = sgItems[sgActive >= 0 ? sgActive : 0];
      if (pick) { focusOn(pick.key); $('search').blur(); }
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });
  $('clearBtn').addEventListener('click', function () {
    $('search').value = ''; $('clearBtn').hidden = true;
    S.filters.q = '';
    if (S.focusKey) exitFocus(); else render();
    hideSuggest();
  });
  $('suggest').addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the input focused
  $('suggest').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sg]');
    if (b) { focusOn(b.getAttribute('data-sg')); $('search').blur(); }
  });

  function matchItems(q) {
    if (!S.data || !q) return [];
    var out = [], tById = trucksById();
    function score(name, driver) {
      var n = String(name || '').toLowerCase(), d = String(driver || '').toLowerCase();
      if (n === q || n.split(/\s+/)[0] === q) return 0;
      if (n.indexOf(q) === 0 || d.indexOf(q) === 0) return 1;
      if (d.split(/\s+/).some(function (w) { return w.indexOf(q) === 0; })) return 2;
      if (n.indexOf(q) !== -1 || d.indexOf(q) !== -1) return 3;
      return -1;
    }
    S.data.trucks.forEach(function (t) {
      var s = score(t.name, t.driver);
      if (s >= 0) out.push({ key: 't:' + t.id, kind: 'truck', s: s + (isInactiveTruck(t) ? 5 : 0), name: t.name,
        label: displayName('truck', t.name), sub: [t.driver || 'No driver assigned', describe(t, currentSite(), 'truck').label].join(', ') });
    });
    S.data.trailers.forEach(function (r) {
      var tk = r.pairedTruckId ? tById[r.pairedTruckId] : null;
      var s = score(r.name, tk ? tk.driver : '');
      if (s >= 0) out.push({ key: 'r:' + r.id, kind: 'trailer', s: s + 1 + (isDead(r) ? 5 : 0), name: r.name,
        label: displayName('trailer', r.name), sub: [r.load ? (r.load.status === 'empty' ? 'Empty' : 'Loaded') : 'Status not set', r.site ? 'at ' + r.site : (tk ? 'with ' + displayName('truck', tk.name) : '')].filter(Boolean).join(', ') });
    });
    out.sort(function (a, b) { return a.s - b.s || a.name.localeCompare(b.name, undefined, { numeric: true }); });
    return out.slice(0, 8);
  }
  function showSuggest() {
    var q = $('search').value.trim().toLowerCase();
    var box = $('suggest');
    sgItems = matchItems(q); sgActive = -1;
    if (!q || S.focusKey || document.activeElement !== $('search')) { hideSuggest(); return; }
    box.innerHTML = sgItems.length ? sgItems.map(function (it) {
      return '<button type="button" class="sg-item" role="option" data-sg="' + esc(it.key) + '">' +
        '<span class="kind-ic ' + it.kind + '">' + (it.kind === 'truck' ? ICON_TRUCK : ICON_TRAILER) + '</span>' +
        '<span class="sg-main"><span class="sg-name">' + esc(it.label) + '</span><br><span class="sg-sub">' + esc(it.sub) + '</span></span></button>';
    }).join('') : '<div class="sg-empty">No truck, trailer or driver matches "' + esc(q) + '".</div>';
    box.hidden = false;
    $('search').setAttribute('aria-expanded', 'true');
  }
  function hideSuggest() { $('suggest').hidden = true; $('search').setAttribute('aria-expanded', 'false'); }

  // ---------------- classify ----------------
  function staleLimit(kind) {
    return kind === 'trailer' ? (CFG.TRAILER_STALE_MINUTES || 1440) : (CFG.TRUCK_STALE_MINUTES || 120);
  }
  function isDead(r) {
    var age = ageMin(r.time);
    return age != null && age > (CFG.DEAD_GPS_DAYS || 30) * 1440;
  }
  // A truck is inactive if it hasn't reported GPS, or its engine has been off, for 60+ days.
  function isInactiveTruck(t) {
    var limit = (CFG.TRUCK_INACTIVE_DAYS || 60) * 1440;
    var gps = ageMin(t.time);
    if (gps != null && gps > limit) return true;
    return t.engine === 'Off' && t.engineSince != null && ageMin(t.engineSince) > limit;
  }
  function inactiveSince(t) {
    var a = t.time ? Date.parse(t.time) : Infinity;
    var b = t.engine === 'Off' && t.engineSince ? Date.parse(t.engineSince) : Infinity;
    var d = new Date(Math.min(a, b));
    return isNaN(d) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // "Fri 5:42 PM" within the last week, otherwise "Oct 3"
  function sinceText(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var days = (Date.now() - d) / 86400000;
    return days < 6 ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // Where an asset is relative to your site, in plain words.
  function describe(a, site, kind) {
    var age = ageMin(a.time);
    var out = { dist: null, eta: null, group: 'other', label: '', cls: '', mph: null };
    var stale = age != null && age > staleLimit(kind);
    var moving = a.speed > MOVING_MPH && !stale;

    if (site && a.site === site.name) {
      out.group = 'here'; out.cls = 'here'; out.dist = 0;
      out.label = 'At ' + site.name;
    } else {
      if (site && site.center) out.dist = milesBetween(a.lat, a.lng, site.center.latitude, site.center.longitude);
      var coming = moving && out.dist != null &&
        headingDiff(a.heading, bearing(a.lat, a.lng, site.center.latitude, site.center.longitude)) <= APPROACH_DEG;
      if (coming && out.dist <= ETA_MAX_MI) {
        var mph = out.dist < 3 ? 25 : Math.min(Math.max(a.speed, 35), 60);
        out.eta = Math.max(1, Math.round(out.dist * ROAD_FACTOR / mph * 60));
        out.group = 'coming'; out.cls = 'coming';
        out.label = 'Headed your way'; out.mph = a.speed;
      } else if (a.site) {
        out.label = 'At ' + a.site;
      } else if (moving) {
        out.label = 'Driving, not toward you'; out.mph = a.speed;
      } else {
        out.label = (kind === 'truck' && a.engine === 'Off' && a.engineSince) ? 'Parked since ' + sinceText(a.engineSince) : 'Parked';
      }
    }
    if (stale) { out.cls = 'stale'; out.mph = null; out.label = 'Last GPS ' + agoText(age); }
    if (kind === 'truck' && a.engine !== undefined && isInactiveTruck(a)) {
      out.cls = 'stale'; out.mph = null; out.eta = null; out.group = 'other';
      out.label = 'Inactive since ' + inactiveSince(a);
    }
    return out;
  }

  // ---------------- render ----------------
  function render() {
    if (!S.data) return;
    var deadN = S.data.trailers.filter(isDead).length + S.data.trucks.filter(isInactiveTruck).length;
    var chip = document.querySelector('.chip[data-filter="dead"]');
    chip.textContent = 'Inactive (' + deadN + ')';
    chip.hidden = deadN === 0;
    var lowN = S.data.trucks.filter(isLowFuel).length;
    var lchip = document.querySelector('.chip[data-filter="lowfuel"]');
    lchip.textContent = 'Low fuel (' + lowN + ')';
    lchip.hidden = lowN === 0 && !S.filters.lowfuel;
    renderList();
    renderMap();
    renderFocus();
  }

  function trucksById() {
    var m = {};
    S.data.trucks.forEach(function (t) { m[t.id] = t; });
    return m;
  }
  function trailersByTruck() {
    var m = {};
    S.data.trailers.forEach(function (r) {
      if (r.pairedTruckId) (m[r.pairedTruckId] = m[r.pairedTruckId] || []).push(r);
    });
    return m;
  }
  function matchesSearch(a, extra) {
    var q = S.filters.q;
    if (!q) return true;
    var hay = [a.name, a.driver, a.address, a.site].concat(extra || []).join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function visibleTrucks(pulls) {
    if (!S.filters.trucks) return [];
    return S.data.trucks.filter(function (t) {
      if (!S.filters.dead && isInactiveTruck(t)) return false;
      if (S.filters.lowfuel && !isLowFuel(t)) return false;
      var trs = pulls[t.id] || [];
      if (S.filters.empty && !trs.some(function (r) { return r.load && r.load.status === 'empty'; })) return false;
      return matchesSearch(t, trs.map(function (r) { return r.name; }));
    });
  }
  function visibleTrailers(tById) {
    if (!S.filters.trailers || S.filters.lowfuel) return [];
    return S.data.trailers.filter(function (r) {
      if (!S.filters.dead && isDead(r)) return false;
      if (S.filters.empty && !(r.load && r.load.status === 'empty')) return false;
      var tk = r.pairedTruckId ? tById[r.pairedTruckId] : null;
      return matchesSearch(r, tk ? [tk.name, tk.driver] : []);
    });
  }

  function loadBadge(load) {
    if (!load) return '<span class="badge unknown">Status not set</span>';
    return '<span class="badge ' + load.status + '">' + (load.status === 'empty' ? 'Empty' : 'Loaded') + '</span>';
  }

  function renderList() {
    var site = currentSite();
    var tById = trucksById();
    var pulls = trailersByTruck();
    var items = [];

    visibleTrucks(pulls).forEach(function (t) {
      items.push({ kind: 'truck', a: t, d: describe(t, site, 'truck'), trailers: pulls[t.id] || [] });
    });
    visibleTrailers(tById).forEach(function (r) {
      var tk = r.pairedTruckId ? tById[r.pairedTruckId] : null;
      // A trailer being pulled moves with its truck: use the truck's fresher position.
      var basis = tk ? Object.assign({}, r, { lat: tk.lat, lng: tk.lng, speed: tk.speed, heading: tk.heading, time: tk.time, site: tk.site || r.site }) : r;
      items.push({ kind: 'trailer', a: r, d: describe(basis, site, tk ? 'truck' : 'trailer'), truck: tk });
    });

    var byName = function (x, y) { return x.a.name.localeCompare(y.a.name, undefined, { numeric: true }); };
    var coming = items.filter(function (i) { return i.d.group === 'coming'; })
      .sort(function (x, y) { return x.d.eta - y.d.eta; });
    var here = items.filter(function (i) { return i.d.group === 'here'; })
      .sort(function (x, y) { return x.kind === y.kind ? byName(x, y) : x.kind === 'truck' ? -1 : 1; });
    var other = items.filter(function (i) { return i.d.group === 'other'; })
      .sort(function (x, y) { return (x.d.dist == null || y.d.dist == null) ? byName(x, y) : x.d.dist - y.d.dist; });

    var name = site ? site.name : 'your site';
    var comingTrucks = coming.filter(function (i) { return i.kind === 'truck'; }).length;
    var hereTrucks = here.filter(function (i) { return i.kind === 'truck'; }).length;
    var lowN = S.data.trucks.filter(isLowFuel).length;
    var bits = [];
    bits.push(comingTrucks ? '<span class="ps-coming">' + comingTrucks + ' headed to ' + esc(name) + '</span>'
                           : 'None headed to ' + esc(name));
    if (hereTrucks) bits.push(hereTrucks + ' here');
    if (lowN) bits.push('<span class="ps-low">' + lowN + ' low fuel</span>');
    $('peekSummary').innerHTML = '<span class="ps-main">' + bits.join(' · ') + '</span><span class="ps-time" id="peekTime"></span>';
    updateClock();
    $('list').innerHTML =
      section('Headed to ' + name, coming, 'Nothing is headed your way right now.') +
      section('At ' + name, here, 'Nothing is on site.') +
      section('Everything else, nearest first', other, items.length ? 'Nothing else.' : 'No matches. Try a different search or turn a filter back on.');
  }

  function section(title, list, emptyMsg) {
    var h = '<div class="section-h"><span>' + esc(title) + '</span><span class="count">' + list.length + '</span></div>';
    if (!list.length) return h + '<div class="empty-note">' + esc(emptyMsg) + '</div>';
    return h + list.map(row).join('');
  }

  function row(i) {
    var a = i.a, d = i.d;
    var key = (i.kind === 'truck' ? 't:' : 'r:') + a.id;
    var right = '';
    if (d.eta != null) right = '<div class="row-eta"><b>' + esc(fmtEta(d.eta)) + '</b><small>' + fmtMi(d.dist) + ' mi</small></div>';
    else if (d.dist != null && d.dist > 0) right = '<div class="row-eta plain"><b>' + fmtMi(d.dist) + ' mi</b><small>away</small></div>';

    var h = '<div class="row" data-key="' + esc(key) + '">';
    h += '<div class="row-top"><span class="kind-ic ' + i.kind + '">' + (i.kind === 'truck' ? ICON_TRUCK : ICON_TRAILER) + '</span>';
    h += '<div class="row-main"><div class="row-name">' + esc(displayName(i.kind, a.name)) + '</div>';
    if (i.kind === 'truck') {
      h += a.driver ? '<div class="row-sub">' + esc(a.driver) + '</div>' : '<div class="row-sub none">No driver assigned</div>';
    } else {
      h += '<div class="row-sub">' + loadBadge(a.load) + '</div>';
    }
    h += '</div>' + right + '</div>';

    h += '<div class="status ' + d.cls + '">' + esc(d.label) +
      (d.mph != null ? ', <span class="spd ' + speedClass(d.mph) + '">' + Math.round(d.mph) + ' mph</span>' : '') + '</div>';

    if (i.kind === 'truck') h += fuelRow(a);
    if (i.kind === 'truck' && i.trailers.length) {
      h += '<div class="detail">Pulling ' + i.trailers.map(function (r) { return esc(r.name) + ' ' + loadBadge(r.load); }).join(', ') +
        ' <span class="likely">likely, from GPS</span></div>';
    }
    if (i.kind === 'trailer' && i.truck) {
      h += '<div class="detail">With ' + esc(displayName('truck', i.truck.name)) + (i.truck.driver ? ', ' + esc(i.truck.driver) : '') +
        ' <span class="likely">likely, from GPS</span></div>';
    }
    if (a.address && d.group !== 'here') h += '<div class="addr">' + esc(a.address) + '</div>';

    if (i.kind === 'trailer') {
      var st = S.pendingLoad[a.id] !== undefined ? S.pendingLoad[a.id] : (a.load ? a.load.status : null);
      var busy = S.pendingLoad[a.id] !== undefined ? ' disabled' : '';
      h += '<div class="actions">' +
        '<button class="act set-empty' + (st === 'empty' ? ' on' : '') + '" data-load="empty" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '"' + busy + ' type="button">Empty</button>' +
        '<button class="act set-loaded' + (st === 'loaded' ? ' on' : '') + '" data-load="loaded" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '"' + busy + ' type="button">Loaded</button>' +
        '</div>';
      if (a.load) h += '<div class="load-meta">Marked ' + esc(a.load.status) + (a.load.by ? ' by ' + esc(a.load.by) : '') + ', ' + esc(agoText(ageMin(a.load.at))) + '</div>';
    }
    return h + '</div>';
  }

  $('sheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-focus-close]')) { $('search').value = ''; $('clearBtn').hidden = true; S.filters.q = ''; exitFocus(); return; }
    if (e.target.closest('[data-follow]')) { S.follow = true; followFocused(true); renderFocus(); return; }
    var btn = e.target.closest('button');
    if (btn && btn.hasAttribute('data-load')) {
      var id = btn.getAttribute('data-id');
      var want = btn.getAttribute('data-load');
      var tr = S.data.trailers.filter(function (r) { return r.id === id; })[0];
      var cur = tr && tr.load ? tr.load.status : null;
      setLoad(id, btn.getAttribute('data-name'), cur === want ? 'clear' : want);
      return;
    }
    var r = e.target.closest('.row');
    if (r) focusOn(r.getAttribute('data-key'));
  });

  function setLoad(id, name, status) {
    S.pendingLoad[id] = status === 'clear' ? null : status;
    render();
    api('setLoad', { trailerId: id, trailerName: name, status: status, by: S.user }).then(function (j) {
      if (!j.ok) { toast('Not saved: ' + (j.error || 'unknown error'), 5000); return; }
      S.data.trailers.forEach(function (r) {
        if (r.id === id) r.load = status === 'clear' ? null : { status: status, by: S.user, at: new Date().toISOString() };
      });
    }).catch(function () {
      toast('No connection. The status was not saved.', 5000);
    }).then(function () {
      delete S.pendingLoad[id];
      render();
    });
  }

  // ---------------- pull-up sheet (phone) ----------------
  var sheetState = 'peek';
  function setSheet(state) {
    sheetState = state;
    var el = $('sheet');
    el.style.height = '';
    el.setAttribute('data-state', state);
  }
  (function sheetDrag() {
    var head = $('sheetHead'), el = $('sheet');
    var startY = 0, startH = 0, dragging = false, moved = false;
    head.addEventListener('pointerdown', function (e) {
      if (isDesktop() || e.target.closest('select, button, input')) return;
      dragging = true; moved = false;
      startY = e.clientY; startH = el.getBoundingClientRect().height;
      el.classList.add('dragging');
      if (head.setPointerCapture) head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = startY - e.clientY;
      if (Math.abs(dy) > 6) moved = true;
      var max = window.innerHeight - 80;
      el.style.height = Math.min(max, Math.max(PEEK_PX, startH + dy)) + 'px';
    });
    function end() {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (!moved) { if (sheetState !== 'focus') setSheet(sheetState === 'peek' ? 'half' : 'peek'); return; }
      if (sheetState === 'focus') { setSheet('focus'); return; }
      var h = el.getBoundingClientRect().height, vh = window.innerHeight;
      var snaps = [['peek', PEEK_PX], ['half', vh * 0.52], ['full', vh - 80]];
      var best = snaps.reduce(function (b, s) { return Math.abs(s[1] - h) < Math.abs(b[1] - h) ? s : b; });
      setSheet(best[0]);
    }
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  })();

  // Space the map should keep clear for the panel/sheet when centering.
  function mapPadding() {
    if (isDesktop()) return { top: 24, right: 72, bottom: 24, left: 408 + 36 };
    var sheetH = $('sheet').getBoundingClientRect().height;
    return { top: 80, right: 64, bottom: sheetH + 16, left: 20 };
  }

  // ---------------- map (Google Maps) ----------------
  // One map load per app open. The 30s refresh only moves existing
  // markers, which Google does not bill as new loads.
  var HtmlMarker = null;
  var mapsLoading = false;

  function mapNote(msg) {
    var n = document.createElement('div');
    n.className = 'toast'; n.style.top = 'auto'; n.style.bottom = (PEEK_PX + 20) + 'px';
    n.textContent = msg;
    $('app').appendChild(n);
  }

  function initMap() {
    if (S.map || mapsLoading) return;
    if (!CFG.GOOGLE_MAPS_KEY) { mapNote('Map not set up yet: no Google Maps key in config.js. The list still works.'); return; }
    mapsLoading = true;
    window.gm_authFailure = function () {
      mapNote('Google Maps rejected the key. Check its website restriction. The list still works.');
    };
    window.__fvMapsReady = function () { mapsLoading = false; createMap(); };
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(CFG.GOOGLE_MAPS_KEY) +
      '&v=weekly&loading=async&callback=__fvMapsReady';
    s.async = true;
    s.onerror = function () { mapsLoading = false; mapNote('The map could not load. Check signal. The list still works.'); };
    document.head.appendChild(s);
  }

  function defineHtmlMarker() {
    // A marker drawn with our own HTML so trucks and trailers keep their
    // labeled badges. Glides to new positions. No Google "Map ID" needed.
    function M(pos, html, z, onClick) {
      this.pos = pos; this.cur = pos; this.html = html; this.anim = null;
      this.div = document.createElement('div');
      this.div.style.position = 'absolute';
      this.div.style.zIndex = String(z);
      if (onClick) {
        this.div.style.cursor = 'pointer';
        var self = this;
        this.div.addEventListener('click', function (e) { e.stopPropagation(); onClick(self); });
      }
      this.div.innerHTML = html;
    }
    M.prototype = Object.create(google.maps.OverlayView.prototype);
    M.prototype.onAdd = function () { this.getPanes().overlayMouseTarget.appendChild(this.div); };
    M.prototype.draw = function () {
      var proj = this.getProjection();
      if (!proj) return;
      var p = proj.fromLatLngToDivPixel(this.cur || this.pos);
      if (!p) return;
      this.div.style.left = p.x + 'px';
      this.div.style.top = p.y + 'px';
    };
    M.prototype.onRemove = function () {
      if (this.anim) cancelAnimationFrame(this.anim);
      if (this.div.parentNode) this.div.parentNode.removeChild(this.div);
    };
    M.prototype.setHtml = function (html) {
      if (html !== this.html) { this.html = html; this.div.innerHTML = html; }
    };
    M.prototype.moveTo = function (pos) {
      var from = this.cur || this.pos;
      this.pos = pos;
      if (this.anim) { cancelAnimationFrame(this.anim); this.anim = null; }
      var dLat = pos.lat() - from.lat(), dLng = pos.lng() - from.lng();
      var jump = Math.abs(dLat) + Math.abs(dLng);
      // No glide for tiny wobble, huge jumps, hidden tabs, or reduced motion.
      if (jump < 1e-6 || jump > 0.3 || document.hidden || reduceMotion) { this.cur = pos; this.draw(); return; }
      var self = this, t0 = performance.now();
      function step(now) {
        var t = Math.min(1, (now - t0) / GLIDE_MS);
        var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        self.cur = new google.maps.LatLng(from.lat() + dLat * e, from.lng() + dLng * e);
        self.draw();
        self.anim = t < 1 ? requestAnimationFrame(step) : null;
      }
      this.anim = requestAnimationFrame(step);
    };
    HtmlMarker = M;
  }

  function createMap() {
    defineHtmlMarker();
    var desk = isDesktop();
    S.map = new google.maps.Map($('map'), {
      center: { lat: CFG.DEFAULT_CENTER[0], lng: CFG.DEFAULT_CENTER[1] },
      zoom: CFG.DEFAULT_ZOOM,
      disableDefaultUI: true,
      zoomControl: desk,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
      clickableIcons: false,
      gestureHandling: 'greedy',
      // Hide shops/restaurants/transit so trucks and trailers stand out.
      styles: [
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] }
      ]
    });
    S.info = new google.maps.InfoWindow({ pixelOffset: new google.maps.Size(0, -14) });
    S.info.addListener('closeclick', function () {
      if (S.infoKey === 'stop' || S.infoKey === 'group') { S.infoKey = null; return; }   // keep the route showing
      deselect();
    });
    S.map.addListener('click', function () { S.info.close(); if (!S.focusKey) deselect(); });
    S.map.addListener('dragstart', function () { if (S.focusKey && S.follow) { S.follow = false; renderFocus(); } });
    // an invisible overlay just to read screen positions for grouping
    S.proj = new google.maps.OverlayView();
    S.proj.onAdd = function () {}; S.proj.draw = function () {}; S.proj.onRemove = function () {};
    S.proj.setMap(S.map);
    S.map.addListener('idle', recluster);
    S.map.addListener('dragstart', hideHover);
    S.map.addListener('zoom_changed', hideHover);
    // while Street View is open, our search bar / panel / buttons step aside
    var sv = S.map.getStreetView();
    sv.addListener('visible_changed', function () { document.body.classList.toggle('sv-on', !!sv.getVisible()); });
    if (S.data) render();
  }

  // map buttons
  $('layerBtn').addEventListener('click', function () {
    if (!S.map) return;
    var sat = S.map.getMapTypeId() !== 'hybrid';
    S.map.setMapTypeId(sat ? 'hybrid' : 'roadmap');
    this.classList.toggle('on', sat);
    this.setAttribute('aria-label', sat ? 'Switch to map' : 'Switch to satellite');
    this.title = sat ? 'Map' : 'Satellite';
  });
  $('siteBtn').addEventListener('click', function () { centerOnSite(); });
  $('fitBtn').addEventListener('click', function () { fitAll(); });

  function focusAt(pos, minZoom) {
    if (!S.map) return;
    S.map.setCenter(pos);
    if (minZoom && S.map.getZoom() < minZoom) S.map.setZoom(minZoom);
    var p = mapPadding();
    // nudge so the point sits in the middle of the uncovered part of the map
    S.map.panBy(-(p.left - p.right) / 2, (p.bottom - p.top) / 2);
  }

  function centerOnSite() {
    var site = currentSite();
    if (S.map && site && site.center) focusAt(new google.maps.LatLng(site.center.latitude, site.center.longitude), 12);
  }

  function fitAll() {
    if (!S.map) return;
    var keys = Object.keys(S.markers);
    if (!keys.length) return;
    var b = new google.maps.LatLngBounds();
    keys.forEach(function (k) { b.extend(S.markers[k].pos); });
    S.map.fitBounds(b, mapPadding());
  }

  function drawSites() {
    if (S.sitesDrawn || !S.data || !S.map) return;
    var style = { strokeColor: '#7d1935', strokeOpacity: 0.8, strokeWeight: 2, fillColor: '#7d1935', fillOpacity: 0.07, clickable: false, map: S.map };
    S.data.sites.forEach(function (s) {
      (s.shapes || []).forEach(function (sh) {
        if (sh.type === 'polygon') {
          new google.maps.Polygon(Object.assign({
            paths: sh.vertices.map(function (v) { return { lat: v.latitude, lng: v.longitude }; })
          }, style));
        } else if (sh.type === 'circle') {
          new google.maps.Circle(Object.assign({
            center: { lat: sh.center.latitude, lng: sh.center.longitude }, radius: sh.radiusMeters
          }, style));
        }
      });
      if (s.center) {
        // label sits on the north edge of the outline, clear of parked trucks
        var top = s.center.latitude;
        (s.shapes || []).forEach(function (sh) {
          if (sh.type === 'polygon') sh.vertices.forEach(function (v) { top = Math.max(top, v.latitude); });
          else top = Math.max(top, sh.center.latitude + sh.radiusMeters / 111320);
        });
        var tag = new HtmlMarker(new google.maps.LatLng(top, s.center.longitude),
          '<div class="mk"><span class="site-tag">' + esc(s.name) + '</span></div>', 1, null);
        tag.setMap(S.map);
        S.siteTags[s.name] = tag;
      }
    });
    S.sitesDrawn = true;
  }

  function truckHtml(t, sel, tows) {
    var moving = t.speed > MOVING_MPH;
    var tow = (tows || []).map(function (r) {
      return '<span class="tow">' + (r.load ? '<span class="dot ' + r.load.status + '"></span>' : '') + esc(shortLabel(r.name)) + '</span>';
    }).join('');
    return '<div class="mk mk-truck' + (moving ? '' : ' idle') + (sel ? ' sel' : '') + '"><span class="mk-body">' +
      (moving ? '<span class="arw" style="transform:rotate(' + Math.round(t.heading) + 'deg)"></span>' : '') +
      esc(shortLabel(t.name)) +
      (moving ? '<span class="spd ' + speedClass(t.speed) + '">' + Math.round(t.speed) + '</span>' : '') +
      (isLowFuel(t) ? '<span class="mk-fuel ' + fuelLevel(t.fuel) + '">' + FUEL_ICON + t.fuel + '%</span>' : '') +
      tow + '</span></div>';
  }
  function trailerHtml(r, sel) {
    var age = ageMin(r.time);
    var old = age != null && age > staleLimit('trailer');
    var dot = r.load ? '<span class="dot ' + r.load.status + '"></span>' : '';
    return '<div class="mk mk-trailer' + (old ? ' old' : '') + (sel ? ' sel' : '') + '"><span class="mk-body">' + dot + esc(shortLabel(r.name)) + '</span></div>';
  }

  function truckPopup(t, pulls) {
    var ti = S.trailInfo[t.id];
    var route = '';
    if (S.trail && S.trail.id === t.id) {
      if (!ti) route = '<div class="pop-route loading">Loading the last ' + TRAIL_HOURS + ' hours</div>';
      else if (ti.err) route = '<div class="pop-route loading">Route did not load: ' + esc(ti.err) + '</div>';
      else route = '<div class="pop-route">Last ' + TRAIL_HOURS + ' hours: ' + fmtMi(ti.miles) + ' mi, ' +
        ti.stops + (ti.stops === 1 ? ' stop' : ' stops') + '<button type="button" data-hide-route>Hide route</button></div>';
    } else {
      route = '<div class="pop-route"><button type="button" data-show-route="' + esc(t.id) + '" style="margin:0;color:var(--route);text-decoration:none;font-weight:500">Show the last ' + TRAIL_HOURS + ' hours</button></div>';
    }
    return '<div class="pop"><div class="pop-name">' + esc(displayName('truck', t.name)) + '</div>' +
      '<div class="pop-sub">' + esc(t.driver || 'No driver assigned') + '</div>' +
      '<div class="pop-sub">' + (isInactiveTruck(t) ? 'Inactive since ' + esc(inactiveSince(t))
          : t.speed > MOVING_MPH ? Math.round(t.speed) + ' mph'
          : (t.engine === 'Off' && t.engineSince ? 'Parked since ' + esc(sinceText(t.engineSince)) : 'Parked')) +
        (t.site ? ', at ' + esc(t.site) : '') + '</div>' +
      (pulls && pulls.length ? '<div class="pop-sub">Likely pulling ' + pulls.map(function (r) { return esc(r.name) + (r.load ? ' (' + r.load.status + ')' : ''); }).join(', ') + '</div>' : '') +
      fuelRow(t) +
      '<div class="pop-meta">' + esc(t.address || '') + (t.address ? '<br>' : '') + 'GPS ' + esc(agoText(ageMin(t.time))) + '</div>' +
      svButton(t.lat, t.lng) + route + '</div>';
  }
  function trailerPopup(r, tk) {
    return '<div class="pop"><div class="pop-name">' + esc(displayName('trailer', r.name)) + '</div>' +
      '<div class="pop-sub">' + (r.load ? (r.load.status === 'empty' ? 'Empty' : 'Loaded') : 'Status not set') + (r.site ? ', at ' + esc(r.site) : '') + '</div>' +
      (tk ? '<div class="pop-sub">Likely with ' + esc(displayName('truck', tk.name)) + (tk.driver ? ', ' + esc(tk.driver) : '') + '</div>' : '') +
      '<div class="pop-meta">' + esc(r.address || '') + (r.address ? '<br>' : '') + 'GPS ' + esc(agoText(ageMin(r.time))) + '</div>' +
      svButton(r.lat, r.lng) + '</div>';
  }

  // ---------------- Street View ----------------
  // Google bills each opened view (5,000 free a month), so it only loads on tap.
  function svButton(lat, lng) {
    return '<button type="button" class="sv-btn" data-sv="' + lat + ',' + lng + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2.5"/><path d="M9 9h6l-1 7h-1.2l-.8 5h-1l-.8-5H9z"/></svg>Street View</button>';
  }
  function openStreetView(lat, lng) {
    if (!S.map || !google.maps.StreetViewService) return;
    var target = new google.maps.LatLng(lat, lng);
    new google.maps.StreetViewService().getPanorama(
      { location: target, radius: 150, source: google.maps.StreetViewSource ? google.maps.StreetViewSource.OUTDOOR : undefined },
      function (data, status) {
        if (status !== 'OK' || !data || !data.location) { toast('No Street View photos near this spot.', 4000); return; }
        var from = data.location.latLng;
        var pano = S.map.getStreetView();
        pano.setOptions({ addressControl: true, enableCloseButton: true, fullscreenControl: false, motionTracking: false, motionTrackingControl: false });
        pano.setPano(data.location.pano);
        // look from the photo spot toward the truck/trailer
        pano.setPov({ heading: bearing(from.lat(), from.lng(), lat, lng), pitch: 0 });
        pano.setVisible(true);
        S.info.close();
      });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-sv]');
    if (!b) return;
    var p = b.getAttribute('data-sv').split(',');
    openStreetView(Number(p[0]), Number(p[1]));
  });

  function select(key) {
    var prev = S.selKey;
    S.selKey = key;
    [prev, key].forEach(function (k) {
      var m = k && S.markers[k];
      if (m) m.setHtml(m.htmlFn());
    });
    recluster();
  }
  function deselect() {
    S.infoKey = null;
    if (S.focusKey) return;            // focus mode keeps its truck selected and its route drawn
    select(null);
    clearTrail();
  }

  function openPopup(key) {
    var m = S.markers[key];
    if (!m || !S.info) return;
    if (S.trail && S.trail.id !== key.slice(2)) clearTrail();
    S.infoKey = key;
    select(key);
    S.info.setContent(m.popupFn());
    S.info.setPosition(m.pos);
    S.info.open({ map: S.map });
    if (key.indexOf('t:') === 0) showTrail(key.slice(2));
  }
  function refreshPopup() {
    var m = S.infoKey && S.markers[S.infoKey];
    if (m && S.info) S.info.setContent(m.popupFn());
    if (S.focusKey) renderFocus();
  }

  // popup buttons (InfoWindow content lives outside our containers)
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-hide-route], [data-show-route]');
    if (!b) return;
    if (b.hasAttribute('data-hide-route')) { clearTrail(); refreshPopup(); if (S.focusKey) renderFocus(); }
    else showTrail(b.getAttribute('data-show-route'));
  });

  function renderMap() {
    if (!S.map || !HtmlMarker) return;
    drawSites();
    var seen = {};
    var tById = trucksById();
    var pulls = trailersByTruck();

    function upsert(key, lat, lng, htmlFn, popupFn, z, meta) {
      seen[key] = true;
      var pos = new google.maps.LatLng(lat, lng);
      var m = S.markers[key];
      if (!m) {
        m = new HtmlMarker(pos, '', z, function () { hideHover(); if (S.focusKey) focusOn(key); else openPopup(key); });
        attachHover(m);
        m.htmlFn = htmlFn; m.setHtml(htmlFn());
        m.setMap(S.map);
        S.markers[key] = m;
      } else {
        m.htmlFn = htmlFn; m.setHtml(htmlFn());
        m.moveTo(pos);
      }
      m.popupFn = popupFn;
      m.meta = meta || {};
      if (S.infoKey === key) { S.info.setContent(popupFn()); S.info.setPosition(pos); }
    }

    var truckShown = {};
    visibleTrucks(pulls).forEach(function (t) { truckShown[t.id] = true; });
    visibleTrailers(tById).forEach(function (r) {
      var key = 'r:' + r.id, tk = r.pairedTruckId ? tById[r.pairedTruckId] : null;
      if (tk && truckShown[tk.id]) return;   // rides inside its truck's badge instead
      upsert(key, r.lat, r.lng,
        function () { return trailerHtml(r, S.selKey === key); },
        function () { return trailerPopup(r, tk); }, 10,
        { moving: r.speed > MOVING_MPH, site: r.site, addr: r.address, name: r.name,
          label: displayName('trailer', r.name), sub: r.load ? (r.load.status === 'empty' ? 'Empty' : 'Loaded') : 'Status not set',
          extra: tk ? 'With ' + displayName('truck', tk.name) + (tk.driver ? ', ' + tk.driver : '') : '' });
    });
    visibleTrucks(pulls).forEach(function (t) {
      var key = 't:' + t.id, trs = pulls[t.id] || [];
      upsert(key, t.lat, t.lng,
        function () { return truckHtml(t, S.selKey === key, trs); },
        function () { return truckPopup(t, trs); }, 20,
        { moving: t.speed > MOVING_MPH, site: t.site, addr: t.address, name: t.name,
          label: displayName('truck', t.name), sub: t.driver || 'No driver assigned',
          extra: [t.speed > MOVING_MPH ? Math.round(t.speed) + ' mph' : 'Parked', t.fuel != null ? 'Fuel ' + t.fuel + '%' : ''].filter(Boolean).join(', '),
          fuelLv: fuelLevel(t.fuel) });
      // keep the drawn route connected to the truck as it moves
      if (S.trail && S.trail.id === t.id && S.trail.line) {
        S.trail.line.forEach(function (pl) { pl.getPath().push(new google.maps.LatLng(t.lat, t.lng)); });
      }
    });

    Object.keys(S.markers).forEach(function (k) {
      if (!seen[k]) {
        S.markers[k].setMap(null);
        delete S.markers[k];
        if (S.infoKey === k) { S.info.close(); deselect(); }
      }
    });

    if (!S.centeredOnce && !S.focusKey) { S.centeredOnce = true; centerOnSite(); }
    var fk = focusMarkerKey();
    Object.keys(S.markers).forEach(function (k) { S.markers[k].div.classList.toggle('fv-dim', !!fk && k !== fk); });
    recluster();
    if (S.focusKey && S.follow) followFocused(false);
  }

  // Tapping a bubble for one crowded lot lists what's there; tap a name to fly to it.
  function showGroupList(label, keys, pos) {
    var rows = keys.map(function (k) { return { k: k, m: S.markers[k] }; }).filter(function (x) { return x.m; });
    rows.sort(function (a, b) {
      if (a.k.charAt(0) !== b.k.charAt(0)) return a.k.charAt(0) === 't' ? -1 : 1;
      return (a.m.meta.name || '').localeCompare(b.m.meta.name || '', undefined, { numeric: true });
    });
    var html = '<div class="pop"><div class="pop-name">' + esc(label) + '</div>' +
      '<div class="pop-sub">' + rows.length + ' here. Tap one to see it.</div><div class="group-list">' +
      rows.slice(0, 40).map(function (x) {
        return '<button type="button" class="group-item" data-goto-key="' + esc(x.k) + '">' +
          '<span class="gi-name">' + esc(x.m.meta.label || '') + '</span>' +
          '<span class="gi-sub">' + esc(x.m.meta.sub || '') + '</span></button>';
      }).join('') + '</div></div>';
    S.infoKey = 'group';
    S.info.setContent(html);
    S.info.setPosition(pos);
    S.info.open({ map: S.map });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto-key]');
    if (b) { if (S.info) S.info.close(); focusOn(b.getAttribute('data-goto-key')); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && S.focusKey && document.activeElement !== $('search')) { $('search').value = ''; $('clearBtn').hidden = true; exitFocus(); }
  });

  // ---------------- hover label (mouse only) ----------------
  // Pointing at a truck shows its driver without clicking. Phones skip this; tap opens the full popup.
  var canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var hoverEl = null;
  function attachHover(m) {
    if (!canHover) return;
    m.div.addEventListener('mouseenter', function () { showHover(m); });
    m.div.addEventListener('mouseleave', hideHover);
  }
  function showHover(m) {
    if (!m.meta || !m.meta.label) return;
    var body = m.div.querySelector('.mk-body');
    if (!body) return;
    if (!hoverEl) {
      hoverEl = document.createElement('div');
      hoverEl.className = 'hover-card';
      hoverEl.setAttribute('role', 'tooltip');
      $('app').appendChild(hoverEl);
    }
    var none = /^No driver/.test(m.meta.sub || '');
    hoverEl.innerHTML = '<div class="hc-name">' + esc(m.meta.label) + '</div>' +
      '<div class="hc-sub' + (none ? ' none' : '') + '">' + esc(m.meta.sub || '') + '</div>' +
      (m.meta.extra ? '<div class="hc-extra' + (m.meta.fuelLv === 'low' || m.meta.fuelLv === 'crit' ? ' ' + m.meta.fuelLv : '') + '">' + esc(m.meta.extra) + '</div>' : '');
    var r = body.getBoundingClientRect(), app = $('app').getBoundingClientRect();
    hoverEl.style.left = (r.left + r.width / 2 - app.left) + 'px';
    hoverEl.style.top = (r.top - app.top - 8) + 'px';
    hoverEl.hidden = false;
  }
  function hideHover() { if (hoverEl) hoverEl.hidden = true; }

  // ---------------- grouping crowded spots ----------------
  // Zoomed out, parked trucks/trailers sitting close together on screen
  // become one bubble ("Truck Yard: 9 trucks, 7 trailers"). Moving trucks
  // and the selected marker always stay visible. Tap a bubble to zoom in.
  function recluster() {
    if (!S.map || !S.proj) return;
    var proj = S.proj.getProjection();
    if (!proj) return;
    S.clusters.forEach(function (b) { b.setMap(null); });
    S.clusters = [];
    var keys = Object.keys(S.markers);
    keys.forEach(function (k) { S.markers[k].div.style.display = ''; });
    var showTags = S.map.getZoom() >= SITE_TAGS_FROM_ZOOM;
    Object.keys(S.siteTags).forEach(function (n) { S.siteTags[n].div.style.display = showTags ? '' : 'none'; });
    if (S.map.getZoom() >= CLUSTER_BELOW_ZOOM) return;

    var groups = [];
    keys.forEach(function (k) {
      var m = S.markers[k];
      if (k === S.selKey || (m.meta && m.meta.moving)) return;
      var p = proj.fromLatLngToDivPixel(m.pos);
      if (!p) return;
      for (var i = 0; i < groups.length; i++) {
        if (Math.abs(groups[i].x - p.x) <= CLUSTER_PX && Math.abs(groups[i].y - p.y) <= CLUSTER_PX) { groups[i].keys.push(k); return; }
      }
      groups.push({ x: p.x, y: p.y, keys: [k] });
    });

    groups.forEach(function (g) {
      if (g.keys.length < CLUSTER_MIN) return;
      var trucks = 0, trailers = 0, lat = 0, lng = 0, bySite = {}, addr = '';
      var n = g.keys.length, minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      g.keys.forEach(function (k) {
        var m = S.markers[k], la = m.pos.lat(), ln = m.pos.lng();
        m.div.style.display = 'none';
        if (k.charAt(0) === 't') trucks++; else trailers++;
        lat += la; lng += ln;
        minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
        minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln);
        if (m.meta.site) bySite[m.meta.site] = (bySite[m.meta.site] || 0) + 1;
        if (!addr && m.meta.addr) addr = m.meta.addr;
      });
      // name the sites inside (up to two), else the street they're parked on
      var sites = Object.keys(bySite).sort(function (a, b) { return bySite[b] - bySite[a]; });
      var label = sites.length ? sites.slice(0, 2).join(' and ') + (sites.length > 2 ? ' area' : '')
        : (addr ? addr.split(',')[0] : 'Parked together');
      sites.forEach(function (sn) { if (S.siteTags[sn]) S.siteTags[sn].div.style.display = 'none'; });
      var parts = [];
      if (trucks) parts.push(trucks + (trucks === 1 ? ' truck' : ' trucks'));
      if (trailers) parts.push(trailers + (trailers === 1 ? ' trailer' : ' trailers'));
      var html = '<div class="mk"><span class="cluster" role="button" aria-label="' + esc(label + ', ' + parts.join(', ') + '. Tap to zoom in') + '">' +
        '<b>' + n + '</b><span class="cl-text"><span class="cl-name">' + esc(label) + '</span><small>' + esc(parts.join(', ')) + '</small></span></span></div>';
      var center = new google.maps.LatLng(lat / n, lng / n);
      var members = g.keys.slice();
      var bub = new HtmlMarker(center, html, 30, function () {
        if (maxLat - minLat < 0.0015 && maxLng - minLng < 0.0015) {
          showGroupList(label, members, center);       // all in one lot: list them instead of zooming forever
        } else {
          var b = new google.maps.LatLngBounds();
          b.extend(new google.maps.LatLng(minLat, minLng));
          b.extend(new google.maps.LatLng(maxLat, maxLng));
          S.map.fitBounds(b, mapPadding());
        }
      });
      bub.setMap(S.map);
      if (S.focusKey) bub.div.classList.add('fv-dim');
      S.clusters.push(bub);
    });
  }

  function goTo(key) {
    if (!S.map) return;
    if (key.indexOf('r:') === 0 && !S.markers[key]) {
      var tr = S.data.trailers.filter(function (r) { return 'r:' + r.id === key; })[0];
      if (tr && tr.pairedTruckId && S.markers['t:' + tr.pairedTruckId]) key = 't:' + tr.pairedTruckId;
    }
    if (!S.markers[key]) {
      // filtered off the map: turn everything back on and retry
      S.filters.trucks = S.filters.trailers = S.filters.dead = true; S.filters.empty = false;
      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('on', !!S.filters[c.getAttribute('data-filter')]);
      });
      render();
      if (!S.markers[key]) return;
    }
    if (!isDesktop()) setSheet('peek');
    setTimeout(function () {
      focusAt(S.markers[key].pos, 14);
      openPopup(key);
    }, isDesktop() ? 0 : 260);
  }

  // ---------------- focus mode: one truck or trailer ----------------
  // Picking a search result flies to it, fades everything else, follows it as it moves,
  // draws its route, and shows all its details in the panel.
  function findItem(key) {
    if (!S.data || !key) return null;
    var id = key.slice(2), list = key.charAt(0) === 't' ? S.data.trucks : S.data.trailers;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  // a towed trailer rides inside its truck's badge, so the map shows the truck
  function focusMarkerKey() {
    if (!S.focusKey) return null;
    if (S.markers[S.focusKey]) return S.focusKey;
    var r = S.focusKey.charAt(0) === 'r' ? findItem(S.focusKey) : null;
    if (r && r.pairedTruckId && S.markers['t:' + r.pairedTruckId]) return 't:' + r.pairedTruckId;
    return null;
  }

  function focusOn(key) {
    var it = findItem(key);
    if (!it) return;
    hideSuggest();
    if (S.info) S.info.close();
    S.infoKey = null;
    S.focusKey = key; S.follow = true;
    var kind = key.charAt(0) === 't' ? 'truck' : 'trailer';
    $('search').value = displayName(kind, it.name); $('clearBtn').hidden = false;
    S.filters.q = '';
    // make sure it isn't filtered off the map
    S.filters.trucks = S.filters.trailers = true; S.filters.empty = S.filters.lowfuel = false;
    if ((kind === 'truck' && isInactiveTruck(it)) || (kind === 'trailer' && isDead(it))) S.filters.dead = true;
    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
      c.classList.toggle('on', !!S.filters[c.getAttribute('data-filter')]);
    });
    $('sheet').classList.add('focus');
    $('focusCard').hidden = false;
    if (!isDesktop()) setSheet('focus');
    render();
    var mk = focusMarkerKey();
    select(mk);
    if (mk && mk.charAt(0) === 't') showTrail(mk.slice(2)); else clearTrail();
    setTimeout(function () { followFocused(true); }, isDesktop() ? 0 : 280);
  }

  function exitFocus(keepSearchText) {
    if (!S.focusKey) return;
    S.focusKey = null; S.follow = true;
    $('sheet').classList.remove('focus');
    $('focusCard').hidden = true;
    if (!keepSearchText) { $('search').value = ''; $('clearBtn').hidden = true; }
    select(null);
    clearTrail();
    if (!isDesktop()) setSheet('peek');
    render();
  }

  // keep the focused truck in the open part of the map (smooth pan, zoom in on first focus)
  function followFocused(first) {
    var mk = focusMarkerKey();
    var m = mk && S.markers[mk];
    if (!S.map || !m) return;
    if (first) { focusAt(m.pos, 15); return; }
    var proj = S.proj && S.proj.getProjection();
    if (!proj) return;
    var p = proj.fromLatLngToContainerPixel ? proj.fromLatLngToContainerPixel(m.pos) : null;
    var pad = mapPadding(), el = $('map');
    if (p && p.x > pad.left + 40 && p.x < el.clientWidth - pad.right - 40 && p.y > pad.top + 40 && p.y < el.clientHeight - pad.bottom - 40) return;
    focusAt(m.pos);
  }

  function renderFocus() {
    var box = $('focusCard');
    if (!S.focusKey) { box.hidden = true; return; }
    var it = findItem(S.focusKey);
    var closeBtn = '<button class="icon-btn fc-close" type="button" data-focus-close aria-label="Back to everything">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg></button>';
    if (!it) {
      box.innerHTML = '<div class="fc-head"><div class="fc-titles"><div class="fc-name">Not reporting right now</div>' +
        '<div class="fc-sub none">It dropped out of the latest Samsara update.</div></div>' + closeBtn + '</div>';
      return;
    }
    var site = currentSite(), siteName = site ? site.name : 'your site';
    var kind = S.focusKey.charAt(0) === 't' ? 'truck' : 'trailer';
    var tById = trucksById(), pulls = trailersByTruck();
    var tk = kind === 'trailer' && it.pairedTruckId ? tById[it.pairedTruckId] : null;
    var basis = tk ? Object.assign({}, it, { lat: tk.lat, lng: tk.lng, speed: tk.speed, heading: tk.heading, time: tk.time, site: tk.site || it.site }) : it;
    var d = describe(basis, site, kind === 'truck' || tk ? 'truck' : 'trailer');

    var h = '<div class="fc-head"><span class="kind-ic ' + kind + '">' + (kind === 'truck' ? ICON_TRUCK : ICON_TRAILER) + '</span>' +
      '<div class="fc-titles"><div class="fc-name">' + esc(displayName(kind, it.name)) + '</div>';
    if (kind === 'truck') h += it.driver ? '<div class="fc-sub">' + esc(it.driver) + '</div>' : '<div class="fc-sub none">No driver assigned</div>';
    else h += '<div class="fc-sub">' + loadBadge(it.load) + '</div>';
    h += '</div>' + closeBtn + '</div>';

    h += '<div class="fc-status ' + d.cls + '">' + esc(d.label) +
      (d.mph != null ? ', <span class="spd ' + speedClass(d.mph) + '">' + Math.round(d.mph) + ' mph</span>' : '') + '</div>';
    if (d.eta != null) h += '<div class="fc-eta">About ' + esc(fmtEta(d.eta)) + ' to ' + esc(siteName) + ', ' + fmtMi(d.dist) + ' mi</div>';
    else if (d.dist) h += '<div class="fc-eta">' + fmtMi(d.dist) + ' mi from ' + esc(siteName) + '</div>';

    h += '<dl class="fc-stats">';
    if (kind === 'truck') {
      if (it.fuel != null || it.mpg7 != null) h += '<dt>Fuel</dt><dd>' + fuelRow(it) + '</dd>';
      if (it.engine) h += '<dt>Engine</dt><dd>' + esc(it.engine) + (it.engineSince ? ' since ' + esc(sinceText(it.engineSince)) : '') + '</dd>';
      var trs = pulls[it.id] || [];
      if (trs.length) h += '<dt>Pulling</dt><dd>' + trs.map(function (r) { return esc(r.name) + ' ' + loadBadge(r.load); }).join(', ') + ' <span class="likely">likely</span></dd>';
    } else if (tk) {
      h += '<dt>With</dt><dd>' + esc(displayName('truck', tk.name)) + (tk.driver ? ', ' + esc(tk.driver) : '') + ' <span class="likely">likely</span></dd>';
    }
    h += '<dt>Last GPS</dt><dd>' + esc(agoText(ageMin(basis.time))) + '</dd>';
    if (kind === 'trailer' && it.load) h += '<dt>Marked</dt><dd>' + esc(it.load.status) + (it.load.by ? ' by ' + esc(it.load.by) : '') + ', ' + esc(agoText(ageMin(it.load.at))) + '</dd>';
    h += '</dl>';

    var addr = (tk ? tk.address : it.address) || '';
    if (addr) h += '<div class="fc-addr">' + esc(addr) + '</div>';

    var truckId = kind === 'truck' ? it.id : (tk ? tk.id : null);
    if (truckId && S.trail && S.trail.id === truckId) {
      var ti = S.trailInfo[truckId];
      h += !ti ? '<div class="fc-route loading">Loading the last ' + TRAIL_HOURS + ' hours</div>'
        : ti.err ? '<div class="fc-route loading">Route did not load: ' + esc(ti.err) + '</div>'
        : '<div class="fc-route">Last ' + TRAIL_HOURS + ' hours: ' + fmtMi(ti.miles) + ' mi, ' + ti.stops + (ti.stops === 1 ? ' stop' : ' stops') + '</div>';
    }

    h += '<div class="fc-actions">';
    if (kind === 'trailer') {
      var st = S.pendingLoad[it.id] !== undefined ? S.pendingLoad[it.id] : (it.load ? it.load.status : null);
      var busy = S.pendingLoad[it.id] !== undefined ? ' disabled' : '';
      h += '<button class="act set-empty' + (st === 'empty' ? ' on' : '') + '" data-load="empty" data-id="' + esc(it.id) + '" data-name="' + esc(it.name) + '"' + busy + ' type="button">Empty</button>' +
           '<button class="act set-loaded' + (st === 'loaded' ? ' on' : '') + '" data-load="loaded" data-id="' + esc(it.id) + '" data-name="' + esc(it.name) + '"' + busy + ' type="button">Loaded</button>';
    }
    if (!S.follow) h += '<button class="act" type="button" data-follow>Follow</button>';
    if (truckId) h += S.trail && S.trail.id === truckId
      ? '<button class="act" type="button" data-hide-route>Hide route</button>'
      : '<button class="act" type="button" data-show-route="' + esc(truckId) + '">Show route</button>';
    h += svButton(basis.lat, basis.lng) + '</div>';
    box.innerHTML = h;
  }

  // ---------------- route trail ----------------
  function clearTrail() {
    if (!S.trail) return;
    (S.trail.line || []).forEach(function (pl) { pl.setMap(null); });
    (S.trail.stops || []).forEach(function (m) { m.setMap(null); });
    S.trail = null;
  }

  function showTrail(truckId) {
    if (!S.map) return;
    clearTrail();
    var token = { id: truckId, line: null, stops: [] };
    S.trail = token;
    delete S.trailInfo[truckId];
    refreshPopup();
    api('trail', { vehicleId: truckId, hours: TRAIL_HOURS }).then(function (j) {
      if (S.trail !== token) return;           // user moved on
      if (!j.ok) { S.trailInfo[truckId] = { err: j.error || 'unknown error' }; refreshPopup(); return; }
      var path = j.points.map(function (p) { return new google.maps.LatLng(p[0], p[1]); });
      var tk = S.data && S.data.trucks.filter(function (t) { return t.id === truckId; })[0];
      if (tk) path.push(new google.maps.LatLng(tk.lat, tk.lng));
      // white casing under a blue line, like Google directions
      token.line = [
        new google.maps.Polyline({ path: path, strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 8, zIndex: 4, clickable: false, map: S.map }),
        new google.maps.Polyline({ path: path, strokeColor: '#1a73e8', strokeOpacity: 1, strokeWeight: 5, zIndex: 5, clickable: false, map: S.map })
      ];
      token.stops = (j.stops || []).map(function (st) {
        var m = new HtmlMarker(new google.maps.LatLng(st.lat, st.lng),
          '<div class="mk"><span class="stop-tag">' + esc(fmtStop(st.minutes)) + '</span></div>', 8, function () {
            S.info.setContent('<div class="pop"><div class="pop-name">Stopped ' + esc(fmtStop(st.minutes)) + '</div>' +
              '<div class="pop-sub">' + esc(clock(st.start)) + ' to ' + esc(clock(st.end)) + '</div>' +
              (st.address ? '<div class="pop-meta">' + esc(st.address) + '</div>' : '') + '</div>');
            S.info.setPosition(m.pos);
            S.info.open({ map: S.map });
            S.infoKey = 'stop';
          });
        m.setMap(S.map);
        return m;
      });
      S.trailInfo[truckId] = { miles: j.miles || 0, stops: (j.stops || []).length };
      refreshPopup();
    }).catch(function () {
      if (S.trail !== token) return;
      S.trailInfo[truckId] = { err: 'no connection' };
      refreshPopup();
    });
  }

  // ---------------- service worker ----------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  // ---------------- boot ----------------
  if (S.pin) startApp(); else showLogin('');
})();
