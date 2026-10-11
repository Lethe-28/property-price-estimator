// Minimal Chrome DevTools driver for testing the app from file:// (no npm packages).
//
//   import { launch } from './cdp.mjs';
//   const b = await launch({ width: 1280, height: 900 });   // THEME=dark|light picks the colour scheme (default light)
//   await b.open(fileUrl);                    // waits for the app's data-ready flag
//   await b.eval('document.title');           // evaluate an expression in the page
//   await b.screenshot('out.png');
//   b.logs / b.requests                       // console errors and every network request URL
//   await b.close();

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const KEYS = {
  Tab: { vk: 9 }, Enter: { vk: 13, text: '\r' }, Space: { key: ' ', vk: 32, text: ' ' }, Escape: { vk: 27 },
  ArrowLeft: { vk: 37 }, ArrowUp: { vk: 38 }, ArrowRight: { vk: 39 }, ArrowDown: { vk: 40 }, Home: { vk: 36 }, End: { vk: 35 },
};

export async function launch({ width = 1280, height = 900, dark = false, port = 9333 + Math.floor(Math.random() * 500), exe: chosen } = {}) {
  const exe = chosen ?? CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('No Chrome or Edge found; set the CHROME environment variable.');
  const profile = mkdtempSync(join(tmpdir(), 'ppe-chrome-'));
  const proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    // OFFLINE=1: every hostname fails to resolve and the proxy is dead, so any network attempt is visible.
    // Local DevTools traffic and file:// pages are unaffected.
    ...(process.env.OFFLINE === '1' ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--proxy-server=127.0.0.1:9'] : []),
    'about:blank',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* chrome still starting */ }
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) { proc.kill(); throw new Error('Chrome did not start'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map(), handlers = [];
  const logs = [], requests = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
    } else if (msg.method) {
      handlers.forEach((h) => h(msg));
      if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
      if (msg.method === 'Runtime.exceptionThrown') logs.push({ level: 'exception', text: msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text });
      if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
        logs.push({ level: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description).join(' ') });
      if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level))
        logs.push({ level: msg.params.entry.level, text: `${msg.params.entry.text} ${msg.params.entry.url ?? ''}` });
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

  await Promise.all(['Page', 'Runtime', 'Network', 'Log'].map((d) => send(`${d}.enable`)));
  const setViewport = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await setViewport(width, height);
  // Always set the scheme: headless Chrome otherwise follows the machine's own theme.
  // THEME=light|dark overrides the `dark` option, so the same gate can be run in both.
  const scheme = process.env.THEME || (dark ? 'dark' : 'light');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });

  const api = {
    logs, requests, send, setViewport,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeoutMs = 60000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (await api.eval(`Boolean(${expression})`).catch(() => false)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    },
    async open(url, { ready = "document.documentElement.dataset.ready === '1'", timeoutMs = 90000 } = {}) {
      await send('Page.navigate', { url });
      await api.waitFor(ready, timeoutMs);
    },
    async settle(ms = 400) { await new Promise((r) => setTimeout(r, ms)); },
    async screenshot(path, { fullPage = true } = {}) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
    },
    // A real key press (Tab, Enter, Space, arrows, ...). Chrome needs the virtual key code for
    // Enter/Space to activate a control and for arrows to move within a radio group or slider.
    async key(name, { shift = false } = {}) {
      const k = KEYS[name];
      if (!k) throw new Error(`unknown key ${name}`);
      const base = { key: k.key ?? name, code: k.code ?? name, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: shift ? 8 : 0 };
      await send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    async type(text) { await send('Input.insertText', { text }); },
    async close() { try { ws.close(); } catch {} proc.kill(); await new Promise((r) => setTimeout(r, 300)); try { rmSync(profile, { recursive: true, force: true }); } catch {} },
  };
  return api;
}
