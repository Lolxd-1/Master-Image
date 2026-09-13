/**
 * Standalone check against the real QuickVerse master catalog (see SPEC.md §10 for the sibling
 * T-1 harness this mirrors). QuickVerse_Master_Catalog.xlsx ships with column A blank on every
 * row — SmartBiz assigns SKU IDs on upload — so this file exists to prove the synthetic-SKU path
 * in web/src/xlsx.js actually holds up against the real 2279-row catalog: stable ids, a lossless
 * export (column A still blank, row XML otherwise untouched), and overrides still working.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { parseWorkbook, buildWorkbook } from '../web/src/xlsx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'QuickVerse_Master_Catalog.xlsx');
const OUT = join(ROOT, '.test-output');
mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (id, desc, fn) => {
  try {
    const note = fn();
    console.log(`  PASS  ${id}  ${desc}${note ? `  — ${note}` : ''}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${id}  ${desc}\n          ${e.message}`);
    fail++;
  }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m); };

/* ---------------------------------------------------------------- helpers */

function sheetOf(bytes, sheetPath) {
  const parts = unzipSync(bytes);
  return { parts, xml: strFromU8(parts[sheetPath]) };
}
function dataRows(xml) {
  const s = xml.indexOf('<sheetData>');
  const e = xml.indexOf('</sheetData>');
  const inner = xml.slice(s + 11, e);
  const rows = [];
  let i = 0;
  for (;;) {
    const a = inner.indexOf('<row', i);
    if (a === -1) break;
    const te = inner.indexOf('>', a);
    const end = inner[te - 1] === '/' ? te + 1 : inner.indexOf('</row>', te) + 6;
    rows.push(inner.slice(a, end));
    i = end;
  }
  return rows;
}
/** strip the r="..." positional attributes so two rows can be compared on content alone */
const contentOf = (rowXml) =>
  rowXml.replace(/<row\s+[^>]*?\br="\d+"/, '<row').replace(/\br="[A-Z]+\d+"/g, '');

/** true if column A carries no value at all (self-closing, empty inlineStr, or absent). */
function columnAIsBlank(rowXml) {
  const m = /<c\s+[^>]*?\br="A\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/.exec(rowXml);
  if (!m) return true;
  const cell = m[0];
  if (cell.endsWith('/>')) return true;
  return !/<v>|<is>|<t[ >]/.test(cell);
}

/* ---------------------------------------------------------------- setup */

console.log('\nT-QV  QuickVerse catalog (synthetic SKUs)\n');

const catalogBytes = new Uint8Array(readFileSync(CATALOG));
const parsed = parseWorkbook(catalogBytes);
const { products, rows, skeleton, sheetPath } = parsed;

console.log(`  (parsed ${products.length} products, ${parsed.emptyRowCount} padding rows skipped, ` +
            `sheet ${sheetPath})\n`);

/* ---------------------------------------------------------------- T-QV.1 */

t('T-QV.1', 'parses without throwing; 2279 products across 27 categories', () => {
  eq(products.length, 2279, 'product count');
  const cats = new Set(products.map((p) => p.c));
  eq(cats.size, 27, 'distinct product categories');
  return `${products.length} products, ${cats.size} categories`;
});

/* ---------------------------------------------------------------- T-QV.2 */

t('T-QV.2', 'every SKU is non-empty, unique, and synthetic (qv- prefixed)', () => {
  const skus = products.map((p) => p.s);
  ok(skus.every((s) => s.length > 0), 'an empty SKU was produced');
  eq(new Set(skus).size, skus.length, 'SKU uniqueness');
  const nonSynthetic = skus.filter((s) => !s.startsWith('qv-'));
  eq(nonSynthetic.length, 0, 'all SKUs should be synthetic (catalog ships with column A blank)');
  return `all ${skus.length} SKUs unique and qv- prefixed, e.g. ${skus[0]}`;
});

/* ---------------------------------------------------------------- T-QV.3 */

t('T-QV.3', 'parsing the same file twice yields an identical SKU list (stability)', () => {
  const again = parseWorkbook(catalogBytes);
  eq(again.products.length, products.length, 'product count on re-parse');
  for (let i = 0; i < products.length; i++) {
    eq(again.products[i].s, products[i].s, `SKU at index ${i} must be stable across parses`);
  }
  return `${products.length} SKUs identical across two independent parses`;
});

/* ---------------------------------------------------------------- T-QV.4 */

// ~50 SKUs spread evenly through the catalog, in original sheet order.
const step = Math.max(1, Math.floor(products.length / 50));
const sample = [];
for (let i = 0; i < products.length && sample.length < 50; i += step) sample.push(products[i]);
const sampleSkus = sample.map((p) => p.s);

t('T-QV.4', 'byte-level export sanity: column A stays blank, rows stay verbatim', () => {
  const outBytes = buildWorkbook(skeleton, rows, sampleSkus, {});
  writeFileSync(join(OUT, 'quickverse-sample.xlsx'), outBytes);
  const { xml } = sheetOf(outBytes, sheetPath);
  const outRows = dataRows(xml);

  eq(outRows.length, sampleSkus.length + 1, 'header + 50 data rows');

  const dataOnly = outRows.slice(1);
  const withValueInA = dataOnly.filter((r) => !columnAIsBlank(r));
  eq(withValueInA.length, 0, 'a data row has a value in column A');

  for (let i = 0; i < sampleSkus.length; i++) {
    const a = contentOf(dataOnly[i]);
    const b = contentOf(rows[sampleSkus[i]]);
    if (a !== b) {
      throw new Error(`row ${i + 2} differs from its source row (ignoring row number)\n  out: ${a.slice(0, 200)}\n  src: ${b.slice(0, 200)}`);
    }
  }
  return `${sampleSkus.length} rows: column A blank, XML verbatim aside from row numbers`;
});

/* ---------------------------------------------------------------- T-QV.5 */

t('T-QV.5', 'override export: price and size land, everything else untouched', () => {
  const targetSku = sampleSkus[Math.floor(sampleSkus.length / 2)];
  const outBytes = buildWorkbook(skeleton, rows, sampleSkus, {
    [targetSku]: { price: '42', size: '340 g' },
  });
  writeFileSync(join(OUT, 'quickverse-override.xlsx'), outBytes);
  const { xml } = sheetOf(outBytes, sheetPath);
  const outRows = dataRows(xml).slice(1);
  const idx = sampleSkus.indexOf(targetSku);
  const row = outRows[idx];

  const f = /<c\s+r="F\d+"[^>]*><v>(.*?)<\/v><\/c>/.exec(row);
  ok(f, 'F cell missing');
  eq(f[1], '42', 'F (price) value');

  ok(/<c\s+r="K\d+"[^>]*t="inlineStr">.*?340 g.*?<\/c>/.test(row), 'K (size) override missing');

  for (let i = 0; i < sampleSkus.length; i++) {
    if (i === idx) continue;
    eq(contentOf(outRows[i]), contentOf(rows[sampleSkus[i]]), `untouched row ${i}`);
  }
  return `SKU ${targetSku} → F=42, K contains "340 g"; other ${sampleSkus.length - 1} rows untouched`;
});

/* ---------------------------------------------------------------- T-QV.6 (report only) */

t('T-QV.6', 'MRP/price sanity across the whole catalog (report only, never fails)', () => {
  const over = products.filter((p) => p.p > p.m);
  if (over.length > 0) {
    console.log(`  WARNING  ${over.length} row(s) have selling price > MRP. buildWorkbook's ` +
                `fail-closed check (SPEC T-1.21) will reject an export containing them.`);
    for (const p of over.slice(0, 10)) {
      console.log(`           ${p.s}  "${p.n}"  price=${p.p} > mrp=${p.m}`);
    }
  }
  return `${over.length} of ${products.length} rows have price > MRP`;
});

/* ---------------------------------------------------------------- summary */

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
