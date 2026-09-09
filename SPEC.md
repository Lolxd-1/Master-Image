# Stock Picker — Build Specification & Definition of Done

**Status:** frozen contract. Implementation and subagents build against this document.
**Last verified against:** `Master excel.xlsx` (650 rows), 2026-09-09.

---

## 1. Problem

A hyperlocal delivery operation in a tier-3 city has onboarded 4 stores and built a combined
product catalog in Amazon SmartBiz's bulk-upload format. Each store owner must tell us **which of
those products he actually stocks**, then hand Amazon a catalog file containing only those items.

Doing this in Excel is unusable on a phone: 650–3000 rows, no images visible, easy to corrupt.

**The deliverable is one file.** Everything else exists to produce it: a valid SmartBiz
bulk-upload `.xlsx` containing only the products a given store owner marked "yes", byte-faithful
to the original in every other respect, ready to upload with zero edits.

### Success, stated plainly
A store owner opens a link on his phone, taps through products with his thumb, closes the browser
whenever he likes, comes back days later on a different device, finishes, taps Download, and
uploads the resulting file to Amazon SmartBiz without touching it.

---

## 2. Users & roles

| Role | Who | Can |
|---|---|---|
| `admin` | The operator (you) | Upload/replace the master sheet, see everyone's progress, export any user's file |
| `picker` | 4 store owners | See the catalog, mark yes/no, export **their own** file |

Accounts are **hardcoded** in `worker/users.ts` (agreed: no signup, no password reset, no email).
Login is username + password. Each user's decisions are private to that user.

Adding a user is one command: `npm run user:add <username> <password>` → prints a line to paste,
then redeploy.

---

## 3. Non-goals

Explicitly out of scope. Building these is scope creep and will be rejected in review.

- No signup, password reset, email, or OAuth.
- No editing of product data. **Yes/no only** — no price, name, or image edits. (Confirmed with user.)
- No store column, no per-store catalogs. All 4 users see the identical catalog; separation is by
  *who is logged in*, not by data. (Confirmed with user.)
- No deduplication logic. The uploaded sheet is pre-deduplicated. (Confirmed with user.)
- No image hosting, resizing service, or CDN. Amazon serves the images. (Verified in §4.3.)
- No real-time collaboration, presence, or multi-user editing of one list.
- No analytics, tracking, cookies beyond the session, or third-party scripts.
- No PWA/service worker in v1.
- No paid infrastructure. Anything that requires a credit card is disqualified.

---

## 4. The data contract

### 4.1 File shape (verified)

The master file is an **Amazon SmartBiz catalog bulk-upload template**. Three sheets:

| Sheet | Role | Must survive export |
|---|---|---|
| `important_instructions` | Amazon's guidance, 203 rows | Untouched, byte-identical |
| `bulk_upload_template` | The data. 25 columns, padded to row 25000 | Rows replaced; everything else identical |
| `DataSheet` | Hidden. Backs every dropdown, 27 tables | Untouched, byte-identical |

Column layout of `bulk_upload_template` (row 1 = header, data starts row 2):

| Col | Field | Populated in sample | Notes |
|---|---|---|---|
| A | SKU ID | 650/650, **all unique** | **Primary key.** Never edited. |
| B | Variant ID | 0/650 | Empty, stays empty |
| C | Custom SKU | 0/650 | Empty |
| D | Product Name | 650/650 | Display title |
| E | MRP | 650/650 | Display |
| F | Selling Price | 650/650 | Display. Always ≤ MRP in sample |
| G | Business Category | 650/650 — all `FOOD_AND_GROCERY` | Dropdown-bound |
| H | Product Category | 650/650 — 11 distinct | **The category screen** |
| I | Product Description | 650/650 | Equals product name in sample |
| J–M | Variant / Size / Colour | 0/650 | Empty |
| N | Best Seller | 650/650 — all `No` | Dropdown-bound |
| O | HSN Code | 0/650 | Empty |
| P | Product Image1 | **649/650** | Display image |
| Q–U | Product Image2–6 | 0/650 | Empty |
| V–Y | Size Guide, SEO fields | 0/650 | Empty |

Category distribution in the sample (this is the home screen):

```
CRISP & NAMKEENS 158 · DRYFRUITS, NUTS & SEEDS 123 · CHOCOLATES 102
INSTANTS & MIXES 68 · CRUSH & SYRUPS 61 · BEVERAGES & COLD DRINKS 57
DAIRY & BAKERY 38 · ICE CREAMS 19 · TEA & COFFEE 12 · CHEWING GUMS 10 · SWEETS 2
```

### 4.2 Structures that must not be damaged

Discovered by reading the raw OOXML. Each is a way the export can silently break:

- **23 `dataValidation` blocks** on `bulk_upload_template`, bound to named ranges (`BCat`,
  `Best_Option`, …) that live in `DataSheet`. Ranges are `G2:G25000`, `H2:H25000`, `E2:E25000`,
  `N2:N25000`, `J2:J25000`, `P2:P25000` …
- **`sheetProtection`** with a SHA-512 hash, `insertRows="0" deleteRows="0"`.
- **`conditionalFormatting`** on `E2:E25000` and `F2:F25000` (flags selling price > MRP).
- **`table1.xml`** `ref="A1:Y25000"`, `displayName="tbl_Bulk_Upload_Sheet"`, 25 typed columns.
- **20+ `definedName` entries** in `workbook.xml` pointing into `DataSheet`.
- **`sharedStrings.xml`** — 14952 refs, 2416 unique. Data cells reference these **by index**
  (`t="s"><v>456</v>`). Re-encoding strings would desynchronise every row.
- `DataSheet` is `state="hidden"` and must stay hidden.

**Consequence:** rebuilding this workbook with a spreadsheet library is not acceptable. It would
need to faithfully reproduce all of the above, and would need ~500 MB of RAM for 625,000 cells.

### 4.3 Images (verified live)

- All 649 URLs are on `m.media-amazon.com`, all HTTPS, all URI-safe (70 contain `$`, which is legal).
- Hotlinking works: **HTTP 200**, `Access-Control-Allow-Origin: *`. No image hosting needed.
- Amazon honours size suffixes on these URLs — measured on a real product image:

  | URL | Size | Bytes | Saving |
  |---|---|---|---|
  | original `.jpg` | 800×800 | 68,603 | — |
  | `._SX400_.jpg` | 400×400 | 17,841 | **−74%** |
  | `._SX200_.jpg` | 200×200 | 6,399 | **−91%** |
  | `.webp` | — | 404 | not supported |

  **Rule:** display uses `._SX400_` (swipe card) and `._SX200_` (grid thumb). The **original URL is
  written to the export unchanged.** Resizing is a display concern only and must never reach the file.

- **One row has no image:** SKU `7ddfe115-b5cc-4278-9422-7e4cb300a8e4`,
  `LIPTON GREEN TEA - HONEY LEMON 10 BAGS`. Must render as a readable text card, not a broken image.

---

## 5. Architecture

### 5.1 The constraint that decides everything

**Cloudflare Workers free plan allows 10 ms CPU per request.** Unzipping and parsing a 14.8 MB
sheet is seconds of CPU. Therefore:

> **All heavy work happens in the browser. The Worker is a thin persistence layer.**

This is not a workaround — it is the correct shape. The Worker only ever runs small indexed D1
queries and streams blobs from KV. Waiting on D1/KV is I/O, not CPU, so requests stay far under
the cap. The app stays free at any realistic usage.

### 5.2 Components

```
Browser (admin)   parse .xlsx ─► products JSON + row XML + skeleton ─► POST /api/catalog
Browser (picker)  fetch catalog ─► swipe ─► outbox ─► POST /api/decisions (batched)
                  export: fetch skeleton + row XML ─► build .xlsx locally ─► download
Worker            auth, D1 reads/writes, KV pass-through. No parsing, no zipping.
D1 (SQLite)       decisions, catalog metadata            [strongly consistent]
KV                skeleton blob, row XML, products JSON   [blob store]
Static assets     the SPA, served by the same Worker      [free, unlimited]
```

**Why D1 for decisions and not KV:** KV's free tier allows 1000 writes/day and is eventually
consistent. 4 users × 3000 swipes would blow that and could show stale state. D1 allows 100,000
row writes/day and is strongly consistent. Expected load is ~12,000 writes total for the whole
project.

**Why KV for blobs and not D1:** D1 caps query result size around 1 MB; the row-XML payload is
~2.8 MB. KV allows 25 MB values.

### 5.3 Free-tier budget

| Resource | Free limit | Our expected use | Headroom |
|---|---|---|---|
| Worker requests | 100,000/day | ~500/day | 200× |
| Worker CPU | 10 ms/request | <5 ms | 2× |
| D1 storage | 5 GB | <10 MB | 500× |
| D1 row reads | 5,000,000/day | ~20,000/day | 250× |
| D1 row writes | 100,000/day | ~3,000/day | 33× |
| KV reads | 100,000/day | ~50/day | 2000× |
| KV writes | 1,000/day | ~3 per upload | — |
| Static assets | unlimited | ~60 KB | — |

**No credit card required at any point.**

---

## 6. Data model

```sql
-- One row per uploaded master sheet. Only one is active.
CREATE TABLE catalog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL,
  uploaded_by TEXT    NOT NULL,
  uploaded_at INTEGER NOT NULL,
  product_count INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0
);

-- One row per user per product. Absent = undecided.
CREATE TABLE decision (
  username   TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  value      INTEGER NOT NULL,   -- 1 = yes (stocks it), 0 = no
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, sku)
);
CREATE INDEX idx_decision_user ON decision (username);
```

**Why decisions are keyed by SKU and not by catalog.** SKU IDs are Amazon UUIDs — unique and
stable across sheets. Scoping decisions to a catalog would mean that re-uploading a corrected or
expanded sheet silently discards every store owner's work, and re-uploads are certain: the first
master is one store (650 rows), the combined sheet is ~3000, and price corrections follow. Since
"selections must never be lost" is the top requirement, decisions outlive catalogs. Products that
disappear from a later sheet simply stop being shown; their stale decisions are inert because the
export walks the *current* catalog's products, never the decisions map.

KV keys, per catalog id:

| Key | Contents | Approx size |
|---|---|---|
| `cat:{id}:products` | JSON array of display fields — fetched to start swiping | ~150 KB gz |
| `cat:{id}:rows` | JSON map `sku → original <row> XML` — fetched only at export | ~500 KB gz |
| `cat:{id}:skeleton` | The workbook with all data rows stripped | ~200 KB |

Product display record (kept deliberately small — this is on the mobile critical path):

```ts
type Product = {
  s: string;   // SKU ID  (col A)
  n: string;   // name    (col D)
  m: number;   // MRP     (col E)
  p: number;   // selling price (col F)
  c: string;   // product category (col H)
  b: string;   // business category (col G)
  i: string;   // image URL, ORIGINAL, unresized (col P) — "" if none
};
```

---

## 7. API contract

All responses JSON. Auth via `HttpOnly; Secure; SameSite=Lax` cookie holding
`username.expiry.HMAC-SHA256(secret)`. Session lasts 90 days. Non-2xx returns `{error: string}`.

| Method | Path | Auth | Body / Query | Returns |
|---|---|---|---|---|
| `POST` | `/api/login` | — | `{username, password}` | `{username, role}` + sets cookie |
| `POST` | `/api/logout` | user | — | `{ok:true}` |
| `GET` | `/api/me` | — | — | `{username, role}` or `401` |
| `GET` | `/api/catalog` | user | — | `{id, filename, productCount, uploadedAt}` |
| `GET` | `/api/catalog/products` | user | — | gzipped `Product[]` |
| `GET` | `/api/catalog/rows` | user | — | gzipped `{sku: rowXml}` |
| `GET` | `/api/catalog/skeleton` | user | — | base64 text |
| `POST` | `/api/catalog/begin` | **admin** | `{filename, productCount}` | `{id}` |
| `PUT` | `/api/catalog/:id/products` | **admin** | raw JSON text | `{ok:true}` |
| `PUT` | `/api/catalog/:id/rows` | **admin** | raw JSON text | `{ok:true}` |
| `PUT` | `/api/catalog/:id/skeleton` | **admin** | raw base64 text | `{ok:true}` |
| `POST` | `/api/catalog/:id/activate` | **admin** | — | `{id, productCount}` |
| `GET` | `/api/decisions` | user | — | `{sku: 0|1}` for the caller only |
| `POST` | `/api/decisions` | user | `{items:[{sku, value}]}` (≤500) | `{saved: n}` |
| `GET` | `/api/progress` | **admin** | — | per-user `{decided, yes, total}` |

**Why upload is five requests and not one.** Measured on a 3250-row combined catalog, the `rows`
map is **3.9 MB** of JSON. `await request.json()` on that costs roughly 20–50 ms of CPU against a
hard **10 ms** free-tier limit — the upload would fail outright. So the Worker never *parses*
these payloads: it streams the request body straight into KV (`KV.put(key, request.body)`) and
streams it back out (`KV.get(key, 'stream')`), treating the content as opaque. CPU stays near
zero regardless of catalog size.

The catalog only becomes visible at `activate`, so a half-finished or failed upload cannot be
served to pickers and leaves the previous catalog untouched.

**Idempotency:** `POST /api/decisions` is an upsert keyed on `(catalog_id, username, sku)`.
Replaying a batch is safe — this is what makes the offline outbox correct.

---

## 8. The export algorithm (the critical path)

This is where correctness is won or lost. Specified precisely.

**At upload (browser):**
1. Unzip the `.xlsx` with `fflate`.
2. Read `xl/worksheets/sheet2.xml`. Split `sheetData` into individual `<row>` elements.
3. Row 1 is the header — keep it in the skeleton.
4. For each data row: extract cell values (resolving `sharedStrings.xml` indices) to build the
   `Product` record, **and keep the row's raw XML string verbatim**, keyed by SKU.
5. Build the skeleton: the original zip with **every part byte-identical**, except
   `sheet2.xml`, whose `sheetData` contains only the header row. `dimension`, `table1.xml`,
   validations, protection, conditional formatting, `sharedStrings.xml` — all untouched.
6. Upload products + rows + skeleton.

**At export (browser):**
1. Fetch skeleton, rows, and the user's decisions.
2. Select SKUs where `value === 1`, **in original sheet order** (stable, reproducible output).
3. Renumber each kept row: `<row r="N"` and each `<c r="XN"` → sequential from 2. Nothing else in
   the row is modified — values, styles, and shared-string indices are carried across verbatim.
4. Splice the renumbered rows into the skeleton's `sheetData`.
5. Re-zip and download as `<original-name>-<username>-<yyyymmdd>.xlsx`.

**Why this is lossless:** kept rows are never re-encoded. They still point at the original
`sharedStrings.xml`, which ships unchanged, so every string resolves to exactly the same text.
Styles keep their original indices against an unchanged `styles.xml`. The only mutation is the
row number, which must change because rows moved.

**Open decision, resolved by test T-1.5:** whether to omit the ~24,350 trailing empty rows
(smaller file) or reproduce them (structurally identical to the original). Ship whichever passes
the fidelity tests; prefer omitting if both pass.

---

## 9. Frontend specification

Four screens. Mobile-first, single column, thumb-reachable controls. Target: a low-end Android
phone on a slow connection.

### 9.1 Login
Username, password, one button. Remembers the session for 90 days. No other chrome.

### 9.2 Category grid (home)
- One tile per **Product Category** (col H), sorted by item count descending.
- Each tile: representative product thumbnail (`._SX200_`), category name, `done / total`, and a
  progress ring.
- Header: overall progress bar, `N of M decided`.
- Footer, always visible: **`Download my list (N items)`** — enabled whenever N ≥ 1.
- If more than one Business Category ever appears, group the tiles under business-category headings.
  With one, render a flat grid (today's case).

### 9.3 Swipe deck
- Full-bleed product image (`._SX400_`), name, MRP + selling price, category chip.
- Two large buttons: **✗ Don't stock** / **✓ Stock it**. Drag left/right also works, with the card
  tilting and a colour tint tracking the gesture.
- **Undo** — mandatory. Mis-swipes are constant and unrecoverable mistakes destroy trust.
- Progress `12 / 158` and a thin bar.
- **Prefetch the next 3 images** so a card is never blank.
- Ignore input while a card is animating out — prevents double-decisions.
- Resume exactly where the user left off within each category.
- Desktop: `←` / `→` / `U` for undo (the admin will test on a laptop).
- Missing image → clean text card, never a broken-image icon.

### 9.4 Export
- Summary: total yes, breakdown by category.
- One button → builds and downloads the file locally, with a progress state while zipping.
- Plain instruction line: upload this file to SmartBiz without opening it.

### 9.5 Persistence behaviour (non-negotiable)
- Every decision writes to `localStorage` **immediately and synchronously** — the UI never waits
  on the network.
- A background outbox flushes batches to `/api/decisions` (debounced ~1 s, ≤500 items per request)
  with retry and exponential backoff.
- A subtle status chip: `Saving… / Saved / Offline — will sync`.
- On load, server state is authoritative and merged with any unsent local queue.
- **Rationale:** iOS Safari's ITP evicts `localStorage` for sites not visited in 7 days. These are
  once-in-a-while users — exactly that eviction profile. Local storage alone would silently lose
  work, so the server is the source of truth and local storage is the speed/offline layer.

---

## 10. Test plan

A test that was not run does not count. Every item records evidence.

### T-1 Excel fidelity — the tests that actually matter

| # | Test | Pass criterion |
|---|---|---|
| T-1.1 | Round-trip with **all 650** selected | Output has 650 data rows; every cell of every row equals the input, compared field-by-field across all 25 columns |
| T-1.2 | Round-trip with a **subset** (e.g. 137 across 4 categories) | Exactly those 137 SKUs, in original order, values identical |
| T-1.3 | **Non-data parts byte-identical** | SHA-256 of every zip part except `sheet2.xml` matches the original — including `sharedStrings.xml`, `styles.xml`, `DataSheet`, all 28 tables |
| T-1.4 | **Validations survive** | Output `sheet2.xml` still contains 23 `dataValidation` blocks, the `sheetProtection` element, and both `conditionalFormatting` blocks |
| T-1.5 | **Opens clean** | `openpyxl` loads it without warnings; LibreOffice/Excel opens with **no "repair" prompt**; dropdowns still work in cells G/H/N |
| T-1.6 | **Image URLs unmodified** | No exported URL contains `_SX`/`_SL`; every URL is character-identical to the input |
| T-1.7 | **Edge: 1 product selected** | Valid file, 1 data row |
| T-1.8 | **Edge: 0 selected** | Download blocked in UI with a clear message; no empty file produced |
| T-1.9 | **Edge: the imageless SKU** selected | Row exports with an empty col P, not the string `undefined` |
| T-1.10 | **Numeric types preserved** | MRP/price remain numeric cells (`t="n"`), never text — Amazon rejects text prices |
| T-1.11 | **Unicode/special chars** | `LAY'S`, `&`, `,` in names survive exactly; XML stays well-formed |
| T-1.12 | Table range consistency | `table1.xml` `ref` and `<dimension>` agree with the emitted row count |

### T-2 API & data

| # | Test | Pass criterion |
|---|---|---|
| T-2.1 | Login with correct/incorrect password | 200 + cookie / 401, no user enumeration difference |
| T-2.2 | Every endpoint without a cookie | 401, no data leaked |
| T-2.3 | Picker calls admin endpoints | 403 |
| T-2.4 | **User isolation** | User A's decisions never appear for user B. Verified with 2 sessions and overlapping SKUs |
| T-2.5 | Decision upsert | Same SKU posted twice with different values → last write wins, one row |
| T-2.6 | Replay a batch | Idempotent, no duplicates, no error |
| T-2.7 | Oversized batch (>500) | Rejected with 400, not a crash |
| T-2.8 | Cookie tampering | Modified HMAC → 401 |
| T-2.9 | Catalog replace | Uploading a new sheet deactivates the old, and **preserves** every user's decisions for products that still exist |
| T-2.11 | Abandoned upload | A `begin` with no `activate` never becomes live; the previous catalog is untouched |

### T-3 Mobile UX

| # | Test | Pass criterion |
|---|---|---|
| T-3.1 | Real phone, real link | Loads and is usable end-to-end |
| T-3.2 | Cold load time | Interactive in < 3 s on a throttled connection |
| T-3.3 | Swipe 50 items | No dropped or double decisions; undo restores correctly |
| T-3.4 | Kill the browser mid-category, reopen | Resumes at the same product, nothing lost |
| T-3.5 | **Airplane mode mid-session** | Swiping continues; chip shows Offline; on reconnect everything syncs |
| T-3.6 | Different device, same login | Prior progress appears |
| T-3.7 | Thumb reach + tap targets | Primary controls ≥ 44 px, reachable one-handed |
| T-3.8 | Image bandwidth | Card images are `_SX400_`; verified in devtools |
| T-3.9 | 2 users swiping simultaneously | No interference, no cross-contamination |

### T-4 Scale & resilience

| # | Test | Pass criterion |
|---|---|---|
| T-4.1 | Synthetic **3000-row** sheet (4 stores combined) | Upload, browse, swipe, export all work |
| T-4.2 | Worker CPU per request | < 10 ms on every endpoint, measured in `wrangler` output |
| T-4.3 | Export build time on a phone | < 5 s for 3000 rows |
| T-4.4 | Re-upload the same sheet | Idempotent; no orphaned KV keys |
| T-4.5 | Malformed upload (wrong template, CSV, corrupt zip) | Clear error message, nothing written |

### T-5 Deployment

| # | Test | Pass criterion |
|---|---|---|
| T-5.1 | Fresh `npm run deploy` | Succeeds from a clean checkout |
| T-5.2 | Live URL over mobile data | Works off wifi |
| T-5.3 | Session survives a redeploy | Users stay logged in |
| T-5.4 | Cold request latency | No cold-start stall (the reason we chose Workers) |
| T-5.5 | Cost check | Cloudflare dashboard shows $0.00 and no card on file |

---

## 11. Definition of Done

The project is finished when **all** of these are true:

- [ ] All T-1 tests pass, with T-1.3 and T-1.5 evidenced by saved output.
- [ ] All T-2, T-3, T-4, T-5 tests pass.
- [ ] A store owner can complete the whole flow on a phone without being told how.
- [ ] The exported file uploads to Amazon SmartBiz and is accepted. *(Final acceptance — only the
      user can run this. Everything above is designed to make it a formality.)*
- [ ] 4 user accounts exist and are handed over.
- [ ] Cloudflare bill is $0.00 with no payment method on file.
- [ ] `README.md` explains, for a non-technical reader: how to upload a new sheet, how to add a
      user, and what to do if something looks wrong.

---

## 12. Build order

Risk-first. Nothing depends on unproven foundations.

1. **XLSX engine + T-1 harness** — built and verified against the real file *before any UI exists*.
2. **Worker API + D1 schema + auth** — verified with T-2.
3. **Frontend** — login, grid, swipe deck, export.
4. **End-to-end locally**, then T-4 with a synthetic 3000-row sheet.
5. **Deploy**, then T-3 and T-5 on a real phone.

**Delegation:** step 1 is owned directly (highest risk, needs full knowledge of the file's
internals). Steps 2 and 3 are delegated to subagents against this contract, then reviewed against
the tests above.
