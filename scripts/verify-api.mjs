/**
 * T-2 API & data tests (SPEC.md §10).
 *
 * Runs against a live Worker. Start one first:
 *     npm run build && npx wrangler dev --port 8787
 * then:
 *     node scripts/verify-api.mjs [baseUrl]
 *
 * These are written against the frozen API contract in SPEC.md §7, not against the
 * implementation, so they are a genuine check rather than a restatement of the code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbook } from '../web/src/xlsx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

const ADMIN = { username: 'admin', password: 'admin123' };
const U1 = { username: 'store1', password: 'store1pass' };
const U2 = { username: 'store2', password: 'store2pass' };

let pass = 0, fail = 0;
const t = async (id, desc, fn) => {
  try {
    const note = await fn();
    console.log(`  PASS  ${id}  ${desc}${note ? `  — ${note}` : ''}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${id}  ${desc}\n          ${e.message}`);
    fail++;
  }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

/** Minimal cookie jar — we need to inspect and tamper with the session cookie. */
function jar() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async fetch(path, init = {}) {
      const headers = { ...(init.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const res = await fetch(BASE + path, { ...init, headers, redirect: 'manual' });
      const sc = res.headers.get('set-cookie');
      if (sc) {
        const m = /sp_session=([^;]*)/.exec(sc);
        if (m) cookie = m[1] ? `sp_session=${m[1]}` : '';
      }
      let body = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) { try { body = await res.json(); } catch { body = null; } }
      else body = await res.text();
      return { status: res.status, body, res };
    },
  };
}
const login = async (j, creds) => j.fetch('/api/login', { method: 'POST', body: JSON.stringify(creds) });

console.log(`\nT-2  API & data   (${BASE})\n`);

/* ---------------------------------------------------------------- reachability */

try {
  const r = await fetch(BASE + '/api/me', { redirect: 'manual' });
  ok([200, 401].includes(r.status), `unexpected status ${r.status}`);
} catch (e) {
  console.log(`  Cannot reach the Worker at ${BASE}.`);
  console.log(`  Start it with:  npm run build && npx wrangler dev --port 8787\n  (${e.message})\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------- T-2.1 */

await t('T-2.1', 'login accepts the right password and rejects the wrong one', async () => {
  const j = jar();
  const bad = await login(j, { username: U1.username, password: 'wrong' });
  eq(bad.status, 401, 'wrong password status');
  ok(!j.cookie, 'a session cookie was set despite a failed login');

  const good = await login(j, U1);
  eq(good.status, 200, 'correct password status');
  eq(good.body.username, U1.username, 'username in response');
  eq(good.body.role, 'picker', 'role in response');
  ok(j.cookie.startsWith('sp_session='), 'no session cookie set');

  const setCookie = good.res.headers.get('set-cookie') || '';
  ok(/HttpOnly/i.test(setCookie), 'session cookie is not HttpOnly');
  ok(/SameSite=Lax/i.test(setCookie), 'session cookie is not SameSite=Lax');
  return 'cookie is HttpOnly + SameSite=Lax';
});

await t('T-2.1b', 'an unknown username fails the same way as a wrong password', async () => {
  const j = jar();
  const unknown = await login(j, { username: 'nobody-here', password: 'whatever' });
  const wrong = await login(j, { username: U1.username, password: 'definitely-wrong' });
  eq(unknown.status, wrong.status, 'status differs between unknown user and wrong password');
  eq(JSON.stringify(unknown.body), JSON.stringify(wrong.body), 'response body differs, allowing user enumeration');
  return `both ${unknown.status}, identical body`;
});

/* ---------------------------------------------------------------- T-2.2 / T-2.3 */

await t('T-2.2', 'every endpoint refuses anonymous callers', async () => {
  const j = jar();
  const paths = ['/api/catalog', '/api/catalog/products', '/api/catalog/rows', '/api/catalog/skeleton', '/api/decisions', '/api/progress'];
  for (const p of paths) {
    const r = await j.fetch(p);
    eq(r.status, 401, `${p} without a cookie`);
  }
  const post = await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku: 'x', value: 1 }] }) });
  eq(post.status, 401, 'POST /api/decisions without a cookie');
  return `${paths.length + 1} endpoints return 401`;
});

await t('T-2.3', 'a picker cannot reach admin endpoints', async () => {
  const j = jar();
  await login(j, U1);
  eq((await j.fetch('/api/progress')).status, 403, 'GET /api/progress as picker');
  const up = await j.fetch('/api/catalog/begin', { method: 'POST', body: JSON.stringify({ filename: 'x.xlsx', productCount: 0 }) });
  eq(up.status, 403, 'POST /api/catalog/begin as picker');
  const put = await j.fetch('/api/catalog/1/products', { method: 'PUT', body: '[]', headers: { 'content-type': 'text/plain' } });
  eq(put.status, 403, 'PUT /api/catalog/:id/products as picker');
  return 'all three admin endpoints return 403';
});

/* ---------------------------------------------------------------- catalog upload */

const admin = jar();
await t('T-2.9a', 'admin can upload the master catalog', async () => {
  const r = await login(admin, ADMIN);
  eq(r.status, 200, 'admin login');
  eq(r.body.role, 'admin', 'admin role');

  const bytes = new Uint8Array(readFileSync(join(ROOT, 'Master excel.xlsx')));
  const { products, rows, skeleton } = parseWorkbook(bytes);

  const begin = await admin.fetch('/api/catalog/begin', {
    method: 'POST',
    body: JSON.stringify({ filename: 'Master excel.xlsx', productCount: products.length }),
  });
  eq(begin.status, 200, `begin status (${JSON.stringify(begin.body).slice(0, 200)})`);
  const id = begin.body.id;
  ok(id, 'begin should return a catalog id');

  const raw = { headers: { 'content-type': 'text/plain; charset=utf-8' } };
  const parts = [
    ['products', JSON.stringify(products)],
    ['rows', JSON.stringify(rows)],
    ['skeleton', Buffer.from(skeleton).toString('base64')],
  ];
  for (const [name, body] of parts) {
    const r = await admin.fetch(`/api/catalog/${id}/${name}`, { method: 'PUT', body, ...raw });
    eq(r.status, 200, `PUT ${name} (${JSON.stringify(r.body).slice(0, 160)})`);
  }

  const act = await admin.fetch(`/api/catalog/${id}/activate`, { method: 'POST' });
  eq(act.status, 200, `activate status (${JSON.stringify(act.body).slice(0, 200)})`);
  eq(act.body.productCount, 650, 'product count');

  const mb = (JSON.stringify(rows).length / 1024 / 1024).toFixed(1);
  return `650 products, rows ${mb} MB streamed, skeleton ${(skeleton.length / 1024).toFixed(0)} KB`;
});

await t('T-2.9c', 'a catalog is invisible until it is activated', async () => {
  const before = (await admin.fetch('/api/catalog')).body.id;
  const begin = await admin.fetch('/api/catalog/begin', {
    method: 'POST',
    body: JSON.stringify({ filename: 'half-finished.xlsx', productCount: 1 }),
  });
  eq(begin.status, 200, 'begin status');
  ok(begin.body.id !== before, 'begin should create a new catalog id');

  // Never activated — the live catalog must not have changed.
  const after = (await admin.fetch('/api/catalog')).body;
  eq(after.id, before, 'an unactivated upload must not become live');
  eq(after.productCount, 650, 'live catalog product count');
  return 'abandoned upload left the live catalog untouched';
});

await t('T-2.9b', 'the uploaded catalog reads back intact', async () => {
  const meta = await admin.fetch('/api/catalog');
  eq(meta.status, 200, 'GET /api/catalog');
  eq(meta.body.productCount, 650, 'product count in metadata');

  const prods = await admin.fetch('/api/catalog/products');
  eq(prods.status, 200, 'GET /api/catalog/products');
  ok(Array.isArray(prods.body), 'products should be an array');
  eq(prods.body.length, 650, 'products length');
  const p = prods.body[0];
  for (const k of ['s', 'n', 'm', 'p', 'c', 'b', 'i']) ok(k in p, `product missing field "${k}"`);

  const rows = await admin.fetch('/api/catalog/rows');
  eq(rows.status, 200, 'GET /api/catalog/rows');
  eq(Object.keys(rows.body).length, 650, 'rows length');

  const skel = await admin.fetch('/api/catalog/skeleton');
  eq(skel.status, 200, 'GET /api/catalog/skeleton');
  return '650 products, 650 rows, skeleton all retrievable';
});

/* ---------------------------------------------------------------- T-2.4 / T-2.5 / T-2.6 */

let sampleSkus = [];
await t('T-2.4', 'one user never sees another user\'s decisions', async () => {
  const prods = await admin.fetch('/api/catalog/products');
  sampleSkus = prods.body.slice(0, 6).map((p) => p.s);

  const a = jar(); await login(a, U1);
  const b = jar(); await login(b, U2);

  // Deliberately overlapping SKUs with opposite answers.
  await a.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: sampleSkus.slice(0, 4).map((s) => ({ sku: s, value: 1 })) }) });
  await b.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: sampleSkus.slice(0, 4).map((s) => ({ sku: s, value: 0 })) }) });

  const da = (await a.fetch('/api/decisions')).body;
  const db = (await b.fetch('/api/decisions')).body;
  for (const s of sampleSkus.slice(0, 4)) {
    eq(da[s], 1, `store1 decision for ${s}`);
    eq(db[s], 0, `store2 decision for ${s}`);
  }
  return '4 overlapping SKUs, opposite values, no bleed';
});

await t('T-2.5', 'the same SKU posted twice keeps only the last value', async () => {
  const j = jar(); await login(j, U1);
  const sku = sampleSkus[5];
  await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku, value: 1 }] }) });
  await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku, value: 0 }] }) });
  const d = (await j.fetch('/api/decisions')).body;
  eq(d[sku], 0, 'last write should win');
  return 'last write wins, single row';
});

await t('T-2.6', 'replaying an identical batch is idempotent', async () => {
  const j = jar(); await login(j, U1);
  const batch = { items: sampleSkus.map((s) => ({ sku: s, value: 1 })) };
  const before = Object.keys((await j.fetch('/api/decisions')).body).length;
  for (let i = 0; i < 3; i++) {
    const r = await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify(batch) });
    eq(r.status, 200, `replay ${i + 1} status`);
  }
  const after = (await j.fetch('/api/decisions')).body;
  eq(Object.keys(after).length, Math.max(before, sampleSkus.length), 'decision count after replays');
  for (const s of sampleSkus) eq(after[s], 1, `value for ${s}`);
  return 'posted 3x, no duplicates';
});

await t('T-2.5b', 'posting value:null deletes the decision (durable undecide)', async () => {
  const j = jar(); await login(j, U1);
  const sku = sampleSkus[5];
  await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku, value: 1 }] }) });
  eq((await j.fetch('/api/decisions')).body[sku], 1, 'decision should be set');
  const del = await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku, value: null }] }) });
  eq(del.status, 200, 'undecide status');
  const d = (await j.fetch('/api/decisions')).body;
  ok(!(sku in d), 'undecided SKU should be absent after reload');
  // Replay the delete — safe.
  const again = await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku, value: null }] }) });
  eq(again.status, 200, 'replay delete status');
  // Bad value rejected, not crashed on.
  const bad = await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku, value: 2 }] }) });
  eq(bad.status, 400, 'bad value status');
  return 'set → null → absent, replay safe, bad value 400';
});

await t('T-2.5c', 'overrides set, read back, reset, and validate', async () => {
  const j = jar(); await login(j, U1);
  const sku = sampleSkus[4];
  // set
  const set = await j.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: [{ sku, field: 'price', value: '38' }] }) });
  eq(set.status, 200, 'set status');
  const got = (await j.fetch('/api/overrides')).body;
  eq(got[sku]?.price, '38', 'override reads back');
  // reset one field
  await j.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: [{ sku, field: 'price', value: null }] }) });
  const after = (await j.fetch('/api/overrides')).body;
  ok(!(sku in after) || !('price' in (after[sku] || {})), 'reset field should be gone');
  // bad field / bad value / oversized
  const bf = await j.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: [{ sku, field: 'nope', value: 'x' }] }) });
  eq(bf.status, 400, 'bad field status');
  const bv = await j.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: [{ sku, field: 'price', value: 'abc' }] }) });
  eq(bv.status, 400, 'bad value status');
  const big = Array.from({ length: 501 }, (_, i) => ({ sku: `s-${i}`, field: 'price', value: '1' }));
  eq((await j.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: big }) })).status, 400, 'oversized status');
  return 'set → read → reset; 400s on bad field/value/size';
});

await t('T-2.4b', 'overrides are per-user; admin ?user= reads, picker ?user= cannot', async () => {
  const a = jar(); await login(a, U1);
  const b = jar(); await login(b, U2);
  const sku = sampleSkus[3];
  await a.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: [{ sku, field: 'name', value: 'STORE1 NAME' }] }) });
  const da = (await a.fetch('/api/overrides')).body;
  const db = (await b.fetch('/api/overrides')).body;
  eq(da[sku]?.name, 'STORE1 NAME', 'owner sees own edit');
  ok(!(sku in db) || db[sku]?.name !== 'STORE1 NAME', 'other user must not see it');
  // picker asking for someone else → 403
  eq((await a.fetch(`/api/overrides?user=${U2.username}`)).status, 403, 'picker ?user= overrides');
  eq((await a.fetch(`/api/decisions?user=${U2.username}`)).status, 403, 'picker ?user= decisions');
  // admin can read either
  const adm = jar(); await login(adm, ADMIN);
  eq((await adm.fetch(`/api/overrides?user=${U1.username}`)).body[sku]?.name, 'STORE1 NAME', 'admin reads user override');
  eq((await adm.fetch(`/api/decisions?user=${U1.username}`)).status, 200, 'admin reads user decisions');
  // cleanup
  await a.fetch('/api/overrides', { method: 'POST', body: JSON.stringify({ items: [{ sku, field: 'name', value: null }] }) });
  return 'isolation holds; admin cross-user reads work';
});

await t('T-2.3b', 'progress includes last-active per user', async () => {
  const adm = jar(); await login(adm, ADMIN);
  const prog = (await adm.fetch('/api/progress')).body;
  ok(prog[U1.username], 'store1 missing from progress');
  for (const u of [U1.username, U2.username]) {
    const e = prog[u];
    ok(e && typeof e.decided === 'number' && typeof e.yes === 'number' && typeof e.total === 'number', `${u} shape`);
    ok('lastActive' in e, `${u} missing lastActive`);
  }
  ok(typeof prog[U1.username].lastActive === 'number', 'active user should have a lastActive timestamp');
  return 'decided/yes/total/lastActive present';
});

await t('T-2.7', 'an oversized batch is rejected, not crashed on', async () => {
  const j = jar(); await login(j, U1);
  const items = Array.from({ length: 501 }, (_, i) => ({ sku: `fake-${i}`, value: 1 }));
  const r = await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items }) });
  eq(r.status, 400, 'oversized batch status');
  ok(r.body && typeof r.body.error === 'string', 'should return a readable {error} message');
  return `400: "${r.body.error}"`;
});

/* ---------------------------------------------------------------- T-2.8 */

await t('T-2.8', 'a tampered session cookie is rejected', async () => {
  const j = jar(); await login(j, U1);
  eq((await j.fetch('/api/me')).status, 200, 'valid cookie should work');

  const valid = j.cookie;
  const flip = (s) => s.slice(0, -1) + (s.at(-1) === 'a' ? 'b' : 'a');

  j.cookie = flip(valid);                                  // broken signature
  eq((await j.fetch('/api/decisions')).status, 401, 'tampered signature');

  const parts = valid.replace('sp_session=', '').split('.');
  if (parts.length >= 3) {
    j.cookie = `sp_session=${Buffer.from('admin').toString('base64url')}.${parts[1]}.${parts[2]}`;
    eq((await j.fetch('/api/progress')).status, 401, 'swapping the username to admin must not grant admin');
  }
  return 'signature tampering and username swapping both rejected';
});

/* ---------------------------------------------------------------- logout */

/* ---------------------------------------------------------------- T-2.9d — the one that matters */

await t('T-2.9d', 're-uploading a catalog PRESERVES everyone\'s decisions', async () => {
  const j = jar(); await login(j, U1);

  // Record a decision the store owner would be furious to lose.
  const target = sampleSkus[0];
  await j.fetch('/api/decisions', { method: 'POST', body: JSON.stringify({ items: [{ sku: target, value: 1 }] }) });
  const before = (await j.fetch('/api/decisions')).body;
  eq(before[target], 1, 'decision should be set before the re-upload');
  const beforeCount = Object.keys(before).length;
  ok(beforeCount > 0, 'no decisions recorded to test with');

  // Admin uploads the sheet again — a brand new catalog id.
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'Master excel.xlsx')));
  const { products, rows, skeleton } = parseWorkbook(bytes);
  const oldId = (await admin.fetch('/api/catalog')).body.id;
  const begin = await admin.fetch('/api/catalog/begin', {
    method: 'POST',
    body: JSON.stringify({ filename: 'Master excel (v2).xlsx', productCount: products.length }),
  });
  const id = begin.body.id;
  const raw = { headers: { 'content-type': 'text/plain; charset=utf-8' } };
  await admin.fetch(`/api/catalog/${id}/products`, { method: 'PUT', body: JSON.stringify(products), ...raw });
  await admin.fetch(`/api/catalog/${id}/rows`, { method: 'PUT', body: JSON.stringify(rows), ...raw });
  await admin.fetch(`/api/catalog/${id}/skeleton`, { method: 'PUT', body: Buffer.from(skeleton).toString('base64'), ...raw });
  eq((await admin.fetch(`/api/catalog/${id}/activate`, { method: 'POST' })).status, 200, 'activate');

  const live = (await admin.fetch('/api/catalog')).body;
  ok(live.id !== oldId, 'the new catalog should be live');
  eq(live.filename, 'Master excel (v2).xlsx', 'live catalog filename');

  const after = (await j.fetch('/api/decisions')).body;
  eq(after[target], 1, 'decision was LOST across the re-upload — this is the failure we care about');
  eq(Object.keys(after).length, beforeCount, 'decision count changed across the re-upload');
  return `${beforeCount} decisions survived catalog ${oldId} → ${live.id}`;
});

await t('T-2.10', 'logout ends the session', async () => {
  const j = jar(); await login(j, U1);
  eq((await j.fetch('/api/me')).status, 200, 'logged in');
  eq((await j.fetch('/api/logout', { method: 'POST' })).status, 200, 'logout');
  eq((await j.fetch('/api/me')).status, 401, 'session should be dead after logout');
  return 'session cleared';
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
