/*
 * Random Forest evaluator for the property price estimator.
 *
 * Walks the 300 exported trees (data/forest.js) after reproducing the fitted preprocessing
 * (data/lookup.js, LOOKUP.preproc). No DOM, no network, no libraries: it loads as a classic
 * <script> from file:// and also under Node (module.exports).
 *
 *   PriceModel.predict(inputs) -> { price, treePrices }
 *
 * inputs: { sqm, lot_area_m2, bedrooms, bathrooms, lat, lng, city, province, region,
 *           property_type }. null, undefined, NaN or an empty string means "blank".
 */
(function (root) {
  'use strict';

  var N_FEATURES = 13;
  var forest = null;   // decoded typed arrays
  var pre = null;      // preprocessing constants, with Maps built from the exported arrays

  function decodeBytes(chunks, total) {
    var bytes = new Uint8Array(total);
    var at = 0;
    for (var i = 0; i < chunks.length; i++) {
      var s = atob(chunks[i]);
      for (var j = 0; j < s.length; j++) bytes[at + j] = s.charCodeAt(j);
      at += s.length;
    }
    if (at !== total) throw new Error('forest data is incomplete (' + at + ' of ' + total + ' bytes)');
    return bytes;
  }

  /* Stored as byte planes (all first bytes, then all second bytes, ...); rebuild the elements. */
  function unshuffle(chunks, Type, count) {
    var w = Type.BYTES_PER_ELEMENT;
    var planes = decodeBytes(chunks, count * w);
    var out = new Type(count);
    var o = new Uint8Array(out.buffer);
    for (var k = 0; k < w; k++) {
      var plane = k * count;
      for (var j = 0; j < count; j++) o[j * w + k] = planes[plane + j];
    }
    return out;
  }

  /* Decode the forest and index the lookup tables. Safe to call again; later calls are no-ops.
     On disk, thresholds and child links exist only for internal nodes and leaf values only for
     leaves; they are expanded here into one array over all nodes so a walk is a plain loop. */
  function init(F, L) {
    if (forest) return;
    F = F || root.FOREST;
    L = L || root.LOOKUP;
    if (!F) throw new Error('data/forest.js did not load');
    if (!L || !L.preproc) throw new Error('data/lookup.js did not load');
    if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('big-endian platform not supported');
    var n = F.n_nodes, nInt = F.n_internal;
    var feat = new Int8Array(decodeBytes(F.feat, n).buffer);
    var thr = unshuffle(F.thr, Float32Array, nInt);
    var rt = unshuffle(F.right, Uint16Array, nInt);
    var leaf = unshuffle(F.leaf, Float32Array, n - nInt);
    var val = new Float32Array(n), right = new Uint16Array(n);
    for (var i = 0, a = 0, b = 0; i < n; i++) {
      if (feat[i] >= 0) { val[i] = thr[a]; right[i] = rt[a]; a++; } else { val[i] = leaf[b++]; }
    }
    if (a !== nInt || b !== n - nInt) throw new Error('forest data is inconsistent');
    forest = { nTrees: F.n_trees, offset: Uint32Array.from(F.offset), feat: feat, val: val, right: right };
    if (forest.offset[forest.nTrees] !== n) throw new Error('forest offsets do not match node count');
    // The base64 text is ~80 MB of strings; drop it so the page does not hold both copies.
    F.feat = F.thr = F.right = F.leaf = null;

    var p = L.preproc;
    var te = {};
    for (var k = 0; k < p.te.columns.length; k++) {
      var col = p.te.columns[k];
      var enc = p.te.encodings[col];
      var m = new Map();
      for (var i = 0; i < enc.names.length; i++) m.set(enc.names[i], enc.values[i]);
      te[col] = m;
    }
    pre = {
      medians: p.num.medians,
      teColumns: p.te.columns,
      teMostFrequent: p.te.most_frequent,
      teMean: p.te.target_mean,
      te: te,
      ohCategories: p.onehot.categories,
      ohMostFrequent: p.onehot.most_frequent
    };
  }

  function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'number' && isNaN(v)) ||
      (typeof v === 'string' && v.trim() === '');
  }
  function toNumber(v) { return isBlank(v) ? NaN : Number(v); }
  function toText(v) { return isBlank(v) ? null : String(v).trim(); }

  /* Raw form values -> the 13 model columns (float64). Mirrors app/predict.py::predict_price
     followed by the fitted ColumnTransformer. */
  function buildFeatures(inputs) {
    var x = new Float64Array(N_FEATURES);
    var type = toText(inputs.property_type);
    var sqm = toNumber(inputs.sqm);
    var lot = toNumber(inputs.lot_area_m2);

    // The condo lot-area back-fill lives outside the saved pipeline (training notebook step).
    if (isNaN(lot) && type === 'condo' && !isNaN(sqm)) lot = sqm;

    var num = [sqm, lot, toNumber(inputs.bedrooms), toNumber(inputs.bathrooms),
               toNumber(inputs.lat), toNumber(inputs.lng)];
    for (var i = 0; i < 6; i++) x[i] = isNaN(num[i]) ? pre.medians[i] : num[i];

    for (var k = 0; k < 3; k++) {
      var name = toText(inputs[pre.teColumns[k]]);
      if (name === null) name = pre.teMostFrequent[k];
      var enc = pre.te[pre.teColumns[k]].get(name);
      x[6 + k] = enc === undefined ? pre.teMean : enc;
    }

    if (type === null) type = pre.ohMostFrequent;
    for (var c = 0; c < pre.ohCategories.length; c++) x[9 + c] = pre.ohCategories[c] === type ? 1 : 0;
    return x;
  }

  /* sklearn casts the matrix to float32 before the trees, so do the same. */
  function walk(x32) {
    var feat = forest.feat, val = forest.val, right = forest.right, offset = forest.offset;
    var T = forest.nTrees;
    var out = new Float64Array(T);
    for (var t = 0; t < T; t++) {
      var base = offset[t];
      var i = base, f;
      while ((f = feat[i]) >= 0) i = x32[f] <= val[i] ? i + 1 : base + right[i];
      out[t] = val[i];
    }
    return out;
  }

  function predict(inputs) {
    if (!forest) init();
    var x = buildFeatures(inputs);
    for (var i = 0; i < N_FEATURES; i++) x[i] = Math.fround(x[i]);
    var tree = walk(x);
    var sum = 0;
    for (var t = 0; t < tree.length; t++) sum += tree[t];
    return { price: sum / tree.length, treePrices: tree };
  }

  var api = { init: init, predict: predict, buildFeatures: buildFeatures };
  root.PriceModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
