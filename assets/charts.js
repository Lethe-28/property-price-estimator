/*
 * Chart builders (Plotly, vendored). Each function draws into a div and returns a one-sentence
 * text summary for the chart's caption. Colours come from the CSS variables in style.css, so
 * light and dark follow the system setting; app.js redraws when that setting changes.
 * Price axes are drawn in log10 units on a linear axis with hand-made ticks, so bar widths and
 * ticks stay under our control.
 */
(function (root) {
  'use strict';

  var PESO = '₱', MINUS = '−';
  var CONFIG = { displayModeBar: false, responsive: true, scrollZoom: false, showTips: false };

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function theme() {
    return {
      ink: cssVar('--ink'), ink2: cssVar('--ink-2'), muted: cssVar('--muted'), grid: cssVar('--grid'),
      axis: cssVar('--axis'), surface: cssVar('--surface'), accent: cssVar('--accent'),
      wash: cssVar('--accent-wash'), down: cssVar('--down'), font: cssVar('--font')
    };
  }

  /* ---------- number formatting ---------- */
  function group(n) { return Math.round(n).toLocaleString('en-US'); }
  function money(v) { return (v < 0 ? MINUS : '') + PESO + group(Math.abs(v)); }
  function short(x) {
    return (x < 100 ? x.toFixed(1) : String(Math.round(x))).replace(/\.0$/, '');
  }
  function compact(v) {
    var a = Math.abs(v), s = v < 0 ? MINUS : '';
    if (a >= 1e9) return s + PESO + short(a / 1e9) + 'B';
    if (a >= 1e6) return s + PESO + short(a / 1e6) + 'M';
    if (a >= 1e3) return s + PESO + short(a / 1e3) + 'K';
    return s + PESO + Math.round(a);
  }
  function signed(v) { return (v > 0 ? '+' : '') + compact(v); }
  function pct(v) { return (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v * 100).toFixed(0) + '%'; }

  /* Ticks at 1-2-5 (or sparser) steps across [lo, hi], positioned in log10 units. */
  function logTicks(lo, hi, label) {
    var span = Math.log10(hi / lo), narrow = document.documentElement.clientWidth < 560;
    // Fewer ticks on a phone, or Plotly tilts the labels to make them fit.
    var mult = narrow ? (span <= 1.5 ? [1, 3] : [1]) : span <= 1.5 ? [1, 2, 3, 5, 7] : span <= 3.2 ? [1, 2, 5] : [1, 3];
    var vals = [], text = [];
    for (var k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
      for (var i = 0; i < mult.length; i++) {
        var v = mult[i] * Math.pow(10, k);
        if (v >= lo && v <= hi) { vals.push(Math.log10(v)); text.push(label(v)); }
      }
    }
    return { vals: vals, text: text };
  }
  function niceTicks(lo, hi, n) {
    var raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    var step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p, vals = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) vals.push(v);
    return vals;
  }

  function baseLayout(t, extra) {
    var l = {
      margin: { l: 8, r: 16, t: 8, b: 8 },
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: t.font, size: 12, color: t.ink2 },
      showlegend: false, dragmode: false,
      hoverlabel: { bgcolor: t.surface, bordercolor: t.axis, font: { family: t.font, size: 13, color: t.ink } }
    };
    for (var k in extra) l[k] = extra[k];
    return l;
  }
  function xAxis(t, ticks, range, extra) {
    var a = {
      range: range, tickmode: 'array', tickvals: ticks.vals, ticktext: ticks.text,
      gridcolor: t.grid, gridwidth: 1, linecolor: t.axis, zeroline: false, automargin: true,
      tickfont: { color: t.muted, size: 11 }, fixedrange: true
    };
    for (var k in extra) a[k] = extra[k];
    return a;
  }
  var HIDDEN_Y = { visible: false, fixedrange: true, range: [-1, 1] };

  /* ---------- 1. likely range / tree agreement ---------- */
  function range(el, d, view) {
    var t = theme(), lx = Math.log10, est = d.price, lo = d.lo, hi = d.hi, traces, layout, summary;
    if (view === 'trees') {
      var trees = Array.prototype.slice.call(d.treePrices).sort(function (a, b) { return a - b; });
      var mn = lx(trees[0]), mx = lx(trees[trees.length - 1]), nb = 28, w = (mx - mn) / nb || 0.01;
      var counts = new Array(nb).fill(0), tips = [];
      trees.forEach(function (p) { counts[Math.min(nb - 1, Math.floor((lx(p) - mn) / w))]++; });
      var xs = counts.map(function (_, i) { return mn + (i + 0.5) * w; });
      tips = counts.map(function (c, i) {
        return c + ' trees predicted ' + compact(Math.pow(10, mn + i * w)) + ' to ' + compact(Math.pow(10, mn + (i + 1) * w));
      });
      var top = Math.max.apply(null, counts);
      traces = [
        { type: 'bar', x: xs, y: counts, width: w * 0.88, marker: { color: t.accent }, hovertext: tips, hoverinfo: 'text' },
        { type: 'scatter', mode: 'lines', x: [lx(est), lx(est)], y: [0, top * 1.12], line: { color: t.ink, width: 2 },
          hoverinfo: 'skip' }
      ];
      var tk = logTicks(Math.pow(10, mn - 0.05), Math.pow(10, mx + 0.05), compact);
      layout = baseLayout(t, {
        margin: { l: 36, r: 16, t: 28, b: 8 }, bargap: 0,
        xaxis: xAxis(t, tk, [mn - 0.08, mx + 0.08]),
        yaxis: { fixedrange: true, gridcolor: t.grid, zeroline: false, tickfont: { color: t.muted, size: 11 },
                 title: { text: 'Trees', font: { size: 11, color: t.muted } }, rangemode: 'tozero' },
        annotations: [{ x: lx(est), y: top * 1.12, text: 'Estimate ' + compact(est), showarrow: false, yshift: 12,
                        font: { color: t.ink, size: 12 } }]
      });
      var q = function (p) { return trees[Math.min(trees.length - 1, Math.floor(p * trees.length))]; };
      summary = 'Half of the ' + trees.length + ' trees predicted between ' + money(q(0.25)) + ' and ' + money(q(0.75)) +
        '; the full spread is ' + money(trees[0]) + ' to ' + money(trees[trees.length - 1]) +
        '. This shows how much the trees agree, not how far the real price may be from the estimate.';
    } else {
      var pad = 0.12, r = [lx(lo) - pad, lx(hi) + pad];
      traces = [
        { type: 'scatter', mode: 'lines', x: [lx(lo), lx(hi)], y: [0, 0], line: { color: t.wash, width: 16 }, hoverinfo: 'skip' },
        { type: 'scatter', mode: 'markers', x: [lx(lo), lx(hi)], y: [0, 0], marker: { symbol: 'line-ns-open', size: 18, color: t.accent, line: { width: 3, color: t.accent } },
          hovertext: ['Low end ' + money(lo), 'High end ' + money(hi)], hoverinfo: 'text' },
        { type: 'scatter', mode: 'markers', x: [lx(est)], y: [0], marker: { size: 16, color: t.accent, line: { color: t.surface, width: 3 } },
          hovertext: ['Estimate ' + money(est)], hoverinfo: 'text' }
      ];
      layout = baseLayout(t, {
        margin: { l: 16, r: 16, t: 8, b: 8 },
        xaxis: xAxis(t, logTicks(Math.pow(10, r[0]), Math.pow(10, r[1]), compact), r),
        yaxis: HIDDEN_Y,
        annotations: [
          { x: lx(est), y: 0, yshift: 30, showarrow: false, text: 'Estimate ' + compact(est), font: { color: t.ink, size: 13 } },
          { x: lx(lo), y: 0, yshift: -30, showarrow: false, text: compact(lo), font: { color: t.ink2, size: 12 } },
          { x: lx(hi), y: 0, yshift: -30, showarrow: false, text: compact(hi), font: { color: t.ink2, size: 12 } }
        ]
      });
      summary = 'Estimate ' + money(est) + '. In testing, the actual asking price fell between ' + money(lo) + ' and ' + money(hi) +
        ' for 80% of ' + d.typeLabel + ' listings.';
    }
    root.Plotly.react(el, traces, layout, CONFIG);
    return summary;
  }

  /* ---------- 2. price against floor area ---------- */
  function area(el, d, onPick) {
    var t = theme(), lx = Math.log10;
    var hover = d.sqm.map(function (s, i) { return group(s) + ' m²: ' + money(d.price[i]); });
    // Straight segments between grid points: a forest is a step function, so no smoothing.
    var traces = [{ type: 'scatter', mode: 'lines', x: d.sqm.map(lx), y: d.price.map(lx), line: { color: t.accent, width: 2 },
                    hovertext: hover, hoverinfo: 'text' }];
    var inRange = d.current.sqm >= d.sqm[0] && d.current.sqm <= d.sqm[d.sqm.length - 1];
    if (inRange) {
      traces.push({ type: 'scatter', mode: 'markers+text', x: [lx(d.current.sqm)], y: [lx(d.current.price)], text: ['Your listing'], textposition: 'top center',
                    textfont: { color: t.ink, size: 12 }, marker: { size: 12, color: t.accent, line: { color: t.surface, width: 3 } },
                    hovertext: [group(d.current.sqm) + ' m²: ' + money(d.current.price)], hoverinfo: 'text', cliponaxis: false });
    }
    var all = d.price.concat([d.current.price]), lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var yr = [lx(lo) - 0.1, lx(hi) + 0.18];
    var yt = logTicks(Math.pow(10, yr[0]), Math.pow(10, yr[1]), compact);
    var xt = logTicks(d.sqm[0], d.sqm[d.sqm.length - 1], group);
    var layout = baseLayout(t, {
      margin: { l: 56, r: 16, t: 12, b: 40 }, hovermode: 'closest',
      xaxis: xAxis(t, xt, [lx(d.sqm[0]), lx(d.sqm[d.sqm.length - 1])],
                   { title: { text: 'Floor area (m², log scale)', font: { size: 11, color: t.muted }, standoff: 6 } }),
      yaxis: { fixedrange: true, range: yr, tickmode: 'array', tickvals: yt.vals, ticktext: yt.text, gridcolor: t.grid,
               zeroline: false, linecolor: t.axis, tickfont: { color: t.muted, size: 11 }, automargin: true }
    });
    root.Plotly.react(el, traces, layout, CONFIG);
    if (el.removeAllListeners) el.removeAllListeners('plotly_click');
    el.on('plotly_click', function (ev) {
      var p = ev.points && ev.points[0];
      if (p && p.curveNumber === 0) onPick(Math.round(Math.pow(10, p.x)));
    });
    return 'Changing only the floor area, from ' + group(d.sqm[0]) + ' to ' + group(d.sqm[d.sqm.length - 1]) + ' m² (the usual range for ' +
      d.typeLabel + ' listings), moves the estimate between ' + money(lo) + ' and ' + money(hi) + '. The line is jagged because the model is a set of ' +
      'decision trees, not a formula. Click the line to try another floor area.' +
      (inRange ? '' : ' Your floor area (' + group(d.current.sqm) + ' m²) is outside this range.');
  }

  /* ---------- 3. what changes this estimate ---------- */
  function drivers(el, d) {
    var t = theme(), items = d.items.slice().sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    var deltas = items.map(function (i) { return i.delta; });
    var maxPos = Math.max(0, Math.max.apply(null, deltas)), maxNeg = Math.max(0, -Math.min.apply(null, deltas));
    var maxAbs = Math.max(maxPos, maxNeg) || 1;
    var narrow = document.documentElement.clientWidth < 560;
    function valueText(i) { return Math.abs(i.delta) < 1 ? 'no change' : signed(i.delta) + ' (' + pct(i.delta / d.price) + ')'; }
    // On a phone there is no room beside the bars, so each value moves under its category name.
    var traces = [{
      type: 'bar', orientation: 'h',
      y: items.map(function (i) { return narrow ? i.label + '<br><b>' + valueText(i) + '</b>' : i.label; }),
      x: deltas, marker: { color: items.map(function (i) { return i.delta >= 0 ? t.accent : t.down; }) },
      text: narrow ? undefined : items.map(valueText), textposition: 'outside', cliponaxis: false, textfont: { color: t.ink, size: 12 },
      hovertext: items.map(function (i) { return i.hint + '<br>Estimate would change by ' + signed(i.delta) + ' to ' + money(d.price + i.delta); }),
      hoverinfo: 'text'
    }];
    var k = narrow ? 1.15 : 1.75;
    var layout = baseLayout(t, {
      margin: { l: narrow ? 8 : 120, r: 24, t: 8, b: 28 }, bargap: 0.62,
      xaxis: { range: [-(maxNeg > 0 ? maxNeg * k : maxAbs * 0.1), maxPos > 0 ? maxPos * k : maxAbs * 0.1],
               fixedrange: true, gridcolor: t.grid, zerolinecolor: t.axis, zerolinewidth: 1, linecolor: t.axis,
               tickfont: { color: t.muted, size: 11 }, automargin: true },
      yaxis: { autorange: 'reversed', fixedrange: true, automargin: true, tickfont: { color: t.ink, size: 12 }, ticklen: 0 }
    });
    // Compact peso ticks on the x axis.
    var tv = niceTicks(layout.xaxis.range[0], layout.xaxis.range[1], narrow ? 3 : 4);
    layout.xaxis.tickmode = 'array'; layout.xaxis.tickvals = tv; layout.xaxis.ticktext = tv.map(function (v) { return v === 0 ? PESO + '0' : signed(v); });
    root.Plotly.react(el, traces, layout, CONFIG);
    var big = items[0];
    return Math.abs(big.delta) < 1 ? 'No single group moves this estimate.' :
      'Biggest effect: if ' + big.name + ' were typical, the estimate would ' + (big.delta > 0 ? 'rise' : 'fall') + ' by ' + money(Math.abs(big.delta)) +
      '. "Typical" means the median listing of this property type; for location, the national average.';
  }

  /* ---------- 4. local market ---------- */
  function market(el, d) {
    var t = theme(), lx = Math.log10, e = d.entry, n = e[0], p05 = e[1], p25 = e[2], p50 = e[3], p75 = e[4], p95 = e[5];
    var lo = Math.min(p05, d.price) * 0.8, hi = Math.max(p95, d.price) * 1.25, r = [lx(lo), lx(hi)];
    var traces = [
      { type: 'scatter', mode: 'lines', x: [lx(p05), lx(p95)], y: [0, 0], line: { color: t.muted, width: 2 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'lines', x: [lx(p25), lx(p75)], y: [0, 0], line: { color: t.wash, width: 22 }, hoverinfo: 'skip' },
      { type: 'scatter', mode: 'markers', x: [lx(p05), lx(p25), lx(p50), lx(p75), lx(p95)], y: [0, 0, 0, 0, 0],
        marker: { symbol: 'line-ns-open', size: [12, 12, 24, 12, 12], color: t.ink2, line: { width: [2, 2, 3, 2, 2], color: t.ink2 } },
        hovertext: ['5th percentile ' + money(p05), '25th percentile ' + money(p25), 'Median ' + money(p50), '75th percentile ' + money(p75), '95th percentile ' + money(p95)],
        hoverinfo: 'text' },
      { type: 'scatter', mode: 'markers', x: [lx(d.price)], y: [0], marker: { symbol: 'diamond', size: 15, color: t.accent, line: { color: t.surface, width: 2 } },
        hovertext: ['Your estimate ' + money(d.price)], hoverinfo: 'text' }
    ];
    var layout = baseLayout(t, {
      margin: { l: 16, r: 16, t: 8, b: 8 },
      xaxis: xAxis(t, logTicks(lo, hi, compact), r), yaxis: HIDDEN_Y,
      annotations: [
        { x: lx(d.price), y: 0, yshift: 28, showarrow: false, text: 'Estimate ' + compact(d.price), font: { color: t.ink, size: 12 } },
        { x: lx(p50), y: 0, yshift: -28, showarrow: false, text: 'Median ' + compact(p50), font: { color: t.ink2, size: 12 } }
      ]
    });
    root.Plotly.react(el, traces, layout, CONFIG);
    var where = d.price < p05 ? 'below the cheapest 5%' : d.price < p25 ? 'in the lower quarter' : d.price <= p75 ? 'within the middle half'
      : d.price <= p95 ? 'in the upper quarter' : 'above the dearest 5%';
    return 'Compared with ' + group(n) + ' ' + d.typeLabel + ' listings in ' + d.placeLabel + ', the estimate sits ' + where +
      ' of asking prices (middle half ' + money(p25) + ' to ' + money(p75) + '; median ' + money(p50) + '). Whiskers show the 5th to 95th percentile.';
  }

  root.Charts = {
    range: range, area: area, drivers: drivers, market: market, money: money, compact: compact,
    util: { theme: theme, baseLayout: baseLayout, xAxis: xAxis, logTicks: logTicks, niceTicks: niceTicks, group: group,
            signed: signed, config: CONFIG, hiddenY: HIDDEN_Y }
  };
})(globalThis);
