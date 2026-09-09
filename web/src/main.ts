/**
 * Bootstrap + hash router + screen switching.
 *
 * Routes: #/login, #/ (category grid), #/deck/<category>, #/export, #/admin.
 * Auth gate: unauthenticated users are bounced to #/login; the admin route is bounced home for
 * non-admins. Everything else about "what a screen does" lives in web/src/screens/*.
 */

import { store } from './store';
import { mount as mountLogin } from './screens/login';
import { mount as mountCategories } from './screens/categories';
import { mount as mountDeck } from './screens/deck';
import { mount as mountExport } from './screens/export';
import { mount as mountAdmin } from './screens/admin';

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
  activeCleanup = mount(root);
}

function renderBootState(message: string, showRetry: boolean): void {
  root.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'boot-state';

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
  // Deck/export need products, so bounce them home instead of showing
  // confusing "not found / nothing to download" screens.
  if (store.catalog === null) {
    if (seg === 'deck' || seg === 'export') {
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

  if (seg !== '' && seg !== 'categories') {
    window.location.hash = '#/';
    return;
  }
  swap(mountCategories);
}

async function boot(): Promise<void> {
  renderBootState('Loading your catalog…', false);
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
