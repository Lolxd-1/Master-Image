/**
 * Bootstrap + hash router + screen switching.
 *
 * Routes: #/login, #/ (category grid), #/deck/<category>, #/review[/<category>],
 * #/export, #/admin. Auth gate: unauthenticated users are bounced to #/login (with
 * a post-login return); the admin route is bounced home for non-admins. Unknown
 * routes explain themselves instead of silently bouncing (AUDIT D-26).
 */

import { store } from './store';
import { mount as mountLogin } from './screens/login';
import { mount as mountCategories } from './screens/categories';
import { mount as mountDeck } from './screens/deck';
import { mount as mountExport } from './screens/export';
import { mount as mountAdmin } from './screens/admin';
import { mount as mountReview } from './screens/review';

export type Cleanup = () => void;
export type ScreenMount = (root: HTMLElement) => Cleanup;

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('index.html is missing <div id="app">.');
const root: HTMLElement = rootEl;

let activeCleanup: Cleanup | null = null;

function swap(mount: ScreenMount): void {
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  root.innerHTML = '';
  try {
    activeCleanup = mount(root);
  } catch (err) {
    activeCleanup = null;
    renderScreenError(err);
  }
}

/**
 * A screen that throws during mount used to leave a blank white page with no way out.
 * This is the recoverable fallback: what happened, a way to retry the same route, and a
 * way back to the one screen that should always work.
 */
function renderScreenError(err: unknown): void {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'export-empty';
  const h = document.createElement('h1');
  h.textContent = 'Something went wrong';
  const p = document.createElement('p');
  p.textContent =
    err instanceof Error && err.message ? err.message : 'This screen hit a problem while loading.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-primary btn-lg';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => route());
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-lg';
  back.textContent = 'Back to products';
  back.addEventListener('click', () => {
    if (window.location.hash === '#/' || window.location.hash === '') {
      route(); // already on home — a hash write here would not fire hashchange
    } else {
      window.location.hash = '#/';
    }
  });
  wrap.append(h, p, retry, back);
  root.appendChild(wrap);
}

function renderBootState(message: string, showRetry: boolean): void {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'boot-state';

  // Skeleton (not a bare text line) so a slow first load never looks broken.
  const skel = document.createElement('div');
  skel.className = 'boot-skeleton';
  skel.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) {
    const line = document.createElement('div');
    line.className = 'boot-skeleton__line';
    line.style.width = `${90 - i * 12}%`;
    skel.appendChild(line);
  }
  wrap.appendChild(skel);

  const p = document.createElement('p');
  p.textContent = message;
  wrap.appendChild(p);

  if (showRetry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-primary';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void boot());
    wrap.appendChild(retry);
  }

  root.appendChild(wrap);
}

function renderUnknown(path: string): void {
  root.innerHTML = '';
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  const wrap = document.createElement('div');
  wrap.className = 'export-empty';
  const h = document.createElement('h1');
  h.textContent = 'That link does not exist';
  const p = document.createElement('p');
  p.textContent = `“${path}” is not a page in this app. Your work is safe.`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary btn-lg';
  btn.textContent = 'Back to products';
  btn.addEventListener('click', () => {
    window.location.hash = '#/';
  });
  wrap.append(h, p, btn);
  root.appendChild(wrap);
}

/** Splits "#/deck/Some%20Category" into { seg: "deck", rest: "Some%20Category" }. */
function parseHash(hash: string): { seg: string; rest: string } {
  const clean = hash.replace(/^#\/?/, '');
  const slashAt = clean.indexOf('/');
  if (slashAt === -1) return { seg: clean, rest: '' };
  return { seg: clean.slice(0, slashAt), rest: clean.slice(slashAt + 1) };
}

function route(): void {
  const { seg, rest } = parseHash(window.location.hash);
  const isLoggedIn = store.session !== null;

  if (!isLoggedIn) {
    if (seg !== 'login') {
      // Remember where they were going (e.g. session expired mid-session): after login
      // they land back there, and the outbox in localStorage means no work is lost.
      try {
        sessionStorage.setItem('sp:post-login-next', window.location.hash || '#/');
      } catch {
        // ignore
      }
      window.location.hash = '#/login';
      return;
    }
    swap(mountLogin);
    return;
  }

  if (seg === 'login') {
    window.location.hash = '#/'; // already logged in — never show the login screen again
    return;
  }

  if (seg === 'admin') {
    if (store.session?.role !== 'admin') {
      window.location.hash = '#/';
      return;
    }
    swap(mountAdmin);
    return;
  }

  // No live catalog yet: admin uploads from #/admin, pickers wait on home.
  // Deck/export/review need products, so bounce them home instead of showing
  // confusing "not found / nothing to download" screens.
  if (store.catalog === null) {
    if (seg === 'deck' || seg === 'export' || seg === 'review') {
      window.location.hash = '#/';
      return;
    }
  }

  if (seg === 'deck') {
    const category = decodeURIComponent(rest);
    swap((r) => mountDeck(r, category));
    return;
  }

  if (seg === 'export') {
    swap(mountExport);
    return;
  }

  if (seg === 'review') {
    const category = rest ? decodeURIComponent(rest) : undefined;
    swap((r) => mountReview(r, category));
    return;
  }

  if (seg !== '' && seg !== 'categories') {
    renderUnknown(window.location.hash);
    return;
  }
  swap(mountCategories);
}

async function boot(): Promise<void> {
  renderBootState('Loading your list…', false);
  try {
    await store.bootstrap();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong loading the app.';
    renderBootState(message, true);
    return;
  }
  window.addEventListener('hashchange', route);
  route();
}

void boot();
