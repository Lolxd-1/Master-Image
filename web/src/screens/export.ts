/**
 * Export screen — SPEC.md §9.4 and the export algorithm in §8.
 *
 * The file itself is built entirely client-side via `buildWorkbook` from xlsx.js: fetch the
 * skeleton + row XML, hand it the selected SKUs in original catalog order, and it splices the
 * kept rows back into an otherwise byte-identical copy of the source workbook. Nothing here
 * touches XLSX internals directly.
 */

import { buildWorkbook, groupByCategory } from '../xlsx.js';
import { fetchCatalogRows, fetchCatalogSkeleton } from '../api';
import { store, type Category } from '../store';
import type { Cleanup } from '../main';

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

  const goBack = (): void => {
    window.location.hash = '#/';
  };

  const yesSkus = store.getYesSkusInOrder();

  if (yesSkus.length === 0) {
    wrap.innerHTML = `
      <header class="export-topbar"><button type="button" class="icon-btn" data-action="back" aria-label="Back">${ICON_BACK}</button></header>
      <div class="export-empty">
        <h1>Nothing to download yet</h1>
        <p>Mark at least one product "Stock it" in the category grid, then come back here.</p>
        <button type="button" class="btn btn-primary btn-lg" data-action="back-cta">Back to categories</button>
      </div>
    `;
    root.appendChild(wrap);
    const back1 = wrap.querySelector('[data-action="back"]');
    const back2 = wrap.querySelector('[data-action="back-cta"]');
    back1?.addEventListener('click', goBack);
    back2?.addEventListener('click', goBack);
    return () => {
      back1?.removeEventListener('click', goBack);
      back2?.removeEventListener('click', goBack);
    };
  }

  const yesProducts = store.products.filter((p) => store.getDecision(p.s) === 1);
  const grouped = groupByCategory(yesProducts) as Category[];

  wrap.innerHTML = `
    <header class="export-topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back">${ICON_BACK}</button>
      <h1>Download my list</h1>
    </header>
    <div class="export-body">
      <p class="export-total">${yesSkus.length} item${yesSkus.length === 1 ? '' : 's'} to export</p>
      <ul class="export-breakdown" data-role="breakdown"></ul>
      <p class="export-error" role="alert" hidden></p>
      <button type="button" class="btn btn-primary btn-lg export-build-btn" data-role="build-btn">
        Build &amp; download file
      </button>
      <p class="export-note">Upload this file to Amazon SmartBiz without opening it.</p>
    </div>
  `;
  root.appendChild(wrap);

  const breakdownEl = wrap.querySelector('[data-role="breakdown"]') as HTMLElement;
  for (const cat of grouped) {
    const li = document.createElement('li');
    li.className = 'export-breakdown__row';
    const name = document.createElement('span');
    name.textContent = cat.name;
    const count = document.createElement('span');
    count.textContent = String(cat.items.length);
    li.append(name, count);
    breakdownEl.appendChild(li);
  }

  const buildBtn = wrap.querySelector('[data-role="build-btn"]') as HTMLButtonElement;
  const errorEl = wrap.querySelector('.export-error') as HTMLElement;
  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError(): void {
    errorEl.hidden = true;
  }

  function setBuilding(building: boolean): void {
    buildBtn.disabled = building;
    buildBtn.textContent = building ? 'Building your file…' : 'Build & download file';
  }

  async function handleBuild(): Promise<void> {
    hideError();
    setBuilding(true);
    try {
      await yieldToPaint(); // let "Building your file…" paint before the CPU-heavy work below
      const [rows, skeleton] = await Promise.all([fetchCatalogRows(), fetchCatalogSkeleton()]);
      await yieldToPaint();
      const fileBytes = buildWorkbook(skeleton, rows, yesSkus) as Uint8Array;

      const base = stripExtension(store.catalog?.filename ?? 'catalog');
      const username = store.session?.username ?? 'user';
      const filename = `${base}-${username}-${formatYYYYMMDD(new Date())}.xlsx`;
      triggerDownload(fileBytes, filename);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Could not build the file. Please try again.');
    } finally {
      setBuilding(false);
    }
  }

  const onBuildClick = (): void => void handleBuild();
  buildBtn.addEventListener('click', onBuildClick);
  backBtn.addEventListener('click', goBack);

  return () => {
    buildBtn.removeEventListener('click', onBuildClick);
    backBtn.removeEventListener('click', goBack);
  };
}

// Explicit width/height: an <svg> with only a viewBox has no intrinsic size and renders at the
// UA default (300x150) otherwise.
const ICON_BACK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
