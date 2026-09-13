/**
 * Swipe deck — SPEC.md §9.3 (production v2). The core interaction, surround fixed.
 *
 * Resume and progress are derived from ACTUAL decided counts, never from a cursor:
 * the queue stays in catalog order, the pointer is recomputed by lookup
 * (`firstUndecidedIndex`), and out-of-order decisions (search/list/review) cannot
 * break it (AUDIT D-08/D-09). The old code asserted decisions form a prefix — that
 * invariant died the moment list-select shipped, so it is gone here on purpose.
 *
 * Undo in this mount covers the session trail; anything older is one tap away in
 * Review (AUDIT D-01). `clearDecision` is durable (tombstone → server DELETE, D-02).
 *
 * The card itself now carries direct +/- controls for selling price and pack size
 * (via `createStepper`) instead of sending every 5-rupee correction through the
 * edit sheet's keyboard fields — a shopkeeper glancing at a shelf price taps a
 * button, they don't type. Each stepper commit writes through `store.setOverride`,
 * clearing the override back to `null` when the typed/stepped value matches the
 * catalog's own so a no-op edit never shows as "Changed". List mode gained its own
 * scroll container — it used to be a bare div inside an `overflow:hidden` screen,
 * which made every product past the first screenful unreachable.
 */

import { thumb } from '../xlsx.js';
import { store, type SyncStatus } from '../store';
import type { DecisionValue, Product } from '../api';
import type { Cleanup } from '../main';
import { productRow } from '../product-row';
import { confirmDialog, toast, renderStatusChip, renderIncrementalList, type IncrementalListHandle } from '../ui';
import { openEditSheet } from './edit-sheet';
import { createStepper, type StepperHandle } from '../stepper';
import {
  UNITS,
  type Unit,
  type PackSize,
  parsePackSize,
  packSizeFromName,
  formatPackSize,
  packSizeStep,
  packSizeMax,
  packSizeDecimals,
} from '../units';

const MAX_TILT_DEG = 10;
const PREFETCH_COUNT = 3;

// Every icon carries explicit width/height: an <svg> with only a viewBox has no intrinsic size
// and renders at the UA default (300x150), so without this every button here would balloon.
const ICON_CHECK =
  '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 7"/></svg>';
const ICON_CROSS =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const ICON_UNDO =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>';
const ICON_BACK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const ICON_PACKAGE =
  '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 8l9-5 9 5-9 5-9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>';
const ICON_DONE =
  '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9.5"/>' +
  '<path d="M8 12.5l2.5 2.5L16 9.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MORE =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatRupees(n: number): string {
  return '₹' + n.toLocaleString('en-IN');
}

/** 28% of the viewport, capped at 110px — a fixed 100px was 31% of a 320px phone. */
function computeSwipeThreshold(): number {
  return Math.min(110, window.innerWidth * 0.28);
}

function priceHint(price: number, mrp: number): string {
  if (price >= mrp) return 'Same as MRP';
  return `MRP ${formatRupees(mrp)} · you save ${formatRupees(mrp - price)}`;
}

function formatSizeValue(v: number, unit: Unit): string {
  const decimals = packSizeDecimals(unit);
  let s = v.toFixed(decimals);
  if (decimals > 0) s = s.replace(/\.?0+$/, '');
  return s;
}

/**
 * Best guess for the pack-size stepper's starting value. An explicit override wins;
 * failing that, a size parsed out of the product name is shown (real data, just not
 * yet confirmed); failing that, {1, 'pc'} is shown muted so the shopkeeper knows
 * nothing about this product's size is known yet.
 */
function seedPackSize(sizeOverride: string, name: string): { ps: PackSize; isSet: boolean } {
  if (sizeOverride) {
    const parsed = parsePackSize(sizeOverride);
    if (parsed) return { ps: parsed, isSet: true };
  }
  const fromName = packSizeFromName(name);
  if (fromName) return { ps: fromName, isSet: true };
  return { ps: { value: 1, unit: 'pc' }, isSet: false };
}

function haptic(): void {
  try {
    navigator.vibrate?.(12);
  } catch {
    // Unsupported/disallowed in this browser — a missed buzz is not worth surfacing.
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function nextCategoryName(current: string): string | null {
  const names = store.categories.map((c) => c.name);
  const i = names.indexOf(current);
  for (let k = 1; k <= names.length; k++) {
    const cand = store.categories[(i + k) % names.length];
    if (cand && cand.name !== current) {
      const p = store.categoryProgress(cand.items);
      if (p.done < p.total) return cand.name;
    }
  }
  return null;
}

export function mount(root: HTMLElement, categoryName: string): Cleanup {
  const cleanups: Array<() => void> = [];
  const on = (
    el: HTMLElement | Window,
    type: string,
    fn: EventListener,
    opts?: AddEventListenerOptions,
  ): void => {
    el.addEventListener(type, fn, opts);
    cleanups.push(() => el.removeEventListener(type, fn, opts));
  };

  const category = store.categories.find((c) => c.name === categoryName);
  const queue: Product[] = category ? category.items : [];

  const wrap = document.createElement('div');
  wrap.className = 'screen screen-deck';
  const mode = store.deckMode();
  wrap.innerHTML = `
    <header class="deck-topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back to categories">${ICON_BACK}</button>
      <button type="button" class="icon-btn btn-undo-icon" data-action="undo" aria-label="Undo last decision" disabled>${ICON_UNDO}</button>
      <div class="deck-progress">
        <span class="deck-progress__label" data-role="progress-label" aria-live="polite"></span>
        <div class="progress-bar"><div class="progress-bar__fill" data-role="progress-fill"></div></div>
      </div>
      <span class="status-chip" data-role="status-chip" aria-live="polite"></span>
    </header>
    <div class="deck-tabs" role="tablist" aria-label="Deck mode">
      <button type="button" role="tab" id="deck-tab-swipe" aria-controls="deck-panel-swipe" aria-selected="${mode === 'swipe' ? 'true' : 'false'}" data-mode="swipe">Swipe</button>
      <button type="button" role="tab" id="deck-tab-list" aria-controls="deck-panel-list" aria-selected="${mode === 'list' ? 'true' : 'false'}" data-mode="list">List</button>
    </div>
    <div class="card-stack" data-role="card-stack" role="tabpanel" id="deck-panel-swipe" aria-labelledby="deck-tab-swipe"></div>
    <div class="deck-list" data-role="list-wrap" role="tabpanel" id="deck-panel-list" aria-labelledby="deck-tab-list" hidden></div>
    <p class="deck-hint" data-role="hint">← ✗ &nbsp;·&nbsp; → ✓ &nbsp;·&nbsp; U undo</p>
    <footer class="deck-controls" data-role="controls">
      <button type="button" class="btn-decide btn-decide--no" data-action="no" aria-label="Don't stock">${ICON_CROSS}<span>Don't stock</span></button>
      <button type="button" class="btn-decide btn-decide--yes" data-action="yes" aria-label="Stock it">${ICON_CHECK}<span>Stock it</span></button>
    </footer>
  `;
  root.appendChild(wrap);

  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;
  const cardStack = wrap.querySelector('[data-role="card-stack"]') as HTMLElement;
  const listWrap = wrap.querySelector('[data-role="list-wrap"]') as HTMLElement;
  const progressLabel = wrap.querySelector('[data-role="progress-label"]') as HTMLElement;
  const progressFill = wrap.querySelector('[data-role="progress-fill"]') as HTMLElement;
  const statusChip = wrap.querySelector('[data-role="status-chip"]') as HTMLElement;
  const undoBtn = wrap.querySelector('[data-action="undo"]') as HTMLButtonElement;
  const noBtn = wrap.querySelector('[data-action="no"]') as HTMLButtonElement;
  const yesBtn = wrap.querySelector('[data-action="yes"]') as HTMLButtonElement;
  const controls = wrap.querySelector('[data-role="controls"]') as HTMLElement;
  const hint = wrap.querySelector('[data-role="hint"]') as HTMLElement;
  const swipeTab = wrap.querySelector('[data-mode="swipe"]') as HTMLButtonElement;
  const listTab = wrap.querySelector('[data-mode="list"]') as HTMLButtonElement;

  // Keyboard hint only where a fine pointer exists — never on the shopkeeper's phone.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    hint.hidden = true;
  }

  const goBack = (): void => {
    window.location.hash = '#/';
  };
  on(backBtn, 'click', goBack);

  if (queue.length === 0) {
    cardStack.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'deck-complete';
    const heading = document.createElement('h2');
    heading.textContent = 'Category not found';
    const body = document.createElement('p');
    body.textContent = "This category isn't in the current catalog anymore.";
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-lg';
    btn.textContent = 'Back to categories';
    on(btn, 'click', goBack);
    panel.append(heading, body, btn);
    cardStack.appendChild(panel);
    undoBtn.disabled = true;
    noBtn.disabled = true;
    yesBtn.disabled = true;
    listWrap.hidden = true;
    const unsub0 = store.onStatusChange(renderStatus);
    renderStatus(store.getStatus());
    return () => {
      unsub0();
      for (const fn of cleanups) fn();
    };
  }

  const EXIT_MS = prefersReducedMotion() ? 0 : 180;
  const SPRING_MS = prefersReducedMotion() ? 0 : 200;

  // Pointer = first undecided BY LOOKUP. Recomputed after every write, so out-of-order
  // decisions can never strand it in a hole (D-08).
  let pointer = store.firstUndecidedIndex(queue);
  const history: string[] = [];
  const prefetched = new Set<string>();

  let SWIPE_THRESHOLD = computeSwipeThreshold();

  let animating = false;
  let dragging = false;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;

  let cardEl: HTMLElement | null = null;
  let peekEl: HTMLElement | null = null;
  let tintEl: HTMLElement | null = null;
  let stampEl: HTMLElement | null = null;
  let currentMode: 'swipe' | 'list' = mode;
  let listFilter: 'all' | 'yes' | 'no' | 'left' = 'all';
  // A category can hold thousands of rows (2,279-product catalogs are real) — batch them
  // in instead of building the whole filtered list synchronously on a cheap phone.
  let listHandle: IncrementalListHandle | null = null;

  // Per-card-body teardown (destroys its steppers) so a discarded card never leaves a
  // press-and-hold timer running. Keyed by the `.card__body` element itself so both a
  // full card removal and an in-place body refresh route through the same cleanup.
  const bodyTeardowns = new Map<HTMLElement, () => void>();

  function destroyBody(body: Element | null): void {
    if (!body) return;
    const fn = bodyTeardowns.get(body as HTMLElement);
    if (fn) {
      fn();
      bodyTeardowns.delete(body as HTMLElement);
    }
  }

  function decidedCount(): number {
    return store.categoryDecidedCount(queue);
  }

  function updateProgress(): void {
    const total = queue.length;
    const done = decidedCount();
    progressLabel.textContent = `${categoryName} · ${done} / ${total}`;
    progressFill.style.width = `${total > 0 ? (done / total) * 100 : 0}%`;
  }

  function updateUndoButton(): void {
    undoBtn.disabled = history.length === 0;
  }

  function renderStatus(status: SyncStatus): void {
    renderStatusChip(statusChip, status);
  }

  function prefetchUpcoming(): void {
    // Walk the undecided items after the pointer — the same lookup that decides what
    // is actually shown next — instead of the raw queue slice, which can prefetch
    // images for products that are already decided and will never be shown.
    let idx = pointer;
    let found = 0;
    while (found < PREFETCH_COUNT) {
      idx = nextUndecidedAfter(idx);
      if (idx === -1) break;
      found++;
      const url = queue[idx]?.i;
      if (!url || prefetched.has(url)) continue;
      prefetched.add(url);
      const img = new Image();
      img.src = thumb(url, 400);
    }
  }

  function buildCard(p: Product, peek: boolean): HTMLElement {
    const card = document.createElement('div');
    card.className = peek ? 'card card--peek' : 'card card--top';
    card.dataset.sku = p.s;
    // Peek is a purely visual preview: pointer-events:none already blocks interaction,
    // and hiding it from the accessibility tree stops a screen reader announcing two
    // "Selling price" steppers with different values at once.
    if (peek) card.setAttribute('aria-hidden', 'true');

    if (!peek) {
      const tint = document.createElement('div');
      tint.className = 'swipe-tint';
      card.appendChild(tint);
      const stamp = document.createElement('div');
      stamp.className = 'swipe-stamp';
      card.appendChild(stamp);
    }

    const imageWrap = document.createElement('div');
    imageWrap.className = 'card__image-wrap';
    if (p.i !== '') {
      const img = document.createElement('img');
      img.className = 'card__image';
      img.src = thumb(p.i, 400);
      img.alt = '';
      img.draggable = false;
      imageWrap.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'card__placeholder';
      placeholder.innerHTML = ICON_PACKAGE;
      imageWrap.appendChild(placeholder);
    }
    card.appendChild(imageWrap);
    card.appendChild(buildCardBody(p));

    return card;
  }

  /** Body-only builder (chip, clamped name, price stepper, size row, More) — `buildCard`
   *  calls this instead of building a whole throwaway card just to steal its body. */
  function buildCardBody(p: Product): HTMLElement {
    const body = document.createElement('div');
    body.className = 'card__body';

    const disp = store.displayOf(p);

    const chip = document.createElement('span');
    chip.className = 'card__chip';
    chip.textContent = p.c;
    body.appendChild(chip);

    const name = document.createElement('h2');
    name.className = 'card__name';
    name.textContent = disp.name;
    body.appendChild(name);

    function refreshChangedBadge(): void {
      const edited = store.displayOf(p).edited;
      const existing = name.querySelector('.edited-badge');
      if (edited && !existing) {
        const badge = document.createElement('span');
        badge.className = 'edited-badge';
        badge.textContent = 'Changed';
        name.appendChild(badge);
      } else if (!edited && existing) {
        existing.remove();
      }
    }
    refreshChangedBadge();

    // ---- selling price: a direct stepper replaces the old keyboard-only field. Its
    // hint carries the MRP context, so there is no separate price row to fit.
    const priceRow = document.createElement('div');
    priceRow.className = 'card__price-row';
    const mrp = disp.mrp;
    const priceHandle: StepperHandle = createStepper({
      value: clamp(disp.price, 0, mrp),
      min: 0,
      max: mrp,
      step: 1,
      decimals: 0,
      format: formatRupees,
      label: 'Selling price',
      size: 'lg',
      hint: priceHint(disp.price, mrp),
      onInput: (v) => priceHandle.setHint(priceHint(v, mrp)),
      onCommit: (v) => {
        if (v === p.p) store.setOverride(p.s, 'price', null);
        else store.setOverride(p.s, 'price', String(v));
        priceHandle.setHint(priceHint(v, mrp));
        refreshChangedBadge();
      },
    });
    priceRow.appendChild(priceHandle.el);
    body.appendChild(priceRow);

    // ---- pack size: a small stepper plus a tap-to-expand unit pill. Changing the
    // unit is a label correction, never a conversion — the number is left alone.
    const sizeRow = document.createElement('div');
    sizeRow.className = 'card__size-row';

    const seed = seedPackSize(disp.size, disp.name);
    let unit: Unit = seed.ps.unit;
    let sizeSet = seed.isSet;
    if (!sizeSet) sizeRow.classList.add('card__size-row--unset');

    const sizeSlot = document.createElement('div');
    sizeSlot.className = 'card__size-stepper';

    function makeSizeStepper(value: number, u: Unit): StepperHandle {
      return createStepper({
        value,
        min: 0,
        max: packSizeMax(u),
        step: (v) => packSizeStep({ value: v, unit: u }),
        decimals: packSizeDecimals(u),
        format: (v) => formatSizeValue(v, u),
        label: 'Pack size',
        size: 'sm',
        // A non-breaking space once set, never true empty string: the card's hint line has
        // no reserved min-height (see .card__size-stepper .stepper__hint in styles.css), so
        // an actually-empty hint would collapse the line and shift the card the moment a
        // size is confirmed. A non-empty (if invisible) line keeps the height constant.
        hint: sizeSet ? ' ' : 'Not set — tap to set',
        onCommit: (v) => commitSize(v),
      });
    }

    function commitSize(v: number): void {
      sizeSet = true;
      sizeRow.classList.remove('card__size-row--unset');
      sizeHandle.setHint(' '); // NBSP — keeps the hint line's height once a size is confirmed.
      const ps: PackSize = { value: v, unit };
      // "The catalog's own value" for size is what the untouched name would infer —
      // matching it clears the override so a no-op edit never shows as Changed.
      const baseline = packSizeFromName(p.n);
      const formatted = formatPackSize(ps);
      if (baseline && formatPackSize(baseline) === formatted) {
        store.setOverride(p.s, 'size', null);
      } else {
        store.setOverride(p.s, 'size', formatted);
      }
      refreshChangedBadge();
    }

    let sizeHandle: StepperHandle = makeSizeStepper(seed.ps.value, unit);
    sizeSlot.appendChild(sizeHandle.el);

    const unitBox = document.createElement('div');
    unitBox.className = 'card__units';
    const unitPill = document.createElement('button');
    unitPill.type = 'button';
    unitPill.className = 'card__unit-pill';
    unitPill.textContent = unit;
    unitPill.setAttribute('aria-haspopup', 'true');
    unitPill.setAttribute('aria-expanded', 'false');
    unitPill.setAttribute('aria-label', `Pack size unit, ${unit}. Tap to change.`);

    const unitOptions = document.createElement('div');
    unitOptions.className = 'card__unit-options';
    unitOptions.hidden = true;
    for (const u of UNITS) {
      const chipBtn = document.createElement('button');
      chipBtn.type = 'button';
      chipBtn.className = 'card__unit-chip';
      chipBtn.textContent = u;
      chipBtn.setAttribute('aria-label', `Use unit ${u}`);
      chipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setUnit(u);
        unitOptions.hidden = true;
        unitPill.setAttribute('aria-expanded', 'false');
      });
      unitOptions.appendChild(chipBtn);
    }
    unitPill.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = unitOptions.hidden;
      unitOptions.hidden = !willOpen;
      unitPill.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });

    function setUnit(u: Unit): void {
      if (u === unit) return;
      const raw = sizeHandle.getValue();
      unit = u;
      const clamped = clamp(raw, 0, packSizeMax(u));
      sizeHandle.destroy();
      sizeSlot.innerHTML = '';
      sizeHandle = makeSizeStepper(clamped, u);
      sizeSlot.appendChild(sizeHandle.el);
      unitPill.textContent = u;
      unitPill.setAttribute('aria-label', `Pack size unit, ${u}. Tap to change.`);
      commitSize(clamped);
    }

    unitBox.append(unitPill, unitOptions);
    sizeRow.append(sizeSlot, unitBox);
    body.appendChild(sizeRow);

    // ---- overflow: name/MRP and the rarer fields stay behind the edit sheet.
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'card__more';
    more.innerHTML = ICON_MORE;
    more.setAttribute('aria-label', `More options for ${disp.name}`);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditSheet(p, () => {
        refreshCardBody();
        updateProgress();
      });
    });
    body.appendChild(more);

    bodyTeardowns.set(body, () => {
      priceHandle.destroy();
      sizeHandle.destroy();
    });

    return body;
  }

  function refreshBodyOf(card: HTMLElement, p: Product): void {
    const oldBody = card.querySelector('.card__body');
    destroyBody(oldBody);
    const fresh = buildCardBody(p);
    if (oldBody) oldBody.replaceWith(fresh);
    else card.appendChild(fresh);
  }

  function refreshCardBody(): void {
    if (!cardEl || pointer >= queue.length) return;
    const p = queue[pointer];
    if (!p) return;
    refreshBodyOf(cardEl, p);
  }

  function setMode(m: 'swipe' | 'list'): void {
    currentMode = m;
    store.setDeckMode(m);
    swipeTab.setAttribute('aria-selected', m === 'swipe' ? 'true' : 'false');
    listTab.setAttribute('aria-selected', m === 'list' ? 'true' : 'false');
    cardStack.hidden = m !== 'swipe';
    listWrap.hidden = m !== 'list';
    controls.style.display = m === 'swipe' ? '' : 'none';
    hint.style.display = m === 'swipe' ? '' : 'none';
    if (m === 'list') renderList();
    else renderCurrent();
  }

  function applyDragTransform(x: number, y: number): void {
    if (!cardEl) return;
    const rot = clamp(x / 12, -MAX_TILT_DEG, MAX_TILT_DEG);
    cardEl.style.transform = `translate(${x}px, ${y * 0.4}px) rotate(${rot}deg)`;
    const frac = clamp(Math.abs(x) / SWIPE_THRESHOLD, 0, 1);
    if (tintEl) {
      tintEl.style.opacity = String(frac * 0.55);
      // CSS-driven tint (D-21 live): data-dir selects the colour, no inline background.
      if (frac > 0.05) tintEl.dataset.dir = x > 0 ? 'yes' : 'no';
      else delete tintEl.dataset.dir;
    }
    if (stampEl) {
      stampEl.style.opacity = String(frac);
      stampEl.textContent = x > 0 ? 'YES' : 'NO';
      stampEl.className = `swipe-stamp swipe-stamp--${x > 0 ? 'yes' : 'no'}`;
    }
  }

  function springBack(): void {
    if (!cardEl) return;
    cardEl.style.transition = `transform ${SPRING_MS}ms var(--ease-snap)`;
    cardEl.style.transform = 'translate(0, 0) rotate(0deg)';
    if (tintEl) {
      tintEl.style.transition = `opacity ${SPRING_MS}ms var(--ease-snap)`;
      tintEl.style.opacity = '0';
    }
    if (stampEl) stampEl.style.opacity = '0';
    const el = cardEl;
    const tint = tintEl;
    window.setTimeout(() => {
      el.style.transition = '';
      if (tint) tint.style.transition = '';
    }, SPRING_MS);
  }

  function commit(value: DecisionValue): void {
    if (animating || pointer >= queue.length) return;
    const current = queue[pointer];
    if (!cardEl) return;
    animating = true;

    const dir = value === 1 ? 1 : -1;
    const flyX = dir * (window.innerWidth + 300);
    cardEl.style.transition = `transform ${EXIT_MS}ms var(--ease-snap), opacity ${EXIT_MS}ms var(--ease-snap)`;
    cardEl.style.transform = `translate(${flyX}px, ${dy * 0.4}px) rotate(${dir * MAX_TILT_DEG * 1.4}deg)`;
    cardEl.style.opacity = '0';
    if (tintEl) {
      tintEl.dataset.dir = value === 1 ? 'yes' : 'no';
      tintEl.style.opacity = '0.55';
    }
    if (stampEl) {
      stampEl.textContent = value === 1 ? 'YES' : 'NO';
      stampEl.className = `swipe-stamp swipe-stamp--${value === 1 ? 'yes' : 'no'}`;
      stampEl.style.opacity = '1';
    }

    store.setDecision(current.s, value);
    store.setContinue(categoryName, current.s);
    history.push(current.s);
    haptic();

    exitTimer = setTimeout(() => {
      exitTimer = null;
      // Recompute by lookup — the next card is the next undecided, wherever it is.
      pointer = store.firstUndecidedIndex(queue);
      animating = false;
      advanceCards();
    }, EXIT_MS);
  }

  /** Promote the peek card to active (D-23) instead of rebuilding both — image never re-mounts. */
  function advanceCards(): void {
    updateProgress();
    updateUndoButton();
    if (pointer >= queue.length) {
      renderComplete();
      return;
    }

    // Drop the flown-out card — destroy its steppers/listeners before it goes.
    destroyCard(cardEl);
    cardEl?.remove();
    cardEl = null;

    const nextP = queue[pointer];
    if (peekEl && nextP && peekEl.dataset.sku === nextP.s) {
      const promoted = peekEl;
      peekEl = null;
      promoted.classList.remove('card--peek');
      promoted.classList.add('card--top');
      promoted.style.cssText = '';
      promoted.removeAttribute('aria-hidden');
      // Peek had no tint/stamp/events — add them now that it is active. Stamp is
      // prepended first so tint ends up first in DOM order (matches a fresh top card).
      const stamp = document.createElement('div');
      stamp.className = 'swipe-stamp';
      promoted.prepend(stamp);
      const tint = document.createElement('div');
      tint.className = 'swipe-tint';
      promoted.prepend(tint);
      // Body may be stale if an edit landed while this card only peeked — refresh it.
      refreshBodyOf(promoted, nextP);
      cardEl = promoted;
    } else if (nextP) {
      // Peek doesn't match what's actually next (an out-of-order decision landed
      // elsewhere) — discard it and build the real thing fresh, image included.
      destroyCard(peekEl);
      peekEl?.remove();
      peekEl = null;
      cardEl = buildCard(nextP, false);
      cardStack.appendChild(cardEl);
    }

    if (cardEl) {
      tintEl = cardEl.querySelector<HTMLElement>('.swipe-tint');
      stampEl = cardEl.querySelector<HTMLElement>('.swipe-stamp');
      wireCardEvents();
    }

    // Fresh peek for the card after next undecided.
    const nextIdx = nextUndecidedAfter(pointer);
    if (nextIdx !== -1 && queue[nextIdx]) {
      peekEl = buildCard(queue[nextIdx], true);
      cardStack.prepend(peekEl);
    }
    const cur = queue[pointer];
    if (cur) store.setContinue(categoryName, cur.s);
    prefetchUpcoming();
  }

  function nextUndecidedAfter(from: number): number {
    for (let i = from + 1; i < queue.length; i++) {
      if (store.getDecision(queue[i].s) === undefined) return i;
    }
    return -1;
  }

  function onUndo(): void {
    if (animating || history.length === 0) return;
    const sku = history.pop() as string;
    store.clearDecision(sku);
    pointer = store.firstUndecidedIndex(queue);
    renderCurrent();
    toast('Undone.', undefined, 2500);
  }

  function onPointerDown(e: PointerEvent): void {
    if (animating || !cardEl || currentMode !== 'swipe') return;
    // Belt-and-braces: the stepper already stops its own pointerdown from bubbling,
    // but a drag started on any control must never be mistaken for a card swipe.
    const target = e.target as Element;
    if (target.closest('.stepper-wrap, button, input, .card__units')) return;
    // One-thumb scroll guard: only take over once a horizontal drag is established
    // (touch-action: pan-y lets vertical scrolls pass through to the page).
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dy = 0;
    try {
      cardEl.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    cardEl.classList.add('card--dragging');
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging || e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (e.cancelable && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault();
    }
    applyDragTransform(dx, dy);
  }

  function endDrag(e: PointerEvent): void {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    cardEl?.classList.remove('card--dragging');
    if (Math.abs(dx) > SWIPE_THRESHOLD) {
      commit(dx > 0 ? 1 : 0);
    } else {
      springBack();
    }
    dx = 0;
    dy = 0;
  }

  function wireCardEvents(): void {
    if (!cardEl) return;
    cardEl.addEventListener('pointerdown', onPointerDown as EventListener);
    cardEl.addEventListener('pointermove', onPointerMove as EventListener);
    cardEl.addEventListener('pointerup', endDrag as EventListener);
    cardEl.addEventListener('pointercancel', endDrag as EventListener);
  }

  function unwireCardEvents(el: HTMLElement): void {
    el.removeEventListener('pointerdown', onPointerDown as EventListener);
    el.removeEventListener('pointermove', onPointerMove as EventListener);
    el.removeEventListener('pointerup', endDrag as EventListener);
    el.removeEventListener('pointercancel', endDrag as EventListener);
  }

  /** Full teardown for one `.card` element: its body's steppers and its own pointer
   *  listeners. Every place a card is discarded (flown away, replaced, or the whole
   *  screen unmounted) routes through this so nothing outlives its element. */
  function destroyCard(el: HTMLElement | null): void {
    if (!el) return;
    destroyBody(el.querySelector('.card__body'));
    unwireCardEvents(el);
  }

  function renderComplete(): void {
    destroyCard(cardEl);
    destroyCard(peekEl);
    cardStack.innerHTML = '';
    cardEl = null;
    peekEl = null;
    tintEl = null;
    stampEl = null;
    store.clearContinue();

    const panel = document.createElement('div');
    panel.className = 'deck-complete';
    const icon = document.createElement('div');
    icon.className = 'deck-complete__icon';
    icon.innerHTML = ICON_DONE;
    const heading = document.createElement('h2');
    heading.textContent = `All done in ${categoryName}`;
    const prog = store.categoryProgress(queue);
    const body = document.createElement('p');
    body.textContent = `✓ ${prog.yes} stocked · ✗ ${prog.no} no.`;
    panel.append(icon, heading, body);

    const next = nextCategoryName(categoryName);
    if (next) {
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'btn btn-primary btn-lg';
      nextBtn.textContent = `Next: ${next} →`;
      nextBtn.addEventListener('click', () => {
        window.location.hash = '#/deck/' + encodeURIComponent(next);
      });
      panel.appendChild(nextBtn);
      cleanups.push(() => nextBtn.replaceWith());
    }
    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.className = 'btn btn-lg';
    reviewBtn.textContent = 'Review this category';
    reviewBtn.addEventListener('click', () => {
      window.location.hash = '#/review/' + encodeURIComponent(categoryName);
    });
    const backBtn2 = document.createElement('button');
    backBtn2.type = 'button';
    backBtn2.className = 'btn btn-lg';
    backBtn2.textContent = 'Back to categories';
    backBtn2.addEventListener('click', goBack);
    panel.append(reviewBtn, backBtn2);
    cardStack.appendChild(panel);

    noBtn.disabled = true;
    yesBtn.disabled = true;
    updateProgress();
    updateUndoButton();
  }

  function renderCurrent(): void {
    dx = 0;
    dy = 0;
    pointer = store.firstUndecidedIndex(queue);
    if (pointer >= queue.length) {
      renderComplete();
      return;
    }

    destroyCard(cardEl);
    destroyCard(peekEl);
    cardStack.innerHTML = '';
    const nextIdx = nextUndecidedAfter(pointer);
    if (nextIdx !== -1 && queue[nextIdx]) {
      peekEl = buildCard(queue[nextIdx], true);
      cardStack.appendChild(peekEl);
    } else {
      peekEl = null;
    }

    cardEl = buildCard(queue[pointer], false);
    cardStack.appendChild(cardEl);
    tintEl = cardEl.querySelector<HTMLElement>('.swipe-tint');
    stampEl = cardEl.querySelector<HTMLElement>('.swipe-stamp');
    wireCardEvents();

    noBtn.disabled = false;
    yesBtn.disabled = false;
    updateProgress();
    updateUndoButton();
    const cur = queue[pointer];
    if (cur) store.setContinue(categoryName, cur.s);
    prefetchUpcoming();
  }

  /* ------------------------------------------------------------ list mode */

  function renderList(): void {
    listHandle?.destroy();
    listHandle = null;
    listWrap.innerHTML = '';
    pointer = store.firstUndecidedIndex(queue);
    updateProgress();

    const prog = store.categoryProgress(queue);
    const filterCounts = {
      all: prog.total,
      yes: prog.yes,
      no: prog.no,
      left: prog.total - prog.done,
    } as const;

    const toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';

    const head = document.createElement('div');
    head.className = 'list-head';
    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'btn';
    selectAll.textContent = `Stock all (${queue.length})`;
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'btn';
    clearAll.textContent = 'Clear all';
    head.append(selectAll, clearAll);

    const chips = document.createElement('div');
    chips.className = 'filter-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Filter products');
    for (const [key, label] of [
      ['all', 'All'],
      ['yes', 'Stocked'],
      ['no', 'Not stocked'],
      ['left', 'Left'],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn';
      b.textContent = `${label} (${filterCounts[key]})`;
      b.setAttribute('aria-pressed', listFilter === key ? 'true' : 'false');
      b.addEventListener('click', () => {
        listFilter = key;
        renderList();
      });
      chips.appendChild(b);
    }
    toolbar.append(head, chips);

    const list = document.createElement('ul');
    list.className = 'prow-list';
    const visible = queue.filter((p) => {
      const v = store.getDecision(p.s);
      if (listFilter === 'yes') return v === 1;
      if (listFilter === 'no') return v === 0;
      if (listFilter === 'left') return v === undefined;
      return true;
    });
    listHandle = renderIncrementalList(list, visible, (p) => {
      return productRow(p, {
        showCategory: false, // list mode is already scoped to one category — repeating it is noise.
        onChange: () => {
          updateProgress();
          updateUndoButton();
        },
        onEdit: (prod) => openEditSheet(prod, () => renderList()),
      });
    });
    const empty = document.createElement('p');
    empty.textContent =
      visible.length === 0 ? 'Nothing in this filter.' : `${visible.length} of ${queue.length} products.`;

    selectAll.addEventListener('click', () => {
      void (async () => {
        const ok = await confirmDialog({
          title: `Stock all ${queue.length} products?`,
          body: 'You can undo this right after, or change any item later.',
          confirmLabel: `Stock all ${queue.length}`,
        });
        if (!ok) return;
        const snapshot = new Map(queue.map((p) => [p.s, store.getDecision(p.s)] as const));
        store.setDecisions(queue.map((p) => ({ sku: p.s, value: 1 as const })));
        renderList();
        updateUndoButton();
        toast(`Stocked ${queue.length} products.`, {
          label: 'Undo',
          onClick: () => {
            store.restoreDecisions(snapshot);
            renderList();
          },
        });
      })();
    });
    clearAll.addEventListener('click', () => {
      void (async () => {
        const ok = await confirmDialog({
          title: `Mark all ${queue.length} products as not stocked?`,
          body: 'You can undo this right after, or change any item later.',
          confirmLabel: 'Mark all not stocked',
        });
        if (!ok) return;
        const snapshot = new Map(queue.map((p) => [p.s, store.getDecision(p.s)] as const));
        store.setDecisions(queue.map((p) => ({ sku: p.s, value: 0 as const })));
        renderList();
        updateUndoButton();
        toast(`Cleared ${queue.length} products.`, {
          label: 'Undo',
          onClick: () => {
            store.restoreDecisions(snapshot);
            renderList();
          },
        });
      })();
    });

    listWrap.append(toolbar, empty, list);
  }

  /* ------------------------------------------------------------ wiring */

  function onKeydown(e: KeyboardEvent): void {
    if (currentMode !== 'swipe' || animating || pointer >= queue.length) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      commit(0);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      commit(1);
    } else if (e.key === 'u' || e.key === 'U') {
      e.preventDefault();
      onUndo();
    }
  }

  const onNoClick = (): void => commit(0);
  const onYesClick = (): void => commit(1);
  on(noBtn, 'click', onNoClick);
  on(yesBtn, 'click', onYesClick);
  on(undoBtn, 'click', onUndo);
  on(window, 'keydown', onKeydown as EventListener);
  on(window, 'resize', () => {
    SWIPE_THRESHOLD = computeSwipeThreshold();
  });
  on(swipeTab, 'click', () => setMode('swipe'));
  on(listTab, 'click', () => setMode('list'));

  renderStatus(store.getStatus());
  const unsubscribeStatus = store.onStatusChange(renderStatus);

  setMode(currentMode);

  return () => {
    if (exitTimer !== null) clearTimeout(exitTimer);
    destroyCard(cardEl);
    destroyCard(peekEl);
    listHandle?.destroy();
    unsubscribeStatus();
    for (const fn of cleanups) fn();
  };
}
