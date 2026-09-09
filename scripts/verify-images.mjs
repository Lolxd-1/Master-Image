/**
 * Image pipeline check (SPEC.md §4.3, T-3.8).
 *
 * The swipe UI shows a resized variant of each Amazon image (~74% less data). That only works
 * if Amazon serves the resized URL for *every* image in the catalog, not just the one that was
 * spot-checked. A 404 here means a store owner sees a broken card, so this samples the real
 * catalog and confirms both the original and the resized URL respond.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkbook, thumb } from '../web/src/xlsx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = Number(process.env.SAMPLE || 40);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

const { products } = parseWorkbook(new Uint8Array(readFileSync(join(ROOT, 'Master excel.xlsx'))));
const withImages = products.filter((p) => p.i);

console.log(`\nImage pipeline  (${withImages.length} of ${products.length} products have an image)\n`);

/* ---------------------------------------------------------------- shape of the URLs */

const exts = new Map();
const hosts = new Map();
for (const p of withImages) {
  const e = (p.i.match(/\.([a-z0-9]+)$/i)?.[1] || '(none)').toLowerCase();
  exts.set(e, (exts.get(e) || 0) + 1);
  const h = new URL(p.i).host;
  hosts.set(h, (hosts.get(h) || 0) + 1);
}
console.log('  extensions:', [...exts].map(([k, v]) => `${k}=${v}`).join(' '));
console.log('  hosts:     ', [...hosts].map(([k, v]) => `${k}=${v}`).join(' '));

const unrewritable = withImages.filter((p) => thumb(p.i, 400) === p.i);
console.log(`  URLs the resizer cannot rewrite: ${unrewritable.length}` +
            (unrewritable.length ? `  e.g. ${unrewritable[0].i}` : ''));

/* ---------------------------------------------------------------- fetch a real sample */

// Evenly spaced through the catalog so we cover every category, not just the first one.
const step = Math.max(1, Math.floor(withImages.length / SAMPLE));
const sample = withImages.filter((_, i) => i % step === 0).slice(0, SAMPLE);

let okCount = 0, badCount = 0, origBytes = 0, thumbBytes = 0;
const failures = [];

async function head(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/avif,image/webp,*/*' } });
  const buf = res.ok ? await res.arrayBuffer() : null;
  return { status: res.status, bytes: buf ? buf.byteLength : 0, cors: res.headers.get('access-control-allow-origin') };
}

console.log(`\n  fetching ${sample.length} products (original + _SX400_)...\n`);

let corsOk = true;
await Promise.all(sample.map(async (p) => {
  try {
    const [a, b] = await Promise.all([head(p.i), head(thumb(p.i, 400))]);
    if (a.status === 200 && b.status === 200) {
      okCount++;
      origBytes += a.bytes;
      thumbBytes += b.bytes;
      if (a.cors !== '*') corsOk = false;
    } else {
      badCount++;
      failures.push(`${a.status}/${b.status}  ${p.n}  ${p.i}`);
    }
  } catch (e) {
    badCount++;
    failures.push(`ERR ${e.message}  ${p.n}`);
  }
}));

for (const f of failures.slice(0, 10)) console.log('  FAIL ', f);

const saved = origBytes ? (100 * (1 - thumbBytes / origBytes)).toFixed(0) : '0';
console.log(`\n  ${okCount} ok, ${badCount} failed`);
console.log(`  average original: ${(origBytes / okCount / 1024).toFixed(1)} KB`);
console.log(`  average _SX400_:  ${(thumbBytes / okCount / 1024).toFixed(1)} KB   (${saved}% less)`);
console.log(`  CORS '*' on every sampled image: ${corsOk ? 'yes' : 'NO — canvas/export use would be blocked'}`);

const wholeCatalogOriginal = (origBytes / okCount) * withImages.length / 1024 / 1024;
const wholeCatalogThumb = (thumbBytes / okCount) * withImages.length / 1024 / 1024;
console.log(`\n  swiping the whole catalog would transfer ` +
            `${wholeCatalogOriginal.toFixed(0)} MB at full size vs ${wholeCatalogThumb.toFixed(0)} MB resized\n`);

if (badCount > 0 || unrewritable.length > 0) process.exit(1);
