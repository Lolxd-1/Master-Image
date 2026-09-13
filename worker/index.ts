/**
 * Stock Picker Worker: thin persistence layer only (SPEC.md §5.1).
 *
 * No XLSX parsing, no zipping, no heavy loops. Every handler is a small
 * indexed D1 query or a KV pass-through, so requests stay far under the
 * Workers free-plan 10ms CPU budget. Routing is a plain switch on
 * `${method} ${path}` (plus a small manual matcher for the three
 * `/api/catalog/:id/...` routes) — zero npm dependencies.
 *
 * Catalog upload is five requests, not one (SPEC.md §7): `begin` creates an
 * inactive catalog row, three `PUT`s stream the products/rows/skeleton
 * payloads straight into KV via `request.body` without ever parsing them
 * (a multi-MB `rows` payload would blow the 10ms CPU budget if parsed), and
 * `activate` atomically flips which catalog is live. A half-finished upload
 * is therefore never visible to pickers.
 */

import { users } from './users';
import {
  verifyLogin,
  verifySession,
  createSessionCookie,
  clearSessionCookie,
  type Session,
} from './auth';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SESSION_SECRET: string;
  ASSETS: Fetcher;
}

/* ------------------------------------------------------------------ small response helpers */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

function badRequest(message: string): Response {
  return errorResponse(400, message);
}

function notFound(message: string): Response {
  return errorResponse(404, message);
}

function forbidden(message: string): Response {
  return errorResponse(403, message);
}

function serverError(): Response {
  return errorResponse(500, 'Something went wrong on the server.');
}

/** 401 always clears the session cookie, per SPEC.md §7 auth design. */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Please log in.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
  });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/* ------------------------------------------------------------------ auth guards */

async function getSession(request: Request, env: Env): Promise<Session | null> {
  return verifySession(request.headers.get('Cookie'), env.SESSION_SECRET);
}

async function requireUser(request: Request, env: Env): Promise<Session | Response> {
  const session = await getSession(request, env);
  if (!session) return unauthorized();
  return session;
}

async function requireAdmin(request: Request, env: Env): Promise<Session | Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  if (session.role !== 'admin') return forbidden('Admins only.');
  return session;
}

/* ------------------------------------------------------------------ catalog helpers */

interface CatalogRow {
  id: number;
  filename: string;
  uploaded_by: string;
  uploaded_at: number;
  product_count: number;
}

async function getActiveCatalog(db: D1Database): Promise<CatalogRow | null> {
  return db
    .prepare('SELECT id, filename, uploaded_by, uploaded_at, product_count FROM catalog WHERE active = 1 LIMIT 1')
    .first<CatalogRow>();
}

async function catalogExists(db: D1Database, id: number): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM catalog WHERE id = ? LIMIT 1').bind(id).first();
  return row !== null;
}

/* ------------------------------------------------------------------ handlers: auth */

async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  if (!isRecord(body) || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return badRequest('username and password are required.');
  }

  const role = await verifyLogin(body.username, body.password);
  if (!role) return errorResponse(401, 'Invalid username or password.');

  const cookie = await createSessionCookie(body.username, env.SESSION_SECRET);
  return new Response(JSON.stringify({ username: body.username, role }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie },
  });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearSessionCookie() },
  });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return unauthorized();
  return json({ username: session.username, role: session.role });
}

/* ------------------------------------------------------------------ handlers: catalog (read) */

async function handleGetCatalog(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  const catalog = await getActiveCatalog(env.DB);
  if (!catalog) return notFound('No catalog has been uploaded yet.');

  return json({
    id: catalog.id,
    filename: catalog.filename,
    productCount: catalog.product_count,
    uploadedAt: catalog.uploaded_at,
  });
}

/** Shared by /api/catalog/products and /api/catalog/rows: stream the stored JSON straight from KV, never parsed. */
async function handleGetCatalogBlob(request: Request, env: Env, kind: 'products' | 'rows'): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  const catalog = await getActiveCatalog(env.DB);
  if (!catalog) return notFound('No catalog has been uploaded yet.');

  const stream = await env.KV.get(`cat:${catalog.id}:${kind}`, 'stream');
  if (!stream) return notFound('No catalog has been uploaded yet.');

  return new Response(stream, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/** Skeleton is stored and served as opaque base64 text — the browser decodes it (SPEC.md §7). */
async function handleGetSkeleton(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  const catalog = await getActiveCatalog(env.DB);
  if (!catalog) return notFound('No catalog has been uploaded yet.');

  const stream = await env.KV.get(`cat:${catalog.id}:skeleton`, 'stream');
  if (!stream) return notFound('No catalog has been uploaded yet.');

  return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/* ------------------------------------------------------------------ handlers: catalog (write) */

interface CatalogBeginBody {
  filename: string;
  productCount: number;
}

function isCatalogBeginBody(x: unknown): x is CatalogBeginBody {
  return (
    isRecord(x) &&
    typeof x.filename === 'string' &&
    x.filename.trim() !== '' &&
    typeof x.productCount === 'number' &&
    Number.isInteger(x.productCount) &&
    x.productCount >= 0
  );
}

/** Step 1/5: create an inactive catalog row. Body is tiny — safe to parse. */
async function handleCatalogBegin(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  if (!isCatalogBeginBody(body)) {
    return badRequest('Body must be {filename, productCount}.');
  }

  const now = Date.now();
  const result = await env.DB
    .prepare('INSERT INTO catalog (filename, uploaded_by, uploaded_at, product_count, active) VALUES (?, ?, ?, ?, 0)')
    .bind(body.filename, session.username, now, body.productCount)
    .run();

  return json({ id: result.meta.last_row_id });
}

/** Steps 2-4/5: stream the raw request body straight into KV. Never parsed — the content is opaque to the Worker. */
async function handleCatalogPut(
  request: Request,
  env: Env,
  id: number,
  kind: 'products' | 'rows' | 'skeleton',
): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  if (!(await catalogExists(env.DB, id))) {
    return notFound(`No catalog upload in progress with id ${id}.`);
  }

  const body = request.body;
  if (!body) return badRequest('Request body is required.');

  await env.KV.put(`cat:${id}:${kind}`, body);
  return json({ ok: true });
}

/** Step 5/5: atomically make :id the only active catalog. */
async function handleCatalogActivate(request: Request, env: Env, id: number): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  if (!(await catalogExists(env.DB, id))) {
    return notFound(`No catalog upload in progress with id ${id}.`);
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE catalog SET active = 0'),
    env.DB.prepare('UPDATE catalog SET active = 1 WHERE id = ?').bind(id),
  ]);

  const row = await env.DB.prepare('SELECT product_count FROM catalog WHERE id = ?').bind(id).first<{
    product_count: number;
  }>();

  return json({ id, productCount: row ? row.product_count : 0 });
}

/* ------------------------------------------------------------------ handlers: decisions */
/* Decisions are keyed by (username, sku) alone — they outlive any one catalog (SPEC.md §6). */

interface DecisionRow {
  sku: string;
  value: number;
}

async function handleGetDecisions(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  // Admin may read another user's decisions (?user=) to build that user's file (SPEC §8.8).
  // Pickers asking for anyone else's data get 403 — never leak cross-user state.
  const url = new URL(request.url);
  const target = url.searchParams.get('user');
  const username = target ?? session.username;
  if (target !== null && target !== session.username) {
    if (session.role !== 'admin') return forbidden('Admins only.');
    if (!(target in users)) return notFound(`No such user: ${target}.`);
  }

  const { results } = await env.DB
    .prepare('SELECT sku, value FROM decision WHERE username = ?')
    .bind(username)
    .all<DecisionRow>();

  const out: Record<string, 0 | 1> = {};
  for (const row of results) out[row.sku] = row.value === 1 ? 1 : 0;
  return json(out);
}

interface DecisionItem {
  sku: string;
  value: 0 | 1 | null;
}

function isDecisionItem(x: unknown): x is DecisionItem {
  return (
    isRecord(x) &&
    typeof x.sku === 'string' &&
    x.sku.length > 0 &&
    x.sku.length <= 100 &&
    (x.value === 0 || x.value === 1 || x.value === null)
  );
}

async function handlePostDecisions(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return badRequest('Body must be {items: [{sku, value}]}.');
  }
  const rawItems = body.items;
  if (rawItems.length > 500) {
    return badRequest('A batch may contain at most 500 items.');
  }

  const items: DecisionItem[] = [];
  for (const item of rawItems) {
    if (!isDecisionItem(item)) return badRequest('Each item must be {sku: string, value: 0 | 1 | null}.');
    items.push(item);
  }
  if (items.length === 0) return json({ saved: 0 });

  const now = Date.now();
  const upsert = env.DB.prepare(
    `INSERT INTO decision (username, sku, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username, sku) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = env.DB.prepare('DELETE FROM decision WHERE username = ? AND sku = ?');
  // value: null = undecided (DELETE). Mixed batches are fine — one batch, still tiny.
  await env.DB.batch(
    items.map((item) =>
      item.value === null ? del.bind(session.username, item.sku) : upsert.bind(session.username, item.sku, item.value, now),
    ),
  );

  return json({ saved: items.length });
}

/* ------------------------------------------------------------------ handlers: overrides (SPEC §6.1) */

interface OverrideRow {
  sku: string;
  field: string;
  value: string;
}

type OverrideField = 'name' | 'size' | 'mrp' | 'price';

function isOverrideField(f: unknown): f is OverrideField {
  return f === 'name' || f === 'size' || f === 'mrp' || f === 'price';
}

function isDecimal2(s: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(s);
}

/** Server-side shape validation. Cross-field F<=E is enforced at export (T-1.21) + live in UI. */
function overrideValueError(field: OverrideField, value: string): string | null {
  if (field === 'name') {
    const t = value.trim();
    if (!t) return 'Name cannot be empty.';
    if (t.length > 200) return 'Name is too long (200 letters maximum).';
    return null;
  }
  if (field === 'size') {
    if (value.length > 50) return 'Pack size is too long (50 letters maximum).';
    return null;
  }
  // mrp / price: bare decimals, no currency, no exponent.
  if (!isDecimal2(value)) return 'Use at most 2 decimal places.';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Enter a valid number.';
  if (field === 'mrp') {
    if (!(n > 0) || n > 999999.99) return 'MRP must be more than ₹0 and at most ₹999999.99.';
    return null;
  }
  if (!(n >= 0) || n > 999999.99) return 'Price must be ₹0 or more and at most ₹999999.99.';
  return null;
}

async function handleGetOverrides(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const target = url.searchParams.get('user');
  const username = target ?? session.username;
  if (target !== null && target !== session.username) {
    if (session.role !== 'admin') return forbidden('Admins only.');
    if (!(target in users)) return notFound(`No such user: ${target}.`);
  }

  const { results } = await env.DB
    .prepare('SELECT sku, field, value FROM override WHERE username = ?')
    .bind(username)
    .all<OverrideRow>();

  const out: Record<string, Partial<Record<OverrideField, string>>> = {};
  for (const row of results) {
    if (!isOverrideField(row.field)) continue;
    (out[row.sku] ??= {})[row.field] = row.value;
  }
  return json(out);
}

async function handlePostOverrides(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return badRequest('Body must be {items: [{sku, field, value}]}.');
  }
  const rawItems = body.items;
  if (rawItems.length > 500) {
    return badRequest('A batch may contain at most 500 items.');
  }

  const now = Date.now();
  const upsert = env.DB.prepare(
    `INSERT INTO override (username, sku, field, value, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username, sku, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = env.DB.prepare('DELETE FROM override WHERE username = ? AND sku = ? AND field = ?');
  const stmts: D1PreparedStatement[] = [];
  for (const item of rawItems) {
    if (!isRecord(item) || typeof item.sku !== 'string' || !item.sku || item.sku.length > 100) {
      return badRequest('Each item must be {sku: string, field: name|size|mrp|price, value: string|null}.');
    }
    if (!isOverrideField(item.field)) {
      return badRequest('Each item must be {sku: string, field: name|size|mrp|price, value: string|null}.');
    }
    const v = (item as { value: unknown }).value;
    if (v === null) {
      stmts.push(del.bind(session.username, item.sku, item.field));
      continue;
    }
    if (typeof v !== 'string') {
      return badRequest('Each item must be {sku: string, field: name|size|mrp|price, value: string|null}.');
    }
    const err = overrideValueError(item.field, v);
    if (err) return badRequest(err);
    stmts.push(upsert.bind(session.username, item.sku, item.field, v, now));
  }
  if (stmts.length > 0) await env.DB.batch(stmts);
  return json({ saved: rawItems.length });
}

/* ------------------------------------------------------------------ handlers: progress */

interface ProgressRow {
  username: string;
  decided: number;
  yes: number;
  lastActive: number;
}

async function handleGetProgress(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  if (session instanceof Response) return session;

  // One grouped query over ALL decisions (they are not catalog-scoped) plus the
  // single active-catalog row for `total`, then a trivial in-memory merge over
  // the fixed, tiny set of pickers in users.ts to zero-fill anyone who hasn't
  // started yet. Not a per-user DB loop.
  const [catalog, { results }] = await Promise.all([
    getActiveCatalog(env.DB),
    env.DB.prepare(
      `SELECT username, COUNT(*) AS decided, SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS yes,
              MAX(updated_at) AS lastActive
       FROM decision GROUP BY username`,
    ).all<ProgressRow>(),
  ]);

  const total = catalog ? catalog.product_count : 0;
  const byUser = new Map(results.map((row) => [row.username, row]));
  const out: Record<string, { decided: number; yes: number; total: number; lastActive: number | null }> = {};
  for (const [username, record] of Object.entries(users)) {
    if (record.role !== 'picker') continue;
    const row = byUser.get(username);
    out[username] = {
      decided: row ? Number(row.decided) : 0,
      yes: row ? Number(row.yes) : 0,
      total,
      lastActive: row && row.lastActive ? Number(row.lastActive) : null,
    };
  }
  return json(out);
}

/* ------------------------------------------------------------------ routing */

async function routeApi(request: Request, env: Env, path: string): Promise<Response> {
  switch (`${request.method} ${path}`) {
    case 'POST /api/login':
      return handleLogin(request, env);
    case 'POST /api/logout':
      return handleLogout(request, env);
    case 'GET /api/me':
      return handleMe(request, env);
    case 'GET /api/catalog':
      return handleGetCatalog(request, env);
    case 'GET /api/catalog/products':
      return handleGetCatalogBlob(request, env, 'products');
    case 'GET /api/catalog/rows':
      return handleGetCatalogBlob(request, env, 'rows');
    case 'GET /api/catalog/skeleton':
      return handleGetSkeleton(request, env);
    case 'POST /api/catalog/begin':
      return handleCatalogBegin(request, env);
    case 'GET /api/decisions':
      return handleGetDecisions(request, env);
    case 'POST /api/decisions':
      return handlePostDecisions(request, env);
    case 'GET /api/overrides':
      return handleGetOverrides(request, env);
    case 'POST /api/overrides':
      return handlePostOverrides(request, env);
    case 'GET /api/progress':
      return handleGetProgress(request, env);
  }

  // /api/catalog/:id/products|rows|skeleton (PUT) and /api/catalog/:id/activate (POST).
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'catalog' && /^\d+$/.test(segments[2])) {
    const id = Number(segments[2]);
    const kind = segments[3];
    if (request.method === 'PUT' && (kind === 'products' || kind === 'rows' || kind === 'skeleton')) {
      return handleCatalogPut(request, env, id, kind);
    }
    if (request.method === 'POST' && kind === 'activate') {
      return handleCatalogActivate(request, env, id);
    }
  }

  return notFound('No such endpoint.');
}

/** Non-API paths: static assets, with SPA fallback to /index.html on 404. */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;

  const indexUrl = new URL(request.url);
  indexUrl.pathname = '/index.html';
  return env.ASSETS.fetch(new Request(indexUrl, { headers: request.headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return await routeApi(request, env, url.pathname);
      }
      return await serveAsset(request, env);
    } catch {
      return serverError();
    }
  },
};
