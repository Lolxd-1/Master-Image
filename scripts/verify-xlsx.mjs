/**
 * T-1 fidelity harness (see SPEC.md §10).
 *
 * Runs the export engine against the real master workbook and checks the output is a faithful
 * SmartBiz upload file. Structural checks live here; an independent openpyxl pass
 * (scripts/verify_xlsx_independent.py) re-reads the output with a different implementation so we
 * are never validating the writer with the writer.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { parseWorkbook, buildWorkbook } from '../web/src/xlsx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(ROOT, 'Master excel.xlsx');
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
const sha = (b) => createHash('sha256').update(b).digest('hex');

/* ---------------------------------------------------------------- helpers */

const SHEET = 'xl/worksheets/sheet2.xml';

function sheetOf(bytes) {
  const parts = unzipSync(bytes);
  return { parts, xml: strFromU8(parts[SHEET]) };
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

/* ---------------------------------------------------------------- setup */

console.log('\nT-1  Excel fidelity\n');

const masterBytes = new Uint8Array(readFileSync(MASTER));
const parsed = parseWorkbook(masterBytes);
const { products, rows, skeleton } = parsed;
const origSheet = sheetOf(masterBytes);
const origRows = dataRows(origSheet.xml);
const origDataRows = origRows.slice(1).filter((r) => {
  const c = contentOf(r);
  return /<v>/.test(c);
});

console.log(`  (parsed ${products.length} products, ${parsed.emptyRowCount} padding rows skipped, ` +
            `skeleton ${(skeleton.length / 1024).toFixed(0)} KB)\n`);

const allSkus = products.map((p) => p.s);

/* ---------------------------------------------------------------- T-1.1 */

t('T-1.1', 'round-trip with all 650 selected is cell-for-cell identical', () => {
  eq(products.length, 650, 'product count');
  const outBytes = buildWorkbook(skeleton, rows, allSkus);
  writeFileSync(join(OUT, 'all.xlsx'), outBytes);
  const out = sheetOf(outBytes);
  const outRows = dataRows(out.xml);

  eq(outRows.length, 651, 'header + 650 data rows');
  eq(contentOf(outRows[0]), contentOf(origRows[0]), 'header row');

  // Compare against the original rows in sheet order, ignoring only position.
  const origBySku = new Map();
  for (const r of origDataRows) origBySku.set(r, r);
  const origList = [...origBySku.keys()];

  for (let i = 0; i < 650; i++) {
    const a = contentOf(outRows[i + 1]);
    const b = contentOf(origList[i]);
    if (a !== b) throw new Error(`row ${i + 2} differs from source row\n  out: ${a.slice(0, 220)}\n  src: ${b.slice(0, 220)}`);
  }
  return 'all 650 rows byte-identical (ignoring row number)';
});

/* ---------------------------------------------------------------- T-1.2 */

t('T-1.2', 'subset export keeps exactly the chosen SKUs, in original order', () => {
  const chosen = products.filter((_, i) => i % 5 === 0).map((p) => p.s); // 130 spread across categories
  const outBytes = buildWorkbook(skeleton, rows, chosen);
  writeFileSync(join(OUT, 'subset.xlsx'), outBytes);
  const outRows = dataRows(sheetOf(outBytes).xml);
  eq(outRows.length, chosen.length + 1, 'row count');

  for (let i = 0; i < chosen.length; i++) {
    eq(contentOf(outRows[i + 1]), contentOf(rows[chosen[i]]), `row ${i + 2}`);
  }
  // row numbers must be contiguous from 2
  outRows.forEach((r, i) => {
    const n = Number(/<row\s+[^>]*?\br="(\d+)"/.exec(r)[1]);
    eq(n, i + 1, `row ${i} numbering`);
  });
  return `${chosen.length} rows, contiguous numbering`;
});

/* ---------------------------------------------------------------- T-1.3 */

t('T-1.3', 'every workbook part except the data sheet is byte-identical', () => {
  const outBytes = buildWorkbook(skeleton, rows, allSkus.slice(0, 10));
  const out = unzipSync(outBytes);
  const src = unzipSync(masterBytes);

  const srcKeys = Object.keys(src).sort();
  const outKeys = Object.keys(out).sort();
  eq(outKeys.join('|'), srcKeys.join('|'), 'zip part list');

  const differing = srcKeys.filter((k) => k !== SHEET && sha(src[k]) !== sha(out[k]));
  ok(differing.length === 0, `these parts changed: ${differing.join(', ')}`);
  return `${srcKeys.length} parts, ${srcKeys.length - 1} hash-identical`;
});

/* ---------------------------------------------------------------- T-1.4 */

t('T-1.4', 'validations, protection and conditional formatting survive', () => {
  const outBytes = buildWorkbook(skeleton, rows, allSkus.slice(0, 50));
  const { xml } = sheetOf(outBytes);
  const count = (re) => (xml.match(re) || []).length;

  eq(count(/<dataValidation[\s>]/g), 23, 'dataValidation blocks');
  eq(count(/<sheetProtection\b/g), 1, 'sheetProtection');
  eq(count(/<conditionalFormatting\b/g), 2, 'conditionalFormatting blocks');
  ok(/algorithmName="SHA-512"/.test(xml), 'SHA-512 protection hash missing');
  ok(/<formula1>BCat<\/formula1>/.test(xml), 'BCat named-range dropdown missing');
  ok(/sqref="G2:G25000"/.test(xml), 'business-category validation range missing');
  return '23 validations + protection + 2 CF blocks intact';
});

/* ---------------------------------------------------------------- T-1.6 */

t('T-1.6', 'image URLs are written unmodified (no display resizing leaks)', () => {
  const outBytes = buildWorkbook(skeleton, rows, allSkus);
  const { parts } = sheetOf(outBytes);
  const sst = strFromU8(parts['xl/sharedStrings.xml']);
  ok(!/_SX\d+_|_SL\d+_|_AC_/.test(sst), 'a resized image URL reached the export');

  const withImg = products.filter((p) => p.i);
  eq(withImg.length, 649, 'products with an image');
  for (const p of withImg.slice(0, 40)) {
    ok(sst.includes(p.i.replace(/&/g, '&amp;')), `URL missing from export: ${p.i}`);
  }
  return '649 URLs, none resized';
});

/* ---------------------------------------------------------------- T-1.7 / T-1.8 / T-1.9 */

t('T-1.7', 'edge: exactly one product selected', () => {
  const outBytes = buildWorkbook(skeleton, rows, [allSkus[0]]);
  writeFileSync(join(OUT, 'single.xlsx'), outBytes);
  eq(dataRows(sheetOf(outBytes).xml).length, 2, 'header + 1 row');
  return products[0].n;
});

t('T-1.8', 'edge: zero selected is refused rather than emitting an empty file', () => {
  let threw = false;
  try { buildWorkbook(skeleton, rows, []); } catch { threw = true; }
  ok(threw, 'building with no selection should throw');
  return 'throws as specified';
});

t('T-1.9', 'edge: the one product with no image exports with an empty column P', () => {
  const sku = '7ddfe115-b5cc-4278-9422-7e4cb300a8e4';
  const p = products.find((x) => x.s === sku);
  ok(p, 'imageless product not found in parse');
  eq(p.i, '', 'image field should be empty string');
  ok(p.n.startsWith('LIPTON GREEN TEA'), `unexpected product: ${p.n}`);

  const outBytes = buildWorkbook(skeleton, rows, [sku]);
  const row = dataRows(sheetOf(outBytes).xml)[1];
  ok(!/undefined|null|NaN/.test(row), 'placeholder text leaked into the row');
  return p.n;
});

/* ---------------------------------------------------------------- T-1.10 */

t('T-1.10', 'MRP and selling price stay numeric cells', () => {
  const outBytes = buildWorkbook(skeleton, rows, allSkus.slice(0, 100));
  const outRows = dataRows(sheetOf(outBytes).xml).slice(1);
  for (const r of outRows) {
    for (const col of ['E', 'F']) {
      const m = new RegExp(`<c r="${col}\\d+"([^>]*)>`).exec(r);
      ok(m, `column ${col} cell missing`);
      ok(!/t="(s|inlineStr|str)"/.test(m[1]), `column ${col} became a text cell — SmartBiz rejects text prices`);
    }
  }
  return '100 rows checked, E and F numeric';
});

/* ---------------------------------------------------------------- T-1.11 */

t('T-1.11', 'special characters survive and XML stays well-formed', () => {
  const tricky = products.filter((p) => /['&<>,]/.test(p.n));
  ok(tricky.length > 0, 'no products with special characters to test');
  const outBytes = buildWorkbook(skeleton, rows, tricky.map((p) => p.s));
  writeFileSync(join(OUT, 'special.xlsx'), outBytes);

  const { xml } = sheetOf(outBytes);
  // bare & that is not a well-formed entity would break every XML reader
  const bad = xml.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g);
  ok(!bad, `malformed XML entity found (${bad && bad.length} occurrences)`);

  const lays = products.find((p) => p.n.includes("LAY'S"));
  ok(lays, "LAY'S product not found");
  return `${tricky.length} products with special chars, e.g. ${lays.n}`;
});

/* ---------------------------------------------------------------- T-1.12 */

t('T-1.12', 'table range and dimension are internally consistent', () => {
  const outBytes = buildWorkbook(skeleton, rows, allSkus.slice(0, 137));
  const { parts, xml } = sheetOf(outBytes);
  const table = strFromU8(parts['xl/tables/table1.xml']);

  const tableRef = /ref="([A-Z]+\d+:[A-Z]+(\d+))"/.exec(table);
  const dimRef = /<dimension ref="([A-Z]+\d+:[A-Z]+(\d+))"/.exec(xml);
  ok(tableRef && dimRef, 'missing table or dimension ref');
  eq(tableRef[1], dimRef[1], 'table ref and dimension must agree');

  // Rows present must fit inside the declared range.
  const emitted = dataRows(xml).length;
  ok(emitted <= Number(dimRef[2]), `emitted ${emitted} rows but dimension declares ${dimRef[2]}`);
  return `${emitted} rows within ${dimRef[1]}`;
});

/* ---------------------------------------------------------------- summary */

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
