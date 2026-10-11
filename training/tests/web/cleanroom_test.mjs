// Gate 2 (P6): the shipped zip works on a clean machine.
//
//   node tests/web/cleanroom_test.mjs [--zip dist/PropertyPriceEstimator.zip] [--shots DIR]
//
// Unzips the zip into a fresh folder OUTSIDE the project (with a space in its path, as a recipient's
// might have), then in each installed browser, with all network access blocked, opens index.html
// over file:// and checks: the estimate equals the golden value, no console errors, no network request
// of any kind, and that the block itself works. Finally runs the full browser gates against the
// unzipped copy. Reports the real zipped size. Exit code 1 on any failure.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const zip = resolve(project, arg('--zip', 'dist/PropertyPriceEstimator.zip'));
const shots = arg('--shots', null);
if (shots) mkdirSync(shots, { recursive: true });

const EXPECTED = ['README.txt', 'index.html', 'assets/app.js', 'assets/charts.js', 'assets/explore.js', 'assets/model.js', 'assets/style.css',
  'data/forest.js', 'data/lookup.js', 'data/perf.js', 'vendor/PLOTLY-LICENSE.txt', 'vendor/plotly-cartesian.min.js'];
const BROWSERS = [
  ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
  ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  ['Firefox', 'C:/Program Files/Mozilla Firefox/firefox.exe'],
];
const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'));
const fixed = golden.cases.find((c) => c.id === 'corrected_region_demo').expected;
const fmt = (v) => '\u20B1' + Math.round(v).toLocaleString('en-US');

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); return ok; };

// ---- unzip into an empty folder outside the project; python -I so nothing in that folder can be imported
check(existsSync(zip), `zip exists: ${zip}`);
const work = mkdtempSync(join(tmpdir(), 'ppe clean room '));
console.log(`extracting into: ${work}`);
const listing = spawnSync('python', ['-I', '-c', `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert all(not n.startswith('/') and '..' not in n.split('/') for n in names), 'unsafe path in zip'
z.extractall(sys.argv[2]); print('\\n'.join(names))`, zip, work], { encoding: 'utf8' });
check(listing.status === 0, `zip extracts cleanly${listing.status ? ': ' + listing.stderr : ''}`);
const names = listing.stdout.trim().split(/\r?\n/).map((n) => n.replace(/^PropertyPriceEstimator\//, '')).sort();
check(JSON.stringify(names) === JSON.stringify([...EXPECTED].sort()), `zip holds exactly the ${EXPECTED.length} expected files${names.length === EXPECTED.length ? '' : ' (found ' + names.length + ')'}`);
const appDir = join(work, 'PropertyPriceEstimator');
const zipBytes = statSync(zip).size;
console.log(`zipped size: ${(zipBytes / 1e6).toFixed(1)} MB (${zipBytes.toLocaleString('en-US')} bytes)`);
check(zipBytes <= 45_000_000, 'zipped size is within the 45 MB budget');
console.log('README.txt:\n' + readFileSync(join(appDir, 'README.txt'), 'utf8').split('\n').map((l) => '  ' + l).join('\n'));

const url = pathToFileURL(join(appDir, 'index.html')).href;
process.env.OFFLINE = '1';
process.env.THEME = 'light';
const available = BROWSERS.filter(([, p]) => existsSync(p));
for (const [name, p] of BROWSERS) if (!existsSync(p)) console.log(`note ${name} is not installed here, so it was not tested`);

// ---- each browser: open index.html the way a double-click does, with the network blocked
for (const [name, exe] of available) {
  console.log(`\n== ${name}: index.html over file://, network blocked ==`);
  const b = await launch({ width: 1280, height: 900, exe });
  try {
    const version = (await b.send('Browser.getVersion')).product;
    const t0 = Date.now();
    await b.open(url);
    const seconds = (Date.now() - t0) / 1000;
    await b.settle(600);
    const price = await b.eval(`document.getElementById('price').textContent.trim()`);
    check(price === fmt(fixed), `${version}: default estimate ${price} equals golden ${fmt(fixed)} (ready in ${seconds.toFixed(1)} s)`);
    const heap = await b.eval(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null`);
    if (heap) console.log(`     JavaScript heap in use: ${heap} MB`);
    const seen = [...b.requests];
    const outside = seen.filter((u) => !u.startsWith('file:'));
    check(outside.length === 0, `${seen.length} requests, all file://${outside.length ? ' but: ' + outside.slice(0, 3).join(', ') : ''}`);
    check(b.logs.length === 0, `no console errors or warnings${b.logs.length ? ': ' + JSON.stringify(b.logs.slice(0, 3)) : ''}`);
    const probe = await b.eval(`fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked')`);
    check(probe === 'blocked', `the network block works (a deliberate request to the internet was ${probe})`);
    for (const tabName of ['explore', 'about']) {
      await b.eval(`document.getElementById('tabbtn-${tabName}').click()`); await b.settle(900);
      if (tabName === 'explore') check(await b.eval(`document.querySelectorAll('#x-dist .main-svg').length > 0 && document.querySelectorAll('#x-scatter .scatterlayer .trace').length >= 4`), `${name}: Explore charts render`);
      else check((await b.eval(`document.querySelector('#tab-about .prose').textContent`)).includes('226,438'), `${name}: About tab shows the dataset size`);
    }
    if (shots) { await b.eval(`document.getElementById('tabbtn-estimate').click()`); await b.settle(500); await b.screenshot(join(shots, `cleanroom-${name.toLowerCase()}.png`), { fullPage: false }); }
  } catch (e) { check(false, `${name}: ${e}`); }
  finally { await b.close(); }
}

// ---- the full gates against the unzipped copy, in each browser
function gate(label, script, exe, extra = []) {
  const r = spawnSync(process.execPath, [join(here, script), '--app', appDir, ...extra], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CHROME: exe, OFFLINE: '1', THEME: 'light' },
  });
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-1)[0];
  check(r.status === 0, `${label}: ${tail}`);
  if (r.status !== 0) console.log((r.stdout + r.stderr).split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 8).join('\n'));
}
for (const [name, exe] of available) {
  console.log(`\n== ${name}: full gates on the unzipped copy ==`);
  gate(`${name} estimate-tab gate`, 'app_gate.mjs', exe);
  gate(`${name} explore/about gate`, 'explore_gate.mjs', exe);
  gate(`${name} accessibility and keyboard gate`, 'a11y_gate.mjs', exe);
}
console.log('\n== loading and failure states ==');
gate('failure-state gate (first browser)', 'states_gate.mjs', available[0][1]);

rmSync(work, { recursive: true, force: true });
console.log(failures.length ? `\nGATE 2 FAIL (${failures.length})` : `\nGATE 2 PASS: ${available.map(([n]) => n).join(' and ')}, zip ${(zipBytes / 1e6).toFixed(1)} MB`);
process.exit(failures.length ? 1 : 0);
