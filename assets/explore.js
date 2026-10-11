/*
 * "Explore the model" charts and the figures on the About tab.
 *
 * Nothing here is typed in by hand: every number comes from PERF, which holds results/metrics.json
 * and results/analysis.json verbatim plus a few facts from the dataset manifest. Elements marked
 * data-src="metrics.holdout.RandomForestRegression.r2" data-fmt="r4" are filled from that path.
 * Charts are drawn the first time the tab is shown (a hidden tab has no width) and redrawn when
 * the system light/dark setting changes.
 */
(function (root) {
  'use strict';

  var U = root.Charts.util, money = root.Charts.money, compact = root.Charts.compact, group = U.group;
  var PESO = '₱', MINUS = '−';
  var TYPES = ['house', 'condo', 'lot', 'commercial'];
  var NAMES = { house: 'House', condo: 'Condo', lot: 'Lot', commercial: 'Commercial' };
  // Marker shape is a second channel, because the fourth type is only a neutral grey.
  var SYMBOL = { house: 'circle', condo: 'square', lot: 'diamond', commercial: 'x' };
  var MODELS = [['RandomForestRegression', 'Random Forest', '--model-rf'], ['XGBoostRegression', 'XGBoost', '--model-xgb']];
  var PLOTS = ['x-scatter', 'x-acc-r2', 'x-acc-err', 'x-acc-w50', 'x-importance', 'x-spatial', 'x-dist'];

  var P, drawn = false, impView = 'r2';

  function el(id) { return document.getElementById(id); }
  function cv(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function hexA(hex, a) {
    var n = parseInt(hex.replace('#', ''), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function get(path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, P);
  }

  /* ---------- formats (the test script mirrors these) ---------- */
  var FMT = {
    int: function (v) { return group(v); },
    r2: function (v) { return (v < 0 ? MINUS : '') + Math.abs(v).toFixed(2); },
    r4: function (v) { return (v < 0 ? MINUS : '') + Math.abs(v).toFixed(4); },
    pct0: function (v) { return v.toFixed(0) + '%'; },
    pct1: function (v) { return v.toFixed(1) + '%'; },
    php: function (v) { return PESO + group(v); },
    text: function (v) { return String(v); }
  };

  function fill() {
    document.querySelectorAll('[data-src]').forEach(function (n) {
      var v = get(n.dataset.src);
      if (v === undefined) throw new Error('data.js is missing ' + n.dataset.src);
      n.textContent = FMT[n.dataset.fmt](v);
    });
  }

  /* ---------- 1. predicted against actual ---------- */
  function scatter() {
    var t = U.theme(), S = P.sample, lx = Math.log10, traces = [];
    TYPES.forEach(function (ty) {
      var idx = [];
      S.type.forEach(function (k, i) { if (S.types[k] === ty) idx.push(i); });
      traces.push({
        type: 'scatter', mode: 'markers', name: NAMES[ty] + ' (' + idx.length + ')',
        x: idx.map(function (i) { return lx(S.actual[i]); }), y: idx.map(function (i) { return lx(S.predicted[i]); }),
        marker: { size: 6, symbol: SYMBOL[ty], color: cv('--type-' + ty), opacity: 0.6 },
        hovertext: idx.map(function (i) { return NAMES[ty] + ' in ' + S.cities[S.city[i]] + '<br>Actual ' + money(S.actual[i]) + '<br>Predicted ' + money(S.predicted[i]); }),
        hoverinfo: 'text'
      });
    });
    var lo = 5.4, hi = 9.1, tk = U.logTicks(Math.pow(10, lo), Math.pow(10, hi), compact);
    traces.push({ type: 'scatter', mode: 'lines', name: 'Perfect prediction', x: [lo, hi], y: [lo, hi], line: { color: t.ink2, width: 1.5 }, hoverinfo: 'skip' });
    var ax = function (title) {
      return U.xAxis(t, tk, [lo, hi], { title: { text: title, font: { size: 11, color: t.muted }, standoff: 6 }, fixedrange: true });
    };
    var layout = U.baseLayout(t, {
      margin: { l: 64, r: 16, t: 44, b: 48 }, hovermode: 'closest',
      showlegend: true, legend: { orientation: 'h', x: 0, y: 1.12, font: { color: t.ink2, size: 12 } },
      xaxis: ax('Actual asking price (log scale)'),
      yaxis: Object.assign(ax('Predicted price (log scale)'), { scaleanchor: 'x', scaleratio: 1 })
    });
    root.Plotly.react(el('x-scatter'), traces, layout, U.config);
    el('x-sum-scatter').textContent = 'Each marker is one listing the model never saw in training (' + group(S.n) + ' of ' + group(P.meta.test_rows) +
      ' test listings, sampled in proportion to property type). On the line means a perfect prediction; above it means the price was over-estimated. ' +
      'Click a type in the key to hide or show it.';
  }

  /* ---------- 2. accuracy by property type ---------- */
  function accuracy() {
    var t = U.theme(), A = P.analysis.by_property_type;
    function one(id, key, label, range, suffix) {
      var vals = TYPES.map(function (ty) { return A[ty][key]; });
      var txt = vals.map(function (v) { return key === 'r2' ? FMT.r2(v) : FMT.pct0(v); });
      root.Plotly.react(el(id), [{
        type: 'bar', x: TYPES.map(function (ty) { return NAMES[ty]; }), y: vals, text: txt, textposition: 'outside', cliponaxis: false,
        textfont: { color: t.ink, size: 12 }, marker: { color: TYPES.map(function (ty) { return cv('--type-' + ty); }) },
        hovertext: TYPES.map(function (ty, i) { return NAMES[ty] + ': ' + txt[i] + ' ' + label + '<br>' + group(A[ty].n) + ' test listings'; }), hoverinfo: 'text'
      }], U.baseLayout(t, {
        margin: { l: 40, r: 8, t: 22, b: 36 }, bargap: 0.45,
        xaxis: { fixedrange: true, linecolor: t.axis, tickfont: { color: t.ink2, size: 11 }, automargin: true },
        yaxis: { fixedrange: true, range: range, gridcolor: t.grid, zerolinecolor: t.axis, linecolor: t.axis, tickfont: { color: t.muted, size: 11 }, ticksuffix: suffix || '' }
      }), U.config);
    }
    var maxErr = Math.max.apply(null, TYPES.map(function (ty) { return A[ty].median_ape_pct; }));
    one('x-acc-r2', 'r2', 'R²', [Math.min(0, Math.min.apply(null, TYPES.map(function (ty) { return A[ty].r2; }))) - 0.02, 1]);
    one('x-acc-err', 'median_ape_pct', 'typical error', [0, maxErr * 1.2], '%');
    one('x-acc-w50', 'within_50_pct', 'of estimates within 50%', [0, 100], '%');
    var byErr = TYPES.slice().sort(function (a, b) { return A[a].median_ape_pct - A[b].median_ape_pct; });
    el('x-sum-accuracy').textContent = 'Condos and houses are estimated best (typical error ' + FMT.pct0(A[byErr[0]].median_ape_pct) + ' and ' + FMT.pct0(A[byErr[1]].median_ape_pct) +
      '). ' + NAMES[byErr[3]] + ' listings are the hardest (typical error ' + FMT.pct0(A[byErr[3]].median_ape_pct) + ', and only ' + FMT.pct0(A[byErr[3]].within_50_pct) +
      ' of estimates within 50% of the asking price). Typical error is the median absolute percentage error on the test listings.';
  }

  /* ---------- 3. what drives price ---------- */
  function importance() {
    var t = U.theme(), key = impView === 'log' ? 'drop_log_r2' : 'drop_r2', PI = P.analysis.permutation_importance;
    var groups = Object.keys(PI.RandomForestRegression.group).sort(function (a, b) {
      return PI.RandomForestRegression.group[b].drop_r2 - PI.RandomForestRegression.group[a].drop_r2;
    });
    var max = 0;
    var traces = MODELS.map(function (m) {
      var vals = groups.map(function (g) { return PI[m[0]].group[g][key]; });
      max = Math.max(max, Math.max.apply(null, vals));
      return { type: 'bar', orientation: 'h', name: m[1], y: groups, x: vals, marker: { color: cv(m[2]) }, text: vals.map(FMT.r2), textposition: 'outside',
               cliponaxis: false, textfont: { color: t.ink, size: 12 },
               hovertext: groups.map(function (g, i) { return m[1] + ': scrambling ' + g.toLowerCase() + ' costs ' + FMT.r2(vals[i]) + ' of R²'; }), hoverinfo: 'text' };
    });
    root.Plotly.react(el('x-importance'), traces, U.baseLayout(t, {
      margin: { l: 96, r: 24, t: 36, b: 44 }, barmode: 'group', bargap: 0.4, bargroupgap: 0.08,
      showlegend: true, legend: { orientation: 'h', x: 0, y: 1.16, font: { color: t.ink2, size: 12 } },
      xaxis: { range: [0, max * 1.22], fixedrange: true, gridcolor: t.grid, zeroline: false, linecolor: t.axis, tickfont: { color: t.muted, size: 11 },
               title: { text: 'Drop in R² when the group is scrambled', font: { size: 11, color: t.muted }, standoff: 6 } },
      yaxis: { autorange: 'reversed', fixedrange: true, automargin: true, tickfont: { color: t.ink, size: 12 }, ticklen: 0 }
    }), U.config);
    var top = groups[0], rf = PI.RandomForestRegression.group;
    el('x-sum-importance').textContent = 'The model is scrambled one group of inputs at a time and re-tested; the bigger the drop, the more it relied on that group. ' +
      'For the Random Forest, ' + top.toLowerCase() + ' matters most (' + FMT.r2(rf[top][key]) + '), then ' + groups[1].toLowerCase() + ' (' + FMT.r2(rf[groups[1]][key]) +
      '), then ' + groups[2].toLowerCase() + ' (' + FMT.r2(rf[groups[2]][key]) + '). ' +
      (impView === 'log' ? 'Log scale measures percentage errors, so cheap and dear listings count equally.' : 'Peso scale is dominated by the most expensive listings.');
  }

  /* ---------- 5. unseen-city test ---------- */
  function spatial() {
    var t = U.theme(), M = P.metrics, H = M.holdout, S = M.spatial_holdout;
    var cats = ['Random split<br>(' + group(H.RandomForestRegression.n_test) + ' listings)', S.city + ' held out<br>(' + group(S.n_test) + ' listings)'];
    var min = 0;
    var traces = MODELS.map(function (m) {
      var vals = [H[m[0]].r2, S.metrics[m[0]].r2];
      min = Math.min(min, Math.min.apply(null, vals));
      return { type: 'bar', name: m[1], x: cats, y: vals, marker: { color: cv(m[2]) }, text: vals.map(FMT.r2), textposition: 'outside', cliponaxis: false,
               textfont: { color: t.ink, size: 12 },
               hovertext: vals.map(function (v, i) { return m[1] + ', ' + cats[i].replace('<br>', ' ') + ': R² ' + FMT.r2(v); }), hoverinfo: 'text' };
    });
    root.Plotly.react(el('x-spatial'), traces, U.baseLayout(t, {
      margin: { l: 44, r: 16, t: 36, b: 52 }, barmode: 'group', bargap: 0.45, bargroupgap: 0.08,
      showlegend: true, legend: { orientation: 'h', x: 0, y: 1.16, font: { color: t.ink2, size: 12 } },
      xaxis: { fixedrange: true, linecolor: t.axis, tickfont: { color: t.ink, size: 12 }, automargin: true },
      yaxis: { fixedrange: true, range: [min * 1.3 - 0.05, 0.98], gridcolor: t.grid, zerolinecolor: t.ink2, zerolinewidth: 1.5, linecolor: t.axis,
               tickfont: { color: t.muted, size: 11 }, title: { text: 'R² (0 = no better than the average)', font: { size: 11, color: t.muted }, standoff: 6 } }
    }), U.config);
    var rf = S.metrics.RandomForestRegression.r2, xg = S.metrics.XGBoostRegression.r2;
    el('x-sum-spatial').textContent = 'The same models, retrained with every ' + S.city + ' listing removed, then tested on ' + S.city + '. This is the situation of someone pricing a city the model has not seen.';
    el('x-spatial-text').textContent = ' With ' + S.city + ' held out, the Random Forest’s R² fell from ' + FMT.r2(H.RandomForestRegression.r2) + ' to ' + FMT.r2(rf) +
      ' and XGBoost’s from ' + FMT.r2(H.XGBoostRegression.r2) + ' to ' + FMT.r2(xg) + '. ' + (rf < 0 && xg < 0 ? 'Below 0 means worse than always guessing the average price. ' : '') +
      'Do not rely on estimates for a city that is not in the training data.';
  }

  /* ---------- 6. price distribution ---------- */
  function distribution() {
    var t = U.theme(), Hh = P.price_hist, e = Hh.edges_log10, traces = [], peak = 0;
    var centers = e.slice(0, -1).map(function (v, i) { return (v + e[i + 1]) / 2; });
    TYPES.forEach(function (ty) {
      var counts = Hh.counts[ty], total = counts.reduce(function (a, b) { return a + b; }, 0) + Hh.outside[ty];
      var share = counts.map(function (c) { return c / total * 100; });
      peak = Math.max(peak, Math.max.apply(null, share));
      var col = cv('--type-' + ty);
      traces.push({ type: 'scatter', mode: 'lines', name: NAMES[ty], x: centers, y: share, fill: 'tozeroy', fillcolor: hexA(col, 0.1),
                    line: { color: col, width: 2, shape: 'linear' },
                    hovertext: share.map(function (s, i) { return NAMES[ty] + ', ' + compact(Math.pow(10, e[i])) + ' to ' + compact(Math.pow(10, e[i + 1])) + ': ' + group(counts[i]) + ' listings (' + s.toFixed(1) + '% of ' + ty + 's)'; }),
                    hoverinfo: 'text' });
    });
    var tk = U.logTicks(Math.pow(10, e[0]), Math.pow(10, e[e.length - 1]), compact);
    root.Plotly.react(el('x-dist'), traces, U.baseLayout(t, {
      margin: { l: 52, r: 16, t: 40, b: 48 }, hovermode: 'closest',
      showlegend: true, legend: { orientation: 'h', x: 0, y: 1.12, font: { color: t.ink2, size: 12 } },
      xaxis: U.xAxis(t, tk, [e[0], e[e.length - 1]], { title: { text: 'Asking price (log scale)', font: { size: 11, color: t.muted }, standoff: 6 } }),
      yaxis: { fixedrange: true, range: [0, peak * 1.1], gridcolor: t.grid, zeroline: false, linecolor: t.axis, ticksuffix: '%', tickfont: { color: t.muted, size: 11 },
               title: { text: 'Share of that type’s listings', font: { size: 11, color: t.muted }, standoff: 6 } }
    }), U.config);
    var med = P.analysis.price_distribution.by_type_median;
    el('x-sum-dist').textContent = 'Each curve shows how one property type’s asking prices spread out, over ' + group(P.analysis.price_distribution.n) + ' listings. ' +
      'Typical (median) asking prices: ' + TYPES.map(function (ty) { return ty + ' ' + FMT.php(med[ty]); }).join(', ') + '. Prices stretch over several orders of magnitude, which is why the axis is logarithmic.';
  }

  /* ---------- lifecycle ---------- */
  function draw() { scatter(); accuracy(); importance(); spatial(); distribution(); drawn = true; }
  function show() {
    if (!drawn) draw();
    else PLOTS.forEach(function (id) { root.Plotly.Plots.resize(el(id)); });
  }
  function invalidate() { drawn = false; }
  function setImp(v) {
    impView = v;
    el('imp-r2').setAttribute('aria-pressed', String(v === 'r2'));
    el('imp-log').setAttribute('aria-pressed', String(v === 'log'));
    if (drawn) importance();
  }
  function init(perf) {
    P = perf;
    fill();
    el('imp-r2').addEventListener('click', function () { setImp('r2'); });
    el('imp-log').addEventListener('click', function () { setImp('log'); });
  }

  root.Explore = { init: init, show: show, invalidate: invalidate, formats: FMT };
})(globalThis);
