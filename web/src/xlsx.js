/**
 * XLSX engine for the Amazon SmartBiz bulk-upload template.
 *
 * Design note — why this file exists instead of a spreadsheet library:
 *
 * The template carries 23 dataValidation blocks bound to named ranges on a hidden DataSheet,
 * a SHA-512 sheetProtection element, conditional formatting, 28 table definitions, and 2416
 * shared strings that every data cell references *by index*. A library that rebuilds the
 * workbook has to reproduce all of that perfectly or the file silently stops being a valid
 * SmartBiz upload. It would also need ~500 MB of RAM for 625,000 cells.
 *
 * So we never rebuild. We keep each product row's original XML verbatim and splice the chosen
 * rows back into an otherwise byte-identical copy of the workbook. The only thing we change is
 * a row's number, which has to change because the row moved. Everything else — values, styles,
 * shared-string indices — is carried across untouched.
 *
 * Plain JS with JSDoc rather than TS so the Node test harness can import it directly, with no
 * build step between the code under test and the test.
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

const SHEET_NAME = 'bulk_upload_template';

/** Columns we surface in the UI. Everything else rides along untouched inside the row XML. */
const COL = { SKU: 'A', NAME: 'D', MRP: 'E', PRICE: 'F', BIZ_CAT: 'G', PROD_CAT: 'H', IMAGE: 'P' };

/* ------------------------------------------------------------------ XML helpers */

const XML_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** @param {string} s */
function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return XML_ENTITY[name];
  });
}

/**
 * Split a container's children into top-level element strings.
 * The workbook is machine-generated and never nests <row> in <row> or <c> in <c>,
 * so a linear scan is both correct and ~100x faster than a DOM parse over 14.8 MB.
 * @param {string} xml
 * @param {string} tag
 * @returns {string[]}
 */
function splitElements(xml, tag) {
  const out = [];
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let i = 0;
  for (;;) {
    const start = xml.indexOf(open, i);
    if (start === -1) return out;
    // Guard against matching <rows> when looking for <row>.
    const after = xml[start + open.length];
    if (after !== ' ' && after !== '>' && after !== '/') { i = start + open.length; continue; }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd === -1) return out;
    let end;
    if (xml[tagEnd - 1] === '/') {
      end = tagEnd + 1;
    } else {
      const closeAt = xml.indexOf(close, tagEnd);
      if (closeAt === -1) return out;
      end = closeAt + close.length;
    }
    out.push(xml.slice(start, end));
    i = end;
  }
}

/** @param {string} xml @param {string} tag */
function sectionOf(xml, tag) {
  const openAt = xml.indexOf('<' + tag);
  if (openAt === -1) return null;
  const tagEnd = xml.indexOf('>', openAt);
  if (xml[tagEnd - 1] === '/') return { start: openAt, end: tagEnd + 1, inner: '' };
  const closeAt = xml.indexOf('</' + tag + '>', tagEnd);
  return { start: openAt, end: closeAt + tag.length + 3, inner: xml.slice(tagEnd + 1, closeAt) };
}

/* ------------------------------------------------------------------ shared strings */

/**
 * Shared strings are read only to build the UI's display fields. The file itself ships
 * unchanged, so exported rows keep resolving through it exactly as before.
 * @param {string} xml
 * @returns {string[]}
 */
function parseSharedStrings(xml) {
  return splitElements(xml, 'si').map((si) => {
    let text = '';
    for (const t of splitElements(si, 't')) {
      const inner = sectionOf(t, 't');
      if (inner) text += unescapeXml(inner.inner);
    }
    return text;
  });
}

/* ------------------------------------------------------------------ cells */

/**
 * @param {string} rowXml
 * @param {string[]} sst
 * @returns {Record<string, string|number>} column letter -> value
 */
function cellsOf(rowXml, sst) {
  /** @type {Record<string, string|number>} */
  const out = {};
  for (const c of splitElements(rowXml, 'c')) {
    const tagEnd = c.indexOf('>');
    const openTag = c.slice(0, tagEnd + 1);
    const refM = /\br="([A-Z]+)\d+"/.exec(openTag);
    if (!refM) continue;
    const col = refM[1];
    if (openTag.endsWith('/>')) continue; // styled but empty

    const typeM = /\bt="([^"]+)"/.exec(openTag);
    const type = typeM ? typeM[1] : 'n';
    const body = c.slice(tagEnd + 1, c.length - 4); // strip </c>

    let value;
    if (type === 'inlineStr') {
      let text = '';
      for (const t of splitElements(body, 't')) {
        const inner = sectionOf(t, 't');
        if (inner) text += unescapeXml(inner.inner);
      }
      value = text;
    } else {
      const v = sectionOf(body, 'v');
      if (!v) continue;
      const raw = unescapeXml(v.inner);
      if (type === 's') value = sst[Number(raw)] ?? '';
      else if (type === 'str' || type === 'e') value = raw;
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else value = raw === '' ? '' : Number(raw);
    }
    if (value !== '' && value !== undefined) out[col] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ workbook plumbing */

/**
 * Resolve the data sheet's part path via workbook.xml + rels rather than hardcoding
 * "sheet2.xml", so a re-exported template with reordered parts still works.
 * @param {Record<string, Uint8Array>} parts
 */
function findSheetPath(parts) {
  const wb = parts['xl/workbook.xml'];
  if (!wb) throw new UploadError('This is not a valid .xlsx file (no workbook found).');
  const wbXml = strFromU8(wb);

  const sheet = splitElements(wbXml, 'sheet').find((s) => {
    const n = /\bname="([^"]*)"/.exec(s);
    return n && unescapeXml(n[1]) === SHEET_NAME;
  });
  if (!sheet) {
    throw new UploadError(
      `This workbook has no "${SHEET_NAME}" sheet, so it is not an Amazon SmartBiz ` +
      `bulk-upload template. Please upload the sheet exactly as downloaded from SmartBiz.`
    );
  }
  const ridM = /r:id="([^"]+)"/.exec(sheet);
  if (!ridM) throw new UploadError('The workbook is missing a link to its data sheet.');

  const relsPart = parts['xl/_rels/workbook.xml.rels'];
  if (!relsPart) throw new UploadError('This .xlsx file is damaged (its internal index is missing). Try re-downloading it from SmartBiz.');
  const relsXml = strFromU8(relsPart);
  const rel = splitElements(relsXml, 'Relationship').find((r) => r.includes(`Id="${ridM[1]}"`));
  const targetM = rel && /Target="([^"]+)"/.exec(rel);
  if (!targetM) throw new UploadError('The workbook is missing a link to its data sheet.');

  const target = targetM[1].replace(/^\//, '').replace(/^\.\//, '');
  const path = target.startsWith('xl/') ? target : 'xl/' + target;
  if (!parts[path]) throw new UploadError('This .xlsx file is damaged (its data sheet is missing).');
  return path;
}

export class UploadError extends Error {}

/* ------------------------------------------------------------------ parse */

/**
 * @typedef {Object} Product
 * @property {string} s SKU ID (column A) — primary key
 * @property {string} n product name
 * @property {number} m MRP
 * @property {number} p selling price
 * @property {string} c product category
 * @property {string} b business category
 * @property {string} i original image URL, unresized ("" when absent)
 */

/**
 * Read a master workbook into everything the app needs.
 *
 * @param {Uint8Array} bytes
 * @returns {{
 *   products: Product[],
 *   rows: Record<string, string>,
 *   skeleton: Uint8Array,
 *   sheetPath: string,
 *   emptyRowCount: number
 * }}
 */
export function parseWorkbook(bytes) {
  /** @type {Record<string, Uint8Array>} */
  let parts;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new UploadError('That file is not readable as an Excel workbook (.xlsx). If it is a .xls or .csv, re-save it as .xlsx first.');
  }

  const sheetPath = findSheetPath(parts);
  const sst = parts['xl/sharedStrings.xml'] ? parseSharedStrings(strFromU8(parts['xl/sharedStrings.xml'])) : [];

  const sheetXml = strFromU8(parts[sheetPath]);
  const data = sectionOf(sheetXml, 'sheetData');
  if (!data) throw new UploadError('The data sheet appears to be empty.');

  const allRows = splitElements(data.inner, 'row');
  if (allRows.length === 0) throw new UploadError('The data sheet has no rows.');

  const headerRow = allRows[0];

  /** @type {Product[]} */
  const products = [];
  /** @type {Record<string, string>} */
  const rows = {};
  let emptyRowCount = 0;
  const seen = new Set();

  for (let r = 1; r < allRows.length; r++) {
    const rowXml = allRows[r];
    const cells = cellsOf(rowXml, sst);

    const sku = String(cells[COL.SKU] ?? '').trim();
    const name = String(cells[COL.NAME] ?? '').trim();
    if (!sku && !name) { emptyRowCount++; continue; } // padding row

    if (!sku) {
      throw new UploadError(
        `Row ${r + 1} has a product name ("${name}") but no SKU ID in column A. ` +
        `Every product needs its SKU ID — that is how the app tracks your choices.`
      );
    }
    if (seen.has(sku)) {
      throw new UploadError(
        `SKU ID "${sku}" appears more than once (row ${r + 1}). SKU IDs must be unique.`
      );
    }
    seen.add(sku);

    products.push({
      s: sku,
      n: name,
      m: Number(cells[COL.MRP] ?? 0),
      p: Number(cells[COL.PRICE] ?? cells[COL.MRP] ?? 0),
      c: String(cells[COL.PROD_CAT] ?? 'Uncategorised').trim() || 'Uncategorised',
      b: String(cells[COL.BIZ_CAT] ?? '').trim(),
      i: String(cells[COL.IMAGE] ?? '').trim(),
    });
    rows[sku] = rowXml;
  }

  if (products.length === 0) {
    throw new UploadError('No products found. Check that the bulk_upload_template sheet has rows below the header.');
  }

  // The skeleton is the original workbook with the header row alone in sheetData.
  // Every other part is carried over untouched, which is what keeps exports faithful.
  const skeletonSheet =
    sheetXml.slice(0, data.start) +
    '<sheetData>' + headerRow + '</sheetData>' +
    sheetXml.slice(data.end);

  const skeletonParts = { ...parts, [sheetPath]: strToU8(skeletonSheet) };
  const skeleton = zipSync(skeletonParts, { level: 6 });

  return { products, rows, skeleton, sheetPath, emptyRowCount };
}

/* ------------------------------------------------------------------ build */

/**
 * Move a row to a new position. Only the row number changes; values, styles and
 * shared-string indices are untouched, which is what makes the export lossless.
 * @param {string} rowXml
 * @param {number} n
 */
function renumberRow(rowXml, n) {
  return rowXml
    .replace(/^(<row\s+[^>]*?\br=")\d+"/, `$1${n}"`)
    .replace(/(<c\s+[^>]*?\br="[A-Z]+)\d+"/g, `$1${n}"`);
}

/**
 * Build a SmartBiz-ready workbook containing only the chosen products.
 *
 * @param {Uint8Array} skeleton  from parseWorkbook
 * @param {Record<string,string>} rows  sku -> original row XML
 * @param {string[]} skus  chosen SKUs, in original sheet order
 * @returns {Uint8Array}
 */
export function buildWorkbook(skeleton, rows, skus) {
  if (!skus.length) throw new Error('Nothing selected — there is no file to build.');

  const parts = unzipSync(skeleton);
  const sheetPath = findSheetPath(parts);
  const sheetXml = strFromU8(parts[sheetPath]);
  const data = sectionOf(sheetXml, 'sheetData');
  const headerRow = splitElements(data.inner, 'row')[0];

  const out = new Array(skus.length + 1);
  out[0] = headerRow;
  for (let i = 0; i < skus.length; i++) {
    const rowXml = rows[skus[i]];
    if (!rowXml) throw new Error(`No source row for SKU ${skus[i]} — the catalog may have changed.`);
    out[i + 1] = renumberRow(rowXml, i + 2); // row 1 is the header
  }

  const rebuilt =
    sheetXml.slice(0, data.start) +
    '<sheetData>' + out.join('') + '</sheetData>' +
    sheetXml.slice(data.end);

  parts[sheetPath] = strToU8(rebuilt);
  return zipSync(parts, { level: 6 });
}

/**
 * Group products by category, ordered by size — this is the home screen.
 * @param {Product[]} products
 */
export function groupByCategory(products) {
  /** @type {Map<string, Product[]>} */
  const map = new Map();
  for (const p of products) {
    let list = map.get(p.c);
    if (!list) map.set(p.c, (list = []));
    list.push(p);
  }
  return [...map.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

/**
 * Amazon serves resized variants from the same URL. Used for display only —
 * the original URL is what gets written to the export.
 * @param {string} url @param {200|400} px
 */
export function thumb(url, px) {
  if (!url) return '';
  return url.replace(/\.(jpg|jpeg|png)$/i, `._SX${px}_.$1`);
}
