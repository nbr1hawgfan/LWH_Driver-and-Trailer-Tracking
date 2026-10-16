/* ============================================================
   LWH Fleet View — Yard Checks (v1.9.0)
   Reads and writes the same yard_checks data as the Driver Toolkit
   (yard-check-history / yard-check-submit / yard-photo-upload /
   yard-photo-urls edge functions in LWH Companion). Nothing new on
   the server: a check saved here shows on the toolkit's Dispatch
   Board, and driver checks show here.

   What managers get:
   - Yards: each yard's latest check, days on yard, damage photos,
     and whether Samsara can see each trailer right now.
   - Find a trailer: every yard check that listed it, plus live GPS.
   - New check: on-site managers log trailers (Loaded / Empty, note,
     Damaged + photo), same as a driver would.
   - Map: trailers seen on a recent yard check that Samsara can't
     place (no gateway, dead gateway, new trailer) show at the yard.
   app.js talks to this file through window.FVYard; this file reads
   the live fleet through window.FV.
   ============================================================ */
(function () {
  'use strict';

  var CFG = window.FLEET_CONFIG || {};
  var API = CFG.YARD_API || 'https://tjivcqxnkftujceumdtx.supabase.co/functions/v1/';
  var URL_HISTORY = API + 'yard-check-history', URL_SUBMIT = API + 'yard-check-submit';
  var URL_PHOTO = API + 'yard-photo-upload', URL_PHOTO_LINKS = API + 'yard-photo-urls';
  var RECENT_DAYS = CFG.YARD_RECENT_DAYS || 14;        // map + "no GPS" window
  var LIST_DAYS = CFG.YARD_LIST_DAYS || 30;            // Yards tab shows these first
  var REFRESH_S = CFG.YARD_REFRESH_SECONDS || 120;
  var MAX_PHOTOS = 5, MAX_EDGE = 1600, JPEG_Q = 0.72, START_ROWS = 8;
  var DAY = 86400000, HOUR = 3600000;
  var DRAFT_KEY = 'fv_yc_draft';

  var Y = {
    checks: [], loaded: false, loading: false, err: '', at: 0,
    byYard: {}, yards: [], sightings: {}, live: null,
    open: false, tab: 'yards', showOld: false, flash: null,
    draft: null, blobs: {}, thumbs: {}, saving: false, saveMsg: '',
    markers: [], markerSig: '',
    urlCache: {}, findQ: '', findServer: null, findFor: '', findTimer: null
  };

  // ---------------- helpers ----------------
  function $(id) { return document.getElementById(id); }
  function FV() { return window.FV; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* private mode */ }
    return null;
  }
  var tKey = function (s) { return String(s || '').trim().toUpperCase(); };
  var locKey = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var normKey = function (s) { return tKey(s).replace(/[^A-Z0-9]/g, ''); };
  var tailNum = function (s) { var m = normKey(s).match(/(\d{3,})$/); return m ? m[1].replace(/^0+/, '') : ''; };
  function pad(n) { return String(n).padStart(2, '0'); }
  function nowLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function rid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function ago(t) {
    var min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' hr ago';
    var d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }
  function when(t) {
    var d = new Date(t);
    return (Date.now() - t < 6 * DAY)
      ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function calDays(from, to) {
    var a = new Date(from), b = new Date(to); a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
    return Math.round((b - a) / DAY);
  }
  function source(c) { return /fleet view/i.test(c.how || '') ? 'Fleet View' : 'Driver Toolkit'; }
  function toast(msg, ms) { if (FV()) FV().toast(msg, ms || 4000); }
  function post(url, body) {
    return fetch(url, { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      });
  }

  var IC_CLIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v2h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3zm0 2v1h6V5zm-1 6v2h8v-2zm0 4v2h5v-2z"/></svg>';

  // ---------------- data ----------------
  function load() {
    if (Y.loading) return Promise.resolve();
    Y.loading = true; paintUpdated();
    return post(URL_HISTORY, { limit: 500 }).then(function (j) {
      Y.checks = (j.checks || []).filter(function (c) { return !isNaN(Date.parse(c.checked_at)); });
      Y.loaded = true; Y.err = ''; Y.at = Date.now();
      build();
    }).catch(function (e) {
      Y.err = e.message || 'did not load';
    }).then(function () {
      Y.loading = false;
      onFleet();
      if (Y.open && Y.tab !== 'new') renderBody();
      paintUpdated();
    });
  }

  function build() {
    var by = {};
    Y.checks.forEach(function (c) {
      c._t = Date.parse(c.checked_at);
      var k = c.location_key || locKey(c.location);
      (by[k] = by[k] || []).push(c);
    });
    Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return b._t - a._t; }); });
    Y.byYard = by;
    Y.yards = Object.keys(by).map(function (k) { return by[k][0]; }).sort(function (a, b) { return b._t - a._t; });
    var s = {};
    Y.checks.slice().sort(function (a, b) { return b._t - a._t; }).forEach(function (c) {
      (c.trailers || []).forEach(function (t) { var k = tKey(t.trailer); if (k && !s[k]) s[k] = { check: c, t: t }; });
    });
    Y.sightings = s;
  }

  // Unbroken run of checks at this yard (up to this one) that include the trailer.
  function onYardSince(key, check) {
    var list = Y.byYard[check.location_key || locKey(check.location)] || [], first = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c._t > check._t) continue;
      if ((c.trailers || []).some(function (t) { return tKey(t.trailer) === key; })) first = c._t; else break;
    }
    return first;
  }
  function dwellText(key, check) {
    var f = onYardSince(key, check);
    if (!f) return '';
    var d = calDays(f, check._t);
    return d >= 1 ? 'On yard since ' + new Date(f).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d + (d === 1 ? ' day' : ' days') : '';
  }

  // ---------------- match to Samsara ----------------
  function liveIndex() {
    var fv = FV(), data = fv && fv.data();
    if (!data) return null;
    if (Y.live && Y.live.src === data) return Y.live;
    var byNorm = {}, byNum = {};
    data.trailers.forEach(function (r) {
      byNorm[normKey(r.name)] = r;
      var n = tailNum(r.name);
      if (n) (byNum[n] = byNum[n] || []).push(r);
    });
    Y.live = { src: data, byNorm: byNorm, byNum: byNum };
    return Y.live;
  }
  function matchLive(name) {
    var ix = liveIndex();
    if (!ix) return null;
    var hit = ix.byNorm[normKey(name)];
    if (hit) return hit;
    var n = tailNum(name), list = n ? ix.byNum[n] : null;
    return list && list.length === 1 ? list[0] : null;     // only when the number is unique
  }
  // Samsara can't vouch for it: no gateway, or its last ping is older than the
  // yard check and more than a day old.
  function gpsStale(r, check) {
    var g = Date.parse(r && r.time);
    if (isNaN(g)) return true;
    return g < check._t && Date.now() - g > 24 * HOUR;
  }
  function liveLine(name, check) {
    var r = matchLive(name);
    if (!r) return { cls: 'nogps', text: 'Not in Samsara', r: null };
    if (gpsStale(r, check)) return { cls: 'nogps', text: 'GPS ' + ago(Date.parse(r.time)).replace(' ago', ' old'), r: r };
    var tk = r.pairedTruckId && FV().truck(r.pairedTruckId);
    return { cls: 'gps', text: tk ? 'GPS: with ' + FV().displayName('truck', tk.name) : r.site ? 'GPS: at ' + r.site : 'GPS: ' + (r.address || 'on map').split(',')[0], r: r };
  }

  // ---------------- where a check happened ----------------
  function checkCoords(c) {
    var m = String(c.pin || '').match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) || String(c.pin || '').match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
    var data = FV() && FV().data(), k = c.location_key || locKey(c.location);
    if (data && k) {
      var s = data.sites.filter(function (x) { return x.center && locKey(x.name) === k; })[0];
      if (s) return { lat: s.center.latitude, lng: s.center.longitude };
    }
    return null;
  }

  // Trailers on a yard's latest recent check that Samsara can't place, and whose
  // newest sighting anywhere is this check.
  function noGpsAt(c) {
    return (c.trailers || []).filter(function (t) {
      var k = tKey(t.trailer), s = Y.sightings[k];
      if (!s || s.check.id !== c.id) return false;
      var r = matchLive(k);
      return !r || gpsStale(r, c);
    });
  }
  function recentYards() {
    var cut = Date.now() - RECENT_DAYS * DAY;
    return Y.yards.filter(function (c) { return c._t >= cut; });
  }

  // ---------------- map layer ----------------
  function onFleet() {
    var fv = FV();
    if (!fv || !Y.loaded) return;
    var groups = recentYards().map(function (c) { return { c: c, list: noGpsAt(c), pos: checkCoords(c) }; })
      .filter(function (g) { return g.list.length; });
    var total = groups.reduce(function (n, g) { return n + g.list.length; }, 0);
    var chip = document.querySelector('.chip[data-filter="nogps"]');
    if (chip) { chip.textContent = 'No-GPS trailers (' + total + ')'; chip.hidden = total === 0; }

    var map = fv.map(), Marker = fv.Marker();
    var show = map && Marker && fv.filters().nogps && !fv.focusKey();
    var placed = show ? groups.filter(function (g) { return g.pos; }) : [];
    var sig = placed.map(function (g) { return g.c.id + ':' + g.list.length; }).join('|');
    if (sig === Y.markerSig) return;
    Y.markerSig = sig;
    Y.markers.forEach(function (m) { m.setMap(null); });
    Y.markers = placed.map(function (g) {
      var names = g.list.map(function (t) { return tKey(t.trailer); });
      var label = names.length <= 2 ? names.join(', ') : names.length + ' trailers';
      var html = '<div class="mk"><span class="mk-yc" role="button" aria-label="' + esc(g.c.location + ': ' + names.length + ' trailers with no GPS, from a yard check') + '">' +
        IC_CLIP + '<span>' + esc(label) + '</span><small>no GPS</small></span></div>';
      var m = new Marker(new google.maps.LatLng(g.pos.lat, g.pos.lng), html, 12, function () { openPanel('yards', g.c.id); });
      m.setMap(map);
      return m;
    });
  }

  // ---------------- panel ----------------
  function openPanel(tab, flashId) {
    Y.open = true;
    if (tab) Y.tab = tab;
    Y.flash = flashId || null;
    $('ycPanel').hidden = false;
    document.body.classList.add('yc-on');
    renderTabs(); renderBody();
    if (!Y.loaded || Date.now() - Y.at > 30000) load();
  }
  function closePanel() {
    Y.open = false;
    $('ycPanel').hidden = true;
    document.body.classList.remove('yc-on');
  }
  function renderTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-yctab]'), function (b) {
      var on = b.getAttribute('data-yctab') === Y.tab;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
    });
  }
  function paintUpdated() {
    var el = $('ycUpdated');
    if (!el) return;
    el.textContent = Y.loading ? 'Loading' : Y.err ? 'Did not load' : Y.at ? 'Updated ' + ago(Y.at) : '';
    el.classList.toggle('stale', !!Y.err);
  }
  function renderBody() {
    var b = $('ycBody');
    if (Y.tab === 'yards') b.innerHTML = yardsHtml();
    else if (Y.tab === 'find') { b.innerHTML = findShellHtml(); renderFind(); }
    else renderNew();
    if (Y.tab === 'yards') {
      fillPhotos(b);
      if (Y.flash) {
        var card = $('ycc-' + Y.flash);
        if (card) { card.classList.add('flash'); card.scrollIntoView({ block: 'start' }); }
        Y.flash = null;
      }
    }
    paintUpdated();
  }

  // ---------------- Yards tab ----------------
  function yardsHtml() {
    if (!Y.loaded) return '<p class="yc-note">' + (Y.err ? 'Yard checks did not load: ' + esc(Y.err) + '. <button type="button" class="yc-link" data-yc-reload>Try again</button>' : 'Loading yard checks') + '</p>';
    if (!Y.yards.length) return '<p class="yc-note">No yard checks yet. Drivers send them from the Driver Toolkit, or tap <b>New check</b>.</p>';
    var cut = Date.now() - LIST_DAYS * DAY;
    var fresh = Y.yards.filter(function (c) { return c._t >= cut; }), old = Y.yards.filter(function (c) { return c._t < cut; });
    var noGps = recentYards().reduce(function (n, c) { return n + noGpsAt(c).length; }, 0);
    var h = '<div class="yc-sum">' + fresh.length + (fresh.length === 1 ? ' yard' : ' yards') + ' checked in the last ' + LIST_DAYS + ' days' +
      (noGps ? '. <b class="yc-warn">' + noGps + ' trailer' + (noGps === 1 ? '' : 's') + ' Samsara can\'t place</b>' : '') +
      '. <button type="button" class="yc-link" data-yc-reload>Refresh</button></div>';
    if (Y.err) h += '<p class="yc-note err">Refresh failed: ' + esc(Y.err) + '. Showing the last good list.</p>';
    h += fresh.map(yardCard).join('') || '<p class="yc-note">Nothing in the last ' + LIST_DAYS + ' days.</p>';
    if (old.length) {
      h += Y.showOld ? '<div class="section-h"><span>Older yards</span><span class="count">' + old.length + '</span></div>' + old.map(yardCard).join('')
        : '<button type="button" class="act yc-more" data-yc-old>Show ' + old.length + ' older yard' + (old.length === 1 ? '' : 's') + '</button>';
    }
    return h;
  }

  function yardCard(c) {
    var tr = c.trailers || [];
    var L = tr.filter(function (t) { return t.status === 'Loaded'; }).length;
    var E = tr.filter(function (t) { return t.status === 'Empty'; }).length;
    var D = tr.filter(function (t) { return t.damaged; }).length;
    var oldCls = Date.now() - c._t > 3 * DAY ? ' old' : '';
    var pos = checkCoords(c);
    var h = '<article class="yc-card" id="ycc-' + esc(c.id) + '">' +
      '<div class="yc-card-h"><h3>' + esc(c.location || '(no location)') + '</h3>' +
      '<div class="yc-when' + oldCls + '">Checked ' + esc(when(c._t)) + ' (' + esc(ago(c._t)) + ')' + (c.driver ? ' by ' + esc(c.driver) : '') + ', ' + source(c) + '</div>' +
      '<div class="yc-counts">' + tr.length + (tr.length === 1 ? ' trailer' : ' trailers') + ': ' +
      '<span class="badge loaded">' + L + ' loaded</span> <span class="badge empty">' + E + ' empty</span>' +
      (tr.length - L - E ? ' <span class="badge unknown">' + (tr.length - L - E) + ' not marked</span>' : '') +
      (D ? ' <span class="badge dmg">' + D + ' damaged</span>' : '') + '</div></div>';
    h += '<div class="yc-rows">' + tr.map(function (t) { return trailerRow(t, c); }).join('') + '</div>';
    if (c.notes) h += '<div class="yc-yardnote"><b>Yard notes:</b> ' + esc(c.notes) + '</div>';
    h += '<div class="actions yc-acts">' +
      '<button type="button" class="act" data-yc-again="' + esc(c.id) + '">Check this yard again</button>' +
      (pos ? '<button type="button" class="act" data-yc-fly="' + pos.lat + ',' + pos.lng + '">Show on map</button>' : '') +
      (c.pin ? '<a class="act" href="' + esc(c.pin) + '" target="_blank" rel="noopener">Open pin</a>' : '') +
      '</div></article>';
    return h;
  }

  function trailerRow(t, c) {
    var k = tKey(t.trailer), live = liveLine(k, c), newer = Y.sightings[k] && Y.sightings[k].check.id !== c.id ? Y.sightings[k].check : null;
    var dwell = dwellText(k, c);
    var num = live.r && live.cls === 'gps'
      ? '<button type="button" class="yc-tnum" data-yc-live="' + esc(live.r.id) + '" title="Show on map">' + esc(k) + '</button>'
      : '<button type="button" class="yc-tnum plain" data-yc-find="' + esc(k) + '" title="Every yard check for this trailer">' + esc(k) + '</button>';
    var st = t.status ? '<span class="badge ' + (t.status === 'Loaded' ? 'loaded' : 'empty') + '">' + esc(t.status) + '</span>' : '<span class="badge unknown">Not marked</span>';
    var bits = [];
    if (t.note) bits.push(esc(t.note));
    if (dwell) bits.push('<span class="' + (calDays(onYardSince(k, c), c._t) >= 7 ? 'yc-long' : '') + '">' + esc(dwell) + '</span>');
    if (newer) bits.push('<span class="yc-moved">Since seen at ' + esc(newer.location || 'another yard') + ', ' + esc(ago(newer._t)) + '</span>');
    return '<div class="yc-trow' + (t.damaged ? ' dmg' : '') + '">' +
      '<div class="yc-trow-top">' + num + st + (t.damaged ? '<span class="badge dmg">Damaged</span>' : '') +
      '<span class="yc-live ' + live.cls + '">' + esc(live.text) + '</span></div>' +
      (bits.length ? '<div class="yc-trow-sub">' + bits.join(' &middot; ') + '</div>' : '') +
      photoStrip(t.photos) + '</div>';
  }

  function photoStrip(paths) {
    paths = paths || [];
    if (!paths.length) return '';
    return '<div class="yc-thumbs">' + paths.map(function (p) {
      return '<a class="yc-thumb" data-ycpath="' + esc(p) + '" target="_blank" rel="noopener"><img data-ycpath="' + esc(p) + '" alt="Trailer photo"></a>';
    }).join('') + '</div>';
  }
  // Photos are private; get 1-hour links after the list draws.
  function fillPhotos(root) {
    var nodes = Array.prototype.slice.call(root.querySelectorAll('[data-ycpath]'));
    if (!nodes.length) return;
    var fresh = function (p) { return Y.urlCache[p] && Date.now() - Y.urlCache[p].at < 45 * 60000; };
    var need = nodes.map(function (n) { return n.getAttribute('data-ycpath'); })
      .filter(function (p, i, a) { return a.indexOf(p) === i && !fresh(p); });
    var go = need.length ? post(URL_PHOTO_LINKS, { paths: need }).then(function (j) {
      Object.keys(j.urls || {}).forEach(function (p) { Y.urlCache[p] = { url: j.urls[p], at: Date.now() }; });
    }).catch(function () { /* thumbnails just stay blank */ }) : Promise.resolve();
    go.then(function () {
      nodes.forEach(function (n) {
        var c = Y.urlCache[n.getAttribute('data-ycpath')];
        if (!c) return;
        if (n.tagName === 'IMG') n.src = c.url; else n.href = c.url;
      });
    });
  }

  // ---------------- Find tab ----------------
  function findShellHtml() {
    return '<label class="yc-lbl" for="ycFind">Trailer number</label>' +
      '<input id="ycFind" class="yc-in" type="search" inputmode="text" autocapitalize="characters" autocomplete="off" placeholder="e.g. 53101" value="' + esc(Y.findQ) + '">' +
      '<div id="ycFindOut"></div>';
  }
  function renderFind() {
    var out = $('ycFindOut');
    if (!out) return;
    var q = normKey(Y.findQ);
    if (!q) { out.innerHTML = '<p class="yc-note">Type a trailer number to see every yard check that listed it, and where Samsara last saw it.</p>'; return; }
    // local (loaded checks) + server results for older history
    var seen = {}, rows = [];
    function add(c) {
      if (seen[c.id]) return; seen[c.id] = true;
      if (isNaN(c._t)) c._t = Date.parse(c.checked_at);
      (c.trailers || []).forEach(function (t) { if (normKey(t.trailer).indexOf(q) !== -1) rows.push({ c: c, t: t }); });
    }
    Y.checks.forEach(add);
    if (Y.findServer && Y.findFor === q) Y.findServer.forEach(add);
    rows.sort(function (a, b) { return b.c._t - a.c._t; });

    var h = '';
    var names = rows.map(function (x) { return tKey(x.t.trailer); }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var liveCands = names.length ? names : [tKey(Y.findQ)];
    liveCands.slice(0, 3).forEach(function (n) {
      var r = matchLive(n);
      if (!r) return;
      var last = Date.parse(r.time);
      h += '<div class="yc-livecard"><div><b>' + esc(FV().displayName('trailer', r.name)) + '</b> in Samsara</div>' +
        '<div class="yc-trow-sub">' + (r.site ? 'At ' + esc(r.site) + ', ' : r.address ? esc(r.address.split(',')[0]) + ', ' : '') +
        'GPS ' + esc(isNaN(last) ? 'unknown' : ago(last)) + (r.load ? ', marked ' + esc(r.load.status) : '') + '</div>' +
        '<button type="button" class="act" data-yc-live="' + esc(r.id) + '">Show on map</button></div>';
    });
    if (!rows.length) {
      h += '<p class="yc-note">' + (Y.findFor === q ? 'No yard check has listed a trailer matching "' + esc(Y.findQ) + '".' : 'Searching') + '</p>';
    } else {
      h += '<div class="section-h"><span>Yard checks</span><span class="count">' + rows.length + '</span></div>';
      h += rows.slice(0, 60).map(function (x) {
        var t = x.t, c = x.c, k = tKey(t.trailer);
        var st = t.status ? '<span class="badge ' + (t.status === 'Loaded' ? 'loaded' : 'empty') + '">' + esc(t.status) + '</span>' : '<span class="badge unknown">Not marked</span>';
        var dw = Y.byYard[c.location_key || locKey(c.location)] ? dwellText(k, c) : '';
        return '<div class="yc-trow' + (t.damaged ? ' dmg' : '') + '"><div class="yc-trow-top"><b class="yc-tnum plain">' + esc(k) + '</b>' + st +
          (t.damaged ? '<span class="badge dmg">Damaged</span>' : '') + '</div>' +
          '<div class="yc-trow-sub"><b>' + esc(c.location || '(no location)') + '</b>, ' + esc(when(c._t)) + ' (' + esc(ago(c._t)) + ')' + (c.driver ? ' by ' + esc(c.driver) : '') +
          (t.note ? ' &middot; ' + esc(t.note) : '') + (dw ? ' &middot; ' + esc(dw) : '') + '</div>' + photoStrip(t.photos) + '</div>';
      }).join('');
    }
    out.innerHTML = h;
    fillPhotos(out);
  }
  function findServer(q) {
    var key = normKey(q);
    if (!key) return;
    post(URL_HISTORY, { trailer: q, limit: 60 }).then(function (j) {
      if (normKey(Y.findQ) !== key) return;
      Y.findServer = j.checks || []; Y.findFor = key; renderFind();
    }).catch(function () {
      if (normKey(Y.findQ) !== key) return;
      Y.findServer = []; Y.findFor = key; renderFind();
    });
  }

  // ---------------- New check ----------------
  function blankRow(trailer, status) { return { rid: rid(), trailer: trailer || '', status: status || '', note: '', damaged: false, photos: [] }; }
  function blankDraft() {
    var rows = []; while (rows.length < START_ROWS) rows.push(blankRow());
    return { id: 'yc-' + Date.now() + '-fv', when: nowLocal(), location: '', pin: '', driver: FV() ? FV().user() : '', notes: '', rows: rows };
  }
  function padRows(d) { while (d.rows.length < START_ROWS) d.rows.push(blankRow()); }
  function saveDraft() { try { store(DRAFT_KEY, JSON.stringify(Y.draft)); } catch (e) { /* full */ } }
  function getDraft() {
    if (Y.draft) return Y.draft;
    var d = null;
    try { d = JSON.parse(store(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    if (d && d.rows) {
      // photos only live in memory; a reload drops them
      var lost = 0;
      d.rows.forEach(function (r) { var n = (r.photos || []).length; r.photos = (r.photos || []).filter(function (p) { return Y.blobs[p]; }); lost += n - r.photos.length; });
      if (lost) setTimeout(function () { toast(lost + ' photo' + (lost === 1 ? '' : 's') + ' from your unsaved check were cleared when the app reloaded. Add them again.', 6000); }, 300);
      padRows(d);
    } else d = blankDraft();
    Y.draft = d;
    return d;
  }
  function filledRows(d) { return d.rows.filter(function (r) { return r.trailer.trim(); }); }
  function isDirty(d) { return filledRows(d).length > 0 || !!d.notes.trim(); }

  function locOptions() {
    var names = {}, data = FV() && FV().data();
    (data ? data.sites : []).forEach(function (s) { names[s.name] = 1; });
    Y.yards.forEach(function (c) { if (c.location) names[c.location] = 1; });
    return Object.keys(names).sort().map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('');
  }

  function renderNew() {
    var d = getDraft();
    var b = $('ycBody');
    b.innerHTML =
      '<form id="ycForm" class="yc-form" autocomplete="off" novalidate>' +
      '<label class="yc-lbl" for="ycLoc">Yard / location</label>' +
      '<input id="ycLoc" class="yc-in" list="ycLocList" maxlength="120" value="' + esc(d.location) + '" placeholder="Pick a site or type a yard name">' +
      '<datalist id="ycLocList">' + locOptions() + '</datalist>' +
      '<div class="yc-pinrow"><button type="button" class="act" id="ycGps">' + (d.pin ? 'Update my location pin' : 'Pin my location') + '</button>' +
      (d.pin ? '<span class="yc-pin">Pinned <button type="button" class="yc-link" id="ycClearPin">clear</button></span>' : '<span class="yc-hint">Helps put no-GPS trailers on the map</span>') + '</div>' +
      '<div class="yc-two"><div><label class="yc-lbl" for="ycWhen">Checked at</label><input id="ycWhen" class="yc-in" type="datetime-local" value="' + esc(d.when) + '"></div>' +
      '<div><label class="yc-lbl" for="ycWho">Checked by</label><input id="ycWho" class="yc-in" maxlength="80" value="' + esc(d.driver) + '"></div></div>' +
      '<div class="section-h yc-rows-h"><span>Trailers</span><span class="count" id="ycCount"></span></div>' +
      '<div id="ycRowsEdit"></div>' +
      '<button type="button" class="act yc-addrow" id="ycAddRow">Add trailer line</button>' +
      '<label class="yc-lbl" for="ycNotes">Yard notes (optional)</label>' +
      '<textarea id="ycNotes" class="yc-in" rows="2" maxlength="1000">' + esc(d.notes) + '</textarea>' +
      '<p class="yc-hint">Photos stay on this screen until you save. A saved check shows on the Driver Toolkit Dispatch Board too.</p>' +
      '<div id="ycSaveMsg" class="yc-savemsg" role="status"></div>' +
      '<div class="yc-savebar"><button type="submit" class="btn-primary" id="ycSave">Save yard check</button>' +
      '<button type="button" class="act" id="ycDiscard">Start over</button></div>' +
      '</form>';
    renderRows();
    paintSaveMsg();
  }

  function rowHtml(r, i) {
    var n = (r.photos || []).length;
    return '<div class="yc-erow' + (r.damaged ? ' dmg' : '') + '" data-rid="' + r.rid + '">' +
      '<div class="yc-erow-top"><span class="yc-num">' + (i + 1) + '</span>' +
      '<input class="yc-in yc-tin" data-f="trailer" value="' + esc(r.trailer) + '" placeholder="Trailer #" autocapitalize="characters" maxlength="30" aria-label="Trailer number ' + (i + 1) + '" enterkeyhint="next">' +
      '<button type="button" class="act yc-st' + (r.status === 'Loaded' ? ' on loaded' : '') + '" data-st="Loaded" aria-pressed="' + (r.status === 'Loaded') + '">Loaded</button>' +
      '<button type="button" class="act yc-st' + (r.status === 'Empty' ? ' on empty' : '') + '" data-st="Empty" aria-pressed="' + (r.status === 'Empty') + '">Empty</button>' +
      '<button type="button" class="icon-btn yc-del" data-del aria-label="Remove line ' + (i + 1) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg></button></div>' +
      '<div class="yc-dupe" hidden>Listed twice</div>' +
      '<input class="yc-in yc-nin" data-f="note" value="' + esc(r.note) + '" placeholder="Product / note (optional)" maxlength="200" aria-label="Note for line ' + (i + 1) + '">' +
      '<div class="yc-erow-x"><button type="button" class="act yc-dmgbtn' + (r.damaged ? ' on' : '') + '" data-dmg aria-pressed="' + r.damaged + '">Damaged</button>' +
      '<label class="act yc-photobtn">Add photo<input type="file" accept="image/*" capture="environment" multiple hidden data-photo></label>' +
      '<span class="yc-pc' + (r.damaged && !n ? ' need' : '') + '">' + (r.damaged && !n ? 'Photo required' : n ? n + (n === 1 ? ' photo' : ' photos') : '') + '</span></div>' +
      (n ? '<div class="yc-thumbs">' + r.photos.map(function (p, j) {
        return '<span class="yc-thumb"><img src="' + thumb(p) + '" alt="Photo ' + (j + 1) + '"><button type="button" data-rmphoto="' + p + '" aria-label="Remove photo ' + (j + 1) + '">&times;</button></span>';
      }).join('') + '</div>' : '') +
      '</div>';
  }
  function thumb(id) { return Y.thumbs[id] || (Y.blobs[id] ? (Y.thumbs[id] = URL.createObjectURL(Y.blobs[id])) : ''); }

  function renderRows(focusLast) {
    var d = getDraft(), box = $('ycRowsEdit');
    if (!box) return;
    box.innerHTML = d.rows.map(rowHtml).join('');
    markDupes(); countLine();
    if (focusLast) { var ins = box.querySelectorAll('.yc-tin'); if (ins.length) ins[ins.length - 1].focus(); }
  }
  function markDupes() {
    var d = getDraft(), n = {};
    d.rows.forEach(function (r) { var k = tKey(r.trailer); if (k) n[k] = (n[k] || 0) + 1; });
    Array.prototype.forEach.call(document.querySelectorAll('#ycRowsEdit .yc-erow'), function (el) {
      var r = findRow(el.getAttribute('data-rid'));
      var dupe = r && tKey(r.trailer) && n[tKey(r.trailer)] > 1;
      el.classList.toggle('dupe', !!dupe);
      el.querySelector('.yc-dupe').hidden = !dupe;
    });
  }
  function countLine() {
    var f = filledRows(getDraft()), el = $('ycCount');
    if (!el) return;
    var L = f.filter(function (r) { return r.status === 'Loaded'; }).length, E = f.filter(function (r) { return r.status === 'Empty'; }).length;
    el.textContent = f.length ? f.length + ' listed: ' + L + ' loaded, ' + E + ' empty' : '';
  }
  function findRow(id) { var d = getDraft(); for (var i = 0; i < d.rows.length; i++) if (d.rows[i].rid === id) return d.rows[i]; return null; }
  function paintSaveMsg() { var el = $('ycSaveMsg'); if (el) { el.innerHTML = Y.saveMsg; el.hidden = !Y.saveMsg; } }

  // Open the form with some trailers filled in (from the map, or "check again").
  function startWith(location, rows, pin) {
    var d = getDraft();
    if (isDirty(d)) {
      // add to the check in progress instead of replacing it
      var have = {}; filledRows(d).forEach(function (r) { have[tKey(r.trailer)] = 1; });
      var add = rows.filter(function (r) { return !have[tKey(r.trailer)]; });
      d.rows = filledRows(d).concat(add.map(function (r) { return blankRow(r.trailer, r.status); }));
      if (!d.location.trim() && location) d.location = location;
      toast(add.length ? 'Added to the yard check you already started.' : 'That trailer is already on your yard check.', 3500);
    } else {
      d = Y.draft = blankDraft();
      d.location = location || '';
      if (pin) d.pin = pin;
      if (rows.length) d.rows = rows.map(function (r) { return blankRow(r.trailer, r.status); });
    }
    padRows(d); saveDraft();
    openPanel('new');
  }

  function compress(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_EDGE / Math.max(w, h));
        w = Math.round(w * k); h = Math.round(h * k);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
        c.toBlob(function (b) { if (b) res(b); else rej(new Error('Could not process photo')); }, 'image/jpeg', JPEG_Q);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Could not read that photo')); };
      img.src = url;
    });
  }
  function addPhotos(r, files) {
    files = Array.prototype.filter.call(files || [], function (f) { return /^image\//.test(f.type); });
    var room = MAX_PHOTOS - r.photos.length;
    if (!files.length) return;
    if (room <= 0) { toast('Up to ' + MAX_PHOTOS + ' photos per trailer.'); return; }
    var chain = Promise.resolve();
    files.slice(0, room).forEach(function (f) {
      chain = chain.then(function () { return compress(f); }).then(function (blob) {
        var id = 'ph-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        Y.blobs[id] = blob; r.photos.push(id);
      }).catch(function (e) { toast(e.message || 'Could not add that photo.'); });
    });
    chain.then(function () { saveDraft(); renderRows(); });
  }
  function dropPhoto(id) {
    if (Y.thumbs[id]) { URL.revokeObjectURL(Y.thumbs[id]); delete Y.thumbs[id]; }
    delete Y.blobs[id];
  }

  function validate(d) {
    var f = filledRows(d);
    if (!f.length) { toast('Add at least one trailer number.'); return false; }
    var noPhoto = f.filter(function (r) { return r.damaged && !r.photos.length; });
    if (noPhoto.length) { alert('Damaged trailer ' + noPhoto.map(function (r) { return tKey(r.trailer); }).join(', ') + ' needs at least one photo before saving.'); return false; }
    if (!d.location.trim() && !d.pin && !confirm('No yard or location entered. Save anyway?')) return false;
    var unmarked = f.filter(function (r) { return !r.status; }).length;
    if (unmarked && !confirm(unmarked + ' trailer' + (unmarked === 1 ? ' is' : 's are') + ' not marked Loaded or Empty. Save anyway?')) return false;
    var at = new Date(d.when);
    if (isNaN(at.getTime())) { toast('Check the date and time.'); return false; }
    if (at.getTime() > Date.now() + 10 * 60000 && !confirm('The time is in the future. Save anyway?')) return false;
    return true;
  }

  function save() {
    var d = getDraft();
    if (Y.saving || !validate(d)) return;
    Y.saving = true;
    var btn = $('ycSave'); if (btn) { btn.disabled = true; btn.textContent = 'Saving'; }
    var f = filledRows(d), todo = [];
    f.forEach(function (r) { r.photos.forEach(function (p) { if (Y.blobs[p]) todo.push(p); }); });
    var chain = Promise.resolve(), done = 0;
    todo.forEach(function (pid) {
      chain = chain.then(function () {
        if (btn) btn.textContent = 'Uploading photo ' + (++done) + ' of ' + todo.length;
        return fetch(URL_PHOTO + '?check=' + encodeURIComponent(d.id) + '&photo=' + encodeURIComponent(pid),
          { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'image/jpeg' }, body: Y.blobs[pid] })
          .then(function (res) {
            if (!res.ok) return res.json().catch(function () { return {}; }).then(function (j) { throw new Error('photo: ' + (j.error || 'HTTP ' + res.status)); });
          });
      });
    });
    chain.then(function () {
      if (btn) btn.textContent = 'Saving';
      return post(URL_SUBMIT, {
        id: d.id, location: d.location.trim(), pin: d.pin || '', driver: (d.driver || '').trim(),
        checked_at: new Date(d.when).toISOString(), how: 'Fleet View', notes: d.notes.trim(),
        trailers: f.map(function (r) {
          return { trailer: tKey(r.trailer), status: r.status, note: r.note.trim(), damaged: !!r.damaged,
            photos: r.photos.filter(function (p) { return todo.indexOf(p) !== -1; }).map(function (p) { return d.id + '/' + p + '.jpg'; }) };
        })
      });
    }).then(function () {
      var id = d.id, loc = d.location.trim() || 'the yard', n = f.length;
      f.forEach(function (r) { r.photos.forEach(dropPhoto); });
      Y.draft = null; store(DRAFT_KEY, null); Y.saveMsg = '';
      toast('Yard check saved: ' + n + ' trailer' + (n === 1 ? '' : 's') + ' at ' + loc + '.', 4000);
      Y.tab = 'yards'; renderTabs();
      Y.flash = id;
      $('ycBody').innerHTML = '<p class="yc-note">Saved. Loading the yard list</p>';
      return load().then(function () { renderBody(); });
    }).catch(function (e) {
      Y.saveMsg = '<b>Not saved.</b> ' + esc(navigator.onLine === false ? 'No signal.' : (e.message || 'The office did not answer.')) +
        ' Everything is still here. Keep this screen open and tap Save again.';
      paintSaveMsg();
    }).then(function () {
      Y.saving = false;
      var b2 = $('ycSave'); if (b2) { b2.disabled = false; b2.textContent = 'Save yard check'; }
    });
  }

  // ---------------- events ----------------
  document.addEventListener('click', function (e) {
    var t = e.target;
    var tab = t.closest('[data-yctab]');
    if (tab) { Y.tab = tab.getAttribute('data-yctab'); renderTabs(); renderBody(); if (Y.tab === 'find') { var fi = $('ycFind'); if (fi) fi.focus(); } return; }
    if (t.closest('#ycClose')) { closePanel(); return; }
    if (t.closest('#ycBtn') || t.closest('[data-menu="yard"]')) { openPanel(Y.tab === 'new' ? 'new' : 'yards'); return; }
    if (t.closest('[data-yc-reload]')) { load(); return; }
    if (t.closest('[data-yc-old]')) { Y.showOld = true; renderBody(); return; }

    var add = t.closest('[data-yc-add]');
    if (add) {
      startWith(add.getAttribute('data-yc-site') || '', [{ trailer: add.getAttribute('data-yc-add'), status: add.getAttribute('data-yc-status') || '' }]);
      return;
    }
    var again = t.closest('[data-yc-again]');
    if (again) {
      var src = Y.checks.filter(function (c) { return c.id === again.getAttribute('data-yc-again'); })[0];
      if (src) {
        startWith(src.location, (src.trailers || []).map(function (x) { return { trailer: x.trailer, status: '' }; }), src.pin);
        toast('Trailers copied from the last check. Mark each Loaded or Empty, remove any that left, add new ones.', 5000);
      }
      return;
    }
    var live = t.closest('[data-yc-live]');
    if (live) { closePanel(); FV().focusOn('r:' + live.getAttribute('data-yc-live')); return; }
    var fly = t.closest('[data-yc-fly]');
    if (fly) {
      var p = fly.getAttribute('data-yc-fly').split(',');
      closePanel();
      FV().flyTo(Number(p[0]), Number(p[1]), 17);
      return;
    }
    var fnd = t.closest('[data-yc-find]');
    if (fnd) { Y.findQ = fnd.getAttribute('data-yc-find'); Y.tab = 'find'; renderTabs(); renderBody(); findServer(Y.findQ); return; }

    // form
    if (!t.closest('#ycForm')) return;
    var d = getDraft();
    if (t.closest('#ycAddRow')) { d.rows.push(blankRow()); saveDraft(); renderRows(true); return; }
    if (t.closest('#ycDiscard')) {
      if (isDirty(d) && !confirm('Clear this yard check and start over?')) return;
      d.rows.forEach(function (r) { r.photos.forEach(dropPhoto); });
      Y.draft = blankDraft(); saveDraft(); Y.saveMsg = ''; renderNew(); return;
    }
    if (t.closest('#ycClearPin')) { d.pin = ''; saveDraft(); renderNew(); return; }
    if (t.closest('#ycGps')) {
      if (!navigator.geolocation) { toast('Location is not available on this device.'); return; }
      var g = $('ycGps'); g.textContent = 'Locating'; g.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        d.pin = 'https://maps.google.com/?q=' + pos.coords.latitude.toFixed(5) + ',' + pos.coords.longitude.toFixed(5);
        saveDraft(); renderNew();
      }, function () {
        g.textContent = 'Pin my location'; g.disabled = false;
        toast('Could not get your location. Check location permission for this site.');
      }, { enableHighAccuracy: true, timeout: 15000 });
      return;
    }
    var rowEl = t.closest('.yc-erow');
    if (!rowEl) return;
    var r = findRow(rowEl.getAttribute('data-rid'));
    if (!r) return;
    var st = t.closest('[data-st]');
    if (st) { var v = st.getAttribute('data-st'); r.status = r.status === v ? '' : v; saveDraft(); renderRows(); return; }
    if (t.closest('[data-dmg]')) { r.damaged = !r.damaged; saveDraft(); renderRows(); if (r.damaged && !r.photos.length) toast('Damaged: add at least one photo.'); return; }
    var rm = t.closest('[data-rmphoto]');
    if (rm) { var pid = rm.getAttribute('data-rmphoto'); r.photos = r.photos.filter(function (x) { return x !== pid; }); dropPhoto(pid); saveDraft(); renderRows(); return; }
    if (t.closest('[data-del]')) {
      if (r.trailer.trim() && !confirm('Remove trailer ' + tKey(r.trailer) + ' from this check?')) return;
      r.photos.forEach(dropPhoto);
      d.rows = d.rows.filter(function (x) { return x !== r; });
      if (!d.rows.length) d.rows.push(blankRow());
      saveDraft(); renderRows();
    }
  });

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'ycFind') {
      Y.findQ = t.value; Y.findServer = null; Y.findFor = '';
      clearTimeout(Y.findTimer);
      renderFind();
      Y.findTimer = setTimeout(function () { findServer(Y.findQ); }, 400);
      return;
    }
    if (!t.closest || !t.closest('#ycForm')) return;
    var d = getDraft();
    if (t.id === 'ycLoc') d.location = t.value;
    else if (t.id === 'ycWhen') d.when = t.value;
    else if (t.id === 'ycWho') d.driver = t.value;
    else if (t.id === 'ycNotes') d.notes = t.value;
    else {
      var rowEl = t.closest('.yc-erow'), r = rowEl && findRow(rowEl.getAttribute('data-rid'));
      if (!r) return;
      if (t.getAttribute('data-f') === 'trailer') { r.trailer = t.value; markDupes(); countLine(); }
      if (t.getAttribute('data-f') === 'note') r.note = t.value;
    }
    saveDraft();
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t.hasAttribute || !t.hasAttribute('data-photo')) return;
    var rowEl = t.closest('.yc-erow'), r = rowEl && findRow(rowEl.getAttribute('data-rid'));
    if (r) addPhotos(r, t.files);
    t.value = '';
  });
  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'ycForm') return;
    e.preventDefault(); save();
  });
  // Enter in a trailer box jumps to the next line (adds one at the end).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && Y.open) { closePanel(); return; }
    if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('yc-tin')) return;
    e.preventDefault();
    var ins = Array.prototype.slice.call(document.querySelectorAll('#ycRowsEdit .yc-tin')), i = ins.indexOf(e.target);
    if (i < ins.length - 1) ins[i + 1].focus();
    else { getDraft().rows.push(blankRow()); saveDraft(); renderRows(true); }
  });

  // ---------------- hooks for app.js ----------------
  var timer = null;
  window.FVYard = {
    start: function () {
      load();
      clearInterval(timer);
      timer = setInterval(function () { if (document.visibilityState === 'visible') load(); }, REFRESH_S * 1000);
    },
    onFleet: onFleet,
    // Search box: trailers seen on yard checks that Samsara doesn't know.
    suggest: function (q) {
      q = normKey(q);
      if (!q || !Y.loaded) return [];
      return Object.keys(Y.sightings).filter(function (k) { return normKey(k).indexOf(q) !== -1 && !matchLive(k); }).slice(0, 4)
        .map(function (k) {
          var s = Y.sightings[k];
          return { key: 'y:' + k, kind: 'trailer', s: (normKey(k) === q ? 0 : 3) + 2, name: k, label: 'Trailer ' + k,
            sub: 'No GPS. Yard check: ' + (s.t.status || 'not marked') + ' at ' + (s.check.location || 'unknown yard') + ', ' + ago(s.check._t) };
        });
    },
    pick: function (key) {
      var k = key.slice(2);
      Y.findQ = k; Y.findServer = null; Y.findFor = '';
      openPanel('find'); findServer(k);
    },
    // Extra lines for a trailer's focus card / popup.
    trailerStats: function (r) {
      var s = Y.sightings[tKey(r.name)];
      if (!s) {
        var ix = Object.keys(Y.sightings).filter(function (k) { return matchLive(k) === r; })[0];
        s = ix ? Y.sightings[ix] : null;
      }
      if (!s) return '';
      var dw = dwellText(tKey(s.t.trailer), s.check);
      return '<dt>Yard check</dt><dd>' + (s.t.status ? esc(s.t.status) : 'Not marked') + ' at ' + esc(s.check.location || 'unknown yard') +
        ', ' + esc(ago(s.check._t)) + (s.check.driver ? ' by ' + esc(s.check.driver) : '') +
        (s.t.damaged ? ' <span class="badge dmg">Damaged</span>' : '') + (s.t.note ? '<br>' + esc(s.t.note) : '') + (dw ? '<br>' + esc(dw) : '') + '</dd>';
    },
    addButton: function (r) {
      var site = r.site || (FV().site() ? FV().site().name : '');
      var st = r.load ? (r.load.status === 'empty' ? 'Empty' : 'Loaded') : '';
      return '<button class="act" type="button" data-yc-add="' + esc(r.name) + '" data-yc-site="' + esc(site) + '" data-yc-status="' + st + '">Add to yard check</button>';
    }
  };
})();
