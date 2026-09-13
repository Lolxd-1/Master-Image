/**
 * Shared product-row component (production v2, Phase 1 → v3 touch-up).
 *
 * One row used by list mode, review, search results and export — thumbnail, name (2-line
 * clamp), price (edited shown, original struck), pack size when known, an Edited badge,
 * and a control on the right. Product names come from an uploaded file, so everything
 * user-supplied is built with `textContent`, never `innerHTML` (XSS via a product name is
 * a real path); the inline SVG icons below are static developer-authored markup, the one
 * safe use of `innerHTML` here, and each carries explicit width/height — a bare-viewBox
 * <svg> has no intrinsic size and renders at the UA default 300×150 otherwise.
 *
 * The whole row (not just the 44px toggle) answers a tap to decide stock/no-stock — a 64px
 * row where only a small square responds is a poor target on a phone. `.prow__edit` and
 * `.prow__toggle` stop propagation so they keep their own, separate behaviour.
 */

import { thumb } from './xlsx.js';
import { store } from './store';
import { packSizeFromName, formatPackSize } from './units';
import type { Product } from './api';

export type RowControl = 'toggle' | 'remove' | 'none';

const ICON_CHECK =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>';
const ICON_CROSS =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_PLUS =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_PENCIL =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_REMOVE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function displayPrice(p: Product): { sell: number; mrp: number; edited: boolean } {
  const ov = store.getOverride(p.s);
  const sell = ov?.price !== undefined ? Number(ov.price) : p.p;
  const mrp = ov?.mrp !== undefined ? Number(ov.mrp) : p.m;
  return { sell, mrp, edited: ov !== undefined };
}

function formatRupees(n: number): string {
  return '₹' + n.toLocaleString('en-IN');
}

/** Shopkeeper-set size (confirmed) beats a best-effort read of the name (unconfirmed). */
function displaySize(name: string, ovSize: string | undefined): { text: string; confirmed: boolean } | null {
  if (ovSize) return { text: ovSize, confirmed: true };
  const parsed = packSizeFromName(name);
  return parsed ? { text: formatPackSize(parsed), confirmed: false } : null;
}

/** Build a <li class="prow"> for product p. Caller appends it. */
export function productRow(
  p: Product,
  opts: {
    readonly control?: RowControl;
    readonly onChange?: () => void;
    readonly onEdit?: (p: Product) => void;
    /** Show the ` · <category>` segment on the meta line. Default true — off only where
     *  the caller (deck list mode) is already inside that single category, so repeating
     *  it on every row is pure noise (and truncates to "Na..." at 360px). */
    readonly showCategory?: boolean;
  } = {},
): HTMLElement {
  const control = opts.control ?? 'toggle';
  const li = document.createElement('li');
  li.className = 'prow';
  li.dataset.sku = p.s;
  if (control === 'toggle') li.classList.add('prow--tappable');

  const ov = store.getOverride(p.s);
  const name = ov?.name ?? p.n;
  const imgUrl = p.i ? thumb(p.i, 200) : '';
  if (imgUrl) {
    const img = document.createElement('img');
    img.className = 'prow__thumb';
    img.src = imgUrl;
    img.alt = '';
    img.loading = 'lazy';
    li.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'prow__thumb prow__thumb--empty';
    ph.textContent = name.charAt(0).toUpperCase();
    ph.setAttribute('aria-hidden', 'true');
    li.appendChild(ph);
  }

  const info = document.createElement('div');
  info.className = 'prow__info';
  const nameEl = document.createElement('div');
  nameEl.className = 'prow__name prow__name-clamp';
  nameEl.textContent = name;
  info.appendChild(nameEl);

  // Meta line: Changed badge, pack size, price, category — one line, ellipsised, never
  // a child of the clamped name box (an inline-block child there breaks -webkit-line-clamp).
  const meta = document.createElement('div');
  meta.className = 'prow__meta';
  if (ov) {
    const badge = document.createElement('span');
    badge.className = 'edited-badge';
    badge.textContent = 'Changed';
    meta.appendChild(badge);
  }
  const metaGroups: HTMLElement[] = [];
  const sizeInfo = displaySize(name, ov?.size);
  if (sizeInfo) {
    const sizeSpan = document.createElement('span');
    sizeSpan.className = sizeInfo.confirmed ? 'prow__size' : 'prow__size prow__size--muted';
    sizeSpan.textContent = sizeInfo.text;
    metaGroups.push(sizeSpan);
  }
  const { sell, mrp } = displayPrice(p);
  const priceGroup = document.createElement('span');
  const priceEl = document.createElement('span');
  priceEl.className = 'prow__price';
  priceEl.textContent = formatRupees(sell);
  priceGroup.appendChild(priceEl);
  if (mrp !== sell) {
    const origEl = document.createElement('span');
    origEl.className = 'prow__price-orig';
    origEl.textContent = formatRupees(mrp);
    priceGroup.appendChild(origEl);
  }
  metaGroups.push(priceGroup);
  if (opts.showCategory ?? true) {
    const catEl = document.createElement('span');
    catEl.textContent = p.c;
    metaGroups.push(catEl);
  }
  metaGroups.forEach((group, i) => {
    if (i > 0 || ov) meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(group);
  });
  info.appendChild(meta);
  li.appendChild(info);

  /** Shared by the row tap and the toggle button — undecided → stocked → not stocked → … */
  function cycleDecision(): void {
    const cur = store.getDecision(p.s);
    const next = cur === undefined ? 1 : cur === 1 ? 0 : 1;
    store.setDecision(p.s, next as 0 | 1);
    render();
    opts.onChange?.();
  }

  let render: () => void = () => undefined;

  if (control === 'toggle') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prow__toggle';
    render = (): void => {
      const v = store.getDecision(p.s);
      btn.dataset.state = v === undefined ? '' : String(v);
      btn.innerHTML = v === 1 ? ICON_CHECK : v === 0 ? ICON_CROSS : ICON_PLUS;
      btn.setAttribute(
        'aria-label',
        `${name}: ${v === 1 ? 'stocked, tap to change' : v === 0 ? 'not stocked, tap to change' : 'not checked, tap to stock'}`,
      );
      btn.setAttribute('aria-pressed', v === 1 ? 'true' : 'false');
    };
    render();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleDecision();
    });
    li.addEventListener('click', cycleDecision);
    li.appendChild(btn);
  } else if (control === 'remove') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prow__remove';
    btn.innerHTML = ICON_REMOVE;
    btn.setAttribute('aria-label', `Remove ${name} from my list`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      store.clearDecision(p.s);
      opts.onChange?.();
    });
    li.appendChild(btn);
  }

  if (opts.onEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'prow__edit';
    editBtn.innerHTML = ICON_PENCIL;
    editBtn.setAttribute('aria-label', `Edit ${name}`);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onEdit?.(p);
    });
    li.appendChild(editBtn);
  }

  return li;
}
