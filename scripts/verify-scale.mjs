/**
 * T-4.1 / T-4.3 scale check (SPEC.md §10).
 *
 * The real master is one store (650 rows). The combined sheet for all four stores will be
 * roughly 3000. This builds a synthetic workbook of that size from the real one -- same styles,
 * same shared strings, same validations -- and measures parse and export.
 *
 * SKUs on the replicated rows are rewritten as inline strings so every row still has a unique
 * primary key without touching sharedStrings.xml.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { parseWorkbook, buildWorkbook, groupByCategory } from '../web/src/xlsx.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.test-output');
mkdirSync(OUT, { recursive: true });
const SHEET = 'xl/worksheets/sheet2.xml';
const COPIES = 5; // 650 x 5 = 3250 rows

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
const ok = (c, m) => { if (!c) throw new Error(m); };
const ms = (t0) => `${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`;
const now = () => process.hrtime.bigint();

/* ---------------------------------------------------------------- build the fixture */

function splitEls(xml, tag) {
  const out = [];
  let i = 0;
  for (;;) {
    const a = xml.indexOf('<' + tag, i);
    if (a === -1) return out;
    const te = xml.indexOf('>', a);
    const end = xml[te - 1] === '/' ? te + 1 : xml.indexOf(`</${tag}>`, te) + tag.length + 3;
    out.push(xml.slice(a, end));
    i = end;
  }
}

console.log('\nT-4  Scale (synthetic combined catalog)\n');

const master = new Uint8Array(readFileSync(join(ROOT, 'Master excel.xlsx')));
const parts = unzipSync(master);
const sheetXml = strFromU8(parts[SHEET]);
const sdStart = sheetXml.indexOf('<sheetData>');
const sdEnd = sheetXml.indexOf('</sheetData>');
const allRows = splitEls(sheetXml.slice(sdStart + 11, sdEnd), 'row');
const header = allRows[0];
const dataRows = allRows.slice(1).filter((r) => /<v>|<is>/.test(r));

const renumber = (r, n) =>
  r.replace(/^(<row\s+[^>]*?\br=")\d+"/, `$1${n}"`)
   .replace(/(<c\s+[^>]*?\br="[A-Z]+)\d+"/g, `$1${n}"`);

const built = [header];
let rowNo = 2;
for (let copy = 0; copy < COPIES; copy++) {
  for (const r of dataRows) {
    let row = renumber(r, rowNo);
    if (copy > 0) {
      // Give the replica a unique SKU without adding shared strings.
      row = row.replace(
        /<c r="A\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/,
        `<c r="A${rowNo}" s="16" t="inlineStr"><is><t>copy${copy}-${rowNo}-0000-0000-000000000000</t></is></c>`
      );
    }
    built.push(row);
    rowNo++;
  }
}
const fixtureSheet = sheetXml.slice(0, sdStart) + '<sheetData>' + built.join('') + '</sheetData>' + sheetXml.slice(sdEnd + 12);
const fixture = zipSync({ ...parts, [SHEET]: strToU8(fixtureSheet) }, { level: 6 });
writeFileSync(join(OUT, 'scale-master.xlsx'), fixture);

const expected = dataRows.length * COPIES;
console.log(`  (fixture: ${expected} rows, ${(fixture.length / 1024 / 1024).toFixed(2)} MB on disk)\n`);

/* ---------------------------------------------------------------- tests */

let parsed;
t('T-4.1a', `parses a ${expected}-row combined catalog`, () => {
  const t0 = now();
  parsed = parseWorkbook(fixture);
  const took = ms(t0);
  ok(parsed.products.length === expected, `expected ${expected} products, got ${parsed.products.length}`);
  const skus = new Set(parsed.products.map((p) => p.s));
  ok(skus.size === expected, `SKUs not unique: ${skus.size} of ${expected}`);
  return `${took}, skeleton ${(parsed.skeleton.length / 1024).toFixed(0)} KB`;
});

t('T-4.1b', 'categories group correctly at scale', () => {
  const groups = groupByCategory(parsed.products);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  ok(total === expected, `grouped ${total}, expected ${expected}`);
  ok(groups.length === 11, `expected 11 categories, got ${groups.length}`);
  ok(groups[0].items.length >= groups[groups.length - 1].items.length, 'groups not sorted by size');
  return `${groups.length} categories, largest ${groups[0].name} (${groups[0].items.length})`;
});

t('T-4.3', 'export of a realistic selection is fast enough for a phone', () => {
  // A store owner typically stocks a large minority of a combined city catalog.
  const chosen = parsed.products.filter((_, i) => i % 5 !== 0).map((p) => p.s);
  const t0 = now();
  const out = buildWorkbook(parsed.skeleton, parsed.rows, chosen);
  const took = Number(process.hrtime.bigint() - t0) / 1e6;
  writeFileSync(join(OUT, 'scale-export.xlsx'), out);

  const outRows = splitEls(strFromU8(unzipSync(out)[SHEET]).match(/<sheetData>[\s\S]*<\/sheetData>/)[0], 'row');
  ok(outRows.length === chosen.length + 1, `expected ${chosen.length + 1} rows, got ${outRows.length}`);
  ok(took < 5000, `export took ${took.toFixed(0)} ms, budget is 5000 ms`);
  return `${chosen.length} rows in ${took.toFixed(0)} ms, file ${(out.length / 1024).toFixed(0)} KB`;
});

t('T-4.1c', 'payload sizes stay inside the free-tier and mobile budget', () => {
  const productsJson = JSON.stringify(parsed.products).length;
  const rowsJson = JSON.stringify(parsed.rows).length;
  ok(rowsJson < 25 * 1024 * 1024, `row map ${(rowsJson / 1024 / 1024).toFixed(1)} MB exceeds the 25 MB KV value limit`);
  ok(productsJson < 2 * 1024 * 1024, `products payload ${(productsJson / 1024).toFixed(0)} KB is too heavy for the mobile critical path`);
  return `products ${(productsJson / 1024).toFixed(0)} KB, rows ${(rowsJson / 1024 / 1024).toFixed(1)} MB, skeleton ${(parsed.skeleton.length / 1024).toFixed(0)} KB`;
});

t('T-4.4', 're-parsing the same workbook is deterministic', () => {
  const again = parseWorkbook(fixture);
  ok(again.products.length === parsed.products.length, 'product count drifted');
  ok(JSON.stringify(again.products) === JSON.stringify(parsed.products), 'product list differs between parses');
  ok(again.skeleton.length === parsed.skeleton.length, 'skeleton size differs between parses');
  return 'identical across two parses';
});

t('T-4.5', 'malformed uploads are rejected with a readable message', () => {
  const cases = [
    ['a CSV', strToU8('name,price\nfoo,10\n')],
    ['random bytes', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
    ['an empty file', new Uint8Array(0)],
  ];
  for (const [label, bytes] of cases) {
    let msg = null;
    try { parseWorkbook(bytes); } catch (e) { msg = e.message; }
    ok(msg, `${label} was accepted but should have been rejected`);
    ok(!/undefined|\[object|Cannot read/.test(msg), `${label} gave a developer-ish message: ${msg}`);
  }
  // A valid zip that is not this template.
  let msg = null;
  try { parseWorkbook(zipSync({ 'hello.txt': strToU8('hi') })); } catch (e) { msg = e.message; }
  ok(msg && /not a valid|no workbook/i.test(msg), `wrong-zip message unclear: ${msg}`);
  return 'CSV, junk, empty and wrong-zip all rejected clearly';
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
