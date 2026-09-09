/**
 * Typed fetch wrapper for the API in SPEC.md §7.
 *
 * Every function here does exactly one HTTP call and returns already-typed data, or throws
 * `ApiError` (HTTP-level failure, message from the server's `{error}` body when present) or lets
 * a network-level `TypeError` from `fetch` itself propagate (no connection, DNS, etc). Callers
 * that care about the difference (login screen, the outbox) branch on `err instanceof ApiError`.
 *
 * Auth is a cookie the browser attaches automatically on same-origin requests; nothing here
 * touches it directly.
 *
 * Amendment (post-freeze, relayed by the coordinator): the admin catalog upload is no longer a
 * single `POST /api/catalog`. A 3.9 MB `rows` JSON payload costs 20-50 ms of Worker CPU to parse
 * against a 10 ms free-tier cap, so the three large payloads are now streamed as opaque
 * `text/plain` bodies across a 5-call sequence: begin -> PUT products -> PUT rows -> PUT skeleton
 * -> activate. The catalog only goes live on `activate`, so a failure at any earlier step leaves
 * the previously-active catalog untouched.
 *
 * Amendment 2 (relayed by the coordinator): decisions are keyed by `(username, sku)`, not
 * `(catalog_id, username, sku)`, so progress survives a catalog re-upload. `GET /api/decisions`
 * can therefore return SKUs that are not in the *current* catalog. This file just carries that
 * map through as-is — filtering it down to the live product list is store.ts's job.
 */

export type Role = 'admin' | 'picker';

export interface Session {
  readonly username: string;
  readonly role: Role;
}

export interface CatalogMeta {
  readonly id: number;
  readonly filename: string;
  readonly productCount: number;
  readonly uploadedAt: number;
}

/** Display record for one product. Field names are short on purpose — SPEC §6, mobile critical path. */
export interface Product {
  readonly s: string; // SKU ID — primary key
  readonly n: string; // name
  readonly m: number; // MRP
  readonly p: number; // selling price
  readonly c: string; // product category
  readonly b: string; // business category
  readonly i: string; // image URL, original/unresized, "" if none
}

export type DecisionValue = 0 | 1;

export interface DecisionItem {
  readonly sku: string;
  readonly value: DecisionValue;
}

/** sku -> 0|1, for the calling user only. May contain SKUs absent from the live catalog. */
export type DecisionsMap = Record<string, DecisionValue>;

export interface ProgressEntry {
  readonly decided: number;
  readonly yes: number;
  readonly total: number;
}

/** username -> that user's progress. Admin only. */
export type ProgressMap = Record<string, ProgressEntry>;

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ base64 (browser-safe) */

/** Uint8Array -> base64, chunked so `String.fromCharCode` never sees an oversized arg list. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 -> Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `/api/catalog/skeleton` returns base64 text — sometimes bare, sometimes a JSON-quoted string. */
function unwrapBase64(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      // Not actually JSON despite the quotes — fall through and treat as raw text.
    }
  }
  return trimmed;
}

/* ------------------------------------------------------------------ low-level request helpers */

async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  let message = res.statusText ? `${res.statusText} (${res.status})` : `Request failed (${res.status})`;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === 'string' && err) message = err;
    }
  } catch {
    // Error body wasn't JSON — keep the status-based message.
  }
  throw new ApiError(message, res.status);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  await throwIfError(res);
  return res.json() as Promise<T>;
}

async function getText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: 'same-origin' });
  await throwIfError(res);
  return res.text();
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await throwIfError(res);
  return res.json() as Promise<T>;
}

async function postEmpty<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin' });
  await throwIfError(res);
  return res.json() as Promise<T>;
}

async function putText(path: string, body: string): Promise<void> {
  const res = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
  });
  await throwIfError(res);
}

/* ------------------------------------------------------------------ auth */

export async function login(username: string, password: string): Promise<Session> {
  return postJson<Session>('/api/login', { username, password });
}

export async function logout(): Promise<void> {
  await postEmpty<{ ok: boolean }>('/api/logout');
}

/** Returns `null` on 401 (not logged in) instead of throwing — that is the expected cold-boot case. */
export async function fetchMe(): Promise<Session | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  await throwIfError(res);
  return res.json() as Promise<Session>;
}

/* ------------------------------------------------------------------ catalog (read) */

export async function fetchCatalogMeta(): Promise<CatalogMeta> {
  return get<CatalogMeta>('/api/catalog');
}

export async function fetchCatalogProducts(): Promise<Product[]> {
  return get<Product[]>('/api/catalog/products');
}

export async function fetchCatalogRows(): Promise<Record<string, string>> {
  return get<Record<string, string>>('/api/catalog/rows');
}

export async function fetchCatalogSkeleton(): Promise<Uint8Array> {
  const text = await getText('/api/catalog/skeleton');
  return base64ToBytes(unwrapBase64(text));
}

/* ------------------------------------------------------------------ catalog (admin write) */

export interface BeginCatalogResult {
  readonly id: number;
}

export interface ActivateCatalogResult {
  readonly id: number;
  readonly productCount: number;
}

export async function beginCatalogUpload(filename: string, productCount: number): Promise<BeginCatalogResult> {
  return postJson<BeginCatalogResult>('/api/catalog/begin', { filename, productCount });
}

/** `productsJson` is `JSON.stringify(products)` — sent verbatim, the server does not parse it. */
export async function putCatalogProducts(id: number, productsJson: string): Promise<void> {
  await putText(`/api/catalog/${id}/products`, productsJson);
}

/** `rowsJson` is `JSON.stringify(rows)` — this is the multi-MB payload the streamed flow exists for. */
export async function putCatalogRows(id: number, rowsJson: string): Promise<void> {
  await putText(`/api/catalog/${id}/rows`, rowsJson);
}

/** `skeletonBase64` is the skeleton bytes, base64-encoded (see `bytesToBase64`). */
export async function putCatalogSkeleton(id: number, skeletonBase64: string): Promise<void> {
  await putText(`/api/catalog/${id}/skeleton`, skeletonBase64);
}

export async function activateCatalog(id: number): Promise<ActivateCatalogResult> {
  return postEmpty<ActivateCatalogResult>(`/api/catalog/${id}/activate`);
}

/* ------------------------------------------------------------------ decisions */

export async function fetchDecisions(): Promise<DecisionsMap> {
  return get<DecisionsMap>('/api/decisions');
}

export async function postDecisions(items: readonly DecisionItem[]): Promise<{ saved: number }> {
  return postJson<{ saved: number }>('/api/decisions', { items });
}

/* ------------------------------------------------------------------ admin progress */

export async function fetchProgress(): Promise<ProgressMap> {
  return get<ProgressMap>('/api/progress');
}
