/**
 * Category grid (home) — SPEC.md §9.2.
 *
 * One tile per product category, sorted by item count descending (that ordering comes straight
 * from `groupByCategory` in xlsx.js — this file doesn't re-sort). Each tile shows a representative
 * thumbnail, the category name, done/total, and a progress ring. A persistent footer button
 * downloads the yes-list once at least one item is picked.
 */

import { thumb } from '../xlsx.js';
import { store, type Category, type SyncStatus } from '../store';
import type { Product } from '../api';
import type { Cleanup } from '../main';

const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringSvg(done: number, total: number): string {
  const frac = total > 0 ? done / total : 0;
  const offset = RING_CIRCUMFERENCE * (1 - frac);
  return (
    `<svg class="ring" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">` +
    `<circle class="ring__track" cx="20" cy="20" r="${RING_RADIUS}" />` +
    `<circle class="ring__fill" cx="20" cy="20" r="${RING_RADIUS}" ` +
    `stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />` +
    `</svg>`
  );
}

function representativeImageUrl(items: readonly Product[]): string {
  const withImage = items.find((p) => p.i !== '');
  return withImage ? thumb(withImage.i, 200) : '';
}

function buildTile(cat: Category): HTMLButtonElement {
  const { done, total } = store.categoryProgress(cat.items);

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'cat-tile';

  // `.cat-tile__thumb` (60x60, object-fit: contain) goes directly on whichever element is
  // actually displayed — an <img> when there's an image, a monogram <div> when there isn't —
  // rather than on a wrapper, since object-fit only has an effect on the replaced element itself.
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
    placeholder.style.display = 'flex';
    placeholder.style.alignItems = 'center';
    placeholder.style.justifyContent = 'center';
    placeholder.style.fontWeight = '700';
    placeholder.style.color = 'var(--ink-3, #8d857a)';
    thumbEl = placeholder;
  }

  const info = document.createElement('div');
  info.className = 'cat-tile__info';
  const name = document.createElement('span');
  name.className = 'cat-tile__name';
  name.textContent = cat.name;
  const count = document.createElement('span');
  count.className = 'cat-tile__count';
  count.textContent = `${done} / ${total}`;
  info.append(name, count);

  const ringWrap = document.createElement('div');
  ringWrap.className = 'cat-tile__ring';
  ringWrap.innerHTML = ringSvg(done, total);
  if (done >= total && total > 0) ringWrap.classList.add('cat-tile__ring--complete');

  tile.append(thumbEl, info, ringWrap);
  tile.addEventListener('click', () => {
    window.location.hash = '#/deck/' + encodeURIComponent(cat.name);
  });
  return tile;
}

export function mount(root: HTMLElement): Cleanup {
  const wrap = document.createElement('div');
  wrap.className = 'screen screen-categories';

  const isAdmin = store.session?.role === 'admin';

  wrap.innerHTML = `
    <header class="cat-header">
      <div class="cat-header__row">
        <span class="cat-header__user">${store.session ? escapeText(store.session.username) : ''}</span>
        <span class="status-chip" data-role="status-chip"></span>
        <div class="cat-header__actions">
          ${isAdmin ? '<button type="button" class="link-btn" data-action="admin">Admin</button>' : ''}
          <button type="button" class="link-btn" data-action="logout">Log out</button>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-bar__fill" data-role="overall-fill"></div>
      </div>
      <p class="cat-header__summary" data-role="overall-summary"></p>
    </header>
    <main class="cat-grid" data-role="grid"></main>
    <footer class="footer-bar">
      <button type="button" class="btn btn-primary btn-lg footer-bar__btn" data-role="download-btn">
        Download my list
      </button>
    </footer>
  `;
  root.appendChild(wrap);

  const grid = wrap.querySelector('[data-role="grid"]') as HTMLElement;
  const overallFill = wrap.querySelector('[data-role="overall-fill"]') as HTMLElement;
  const overallSummary = wrap.querySelector('[data-role="overall-summary"]') as HTMLElement;
  const downloadBtn = wrap.querySelector('[data-role="download-btn"]') as HTMLButtonElement;
  const statusChip = wrap.querySelector('[data-role="status-chip"]') as HTMLElement;

  function renderHeader(): void {
    const decided = store.overallDecided;
    const total = store.overallTotal;
    const pct = total > 0 ? Math.min(100, (decided / total) * 100) : 0;
    overallFill.style.width = `${pct}%`;
    overallSummary.textContent = `${decided} of ${total} decided`;
  }

  function renderFooter(): void {
    const yes = store.overallYes;
    downloadBtn.textContent = `Download my list (${yes} item${yes === 1 ? '' : 's'})`;
    downloadBtn.disabled = yes < 1;
  }

  function renderStatus(status: SyncStatus): void {
    statusChip.textContent = status === 'saving' ? 'Saving…' : status === 'offline' ? 'Offline — will sync' : 'Saved';
    statusChip.dataset.status = status; // CSS keys off data-status, not a modifier class
  }

  if (store.categories.length === 0) {
    if (store.catalog === null) {
      grid.innerHTML = isAdmin
        ? '<p class="empty-state">No catalog uploaded yet. Go to Admin to upload the master sheet.</p>'
        : '<p class="empty-state">No catalog yet — please check back after your admin uploads it.</p>';
    } else {
      grid.innerHTML = '<p class="empty-state">No products in this catalog yet.</p>';
    }
  } else {
    for (const cat of store.categories) grid.appendChild(buildTile(cat));
  }

  renderHeader();
  renderFooter();
  renderStatus(store.getStatus());
  const unsubscribeStatus = store.onStatusChange(renderStatus);

  function onDownload(): void {
    if (downloadBtn.disabled) return;
    window.location.hash = '#/export';
  }
  downloadBtn.addEventListener('click', onDownload);

  function onLogout(): void {
    void store.logout().then(() => {
      window.location.hash = '#/login';
    });
  }
  const logoutBtn = wrap.querySelector('[data-action="logout"]');
  logoutBtn?.addEventListener('click', onLogout);

  function onAdmin(): void {
    window.location.hash = '#/admin';
  }
  const adminBtn = wrap.querySelector('[data-action="admin"]');
  adminBtn?.addEventListener('click', onAdmin);

  return () => {
    unsubscribeStatus();
    downloadBtn.removeEventListener('click', onDownload);
    logoutBtn?.removeEventListener('click', onLogout);
    adminBtn?.removeEventListener('click', onAdmin);
  };
}

function escapeText(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
