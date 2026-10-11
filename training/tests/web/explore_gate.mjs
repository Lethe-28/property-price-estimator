// P4 gate: every number on the Explore and About tabs matches the source files.
//
//   node tests/web/explore_gate.mjs [--app PropertyPriceEstimator] [--shots DIR]
//
// Reads results/metrics.json, results/analysis.json and dataset_manifest.json directly (it does not
// use the app's embedded copies), opens the page from file:// in headless Chrome, and compares:
//   - every element marked data-src (tables, About text) with the value at that path, formatted;
//   - the numbers inside each Explore chart (read back from Plotly) with the files;
//   - the generated warning and summary text, for the figures they quote.
// Also fails on console errors, non-file requests, or "NaN"/"undefined" appearing on screen.

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const appDir = resolve(project, arg('--app', 'PropertyPriceEstimator'));
const shots = arg('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });
const url = pathToFileURL(join(appDir, 'index.html')).href;

const readJson = (...p) => JSON.parse(readFileSync(join(project, ...p), 'utf8'));
const manifest = readJson('dataset_manifest.json');
const SRC = {
  metrics: readJson('results', 'metrics.json'),
  analysis: readJson('results', 'analysis.json'),
  dataset: { ...manifest.dataset, out_of_domain: manifest.data_quality.out_of_domain, missing_pct_deduplicated: manifest.data_quality.missing_pct_deduplicated },
};
const at = (path) => path.split('.').reduce((o, k) => o?.[k], SRC);

const PESO = '₱', MINUS = '−';
const sgn = (v, d) => (v < 0 ? MINUS : '') + Math.abs(v).toFixed(d);
const FMT = {
  int: (v) => Math.round(v).toLocaleString('en-US'),
  r2: (v) => sgn(v, 2), r4: (v) => sgn(v, 4),
  pct0: (v) => v.toFixed(0) + '%', pct1: (v) => v.toFixed(1) + '%',
  php: (v) => PESO + Math.round(v).toLocaleString('en-US'), text: (v) => String(v),
};

const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.log(`FAIL ${msg}`); } return ok; };
const close = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-9 * Math.max(1, Math.abs(b[i])));

const b = await launch({ width: 1280, height: 900 });
try {
  await b.open(url);
  const gdData = (id) => b.eval(`document.getElementById(${JSON.stringify(id)}).data.map(t => ({ name: t.name, x: t.x, y: t.y, text: t.text, visible: t.visible }))`);

  // ---- every data-src figure, including the hidden About tab
  const items = await b.eval(`[...document.querySelectorAll('[data-src]')].map(e => ({ src: e.dataset.src, fmt: e.dataset.fmt, text: e.textContent.trim() }))`);
  let bad = 0;
  for (const it of items) {
    const v = at(it.src);
    const want = v === undefined ? '(missing in source file)' : FMT[it.fmt](v);
    if (!check(it.text === want, `[data-src] ${it.src} shows "${it.text}", file gives "${want}"`)) bad++;
  }
  console.log(`data-src figures checked: ${items.length}, mismatches: ${bad}`);
  check(items.length >= 25, `expected at least 25 sourced figures, found ${items.length}`);

  // ---- Explore tab
  await b.eval(`document.getElementById('tabbtn-explore').click()`);
  await b.waitFor(`document.querySelectorAll('#x-dist .main-svg').length > 0`);
  await b.settle(700);
  const T = ['house', 'condo', 'lot', 'commercial'];
  const A = SRC.analysis.by_property_type;

  for (const [id, key] of [['x-acc-r2', 'r2'], ['x-acc-err', 'median_ape_pct'], ['x-acc-w50', 'within_50_pct']]) {
    const [tr] = await gdData(id);
    check(close(tr.y, T.map((t) => A[t][key])), `${id}: bars equal analysis.by_property_type.*.${key}`);
  }

  const PI = SRC.analysis.permutation_importance;
  const groupsFor = async () => (await gdData('x-importance'))[0].y;
  for (const [view, key, btn] of [['peso', 'drop_r2', 'imp-r2'], ['log', 'drop_log_r2', 'imp-log']]) {
    await b.eval(`document.getElementById(${JSON.stringify(btn)}).click()`);
    await b.settle(500);
    const traces = await gdData('x-importance'), groups = await groupsFor();
    check(groups.length === 3 && groups.join() === 'Size,Location,Property type', `importance order is ${groups.join(', ')}`);
    const models = { 'Random Forest': 'RandomForestRegression', XGBoost: 'XGBoostRegression' };
    for (const tr of traces)
      check(close(tr.x, groups.map((g) => PI[models[tr.name]].group[g][key])), `importance (${view}) ${tr.name}: bars equal permutation_importance.*.group.*.${key}`);
  }

  const M = SRC.metrics, sp = await gdData('x-spatial');
  for (const tr of sp) {
    const m = tr.name === 'Random Forest' ? 'RandomForestRegression' : 'XGBoostRegression';
    check(close(tr.y, [M.holdout[m].r2, M.spatial_holdout.metrics[m].r2]), `unseen-city chart ${tr.name}: [random split, held out] R2 equal metrics.json`);
  }
  const warn = await b.eval(`document.getElementById('x-spatial-warning').textContent`);
  const rf = M.spatial_holdout.metrics.RandomForestRegression.r2, xg = M.spatial_holdout.metrics.XGBoostRegression.r2;
  for (const v of [M.holdout.RandomForestRegression.r2, rf, M.holdout.XGBoostRegression.r2, xg])
    check(warn.includes(FMT.r2(v)), `unseen-city warning quotes ${FMT.r2(v)}`);
  check(warn.includes(M.spatial_holdout.city), 'unseen-city warning names the held-out city');

  const sc = await gdData('x-scatter');
  const dots = sc.filter((t) => t.name !== 'Perfect prediction');
  check(dots.length === 4 && dots.reduce((n, t) => n + t.x.length, 0) === 3000, `scatter has 4 type traces totalling ${dots.reduce((n, t) => n + t.x.length, 0)} points`);
  check(dots.every((t, i) => t.name.startsWith(['House', 'Condo', 'Lot', 'Commercial'][i])), 'scatter traces are House, Condo, Lot, Commercial');
  const dist = await gdData('x-dist');
  check(dist.length === 4 && dist.every((t) => t.y.reduce((a, c) => a + c, 0) > 99.9 && t.y.reduce((a, c) => a + c, 0) <= 100.0001), 'distribution curves each sum to 100% of their type');

  if (shots) await b.screenshot(join(shots, 'explore-1280.png'));

  // ---- legend click hides a type in the scatter (real mouse click)
  const box = await b.eval(`(() => { const r = document.querySelector('#x-scatter .legend .traces .legendtoggle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await b.settle(500);
  check((await gdData('x-scatter'))[0].visible === 'legendonly', 'clicking the legend hides the House points');

  // ---- nothing broken on screen
  const body = await b.eval(`document.body.innerText`);
  check(!/\bNaN\b|undefined|\[object/.test(body), 'no NaN / undefined / [object] on screen');
  await b.eval(`document.getElementById('tabbtn-about').click()`);
  await b.settle(400);
  if (shots) await b.screenshot(join(shots, 'about-1280.png'));
  await b.setViewport(390, 844);
  await b.eval(`document.getElementById('tabbtn-explore').click()`);
  await b.settle(900);
  check(await b.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'Explore at 390 px: no horizontal page scroll');
  if (shots) await b.screenshot(join(shots, 'explore-390.png'));
  await b.eval(`document.getElementById('tabbtn-about').click()`);
  await b.settle(400);
  check(await b.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'About at 390 px: no horizontal page scroll');

  const external = b.requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('about:'));
  check(external.length === 0, `no requests outside file:// (${external.slice(0, 3).join(', ')})`);
  check(b.logs.length === 0, `no console errors or warnings ${JSON.stringify(b.logs.slice(0, 3))}`);
} catch (e) {
  failures.push(String(e));
  console.log('ERROR', e);
} finally {
  await b.close();
}
console.log(failures.length ? `\nP4 GATE FAIL (${failures.length})` : '\nP4 GATE PASS');
process.exit(failures.length ? 1 : 0);
