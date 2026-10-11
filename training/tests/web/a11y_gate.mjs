// P5 accessibility gate: contrast in both themes, accessible names, and a keyboard-only run-through.
//
//   node tests/web/a11y_gate.mjs [--app PropertyPriceEstimator]
//
// Contrast thresholds follow WCAG 2.2 AA: 4.5:1 for text, 3:1 for the edges of controls, focus rings
// and the marks that carry data. The keyboard part never touches the mouse: it presses Tab through
// the whole Estimate tab and then operates each kind of control with the keys a person would use.

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..', '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const url = pathToFileURL(join(resolve(project, arg('--app', 'PropertyPriceEstimator')), 'index.html')).href;
const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'));
const fixed = golden.cases.find((c) => c.id === 'corrected_region_demo').expected;
const fmt = (v) => '₱' + Math.round(v).toLocaleString('en-US');

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); return ok; };

const lum = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const TEXT = [['--ink', '--surface'], ['--ink', '--page'], ['--ink-2', '--surface'], ['--ink-2', '--page'], ['--muted', '--surface'],
  ['--accent-strong', '--surface'], ['--accent-strong', '--page'], ['--bad', '--surface'], ['--good', '--good-wash'], ['--warn', '--warn-wash'],
  ['--bad', '--bad-wash'], ['--ink', '--accent-wash'], ['--ink', '--good-wash'], ['--ink', '--warn-wash'], ['--ink', '--bad-wash']];
const NON_TEXT = [['--control', '--surface'], ['--control', '--page'], ['--focus', '--surface'], ['--focus', '--page'], ['--accent', '--surface'],
  ['--down', '--surface'], ['--model-rf', '--surface'], ['--model-xgb', '--surface'], ['--type-house', '--surface'], ['--type-condo', '--surface'],
  ['--type-commercial', '--surface']];
// Known and documented: light aqua (lots) is 2.74:1. Type is also carried by the legend, marker shape and tooltip.
const RELIEF = new Set(['--type-lot|--surface|light']);

for (const theme of ['light', 'dark']) {
  process.env.THEME = theme;
  const b = await launch({ width: 1280, height: 900 });
  try {
    await b.open(url);
    console.log(`\n== ${theme} theme: contrast ==`);
    const tok = await b.eval(`(() => { const s = getComputedStyle(document.documentElement), o = {};
      for (const n of ${JSON.stringify([...new Set([...TEXT, ...NON_TEXT, ['--type-lot', '--surface']].flat())])}) o[n] = s.getPropertyValue(n).trim(); return o; })()`);
    for (const [fg, bg] of TEXT) { const r = ratio(tok[fg], tok[bg]); check(r >= 4.5, `text ${fg} on ${bg}: ${r.toFixed(2)}:1 (needs 4.5)`); }
    for (const [fg, bg] of [...NON_TEXT, ['--type-lot', '--surface']]) {
      const r = ratio(tok[fg], tok[bg]);
      if (r < 3 && RELIEF.has(`${fg}|${bg}|${theme}`)) console.log(`note ${fg} on ${bg}: ${r.toFixed(2)}:1, below 3:1 by design (legend, shape and tooltip carry identity)`);
      else check(r >= 3, `graphic ${fg} on ${bg}: ${r.toFixed(2)}:1 (needs 3)`);
    }
  } finally { await b.close(); }
}

process.env.THEME = 'light';
const b = await launch({ width: 1280, height: 900 });
const text = (sel) => b.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()`);
const focusAnd = async (sel) => { await b.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`); };
try {
  await b.open(url);
  await b.settle(600);

  console.log('\n== names, landmarks, language ==');
  const unnamed = await b.eval(`(() => {
    const name = (e) => {
      if (e.getAttribute('aria-label')) return e.getAttribute('aria-label');
      const by = e.getAttribute('aria-labelledby');
      if (by) return by.split(' ').map((i) => document.getElementById(i)?.textContent ?? '').join(' ').trim();
      if (e.id && document.querySelector('label[for="' + e.id + '"]')) return document.querySelector('label[for="' + e.id + '"]').textContent.trim();
      if (e.closest('label')) return e.closest('label').textContent.trim();
      return (e.textContent || e.title || '').trim();
    };
    return [...document.querySelectorAll('input:not([type=hidden]), select, button, summary, [role=tab], a[href]')]
      .filter((e) => !e.closest('.js-plotly-plot') && !e.hidden)
      .filter((e) => !name(e)).map((e) => e.outerHTML.slice(0, 90));
  })()`);
  check(unnamed.length === 0, `every control has an accessible name${unnamed.length ? ': ' + JSON.stringify(unnamed) : ''}`);
  check(await b.eval(`document.documentElement.lang === 'en' && document.title.length > 3`), 'page has a language and a title');
  check(await b.eval(`document.querySelectorAll('h1').length === 1 && document.querySelectorAll('main').length === 1 && document.querySelectorAll('header').length === 1`), 'one h1, one main, one header');
  check(await b.eval(`[...document.querySelectorAll('.plot')].every((p) => p.getAttribute('role') === 'img' && (p.getAttribute('aria-labelledby') || p.getAttribute('aria-label')))`), 'every chart is an image with a text description');
  check(await b.eval(`document.getElementById('live').getAttribute('aria-live') === 'polite' && /Estimated asking price/.test(document.getElementById('live').textContent)`), 'a polite live region announces the estimate');

  console.log('\n== keyboard only: tab order ==');
  const describe = `(() => { const e = document.activeElement; if (!e || e === document.body) return 'BODY';
    if (e.dataset.preset) return 'preset:' + e.dataset.preset; if (e.dataset.step) return 'step:' + e.dataset.step + (e.dataset.dir > 0 ? '+' : '-');
    if (e.name === 'ptype') return 'radio:' + e.value; if (e.tagName === 'SUMMARY') return 'summary'; if (e.dataset.tab) return 'tab:' + e.dataset.tab;
    if (e.classList.contains('skip')) return 'skip'; return e.id || e.tagName; })()`;
  const ringOk = `(() => { let e = document.activeElement; if (e.type === 'radio' && e.closest('.seg')) e = e.nextElementSibling;
    const c = getComputedStyle(e), r = document.activeElement.getBoundingClientRect();
    return { ring: c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) >= 2, visible: r.width > 0 && r.height > 0 }; })()`;
  await b.eval('document.activeElement.blur(); window.scrollTo(0, 0)');
  const stops = [], rings = [];
  for (let i = 0; i < 40; i++) {
    await b.key('Tab');
    const d = await b.eval(describe);
    if (d === 'BODY' || stops.includes(d)) break;
    stops.push(d); rings.push({ d, ...(await b.eval(ringOk)) });
  }
  // Tabbing past the last control leaves the page; Edge then keeps keyboard focus in its own UI until the page is brought back.
  await b.send('Page.bringToFront');
  console.log('  stops:', stops.join(' > '));
  const expected = ['skip', 'tab:estimate', 'preset:condo-davao', 'preset:house-qc', 'preset:lot-cebu', 'region', 'province', 'city', 'unlisted', 'radio:condo',
    'sqm-range', 'sqm', 'lot', 'step:bed-', 'bed', 'step:bed+', 'step:bath-', 'bath', 'step:bath+', 'summary', 'reset', 'view-range', 'view-trees'];
  check(expected.every((e) => stops.includes(e)), `Tab reaches every control${expected.filter((e) => !stops.includes(e)).length ? ', missing: ' + expected.filter((e) => !stops.includes(e)) : ''}`);
  check(expected.every((e, i) => stops.indexOf(e) === i), 'tab order follows the visual order');
  const noRing = rings.filter((r) => !r.ring || !r.visible).map((r) => r.d);
  check(noRing.length === 0, `every focused control shows a focus ring${noRing.length ? ': ' + noRing : ''}`);

  console.log('\n== keyboard only: operating the controls ==');
  const price = () => text('#price');
  await focusAnd('[data-preset="house-qc"]'); await b.key('Enter'); await b.settle(500);
  check(await b.eval(`document.getElementById('city').value`) === 'Quezon City', 'Enter on a preset chip fills the form');
  const houseP = await price();

  await focusAnd('input[name="ptype"][value="house"]'); await b.key('ArrowRight'); await b.settle(500);
  check(await b.eval(`document.querySelector('input[name="ptype"][value="condo"]').checked`) && await price() !== houseP, `arrow key moves the property type (house ${houseP} to condo ${await price()})`);

  const bed0 = await b.eval(`document.getElementById('bed').value`);
  await focusAnd('[data-step="bed"][data-dir="1"]'); await b.key('Space'); await b.settle(400);
  check(Number(await b.eval(`document.getElementById('bed').value`)) === Number(bed0) + 1, 'Space on the + button adds a bedroom');

  const sqm0 = await b.eval(`document.getElementById('sqm').value`);
  await focusAnd('#sqm-range'); for (let i = 0; i < 5; i++) await b.key('ArrowRight'); await b.settle(500);
  const sqm1 = await b.eval(`document.getElementById('sqm').value`);
  check(Number(sqm1) > Number(sqm0) && /square metres/.test(await b.eval(`document.getElementById('sqm-range').getAttribute('aria-valuetext')`)), `arrow keys move the floor-area slider (${sqm0} to ${sqm1} m²) and it announces its value`);

  await b.eval(`(() => { const c = document.getElementById('city'); c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await focusAnd('#city'); await b.type('Silang'); await b.settle(500);
  check(await b.eval(`document.getElementById('province').selectedOptions[0].textContent`) === 'Cavite', 'typing a city name selects its province');

  await focusAnd('#tabbtn-estimate'); await b.key('ArrowRight'); await b.settle(900);
  check(await b.eval(`!document.getElementById('tab-explore').hidden && document.activeElement.id === 'tabbtn-explore'`), 'arrow key moves to the Explore tab and shows it');
  await b.key('ArrowRight'); await b.settle(300);
  check(await b.eval(`!document.getElementById('tab-about').hidden`), 'arrow key moves to the About tab');
  await b.key('Home'); await b.settle(300);
  check(await b.eval(`!document.getElementById('tab-estimate').hidden`), 'Home returns to the Estimate tab');

  await focusAnd('#view-trees'); await b.key('Enter'); await b.settle(500);
  check(await b.eval(`document.getElementById('view-trees').getAttribute('aria-pressed') === 'true'`), 'Enter switches the chart view');

  await focusAnd('.adv summary'); await b.key('Enter'); await b.settle(300);
  check(await b.eval(`document.querySelector('.adv').open`), 'Enter opens the advanced coordinates');
  await b.key('Tab');
  check(await b.eval(`document.activeElement.id`) === 'lat', 'Tab then enters the coordinate fields');

  await focusAnd('#reset'); await b.key('Enter'); await b.settle(600);
  check(await price() === fmt(fixed), `Reset by keyboard restores the default estimate ${fmt(fixed)}`);

  console.log('\n== phone: price bar and layout ==');
  await b.setViewport(390, 844); await b.eval('window.scrollTo(0, 0)'); await b.settle(900);
  check(await b.eval(`document.getElementById('pricebar').hidden === false`), 'the price bar appears while the result is below the fold');
  const barText = await text('#pricebar');
  check(barText.includes(fmt(fixed)), `price bar shows the estimate: "${barText}"`);
  await b.eval(`document.getElementById('pricebar').click()`); await b.settle(1200);
  check(await b.eval(`document.getElementById('pricebar').hidden === true && document.activeElement.id === 'result'`), 'activating the bar scrolls to the result and hides the bar');
  check(await b.eval(`[...document.querySelectorAll('.tabs button')].every((t) => t.getBoundingClientRect().right <= document.documentElement.clientWidth)`), 'all three tabs fit on a 390 px screen');
  check(await b.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), '390 px: no horizontal page scroll');
  const small = await b.eval(`[...document.querySelectorAll('button, input:not([type=range]):not([type=checkbox]):not([type=radio]), select, summary')].filter((e) => !e.closest('.js-plotly-plot') && e.getBoundingClientRect().width > 0)
    .filter((e) => { const r = e.getBoundingClientRect(); return r.height < 36 || r.width < 36; }).map((e) => (e.id || e.textContent.trim().slice(0, 20)) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))`);
  check(small.length === 0, `touch targets are at least 36 px${small.length ? ': ' + small.join(', ') : ''}`);
  check(b.logs.length === 0, `no console errors${b.logs.length ? ': ' + JSON.stringify(b.logs.slice(0, 3)) : ''}`);
} catch (e) {
  failures.push(String(e)); console.log('ERROR', e);
} finally {
  await b.close();
}
console.log(failures.length ? `\nP5 ACCESSIBILITY GATE FAIL (${failures.length})` : '\nP5 ACCESSIBILITY GATE PASS');
process.exit(failures.length ? 1 : 0);
