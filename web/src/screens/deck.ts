/**
 * Swipe deck — SPEC.md §9.3. The core interaction: one product at a time, drag or tap to decide,
 * undo to recover from a mis-swipe.
 *
 * Resume works without any separate "current index" state: the queue is the category's products
 * in catalog order, and the starting position is simply the first one with no decision yet. Since
 * the deck only ever presents cards in that fixed order, decisions within a category always form
 * a prefix of it — so "first undecided" is always the right place to resume, on any device.
 *
 * Undo removes the decision locally (and cancels it if it hadn't shipped to the outbox yet). The
 * API has no "unset" endpoint — only upsert — so if a decision already reached the server before
 * undo is pressed, the server row is not retracted; it will be corrected the next time this SKU
 * is decided again (upsert), which is the overwhelmingly common case since undo is almost always
 * pressed within moments of a mis-swipe, before the ~1s debounce even flushes.
 */

import { thumb } from '../xlsx.js';
import { store, type SyncStatus } from '../store';
import type { DecisionValue, Product } from '../api';
import type { Cleanup } from '../main';

const SWIPE_THRESHOLD = 100;
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
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatRupees(n: number): string {
  return '₹' + n.toLocaleString('en-IN');
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function buildCard(p: Product, isPeek: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = isPeek ? 'card card--peek' : 'card';

  if (isPeek) {
    // styles.css doesn't carry a distinct .card--peek rule (it's identical to .card), so this
    // stays inline: without it the peek card sits exactly under the active one and never shows.
    card.style.zIndex = '1';
    card.style.transform = 'scale(0.96) translateY(10px)';
    card.style.opacity = '0.7';
    card.style.pointerEvents = 'none';
  } else {
    card.style.zIndex = '2';
    const tint = document.createElement('div');
    tint.className = 'swipe-tint';
    card.appendChild(tint);
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
    imageWrap.classList.add('card__image-wrap--empty');
    const placeholder = document.createElement('div');
    placeholder.className = 'card__placeholder';
    placeholder.innerHTML = ICON_PACKAGE;
    imageWrap.appendChild(placeholder);
  }
  card.appendChild(imageWrap);

  const body = document.createElement('div');
  body.className = 'card__body';

  const chip = document.createElement('span');
  chip.className = 'card__chip';
  chip.textContent = p.c;
  body.appendChild(chip);

  const name = document.createElement('h2');
  name.className = 'card__name';
  name.textContent = p.n;
  body.appendChild(name);

  const price = document.createElement('div');
  price.className = 'card__price';
  const sell = document.createElement('span');
  sell.className = 'card__price-sell';
  sell.textContent = formatRupees(p.p);
  price.appendChild(sell);
  if (p.m !== p.p) {
    const mrp = document.createElement('span');
    mrp.className = 'card__price-mrp';
    mrp.textContent = formatRupees(p.m);
    price.appendChild(mrp);
  }
  body.appendChild(price);

  card.appendChild(body);
  return card;
}

export function mount(root: HTMLElement, categoryName: string): Cleanup {
  const category = store.categories.find((c) => c.name === categoryName);
  const queue: Product[] = category ? category.items : [];

  const wrap = document.createElement('div');
  wrap.className = 'screen screen-deck';
  wrap.innerHTML = `
    <header class="deck-topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back to categories">${ICON_BACK}</button>
      <div class="deck-progress">
        <span class="deck-progress__label" data-role="progress-label"></span>
        <div class="progress-bar"><div class="progress-bar__fill" data-role="progress-fill"></div></div>
      </div>
      <span class="status-chip" data-role="status-chip"></span>
    </header>
    <div class="card-stack" data-role="card-stack"></div>
    <footer class="deck-controls">
      <button type="button" class="btn-undo" data-action="undo" aria-label="Undo">${ICON_UNDO}</button>
      <button type="button" class="btn-decide btn-decide--no" data-action="no" aria-label="Don't stock">${ICON_CROSS}</button>
      <button type="button" class="btn-decide btn-decide--yes" data-action="yes" aria-label="Stock it">${ICON_CHECK}</button>
    </footer>
  `;
  root.appendChild(wrap);

  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;
  const cardStack = wrap.querySelector('[data-role="card-stack"]') as HTMLElement;
  const progressLabel = wrap.querySelector('[data-role="progress-label"]') as HTMLElement;
  const progressFill = wrap.querySelector('[data-role="progress-fill"]') as HTMLElement;
  const statusChip = wrap.querySelector('[data-role="status-chip"]') as HTMLElement;
  const undoBtn = wrap.querySelector('[data-action="undo"]') as HTMLButtonElement;
  const noBtn = wrap.querySelector('[data-action="no"]') as HTMLButtonElement;
  const yesBtn = wrap.querySelector('[data-action="yes"]') as HTMLButtonElement;

  const goBack = (): void => {
    window.location.hash = '#/';
  };
  backBtn.addEventListener('click', goBack);

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
    btn.addEventListener('click', goBack);
    panel.append(heading, body, btn);
    cardStack.appendChild(panel);
    undoBtn.disabled = true;
    noBtn.disabled = true;
    yesBtn.disabled = true;
    return () => backBtn.removeEventListener('click', goBack);
  }

  const EXIT_MS = prefersReducedMotion() ? 0 : 180;
  const SPRING_MS = prefersReducedMotion() ? 0 : 200;

  let pointer = queue.findIndex((p) => store.getDecision(p.s) === undefined);
  if (pointer === -1) pointer = queue.length;

  const history: string[] = [];
  const prefetched = new Set<string>();

  let animating = false;
  let dragging = false;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;

  let cardEl: HTMLElement | null = null;
  let tintEl: HTMLElement | null = null;

  function updateProgress(): void {
    const total = queue.length;
    progressLabel.textContent = `${Math.min(pointer, total)} / ${total}`;
    progressFill.style.width = `${total > 0 ? (Math.min(pointer, total) / total) * 100 : 0}%`;
  }

  function updateUndoButton(): void {
    undoBtn.disabled = history.length === 0;
  }

  function prefetchUpcoming(): void {
    for (let i = pointer + 1; i <= pointer + PREFETCH_COUNT && i < queue.length; i++) {
      const url = queue[i]?.i;
      if (!url || prefetched.has(url)) continue;
      prefetched.add(url);
      const img = new Image();
      img.src = thumb(url, 400);
    }
  }

  function applyDragTransform(x: number, y: number): void {
    if (!cardEl || !tintEl) return;
    const rot = clamp(x / 12, -MAX_TILT_DEG, MAX_TILT_DEG);
    cardEl.style.transform = `translate(${x}px, ${y * 0.4}px) rotate(${rot}deg)`;
    const frac = clamp(Math.abs(x) / SWIPE_THRESHOLD, 0, 1);
    tintEl.style.opacity = String(frac * 0.55);
    tintEl.style.background = x > 0 ? 'var(--yes)' : 'var(--no)';
  }

  function springBack(): void {
    if (!cardEl || !tintEl) return;
    cardEl.style.transition = `transform ${SPRING_MS}ms var(--ease-snap)`;
    cardEl.style.transform = 'translate(0, 0) rotate(0deg)';
    tintEl.style.transition = `opacity ${SPRING_MS}ms var(--ease-snap)`;
    tintEl.style.opacity = '0';
    const el = cardEl;
    window.setTimeout(() => {
      el.style.transition = '';
    }, SPRING_MS);
  }

  function commit(value: DecisionValue): void {
    if (animating || pointer >= queue.length) return;
    const current = queue[pointer];
    if (!cardEl || !tintEl) return;
    animating = true;

    const dir = value === 1 ? 1 : -1;
    const flyX = dir * (window.innerWidth + 300);
    cardEl.style.transition = `transform ${EXIT_MS}ms var(--ease-snap), opacity ${EXIT_MS}ms var(--ease-snap)`;
    cardEl.style.transform = `translate(${flyX}px, ${dy * 0.4}px) rotate(${dir * MAX_TILT_DEG * 1.4}deg)`;
    cardEl.style.opacity = '0';
    tintEl.style.transition = `opacity ${EXIT_MS}ms var(--ease-snap)`;
    tintEl.style.background = value === 1 ? 'var(--yes)' : 'var(--no)';
    tintEl.style.opacity = '0.55';

    store.setDecision(current.s, value);
    history.push(current.s);

    exitTimer = setTimeout(() => {
      exitTimer = null;
      pointer += 1;
      animating = false;
      renderCurrent();
    }, EXIT_MS);
  }

  function onUndo(): void {
    if (animating || history.length === 0) return;
    const sku = history.pop() as string;
    store.clearDecision(sku);
    pointer -= 1;
    renderCurrent();
  }

  function onPointerDown(e: PointerEvent): void {
    if (animating || !cardEl) return;
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dy = 0;
    cardEl.setPointerCapture(e.pointerId);
    cardEl.classList.add('card--dragging');
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging || e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
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
    cardEl.addEventListener('pointerdown', onPointerDown);
    cardEl.addEventListener('pointermove', onPointerMove);
    cardEl.addEventListener('pointerup', endDrag);
    cardEl.addEventListener('pointercancel', endDrag);
  }

  function renderComplete(): void {
    cardStack.innerHTML = '';
    cardEl = null;
    tintEl = null;

    const panel = document.createElement('div');
    panel.className = 'deck-complete';
    const icon = document.createElement('div');
    icon.className = 'deck-complete__icon';
    icon.innerHTML = ICON_DONE;
    const heading = document.createElement('h2');
    heading.textContent = `All done in ${categoryName}`;
    const body = document.createElement('p');
    body.textContent = "You've decided every product in this category.";
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-lg';
    btn.textContent = 'Back to categories';
    btn.addEventListener('click', goBack);
    panel.append(icon, heading, body, btn);
    cardStack.appendChild(panel);

    noBtn.disabled = true;
    yesBtn.disabled = true;
    updateProgress();
    updateUndoButton();
  }

  function renderCurrent(): void {
    dx = 0;
    dy = 0;
    if (pointer >= queue.length) {
      renderComplete();
      return;
    }

    cardStack.innerHTML = '';
    const peekProduct = queue[pointer + 1];
    if (peekProduct) cardStack.appendChild(buildCard(peekProduct, true));

    cardEl = buildCard(queue[pointer], false);
    cardStack.appendChild(cardEl);
    tintEl = cardEl.querySelector<HTMLElement>('.swipe-tint');
    wireCardEvents();

    noBtn.disabled = false;
    yesBtn.disabled = false;
    updateProgress();
    updateUndoButton();
    prefetchUpcoming();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (animating || pointer >= queue.length) return;
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

  function renderStatus(status: SyncStatus): void {
    statusChip.textContent = status === 'saving' ? 'Saving…' : status === 'offline' ? 'Offline — will sync' : 'Saved';
    statusChip.dataset.status = status; // CSS keys off data-status, not a modifier class
  }

  const onNoClick = (): void => commit(0);
  const onYesClick = (): void => commit(1);
  noBtn.addEventListener('click', onNoClick);
  yesBtn.addEventListener('click', onYesClick);
  undoBtn.addEventListener('click', onUndo);
  window.addEventListener('keydown', onKeydown);

  renderStatus(store.getStatus());
  const unsubscribeStatus = store.onStatusChange(renderStatus);

  renderCurrent();

  return () => {
    if (exitTimer !== null) clearTimeout(exitTimer);
    window.removeEventListener('keydown', onKeydown);
    unsubscribeStatus();
    backBtn.removeEventListener('click', goBack);
    noBtn.removeEventListener('click', onNoClick);
    yesBtn.removeEventListener('click', onYesClick);
    undoBtn.removeEventListener('click', onUndo);
  };
}
