/**
 * Edit sheet — SPEC.md §9.3d (production v3, Phase 3).
 *
 * Rebuilt to fit on one screen at 360×640 with no scrolling: three steppers (selling
 * price, MRP, pack size) instead of four stacked text fields + keyboard. Selling price's
 * range is live-clamped to the current MRP stepper value, so "price above MRP" is
 * structurally impossible rather than a validation message — the export fails closed on
 * that rule, so it is enforced here, not just checked.
 *
 * Per field: an "Original: …" line + a 44px ↺ reset appear only once that field differs
 * from the *catalog* value (never a full-width always-there reset button). "Reset all"
 * is the destructive path — it writes through to the store immediately, behind
 * `confirmDialog`. Everything else here is draft-only until Save.
 *
 * Product names are user-supplied (an uploaded spreadsheet), so anything derived from
 * them is set via `textContent`, never `innerHTML` — the inline SVG icon strings below are
 * static, developer-authored markup, not user data, which is the one place `innerHTML` is
 * safe in this codebase. Every icon carries explicit width/height: an <svg> with only a
 * viewBox has no intrinsic size and renders at the UA default 300×150 otherwise.
 */

import { store } from '../store';
import type { Product } from '../api';
import { toast, confirmDialog, trapFocus, lockBodyScroll } from '../ui';
import { thumb } from '../xlsx.js';
import { createStepper, type StepperHandle } from '../stepper';
import {
  UNITS,
  parsePackSize,
  packSizeFromName,
  formatPackSize,
  packSizeStep,
  packSizeMax,
  type PackSize,
  type Unit,
} from '../units';

const ICON_PENCIL =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_CLOSE =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_RESET =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';

function formatRupees(n: number): string {
  return '₹' + n.toLocaleString('en-IN');
}

/** Smallest sensible stepper minimum for a unit — whole units for g/ml/pc, 0.05 for kg/L. */
function sizeMin(u: Unit): number {
  return u === 'kg' || u === 'L' ? 0.05 : 1;
}

export function openEditSheet(p: Product, onSaved: () => void): void {
  const ov = store.getOverride(p.s) ?? {};
  const displayName = ov.name ?? p.n;

  // ---------------------------------------------------------------- draft state
  let draftName = displayName;
  let mrpValue = ov.mrp !== undefined ? Number(ov.mrp) : p.m;
  let priceValue = ov.price !== undefined ? Number(ov.price) : p.p;

  // Pack size seed: an existing override wins, then a best-effort read of the (possibly
  // already-overridden) name, then an inert placeholder that reads as "not set" until touched.
  const seedFromOverride = ov.size ? parsePackSize(ov.size) : null;
  const seedFromName = packSizeFromName(displayName);
  const seedPS: PackSize = seedFromOverride ?? seedFromName ?? { value: 1, unit: 'pc' };
  const isPlaceholderStart = !seedFromOverride && !seedFromName;
  // The catalog's own guess — used for "Original: …" / reset-to-original, independent of
  // whatever the shopkeeper has already renamed this product to.
  const baselinePS = packSizeFromName(p.n);
  let curUnit: Unit = seedPS.unit;
  let sizeTouched = false;

  // Session-start snapshot: what "dirty" (for the close-confirm) is measured against.
  // Deliberately different from the catalog comparisons below — a product that already had
  // overrides before this sheet opened is not "dirty" just for having been opened.
  const sessionStart = {
    name: draftName,
    mrp: mrpValue,
    price: priceValue,
    sizeStr: formatPackSize(seedPS),
  };

  // ---------------------------------------------------------------- scrim + sheet shell

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.tabIndex = -1;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', `Edit ${p.n}`);

  const handle = document.createElement('div');
  handle.className = 'sheet__handle';
  handle.setAttribute('aria-hidden', 'true');

  // ---------------------------------------------------------------- header: thumb + name + close

  const header = document.createElement('div');
  header.className = 'sheet__header';

  if (p.i) {
    const img = document.createElement('img');
    img.className = 'sheet__thumb';
    img.src = thumb(p.i, 200);
    img.alt = '';
    header.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'sheet__thumb sheet__thumb--empty';
    ph.textContent = displayName.charAt(0).toUpperCase();
    ph.setAttribute('aria-hidden', 'true');
    header.appendChild(ph);
  }

  const nameWrap = document.createElement('div');
  nameWrap.className = 'sheet__name-wrap';

  const nameViewRow = document.createElement('div');
  nameViewRow.className = 'sheet__name-view';
  const nameDisplay = document.createElement('span');
  nameDisplay.className = 'sheet__name';
  const nameEditBtn = document.createElement('button');
  nameEditBtn.type = 'button';
  nameEditBtn.className = 'sheet__name-edit';
  nameEditBtn.innerHTML = ICON_PENCIL;
  nameEditBtn.setAttribute('aria-label', 'Edit product name');
  const nameResetBtn = document.createElement('button');
  nameResetBtn.type = 'button';
  nameResetBtn.className = 'sheet__name-reset';
  nameResetBtn.innerHTML = ICON_RESET;
  nameResetBtn.setAttribute('aria-label', 'Reset name to original');
  nameResetBtn.hidden = true;
  nameViewRow.append(nameDisplay, nameEditBtn, nameResetBtn);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 200;
  nameInput.setAttribute('inputmode', 'text');
  nameInput.className = 'sheet__name-input';
  nameInput.setAttribute('aria-label', 'Product name');
  nameInput.hidden = true;

  nameWrap.append(nameViewRow, nameInput);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sheet__close';
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.setAttribute('aria-label', 'Close');

  header.append(nameWrap, closeBtn);

  const nameMeta = document.createElement('p');
  nameMeta.className = 'sheet__name-meta';
  nameMeta.hidden = true;

  // ---------------------------------------------------------------- generic field wrapper

  function buildField(
    label: string,
    content: HTMLElement[],
    dirty: () => boolean,
    origText: () => string,
    onReset: () => void,
  ): { wrap: HTMLElement; refresh: () => void } {
    const wrap = document.createElement('div');
    wrap.className = 'sheet__field';
    const head = document.createElement('div');
    head.className = 'sheet__field-head';
    const lab = document.createElement('span');
    lab.className = 'sheet__field-label';
    lab.textContent = label;
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'sheet__reset';
    resetBtn.innerHTML = ICON_RESET;
    resetBtn.setAttribute('aria-label', `Reset ${label} to original`);
    resetBtn.hidden = true;
    head.append(lab, resetBtn);
    const origLine = document.createElement('p');
    origLine.className = 'sheet__orig';
    origLine.hidden = true;
    wrap.append(head, ...content, origLine);

    function refresh(): void {
      const d = dirty();
      resetBtn.hidden = !d;
      origLine.hidden = !d;
      if (d) origLine.textContent = origText();
    }
    resetBtn.addEventListener('click', () => {
      onReset();
      refresh();
    });
    refresh();
    return { wrap, refresh };
  }

  // ---------------------------------------------------------------- selling price + MRP

  const priceStepper: StepperHandle = createStepper({
    value: priceValue,
    min: 0,
    max: mrpValue,
    step: 1,
    decimals: 0,
    format: formatRupees,
    label: 'Selling price',
    size: 'lg',
    onInput: (v) => {
      priceValue = v;
      fieldPrice.refresh();
    },
    onCommit: (v) => {
      priceValue = v;
    },
  });

  function updatePriceHint(): void {
    const diff = mrpValue - priceValue;
    priceStepper.setHint(diff === 0 ? 'Same as MRP' : `MRP ${formatRupees(mrpValue)} · you save ${formatRupees(diff)}`);
  }
  updatePriceHint();

  function resetPrice(): void {
    priceStepper.setValue(p.p, true);
    priceValue = priceStepper.getValue();
    updatePriceHint();
  }

  const mrpStepper: StepperHandle = createStepper({
    value: mrpValue,
    min: 1,
    max: 999999,
    step: 1,
    decimals: 0,
    format: formatRupees,
    label: 'MRP',
    size: 'sm',
    onInput: onMrpChanged,
    onCommit: (v) => {
      mrpValue = v;
    },
  });

  function onMrpChanged(v: number): void {
    mrpValue = v;
    priceStepper.setRange(0, v);
    priceValue = priceStepper.getValue(); // setRange re-clamps silently — resync our copy
    updatePriceHint();
    fieldPrice.refresh();
    fieldMrp.refresh();
  }

  function resetMrp(): void {
    mrpStepper.setValue(p.m, true);
    onMrpChanged(mrpStepper.getValue());
  }

  const fieldPrice = buildField(
    'Selling price',
    [priceStepper.el],
    () => priceValue !== p.p,
    () => `Original: ${formatRupees(p.p)}`,
    resetPrice,
  );
  const fieldMrp = buildField(
    'MRP',
    [mrpStepper.el],
    () => mrpValue !== p.m,
    () => `Original: ${formatRupees(p.m)}`,
    resetMrp,
  );

  // ---------------------------------------------------------------- pack size

  function currentSizeStr(): string {
    return formatPackSize({ value: sizeStepper.getValue(), unit: curUnit });
  }
  /** True when the field carries nothing worth persisting — matches the catalog's own
   *  guess (or, when there is no guess, still sits at the untouched placeholder). */
  function sizeMatchesCleanState(): boolean {
    if (baselinePS) return currentSizeStr() === formatPackSize(baselinePS);
    return curUnit === 'pc' && sizeStepper.getValue() === 1 && !sizeTouched;
  }

  const sizeStepper: StepperHandle = createStepper({
    value: seedPS.value,
    min: sizeMin(seedPS.unit),
    max: packSizeMax(seedPS.unit),
    // decimals fixed at 2 — enough precision for every unit (kg/L need it, g/ml/pc never
    // produce a fraction so it's a no-op for them); the per-unit display precision instead
    // comes from formatPackSize via `format` below, which is re-applied on unit change.
    decimals: 2,
    step: (v) => packSizeStep({ value: v, unit: curUnit }),
    format: (v) => formatPackSize({ value: v, unit: curUnit }).split(' ')[0] ?? String(v),
    label: 'Pack size',
    size: 'sm',
    onInput: () => {
      sizeTouched = true;
      refreshSizeUI();
    },
    onCommit: () => refreshSizeUI(),
  });

  const unitBtn = document.createElement('button');
  unitBtn.type = 'button';
  unitBtn.className = 'sheet__unit-btn';
  unitBtn.textContent = curUnit;
  unitBtn.setAttribute('aria-label', 'Change pack size unit');
  unitBtn.setAttribute('aria-expanded', 'false');
  unitBtn.addEventListener('click', () => {
    chipsWrap.hidden = !chipsWrap.hidden;
    unitBtn.setAttribute('aria-expanded', chipsWrap.hidden ? 'false' : 'true');
  });

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'sheet__unit-chips';
  chipsWrap.hidden = true;
  const chipButtons: HTMLButtonElement[] = [];
  for (const u of UNITS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn';
    chip.textContent = u;
    chip.setAttribute('aria-pressed', u === curUnit ? 'true' : 'false');
    chip.addEventListener('click', () => applyUnit(u));
    chipButtons.push(chip);
    chipsWrap.appendChild(chip);
  }

  function updateUnitChipsPressed(): void {
    for (const chip of chipButtons) {
      chip.setAttribute('aria-pressed', chip.textContent === curUnit ? 'true' : 'false');
    }
  }

  /** Corrects a mislabelled unit — deliberately does NOT rescale the number (250 g → 250 ml,
   *  never 0.25 ml); only clamps it into the new unit's range if it no longer fits. */
  function applyUnit(u: Unit): void {
    curUnit = u;
    unitBtn.textContent = u;
    sizeStepper.setFormat((v) => formatPackSize({ value: v, unit: u }).split(' ')[0] ?? String(v));
    sizeStepper.setRange(sizeMin(u), packSizeMax(u));
    sizeTouched = true;
    updateUnitChipsPressed();
    chipsWrap.hidden = true;
    unitBtn.setAttribute('aria-expanded', 'false');
    refreshSizeUI();
  }

  function sizeOrigText(): string {
    return baselinePS ? `Original: ${formatPackSize(baselinePS)}` : 'Not set in catalog';
  }

  function resetSize(): void {
    const target = baselinePS ?? { value: 1, unit: 'pc' as Unit };
    curUnit = target.unit;
    sizeStepper.setFormat((v) => formatPackSize({ value: v, unit: curUnit }).split(' ')[0] ?? String(v));
    sizeStepper.setRange(sizeMin(curUnit), packSizeMax(curUnit));
    sizeStepper.setValue(target.value, true);
    unitBtn.textContent = curUnit;
    updateUnitChipsPressed();
    sizeTouched = false;
    refreshSizeUI();
  }

  const sizeRow = document.createElement('div');
  sizeRow.className = 'sheet__size-row';
  sizeRow.append(sizeStepper.el, unitBtn);

  function refreshSizeUI(): void {
    const placeholder = isPlaceholderStart && !sizeTouched;
    sizeRow.classList.toggle('sheet__size-row--placeholder', placeholder);
    sizeStepper.setHint(placeholder ? 'Not set — tap to add a pack size' : '');
    fieldSize.refresh();
  }

  const fieldSize = buildField(
    'Pack size',
    [sizeRow, chipsWrap],
    () => !sizeMatchesCleanState(),
    sizeOrigText,
    resetSize,
  );
  refreshSizeUI();

  // ---------------------------------------------------------------- name edit + validation

  function refreshNameUI(): void {
    const trimmed = draftName.trim();
    const empty = trimmed === '';
    nameDisplay.textContent = empty ? 'Untitled product' : draftName;
    nameDisplay.classList.toggle('sheet__name--empty', empty);
    const dirty = trimmed !== p.n.trim();
    nameResetBtn.hidden = !dirty;
    const remaining = 200 - draftName.length;
    if (empty) {
      nameMeta.textContent = 'Name cannot be empty.';
      nameMeta.className = 'sheet__name-meta sheet__name-meta--err';
      nameMeta.hidden = false;
    } else if (dirty) {
      nameMeta.textContent = `Original: ${p.n}`;
      nameMeta.className = 'sheet__name-meta';
      nameMeta.hidden = false;
    } else if (remaining < 20) {
      nameMeta.textContent = `${remaining} characters left`;
      nameMeta.className = 'sheet__name-meta';
      nameMeta.hidden = false;
    } else {
      nameMeta.hidden = true;
    }
    saveBtn.disabled = empty;
    saveBtn.title = empty ? 'Enter a product name to save.' : '';
  }

  function startNameEdit(): void {
    nameViewRow.hidden = true;
    nameInput.hidden = false;
    nameInput.value = draftName;
    nameInput.focus();
    nameInput.select();
  }
  function endNameEdit(): void {
    nameInput.hidden = true;
    nameViewRow.hidden = false;
    refreshNameUI();
  }
  nameEditBtn.addEventListener('click', startNameEdit);
  nameResetBtn.addEventListener('click', () => {
    draftName = p.n;
    refreshNameUI();
  });
  nameInput.addEventListener('input', () => {
    draftName = nameInput.value;
    refreshNameUI();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      endNameEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // cancel the rename only — don't also close the whole sheet
      draftName = sessionStart.name;
      endNameEdit();
    }
  });
  nameInput.addEventListener('blur', endNameEdit);

  // ---------------------------------------------------------------- SKU (tap to copy)

  const skuLine = document.createElement('p');
  skuLine.className = 'sheet__sku';
  skuLine.textContent = `SKU ${p.s} (tap to copy)`;
  skuLine.setAttribute('role', 'button');
  skuLine.tabIndex = 0;
  function copySku(): void {
    void navigator.clipboard
      ?.writeText(p.s)
      .then(() => toast('SKU copied.'))
      .catch(() => undefined);
  }
  skuLine.addEventListener('click', copySku);
  skuLine.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copySku();
    }
  });

  // ---------------------------------------------------------------- actions

  const actions = document.createElement('div');
  actions.className = 'sheet__actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary btn-lg';
  saveBtn.textContent = 'Save';
  const resetAllBtn = document.createElement('button');
  resetAllBtn.type = 'button';
  resetAllBtn.className = 'btn btn-lg';
  resetAllBtn.textContent = 'Reset all';
  actions.append(saveBtn, resetAllBtn);

  sheet.append(handle, header, nameMeta, fieldPrice.wrap, fieldMrp.wrap, fieldSize.wrap, skuLine, actions);
  scrim.appendChild(sheet);
  document.body.appendChild(scrim);

  refreshNameUI();

  // trapFocus focuses the first focusable element inside the sheet itself.
  const releaseFocus = trapFocus(sheet);
  const unlockScroll = lockBodyScroll();

  // ---------------------------------------------------------------- close / dirty-check

  function isSessionDirty(): boolean {
    return (
      draftName.trim() !== sessionStart.name.trim() ||
      mrpValue !== sessionStart.mrp ||
      priceValue !== sessionStart.price ||
      currentSizeStr() !== sessionStart.sizeStr
    );
  }

  function close(): void {
    releaseFocus();
    unlockScroll();
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  async function requestClose(): Promise<void> {
    if (isSessionDirty()) {
      const ok = await confirmDialog({
        title: 'Discard your changes?',
        body: 'Your edits to this product have not been saved.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
      });
      if (!ok) return;
    }
    close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      void requestClose();
    }
  }
  document.addEventListener('keydown', onKey, true);

  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) void requestClose();
  });
  closeBtn.addEventListener('click', () => void requestClose());

  // ---------------------------------------------------------------- drag-down-to-dismiss

  const DRAG_DISMISS_PX = 80;
  let dragActive = false;
  let dragStartY = 0;
  handle.addEventListener('pointerdown', (e) => {
    dragActive = true;
    dragStartY = e.clientY;
    sheet.style.transition = 'none';
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragActive) return;
    const dy = Math.max(0, e.clientY - dragStartY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  function endDrag(e: PointerEvent): void {
    if (!dragActive) return;
    dragActive = false;
    sheet.style.transition = '';
    const dy = Math.max(0, e.clientY - dragStartY);
    sheet.style.transform = '';
    if (dy > DRAG_DISMISS_PX) void requestClose();
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', () => {
    dragActive = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
  });

  // ---------------------------------------------------------------- save / reset all

  saveBtn.addEventListener('click', () => {
    if (!draftName.trim()) return;

    const finalName = draftName.trim();
    if (finalName !== p.n) store.setOverride(p.s, 'name', finalName);
    else if (ov.name !== undefined) store.setOverride(p.s, 'name', null);

    if (mrpValue !== p.m) store.setOverride(p.s, 'mrp', String(mrpValue));
    else if (ov.mrp !== undefined) store.setOverride(p.s, 'mrp', null);

    if (priceValue !== p.p) store.setOverride(p.s, 'price', String(priceValue));
    else if (ov.price !== undefined) store.setOverride(p.s, 'price', null);

    if (!sizeMatchesCleanState()) store.setOverride(p.s, 'size', currentSizeStr());
    else if (ov.size !== undefined) store.setOverride(p.s, 'size', null);

    close();
    onSaved();
  });

  resetAllBtn.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDialog({
        title: 'Reset all changes?',
        body: `This removes every edit you've made to ${p.n} and restores the catalog values.`,
        confirmLabel: 'Reset all',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      (['name', 'size', 'mrp', 'price'] as const).forEach((field) => {
        if ((store.getOverride(p.s) ?? {})[field] !== undefined) store.setOverride(p.s, field, null);
      });
      close();
      onSaved();
    })();
  });
}
