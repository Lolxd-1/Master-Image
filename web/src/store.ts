/**
 * App state: session, catalog, products, decisions, and the offline outbox — SPEC.md §9.5.
 *
 * The persistence rule that shapes this whole file: a decision is written to `localStorage`
 * synchronously, before anything async happens. The UI reads that write back immediately and
 * never waits on the network. A debounced background loop drains a durable outbox to
 * `POST /api/decisions`, batched and retried with backoff. All of that state survives a reload
 * because the outbox itself is the thing sitting in `localStorage`, not just an in-memory queue.
 *
 * Decisions are keyed server-side by `(username, sku)`, not by catalog — a re-uploaded catalog
 * can leave stale SKUs in `GET /api/decisions` that no longer exist in `products`. Every derived
 * count in this file (`overallDecided`, `overallYes`, `getYesSkusInOrder`, `categoryProgress`)
 * walks `products` and looks up `decisions` by SKU — never the other way around — so those stale
 * entries are silently ignored everywhere it matters, export included.
 */

import {
  ApiError,
  fetchCatalogMeta,
  fetchCatalogProducts,
  fetchDecisions,
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  postDecisions,
  type CatalogMeta,
  type DecisionItem,
  type DecisionValue,
  type Product,
  type Session,
} from './api';
import { groupByCategory } from './xlsx.js';

export type SyncStatus = 'saving' | 'saved' | 'offline';

export interface Category {
  readonly name: string;
  readonly items: Product[];
}

const FLUSH_DEBOUNCE_MS = 1000;
const FLUSH_BASE_DELAY_MS = 1000;
const FLUSH_MAX_DELAY_MS = 30000;
const MAX_BATCH = 500;
const LS_PREFIX = 'sp:';

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // storage disabled, full, or the value was corrupt JSON — cache misses are safe
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled (private browsing). The app still works; it just
    // starts cold next time instead of from cache.
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    // ignore
  }
}

class Store {
  session: Session | null = null;
  catalog: CatalogMeta | null = null;
  products: Product[] = [];
  categories: Category[] = [];

  private decisions = new Map<string, DecisionValue>();
  private outbox = new Map<string, DecisionValue>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay = FLUSH_BASE_DELAY_MS;
  private flushing = false;
  private status: SyncStatus = 'saved';
  private statusListeners = new Set<(status: SyncStatus) => void>();

  /** Called once by main.ts on app load. Populates session, catalog, products and decisions. */
  async bootstrap(): Promise<void> {
    const cachedSession = lsGet<Session>('session');
    let session: Session | null;
    try {
      session = await fetchMe();
    } catch (err) {
      if (!cachedSession) throw err; // nothing to fall back to — let main.ts show a retry screen
      session = cachedSession;
      this.setStatus('offline');
    }

    if (!session) {
      this.session = null;
      lsRemove('session');
      return; // main.ts routes to the login screen
    }

    this.session = session;
    lsSet('session', session);

    await this.loadCatalogAndProducts();
    await this.loadDecisions();
  }

  async login(username: string, password: string): Promise<void> {
    const session = await apiLogin(username, password); // throws on bad credentials / network
    this.session = session;
    lsSet('session', session);
    await this.loadCatalogAndProducts();
    await this.loadDecisions();
  }

  async logout(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await apiLogout();
    } finally {
      this.session = null;
      this.catalog = null;
      this.products = [];
      this.categories = [];
      this.decisions = new Map();
      this.outbox = new Map();
      this.flushDelay = FLUSH_BASE_DELAY_MS;
      this.flushing = false;
      lsRemove('session');
      this.setStatus('saved');
    }
  }

  /** Re-reads the live catalog. Used by admin.ts right after a successful upload+activate. */
  async reloadCatalog(): Promise<void> {
    await this.loadCatalogAndProducts();
    await this.loadDecisions();
  }

  private async loadCatalogAndProducts(): Promise<void> {
    const cachedMeta = lsGet<CatalogMeta>('catalogMeta');

    let meta: CatalogMeta;
    try {
      meta = await fetchCatalogMeta();
    } catch (err) {
      // No catalog on the server is authoritative (not offline): allow the app to boot
      // with an empty catalog so admin can reach the upload screen. Without this,
      // the first-ever upload is impossible — bootstrap/login throw before #/admin.
      if (err instanceof ApiError && err.status === 404) {
        this.catalog = null;
        this.setProducts([]);
        lsRemove('catalogMeta');
        if (cachedMeta) lsRemove(`products.${cachedMeta.id}`);
        return;
      }
      // Offline (or the server is unreachable) on a return visit: fall back to whatever we
      // cached last time rather than showing an empty app.
      if (cachedMeta) {
        const cachedProducts = lsGet<Product[]>(`products.${cachedMeta.id}`);
        if (cachedProducts && cachedProducts.length > 0) {
          this.catalog = cachedMeta;
          this.setProducts(cachedProducts);
          this.setStatus('offline');
          return;
        }
      }
      throw err;
    }

    this.catalog = meta;
    lsSet('catalogMeta', meta);

    if (cachedMeta && cachedMeta.id === meta.id) {
      const cachedProducts = lsGet<Product[]>(`products.${meta.id}`);
      if (cachedProducts && cachedProducts.length > 0) {
        this.setProducts(cachedProducts);
        return;
      }
    }

    try {
      const products = await fetchCatalogProducts();
      this.setProducts(products);
      lsSet(`products.${meta.id}`, products);
      if (cachedMeta && cachedMeta.id !== meta.id) lsRemove(`products.${cachedMeta.id}`);
    } catch (err) {
      if (cachedMeta && cachedMeta.id === meta.id) {
        const cachedProducts = lsGet<Product[]>(`products.${meta.id}`);
        if (cachedProducts && cachedProducts.length > 0) {
          this.setProducts(cachedProducts);
          this.setStatus('offline');
          return;
        }
      }
      throw err;
    }
  }

  private setProducts(products: Product[]): void {
    this.products = products;
    this.categories = groupByCategory(products) as Category[];
  }

  private async loadDecisions(): Promise<void> {
    const username = this.requireSession().username;

    const localOutbox = lsGet<Record<string, DecisionValue>>(`outbox.${username}`) ?? {};
    this.outbox = new Map(Object.entries(localOutbox) as [string, DecisionValue][]);

    let server: Record<string, DecisionValue>;
    try {
      server = await fetchDecisions();
    } catch {
      server = lsGet<Record<string, DecisionValue>>(`decisions.${username}`) ?? {};
      this.setStatus('offline');
    }

    const merged = new Map<string, DecisionValue>(Object.entries(server) as [string, DecisionValue][]);
    for (const [sku, value] of this.outbox) merged.set(sku, value); // local unsent wins
    this.decisions = merged;
    this.persistDecisions();

    if (this.outbox.size > 0) this.scheduleFlush(0);
  }

  private requireSession(): Session {
    if (!this.session) throw new Error('Store method used before login.');
    return this.session;
  }

  /* -------------------------------------------------------------- decisions */

  getDecision(sku: string): DecisionValue | undefined {
    return this.decisions.get(sku);
  }

  setDecision(sku: string, value: DecisionValue): void {
    this.decisions.set(sku, value);
    this.outbox.set(sku, value);
    this.persistDecisions();
    this.persistOutbox();
    this.setStatus('saving');
    this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  /** Undo: back to "undecided" locally, and drop it from the outbox if it hadn't shipped yet. */
  clearDecision(sku: string): void {
    this.decisions.delete(sku);
    this.outbox.delete(sku);
    this.persistDecisions();
    this.persistOutbox();
  }

  /** Decided count across the whole catalog (yes + no), ignoring decisions for unknown SKUs. */
  get overallDecided(): number {
    let n = 0;
    for (const p of this.products) if (this.decisions.has(p.s)) n++;
    return n;
  }

  get overallTotal(): number {
    return this.products.length;
  }

  get overallYes(): number {
    let n = 0;
    for (const p of this.products) if (this.decisions.get(p.s) === 1) n++;
    return n;
  }

  /** For export: yes-SKUs in original catalog order. Walks `products`, never `decisions`. */
  getYesSkusInOrder(): string[] {
    const out: string[] = [];
    for (const p of this.products) if (this.decisions.get(p.s) === 1) out.push(p.s);
    return out;
  }

  categoryProgress(items: readonly Product[]): { done: number; total: number } {
    let done = 0;
    for (const p of items) if (this.decisions.has(p.s)) done++;
    return { done, total: items.length };
  }

  /* -------------------------------------------------------------- sync status */

  onStatusChange(fn: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }

  /* -------------------------------------------------------------- outbox flush */

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.outbox.size === 0) {
      this.setStatus('saved');
      return;
    }

    this.flushing = true;
    this.setStatus('saving');
    try {
      const batch = [...this.outbox].slice(0, MAX_BATCH);
      const items: DecisionItem[] = batch.map(([sku, value]) => ({ sku, value }));
      await postDecisions(items);

      for (const [sku, value] of batch) {
        if (this.outbox.get(sku) === value) this.outbox.delete(sku); // untouched since the snapshot
      }
      this.persistOutbox();
      this.flushDelay = FLUSH_BASE_DELAY_MS;

      if (this.outbox.size > 0) {
        this.scheduleFlush(0); // more than 500 pending — drain the rest right away
      } else {
        this.setStatus('saved');
      }
    } catch (err) {
      // A 400 here (e.g. a malformed item) would loop forever; anything else is a transient
      // network failure worth retrying. Either way the safe move is the same: back off and
      // tell the user we're offline rather than silently dropping their decisions.
      void err;
      this.setStatus('offline');
      this.flushDelay = Math.min(this.flushDelay * 2, FLUSH_MAX_DELAY_MS);
      this.scheduleFlush(this.flushDelay);
    } finally {
      this.flushing = false;
    }
  }

  private persistDecisions(): void {
    if (!this.session) return;
    lsSet(`decisions.${this.session.username}`, Object.fromEntries(this.decisions));
  }

  private persistOutbox(): void {
    if (!this.session) return;
    lsSet(`outbox.${this.session.username}`, Object.fromEntries(this.outbox));
  }

  /** Wired once at module load (below) — connectivity events are global, not tied to login state. */
  handleOnline(): void {
    this.flushDelay = FLUSH_BASE_DELAY_MS;
    if (this.outbox.size > 0) this.scheduleFlush(0);
  }

  handleOffline(): void {
    this.setStatus('offline');
  }
}

export const store = new Store();

window.addEventListener('online', () => store.handleOnline());
window.addEventListener('offline', () => store.handleOffline());
