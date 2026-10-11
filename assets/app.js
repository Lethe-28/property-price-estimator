/*
 * Property Price Estimator: UI and state.
 *
 * Everything loads through classic script elements (no fetch, no modules) so the page works when
 * opened straight from a folder (file://). Order: vendored Plotly, the data files, then
 * model.js and charts.js.
 */
(function () {
  'use strict';

  var PESO = '₱', MINUS = '−', NOT_SPECIFIED = '(not specified)';
  var TYPE_LABEL = { house: 'house', condo: 'condo', lot: 'lot', commercial: 'commercial' };
  var PRESETS = {
    // The paper's demonstration listing, including its hand-entered coordinates.
    'condo-davao': { type: 'condo', city: 'Davao City', sqm: '60', lot: '', bed: '3', bath: '2', lat: '7.07', lng: '125.61' },
    'house-qc': { type: 'house', city: 'Quezon City', sqm: '150', lot: '200', bed: '4', bath: '3' },
    'lot-cebu': { type: 'lot', city: 'Cebu City', sqm: '500', lot: '', bed: '0', bath: '0' }
  };
  var DEFAULT_PRESET = 'condo-davao';

  var $ = function (id) { return document.getElementById(id); };
  var L, P, H, B;                       // LOOKUP, PERF, hierarchy, numeric bounds
  var cityIndex, cityLower, provincesByRegion, citiesByProvince, citiesNoProvince;
  var state = null, last = null, cityTouched = false, timer = null, view = 'range', tab = 'estimate';

  /* ------------------------------------------------------------------ loading */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error(src)); };
      document.head.appendChild(s);
    });
  }
  function fail(message) {
    var box = $('loading');
    box.classList.add('failed');
    $('loading-text').textContent = message;
  }
  function boot() {
    Promise.all(['vendor/plotly-cartesian.min.js', 'data/lookup.js', 'data/perf.js', 'data/forest.js'].map(loadScript))
      .then(function () { return loadScript('assets/model.js'); })
      .then(function () { return loadScript('assets/charts.js'); })
      .then(function () { return loadScript('assets/explore.js'); })
      .then(function () { return loadScript('assets/mydata.js'); })
      .then(function () {
        $('loading-text').textContent = 'Preparing the model…';
        return new Promise(function (r) { setTimeout(r, 30); });   // let that message paint first
      })
      .then(start)
      .catch(function (e) {
        var missing = e && e.message && /\.js$/.test(e.message);
        fail(missing ? 'Could not load ' + e.message + '. Unzip the whole folder, keep its files together, and reload this page.'
                     : 'Something went wrong while starting: ' + (e && e.message ? e.message : e));
      });
  }

  /* ------------------------------------------------------------------ start */

  function start() {
    PriceModel.init();
    L = globalThis.LOOKUP; P = globalThis.PERF; H = L.hierarchy; B = L.bounds;
    buildIndexes();
    $('sqm').max = B.sqm[1]; $('lot').max = B.lot_area_m2[1];
    Explore.init(P);
    MyData.init();
    if (!readHash()) { state = blankState(); applyPreset(PRESETS[DEFAULT_PRESET]); }
    syncForm();
    bind();
    watchResult();
    showTab(tab, true);
    $('loading').hidden = true;
    $('main').hidden = false;
    update();
    document.documentElement.setAttribute('data-ready', '1');
  }

  function buildIndexes() {
    cityIndex = new Map(); cityLower = new Map();
    H.cities.name.forEach(function (n, i) { cityIndex.set(n, i); cityLower.set(n.toLowerCase(), n); });
    provincesByRegion = H.regions.map(function () { return []; });
    H.provinces.region.forEach(function (r, p) { provincesByRegion[r].push(p); });
    citiesByProvince = H.provinces.name.map(function () { return []; });
    citiesNoProvince = [];
    H.cities.province.forEach(function (p, i) { (p < 0 ? citiesNoProvince : citiesByProvince[p]).push(i); });
  }

  /* ------------------------------------------------------------------ state */

  function blankState() {
    return { region: '', province: '', city: '', unlisted: false, type: 'condo', sqm: '60', lot: '', bed: '3', bath: '2',
             lat: '', lng: '', geoAuto: true };
  }
  function applyPreset(p) {
    state = Object.assign(blankState(), p, { city: '', lat: '', lng: '' });
    setCity(p.city);
    if (p.lat !== undefined) { state.lat = p.lat; state.lng = p.lng; state.geoAuto = false; }
  }
  /* Choosing a known city fills region, province and the city's typical coordinates. */
  function setCity(name) {
    var i = cityIndex.get(name), p = H.cities.province[i];
    state.city = name; state.unlisted = false; state.geoAuto = true; cityTouched = false;
    if (p < 0) { state.region = 'none'; state.province = ''; }
    else { state.region = String(H.provinces.region[p]); state.province = String(p); }
    state.lat = H.cities.lat[i] === null ? '' : String(H.cities.lat[i]);
    state.lng = H.cities.lng[i] === null ? '' : String(H.cities.lng[i]);
  }

  /* ------------------------------------------------------------------ form <-> state */

  function option(value, text) { var o = document.createElement('option'); o.value = value; o.textContent = text; return o; }

  function populateRegions() {
    var sel = $('region'); sel.textContent = '';
    sel.appendChild(option('', state.unlisted ? 'Not specified' : 'Choose a region'));
    H.regions.forEach(function (name, i) { sel.appendChild(option(String(i), name)); });
    if (!state.unlisted) sel.appendChild(option('none', 'Province not recorded (' + citiesNoProvince.length + ' places)'));
    sel.value = state.region;
    if (sel.value !== state.region) { state.region = ''; sel.value = ''; }
  }
  function populateProvinces() {
    var sel = $('province'); sel.textContent = '';
    if (state.region === '' || state.region === 'none') {
      sel.appendChild(option('', state.region === 'none' ? 'Not applicable' : state.unlisted ? 'Not specified' : 'Choose a region first'));
      sel.disabled = true; state.province = '';
    } else {
      sel.disabled = false;
      sel.appendChild(option('', state.unlisted ? 'Not specified' : 'Any province in this region'));
      provincesByRegion[+state.region].forEach(function (p) { sel.appendChild(option(String(p), H.provinces.name[p])); });
      sel.value = state.province;
      if (sel.value !== state.province) { state.province = ''; sel.value = ''; }
    }
  }
  function populateCityList() {
    var list = $('citylist'), ids;
    if (state.unlisted) ids = [];
    else if (state.province !== '') ids = citiesByProvince[+state.province];
    else if (state.region === 'none') ids = citiesNoProvince;
    else if (state.region !== '') ids = [].concat.apply([], provincesByRegion[+state.region].map(function (p) { return citiesByProvince[p]; }));
    else ids = H.cities.name.map(function (_, i) { return i; });
    list.textContent = '';
    ids.forEach(function (i) { var o = document.createElement('option'); o.value = H.cities.name[i]; list.appendChild(o); });
  }
  function sliderFromSqm(v) { return Math.round(1000 * Math.cbrt(Math.min(Math.max(v, 0), B.sqm[1]) / B.sqm[1])); }
  function sqmFromSlider(s) { return Math.round(B.sqm[1] * Math.pow(s / 1000, 3)); }

  function syncSlider() {
    $('sqm-range').value = sliderFromSqm(+state.sqm || 0);
    $('sqm-range').setAttribute('aria-valuetext', state.sqm === '' ? 'no value' : state.sqm + ' square metres');
  }

  function syncForm() {
    populateRegions(); populateProvinces(); populateCityList();
    $('city').value = state.city;
    $('unlisted').checked = state.unlisted;
    $('city').placeholder = state.unlisted ? 'Type the city name' : 'Start typing a city';
    $('city-hint').textContent = state.unlisted
      ? 'This city is not in the training data, so the model uses the national average for it. Choosing a region and province still helps.'
      : '';
    document.querySelectorAll('input[name="ptype"]').forEach(function (r) { r.checked = r.value === state.type; });
    $('sqm').value = state.sqm; syncSlider();
    $('lot').value = state.lot; $('bed').value = state.bed; $('bath').value = state.bath;
    $('lat').value = state.lat; $('lng').value = state.lng;
    syncSteppers();
    var ci = cityIndex.get(state.city), typicalPos = ci === undefined || H.cities.lat[ci] === null ? null : H.cities.lat[ci] + ', ' + H.cities.lng[ci];
    $('geo-hint').textContent = state.geoAuto
      ? (state.lat === '' ? 'No typical position is recorded for this place, so the national median is used. Enter coordinates to override.'
                          : "Filled in from the city's typical position. Change them to price a specific spot.")
      : 'Set by you' + (typicalPos ? '; this city’s typical position is ' + typicalPos : '') + '. Coordinates move the estimate noticeably.';
  }
  function syncSteppers() {
    document.querySelectorAll('[data-step]').forEach(function (b) {
      var v = Number($(b.dataset.step).value), d = +b.dataset.dir;
      b.disabled = (d < 0 && !(v > 0)) || (d > 0 && v >= 20);
    });
  }

  function cityPlacementMatches() {
    var i = cityIndex.get(state.city);
    if (i === undefined) return true;
    var p = H.cities.province[i];
    if (state.region === 'none') return p < 0;
    if (state.region !== '' && (p < 0 || String(H.provinces.region[p]) !== state.region)) return false;
    return state.province === '' || String(p) === state.province;
  }

  function bind() {
    $('region').addEventListener('change', function () {
      state.region = this.value; state.province = '';
      if (!state.unlisted && !cityPlacementMatches()) { state.city = ''; $('city').value = ''; }
      populateProvinces(); populateCityList(); schedule(0);
    });
    $('province').addEventListener('change', function () {
      state.province = this.value;
      if (!state.unlisted && !cityPlacementMatches()) { state.city = ''; $('city').value = ''; }
      populateCityList(); schedule(0);
    });
    $('city').addEventListener('input', function () {
      var typed = this.value, hit = cityLower.get(typed.trim().toLowerCase());
      if (hit) {                      // any text that names a known city is that city
        var wasUnlisted = state.unlisted;
        setCity(hit);
        populateRegions(); populateProvinces(); populateCityList();
        $('unlisted').checked = false;
        if (wasUnlisted) syncForm();
        $('lat').value = state.lat; $('lng').value = state.lng;
      } else { state.city = typed; }
      schedule(150);
    });
    $('city').addEventListener('change', function () {
      var hit = cityLower.get(this.value.trim().toLowerCase());
      if (hit) this.value = hit;
      cityTouched = true; schedule(0);
    });
    $('city').addEventListener('blur', function () { cityTouched = true; showErrors(validate().errors); });
    $('unlisted').addEventListener('change', function () {
      state.unlisted = this.checked;
      if (!state.unlisted && !cityIndex.has(state.city)) { state.city = ''; }
      if (state.unlisted && state.region === 'none') state.region = '';
      syncForm(); schedule(0);
    });
    document.querySelectorAll('input[name="ptype"]').forEach(function (r) {
      r.addEventListener('change', function () { if (this.checked) { state.type = this.value; schedule(0); } });
    });
    $('sqm').addEventListener('input', function () {
      state.sqm = this.value;
      if (this.value !== '' && isFinite(+this.value)) syncSlider();
      schedule(150);
    });
    $('sqm-range').addEventListener('input', function () {
      state.sqm = String(sqmFromSlider(+this.value)); $('sqm').value = state.sqm; syncSlider(); schedule(100);
    });
    ['lot', 'bed', 'bath'].forEach(function (id) {
      $(id).addEventListener('input', function () { state[id] = this.value; syncSteppers(); schedule(150); });
    });
    ['lat', 'lng'].forEach(function (id) {
      $(id).addEventListener('input', function () { state[id] = this.value; state.geoAuto = false; schedule(150); });
    });
    document.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.step, v = Math.round(Number($(id).value) || 0) + (+b.dataset.dir);
        v = Math.min(20, Math.max(0, v)); state[id] = String(v); $(id).value = state[id]; syncSteppers(); schedule(0);
      });
    });
    document.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(PRESETS[b.dataset.preset]); syncForm(); schedule(0); });
    });
    $('reset').addEventListener('click', function () { applyPreset(PRESETS[DEFAULT_PRESET]); syncForm(); schedule(0); });
    $('view-range').addEventListener('click', function () { setView('range'); });
    $('view-trees').addEventListener('click', function () { setView('trees'); });
    document.querySelectorAll('[role="tab"]').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.dataset.tab); });
      b.addEventListener('keydown', function (e) {
        var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')), i = tabs.indexOf(b), j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i + tabs.length - 1) % tabs.length;
        else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1;
        if (j >= 0) { e.preventDefault(); tabs[j].focus(); showTab(tabs[j].dataset.tab); }
      });
    });
    window.addEventListener('hashchange', function () {
      var restored = readHash();
      if (restored) syncForm();
      showTab(tab, true);
      if (restored) schedule(0);
    });
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', function () {
      if (last) drawCharts();
      Explore.invalidate();
      if (tab === 'explore') Explore.show();
      MyData.invalidate();
    });
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(update, ms); }

  function setView(v) {
    view = v;
    $('view-range').setAttribute('aria-pressed', String(v === 'range'));
    $('view-trees').setAttribute('aria-pressed', String(v === 'trees'));
    if (last) drawRange();
  }

  function showTab(name, quiet) {
    tab = name;
    document.querySelectorAll('[role="tab"]').forEach(function (b) {
      var on = b.dataset.tab === name; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    });
    ['estimate', 'explore', 'data', 'about'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    if (name === 'estimate' && last) {            // charts drawn while hidden have no width
      ['plot-range', 'plot-area', 'plot-drivers', 'plot-market'].forEach(function (id) { Plotly.Plots.resize($(id)); });
    }
    if (name === 'explore') Explore.show();
    if (name === 'data') MyData.show();
    if ($('pricebar')) updatePriceBar();
    if (!quiet) writeHash();
  }

  /* ------------------------------------------------------------------ validation */

  function num(s) { s = s == null ? '' : String(s).trim(); return s === '' ? null : Number(s); }
  function grp(n) { return n.toLocaleString('en-US'); }

  function validate() {
    var errors = {}, inputs = {};
    function field(key, id, label, bound, required, integer, unit) {
      var v = num(state[key]), u = unit ? ' ' + unit : '';
      if (v === null) { if (required) errors[id] = 'Enter ' + label + '.'; return null; }
      if (!isFinite(v)) { errors[id] = 'Enter a number.'; return null; }
      if (v < bound[0] || v > bound[1]) { errors[id] = label.charAt(0).toUpperCase() + label.slice(1) + ' must be between ' + grp(bound[0]) + u + ' and ' + grp(bound[1]) + u + '.'; return null; }
      if (integer && v % 1 !== 0) { errors[id] = 'Use a whole number.'; return null; }
      return v;
    }
    inputs.sqm = field('sqm', 'sqm', 'the floor area', B.sqm, true, false, 'm²');
    inputs.lot_area_m2 = field('lot', 'lot', 'the lot area', B.lot_area_m2, false, false, 'm²');
    inputs.bedrooms = field('bed', 'bed', 'the number of bedrooms', B.bedrooms, true, true);
    inputs.bathrooms = field('bath', 'bath', 'the number of bathrooms', B.bathrooms, true, true);
    inputs.lat = field('lat', 'lat', 'the latitude', B.lat, false, false, '°');
    inputs.lng = field('lng', 'lng', 'the longitude', B.lng, false, false, '°');
    inputs.property_type = state.type;

    var city = state.city.trim();
    if (!city) errors.city = state.unlisted ? 'Type the name of the city.' : "Choose a city from the list, or tick “My city isn't listed”.";
    else if (!state.unlisted && !cityIndex.has(city)) errors.city = '“' + city + "” is not in the list. Pick a suggestion, or tick “My city isn't listed”.";
    inputs.city = city;

    var i = cityIndex.get(city);
    if (i !== undefined) {                       // a known city carries its own province and region
      var p = H.cities.province[i];
      inputs.province = p < 0 ? null : H.provinces.name[p];          // null = blank, as in training
      inputs.region = p < 0 ? null : H.regions[H.provinces.region[p]];
    } else {
      inputs.province = state.province === '' ? NOT_SPECIFIED : H.provinces.name[+state.province];
      inputs.region = (state.region === '' || state.region === 'none') ? NOT_SPECIFIED : H.regions[+state.region];
    }
    return { ok: Object.keys(errors).length === 0, errors: errors, inputs: inputs };
  }

  function showErrors(errors) {
    ['city', 'sqm', 'lot', 'bed', 'bath', 'lat', 'lng'].forEach(function (id) {
      var msg = errors[id] && (id !== 'city' || cityTouched) ? errors[id] : '';
      $(id + '-msg').textContent = msg;
      $(id).setAttribute('aria-invalid', msg ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------------ update */

  function update() {
    var v = validate();
    showErrors(v.errors);
    document.querySelector('.results').classList.toggle('stale', !v.ok);
    if (!v.ok) {
      $('price').textContent = '—';
      $('range-line').textContent = '';
      $('range-note').textContent = 'Fix the highlighted input to see an estimate.';
      $('badge').hidden = true;
      setLive('No estimate. Fix the highlighted input.');
      $('pb-price').textContent = '\u2014';
      return;
    }
    var r = PriceModel.predict(v.inputs);
    last = { inputs: v.inputs, result: r };
    renderResult();
    drawCharts();
    writeHash();
  }

  function money(x) { return Charts.money(x); }
  function setLive(text) { if ($('live').textContent !== text) $('live').textContent = text; }

  /* On a phone the result sits below the form; show a compact price bar while it is off screen. */
  var resultVisible = true;
  function updatePriceBar() { $('pricebar').hidden = resultVisible || tab !== 'estimate'; }
  function watchResult() {
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (entries) { resultVisible = entries[0].isIntersecting; updatePriceBar(); }).observe($('result'));
    $('pricebar').addEventListener('click', function () {
      var calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      $('result').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
      $('result').focus({ preventScroll: true });
    });
  }

  function renderResult() {
    var inp = last.inputs, r = last.result, tq = P.ratio_quantiles[inp.property_type], lo = r.price * tq.q10, hi = r.price * tq.q90;
    last.lo = lo; last.hi = hi;
    $('price').textContent = money(r.price);
    $('range-line').textContent = 'Likely range ' + money(lo) + ' to ' + money(hi);
    setLive('Estimated asking price ' + money(r.price) + '. Likely range ' + money(lo) + ' to ' + money(hi) + '.');
    $('pb-price').textContent = money(r.price);
    var note = 'In testing, the actual asking price fell within this range for 80% of ' + TYPE_LABEL[inp.property_type] + ' listings.';
    if (inp.property_type === 'lot' || inp.property_type === 'commercial') note += ' Lots and commercial properties are much harder to estimate than houses and condos, so the range is wide.';
    $('range-note').textContent = note;
    renderBadge(inp);
  }

  var ICON = {
    good: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M6 10.5l3 3 5-6"/></svg>',
    warn: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3l8 14H2z"/><path d="M10 8.5v3.5M10 14.5v.5"/></svg>',
    bad: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M7 7l6 6M13 7l-6 6"/></svg>'
  };
  function renderBadge(inp) {
    var i = cityIndex.get(inp.city), kind, title, body;
    if (i === undefined) {
      var sp = P.metrics.spatial_holdout, r2 = sp.metrics.RandomForestRegression.r2;
      kind = 'bad'; title = 'Unfamiliar location';
      body = 'The model has not seen this city. In our test on an unseen city (' + sp.city + ' held out) it did worse than guessing the average (R² = ' +
        (r2 < 0 ? MINUS : '') + Math.abs(r2).toFixed(2) + ').';
    } else if (H.cities.n[i] >= 30) {
      kind = 'good'; title = 'Familiar location';
      body = grp(H.cities.n[i]) + ' listings from this city were in the training data.';
    } else {
      kind = 'warn'; title = 'Few examples for this city';
      body = 'Only ' + H.cities.n[i] + ' training listings, so this estimate is less reliable.';
    }
    if (i !== undefined && H.cities.province[i] < 0) body += ' No province is recorded for this place; the model treats it the way it did in training.';
    var badge = $('badge');
    badge.className = 'badge ' + kind; badge.hidden = false; badge.textContent = '';
    badge.insertAdjacentHTML('afterbegin', ICON[kind]);
    var wrap = document.createElement('div'), s = document.createElement('strong'), t = document.createElement('span');
    s.textContent = title; t.textContent = body; wrap.appendChild(s); wrap.appendChild(t); badge.appendChild(wrap);
  }

  /* ------------------------------------------------------------------ charts */

  function withVariant(inp, over) { return Object.assign({}, inp, over); }

  function drawCharts() { drawRange(); drawArea(); drawDrivers(); drawMarket(); }

  function drawRange() {
    var inp = last.inputs;
    $('sum-range').textContent = Charts.range($('plot-range'),
      { price: last.result.price, lo: last.lo, hi: last.hi, treePrices: last.result.treePrices, typeLabel: TYPE_LABEL[inp.property_type] }, view);
  }

  function drawArea() {
    var inp = last.inputs, sqm = [], price = [], n = 60, tp = L.typical[inp.property_type].sqm;
    // The usual size range for this property type, a little wider on each side.
    var lo = Math.max(5, tp[0] / 1.5), hi = Math.min(B.sqm[1], tp[2] * 1.5);
    for (var i = 0; i < n; i++) {
      var s = lo * Math.pow(hi / lo, i / (n - 1));
      sqm.push(s); price.push(PriceModel.predict(withVariant(inp, { sqm: s })).price);
    }
    $('sum-area').textContent = Charts.area($('plot-area'),
      { sqm: sqm, price: price, current: { sqm: inp.sqm, price: last.result.price }, typeLabel: TYPE_LABEL[inp.property_type] },
      function (picked) { state.sqm = String(picked); $('sqm').value = state.sqm; syncSlider(); schedule(0); });
  }

  function drawDrivers() {
    var inp = last.inputs, price = last.result.price, tp = L.typical[inp.property_type], typical = L.preproc.onehot.most_frequent;
    function delta(over) { return PriceModel.predict(withVariant(inp, over)).price - price; }
    function show(v, unit) { return v === null ? 'not recorded' : v + unit; }
    var items = [
      { label: 'Size<br>(area, lot, rooms)', name: 'its size',
        delta: delta({ sqm: tp.sqm[1], lot_area_m2: tp.lot_area_m2, bedrooms: tp.bedrooms, bathrooms: tp.bathrooms }),
        hint: 'Size set to the typical ' + TYPE_LABEL[inp.property_type] + ': ' + tp.sqm[1] + ' m² floor, lot ' + show(tp.lot_area_m2, ' m²') +
          ', bedrooms ' + show(tp.bedrooms, '') + ', bathrooms ' + show(tp.bathrooms, '') + '.' },
      { label: 'Location<br>(city, province, region)', name: 'its location', delta: delta({ city: NOT_SPECIFIED, province: NOT_SPECIFIED, region: NOT_SPECIFIED }),
        hint: 'City, province and region set to unknown, which the model prices at the national average.' },
      { label: 'Property type', name: 'its property type', delta: delta({ property_type: typical }),
        hint: 'Property type set to the most common one in the data (' + typical + ').' }
    ];
    $('sum-drivers').textContent = Charts.drivers($('plot-drivers'), { price: price, items: items });
  }

  /* Finest place with at least min_n listings of this type: city, province, region, then the whole country. */
  function marketFor(inp) {
    var M = L.market.levels, t = inp.property_type, tries = [];
    if (inp.city) tries.push(['city', inp.city, inp.city]);
    if (inp.province && inp.province !== NOT_SPECIFIED) tries.push(['province', inp.province, inp.province + ' (province)']);
    if (inp.region && inp.region !== NOT_SPECIFIED) tries.push(['region', inp.region, inp.region + ' (region)']);
    for (var i = 0; i < tries.length; i++) {
      var e = M[tries[i][0]][tries[i][1]]; e = e && e[t];
      if (e) return { entry: e, placeLabel: tries[i][2] };
    }
    return { entry: M.national[t], placeLabel: 'the whole Philippines' };
  }
  function drawMarket() {
    var inp = last.inputs, m = marketFor(inp);
    $('sum-market').textContent = Charts.market($('plot-market'),
      { price: last.result.price, entry: m.entry, placeLabel: m.placeLabel, typeLabel: TYPE_LABEL[inp.property_type] });
  }

  /* ------------------------------------------------------------------ share link (location.hash) */

  function writeHash() {
    if (!state) return;
    var q = new URLSearchParams();
    q.set('tab', tab); q.set('t', state.type); q.set('s', state.sqm); q.set('b', state.bed); q.set('ba', state.bath);
    if (state.lot !== '') q.set('l', state.lot);
    q.set('c', state.city);
    if (state.unlisted) {
      q.set('u', '1');
      if (state.region !== '' && state.region !== 'none') q.set('rg', H.regions[+state.region]);
      if (state.province !== '') q.set('pv', H.provinces.name[+state.province]);
    }
    if (!state.geoAuto) { q.set('la', state.lat); q.set('ln', state.lng); }
    var h = '#' + q.toString();
    try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
  }

  function readHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return false;
    var q = new URLSearchParams(raw);
    if (!q.has('c') && !q.has('tab')) return false;
    if (['estimate', 'explore', 'data', 'about'].indexOf(q.get('tab')) >= 0) tab = q.get('tab');
    if (!q.has('c')) return false;
    state = blankState();
    var type = q.get('t'); if (TYPE_LABEL[type]) state.type = type;
    state.sqm = q.get('s') || ''; state.bed = q.get('b') || ''; state.bath = q.get('ba') || ''; state.lot = q.get('l') || '';
    var city = q.get('c'), hit = cityLower.get(city.trim().toLowerCase());
    if (hit && q.get('u') !== '1') setCity(hit);
    else {
      state.city = city; state.unlisted = true; state.geoAuto = true;
      var rg = H.regions.indexOf(q.get('rg')); if (rg >= 0) state.region = String(rg);
      var pv = H.provinces.name.indexOf(q.get('pv')); if (pv >= 0) { state.province = String(pv); state.region = String(H.provinces.region[pv]); }
    }
    if (q.has('la') || q.has('ln')) { state.lat = q.get('la') || ''; state.lng = q.get('ln') || ''; state.geoAuto = false; }
    return true;
  }

  boot();
})();
