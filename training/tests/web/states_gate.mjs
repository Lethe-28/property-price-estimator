// P5 gate: loading and failure states.
//
//   node tests/web/states_gate.mjs [--app PropertyPriceEstimator] [--shots DIR]
//
// Shows what a recipient sees when the app is still starting and when it cannot start: a data file
// missing (an incomplete unzip), a script missing, a corrupted forest file, and JavaScript switched
// off. Each broken case runs on a throwaway copy of the app; the real folder is never touched.

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const appDir = resolve(project, arg('--app', 'PropertyPriceEstimator'));
const shots = arg('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });
const realUrl = pathToFileURL(join(appDir, 'index.html')).href;

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); return ok; };

/* A copy of the app without the big forest file unless the case needs it. */
function copyApp(label, { keepForest = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `ppe-${label}-`));
  for (const f of ['index.html', 'assets', 'vendor']) cpSync(join(appDir, f), join(dir, f), { recursive: true });
  mkdirSync(join(dir, 'data'));
  for (const f of ['lookup.js', 'perf.js', ...(keepForest ? ['forest.js'] : [])]) cpSync(join(appDir, 'data', f), join(dir, 'data', f));
  return dir;
}

async function failCase(label, prep, expectText, shotName) {
  const dir = copyApp(label, { keepForest: label !== 'missing-forest' });
  prep(dir);
  const b = await launch({ width: 1000, height: 700 });
  try {
    await b.send('Page.navigate', { url: pathToFileURL(join(dir, 'index.html')).href });
    await b.waitFor(`document.getElementById('loading')?.classList.contains('failed')`, 90000);
    const msg = await b.eval(`document.getElementById('loading-text').textContent`);
    check(msg.includes(expectText), `${label}: message says "${msg}"`);
    check(await b.eval(`document.getElementById('main').hidden && getComputedStyle(document.querySelector('.spinner')).display === 'none'`), `${label}: no half-built page, no spinner`);
    check(await b.eval(`getComputedStyle(document.getElementById('loading-text')).color !== getComputedStyle(document.body).color`), `${label}: the message is styled as an error`);
    if (shots) await b.screenshot(join(shots, shotName), { fullPage: false });
  } finally { await b.close(); rmSync(dir, { recursive: true, force: true }); }
}

await failCase('missing-forest', () => {}, 'Could not load data/forest.js', 'state-missing-file.png');
await failCase('missing-script', (d) => rmSync(join(d, 'assets', 'charts.js')), 'Could not load assets/charts.js', 'state-missing-script.png');
await failCase('corrupt-forest', (d) => {
  const f = join(d, 'data', 'forest.js');
  writeFileSync(f, readFileSync(f, 'latin1').replace(/"leaf":\[[^\]]*\]/, '"leaf":[]'), 'latin1');
}, 'Something went wrong while starting', 'state-corrupt.png');

// ---- the loading screen while the model decodes, then the finished page
{
  const b = await launch({ width: 1000, height: 700 });
  try {
    await b.send('Page.navigate', { url: realUrl });
    await b.waitFor(`document.getElementById('loading-text')`, 20000);
    const early = await b.eval(`({ shown: !document.getElementById('loading').hidden && getComputedStyle(document.getElementById('loading')).display !== 'none',
      spinner: getComputedStyle(document.querySelector('.spinner')).display !== 'none', mainHidden: document.getElementById('main').hidden,
      text: document.getElementById('loading-text').textContent, ready: document.documentElement.dataset.ready === '1' })`);
    check(early.ready || (early.shown && early.spinner && early.mainHidden), `while starting: spinner and "${early.text}" are visible, the empty page is hidden`);
    if (shots && !early.ready) await b.screenshot(join(shots, 'state-loading.png'), { fullPage: false });
    await b.waitFor(`document.documentElement.dataset.ready === '1'`, 90000);
    check(await b.eval(`getComputedStyle(document.getElementById('loading')).display === 'none' && !document.getElementById('main').hidden`), 'once ready: the loading screen is gone and the app is shown');
  } finally { await b.close(); }
}

// ---- JavaScript switched off
{
  const b = await launch({ width: 1000, height: 700 });
  try {
    await b.send('Emulation.setScriptExecutionDisabled', { value: true });
    await b.send('Page.navigate', { url: realUrl });
    await b.settle(1500);
    const r = await b.eval(`({ spinnerShown: getComputedStyle(document.getElementById('loading')).display !== 'none', note: document.querySelector('.noscript')?.textContent.trim() ?? '' })`);
    check(!r.spinnerShown && r.note.includes('needs JavaScript'), `JavaScript off: no endless spinner, and the page says "${r.note}"`);
  } finally { await b.close(); }
}

console.log(failures.length ? `\nSTATES GATE FAIL (${failures.length})` : '\nSTATES GATE PASS');
process.exit(failures.length ? 1 : 0);
