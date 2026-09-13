/**
 * Pack-size parsing and formatting (production v2, Phase 3).
 *
 * Shopkeepers correct a pack size ("340 g" → "360 g") far more often than they change
 * the unit, and when they do change the unit it is almost always because the original
 * label was wrong ("g" typed where the pack is really "ml"), not because they want the
 * number converted. So changing the unit here NEVER rescales the value — 250 g → 250 ml,
 * not 0.25 ml. That is a deliberate product decision, not an oversight.
 *
 * Pure functions only: no DOM, no imports, safe to unit-test and to import from a worker.
 */

export type Unit = 'g' | 'kg' | 'ml' | 'L' | 'pc';

export const UNITS: readonly Unit[] = ['g', 'kg', 'ml', 'L', 'pc'];

export interface PackSize {
  readonly value: number;
  readonly unit: Unit;
}

// Every spelling a shopkeeper or a supplier's product-name column is likely to use,
// mapped to the canonical unit. Keys are matched case-insensitively.
const UNIT_WORDS: Record<string, Unit> = {
  g: 'g',
  gm: 'g',
  gms: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  kgs: 'kg',
  kilo: 'kg',
  kilogram: 'kg',
  ml: 'ml',
  mls: 'ml',
  millilitre: 'ml',
  milliliter: 'ml',
  l: 'L',
  ltr: 'L',
  ltrs: 'L',
  litre: 'L',
  liter: 'L',
  pc: 'pc',
  pcs: 'pc',
  piece: 'pc',
  pieces: 'pc',
  pack: 'pc',
  packs: 'pc',
  n: 'pc',
  no: 'pc',
};

// Longest spellings first so e.g. "grams" isn't cut short by trying "gram" — not that it
// matters for correctness (the trailing boundary below makes the alternation backtrack
// into the longer word anyway), but it keeps the compiled pattern's happy path short.
const UNIT_WORD_PATTERN = Object.keys(UNIT_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

// A number immediately (optional whitespace) followed by a recognised unit word, where the
// digits are not glued to a letter on the left (rules out "B12") and the unit word is not
// glued to more letters/digits on the right (rules out "g" matching inside "grip").
const SIZE_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9])(\\d+(?:\\.\\d+)?)\\s*(${UNIT_WORD_PATTERN})(?![A-Za-z0-9])`,
  'gi',
);

const FULL_SIZE_RE = new RegExp(`^\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_WORD_PATTERN})\\s*$`, 'i');

/** Parse a stored/typed size string: "340 g", "1.5L", "250ml", "6 pc", "2 KG" → PackSize | null */
export function parsePackSize(s: string): PackSize | null {
  const m = FULL_SIZE_RE.exec(s);
  if (!m) return null;
  const unit = UNIT_WORDS[m[2].toLowerCase()];
  if (!unit) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > packSizeMax(unit)) return null;
  return { value, unit };
}

/** Best-effort pack size read out of a product name. Returns null when there isn't one. */
export function packSizeFromName(name: string): PackSize | null {
  // Real product names put the size at the end ("... FaceWash 100ML"), so scan every
  // number+unit token in the string and take the LAST one that is actually valid.
  const matches = Array.from(name.matchAll(SIZE_TOKEN_RE));
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const unit = UNIT_WORDS[m[2].toLowerCase()];
    if (!unit) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > packSizeMax(unit)) continue;
    return { value, unit };
  }
  return null;
}

/** Canonical stored form, always "<number> <unit>": "340 g", "1.5 L", "6 pc". */
export function formatPackSize(ps: PackSize): string {
  const decimals = packSizeDecimals(ps.unit);
  let str = ps.value.toFixed(decimals);
  if (decimals > 0) {
    // Strip trailing zeros (and a now-bare trailing dot): "1.50" -> "1.5", "1.00" -> "1".
    str = str.replace(/\.?0+$/, '');
  }
  // Always short — the longest possible result here (e.g. "20000 g") is nowhere near the
  // server's 50-character cap, but callers concatenating a name in front should keep an eye on it.
  return `${str} ${ps.unit}`;
}

/** Sensible increment for the current value+unit. */
export function packSizeStep(ps: PackSize): number {
  if (ps.unit === 'pc') return 1;
  if (ps.unit === 'kg' || ps.unit === 'L') return ps.value < 1 ? 0.05 : 0.25;
  // g or ml
  if (ps.value < 20) return 1;
  if (ps.value < 100) return 5;
  if (ps.value < 1000) return 10;
  return 50;
}

/** Upper bound per unit. */
export function packSizeMax(unit: Unit): number {
  if (unit === 'g' || unit === 'ml') return 20000;
  if (unit === 'kg' || unit === 'L') return 100;
  return 500; // pc
}

/** Decimal places to show/round for a unit: 0 for g/ml/pc, 2 for kg/L. */
export function packSizeDecimals(unit: Unit): number {
  return unit === 'kg' || unit === 'L' ? 2 : 0;
}
