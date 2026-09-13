/**
 * Admin screen — SPEC.md §8.8 (production v2, Phase 4).
 *
 * Styled upload (drop zone + filename + BYTE progress on the multi-MB PUTs via XHR
 * upload events — fetch has no upload progress), 5-step labels with activate-last
 * reassurance, catalog card (file/count/who/when), per-user table (stocked / not /
 * left / last active / bar + download-that-user's-file), starter-password warning.
 */

import { parseWorkbook, buildWorkbook, UploadError } from '../xlsx.js';
import {
  ApiError,
  activateCatalog,
  beginCatalogUpload,
  bytesToBase64,
  fetchDecisions,
  fetchCatalogRows,
  fetchCatalogSkeleton,
  fetchOverrides,
  fetchProgress,
  putCatalogProducts,
  putCatalogRows,
  putCatalogSkeleton,
  type Product,
  type ProgressMap,
} from '../api';
import { store } from '../store';
import type { Cleanup } from '../main';
import { confirmDialog } from '../ui';

const ADMIN_TABLE_COLUMNS = 7;

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

/** XHR PUT with upload byte progress (fetch cannot report upload progress). */
function putWithProgress(url: string, body: string, onProgress: (sent: number, total: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'text/plain; charset=utf-8');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `Upload failed (${xhr.status}).`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // keep default
        }
        reject(new ApiError(msg, xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error('Could not reach the server. Check your connection.'));
    xhr.send(body);
  });
}

async function runUpload(
  file: File,
  setStep: (label: string) => void,
  setBytes: (sent: number, total: number) => void,
): Promise<{ productCount: number }> {
  setStep('Reading your file…');
  await yieldToPaint();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseWorkbook(bytes) as ParsedWorkbook; // throws UploadError on a bad file

  setStep('Uploading products…');
  const { id } = await beginCatalogUpload(file.name, parsed.products.length);
  await putCatalogProducts(id, JSON.stringify(parsed.products));

  setStep('Uploading catalog data…');
  const rowsJson = JSON.stringify(parsed.rows);
  await putWithProgress(`/api/catalog/${id}/rows`, rowsJson, setBytes);
  const skelB64 = bytesToBase64(parsed.skeleton);
  await putWithProgress(`/api/catalog/${id}/skeleton`, skelB64, setBytes);

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
        <h2>Current list</h2>
        <p data-role="catalog-info"></p>
      </section>

      <section class="admin-card">
        <h2>Upload a new master sheet</h2>
        <p class="admin-warning">
          Uploading a new sheet replaces the live list for everyone. Shop owners' choices
          and price fixes are kept and matched by product ID. If anything fails, the
          previous list stays live — nothing changes for shop owners.
        </p>
        <label class="admin-drop" data-role="drop">
          <span data-role="drop-label">Choose the master sheet (.xlsx)</span>
          <input type="file" accept=".xlsx" data-role="file-input" />
        </label>
        <div class="admin-progress" data-role="byte-bar" hidden>
          <div class="admin-progress__fill" data-role="byte-fill"></div>
        </div>
        <button type="button" class="btn btn-primary btn-lg" data-role="upload-btn">Upload &amp; replace list</button>
        <p class="admin-step" data-role="step" hidden></p>
        <p class="admin-error" role="alert" data-role="error" hidden></p>
      </section>

      <section class="admin-card">
        <div class="admin-card__header">
          <h2>Shop owners</h2>
          <button type="button" class="link-btn" data-action="refresh-progress">Refresh</button>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Shop</th><th>Yes</th><th>No</th><th>Left</th><th>Progress</th><th>Last active</th><th>File</th></tr>
            </thead>
            <tbody data-role="progress-body"></tbody>
          </table>
        </div>
      </section>

      <section class="admin-card">
        <h2>Passwords</h2>
        <p class="admin-warning">If you still use the starter passwords from setup, change them now:
        run <code>npm run user:add</code> and redeploy. Never share your admin login.</p>
      </section>
    </div>
  `;
  root.appendChild(wrap);

  const catalogInfoEl = wrap.querySelector('[data-role="catalog-info"]') as HTMLElement;
  const dropZone = wrap.querySelector('[data-role="drop"]') as HTMLElement;
  const fileInput = wrap.querySelector('[data-role="file-input"]') as HTMLInputElement;
  const dropLabel = wrap.querySelector('[data-role="drop-label"]') as HTMLElement;
  const uploadBtn = wrap.querySelector('[data-role="upload-btn"]') as HTMLButtonElement;
  const stepEl = wrap.querySelector('[data-role="step"]') as HTMLElement;
  const errorEl = wrap.querySelector('[data-role="error"]') as HTMLElement;
  const progressBody = wrap.querySelector('[data-role="progress-body"]') as HTMLElement;
  const backBtn = wrap.querySelector('[data-action="back"]') as HTMLButtonElement;
  const refreshBtn = wrap.querySelector('[data-action="refresh-progress"]') as HTMLButtonElement;
  const byteBar = wrap.querySelector('[data-role="byte-bar"]') as HTMLElement;
  const byteFill = wrap.querySelector('[data-role="byte-fill"]') as HTMLElement;

  // Tracked separately from fileInput.files: assigning a dropped FileList to an <input>
  // programmatically is not reliable everywhere, so the chosen file is the source of truth
  // and fileInput.files is treated as a fallback rather than the only path.
  let chosenFile: File | null = null;

  function setChosenFile(f: File | null): void {
    chosenFile = f;
    dropLabel.textContent = f ? `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)` : 'Choose the master sheet (.xlsx)';
    uploadBtn.disabled = !f;
  }
  setChosenFile(null);

  function renderCatalogInfo(): void {
    const c = store.catalog;
    if (!c) {
      catalogInfoEl.textContent = 'No list uploaded yet.';
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

  function setBytes(sent: number, total: number): void {
    byteBar.hidden = false;
    byteFill.style.width = `${total > 0 ? Math.min(100, (sent / total) * 100) : 0}%`;
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

  /**
   * `GET /api/progress` counts every `decision` row a user has, and decisions are keyed by
   * (username, sku) on purpose so they survive a catalog re-upload (SPEC §6). A shop that
   * decided products in an older catalog therefore carries rows whose SKUs are no longer in
   * the live list, and the raw count can exceed the catalog size — the table then invents
   * "no" decisions nobody made. The worker cannot filter them: the SKU list lives in KV and
   * parsing it per request would blow the 10 ms CPU budget.
   *
   * So recount here, the same way `store.ts` does everywhere else: walk the live products and
   * look each SKU up, never the other way round. One extra request per shop, on a screen only
   * the admin opens.
   */
  async function accurateProgress(raw: ProgressMap): Promise<ProgressMap> {
    const total = store.products.length;
    if (total === 0) return raw;
    const usernames = Object.keys(raw);
    const recounted = await Promise.all(
      usernames.map(async (username) => {
        try {
          const decisions = await fetchDecisions(username);
          let decided = 0;
          let yes = 0;
          for (const p of store.products) {
            const v = decisions[p.s];
            if (v === undefined) continue;
            decided++;
            if (v === 1) yes++;
          }
          return [username, { decided, yes, total, lastActive: raw[username].lastActive }] as const;
        } catch {
          // Fall back to the server's figure for this shop rather than blanking the row.
          return [username, raw[username]] as const;
        }
      }),
    );
    return Object.fromEntries(recounted);
  }

  async function loadProgress(): Promise<void> {
    progressBody.innerHTML = `<tr><td colspan="${ADMIN_TABLE_COLUMNS}">Loading…</td></tr>`;
    try {
      const progress = await accurateProgress(await fetchProgress());
      renderProgressTable(progress);
    } catch (err) {
      progressBody.innerHTML = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = ADMIN_TABLE_COLUMNS;
      td.textContent = err instanceof Error ? err.message : 'Could not load progress.';
      tr.appendChild(td);
      progressBody.appendChild(tr);
    }
  }

  function fmtLastActive(ts: number | null): string {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = Date.now();
    const days = Math.floor((now - ts) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString('en-IN');
  }

  function renderProgressTable(progress: ProgressMap): void {
    progressBody.innerHTML = '';
    const usernames = Object.keys(progress).sort();
    if (usernames.length === 0) {
      progressBody.innerHTML = `<tr><td colspan="${ADMIN_TABLE_COLUMNS}">No shops yet.</td></tr>`;
      return;
    }
    for (const username of usernames) {
      const entry = progress[username];
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = username;

      const yesTd = document.createElement('td');
      yesTd.textContent = String(entry.yes);

      const noTd = document.createElement('td');
      const no = Math.max(0, entry.decided - entry.yes);
      noTd.textContent = String(no);

      const leftTd = document.createElement('td');
      leftTd.textContent = String(Math.max(0, entry.total - entry.decided));

      const progressTd = document.createElement('td');
      const pct = entry.total > 0 ? Math.min(100, (entry.decided / entry.total) * 100) : 0;
      const bar = document.createElement('div');
      bar.className = 'progress-bar admin-table__bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-label', `${entry.decided} of ${entry.total} checked`);
      const fill = document.createElement('div');
      fill.className = 'progress-bar__fill';
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      progressTd.appendChild(bar);

      const activeTd = document.createElement('td');
      activeTd.textContent = fmtLastActive(entry.lastActive);

      const fileTd = document.createElement('td');
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'link-btn';
      dl.textContent = 'File';
      dl.setAttribute('aria-label', `Download ${username}'s file`);
      dl.disabled = entry.yes < 1;
      dl.addEventListener('click', () => void downloadUserFile(username, dl));
      fileTd.appendChild(dl);

      tr.append(nameTd, yesTd, noTd, leftTd, progressTd, activeTd, fileTd);
      progressBody.appendChild(tr);
    }
  }

  async function downloadUserFile(username: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const [decisions, overrides, rows, skeleton] = await Promise.all([
        fetchDecisions(username),
        fetchOverrides(username),
        fetchCatalogRows(),
        fetchCatalogSkeleton(),
      ]);
      const skus: string[] = [];
      for (const p of store.products) {
        if (decisions[p.s] === 1) skus.push(p.s);
      }
      if (skus.length === 0) return;
      const fileBytes = buildWorkbook(skeleton, rows, skus, overrides) as Uint8Array;
      const blob = new Blob([new Uint8Array(fileBytes).buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const base = (store.catalog?.filename ?? 'catalog').replace(/\.[^.]+$/, '');
      a.href = url;
      a.download = `${base}-${username}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      showError(err instanceof Error ? err.message : `Could not build ${username}'s file.`);
    } finally {
      btn.disabled = false;
    }
  }

  async function handleUpload(): Promise<void> {
    const file = chosenFile ?? fileInput.files?.[0] ?? null;
    if (!file) {
      showError('Choose a .xlsx file first.');
      return;
    }
    // Replacing the live catalog affects every shopkeeper — gate it behind a confirm that
    // names the file and the current live count, so this can never be a stray tap.
    const liveCount = store.catalog?.productCount ?? 0;
    const ok = await confirmDialog({
      title: 'Replace the live list?',
      body:
        `Replaces the live list for everyone. Their choices and price fixes are kept and ` +
        `matched by product ID.\n\n“${file.name}” will replace the current live list of ` +
        `${liveCount.toLocaleString('en-IN')} product${liveCount === 1 ? '' : 's'}.`,
      confirmLabel: 'Replace list',
    });
    if (!ok) return;

    hideMessages();
    byteBar.hidden = true;
    byteFill.style.width = '0%';
    setBusy(true);
    try {
      const { productCount } = await runUpload(file, setStep, setBytes);
      setStep(`Uploaded "${file.name}" — ${productCount} products are now live. Choices and fixes were kept.`);
      await store.reloadCatalog();
      renderCatalogInfo();
      void loadProgress();
      fileInput.value = '';
      setChosenFile(null);
    } catch (err) {
      const failedAt = stepEl.textContent || 'the upload';
      if (err instanceof UploadError) {
        showError(err.message);
      } else if (err instanceof ApiError) {
        showError(`Failed while ${failedAt} — ${err.message}. The previous list is still live.`);
      } else {
        showError(`Failed while ${failedAt} — check your connection and try again. The previous list is still live.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const onUploadClick = (): void => void handleUpload();
  uploadBtn.addEventListener('click', onUploadClick);
  fileInput.addEventListener('change', () => {
    setChosenFile(fileInput.files?.[0] ?? null);
  });

  // Real drag-and-drop target, in addition to the native file picker via the <label>.
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    dropZone.classList.add('admin-drop--hover');
  };
  const onDragLeave = (): void => {
    dropZone.classList.remove('admin-drop--hover');
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    dropZone.classList.remove('admin-drop--hover');
    const dt = e.dataTransfer;
    const f = dt?.files?.[0] ?? null;
    if (!dt || !f) return;
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      showError('Choose a .xlsx file.');
      return;
    }
    try {
      fileInput.files = dt.files;
    } catch {
      // Some browsers refuse programmatic FileList assignment — chosenFile still carries it.
    }
    setChosenFile(f);
  };
  dropZone.addEventListener('dragover', onDragOver);
  dropZone.addEventListener('dragleave', onDragLeave);
  dropZone.addEventListener('drop', onDrop);

  const goBack = (): void => {
    window.location.hash = '#/';
  };
  backBtn.addEventListener('click', goBack);

  const onRefresh = (): void => void loadProgress();
  refreshBtn.addEventListener('click', onRefresh);

  // putCatalogRows/putCatalogSkeleton imported for compat; large PUTs go through XHR progress above.
  void putCatalogRows;
  void putCatalogSkeleton;

  renderCatalogInfo();
  void loadProgress();

  return () => {
    uploadBtn.removeEventListener('click', onUploadClick);
    backBtn.removeEventListener('click', goBack);
    refreshBtn.removeEventListener('click', onRefresh);
    dropZone.removeEventListener('dragover', onDragOver);
    dropZone.removeEventListener('dragleave', onDragLeave);
    dropZone.removeEventListener('drop', onDrop);
  };
}
