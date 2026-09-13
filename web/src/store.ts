/**
 * App state: session, catalog, products, decisions, overrides, and the offline outbox — SPEC.md §9.5.
 *
 * The persistence rule that shapes this whole file: every write (decide, undecide, bulk, edit)
 * hits `localStorage` synchronously, before anything async happens. The UI reads that write back
 * immediately and never waits on the network. A debounced background loop drains durable outboxes
 * to `POST /api/decisions` (`value: null` = DELETE/undecided) and `POST /api/overrides`,
 * batched and retried with backoff. All of that state survives a reload because the outboxes
 * themselves sit in `localStorage`, not just an in-memory queue.
 *
 * Decisions and overrides are keyed by `(username, sku)` — they outlive any one catalog.
 * Every derived count walks `products` and looks up state by SKU — never the other way around —
 * so stale entries for vanished SKUs are silently ignored everywhere it matters, export included.
 *
 * Progress and resume are derived from actual decided counts, never from a cursor: search,
 * list-select and review may decide out of order, so "first undecided" is computed by lookup,
 * not by assuming a prefix (AUDIT D-08/D-09).
 */

import {
  ApiError,
  fetchCatalogMeta,
  fetchCatalogProducts,
  fetchDecisions,
  fetchMe,
  fetchOverrides,
  login as apiLogin,
  logout as apiLogout,
  postDecisions,
  postOverrides,
  type CatalogMeta,
  type DecisionItem,
  type DecisionValue,
  type OverrideField,
  type OverrideItem,
  type OverridesMap,
  type Product,
  type Session,
} from './api';
import { groupByCategory } from './xlsx.js';

export type SyncStatus = 'saving' | 'saved' | 'offline';
export type { OverrideField };

export interface Category {
  readonly name: string;
  readonly items: Product[];
}

export type OverrideValues = Partial<Record<OverrideField, string>>;

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
    return null; // storage disabled, full, or corrupt JSON — cache misses are safe
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled. The app still works; it starts cold next time.
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    // ignore
  }
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

class Store {
  session: Session | null = null;
  catalog: CatalogMeta | null = null;
  products: Product[] = [];
  categories: Category[] = [];

  private decisions = new Map<string, DecisionValue>();
  /** sku -> value|null; null = tombstone: delete the row server-side (durable undecide). */
  private outbox = new Map<string, DecisionValue | null>();
  private overrides = new Map<string, OverrideValues>();
  /** `${sku} ${field}` -> value|null; null = reset this field server-side. */
  private overridesOutbox = new Map<string, string | null>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay = FLUSH_BASE_DELAY_MS;
  private flushing = false;
  /** Until the first load completes the chip must not claim "Saved" (AUDIT D-19). */
  private status: SyncStatus = 'saving';
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
      this.setStatus('saved');
      return; // main.ts routes to the login screen
    }

    this.session = session;
    lsSet('session', session);

    await this.loadCatalogAndProducts();
    await this.loadDecisions();
    await this.loadOverrides();
    this.setStatus(this.outbox.size > 0 || this.overridesOutbox.size > 0 ? 'saving' : 'saved');
    if (this.outbox.size > 0 || this.overridesOutbox.size > 0) this.scheduleFlush(0);
  }

  async login(username: string, password: string): Promise<void> {
    const session = await apiLogin(username, password); // throws on bad credentials / network
    this.session = session;
    lsSet('session', session);
    await this.loadCatalogAndProducts();
    await this.loadDecisions();
    await this.loadOverrides();
    this.setStatus(this.outbox.size > 0 || this.overridesOutbox.size > 0 ? 'saving' : 'saved');
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
      this.overrides = new Map();
      this.overridesOutbox = new Map();
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
    await this.loadOverrides();
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
      // Offline on a return visit: fall back to cache rather than showing an empty app.
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

    const localOutbox = lsGet<Record<string, DecisionValue | null>>(`outbox.${username}`) ?? {};
    this.outbox = new Map(Object.entries(localOutbox) as [string, DecisionValue | null][]);

    let server: Record<string, DecisionValue>;
    try {
      server = await fetchDecisions();
    } catch {
      server = lsGet<Record<string, DecisionValue>>(`decisions.${username}`) ?? {};
      this.setStatus('offline');
    }

    const merged = new Map<string, DecisionValue>(Object.entries(server) as [string, DecisionValue][]);
    for (const [sku, value] of this.outbox) {
      if (value === null) merged.delete(sku); // local undecide wins, even offline
      else merged.set(sku, value);
    }
    this.decisions = merged;
    this.persistDecisions();

    if (this.outbox.size > 0) this.scheduleFlush(0);
  }

  private async loadOverrides(): Promise<void> {
    const username = this.requireSession().username;

    const local = lsGet<Record<string, string | null>>(`ooutbox.${username}`) ?? {};
    this.overridesOutbox = new Map(Object.entries(local));

    let server: OverridesMap;
    try {
      server = await fetchOverrides();
    } catch {
      server = lsGet<OverridesMap>(`overrides.${username}`) ?? {};
      this.setStatus('offline');
    }

    const merged = new Map<string, OverrideValues>();
    for (const [sku, vals] of Object.entries(server)) merged.set(sku, { ...vals });
    for (const [key, value] of this.overridesOutbox) {
      const sep = key.indexOf(' ');
      const sku = key.slice(0, sep);
      const field = key.slice(sep + 1) as OverrideField;
      if (value === null) {
        const cur = merged.get(sku);
        if (cur) {
          delete cur[field];
          if (Object.keys(cur).length === 0) merged.delete(sku);
        }
      } else {
        const cur = merged.get(sku) ?? {};
        cur[field] = value;
        merged.set(sku, cur);
      }
    }
    this.overrides = merged;
    this.persistOverrides();

    if (this.overridesOutbox.size > 0) this.scheduleFlush(0);
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

  /** Bulk write used by list Select-all/Clear-all. Returns prior values for undo. */
  setDecisions(items: ReadonlyArray<{ readonly sku: string; readonly value: DecisionValue }>): void {
    for (const { sku, value } of items) {
      this.decisions.set(sku, value);
      this.outbox.set(sku, value);
    }
    this.persistDecisions();
    this.persistOutbox();
    this.setStatus('saving');
    this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  /**
   * Durable undecide (AUDIT D-02): delete locally AND enqueue a `null` tombstone so the
   * already-flushed server row is deleted on flush. Never just drops the outbox entry —
   * that is what made undo silently un-do itself.
   */
  clearDecision(sku: string): void {
    this.decisions.delete(sku);
    this.outbox.set(sku, null);
    this.persistDecisions();
    this.persistOutbox();
    this.setStatus('saving');
    this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  /** Restore a snapshot (bulk undo). `undefined` = was undecided. */
  restoreDecisions(snapshot: ReadonlyMap<string, DecisionValue | undefined>): void {
    for (const [sku, prev] of snapshot) {
      if (prev === undefined) {
        this.decisions.delete(sku);
        this.outbox.set(sku, null);
      } else {
        this.decisions.set(sku, prev);
        this.outbox.set(sku, prev);
      }
    }
    this.persistDecisions();
    this.persistOutbox();
    this.setStatus('saving');
    this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  /* -------------------------------------------------------------- overrides */

  getOverride(sku: string): OverrideValues | undefined {
    return this.overrides.get(sku);
  }

  /** Effective display values with overrides applied (cards, lists, review, export all use this). */
  displayOf(p: Product): { name: string; mrp: number; price: number; size: string; edited: boolean } {
    const ov = this.overrides.get(p.s);
    return {
      name: ov?.name ?? p.n,
      mrp: ov?.mrp !== undefined ? Number(ov.mrp) : p.m,
      price: ov?.price !== undefined ? Number(ov.price) : p.p,
      size: ov?.size ?? '',
      edited: ov !== undefined,
    };
  }

  get overridesCount(): number {
    return this.overrides.size;
  }

  setOverride(sku: string, field: OverrideField, value: string | null): void {
    const cur = this.overrides.get(sku) ?? {};
    if (value === null) {
      delete cur[field];
      if (Object.keys(cur).length === 0) this.overrides.delete(sku);
      else this.overrides.set(sku, { ...cur });
    } else {
      this.overrides.set(sku, { ...cur, [field]: value });
    }
    this.overridesOutbox.set(`${sku} ${field}`, value);
    this.persistOverrides();
    this.persistOverridesOutbox();
    this.setStatus('saving');
    this.scheduleFlush(FLUSH_DEBOUNCE_MS);
  }

  /* -------------------------------------------------------------- derived counts */

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

  get overallNo(): number {
    let n = 0;
    for (const p of this.products) if (this.decisions.get(p.s) === 0) n++;
    return n;
  }

  /** For export: yes-SKUs in original catalog order. Walks `products`, never `decisions`. */
  getYesSkusInOrder(): string[] {
    const out: string[] = [];
    for (const p of this.products) if (this.decisions.get(p.s) === 1) out.push(p.s);
    return out;
  }

  categoryProgress(items: readonly Product[]): { done: number; yes: number; no: number; total: number } {
    let done = 0;
    let yes = 0;
    for (const p of items) {
      const v = this.decisions.get(p.s);
      if (v !== undefined) {
        done++;
        if (v === 1) yes++;
      }
    }
    return { done, yes, no: done - yes, total: items.length };
  }

  /** Actual decided count for a category — never a cursor (AUDIT D-09). */
  categoryDecidedCount(items: readonly Product[]): number {
    let n = 0;
    for (const p of items) if (this.decisions.has(p.s)) n++;
    return n;
  }

  /** First undecided by lookup — correct even when decisions are out of order (AUDIT D-08). */
  firstUndecidedIndex(items: readonly Product[]): number {
    for (let i = 0; i < items.length; i++) {
      if (!this.decisions.has(items[i].s)) return i;
    }
    return items.length;
  }

  /** Case/diacritic-insensitive name+SKU search (AUDIT D-06). Capped for render sanity. */
  search(q: string, limit = 400): Product[] {
    const needle = norm(q.trim());
    if (!needle) return [];
    const out: Product[] = [];
    for (const p of this.products) {
      const ov = this.overrides.get(p.s);
      if (norm(ov?.name ?? p.n).includes(needle) || norm(p.s).includes(needle)) {
        out.push(p);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** "Continue where you left off" — UI convenience in localStorage, not server state. */
  getContinue(): { category: string; sku: string } | null {
    if (!this.session) return null;
    return lsGet<{ category: string; sku: string }>(`continue.${this.session.username}`);
  }

  setContinue(category: string, sku: string): void {
    if (!this.session) return;
    lsSet(`continue.${this.session.username}`, { category, sku });
  }

  clearContinue(): void {
    if (!this.session) return;
    lsRemove(`continue.${this.session.username}`);
  }

  deckMode(): 'swipe' | 'list' {
    if (!this.session) return 'swipe';
    return lsGet<'swipe' | 'list'>(`deckmode.${this.session.username}`) ?? 'swipe';
  }

  setDeckMode(mode: 'swipe' | 'list'): void {
    if (!this.session) return;
    lsSet(`deckmode.${this.session.username}`, mode);
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
    if (this.outbox.size === 0 && this.overridesOutbox.size === 0) {
      this.setStatus('saved');
      return;
    }

    this.flushing = true;
    this.setStatus('saving');
    try {
      // Decisions first ( tombstones included ), then overrides — both ≤500 per request.
      if (this.outbox.size > 0) {
        const batch = [...this.outbox].slice(0, MAX_BATCH);
        const items: DecisionItem[] = batch.map(([sku, value]) => ({ sku, value }));
        try {
          await postDecisions(items);
        } catch (err) {
          if (err instanceof ApiError && err.status === 400) {
            // Malformed batch would loop forever — drop it; local state is already correct.
          } else {
            throw err;
          }
        }
        for (const [sku, value] of batch) {
          if (this.outbox.get(sku) === value) this.outbox.delete(sku);
        }
        this.persistOutbox();
      }

      if (this.overridesOutbox.size > 0) {
        const batch = [...this.overridesOutbox].slice(0, MAX_BATCH);
        const items: OverrideItem[] = batch.map(([key, value]) => {
          const sep = key.indexOf(' ');
          return { sku: key.slice(0, sep), field: key.slice(sep + 1) as OverrideField, value };
        });
        try {
          await postOverrides(items);
        } catch (err) {
          if (err instanceof ApiError && err.status === 400) {
            // Validation failure (e.g. price > MRP raced an edit) — keep local, drop the send
            // so we never spin; the next edit re-enqueues.
          } else {
            // Put the batch back conceptually (we didn't delete yet) and retry with backoff.
            throw err;
          }
        }
        for (const [key, value] of batch) {
          if (this.overridesOutbox.get(key) === value) this.overridesOutbox.delete(key);
        }
        this.persistOverridesOutbox();
      }

      this.flushDelay = FLUSH_BASE_DELAY_MS;
      if (this.outbox.size > 0 || this.overridesOutbox.size > 0) {
        this.scheduleFlush(0); // more than 500 pending — drain the rest right away
      } else {
        this.setStatus('saved');
      }
    } catch (err) {
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

  private persistOverrides(): void {
    if (!this.session) return;
    lsSet(`overrides.${this.session.username}`, Object.fromEntries(this.overrides));
  }

  private persistOverridesOutbox(): void {
    if (!this.session) return;
    lsSet(`ooutbox.${this.session.username}`, Object.fromEntries(this.overridesOutbox));
  }

  /** Wired once at module load (below) — connectivity events are global, not tied to login state. */
  handleOnline(): void {
    this.flushDelay = FLUSH_BASE_DELAY_MS;
    if (this.outbox.size > 0 || this.overridesOutbox.size > 0) this.scheduleFlush(0);
    else if (this.session) this.setStatus('saved');
  }

  handleOffline(): void {
    this.setStatus('offline');
  }
}

export const store = new Store();

window.addEventListener('online', () => store.handleOnline());
window.addEventListener('offline', () => store.handleOffline());
