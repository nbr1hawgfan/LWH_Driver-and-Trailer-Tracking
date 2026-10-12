/* ============================================================
   LWH Fleet View — client
   Talks only to the fleet-live edge function. No Samsara token here.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.FLEET_CONFIG;
  var MOVING_MPH = 5;
  var APPROACH_DEG = 50;     // heading within this of the bearing to your site = "headed your way"
  var ROAD_FACTOR = 1.25;    // straight-line miles -> rough road miles
  var ETA_MAX_MI = 150;      // don't show ETAs for trucks farther than this

  // ---------------- state ----------------
  var S = {
    pin: store('fv_pin') || '',
    user: store('fv_user') || '',
    siteName: store('fv_site') || '',
    view: 'list',
    data: null,
    lastOk: 0,
    loading: false,
    filters: { trucks: true, trailers: true, empty: false, dead: false, q: '' },
    map: null,
    layers: null,
    markers: {},       // key "t:<id>" / "r:<id>" -> marker
    siteLayer: null,
    sitesDrawn: false,
    centeredOnce: false,
    pendingLoad: {}    // trailerId -> status while saving
  };

  // ---------------- storage (never trust it to exist) ----------------
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* private mode etc. */ }
    return null;
  }

  // ---------------- helpers ----------------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
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
  function shortLabel(name) {
    var m = String(name || '').match(/^\s*(\d+)/);
    if (m) return m[1];
    var s = String(name || '').trim();
    return s.length > 8 ? s.slice(0, 8) : s;
  }
  function fmtMi(mi) { return mi < 10 ? mi.toFixed(1) : String(Math.round(mi)); }
  function fmtEta(min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' hr' + (m ? ' ' + m : '');
  }

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

  // ---------------- login ----------------
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
    btn.disabled = true; btn.textContent = 'Checking…';
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

  $('menuBtn').addEventListener('click', function () {
    if (!confirm('Sign out of Fleet View on this device?')) return;
    S.pin = ''; store('fv_pin', null);
    showLogin('');
  });

  // ---------------- app start ----------------
  var timers = { refresh: null, tick: null };

  function startApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    setView(S.view);
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

  $('refreshBtn').addEventListener('click', function () { refresh(true); });

  // ---------------- tabs / view ----------------
  function setView(v) {
    S.view = v;
    document.body.classList.toggle('view-map', v === 'map');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === v);
    });
    if (v === 'map' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 30);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
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
  var searchTimer = null;
  $('search').addEventListener('input', function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { S.filters.q = e.target.value.trim().toLowerCase(); render(); }, 150);
  });

  $('sitePick').addEventListener('change', function (e) {
    S.siteName = e.target.value;
    store('fv_site', S.siteName);
    render();
    var site = currentSite();
    if (site && site.center && S.map) S.map.setView([site.center.latitude, site.center.longitude], 11);
  });

  // ---------------- data ----------------
  function refresh(manual) {
    if (S.loading) return;
    S.loading = true;
    if (manual) $('updated').textContent = 'Refreshing…';
    api('live').then(function (j) {
      if (j._status === 401) { S.pin = ''; store('fv_pin', null); showLogin('PIN changed. Sign in again.'); return; }
      if (!j.ok) { showBanner('Could not load fleet data: ' + (j.error || 'unknown error') + '. Showing last good data.'); return; }
      S.data = j;
      S.lastOk = Date.now();
      hideBanner();
      fillSitePicker();
      render();
    }).catch(function () {
      showBanner('No connection. Showing last good data — it will update when signal returns.');
    }).then(function () {
      S.loading = false;
      updateClock();
    });
  }

  function showBanner(t) { var b = $('banner'); b.textContent = t; b.hidden = false; }
  function hideBanner() { $('banner').hidden = true; }

  function updateClock() {
    var el = $('updated');
    if (!S.lastOk) { if (!S.loading) el.textContent = 'Not loaded yet'; return; }
    var s = Math.round((Date.now() - S.lastOk) / 1000);
    el.textContent = 'Updated ' + (s < 5 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago');
    el.classList.toggle('stale', s > 120);
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

  // ---------------- classify an asset relative to your site ----------------
  function staleLimit(kind) {
    return kind === 'trailer' ? (CFG.TRAILER_STALE_MINUTES || 1440) : (CFG.TRUCK_STALE_MINUTES || 120);
  }
  function isDead(r) {
    var age = ageMin(r.time);
    return age != null && age > (CFG.DEAD_GPS_DAYS || 30) * 1440;
  }

  function describe(a, site, kind) {
    var age = ageMin(a.time);
    var out = { dist: null, eta: null, group: 'other', label: '', cls: 'away', age: age };
    var stale = age != null && age > staleLimit(kind);
    var moving = a.speed > MOVING_MPH && !stale;

    if (site && a.site === site.name) {
      out.group = 'here'; out.cls = 'here'; out.dist = 0;
      out.label = 'At ' + site.name;
    } else if (site && site.center) {
      var d = milesBetween(a.lat, a.lng, site.center.latitude, site.center.longitude);
      out.dist = d;
      var coming = moving && headingDiff(a.heading, bearing(a.lat, a.lng, site.center.latitude, site.center.longitude)) <= APPROACH_DEG;
      if (coming && d <= ETA_MAX_MI) {
        var mph = d < 3 ? 25 : Math.min(Math.max(a.speed, 35), 60);
        out.eta = Math.max(1, Math.round(d * ROAD_FACTOR / mph * 60));
        out.group = 'coming'; out.cls = 'coming';
        out.label = 'Headed your way · ' + Math.round(a.speed) + ' mph';
      } else if (a.site) {
        out.label = 'At ' + a.site;
      } else if (moving) {
        out.label = 'Moving · ' + Math.round(a.speed) + ' mph, not toward you';
      } else {
        out.label = 'Stopped';
      }
    } else {
      out.label = a.site ? 'At ' + a.site : moving ? 'Moving · ' + Math.round(a.speed) + ' mph' : 'Stopped';
    }
    if (stale) { out.cls = 'stale'; out.label = 'Old GPS · last ping ' + agoText(age); }
    return out;
  }

  // ---------------- render ----------------
  function render() {
    if (!S.data) return;
    var deadN = S.data.trailers.filter(isDead).length;
    var chip = document.querySelector('.chip[data-filter="dead"]');
    if (chip) { chip.textContent = 'No GPS 30d+ (' + deadN + ')'; chip.hidden = deadN === 0; }
    renderList();
    renderMap();
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

  function loadBadge(load) {
    if (!load) return '<span class="badge unknown">STATUS ?</span>';
    return '<span class="badge ' + load.status + '">' + load.status.toUpperCase() + '</span>';
  }

  function renderList() {
    var site = currentSite();
    var tById = trucksById();
    var pulls = trailersByTruck();
    var items = [];

    if (S.filters.trucks) {
      S.data.trucks.forEach(function (t) {
        var trs = pulls[t.id] || [];
        if (S.filters.empty && !trs.some(function (r) { return r.load && r.load.status === 'empty'; })) return;
        if (!matchesSearch(t, trs.map(function (r) { return r.name; }))) return;
        items.push({ kind: 'truck', a: t, d: describe(t, site, 'truck'), trailers: trs });
      });
    }
    if (S.filters.trailers) {
      S.data.trailers.forEach(function (r) {
        if (!S.filters.dead && isDead(r)) return;
        if (S.filters.empty && !(r.load && r.load.status === 'empty')) return;
        var tk = r.pairedTruckId ? tById[r.pairedTruckId] : null;
        if (!matchesSearch(r, tk ? [tk.name, tk.driver] : [])) return;
        // A trailer being pulled moves with its truck: use the truck's
        // fresher position for the distance/ETA.
        var basis = tk ? Object.assign({}, r, { lat: tk.lat, lng: tk.lng, speed: tk.speed, heading: tk.heading, time: tk.time, site: tk.site || r.site }) : r;
        items.push({ kind: 'trailer', a: r, d: describe(basis, site, tk ? 'truck' : 'trailer'), truck: tk });
      });
    }

    var coming = items.filter(function (i) { return i.d.group === 'coming'; })
      .sort(function (x, y) { return x.d.eta - y.d.eta; });
    var here = items.filter(function (i) { return i.d.group === 'here'; })
      .sort(function (x, y) { return x.kind === y.kind ? x.a.name.localeCompare(y.a.name, undefined, { numeric: true }) : x.kind === 'truck' ? -1 : 1; });
    var other = items.filter(function (i) { return i.d.group === 'other'; })
      .sort(function (x, y) {
        if (x.d.dist == null || y.d.dist == null) return x.a.name.localeCompare(y.a.name, undefined, { numeric: true });
        return x.d.dist - y.d.dist;
      });

    var siteName = site ? site.name : 'your site';
    var html = '';
    html += section('Headed to ' + siteName, coming, 'Nothing headed your way right now.');
    html += section('At ' + siteName, here, 'Nothing on site.');
    html += section('Everyone else · nearest first', other, items.length ? 'None.' : 'No matches.');
    $('list').innerHTML = html;
  }

  function section(title, list, emptyMsg) {
    var h = '<div class="section-h"><span>' + esc(title) + '</span><span class="count">' + list.length + '</span></div>';
    if (!list.length) return h + '<div class="empty-note">' + esc(emptyMsg) + '</div>';
    return h + list.map(card).join('');
  }

  function card(i) {
    var a = i.a, d = i.d;
    var right = '';
    if (d.eta != null) right = '<div class="eta"><b>~' + esc(fmtEta(d.eta)) + '</b><small>' + fmtMi(d.dist) + ' mi</small></div>';
    else if (d.dist != null && d.dist > 0) right = '<div class="eta"><b>' + fmtMi(d.dist) + '</b><small>miles</small></div>';

    var h = '<div class="card ' + i.kind + '" data-key="' + (i.kind === 'truck' ? 't:' : 'r:') + esc(a.id) + '">';
    h += '<div class="card-top"><span class="kind">' + (i.kind === 'truck' ? 'Truck' : 'Trailer') + '</span>';
    h += '<div class="card-main"><div class="card-name">' + esc(a.name) + '</div>';

    if (i.kind === 'truck') {
      h += a.driver ? '<div class="card-who">' + esc(a.driver) + '</div>' : '<div class="card-who none">No driver assigned</div>';
    } else {
      h += '<div class="card-who">' + loadBadge(a.load) + '</div>';
    }
    h += '</div>' + right + '</div>';

    h += '<span class="status ' + d.cls + '">' + esc(d.label) + '</span>';

    if (i.kind === 'truck' && i.trailers.length) {
      h += '<div class="pull">Pulling ' + i.trailers.map(function (r) {
        return esc(r.name) + ' ' + loadBadge(r.load);
      }).join(', ') + ' <span class="likely">(likely, from GPS)</span></div>';
    }
    if (i.kind === 'trailer' && i.truck) {
      h += '<div class="pull">With truck ' + esc(i.truck.name) + (i.truck.driver ? ' · ' + esc(i.truck.driver) : '') +
        ' <span class="likely">(likely, from GPS)</span></div>';
    }

    if (a.address && d.group !== 'here') {
      h += '<div class="card-detail"><span class="addr">' + esc(a.address) + '</span></div>';
    }

    h += '<div class="card-actions">';
    if (i.kind === 'trailer') {
      var st = S.pendingLoad[a.id] !== undefined ? S.pendingLoad[a.id] : (a.load ? a.load.status : null);
      var busy = S.pendingLoad[a.id] !== undefined;
      h += '<button class="act set-empty' + (st === 'empty' ? ' on' : '') + '" data-load="empty" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '"' + (busy ? ' disabled' : '') + ' type="button">Empty</button>';
      h += '<button class="act set-loaded' + (st === 'loaded' ? ' on' : '') + '" data-load="loaded" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '"' + (busy ? ' disabled' : '') + ' type="button">Loaded</button>';
    }
    h += '<button class="act map" data-goto="' + (i.kind === 'truck' ? 't:' : 'r:') + esc(a.id) + '" type="button">Show on map</button>';
    h += '</div>';

    if (i.kind === 'trailer' && a.load) {
      h += '<div class="load-meta">Marked ' + esc(a.load.status) + (a.load.by ? ' by ' + esc(a.load.by) : '') + ', ' + esc(agoText(ageMin(a.load.at))) + '</div>';
    }
    h += '</div>';
    return h;
  }

  // card buttons (event delegation)
  $('list').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-goto')) { goTo(btn.getAttribute('data-goto')); return; }
    if (btn.hasAttribute('data-load')) {
      var id = btn.getAttribute('data-id');
      var name = btn.getAttribute('data-name');
      var want = btn.getAttribute('data-load');
      var tr = S.data.trailers.filter(function (r) { return r.id === id; })[0];
      var cur = tr && tr.load ? tr.load.status : null;
      setLoad(id, name, cur === want ? 'clear' : want);
    }
  });

  function setLoad(id, name, status) {
    S.pendingLoad[id] = status === 'clear' ? null : status;
    render();
    api('setLoad', { trailerId: id, trailerName: name, status: status, by: S.user }).then(function (j) {
      if (!j.ok) { alert('Could not save: ' + (j.error || 'unknown error')); return; }
      S.data.trailers.forEach(function (r) {
        if (r.id === id) r.load = status === 'clear' ? null : { status: status, by: S.user, at: new Date().toISOString() };
      });
    }).catch(function () {
      alert('No connection — status was not saved.');
    }).then(function () {
      delete S.pendingLoad[id];
      render();
    });
  }

  // ---------------- map ----------------
  function initMap() {
    if (S.map) { setTimeout(function () { S.map.invalidateSize(); }, 50); return; }
    if (!window.L) {
      // Map library didn't load (bad signal, blocked CDN) — the list still works.
      $('map').innerHTML = '<p class="empty-note" style="padding:16px">Map could not load. The Nearby list still works.</p>';
      return;
    }
    S.map = L.map('map', { zoomControl: true }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(S.map);
    S.siteLayer = L.layerGroup().addTo(S.map);
    S.layers = { trailers: L.layerGroup().addTo(S.map), trucks: L.layerGroup().addTo(S.map) };
  }

  function drawSites() {
    if (S.sitesDrawn || !S.data) return;
    S.data.sites.forEach(function (s) {
      (s.shapes || []).forEach(function (sh) {
        var style = { color: '#7d1935', weight: 2, fillOpacity: 0.08 };
        if (sh.type === 'polygon') {
          L.polygon(sh.vertices.map(function (v) { return [v.latitude, v.longitude]; }), style).addTo(S.siteLayer);
        } else if (sh.type === 'circle') {
          L.circle([sh.center.latitude, sh.center.longitude], Object.assign({ radius: sh.radiusMeters }, style)).addTo(S.siteLayer);
        }
      });
      if (s.center) {
        L.marker([s.center.latitude, s.center.longitude], { opacity: 0, interactive: false })
          .bindTooltip(esc(s.name), { permanent: true, direction: 'top', className: 'site-label', offset: [0, -4] })
          .addTo(S.siteLayer);
      }
    });
    S.sitesDrawn = true;
  }

  function truckIcon(t) {
    var moving = t.speed > MOVING_MPH;
    var html = '<div class="mk mk-truck' + (moving ? '' : ' idle') + '"><span class="mk-body">' +
      (moving ? '<span class="arw" style="transform:rotate(' + Math.round(t.heading) + 'deg)"></span>' : '') +
      esc(shortLabel(t.name)) + '</span></div>';
    return L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] });
  }
  function trailerIcon(r) {
    var age = ageMin(r.time);
    var old = age != null && age > staleLimit('trailer');
    var dot = r.load ? '<span class="dot ' + r.load.status + '"></span>' : '';
    var html = '<div class="mk mk-trailer' + (old ? ' old' : '') + '"><span class="mk-body">' + dot + esc(shortLabel(r.name)) + '</span></div>';
    return L.divIcon({ className: 'mk-wrap', html: html, iconSize: [0, 0] });
  }

  function truckPopup(t, pulls) {
    var age = ageMin(t.time);
    return '<div class="pop-name">Truck ' + esc(t.name) + '</div>' +
      '<div class="pop-sub">' + esc(t.driver || 'No driver assigned') + '</div>' +
      '<div class="pop-sub">' + (t.speed > MOVING_MPH ? Math.round(t.speed) + ' mph' : 'Stopped') + (t.site ? ' · At ' + esc(t.site) : '') + '</div>' +
      (pulls && pulls.length ? '<div class="pop-sub">Likely pulling ' + pulls.map(function (r) { return esc(r.name) + (r.load ? ' (' + r.load.status + ')' : ''); }).join(', ') + '</div>' : '') +
      '<div class="pop-meta">' + esc(t.address || '') + '<br>GPS ' + esc(agoText(age)) + '</div>';
  }
  function trailerPopup(r, tk) {
    return '<div class="pop-name">Trailer ' + esc(r.name) + '</div>' +
      '<div class="pop-sub">' + (r.load ? esc(r.load.status.toUpperCase()) : 'Status not set') + (r.site ? ' · At ' + esc(r.site) : '') + '</div>' +
      (tk ? '<div class="pop-sub">Likely with truck ' + esc(tk.name) + (tk.driver ? ' · ' + esc(tk.driver) : '') + '</div>' : '') +
      '<div class="pop-meta">' + esc(r.address || '') + '<br>GPS ' + esc(agoText(ageMin(r.time))) + '</div>';
  }

  function renderMap() {
    if (!S.map) return;
    drawSites();
    var seen = {};
    var tById = trucksById();
    var pulls = trailersByTruck();

    function upsert(key, latlng, icon, popup, layer, z) {
      seen[key] = true;
      var m = S.markers[key];
      if (!m) {
        m = L.marker(latlng, { icon: icon, zIndexOffset: z }).bindPopup(popup);
        m.addTo(layer);
        S.markers[key] = m;
      } else {
        m.setLatLng(latlng); m.setIcon(icon); m.setPopupContent(popup);
        if (!layer.hasLayer(m)) { S.layers.trucks.removeLayer(m); S.layers.trailers.removeLayer(m); m.addTo(layer); }
      }
    }

    if (S.filters.trailers) {
      S.data.trailers.forEach(function (r) {
        if (!S.filters.dead && isDead(r)) return;
        if (S.filters.empty && !(r.load && r.load.status === 'empty')) return;
        var tk = r.pairedTruckId ? tById[r.pairedTruckId] : null;
        if (!matchesSearch(r, tk ? [tk.name, tk.driver] : [])) return;
        upsert('r:' + r.id, [r.lat, r.lng], trailerIcon(r), trailerPopup(r, tk), S.layers.trailers, 0);
      });
    }
    if (S.filters.trucks) {
      S.data.trucks.forEach(function (t) {
        var trs = pulls[t.id] || [];
        if (S.filters.empty && !trs.some(function (r) { return r.load && r.load.status === 'empty'; })) return;
        if (!matchesSearch(t, trs.map(function (r) { return r.name; }))) return;
        upsert('t:' + t.id, [t.lat, t.lng], truckIcon(t), truckPopup(t, trs), S.layers.trucks, 1000);
      });
    }

    Object.keys(S.markers).forEach(function (k) {
      if (!seen[k]) {
        S.layers.trucks.removeLayer(S.markers[k]);
        S.layers.trailers.removeLayer(S.markers[k]);
        delete S.markers[k];
      }
    });

    if (!S.centeredOnce) {
      var site = currentSite();
      if (site && site.center) S.map.setView([site.center.latitude, site.center.longitude], 11);
      S.centeredOnce = true;
    }
  }

  function goTo(key) {
    var m = S.markers[key];
    if (!m) {
      // filtered off the map — turn everything back on and retry
      S.filters.trucks = S.filters.trailers = S.filters.dead = true; S.filters.empty = false;
      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
        c.classList.toggle('on', !!S.filters[c.getAttribute('data-filter')]);
      });
      renderMap();
      m = S.markers[key];
      if (!m) return;
    }
    if (window.innerWidth < 900) setView('map');
    setTimeout(function () {
      S.map.invalidateSize();
      S.map.setView(m.getLatLng(), Math.max(S.map.getZoom(), 14));
      m.openPopup();
    }, 60);
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
