/**
 * Category grid (home) — SPEC.md §9.2 (production v2 rebuild).
 *
 * Top to bottom: header (user + sync chip + ⋯ menu), the one number that matters
 * (You stock N), secondary checked/not-stocked, progress bar + %, primary CTA
 * (Start / Continue / Download when done), always-visible search, category list
 * (unfinished-first, 3-part state, finished unmistakable but tappable), footer
 * download bar only once N ≥ 1.
 */

import { thumb } from '../xlsx.js';
import { store, type Category, type SyncStatus } from '../store';
import type { Product } from '../api';
import type { Cleanup } from '../main';
import { productRow } from '../product-row';
import { confirmDialog, renderIncrementalList, renderStatusChip, type IncrementalListHandle } from '../ui';

const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringSvg(done: number, total: number): string {
  const frac = total > 0 ? done / total : 0;
  const offset = RING_CIRCUMFERENCE * (1 - frac);
  return (
    `<svg class="ring" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">` +
    `<circle class="ring__track" cx="20" cy="20" r="${RING_RADIUS}" stroke-width="4" />` +
    `<circle class="ring__fill" cx="20" cy="20" r="${RING_RADIUS}" stroke-width="4" ` +
    `stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />` +
    `</svg>`
  );
}

function representativeImageUrl(items: readonly Product[]): string {
  const withImage = items.find((p) => p.i !== '');
  return withImage ? thumb(withImage.i, 200) : '';
}

function buildTile(cat: Category): HTMLButtonElement {
  const { done, yes, no, total } = store.categoryProgress(cat.items);
  const left = total - done;
  const finished = total > 0 && done >= total;

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'cat-tile' + (finished ? ' cat-tile--done' : '');
  tile.setAttribute(
    'aria-label',
    `${cat.name}: ${yes} stocked, ${no} not stocked, ${left} left`,
  );

  const url = representativeImageUrl(cat.items);
  let thumbEl: HTMLElement;
  if (url) {
    const img = document.createElement('img');
    img.className = 'cat-tile__thumb';
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    thumbEl = img;
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'cat-tile__thumb cat-tile__thumb--empty';
    placeholder.textContent = cat.name.charAt(0).toUpperCase();
    placeholder.setAttribute('aria-hidden', 'true');
    thumbEl = placeholder;
  }

  const info = document.createElement('div');
  info.className = 'cat-tile__info';
  const name = document.createElement('span');
  name.className = 'cat-tile__name';
  name.textContent = (finished ? '✓ ' : '') + cat.name;
  const count = document.createElement('span');
  count.className = 'cat-tile__count';
  count.textContent = `✓ ${yes} stocked · ✗ ${no} no · ${left} left`;
  info.append(name, count);

  const ringWrap = document.createElement('div');
  ringWrap.className = 'cat-tile__ring';
  ringWrap.innerHTML = ringSvg(done, total);

  tile.append(thumbEl, info, ringWrap);
  tile.addEventListener('click', () => {
    window.location.hash = '#/deck/' + encodeURIComponent(cat.name);
  });
  return tile;
}

/** Where should Continue go? Saved position if still undecided, else first unfinished. */
function continueTarget(): { category: string; index: number; left: number } | null {
  const saved = store.getContinue();
  if (saved) {
    const cat = store.categories.find((c) => c.name === saved.category);
    if (cat) {
      const idx = cat.items.findIndex((p) => p.s === saved.sku);
      if (idx >= 0 && store.getDecision(saved.sku) === undefined) {
        const left = cat.items.length - store.categoryProgress(cat.items).done;
        return { category: saved.category, index: idx, left };
      }
    }
  }
  const unfinished = store.categories
    .map((c) => ({ c, left: c.items.length - store.categoryProgress(c.items).done }))
    .filter((x) => x.left > 0)
    .sort((a, b) => b.left - a.left);
  if (unfinished.length === 0) return null;
  const top = unfinished[0];
  const idx = store.firstUndecidedIndex(top.c.items);
  return { category: top.c.name, index: Math.min(idx, top.c.items.length - 1), left: top.left };
}

export function mount(root: HTMLElement): Cleanup {
  const wrap = document.createElement('div');
  wrap.className = 'screen screen-categories';

  const isAdmin = store.session?.role === 'admin';
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
  ): void => {
    el.addEventListener(type, fn as EventListener);
    cleanups.push(() => el.removeEventListener(type, fn as EventListener));
  };

  wrap.innerHTML = `
    <header class="cat-header">
      <div class="cat-header__row">
        <span class="cat-header__user" data-role="user"></span>
        <span class="status-chip" data-role="status-chip" aria-live="polite"></span>
        <div class="cat-header__actions">
          <div class="menu-wrap">
            <button type="button" class="icon-btn" data-action="menu" aria-label="Menu" aria-haspopup="menu">⋯</button>
          </div>
        </div>
      </div>
      <p class="home-stock" data-role="stock" aria-live="polite"></p>
      <p class="home-stock__sub" data-role="stock-sub"></p>
      <div class="progress-bar" role="progressbar" data-role="overall-bar">
        <div class="progress-bar__fill" data-role="overall-fill"></div>
      </div>
      <p class="cat-header__summary" data-role="overall-summary"></p>
      <div class="home-cta" data-role="cta"></div>
      <div class="home-search">
        <input class="search-input" data-role="search" type="search"
               placeholder="Search products" aria-label="Search products" autocomplete="off" />
      </div>
    </header>
    <main class="cat-main">
      <div class="cat-grid" data-role="grid"></div>
      <div class="search-view" data-role="search-view" hidden>
        <div class="search-bar">
          <p data-role="search-summary"></p>
          <button type="button" class="link-btn" data-role="search-clear">Clear</button>
        </div>
        <div data-role="search-rows"></div>
      </div>
    </main>
    <footer class="footer-bar" data-role="footer" hidden>
      <button type="button" class="btn btn-primary btn-lg footer-bar__btn" data-role="download-btn">
        Download my list
      </button>
    </footer>
  `;
  root.appendChild(wrap);

  const userEl = wrap.querySelector('[data-role="user"]') as HTMLElement;
  userEl.textContent = store.session ? store.session.username : '';

  const grid = wrap.querySelector('[data-role="grid"]') as HTMLElement;
  const overallFill = wrap.querySelector('[data-role="overall-fill"]') as HTMLElement;
  const overallBar = wrap.querySelector('[data-role="overall-bar"]') as HTMLElement;
  const overallSummary = wrap.querySelector('[data-role="overall-summary"]') as HTMLElement;
  const stockEl = wrap.querySelector('[data-role="stock"]') as HTMLElement;
  const stockSub = wrap.querySelector('[data-role="stock-sub"]') as HTMLElement;
  const downloadBtn = wrap.querySelector('[data-role="download-btn"]') as HTMLButtonElement;
  const footer = wrap.querySelector('[data-role="footer"]') as HTMLElement;
  const statusChip = wrap.querySelector('[data-role="status-chip"]') as HTMLElement;
  const ctaBox = wrap.querySelector('[data-role="cta"]') as HTMLElement;
  const searchInput = wrap.querySelector('[data-role="search"]') as HTMLInputElement;
  const searchView = wrap.querySelector('[data-role="search-view"]') as HTMLElement;
  const searchSummary = wrap.querySelector('[data-role="search-summary"]') as HTMLElement;
  const searchClearBtn = wrap.querySelector('[data-role="search-clear"]') as HTMLButtonElement;
  const searchRows = wrap.querySelector('[data-role="search-rows"]') as HTMLElement;
  searchInput.placeholder =
    store.overallTotal > 0 ? `Search ${store.overallTotal.toLocaleString('en-IN')} products` : 'Search products';

  // Overflow menu: Admin (if admin) + Log out with confirm. Kills the 1.9px adjacency (D-12).
  const menuWrap = wrap.querySelector('.menu-wrap') as HTMLElement;
  const menuBtn = wrap.querySelector('[data-action="menu"]') as HTMLButtonElement;
  let menuEl: HTMLElement | null = null;
  function closeMenu(): void {
    menuEl?.remove();
    menuEl = null;
    document.removeEventListener('click', onDocClick, true);
  }
  function onDocClick(e: MouseEvent): void {
    if (menuEl && !menuEl.contains(e.target as Node) && e.target !== menuBtn) closeMenu();
  }
  on(menuBtn, 'click', () => {
    if (menuEl) {
      closeMenu();
      return;
    }
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.setAttribute('role', 'menu');
    if (isAdmin) {
      const adminBtn = document.createElement('button');
      adminBtn.type = 'button';
      adminBtn.textContent = 'Admin';
      adminBtn.setAttribute('role', 'menuitem');
      adminBtn.addEventListener('click', () => {
        closeMenu();
        window.location.hash = '#/admin';
      });
      menuEl.appendChild(adminBtn);
    }
    const reviewBtn = document.createElement('button');
    reviewBtn.type = 'button';
    reviewBtn.textContent = 'Review my list';
    reviewBtn.setAttribute('role', 'menuitem');
    reviewBtn.addEventListener('click', () => {
      closeMenu();
      window.location.hash = '#/review';
    });
    const logoutBtn = document.createElement('button');
    logoutBtn.type = 'button';
    logoutBtn.textContent = 'Log out';
    logoutBtn.setAttribute('role', 'menuitem');
    logoutBtn.addEventListener('click', () => {
      closeMenu();
      void (async () => {
        const ok = await confirmDialog({
          title: 'Log out?',
          body: 'Your work is saved on the server.',
          confirmLabel: 'Log out',
        });
        if (!ok) return;
        await store.logout();
        window.location.hash = '#/login';
      })();
    });
    menuEl.append(reviewBtn, logoutBtn);
    menuWrap.appendChild(menuEl);
    document.addEventListener('click', onDocClick, true);
  });

  function renderHeader(): void {
    const decided = store.overallDecided;
    const total = store.overallTotal;
    const yes = store.overallYes;
    const no = store.overallNo;
    const pct = total > 0 ? Math.min(100, (decided / total) * 100) : 0;
    overallFill.style.width = `${pct}%`;
    overallBar.setAttribute('aria-valuenow', String(Math.round(pct)));
    overallBar.setAttribute('aria-valuemin', '0');
    overallBar.setAttribute('aria-valuemax', '100');
    overallSummary.textContent = `${decided} of ${total} checked · ${Math.round(pct)}%`;
    // The one number that matters (D-18): yes-count is first-class, not hidden in a button.
    stockEl.textContent = `You stock ${yes} item${yes === 1 ? '' : 's'}`;
    stockSub.textContent = `${decided} of ${total} products checked · ${no} not stocked`;
  }

  function renderCta(): void {
    ctaBox.innerHTML = '';
    const decided = store.overallDecided;
    const total = store.overallTotal;
    if (total === 0) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-lg';
    if (decided === 0) {
      btn.textContent = 'Start checking products';
      btn.addEventListener('click', () => {
        const t = continueTarget();
        const first = t?.category ?? store.categories[0]?.name;
        if (first) window.location.hash = '#/deck/' + encodeURIComponent(first);
      });
    } else if (decided < total) {
      const t = continueTarget();
      // An item index means nothing to a shopkeeper — how many are left in that category does.
      btn.textContent = t ? `Continue — ${t.category} (${t.left} left)` : 'Continue checking products';
      btn.addEventListener('click', () => {
        if (t) window.location.hash = '#/deck/' + encodeURIComponent(t.category);
      });
    } else {
      // Everything is decided: the footer download bar (if yes >= 1) already says exactly
      // this. Two identical primary actions on screen is worse than one, so skip this one.
      return;
    }
    ctaBox.appendChild(btn);
  }

  function renderFooter(): void {
    const yes = store.overallYes;
    // No dead disabled download as the most prominent thing on a first-time screen:
    // the bar only exists once there is something to download.
    if (yes < 1) {
      footer.hidden = true;
      return;
    }
    footer.hidden = false;
    downloadBtn.textContent = `Download my list (${yes} item${yes === 1 ? '' : 's'})`;
    downloadBtn.disabled = false;
  }

  function renderStatus(status: SyncStatus): void {
    renderStatusChip(statusChip, status);
  }

  function renderGrid(): void {
    grid.innerHTML = '';
    if (store.categories.length === 0) {
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent =
        store.catalog === null
          ? isAdmin
            ? 'No catalog uploaded yet. Open the menu → Admin to upload the master sheet.'
            : 'No catalog yet — please check back after your admin uploads it.'
          : 'No products in this catalog yet.';
      grid.appendChild(p);
      return;
    }
    // Unfinished first (largest first), finished last — never scroll past done work.
    const ordered = [...store.categories].sort((a, b) => {
      const pa = store.categoryProgress(a.items);
      const pb = store.categoryProgress(b.items);
      const fa = pa.done >= pa.total && pa.total > 0 ? 1 : 0;
      const fb = pb.done >= pb.total && pb.total > 0 ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return b.items.length - a.items.length || a.name.localeCompare(b.name);
    });
    for (const cat of ordered) grid.appendChild(buildTile(cat));
  }

  function renderAll(): void {
    renderHeader();
    renderCta();
    renderFooter();
    renderGrid();
  }

  // Search: debounced, toggleable rows with category + state (D-06). Results replace the
  // category grid in the main content area — they used to live inside the sticky header,
  // where a long list grew taller than the screen and shoved the grid out of reach.
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchListHandle: IncrementalListHandle | null = null;

  function clearSearch(): void {
    searchInput.value = '';
    renderSearch();
  }

  function renderSearch(): void {
    const q = searchInput.value;
    if (searchListHandle) {
      searchListHandle.destroy();
      searchListHandle = null;
    }
    searchRows.innerHTML = '';
    if (!q.trim()) {
      searchView.hidden = true;
      grid.hidden = false;
      return;
    }
    grid.hidden = true;
    searchView.hidden = false;
    const hits = store.search(q);
    searchSummary.textContent =
      hits.length === 0
        ? `No products match "${q}"`
        : `${hits.length.toLocaleString('en-IN')} product${hits.length === 1 ? '' : 's'} match "${q}"`;
    if (hits.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'prow-list search-results-list';
    searchRows.appendChild(list);
    searchListHandle = renderIncrementalList(list, hits, (p) =>
      productRow(p, {
        onChange: () => {
          renderAll();
          renderSearch();
        },
      }),
    );
  }
  on(searchInput, 'input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(renderSearch, 200);
  });
  on(searchInput, 'keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.preventDefault();
      clearSearch();
    }
  });
  on(searchClearBtn, 'click', () => {
    clearSearch();
    searchInput.focus();
  });

  renderAll();
  renderStatus(store.getStatus());
  const unsubscribeStatus = store.onStatusChange(renderStatus);

  on(downloadBtn, 'click', () => {
    window.location.hash = '#/export';
  });

  return () => {
    unsubscribeStatus();
    closeMenu();
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchListHandle?.destroy();
    for (const fn of cleanups) fn();
  };
}
