/** Targeted probes: hit-testing under the fixed footer, admin header adjacency, focus styles. */
import { launch, connect, newPage, pageSocket } from './cdp.mjs';

const BASE = 'http://127.0.0.1:8787';
const HOST = '127.0.0.1', PORT = 8787;

async function loginCookie(u, p) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  return /sp_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
}

const picker = await loginCookie('store1', 'store1pass');
const admin = await loginCookie('admin', 'admin123');

const { proc } = await launch(9555);
const conn = await connect(await pageSocket(9555));
const page = await newPage(conn);

async function load(cookie, hash, w = 360, h = 640) {
  await page.viewport(w, h);
  await page.send('Network.clearBrowserCookies');
  await page.cookie('sp_session', cookie, HOST, PORT);
  await page.goto(`${BASE}/?v=${Date.now()}${hash}`, 1600);
}

/* ---- 1. Hit-testing: is any visible tile covered by the fixed footer? ---- */
const HITTEST = String.raw`
(() => {
  const footer = document.querySelector('.footer-bar');
  const fr = footer ? footer.getBoundingClientRect() : null;
  const tiles = [...document.querySelectorAll('.cat-tile')];
  const rows = [];
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) continue;  // offscreen
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const owned = hit && (hit === t || t.contains(hit));
    // how much of the tile's visible height is under the footer box
    const overlap = fr ? Math.max(0, Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top)) : 0;
    rows.push({
      name: (t.querySelector('.cat-tile__name') || {}).textContent || '?',
      top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      centerHitsTile: !!owned,
      hitEl: hit ? (hit.className || hit.tagName) : null,
      footerOverlapPx: +overlap.toFixed(1),
    });
  }
  return {
    vh: innerHeight,
    footer: fr ? { top: +fr.top.toFixed(1), bottom: +fr.bottom.toFixed(1), h: +fr.height.toFixed(1) } : null,
    footerPointerEvents: footer ? getComputedStyle(footer).pointerEvents : null,
    gridPaddingBottom: (() => { const g = document.querySelector('.cat-grid'); return g ? getComputedStyle(g).paddingBottom : null; })(),
    tiles: rows,
  };
})()
`;

await load(picker, '#/');
console.log('\n=== HIT TEST: home at top of scroll (360x640) ===');
console.log(JSON.stringify(await page.eval(HITTEST), null, 1));

await page.eval(`document.scrollingElement.scrollTop = 400`);
await new Promise((r) => setTimeout(r, 400));
console.log('\n=== HIT TEST: home scrolled 400px ===');
const scrolled = await page.eval(HITTEST);
console.log(JSON.stringify(scrolled, null, 1));

/* ---- 2. Admin role: header control adjacency ---- */
await load(admin, '#/');
console.log('\n=== ADMIN ROLE home header controls ===');
console.log(await page.eval(String.raw`
(() => {
  const out = [];
  for (const el of document.querySelectorAll('.cat-header button, .cat-header a')) {
    const r = el.getBoundingClientRect();
    out.push({ label: el.textContent.trim(), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
  }
  // pairwise horizontal gaps
  const gaps = [];
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
    const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    gaps.push({ pair: a.label + ' | ' + b.label, gap: +Math.hypot(dx, dy).toFixed(1) });
  }
  return JSON.stringify({ controls: out, gaps: gaps.sort((p,q)=>p.gap-q.gap) }, null, 1);
})()
`));

/* ---- 3. Focus styles: does anything show a focus ring? ---- */
console.log('\n=== FOCUS STYLE PROBE (admin home + login) ===');
console.log(await page.eval(String.raw`
(() => {
  const res = [];
  for (const el of document.querySelectorAll('button, input, a[href]')) {
    const before = getComputedStyle(el);
    const b = { outline: before.outlineStyle + ' ' + before.outlineWidth, shadow: before.boxShadow };
    el.focus();
    const after = getComputedStyle(el);
    const a = { outline: after.outlineStyle + ' ' + after.outlineWidth, shadow: after.boxShadow };
    const changed = b.outline !== a.outline || b.shadow !== a.shadow;
    res.push({ el: (el.className || el.tagName).toString().slice(0, 46), label: (el.textContent || '').trim().slice(0, 24), focusVisibleChange: changed, after: a.outline });
    el.blur();
  }
  return JSON.stringify(res, null, 1);
})()
`));

await load(picker, '#/login');
console.log('\n=== FOCUS on login inputs ===');
console.log(await page.eval(String.raw`
(() => {
  const res = [];
  for (const el of document.querySelectorAll('input, button')) {
    el.focus();
    const cs = getComputedStyle(el);
    res.push({ el: el.className || el.tagName, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor });
    el.blur();
  }
  return JSON.stringify(res, null, 1);
})()
`));

/* ---- 4. Deck: undo state with prior decisions, and keyboard-only reachability ---- */
await load(picker, '#/deck/CHOCOLATES');
console.log('\n=== DECK undo state on a category with 40 prior decisions ===');
console.log(await page.eval(String.raw`
(() => {
  const u = document.querySelector('[data-action="undo"]');
  const cards = document.querySelectorAll('.card');
  return JSON.stringify({
    undoDisabled: u ? u.disabled : null,
    cardsInStack: cards.length,
    peekInlineStyle: cards[0] ? cards[0].getAttribute('style') : null,
    activeHasTint: !!document.querySelector('.swipe-tint'),
    tintDataDirUsed: !!document.querySelector('.swipe-tint[data-dir]'),
    touchAction: getComputedStyle(document.querySelector('.card-stack')).touchAction,
    ariaLive: document.querySelectorAll('[aria-live]').length,
  }, null, 1);
})()
`));

proc.kill();
process.exit(0);
