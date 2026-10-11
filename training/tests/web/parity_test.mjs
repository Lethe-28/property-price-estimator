// Gate 1: the JavaScript forest must reproduce Python's pipeline.predict.
//
//   node tests/web/parity_test.mjs [--app PropertyPriceEstimator] [--sample tests/web/parity_sample.json]
//
// Loads the exported data files and assets/model.js exactly as the page does (classic scripts that
// assign to globalThis), then compares every row of tests/web/golden.json and the parity sample
// against the values Python produced. Exit code 1 if any row differs by 1e-6 relative or more.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const appDir = resolve(project, arg('--app', 'PropertyPriceEstimator'));
const samplePath = resolve(project, arg('--sample', 'tests/web/parity_sample.json'));
const GATE = 1e-6;

const require = createRequire(import.meta.url);
let t0 = performance.now();
require(resolve(appDir, 'data/forest.js'));
require(resolve(appDir, 'data/lookup.js'));
const model = require(resolve(appDir, 'assets/model.js'));
const tLoad = performance.now() - t0;
t0 = performance.now();
model.init();
const tDecode = performance.now() - t0;
console.log(`parse scripts ${tLoad.toFixed(0)} ms, decode forest ${tDecode.toFixed(0)} ms`);

const golden = JSON.parse(readFileSync(resolve(here, 'golden.json'), 'utf8'));
const sample = JSON.parse(readFileSync(samplePath, 'utf8'));

function compare(label, items) {
  let max = 0, worst = null, bad = 0;
  for (const { id, inputs, expected } of items) {
    const got = model.predict(inputs).price;
    const rel = Math.abs(got - expected) / Math.abs(expected);
    if (!(rel < GATE)) bad++;
    if (!(rel <= max)) { max = rel; worst = { id, got, expected }; }   // also catches NaN
  }
  console.log(`${label.padEnd(26)} rows=${String(items.length).padStart(5)}  max rel diff=${max.toExponential(3)}  rows >= ${GATE}: ${bad}`);
  if (worst) console.log(`    worst: ${worst.id}  js=${worst.got}  py=${worst.expected}`);
  return { max, bad };
}

const results = [];
results.push(compare('golden.json (all)', golden.cases));
const byTag = new Map();
for (const c of golden.cases) { const k = c.tag.split(':')[0]; (byTag.get(k) ?? byTag.set(k, []).get(k)).push(c); }
for (const [tag, cases] of byTag) if (cases.length >= 12) results.push(compare(`  tag ${tag}`, cases));
t0 = performance.now();
results.push(compare('parity_sample.json', sample.rows.map((inputs, i) => ({ id: `row ${i}`, inputs, expected: sample.expected[i] }))));
console.log(`(sample evaluated in ${(performance.now() - t0).toFixed(0)} ms, ${(sample.rows.length)} rows x 300 trees)`);

const fmt = (v) => Math.round(v).toLocaleString('en-US');
for (const id of ['paper_demo', 'corrected_region_demo']) {
  const c = golden.cases.find((k) => k.id === id);
  console.log(`${id}: js ₱${fmt(model.predict(c.inputs).price)}  python ₱${fmt(c.expected)}`);
}

// The paper's Section 4.7 back-fill replay: the browser model must give the numbers the manifest recorded.
const recorded = JSON.parse(readFileSync(resolve(project, 'dataset_manifest.json'), 'utf8')).application.parity_check;
let replayOk = true;
for (const [tag, want] of [['paper_backfill_replay', recorded.app_prediction_php], ['paper_backfill_replay_skipped', recorded.prediction_if_backfill_skipped_php]]) {
  const c = golden.cases.find((k) => k.tag === tag);
  const got = model.predict(c.inputs).price;
  const ok = Math.round(got) === Math.round(want);
  replayOk &&= ok;
  console.log(`${tag}: js ₱${fmt(got)}  manifest ₱${fmt(want)}  ${ok ? 'match' : 'MISMATCH'}`);
}
if (!replayOk) { console.log('GATE 1 FAIL: the browser model does not reproduce the paper replay numbers'); process.exit(1); }

const treePrices = model.predict(golden.cases[0].inputs).treePrices;
if (treePrices.length !== 300) { console.log(`FAIL: expected 300 tree prices, got ${treePrices.length}`); process.exit(1); }

const max = Math.max(...results.map((r) => r.max)), bad = results.reduce((a, r) => a + r.bad, 0);
console.log(max < GATE && bad === 0 ? `GATE 1 PASS: max relative difference ${max.toExponential(3)} < ${GATE}`
                                    : `GATE 1 FAIL: max relative difference ${max.toExponential(3)}, ${bad} rows over ${GATE}`);
process.exit(max < GATE && bad === 0 ? 0 : 1);
