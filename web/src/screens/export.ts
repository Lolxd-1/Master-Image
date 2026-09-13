/**
 * Export screen — SPEC.md §9.4 (production v2, Phase 4).
 *
 * `N items ready`, per-category breakdown, the ACTUAL item list (removable →
 * undecided everywhere, Edited badges, edited count), primary `Make my file`,
 * real success state (filename + count + Share via navigator.share files with
 * silent download fallback + Save to phone), short instruction. Rebuilds from
 * current state on every build — never serves a stale blob. Overrides applied
 * before renumbering (SPEC §8); F > E fails closed before bytes are emitted.
 */

import { buildWorkbook, groupByCategory } from '../xlsx.js';
import { fetchCatalogRows, fetchCatalogSkeleton, fetchOverrides } from '../api';
import { store, type Category, type SyncStatus } from '../store';
import type { Cleanup } from '../main';
import { productRow } from '../product-row';
import type { Product } from '../api';
import { renderIncrementalList, renderStatusChip, type IncrementalListHandle } from '../ui';

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

function formatYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function triggerDownload(bytes: Uint8Array, filename: string): void {
  // Copy into a plain ArrayBuffer-backed view: TS 5.7+ types Uint8Array as possibly
  // SharedArrayBuffer-backed, which BlobPart does not accept.
  const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mount(root: HTMLElement): Cleanup {
  const wrap = document.createElement('div');
  wrap.className = 'screen screen-export';
  const cleanups: Array<() => void> = [];
  const on = (el: HTMLElement, type: string, fn: EventListener): void => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };

  const goBack = (): void => {
    window.location.hash = '#/';
  };

  const yesSkus = store.getYesSkusInOrder();

  if (yesSkus.length === 0) {
    wrap.innerHTML = `
      <header class="export-topbar"><button type="button" class="icon-btn" data-action="back" aria-label="Back">${ICON_BACK}</button>
      <h1>My list</h1></header>
      <div class="export-empty">
        <h1>Nothing in your list yet</h1>
        <p>Mark at least one product “Stock it”, then come back here.</p>
        <button type="button" class="btn btn-primary btn-lg" data-action="back-cta">Back to products</button>
      </div>
    `;
    root.appendChild(wrap);
    const back1 = wrap.querySelector('[data-action="back"]') as HTMLElement;
    const back2 = wrap.querySelector('[data-action="back-cta"]') as HTMLElement;
    on(back1, 'click', goBack);
    on(back2, 'click', goBack);
    return () => {
      for (const fn of cleanups) fn();
    };
  }

  const yesProducts = store.products.filter((p) => store.getDecision(p.s) === 1);
  void yesProducts;

  wrap.innerHTML = `
    <header class="export-topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back">${ICON_BACK}</button>
      <h1>My list</h1>
      <span class="status-chip" data-role="status-chip" aria-live="polite"></span>
    </header>
    <div class="export-body">
      <p class="export-total" data-role="total" aria-live="polite"></p>
      <p class="export-sub" data-role="edited-sub"></p>
      <ul class="export-breakdown" data-role="breakdown"></ul>
      <div data-role="items"></div>
      <p class="export-sub">See everything before you make the file.</p>
      <button type="button" class="btn btn-lg" data-role="review-link">Review my list</button>
      <p class="export-error" role="alert" hidden></p>
      <div class="export-success" data-role="success" hidden></div>
      <div class="export-actions">
        <button type="button" class="btn btn-primary btn-lg export-build-btn" data-role="build-btn">
          Make my file
        </button>
        <button type="button" class="btn btn-lg" data-role="share-btn" hidden>Share</button>
      </div>
      <p class="export-note">Send this file as it is. Do not open it first.</p>
    </div>
  `;
  root.appendChild(wrap);

  const totalEl = wrap.querySelector('[data-role="total"]') as HTMLElement;
  const editedSub = wrap.querySelector('[data-role="edited-sub"]') as HTMLElement;
  const breakdownEl = wrap.querySelector('[data-role="breakdown"]') as HTMLElement;
  const itemsEl = wrap.querySelector('[data-role="items"]') as HTMLElement;
  const buildBtn = wrap.querySelector('[data-role="build-btn"]') as HTMLButtonElement;
  const shareBtn = wrap.querySelector('[data-role="share-btn"]') as HTMLButtonElement;
  const errorEl = wrap.querySelector('.export-error') as HTMLElement;
  const successEl = wrap.querySelector('[data-role="success"]') as HTMLElement;
  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;
  const reviewBtn = wrap.querySelector('[data-role="review-link"]') as HTMLButtonElement;
  const statusChip = wrap.querySelector('[data-role="status-chip"]') as HTMLElement;

  function renderStatus(status: SyncStatus): void {
    renderStatusChip(statusChip, status);
  }
  renderStatus(store.getStatus());
  const unsub = store.onStatusChange(renderStatus);
  cleanups.push(unsub);

  // The "yes" list can be thousands of rows now — rendered incrementally (renderIncrementalList)
  // instead of all at once. Removing one item calls renderAll() again; preserving scrollTop +
  // rendered batch depth across that rebuild (rather than resetting to the top every time) is
  // the same approach used in review.ts, for the same reason: it is jarring mid-list.
  let itemsHandle: IncrementalListHandle | null = null;

  function renderItemsList(prods: Product[]): void {
    const previousCount = itemsHandle?.renderedCount();
    const scrollY = window.scrollY;
    itemsHandle?.destroy();
    itemsHandle = null;
    itemsEl.innerHTML = '';
    if (prods.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'prow-list';
    itemsEl.appendChild(list);
    itemsHandle = renderIncrementalList(list, prods, (p) => productRow(p, { control: 'remove', onChange: renderAll }), {
      initialCount: previousCount,
    });
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }

  function renderAll(): void {
    const skus = store.getYesSkusInOrder();
    const prods = store.products.filter((p) => store.getDecision(p.s) === 1);
    const groups = groupByCategory(prods) as Category[];
    const edited = prods.filter((p) => store.getOverride(p.s)).length;
    totalEl.textContent = `${skus.length} item${skus.length === 1 ? '' : 's'} ready`;
    editedSub.textContent = edited > 0 ? `${edited} product${edited === 1 ? '' : 's'} changed` : '';
    breakdownEl.innerHTML = '';
    for (const cat of groups) {
      const li = document.createElement('li');
      li.className = 'export-breakdown__row';
      const name = document.createElement('span');
      name.textContent = cat.name;
      const count = document.createElement('span');
      count.textContent = String(cat.items.length);
      li.append(name, count);
      breakdownEl.appendChild(li);
    }
    renderItemsList(prods);
    if (skus.length === 0) {
      window.location.hash = '#/';
    }
  }
  renderAll();

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError(): void {
    errorEl.hidden = true;
  }

  function setBuilding(building: boolean): void {
    buildBtn.disabled = building;
    buildBtn.textContent = building ? 'Making your file…' : 'Make my file';
  }

  let lastFile: { bytes: Uint8Array; filename: string } | null = null;

  async function handleBuild(): Promise<void> {
    hideError();
    successEl.hidden = true;
    shareBtn.hidden = true;
    setBuilding(true);
    try {
      await yieldToPaint(); // let "Making your file…" paint before the CPU-heavy work below
      const [rows, skeleton] = await Promise.all([fetchCatalogRows(), fetchCatalogSkeleton()]);
      // Fresh overrides (another device may have edited) merged over local unsent ones.
      let overrides: Record<string, { name?: string; size?: string; mrp?: string; price?: string }> = {};
      try {
        const server = await fetchOverrides();
        overrides = { ...server };
        for (const p of store.products) {
          const local = store.getOverride(p.s);
          if (local) overrides[p.s] = { ...local };
        }
      } catch {
        for (const p of store.products) {
          const local = store.getOverride(p.s);
          if (local) overrides[p.s] = { ...local };
        }
      }
      await yieldToPaint();
      const skus = store.getYesSkusInOrder();
      const fileBytes = buildWorkbook(skeleton, rows, skus, overrides) as Uint8Array;

      const base = stripExtension(store.catalog?.filename ?? 'catalog');
      const username = store.session?.username ?? 'user';
      const filename = `${base}-${username}-${formatYYYYMMDD(new Date())}.xlsx`;
      lastFile = { bytes: fileBytes, filename };
      triggerDownload(fileBytes, filename);

      successEl.textContent = `Your file is ready: ${filename} (${skus.length} item${skus.length === 1 ? '' : 's'}).`;
      successEl.hidden = false;
      // Share when the platform can take files (Android Chrome → WhatsApp/email without
      // ever opening the file manager); otherwise the download above is the path.
      try {
        const nav = navigator as Navigator & {
          canShare?: (data: { files: File[] }) => boolean;
          share?: (data: { files: File[]; title: string }) => Promise<void>;
        };
        const testFile = new File([new Uint8Array(fileBytes).buffer as ArrayBuffer], filename, {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        if (typeof nav.canShare === 'function' && nav.canShare({ files: [testFile] })) {
          shareBtn.hidden = false;
        }
      } catch {
        // Share unavailable — download already happened.
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not make the file. Try again.');
    } finally {
      setBuilding(false);
    }
  }

  async function handleShare(): Promise<void> {
    if (!lastFile) return;
    try {
      const nav = navigator as Navigator & {
        share?: (data: { files: File[]; title: string }) => Promise<void>;
      };
      const file = new File([new Uint8Array(lastFile.bytes).buffer as ArrayBuffer], lastFile.filename, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      if (typeof nav.share !== 'function') return;
      await nav.share({ files: [file], title: lastFile.filename });
    } catch (err) {
      // User dismissed the sheet — not an error. Real failures get a message.
      if (err instanceof Error && err.name !== 'AbortError') {
        showError('Could not open sharing. Your file is already saved on this phone.');
      }
    }
  }

  on(buildBtn, 'click', () => void handleBuild());
  on(shareBtn, 'click', () => void handleShare());
  on(backBtn, 'click', goBack);
  // Was a bare inline <a>: 17px tall, well under a thumb. A real button, thumb-sized.
  on(reviewBtn, 'click', () => {
    window.location.hash = '#/review';
  });

  return () => {
    itemsHandle?.destroy();
    for (const fn of cleanups) fn();
  };
}

// Explicit width/height: an <svg> with only a viewBox has no intrinsic size and renders at the
// UA default (300x150) otherwise.
const ICON_BACK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
