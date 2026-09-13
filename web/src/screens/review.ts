/**
 * Review screen — SPEC.md §9.3b (production v2, Phase 2).
 *
 * The trust screen: three tabs Stocked (N) / Not stocked (N) / Left to check (N),
 * same row component as list mode, everything one tap from changing. Reachable from
 * home (menu), the deck completion panel, and export. Optional category scope:
 * `#/review/<category>` filters to that category (deck "Review this category").
 *
 * "Left to check" can hold thousands of products now, so the old 300-item cap (with a
 * "use search on home" dead end) is gone: rows render incrementally (renderIncrementalList)
 * and a search box filters within whichever tab is open. The tab bar is sticky so switching
 * tabs never requires scrolling back up first.
 */

import { store } from '../store';
import type { Product } from '../api';
import type { Cleanup } from '../main';
import { productRow } from '../product-row';
import { openEditSheet } from './edit-sheet';
import { renderIncrementalList, type IncrementalListHandle } from '../ui';

/** Case/diacritic-insensitive match, mirroring store.ts's own search normalisation. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const ICON_BACK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';

type Tab = 'yes' | 'no' | 'left';

export function mount(root: HTMLElement, categoryName?: string): Cleanup {
  const wrap = document.createElement('div');
  wrap.className = 'screen screen-review';
  wrap.innerHTML = `
    <header class="export-topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back">${ICON_BACK}</button>
      <h1 data-role="title">Review my list</h1>
    </header>
    <div class="export-body">
      <div class="review-toolbar">
        <div class="review-tabs" role="tablist" data-role="tabs"></div>
        <input class="search-input review-search" data-role="search" type="search"
               placeholder="Search this list" aria-label="Search this list" autocomplete="off" />
      </div>
      <p class="export-sub" data-role="scope"></p>
      <div data-role="rows"></div>
    </div>
  `;
  root.appendChild(wrap);

  const title = wrap.querySelector('[data-role="title"]') as HTMLElement;
  const tabsEl = wrap.querySelector('[data-role="tabs"]') as HTMLElement;
  const searchInput = wrap.querySelector('[data-role="search"]') as HTMLInputElement;
  const scopeEl = wrap.querySelector('[data-role="scope"]') as HTMLElement;
  const rowsEl = wrap.querySelector('[data-role="rows"]') as HTMLElement;
  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;

  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
  ): void => {
    el.addEventListener(type, fn as EventListener);
    cleanups.push(() => el.removeEventListener(type, fn as EventListener));
  };

  let tab: Tab = 'yes';
  let query = '';
  const scope = categoryName && store.categories.some((c) => c.name === categoryName) ? categoryName : undefined;
  if (scope) title.textContent = `Review ${scope}`;

  const goBack = (): void => {
    window.location.hash = '#/';
  };
  backBtn.addEventListener('click', goBack);

  function pool(): Product[] {
    const all = scope
      ? (store.categories.find((c) => c.name === scope)?.items ?? [])
      : store.products;
    return all;
  }

  function counts(): { yes: number; no: number; left: number } {
    let yes = 0;
    let no = 0;
    for (const p of pool()) {
      const v = store.getDecision(p.s);
      if (v === 1) yes++;
      else if (v === 0) no++;
    }
    const total = pool().length;
    return { yes, no, left: total - yes - no };
  }

  function buildRow(p: Product): HTMLElement {
    return productRow(p, {
      onChange: render,
      onEdit: (prod) => openEditSheet(prod, render),
    });
  }

  let listHandle: IncrementalListHandle | null = null;
  // Toggling an item calls render() again; without this the scroll position (and rendered
  // batch depth) reset to the top every time, which is infuriating when correcting item 400.
  // Chosen approach: preserve scrollTop + rendered count across same-context re-renders
  // (same tab, same search) instead of diffing individual rows in place — simpler to keep
  // correct alongside the tab/search filtering below, and a toggle only ever changes one row's
  // own state, which productRow already updates without a rebuild via its internal render().
  let lastContextKey = '';

  function renderRows(items: Product[]): void {
    const contextKey = `${tab}\u0000${query}`;
    const contextChanged = contextKey !== lastContextKey;
    lastContextKey = contextKey;

    const previousCount = contextChanged ? undefined : listHandle?.renderedCount();
    const scrollY = contextChanged ? 0 : window.scrollY;

    listHandle?.destroy();
    listHandle = null;
    rowsEl.innerHTML = '';

    if (items.length === 0) {
      const p = document.createElement('p');
      p.className = 'export-sub';
      p.textContent = query.trim()
        ? `No products match "${query}" here.`
        : tab === 'yes'
          ? 'Nothing stocked here yet.'
          : tab === 'no'
            ? 'Nothing marked “not stocked”.'
            : 'Nothing left — this list is done.';
      rowsEl.appendChild(p);
      return;
    }

    const list = document.createElement('ul');
    list.className = 'prow-list';
    rowsEl.appendChild(list);
    listHandle = renderIncrementalList(list, items, buildRow, { initialCount: previousCount });

    if (!contextChanged) {
      // Restore after the batch above has painted, else scrollTo lands before layout settles.
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }

  function render(): void {
    const c = counts();
    scopeEl.textContent = scope
      ? `${c.yes} stocked · ${c.no} no · ${c.left} left in ${scope}`
      : `${c.yes} stocked · ${c.no} no · ${c.left} left overall`;
    tabsEl.innerHTML = '';
    for (const [key, label, n] of [
      ['yes', 'Stocked', c.yes],
      ['no', 'Not stocked', c.no],
      ['left', 'Left to check', c.left],
    ] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-btn review-tab';
      b.textContent = `${label} (${n})`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', tab === key ? 'true' : 'false');
      b.setAttribute('aria-pressed', tab === key ? 'true' : 'false');
      b.addEventListener('click', () => {
        if (tab === key) return;
        tab = key;
        render();
      });
      tabsEl.appendChild(b);
    }

    const needle = norm(query.trim());
    const items = pool().filter((p) => {
      const v = store.getDecision(p.s);
      const matchesTab = tab === 'yes' ? v === 1 : tab === 'no' ? v === 0 : v === undefined;
      if (!matchesTab) return false;
      if (!needle) return true;
      return norm(store.displayOf(p).name).includes(needle) || norm(p.s).includes(needle);
    });
    renderRows(items);
  }

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  on(searchInput, 'input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value;
      render();
    }, 200);
  });
  on(searchInput, 'keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.preventDefault();
      searchInput.value = '';
      query = '';
      render();
    }
  });

  render();
  return () => {
    backBtn.removeEventListener('click', goBack);
    if (searchTimer !== null) clearTimeout(searchTimer);
    listHandle?.destroy();
    for (const fn of cleanups) fn();
  };
}
