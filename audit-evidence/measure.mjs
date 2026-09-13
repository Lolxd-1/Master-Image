/**
 * Measures the running Stock Picker app through CDP: tap targets, adjacency gaps,
 * text contrast, horizontal overflow, dark-mode response. Writes JSON + screenshots.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, connect, newPage, pageSocket } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const HOST = '127.0.0.1';
const PORT = 8787;
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(OUT, { recursive: true });

/* ---------------------------------------------------------------- session + state setup */

async function loginCookie(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  const sc = res.headers.get('set-cookie') || '';
  const m = /sp_session=([^;]+)/.exec(sc);
  if (!m) throw new Error('no session cookie');
  return m[1];
}

/** Give store1 a realistic half-finished state so no screen is measured empty. */
async function seedDecisions(cookie) {
  const products = await (await fetch(`${BASE}/api/catalog/products`, { headers: { cookie: `sp_session=${cookie}` } })).json();
  const byCat = new Map();
  for (const p of products) {
    if (!byCat.has(p.c)) byCat.set(p.c, []);
    byCat.get(p.c).push(p);
  }
  // CHOCOLATES: first 40 decided (28 yes / 12 no) -> a partly-done category.
  // CHEWING GUMS: all 10 decided -> a finished category.
  const items = [];
  const choc = byCat.get('CHOCOLATES') || [];
  choc.slice(0, 40).forEach((p, i) => items.push({ sku: p.s, value: i % 10 < 7 ? 1 : 0 }));
  const gums = byCat.get('CHEWING GUMS') || [];
  gums.forEach((p, i) => items.push({ sku: p.s, value: i % 3 === 0 ? 0 : 1 }));
  const crisp = byCat.get('CRISP & NAMKEENS') || [];
  crisp.slice(0, 15).forEach((p) => items.push({ sku: p.s, value: 1 }));

  const res = await fetch(`${BASE}/api/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `sp_session=${cookie}` },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`seed decisions failed: ${res.status} ${await res.text()}`);
  return { decided: items.length, yes: items.filter((i) => i.value === 1).length, categories: [...byCat.keys()] };
}

/* ---------------------------------------------------------------- in-page measurement */

const MEASURE_JS = String.raw`
(() => {
  const PARSE = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const effBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = PARSE(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.05) return c;
      n = n.parentElement;
    }
    const c = PARSE(getComputedStyle(document.documentElement).backgroundColor);
    return c && c.a > 0.05 ? c : { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg, bg) => {
    if (!fg || !bg) return null;
    const a = fg.a < 1
      ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) }
      : fg;
    const L1 = lum(a), L2 = lum(bg);
    return +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05))).toFixed(2);
  };
  const desc = (el) => {
    const d = el.dataset || {};
    const id = [el.tagName.toLowerCase(), el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '',
      d.action ? '[data-action=' + d.action + ']' : '', d.role ? '[data-role=' + d.role + ']' : ''].join('');
    return id.slice(0, 90);
  };

  const out = {
    hash: location.hash, vw: innerWidth, vh: innerHeight,
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    controls: [], text: [], notes: {},
  };

  const SEL = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 && r.height < 0.5) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    out.controls.push({
      sel: desc(el),
      label: (el.getAttribute('aria-label') || el.value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 46),
      w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1), y: +r.y.toFixed(1),
      disabled: !!el.disabled,
      fs: parseFloat(cs.fontSize),
      contrast: ratio(PARSE(cs.color), effBg(el)),
      hasFocusStyle: null,
      inThumbReach: r.y + r.height / 2 > innerHeight * 0.35,
    });
  }

  const textSel = ['h1','h2','p','span','td','th','label','li'];
  for (const el of document.querySelectorAll(textSel.join(','))) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || el.children.length > 0) continue;
    const cs = getComputedStyle(el);
    out.text.push({
      sel: desc(el), t: t.slice(0, 44), fs: parseFloat(cs.fontSize), fw: cs.fontWeight,
      contrast: ratio(PARSE(cs.color), effBg(el)),
    });
  }

  // screen-specific probes
  const stack = document.querySelector('.card-stack');
  if (stack) {
    const r = stack.getBoundingClientRect();
    const card = document.querySelector('.card:not(.card--peek)');
    const img = document.querySelector('.card__image-wrap');
    const body = document.querySelector('.card__body');
    out.notes.cardStack = { h: +r.height.toFixed(1), w: +r.width.toFixed(1) };
    if (card) out.notes.card = { h: +card.getBoundingClientRect().height.toFixed(1) };
    if (img) out.notes.imageWrap = { h: +img.getBoundingClientRect().height.toFixed(1) };
    if (body) out.notes.cardBody = { h: +body.getBoundingClientRect().height.toFixed(1) };
    const imgEl = document.querySelector('img.card__image');
    out.notes.cardImageSrc = imgEl ? imgEl.getAttribute('src') : null;
    out.notes.progressLabel = (document.querySelector('[data-role="progress-label"]') || {}).textContent || null;
    out.notes.categoryNameVisibleInTopbar = !!document.querySelector('.deck-topbar .deck-progress__label')
      && /[A-Za-z]{3}/.test((document.querySelector('.deck-topbar') || {}).textContent || '');
    out.notes.deckTopbarText = ((document.querySelector('.deck-topbar') || {}).textContent || '').replace(/\s+/g, ' ').trim();
  }
  const grid = document.querySelector('.cat-grid');
  if (grid) {
    out.notes.tiles = grid.querySelectorAll('.cat-tile').length;
    out.notes.tileTexts = [...grid.querySelectorAll('.cat-tile')].slice(0, 12)
      .map((t) => (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
    out.notes.headerSummary = (document.querySelector('[data-role="overall-summary"]') || {}).textContent || null;
    out.notes.downloadBtn = (() => {
      const b = document.querySelector('[data-role="download-btn"]');
      return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
    })();
    out.notes.statusChip = (document.querySelector('[data-role="status-chip"]') || {}).textContent || null;
  }
  const exportBody = document.querySelector('.export-body');
  if (exportBody) {
    out.notes.exportTotal = (document.querySelector('.export-total') || {}).textContent || null;
    out.notes.breakdownRows = document.querySelectorAll('.export-breakdown__row').length;
    out.notes.listsActualItems = !!document.querySelector('.export-item, [data-role="item-row"]');
  }
  const adminBody = document.querySelector('.admin-body');
  if (adminBody) {
    out.notes.adminCards = document.querySelectorAll('.admin-card').length;
    out.notes.progressRows = document.querySelectorAll('[data-role="progress-body"] tr').length;
    out.notes.fileInputStyled = (() => {
      const i = document.querySelector('input[type=file]');
      if (!i) return null;
      const r = i.getBoundingClientRect();
      return { h: +r.height.toFixed(1), w: +r.width.toFixed(1) };
    })();
    out.notes.inlineStyleAttrs = document.querySelectorAll('.admin-body [style]').length;
  }

  // search affordance anywhere?
  out.notes.hasSearchInput = !!document.querySelector('input[type=search], input[placeholder*="earch"], [data-role*="search"]');
  out.notes.inlineStyledEls = document.querySelectorAll('#app [style]').length;
  return out;
})()
`;

/** Smallest gap between any two control rects (mis-tap risk). */
function adjacency(controls) {
  const pairs = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
      const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
      const gap = Math.hypot(dx, dy);
      if (gap < 12) pairs.push({ a: a.sel, aLabel: a.label, b: b.sel, bLabel: b.label, gap: +gap.toFixed(1) });
    }
  }
  return pairs.sort((p, q) => p.gap - q.gap).slice(0, 12);
}

/* ---------------------------------------------------------------- run */

const pickerCookie = await loginCookie('store1', 'store1pass');
const adminCookie = await loginCookie('admin', 'admin123');
const seeded = await seedDecisions(pickerCookie);
console.log('seeded:', JSON.stringify(seeded.decided), 'decisions,', seeded.yes, 'yes');

const { proc } = await launch(9222);
const conn = await connect(await pageSocket(9222));
const report = { generatedAt: new Date().toISOString(), seeded, screens: [] };

const VIEWPORTS = [
  { name: '360x640', w: 360, h: 640 },
  { name: '390x844', w: 390, h: 844 },
  { name: '320x568', w: 320, h: 568 },
];

const SCREENS = [
  { id: 'login', hash: '#/login', who: 'none' },
  { id: 'home', hash: '#/', who: 'picker' },
  { id: 'deck-partial', hash: '#/deck/CHOCOLATES', who: 'picker' },
  { id: 'deck-complete', hash: '#/deck/CHEWING%20GUMS', who: 'picker' },
  { id: 'deck-untouched', hash: '#/deck/SWEETS', who: 'picker' },
  { id: 'export', hash: '#/export', who: 'picker' },
  { id: 'admin', hash: '#/admin', who: 'admin' },
];

const page = await newPage(conn);
for (const vp of VIEWPORTS) {
  await page.viewport(vp.w, vp.h);
  for (const sc of SCREENS) {
    await page.media('light');
    await page.send('Network.clearBrowserCookies');
    if (sc.who !== 'none') {
      await page.cookie('sp_session', sc.who === 'admin' ? adminCookie : pickerCookie, HOST, PORT);
    }
    // Navigate to the hash directly so the router mounts the target screen on boot.
    await page.goto(`${BASE}/?v=${Date.now()}${sc.hash}`, 1600);
    let m;
    try { m = await page.eval(MEASURE_JS); } catch (e) { m = { error: String(e) }; }
    if (m && m.controls) {
      m.adjacency = adjacency(m.controls);
      m.under44 = m.controls.filter((c) => c.h < 44 || c.w < 44).map((c) => ({ sel: c.sel, label: c.label, w: c.w, h: c.h }));
      m.lowContrastText = (m.text || []).filter((t) => t.contrast !== null && t.contrast < 4.5 && t.fs < 18.66)
        .map((t) => ({ sel: t.sel, t: t.t, fs: t.fs, contrast: t.contrast }));
      delete m.text;
    }
    if (vp.name === '360x640') {
      await page.shot(`${OUT}${sc.id}-light.png`);
      await page.media('dark');
      await new Promise((r) => setTimeout(r, 400));
      const darkBg = await page.eval(`getComputedStyle(document.body).backgroundColor`);
      m.darkModeBodyBg = darkBg;
      await page.shot(`${OUT}${sc.id}-dark.png`);
      await page.media('light');
    }
    report.screens.push({ viewport: vp.name, screen: sc.id, hash: sc.hash, ...m });
    console.log(`  ${vp.name} ${sc.id.padEnd(16)} hash=${String(m.hash).padEnd(22)} controls=${m.controls ? m.controls.length : 'ERR'} under44=${m.under44 ? m.under44.length : '-'} overflowX=${m.overflowX}`);
  }
}

writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
console.log(`\nwrote ${OUT}report.json`);
proc.kill();
process.exit(0);
