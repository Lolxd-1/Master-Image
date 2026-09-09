/**
 * Admin screen — SPEC.md §9.4 (admin part) plus the coordinator's streamed-upload amendment.
 *
 * Upload is 5 sequential requests (begin -> PUT products -> PUT rows -> PUT skeleton -> activate)
 * because the rows payload is multi-MB and the Worker must never JSON.parse it (10ms CPU cap).
 * The catalog only goes live on `activate`, so a failure at any earlier step leaves the previous
 * catalog untouched — that claim in the error message is always true given this flow.
 */

import { parseWorkbook, UploadError } from '../xlsx.js';
import {
  ApiError,
  activateCatalog,
  beginCatalogUpload,
  bytesToBase64,
  fetchProgress,
  putCatalogProducts,
  putCatalogRows,
  putCatalogSkeleton,
  type Product,
  type ProgressMap,
} from '../api';
import { store } from '../store';
import type { Cleanup } from '../main';

interface ParsedWorkbook {
  products: Product[];
  rows: Record<string, string>;
  skeleton: Uint8Array;
  sheetPath: string;
  emptyRowCount: number;
}

// Explicit width/height: an <svg> with only a viewBox has no intrinsic size and renders at the
// UA default (300x150) otherwise.
const ICON_BACK =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function runUpload(file: File, setStep: (label: string) => void): Promise<{ productCount: number }> {
  setStep('Reading your file…');
  await yieldToPaint();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseWorkbook(bytes) as ParsedWorkbook; // throws UploadError on a bad file

  setStep('Uploading products…');
  const { id } = await beginCatalogUpload(file.name, parsed.products.length);
  await putCatalogProducts(id, JSON.stringify(parsed.products));

  setStep('Uploading catalog data…');
  await putCatalogRows(id, JSON.stringify(parsed.rows));
  await putCatalogSkeleton(id, bytesToBase64(parsed.skeleton));

  setStep('Finishing…');
  const result = await activateCatalog(id);
  return { productCount: result.productCount };
}

export function mount(root: HTMLElement): Cleanup {
  const wrap = document.createElement('div');
  wrap.className = 'screen screen-admin';
  wrap.innerHTML = `
    <header class="export-topbar">
      <button type="button" class="icon-btn" data-action="back" aria-label="Back">${ICON_BACK}</button>
      <h1>Admin</h1>
    </header>
    <div class="admin-body">
      <section class="admin-card">
        <h2>Current catalog</h2>
        <p data-role="catalog-info"></p>
      </section>

      <section class="admin-card">
        <h2>Upload a new master sheet</h2>
        <p class="admin-warning">
          Uploading a new sheet replaces the live catalog for everyone. Store owners' existing
          choices are kept and matched by SKU ID.
        </p>
        <input type="file" accept=".xlsx" data-role="file-input" />
        <button type="button" class="btn btn-primary btn-lg" data-role="upload-btn">Upload &amp; replace catalog</button>
        <p class="admin-step" data-role="step" hidden></p>
        <p class="admin-error" role="alert" data-role="error" hidden></p>
      </section>

      <section class="admin-card">
        <div class="admin-card__header" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <h2>Store owner progress</h2>
          <button type="button" class="link-btn" data-action="refresh-progress">Refresh</button>
        </div>
        <table class="admin-table">
          <thead><tr><th>User</th><th>Decided</th><th>Yes</th><th>Progress</th></tr></thead>
          <tbody data-role="progress-body"></tbody>
        </table>
      </section>
    </div>
  `;
  root.appendChild(wrap);

  const catalogInfoEl = wrap.querySelector('[data-role="catalog-info"]') as HTMLElement;
  const fileInput = wrap.querySelector('[data-role="file-input"]') as HTMLInputElement;
  const uploadBtn = wrap.querySelector('[data-role="upload-btn"]') as HTMLButtonElement;
  const stepEl = wrap.querySelector('[data-role="step"]') as HTMLElement;
  const errorEl = wrap.querySelector('[data-role="error"]') as HTMLElement;
  const progressBody = wrap.querySelector('[data-role="progress-body"]') as HTMLElement;
  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;
  const refreshBtn = wrap.querySelector('[data-action="refresh-progress"]') as HTMLButtonElement;

  function renderCatalogInfo(): void {
    const c = store.catalog;
    if (!c) {
      catalogInfoEl.textContent = 'No catalog uploaded yet.';
      return;
    }
    const uploaded = new Date(c.uploadedAt).toLocaleString('en-IN');
    catalogInfoEl.textContent = `${c.filename} — ${c.productCount} products — uploaded ${uploaded}`;
  }

  function hideMessages(): void {
    stepEl.hidden = true;
    errorEl.hidden = true;
  }

  function setStep(label: string): void {
    stepEl.textContent = label;
    stepEl.hidden = false;
  }

  function showError(message: string): void {
    stepEl.hidden = true;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function setBusy(busy: boolean): void {
    fileInput.disabled = busy;
    uploadBtn.disabled = busy;
  }

  async function loadProgress(): Promise<void> {
    progressBody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
    try {
      const progress = await fetchProgress();
      renderProgressTable(progress);
    } catch (err) {
      progressBody.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = err instanceof Error ? err.message : 'Could not load progress.';
      tr.appendChild(td);
      progressBody.appendChild(tr);
    }
  }

  function renderProgressTable(progress: ProgressMap): void {
    progressBody.innerHTML = '';
    const usernames = Object.keys(progress).sort();
    if (usernames.length === 0) {
      progressBody.innerHTML = '<tr><td colspan="4">No users yet.</td></tr>';
      return;
    }
    for (const username of usernames) {
      const entry = progress[username];
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = username;

      const decidedTd = document.createElement('td');
      decidedTd.textContent = `${entry.decided} / ${entry.total}`;

      const yesTd = document.createElement('td');
      yesTd.textContent = String(entry.yes);

      const barTd = document.createElement('td');
      const barOuter = document.createElement('div');
      barOuter.className = 'progress-bar';
      const barFill = document.createElement('div');
      barFill.className = 'progress-bar__fill';
      // decided can exceed total when a re-upload shrinks the catalog — clamp the bar, but the
      // text above still shows the raw numbers as returned.
      const pct = entry.total > 0 ? Math.min(100, (entry.decided / entry.total) * 100) : 0;
      barFill.style.width = `${pct}%`;
      barOuter.appendChild(barFill);
      barTd.appendChild(barOuter);

      tr.append(nameTd, decidedTd, yesTd, barTd);
      progressBody.appendChild(tr);
    }
  }

  async function handleUpload(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) {
      showError('Choose a .xlsx file first.');
      return;
    }
    hideMessages();
    setBusy(true);
    try {
      const { productCount } = await runUpload(file, setStep);
      setStep(`Uploaded "${file.name}" — ${productCount} products are now live.`);
      await store.reloadCatalog();
      renderCatalogInfo();
      void loadProgress();
      fileInput.value = '';
    } catch (err) {
      const failedAt = stepEl.textContent || 'the upload';
      if (err instanceof UploadError) {
        showError(err.message);
      } else if (err instanceof ApiError) {
        showError(`Failed while ${failedAt} — ${err.message}. The previous catalog is still live; nothing changed for store owners.`);
      } else {
        showError(`Failed while ${failedAt} — check your connection and try again. The previous catalog is still live; nothing changed for store owners.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const onUploadClick = (): void => void handleUpload();
  uploadBtn.addEventListener('click', onUploadClick);

  const goBack = (): void => {
    window.location.hash = '#/';
  };
  backBtn.addEventListener('click', goBack);

  const onRefresh = (): void => void loadProgress();
  refreshBtn.addEventListener('click', onRefresh);

  renderCatalogInfo();
  void loadProgress();

  return () => {
    uploadBtn.removeEventListener('click', onUploadClick);
    backBtn.removeEventListener('click', goBack);
    refreshBtn.removeEventListener('click', onRefresh);
  };
}
