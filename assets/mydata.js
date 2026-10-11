/*
 * "My data" tab: import a CSV or Excel file, store it in a SQLite database, and report on it.
 *
 *   file -> SheetJS (vendor/xlsx.mini.min.js) -> validated rows -> Random Forest estimate per row
 *        -> SQLite (vendor/sql-wasm.*, schema in database/schema.sql) -> SQL queries -> charts + insights
 *
 * The database lives in the browser: it is saved to IndexedDB after every change, so it is still
 * there on the next visit, and "Download database" exports it as a normal .sqlite file. Nothing is
 * uploaded anywhere. sql.js loads its .wasm with a network request, so this tab needs the page to
 * be served over http(s) (GitHub Pages, or `python -m http.server`); the other tabs work from a folder.
 */
(function (root) {
  'use strict';

  var PESO = '₱', MINUS = '−';
  var TYPES = ['house', 'condo', 'lot', 'commercial'];
  var NAMES = { house: 'House', condo: 'Condo', lot: 'Lot', commercial: 'Commercial' };
  var SYMBOL = { house: 'circle', condo: 'square', lot: 'diamond', commercial: 'x' };
  var PLOTS = ['d-region', 'd-box', 'd-scatter', 'd-gap'];
  var MAX_BYTES = 30 * 1024 * 1024, MAX_ROWS = 100000, CHUNK = 1500;
  var IDB_NAME = 'property-price-estimator', IDB_STORE = 'files', IDB_KEY = 'listings.sqlite';

  // Accepted column names (after lower-casing and turning punctuation into "_") for each field.
  var ALIASES = {
    property_type: ['property_type', 'type', 'propertytype'],
    price_php: ['price_php', 'price', 'asking_price', 'price_in_php', 'list_price'],
    sqm: ['sqm', 'floor_area', 'floor_area_sqm', 'floor_area_m2', 'floor_size', 'area_sqm'],
    lot_area_m2: ['lot_area_m2', 'lot_area', 'lot_size', 'lot_area_sqm'],
    bedrooms: ['bedrooms', 'bedroom', 'beds'],
    bathrooms: ['bathrooms', 'bathroom', 'baths'],
    city: ['city', 'municipality'],
    province: ['province'],
    region: ['region'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'long', 'longitude'],
    source_id: ['listing_id', 'id', 'source_id']
  };
  var TYPE_WORDS = {
    house: 'house', 'house and lot': 'house', 'house & lot': 'house',
    condo: 'condo', condominium: 'condo', 'condo unit': 'condo',
    lot: 'lot', land: 'lot', 'vacant lot': 'lot',
    commercial: 'commercial', 'commercial space': 'commercial'
  };

  var SQL = null, db = null, ready = null, drawn = false, busy = false, clearArmed = null;
  var knownCities = null, bounds = null;

  function el(id) { return document.getElementById(id); }
  function U() { return root.Charts.util; }
  function money(v) { return root.Charts.money(v); }
  function compact(v) { return root.Charts.compact(v); }
  function group(n) { return Math.round(n).toLocaleString('en-US'); }
  function cv(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function pctText(v) { return (v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(0) + '%'; }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ------------------------------------------------------------------ status line */

  function say(text, kind) {
    var s = el('d-status');
    s.textContent = text;
    s.className = 'msg-line' + (kind ? ' ' + kind : '');
    s.hidden = !text;
  }

  /* ------------------------------------------------------------------ loading the database */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function idb() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(IDB_STORE); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idbGet() {
    return idb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var q = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY);
        q.onsuccess = function () { resolve(q.result || null); };
        q.onerror = function () { reject(q.error); };
      });
    });
  }
  function idbPut(bytes) {
    return idb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function save() {
    // Not being able to save (private window, blocked storage) must not lose the in-memory result.
    return idbPut(db.export()).catch(function () {
      say('The data is loaded, but this browser would not keep it for next time (private window or blocked storage). Use "Download database" to keep a copy.', 'warn');
    });
  }

  function ensure() {
    if (ready) return ready;
    ready = Promise.all([loadScript('vendor/sql-wasm.js'), loadScript('vendor/xlsx.mini.min.js')])
      .then(function () { return root.initSqlJs({ locateFile: function (f) { return 'vendor/' + f; } }); })
      .then(function (S) { SQL = S; return Promise.all([fetch('database/schema.sql').then(function (r) { if (!r.ok) throw new Error('schema'); return r.text(); }), idbGet().catch(function () { return null; })]); })
      .then(function (res) {
        db = res[1] ? new SQL.Database(res[1]) : new SQL.Database();
        db.exec(res[0]);
        bounds = root.LOOKUP.bounds;
        knownCities = new Set(root.LOOKUP.preproc.te.encodings.city.names);
      })
      .catch(function (e) {
        ready = null;
        var file = location.protocol === 'file:';
        throw new Error(file
          ? 'The database needs the page to be served over http. Open the GitHub Pages link, or run "python -m http.server" in this folder and visit http://localhost:8000.'
          : 'The database could not start (' + (e && e.message ? e.message : e) + ').');
      });
    return ready;
  }

  /* ------------------------------------------------------------------ SQL helpers */

  function q(sql, params) {
    var st = db.prepare(sql), out = [];
    if (params) st.bind(params);
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  }
  function one(sql) { return q(sql)[0]; }

  /* ------------------------------------------------------------------ reading a file */

  function readFile(name, buf) {
    var wb;
    if (/\.(csv|txt)$/i.test(name)) {
      // Decode as UTF-8 ourselves; SheetJS assumes a legacy code page for binary CSV and garbles letters like n-tilde.
      wb = root.XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''), { type: 'string', raw: true });
    } else {
      wb = root.XLSX.read(buf, { type: 'array' });
    }
    var ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('That file has no sheets.');
    return root.XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  }

  function norm(h) { return String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }

  function mapColumns(sample) {
    var byNorm = {}, map = {};
    Object.keys(sample).forEach(function (k) { byNorm[norm(k)] = k; });
    Object.keys(ALIASES).forEach(function (field) {
      for (var i = 0; i < ALIASES[field].length; i++) {
        if (byNorm[ALIASES[field][i]] !== undefined) { map[field] = byNorm[ALIASES[field][i]]; break; }
      }
    });
    return map;
  }

  function toNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).replace(/[^0-9.\-]/g, '');
    if (s === '' || s === '-' || s === '.') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function toText(v) { if (v === null || v === undefined) return null; var s = String(v).trim(); return s === '' ? null : s; }

  /* Raw rows -> { good: [record], bad: [{row, why}] }. Only the price and the type are required;
     everything else may be blank because the model fills the gaps with typical values. */
  function validate(rows, map) {
    var good = [], bad = [];
    rows.forEach(function (r, i) {
      var type = TYPE_WORDS[String(toText(r[map.property_type]) || '').toLowerCase()] || null;
      var price = toNum(r[map.price_php]);
      if (!type) { bad.push({ row: i + 2, why: 'property type is missing or not house, condo, lot or commercial' }); return; }
      if (price === null || price <= 0) { bad.push({ row: i + 2, why: 'price is missing or not above zero' }); return; }
      var rec = { property_type: type, price_php: price };
      ['sqm', 'lot_area_m2', 'bedrooms', 'bathrooms', 'lat', 'lng'].forEach(function (f) { rec[f] = map[f] ? toNum(r[map[f]]) : null; });
      ['city', 'province', 'region', 'source_id'].forEach(function (f) { rec[f] = map[f] ? toText(r[map[f]]) : null; });
      good.push(rec);
    });
    return { good: good, bad: bad };
  }

  /* The model was trained on plausible values only; a floor area of 9 million m2 is a typo, not a
     property. Such values are kept in the database as given but left out of the estimate. */
  function modelInput(rec) {
    var inp = { property_type: rec.property_type, city: rec.city, province: rec.province, region: rec.region };
    ['sqm', 'lot_area_m2', 'bedrooms', 'bathrooms', 'lat', 'lng'].forEach(function (f) {
      var v = rec[f], b = bounds[f];
      inp[f] = v !== null && b && (v < b[0] || v > b[1]) ? null : v;
    });
    return inp;
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ------------------------------------------------------------------ importing */

  function importRows(fileName, rows) {
    if (!rows.length) throw new Error('That file has no data rows.');
    if (rows.length > MAX_ROWS) throw new Error('That file has ' + group(rows.length) + ' rows. This demo handles up to ' + group(MAX_ROWS) + '; split the file and import the parts.');
    var map = mapColumns(rows[0]);
    if (!map.property_type || !map.price_php) {
      throw new Error('Could not find the required columns. The file needs a property type column (property_type) and a price column (price_php). Columns found: ' +
        Object.keys(rows[0]).slice(0, 12).join(', ') + '.');
    }
    var v = validate(rows, map);
    if (!v.good.length) throw new Error('Every row was rejected. First problem: row ' + v.bad[0].row + ', ' + v.bad[0].why + '.');

    root.PriceModel.init();
    db.run('BEGIN');
    var importId;
    try {
      db.run('INSERT INTO imports (file_name, rows_read, rows_stored, rows_rejected) VALUES (?, ?, ?, ?)', [fileName, rows.length, v.good.length, v.bad.length]);
      importId = one('SELECT last_insert_rowid() AS id').id;
    } catch (e) { db.run('ROLLBACK'); throw e; }

    var st = db.prepare('INSERT INTO listings (import_id, source_id, property_type, price_php, sqm, lot_area_m2, bedrooms, bathrooms, city, province, region, lat, lng, city_known, predicted_price_php) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    var i = 0;
    function step() {
      var end = Math.min(i + CHUNK, v.good.length);
      for (; i < end; i++) {
        var r = v.good[i], est = root.PriceModel.predict(modelInput(r)).price;
        st.run([importId, r.source_id, r.property_type, r.price_php, r.sqm, r.lot_area_m2, r.bedrooms, r.bathrooms,
                r.city, r.province, r.region, r.lat, r.lng, r.city && knownCities.has(r.city) ? 1 : 0, isFinite(est) ? est : null]);
      }
      say('Storing and estimating ' + group(i) + ' of ' + group(v.good.length) + ' listings…');
      if (i < v.good.length) return tick().then(step);
    }
    return tick().then(step).then(function () {
      st.free(); db.run('COMMIT');
      return save();
    }).then(function () {
      return { stored: v.good.length, rejected: v.bad, read: rows.length };
    }, function (e) {
      try { st.free(); } catch (x) { /* already freed */ }
      try { db.run('ROLLBACK'); } catch (x) { /* nothing open */ }
      throw e;
    });
  }

  function handleFile(name, buf) {
    if (busy) return;
    busy = true; setBusy(true);
    say('Reading ' + name + '…');
    return ensure().then(function () { return tick(); })
      .then(function () { return importRows(name, readFile(name, buf)); })
      .then(function (res) {
        var msg = 'Imported ' + group(res.stored) + ' of ' + group(res.read) + ' rows from ' + name + '.';
        if (res.rejected.length) {
          msg += ' ' + group(res.rejected.length) + ' rejected, for example row ' + res.rejected[0].row + ': ' + res.rejected[0].why + '.';
        }
        say(msg, res.rejected.length ? 'warn' : 'good');
        drawn = false; return render();
      })
      .catch(function (e) { say(e && e.message ? e.message : String(e), 'bad'); })
      .then(function () { busy = false; setBusy(false); });
  }

  function setBusy(on) {
    ['d-file', 'd-sample', 'd-clear'].forEach(function (id) { el(id).disabled = on; });
  }

  /* ------------------------------------------------------------------ report */

  function tableRows(tbody, rows, cells) {
    tbody.textContent = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      cells.forEach(function (c, i) {
        var td = document.createElement(i === 0 ? 'th' : 'td');
        if (i === 0) td.scope = 'row';
        td.textContent = c(r);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function render() {
    var n = one('SELECT COUNT(*) AS n FROM listings').n;
    el('d-empty').hidden = n > 0;
    el('d-report').hidden = n === 0;
    el('d-clear').hidden = n === 0;
    el('d-download').hidden = n === 0;
    if (n === 0) { drawn = false; return Promise.resolve(); }

    var all = q('SELECT property_type AS t, region AS rg, price_php AS p, predicted_price_php AS e, city_known AS ck, sqm FROM listings');
    var gaps = q('SELECT property_type AS t, gap_pct AS g FROM listing_gap');
    var prices = all.map(function (r) { return r.p; });
    var ests = all.filter(function (r) { return r.e !== null; }).map(function (r) { return r.e; });
    var gapAll = gaps.map(function (r) { return r.g; });
    var medP = median(prices), medE = median(ests), medG = median(gapAll);

    // KPI tiles
    var kpi = [['Listings stored', group(n)], ['Median asking price', money(medP)], ['Median model estimate', medE === null ? 'n/a' : money(medE)],
               ['Median gap', medG === null ? 'n/a' : (medG > 0 ? '+' : '') + pctText(medG)]];
    var box = el('d-kpis'); box.textContent = '';
    kpi.forEach(function (k) {
      var d = document.createElement('div'); d.className = 'kpi';
      var a = document.createElement('span'); a.textContent = k[0];
      var b = document.createElement('strong'); b.textContent = k[1];
      d.appendChild(a); d.appendChild(b); box.appendChild(d);
    });

    insights(n, all, gaps, medP, medE, medG);
    reviewTables();
    contents();
    drawCharts(all, gaps);
    drawn = true;
    return Promise.resolve();
  }

  function groupBy(rows, key, val) {
    var m = {};
    rows.forEach(function (r) { if (r[key] !== null && r[key] !== undefined) (m[r[key]] = m[r[key]] || []).push(val(r)); });
    return m;
  }

  function insights(n, all, gaps, medP, medE, medG) {
    var out = [];
    var imp = one('SELECT COUNT(*) AS files, SUM(rows_rejected) AS bad FROM imports');
    out.push(group(n) + ' listings are stored from ' + imp.files + ' file' + (imp.files === 1 ? '' : 's') + (imp.bad ? '; ' + group(imp.bad) + ' rows were rejected for a missing price or property type.' : '.'));

    var byRegion = groupBy(all, 'rg', function (r) { return r.p; });
    var regs = Object.keys(byRegion).filter(function (k) { return byRegion[k].length >= 5; })
      .map(function (k) { return { name: k, med: median(byRegion[k]), n: byRegion[k].length }; })
      .sort(function (a, b) { return b.med - a.med; });
    if (regs.length >= 2) {
      var hi = regs[0], lo = regs[regs.length - 1];
      out.push('The highest typical asking price is in ' + hi.name + ' (median ' + money(hi.med) + ', ' + hi.n + ' listings); the lowest is in ' + lo.name + ' (' + money(lo.med) + ', ' + lo.n + ' listings). Regions with fewer than 5 listings are left out of this comparison.');
    }

    if (medG !== null) {
      var bias = root.PERF.analysis.bias.median_signed_error_pct;
      out.push('The median listing asks ' + pctText(Math.abs(medG)) + (medG < 0 ? ' less' : ' more') + ' than the model estimates. The model itself leans about ' + bias.toFixed(0) +
        '% high on its own test data (paper Section 4.2), so asking prices a little below the estimate are normal.');
    }

    var byType = groupBy(gaps, 't', function (r) { return Math.abs(r.g); });
    var types = Object.keys(byType).filter(function (k) { return byType[k].length >= 5; })
      .map(function (k) { return { t: k, m: median(byType[k]) }; }).sort(function (a, b) { return b.m - a.m; });
    if (types.length >= 2) {
      out.push('Asking prices and estimates disagree most for ' + NAMES[types[0].t].toLowerCase() + 's (typical difference ' + pctText(types[0].m) + ') and least for ' +
        NAMES[types[types.length - 1].t].toLowerCase() + 's (' + pctText(types[types.length - 1].m) + '). The paper also found lots and commercial properties harder to price.');
    }

    var k = one("SELECT SUM(gap_pct <= -0.3) AS low, SUM(gap_pct >= 0.3) AS high FROM listing_gap WHERE city_known = 1 AND sqm IS NOT NULL AND region IS NOT NULL");
    if (k && (k.low || k.high)) {
      out.push(group(k.low || 0) + ' listings with a known city, floor area and region ask at least 30% less than its estimate, and ' + group(k.high || 0) +
        ' ask at least 30% more. The most extreme are listed below as candidates to look at again; a gap can also mean the listing is unusual or has a typo.');
    }

    var unseen = all.filter(function (r) { return r.ck === 0; }).length, noSqm = all.filter(function (r) { return r.sqm === null; }).length;
    var r2 = root.PERF.metrics.spatial_holdout.metrics.RandomForestRegression.r2;
    var quality = [];
    if (unseen) quality.push(pctText(unseen / n) + ' of listings (' + group(unseen) + ') are in cities the model has not seen. In the paper\'s unseen-city test R² fell to ' + (r2 < 0 ? MINUS : '') + Math.abs(r2).toFixed(2) + ', so treat those estimates as rough.');
    if (noSqm) quality.push(pctText(noSqm / n) + ' have no floor area, so the model used a typical value for them.');
    if (quality.length) out.push(quality.join(' '));

    var ul = el('d-insights'); ul.textContent = '';
    out.forEach(function (s) { var li = document.createElement('li'); li.textContent = s; ul.appendChild(li); });
  }

  function reviewTables() {
    var cols = [
      function (r) { return NAMES[r.property_type]; },
      function (r) { return r.city || '(not specified)'; },
      function (r) { return r.sqm === null ? 'n/a' : group(r.sqm) + ' m²'; },
      function (r) { return money(r.price_php); },
      function (r) { return money(r.predicted_price_php); },
      function (r) { return (r.gap_pct > 0 ? '+' : '') + pctText(r.gap_pct); }
    ];
    var base = 'SELECT property_type, city, sqm, price_php, predicted_price_php, gap_pct FROM listing_gap WHERE city_known = 1 AND sqm IS NOT NULL AND region IS NOT NULL ORDER BY gap_pct ';
    tableRows(el('d-low'), q(base + 'ASC LIMIT 10'), cols);
    tableRows(el('d-high'), q(base + 'DESC LIMIT 10'), cols);
  }

  function contents() {
    tableRows(el('d-imports'), q('SELECT file_name, imported_at, rows_read, rows_stored, rows_rejected FROM imports ORDER BY id DESC'), [
      function (r) { return r.file_name; }, function (r) { return r.imported_at + ' UTC'; },
      function (r) { return group(r.rows_read); }, function (r) { return group(r.rows_stored); }, function (r) { return group(r.rows_rejected); }]);
    tableRows(el('d-preview'), q('SELECT property_type, city, region, sqm, price_php, predicted_price_php FROM listings ORDER BY id LIMIT 15'), [
      function (r) { return NAMES[r.property_type]; }, function (r) { return r.city || '(not specified)'; }, function (r) { return r.region || '(not specified)'; },
      function (r) { return r.sqm === null ? 'n/a' : group(r.sqm) + ' m²'; }, function (r) { return money(r.price_php); },
      function (r) { return r.predicted_price_php === null ? 'n/a' : money(r.predicted_price_php); }]);
  }

  /* ------------------------------------------------------------------ charts */

  function priceTicks(lo, hi) {
    var vals = [], text = [];
    for (var k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      [1, 3].forEach(function (m) { var v = m * Math.pow(10, k); if (v >= lo && v <= hi) { vals.push(v); text.push(compact(v)); } });
    }
    return { tickmode: 'array', tickvals: vals, ticktext: text };
  }
  function axisBase(t, title) {
    return { gridcolor: t.grid, zeroline: false, linecolor: t.axis, automargin: true, fixedrange: true,
             tickfont: { color: t.muted, size: 11 }, title: { text: title, font: { size: 11, color: t.muted }, standoff: 6 } };
  }
  function shortRegion(s) { return s.replace(/^Region [IVX]+-?[AB]? \((.*)\)$/, '$1').replace(/ \(.*\)$/, ''); }

  function drawCharts(all, gaps) {
    var t = U().theme(), cfg = U().config, Plotly = root.Plotly;

    // 1. Median asking price by region (the 8 regions with the most listings)
    var byRegion = groupBy(all, 'rg', function (r) { return r.p; });
    var regs = Object.keys(byRegion).map(function (k) { return { name: k, n: byRegion[k].length, med: median(byRegion[k]) }; })
      .sort(function (a, b) { return b.n - a.n; }).slice(0, 8).sort(function (a, b) { return a.med - b.med; });
    var rEl = el('d-region');
    if (regs.length) {
      var top = Math.max.apply(null, regs.map(function (r) { return r.med; }));
      Plotly.react(rEl, [{ type: 'bar', orientation: 'h', x: regs.map(function (r) { return r.med; }), y: regs.map(function (r) { return shortRegion(r.name); }),
        marker: { color: t.accent }, text: regs.map(function (r) { return compact(r.med); }), textposition: 'outside', cliponaxis: false,
        hovertext: regs.map(function (r) { return r.name + '<br>Median ' + money(r.med) + '<br>' + group(r.n) + ' listings'; }), hoverinfo: 'text' }],
        U().baseLayout(t, { margin: { l: 130, r: 56, t: 8, b: 36 }, hovermode: 'closest',
          xaxis: Object.assign(axisBase(t, 'Median asking price'), { range: [0, top * 1.18], tickformat: '.2s', tickprefix: PESO }),
          yaxis: Object.assign(axisBase(t), { automargin: true }) }), cfg);
      el('d-sum-region').textContent = 'Median asking price in the ' + regs.length + ' regions with the most listings in your data. The priciest is ' + regs[regs.length - 1].name + ' at ' + money(regs[regs.length - 1].med) + '.';
    } else {
      Plotly.purge(rEl);
      el('d-sum-region').textContent = 'None of your listings has a region, so this chart cannot be drawn.';
    }

    // 2. Price spread by type
    var lo = Infinity, hi = 0, traces = [];
    TYPES.forEach(function (ty) {
      var ys = all.filter(function (r) { return r.t === ty; }).map(function (r) { return r.p; });
      if (!ys.length) return;
      ys.forEach(function (v) { lo = Math.min(lo, v); hi = Math.max(hi, v); });
      var col = cv('--type-' + ty);
      traces.push({ type: 'box', name: NAMES[ty] + ' (' + group(ys.length) + ')', y: ys, boxpoints: false, line: { color: col, width: 1.6 }, fillcolor: col + '33', hoverinfo: 'y' });
    });
    Plotly.react(el('d-box'), traces, U().baseLayout(t, { margin: { l: 56, r: 16, t: 8, b: 48 }, hovermode: 'closest',
      xaxis: Object.assign(axisBase(t), { automargin: true }),
      yaxis: Object.assign(axisBase(t), { type: 'log' }, priceTicks(lo, hi)) }), cfg);
    el('d-sum-box').textContent = 'The box covers the middle half of asking prices for each property type, the line inside is the median, and the whiskers reach the extremes the box rule allows. The price axis is logarithmic.';

    // 3. Asking vs estimate
    var sample = q('SELECT property_type AS t, city, price_php AS p, predicted_price_php AS e FROM listings WHERE predicted_price_php IS NOT NULL ORDER BY RANDOM() LIMIT 2500');
    var slo = Infinity, shi = 0, st = [];
    sample.forEach(function (r) { slo = Math.min(slo, r.p, r.e); shi = Math.max(shi, r.p, r.e); });
    TYPES.forEach(function (ty) {
      var rs = sample.filter(function (r) { return r.t === ty; });
      if (!rs.length) return;
      st.push({ type: 'scatter', mode: 'markers', name: NAMES[ty], x: rs.map(function (r) { return r.p; }), y: rs.map(function (r) { return r.e; }),
        marker: { size: 6, symbol: SYMBOL[ty], color: cv('--type-' + ty), opacity: 0.6 },
        hovertext: rs.map(function (r) { return NAMES[ty] + ' in ' + (r.city || '(not specified)') + '<br>Asking ' + money(r.p) + '<br>Model estimate ' + money(r.e); }), hoverinfo: 'text' });
    });
    st.push({ type: 'scatter', mode: 'lines', name: 'Equal', x: [slo, shi], y: [slo, shi], line: { color: t.ink2, width: 1.5 }, hoverinfo: 'skip' });
    var tk = priceTicks(slo, shi);
    Plotly.react(el('d-scatter'), st, U().baseLayout(t, { margin: { l: 64, r: 16, t: 40, b: 48 }, hovermode: 'closest',
      showlegend: true, legend: { orientation: 'h', x: 0, y: 1.12, font: { color: t.ink2, size: 12 } },
      xaxis: Object.assign(axisBase(t, 'Asking price (log scale)'), { type: 'log' }, tk),
      yaxis: Object.assign(axisBase(t, 'Model estimate (log scale)'), { type: 'log', scaleanchor: 'x', scaleratio: 1 }, tk) }), cfg);
    el('d-sum-scatter').textContent = 'Each marker is one of your listings' + (sample.length >= 2500 ? ' (a random 2,500)' : '') + '. On the line means the asking price equals the model\'s estimate; above it means the model estimates more than the seller asks.';

    // 4. Median gap by type
    var byType = groupBy(gaps, 't', function (r) { return r.g; });
    var ts = TYPES.filter(function (ty) { return byType[ty]; }).map(function (ty) { return { t: ty, m: median(byType[ty]), n: byType[ty].length }; });
    var gmax = Math.max.apply(null, ts.map(function (x) { return Math.abs(x.m); }).concat([0.1]));
    Plotly.react(el('d-gap'), [{ type: 'bar', x: ts.map(function (x) { return NAMES[x.t]; }), y: ts.map(function (x) { return x.m * 100; }),
      marker: { color: ts.map(function (x) { return x.m >= 0 ? t.accent : t.down; }) }, text: ts.map(function (x) { return (x.m > 0 ? '+' : '') + pctText(x.m); }),
      textposition: 'outside', cliponaxis: false,
      hovertext: ts.map(function (x) { return NAMES[x.t] + ': median gap ' + pctText(x.m) + ' over ' + group(x.n) + ' listings'; }), hoverinfo: 'text' }],
      U().baseLayout(t, { margin: { l: 56, r: 16, t: 24, b: 40 }, hovermode: 'closest',
        xaxis: Object.assign(axisBase(t), { automargin: true }),
        yaxis: Object.assign(axisBase(t, 'Asking vs estimate'), { range: [-gmax * 135, gmax * 135], ticksuffix: '%', zerolinecolor: t.axis, zeroline: true }) }), cfg);
    el('d-sum-gap').textContent = 'Median difference between asking price and model estimate, by property type. Below zero: sellers ask less than the model estimates. Above zero: they ask more.';
  }

  /* ------------------------------------------------------------------ lifecycle */

  function show() {
    if (drawn) { PLOTS.forEach(function (id) { root.Plotly.Plots.resize(el(id)); }); return; }
    if (db) { render(); return; }
    say('Starting the database…');
    el('d-empty').hidden = true;
    ensure().then(function () { say(''); el('d-empty').hidden = false; return render(); })
      .catch(function (e) { say(e.message, 'bad'); });
  }
  function invalidate() { if (drawn && db) render(); }

  function download() {
    var blob = new Blob([db.export()], { type: 'application/vnd.sqlite3' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'property_listings.sqlite';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function clearAll() {
    var b = el('d-clear');
    if (!clearArmed) {                 // two clicks instead of a browser dialog
      b.textContent = 'Click again to delete all stored data';
      clearArmed = setTimeout(function () { clearArmed = null; b.textContent = 'Clear stored data'; }, 4000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = null; b.textContent = 'Clear stored data';
    db.run('DELETE FROM listings'); db.run('DELETE FROM imports');
    drawn = false; say('All stored data was deleted.', 'good');
    save().then(render);
  }

  function init() {
    el('d-file').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (f.size > MAX_BYTES) { say(f.name + ' is ' + (f.size / 1048576).toFixed(0) + ' MB. This demo handles files up to ' + (MAX_BYTES / 1048576) + ' MB.', 'bad'); return; }
      f.arrayBuffer().then(function (buf) { handleFile(f.name, buf); });
    });
    el('d-sample').addEventListener('click', function () {
      fetch('sample/sample_listings.csv').then(function (r) { if (!r.ok) throw new Error(); return r.arrayBuffer(); })
        .then(function (buf) { handleFile('sample_listings.csv', buf); })
        .catch(function () { say('The sample file could not be loaded here. Download it with the link, then choose it with "Choose a file".', 'bad'); });
    });
    el('d-clear').addEventListener('click', clearAll);
    el('d-download').addEventListener('click', download);
    var zone = el('d-drop');
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files[0];
      if (!f) return;
      if (f.size > MAX_BYTES) { say(f.name + ' is too large for this demo (limit ' + (MAX_BYTES / 1048576) + ' MB).', 'bad'); return; }
      f.arrayBuffer().then(function (buf) { handleFile(f.name, buf); });
    });
  }

  root.MyData = { init: init, show: show, invalidate: invalidate };
})(globalThis);
