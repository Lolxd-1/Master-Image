/**
 * Seed the local dev server with the master catalog, using the same 5-step admin flow the
 * Admin screen uses. Then log in as a picker and confirm the catalog is actually visible.
 *
 *   node scripts/seed-local.mjs [baseUrl] [pathToXlsx]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbook } from '../web/src/xlsx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const FILE = process.argv[3] || join(ROOT, 'Master excel.xlsx');

function jar() {
  let cookie = '';
  return async function call(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) { const m = /sp_session=([^;]*)/.exec(sc); if (m) cookie = m[1] ? `sp_session=${m[1]}` : ''; }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, body };
  };
}

const admin = jar();
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };

console.log(`\nSeeding ${BASE} from ${basename(FILE)}\n`);

const login = await admin('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
if (login.status !== 200) die(`admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
console.log('  logged in as admin');

const { products, rows, skeleton } = parseWorkbook(new Uint8Array(readFileSync(FILE)));
console.log(`  parsed ${products.length} products`);

const begin = await admin('/api/catalog/begin', {
  method: 'POST',
  body: JSON.stringify({ filename: basename(FILE), productCount: products.length }),
});
if (begin.status !== 200) die(`begin failed: ${begin.status} ${JSON.stringify(begin.body)}`);
const id = begin.body.id;

const raw = { headers: { 'content-type': 'text/plain; charset=utf-8' } };
for (const [name, payload] of [
  ['products', JSON.stringify(products)],
  ['rows', JSON.stringify(rows)],
  ['skeleton', Buffer.from(skeleton).toString('base64')],
]) {
  const r = await admin(`/api/catalog/${id}/${name}`, { method: 'PUT', body: payload, ...raw });
  if (r.status !== 200) die(`upload ${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  console.log(`  uploaded ${name} (${(payload.length / 1024).toFixed(0)} KB)`);
}

const act = await admin(`/api/catalog/${id}/activate`, { method: 'POST' });
if (act.status !== 200) die(`activate failed: ${act.status} ${JSON.stringify(act.body)}`);
console.log(`  activated catalog ${act.body.id} (${act.body.productCount} products)`);

// The real check: can a picker actually see it?
const picker = jar();
const pl = await picker('/api/login', { method: 'POST', body: JSON.stringify({ username: 'store1', password: 'store1pass' }) });
if (pl.status !== 200) die(`store1 login failed: ${pl.status}`);
const meta = await picker('/api/catalog');
if (meta.status !== 200) die(`store1 cannot see the catalog: ${meta.status} ${JSON.stringify(meta.body)}`);
const prods = await picker('/api/catalog/products');
if (prods.status !== 200 || !Array.isArray(prods.body)) die(`store1 cannot load products: ${prods.status}`);

console.log(`\n  store1 sees "${meta.body.filename}" with ${prods.body.length} products`);
console.log(`\n  Ready. Open ${BASE} and log in as store1 / store1pass\n`);
