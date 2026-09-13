/** Minimal zero-dependency Chrome DevTools Protocol driver (Node 22 global WebSocket). */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function launch(port = 9222) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-extensions', '--disable-background-networking',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let version = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!version) { proc.kill(); throw new Error('Chrome did not expose the debugging port'); }
  return { proc, wsUrl: version.webSocketDebuggerUrl, port };
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      } else {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
  });
  return new Conn(ws);
}

/** Find the page target's own debugger socket — no Target sessions, which this Chrome rejects. */
export async function pageSocket(port = 9222) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('no page target found');
}

/** One page, with the handful of helpers the audit needs. Commands carry no sessionId. */
export async function newPage(conn) {
  await conn.send('Page.enable');
  await conn.send('Runtime.enable');
  await conn.send('Network.enable');

  const loads = [];
  conn.on((msg) => { if (msg.method === 'Page.loadEventFired') loads.push(Date.now()); });

  const s = undefined;
  return {
    send: (m, p) => conn.send(m, p, s),
    async viewport(width, height, mobile = true, dpr = 1) {
      await conn.send('Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: dpr, mobile, screenWidth: width, screenHeight: height }, s);
      await conn.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 }, s);
    },
    async media(scheme /* 'light' | 'dark' | null */) {
      const features = scheme ? [{ name: 'prefers-color-scheme', value: scheme }] : [];
      await conn.send('Emulation.setEmulatedMedia', { features }, s);
    },
    async cookie(name, value, domain, port) {
      await conn.send('Network.setCookie', { name, value, domain, path: '/', url: `http://${domain}:${port}/` }, s);
    },
    async goto(url, settleMs = 900) {
      const before = loads.length;
      await conn.send('Page.navigate', { url }, s);
      for (let i = 0; i < 80 && loads.length === before; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, settleMs));
    },
    async hash(h, settleMs = 700) {
      await this.eval(`location.hash = ${JSON.stringify(h)}`);
      await new Promise((r) => setTimeout(r, settleMs));
    },
    async eval(expression, awaitPromise = false) {
      const r = await conn.send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise, userGesture: true }, s);
      if (r.exceptionDetails) {
        throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    async shot(path) {
      const { data } = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, s);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
  };
}
