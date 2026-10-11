// P3 gate: the Estimate tab works from file:// and reproduces the golden estimate.
//
//   node tests/web/app_gate.mjs [--app PropertyPriceEstimator] [--shots DIR]
//
// Opens index.html in headless Chrome exactly as a recipient would (file://), then checks the
// default scenario (the paper's condo, with the correctly spelled region) against
// tests/web/golden.json, exercises the inputs, and fails on any console error or any network
// request that is not a file:// URL. Exit code 1 on any failure.

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
const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'));
const fixed = golden.cases.find((c) => c.id === 'corrected_region_demo').expected;
const PESO = '₱', MINUS = '−';
const fmt = (v) => PESO + Math.round(v).toLocaleString('en-US');

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
const text = (b, sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()`);
const set = async (b, sel, value) => {
  await b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)};
    e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
  await b.settle(450);
};
const click = async (b, sel) => { await b.eval(`document.querySelector(${JSON.stringify(sel)}).click()`); await b.settle(450); };

const b = await launch({ width: 1280, height: 900 });
try {
  const t0 = Date.now();
  await b.open(url);
  console.log(`page ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await b.settle(600);

  // --- default scenario = the paper's demo with the correct region spelling
  check(await b.eval(`getComputedStyle(document.getElementById('loading')).display === 'none'`), 'loading overlay is gone once the app is ready');
  check(await text(b, '#price') === fmt(fixed), `default estimate ${await text(b, '#price')} equals golden ${fmt(fixed)}`);
  check(await b.eval(`document.getElementById('region').selectedOptions[0].textContent`) === 'Region XI (Davao Region)', 'region resolved to Region XI (Davao Region)');
  check(await b.eval(`document.getElementById('province').selectedOptions[0].textContent`) === 'Davao del Sur', 'province resolved to Davao del Sur');
  check((await text(b, '#badge')).startsWith('Familiar location'), 'Davao City shows the familiar-location badge');
  check((await text(b, '#range-line')).startsWith('Likely range'), `range line: ${await text(b, '#range-line')}`);
  for (const id of ['plot-range', 'plot-area', 'plot-drivers', 'plot-market'])
    check(await b.eval(`document.querySelectorAll('#${id} .main-svg').length > 0`), `chart ${id} rendered`);
  console.log('summaries:'); for (const id of ['sum-range', 'sum-area', 'sum-drivers', 'sum-market']) console.log('  -', await text(b, '#' + id));
  if (shots) await b.screenshot(join(shots, 'estimate-1280.png'));

  // --- chart interactions
  await click(b, '#view-trees');
  check((await text(b, '#sum-range')).includes('300 trees') && await b.eval(`document.querySelectorAll('#plot-range .bars .point').length >= 5`), 'Tree agreement view draws a histogram of the 300 trees');
  await click(b, '#view-range');
  check((await text(b, '#sum-range')).startsWith('Estimate'), 'toggle returns to the likely-range view');
  await b.eval(`document.getElementById('plot-area').emit('plotly_click', { points: [{ curveNumber: 0, x: Math.log10(100) }] })`);
  await b.settle(500);
  check(await b.eval(`document.getElementById('sqm').value`) === '100' && await text(b, '#price') !== fmt(fixed), `clicking the area chart at 100 m² sets the floor area; estimate ${await text(b, '#price')}`);
  await click(b, '[data-preset="condo-davao"]');

  // --- other presets and inputs
  await click(b, '[data-preset="house-qc"]');
  check((await text(b, '#price')).startsWith(PESO) && await text(b, '#price') !== fmt(fixed), `house in Quezon City estimates ${await text(b, '#price')}`);
  check(await b.eval(`document.getElementById('city').value`) === 'Quezon City', 'preset fills the city');
  await click(b, '[data-preset="lot-cebu"]');
  const lot = await text(b, '#price');
  check(lot.startsWith(PESO), `vacant lot in Cebu estimates ${lot}; note: ${await text(b, '#range-note')}`);

  // --- out-of-range input is flagged, never clamped
  await set(b, '#sqm', '20000');
  check((await text(b, '#sqm-msg')).includes('10,000 m²'), `sqm over the maximum is flagged: "${await text(b, '#sqm-msg')}"`);
  check(await text(b, '#price') === '—', 'no estimate is shown while an input is invalid');
  await set(b, '#sqm', '500');
  check(await text(b, '#sqm-msg') === '' && lot === await text(b, '#price'), 'fixing the input restores the same estimate');

  // --- unlisted city shows the unfamiliar-location warning with the R2 from metrics.json
  await click(b, '[data-preset="condo-davao"]');
  await click(b, '#unlisted');
  await set(b, '#city', 'Atlantis');
  const badge = await text(b, '#badge');
  const r2 = JSON.parse(readFileSync(join(project, 'results', 'metrics.json'), 'utf8')).spatial_holdout.metrics.RandomForestRegression.r2;
  const r2text = `R² = ${r2 < 0 ? MINUS : ''}${Math.abs(r2).toFixed(2)}`;
  check(badge.startsWith('Unfamiliar location') && badge.includes(r2text), `unseen city warns with ${r2text} from metrics.json`);
  check(await text(b, '#price') !== fmt(fixed), `unseen city changes the estimate to ${await text(b, '#price')}`);

  // --- typing a known city name fills the cascade
  await set(b, '#city', 'Silang');
  check(await b.eval(`document.getElementById('province').selectedOptions[0].textContent`) === 'Cavite', 'typing "Silang" selects Cavite');
  check(await b.eval(`document.getElementById('unlisted').checked`) === false, 'a known name leaves unlisted mode');

  // --- a city with no recorded province (blank province and region)
  const none = await b.eval(`(() => { const H = LOOKUP.hierarchy.cities; const i = H.province.findIndex((p, k) => p < 0 && H.n[k] >= 100); return H.name[i]; })()`);
  await set(b, '#city', none);
  check(await b.eval(`document.getElementById('region').selectedOptions[0].textContent.startsWith('Province not recorded')`), `"${none}" sits under "Province not recorded"`);
  check((await text(b, '#price')).startsWith(PESO), `"${none}" estimates ${await text(b, '#price')}`);

  // --- share link round trip from a non-default scenario, through a genuine page load
  await click(b, '[data-preset="house-qc"]');
  await set(b, '#bed', '5');
  const before = await text(b, '#price');
  const hash = await b.eval('location.hash');
  await b.send('Page.navigate', { url: 'about:blank' });
  await b.settle(300);
  await b.open(url + hash);
  await b.settle(500);
  check(before !== fmt(fixed) && await text(b, '#price') === before, `share link (${hash.length} chars) reloads the same scenario: ${before}`);
  check(await b.eval(`document.getElementById('bed').value`) === '5' && await b.eval(`document.getElementById('city').value`) === 'Quezon City', 'share link restores bedrooms and city');

  // --- narrow screen: no horizontal scroll
  await b.setViewport(390, 844); await b.settle(800);
  check(await b.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), '390 px wide: no horizontal page scroll');
  if (shots) await b.screenshot(join(shots, 'estimate-390.png'));

  // --- offline hygiene
  const external = b.requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('about:'));
  check(external.length === 0, `no network requests outside file:// (${b.requests.length} requests, ${external.length} external${external.length ? ': ' + external.slice(0, 3).join(', ') : ''})`);
  check(b.logs.length === 0, `no console errors or warnings${b.logs.length ? ': ' + JSON.stringify(b.logs.slice(0, 4)) : ''}`);
} catch (e) {
  failures.push(String(e));
  console.log('ERROR', e);
} finally {
  await b.close();
}
console.log(failures.length ? `\nGATE FAIL (${failures.length})` : '\nP3 GATE PASS');
process.exit(failures.length ? 1 : 0);
