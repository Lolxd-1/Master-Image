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

/* ------------------------------------------------------------------ synthetic SKUs */

/**
 * Some catalogs (a freshly assembled master sheet, in particular) arrive with column A blank
 * on every row — SmartBiz assigns the real SKU ID only when the file is actually uploaded, so
 * the "Not to be Edited" header just means "not assigned yet". But the app needs a stable key
 * per row from the moment it is parsed: every yes/no choice and every price/name/size fix a
 * shopkeeper makes is stored keyed by SKU, and that work has to survive re-uploading the same
 * catalog next week rather than evaporating because the SKU column is empty. So when a row has
 * no SKU we derive one from the row's own content (name, categories, MRP, image) instead of its
 * position in the sheet — content is stable even if rows get reordered upstream, a row index is
 * not. The derived id lives only inside the app: it is never written into column A, and because
 * buildWorkbook re-emits row XML verbatim the exported file stays exactly as blank there as the
 * source was, so SmartBiz still assigns its own SKU on the real upload.
 */

/** Multiply two uint32 values, returning the full 64-bit product as {hi, lo} uint32 halves. */
function mul32(a, b) {
  const aLo = a & 0xffff, aHi = a >>> 16;
  const bLo = b & 0xffff, bHi = b >>> 16;
  const lo0 = aLo * bLo;
  const mid = aHi * bLo + aLo * bHi;
  const loFull = lo0 + (mid & 0xffff) * 0x10000;
  const carry = Math.floor(loFull / 0x100000000);
  const hi = (aHi * bHi + Math.floor(mid / 0x10000) + carry) >>> 0;
  return { hi, lo: loFull >>> 0 };
}

/** 64-bit multiply of (aHi,aLo) * (bHi,bLo) mod 2^64, via the standard hi/lo split (no BigInt). */
function mul64(aHi, aLo, bHi, bLo) {
  const ll = mul32(aLo, bLo);
  const hl = mul32(aHi, bLo);
  const lh = mul32(aLo, bHi);
  const hi = (ll.hi + hl.lo + lh.lo) >>> 0;
  return { hi, lo: ll.lo };
}

const FNV_OFFSET_HI = 0xcbf29ce4, FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_HI = 0x00000100, FNV_PRIME_LO = 0x000001b3;

/**
 * FNV-1a 64-bit over the UTF-8 bytes of `str`, returned as 16 lowercase hex chars. Pure integer
 * ops so it is byte-identical between Node and the browser, and stable across runs — the whole
 * point of using it as a SKU source.
 * @param {string} str
 */
function fnv1a64Hex(str) {
  let hi = FNV_OFFSET_HI, lo = FNV_OFFSET_LO;
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    const prod = mul64(hi, lo, FNV_PRIME_HI, FNV_PRIME_LO);
    hi = prod.hi;
    lo = prod.lo;
  }
  const hex = (n) => n.toString(16).padStart(8, '0');
  return hex(hi) + hex(lo);
}

/**
 * Derive a stable synthetic SKU for a row with no column-A value, from row content rather than
 * position. `seen` is the same de-dup set parseWorkbook already tracks real SKUs in, so a
 * collision (two rows with identical name/categories/MRP/image) gets `-2`, `-3`, ... appended.
 * @param {Record<string, string|number>} cells
 * @param {string} name  already-trimmed column D value
 * @param {Set<string>} seen
 */
function syntheticSku(cells, name, seen) {
  const canon = [
    name,
    String(cells[COL.PROD_CAT] ?? '').trim(),
    String(cells[COL.BIZ_CAT] ?? '').trim(),
    String(cells[COL.MRP] ?? ''),
    String(cells[COL.IMAGE] ?? '').trim(),
  ].join(' ');
  const hash = fnv1a64Hex(canon);
  let candidate = `qv-${hash}`;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `qv-${hash}-${suffix}`;
    suffix++;
  }
  return candidate;
}

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

    let rowSku = sku;
    if (rowSku) {
      if (seen.has(rowSku)) {
        throw new UploadError(
          `SKU ID "${rowSku}" appears more than once (row ${r + 1}). SKU IDs must be unique.`
        );
      }
    } else {
      rowSku = syntheticSku(cells, name, seen);
    }
    seen.add(rowSku);

    products.push({
      s: rowSku,
      n: name,
      m: Number(cells[COL.MRP] ?? 0),
      p: Number(cells[COL.PRICE] ?? cells[COL.MRP] ?? 0),
      c: String(cells[COL.PROD_CAT] ?? 'Uncategorised').trim() || 'Uncategorised',
      b: String(cells[COL.BIZ_CAT] ?? '').trim(),
      i: String(cells[COL.IMAGE] ?? '').trim(),
    });
    rows[rowSku] = rowXml;
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

/* ------------------------------------------------------------------ overrides (SPEC §6.1, §8) */

const OV_COL = { name: 'D', size: 'K', mrp: 'E', price: 'F' };
const COL_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');

/** Escape for inline-string XML: & first, then < >, strip XML-1.0-illegal controls. */
function escapeInline(s) {
  const stripped = String(s).replace(/[ --]/g, '');
  return stripped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Bare decimal: 12, 12.5, 1234.75 — never exponent, currency, separators or trailing dot. */
function formatDecimal(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${JSON.stringify(v)}`);
  const rounded = Math.round(n * 100) / 100;
  let s = String(rounded);
  if (/[eE]/.test(s)) s = rounded.toFixed(2).replace(/\.?0+$/, '');
  return s;
}

function cellOpenAttrs(rowXml, col) {
  const m = new RegExp(`<c\\s+[^>]*?\\br="${col}\\d+"[^>]*?>`).exec(rowXml);
  return m ? m[0] : null;
}

function styleOf(openTag) {
  const m = /\bs="([^"]*)"/.exec(openTag || '');
  return m ? m[1] : null;
}

function rowNumberOf(rowXml) {
  const m = /<row\s+[^>]*?\br="(\d+)"/.exec(rowXml);
  return m ? m[1] : '2';
}

/**
 * Set one cell in a row, preserving column order. `makeCell(r, s)` returns the full `<c>` element.
 * @param {string} rowXml
 * @param {string} col
 * @param {(r: string, s: string | null) => string} makeCell
 */
function setCell(rowXml, col, makeCell) {
  const rNum = rowNumberOf(rowXml);
  const r = `${col}${rNum}`;
  const openRe = new RegExp(`<c\\s+[^>]*?\\br="${col}\\d+"[^>]*?(?:/>|>)`);
  const m = openRe.exec(rowXml);
  if (!m) {
    // Cell absent: insert in column order so Excel never sees out-of-order cells.
    const s = '2';
    const cell = makeCell(r, s);
    const cells = [];
    const cellRe = /<c\s+[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>.*?<\/c>)/g;
    let match;
    let insertAt = rowXml.length;
    let found = false;
    const want = COL_ORDER.indexOf(col);
    while ((match = cellRe.exec(rowXml)) !== null) {
      cells.push(match);
      if (!found && COL_ORDER.indexOf(match[1]) > want) {
        insertAt = match.index;
        found = true;
      }
    }
    if (!found) {
      // Append just before </row>, or before trailing whitespace.
      const closeAt = rowXml.lastIndexOf('</row>');
      insertAt = closeAt === -1 ? rowXml.length : closeAt;
    }
    return rowXml.slice(0, insertAt) + cell + rowXml.slice(insertAt);
  }
  const openTag = m[0];
  const s = styleOf(openTag);
  if (openTag.endsWith('/>')) {
    return rowXml.slice(0, m.index) + makeCell(r, s) + rowXml.slice(m.index + openTag.length);
  }
  const closeAt = rowXml.indexOf('</c>', m.index);
  const full = rowXml.slice(m.index, closeAt + 4);
  void full;
  return rowXml.slice(0, m.index) + makeCell(r, s) + rowXml.slice(closeAt + 4);
}

function numericInRow(rowXml, col) {
  const m = new RegExp(`<c\\s+[^>]*?\\br="${col}\\d+"[^>]*?>(.*?)</c>`).exec(rowXml);
  if (!m) return null;
  const v = /<v>(.*?)<\/v>/.exec(m[1]);
  return v ? Number(v[1]) : null;
}

/**
 * Apply per-field overrides to one row's XML (SPEC §8). Text D/K become `t="inlineStr"`
 * (sharedStrings.xml is never touched); numeric E/F replace only the `<v>` body, keeping
 * `t="n"` and the `s` style byte-for-byte. Rows with no override pass through untouched.
 *
 * @param {string} rowXml
 * @param {{name?:string,size?:string,mrp?:string,price?:string}} ov
 * @returns {string}
 */
export function applyOverrides(rowXml, ov) {
  if (!ov || (ov.name === undefined && ov.size === undefined && ov.mrp === undefined && ov.price === undefined)) {
    return rowXml;
  }
  let out = rowXml;
  if (ov.name !== undefined) {
    const text = escapeInline(ov.name);
    out = setCell(out, OV_COL.name, (r, s) =>
      `<c r="${r}"${s !== null ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`);
  }
  if (ov.size !== undefined) {
    const text = escapeInline(ov.size);
    out = setCell(out, OV_COL.size, (r, s) =>
      `<c r="${r}"${s !== null ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`);
  }
  if (ov.mrp !== undefined) {
    const num = formatDecimal(ov.mrp);
    out = setCell(out, OV_COL.mrp, (r, s) =>
      `<c r="${r}"${s !== null ? ` s="${s}"` : ''} t="n"><v>${num}</v></c>`);
  }
  if (ov.price !== undefined) {
    const num = formatDecimal(ov.price);
    out = setCell(out, OV_COL.price, (r, s) =>
      `<c r="${r}"${s !== null ? ` s="${s}"` : ''} t="n"><v>${num}</v></c>`);
  }
  // Fail closed: an export can never contain selling price > MRP (T-1.21).
  const e = numericInRow(out, 'E');
  const f = numericInRow(out, 'F');
  if (e !== null && f !== null && f > e) {
    throw new Error(`Selling price (${f}) cannot be more than MRP (${e}).`);
  }
  return out;
}

/**
 * Build a SmartBiz-ready workbook containing only the chosen products.
 *
 * @param {Uint8Array} skeleton  from parseWorkbook
 * @param {Record<string,string>} rows  sku -> original row XML
 * @param {string[]} skus  chosen SKUs, in original sheet order
 * @param {Record<string,{name?:string,size?:string,mrp?:string,price?:string}>} overridesBySku
 *   optional per-SKU overrides — applied BEFORE renumbering; SKUs without an entry pass
 *   through byte-identical. The 3-argument call keeps working unchanged.
 * @returns {Uint8Array}
 */
export function buildWorkbook(skeleton, rows, skus, overridesBySku = {}) {
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
    const ov = overridesBySku[skus[i]];
    // Order: apply overrides, then renumber (SPEC §8).
    out[i + 1] = renumberRow(ov ? applyOverrides(rowXml, ov) : rowXml, i + 2); // row 1 is the header
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
