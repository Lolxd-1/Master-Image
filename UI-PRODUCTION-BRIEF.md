# Stock Picker — Production UI/UX Brief

**You are the senior engineer who owns shipping this.** This repo is a working MVP. Your job is to
take it to a state where it can be handed to a non-technical shopkeeper in a tier-3 Indian city,
with no phone call, no training, no hand-holding — and to the operator who runs it — and nothing
about it feels unfinished.

Read this whole document before touching a file. It is long on purpose: every section exists
because getting it wrong costs a rebuild.

---

## 0. How to use this document

**The audit is already done.** `AUDIT.md` is the completed Phase 0 deliverable: 26 defects with
IDs, file:line references and measured evidence, a state-coverage matrix, and tap-target/contrast
numbers taken from the running app in headless Chrome. Raw measurements and screenshots are in
`audit-evidence/`.

1. Read this document end to end, then read `AUDIT.md`.
2. **Start at Phase 1 (§10).** Do not re-run the audit. Where this brief and `AUDIT.md` disagree,
   `AUDIT.md` wins — it was measured, and §4 of it lists the places this brief guessed wrong.
3. Implement phase by phase, running the verification gate at the end of each phase.
4. Never mark a phase done while its gate is red.
5. Reference defects by ID (`D-01` … `D-28`) in commit messages, so the trail from audit to fix is
   readable.

You may of course discover new defects while building. Add them to `AUDIT.md` with a new ID rather
than fixing them silently.

If you think something in this brief is wrong, say so in one or two sentences, recommend the
alternative, and keep going with my version unless I change it. Do not silently substitute your
own plan.

---

## 1. Mission

One sentence: **a shopkeeper opens a link on a cheap Android phone, tells us which of 650 products
he stocks, fixes the ones where our price or pack size is wrong, and gets a file he can hand to
Amazon — and he never once has to ask anyone how.**

The deliverable of the *app* is still one file: a valid Amazon SmartBiz bulk-upload `.xlsx`
containing only his items. Nothing you build may put that file at risk.

### What "production" means here, concretely

- A first-time user lands, and within 5 seconds knows what he is being asked to do and where to
  tap. No tooltip, no onboarding carousel — the screen itself says it.
- Every decision he makes is reversible, forever, from an obvious place. Not just "undo the last
  one in this session."
- He can find any product without scrolling 650 rows.
- When our data is wrong about his shop — wrong price, wrong pack size, slightly wrong name — he
  fixes it himself and the fix lands in the exported file.
- He never sees a screen that is blank, a number that contradicts another number, or a button he
  has to guess about.
- Nothing is below 44px. Nothing important is out of thumb reach. Nothing shifts under his finger.
- The operator can upload a new sheet, see who is progressing, and pull anyone's file.

---

## 2. The app as it exists (ground truth — verified, do not re-derive from scratch, but do confirm)

```
web/index.html          14 lines   — shell
web/src/main.ts         131        — hash router + auth gate + boot states
web/src/store.ts        381        — session, catalog, products, decisions, offline outbox
web/src/api.ts          252        — typed fetch wrapper, ApiError
web/src/xlsx.js         365        — THE EXCEL ENGINE. parse + lossless splice export.
web/src/styles.css      465        — hand-rolled, light-only, phone-first
web/src/screens/login.ts      91
web/src/screens/categories.ts 192  — home: 11 tiles, overall bar, download button
web/src/screens/deck.ts       417  — the swipe deck (the core interaction)
web/src/screens/export.ts     161  — summary + build & download
web/src/screens/admin.ts      244  — upload, catalog info, per-user progress table
worker/index.ts         454        — thin API: auth, D1, KV pass-through
worker/auth.ts          195        — PBKDF2 + HMAC session cookie (90 days)
worker/users.ts         35         — 5 hardcoded accounts
schema.sql                         — catalog + decision tables
SPEC.md                 463        — self-declared FROZEN contract (see §6 of this brief)
scripts/verify-*                   — the test suites
```

Stack: vanilla TypeScript, **no framework**, Vite build, one Cloudflare Worker serving both the SPA
and the API. D1 for decisions, KV for catalog blobs. Free tier, **10 ms CPU per request** — this is
the constraint that shaped the whole backend. Keep it.

Routes today: `#/login`, `#/` (category grid), `#/deck/<category>`, `#/export`, `#/admin`.

### Verified baseline state — this is green right now, and must stay green

```
npm run typecheck        → clean
node scripts/verify-xlsx.mjs → 11 passed, 0 failed (T-1.1 … T-1.12)
```

If either goes red at any point, that is a regression and it is your highest priority.

Full suite (run it before you call anything done):
```
npm test      # xlsx fidelity + independent openpyxl pass + scale + powershell/Excel check
```

---

## 3. Ground truth about the data (measured from `Master excel.xlsx` — trust these numbers)

- **650 products**, 24,349 trailing padding rows, **11 product categories**, 1 business category
  (`FOOD_AND_GROCERY`).
- 649 of 650 have an image. The one without: SKU `7ddfe115-b5cc-4278-9422-7e4cb300a8e4`
  (`LIPTON GREEN TEA - HONEY LEMON 10 BAGS`). It must render as a clean text card.
- 299 of 650 have selling price ≠ MRP.
- Category sizes: `CRISP & NAMKEENS` 158, `DRYFRUITS, NUTS & SEEDS` 123, `CHOCOLATES` 102,
  `INSTANTS & MIXES` 68, `CRUSH & SYRUPS` 61, `BEVERAGES & COLD DRINKS` 57, `DAIRY & BAKERY` 38,
  `ICE CREAMS` 19, `TEA & COFFEE` 12, `CHEWING GUMS` 10, `SWEETS` 2.
- **The largest category is 158 items.** A one-at-a-time swipe deck is 158 taps. Remember this
  number when you read §8.3.

### The sheet's 25 columns, and which ones matter

| Col | Header (verbatim) | Notes |
|---|---|---|
| A | SKU ID **(Not to be Edited)** | Amazon UUID. Primary key everywhere in this app. Never editable. |
| B | Variant ID **(Not to be Edited)** | Never editable. |
| C | Custom SKU (Optional) max 40 | Empty in every row. Vendor's own code. |
| D | **Product Name** (Mandatory) max 200 | **Pack size lives inside this string**, e.g. `5 STAR 20 GM`. |
| E | **MRP** (Mandatory) number only | |
| F | **Selling Price** (Optional) number only | |
| G | Business Category (Mandatory) | Dropdown, bound to named range `BCat`. **Do not make editable.** |
| H | Product Category (Mandatory) max 100 | Drives the category grid. **Do not make editable.** |
| I | Product Description (Optional) max 2000 | Currently a copy of the name. |
| J | Variant Relationship (Optional) | Dropdown `Var_RelSp`. **Do not make editable.** |
| K | **Size** (Optional) max 50 | **Empty in every row today.** This is the template's real slot for pack size / variant. |
| L–M | Colour Code (≤7) / Colour Name (≤50) | Empty. Irrelevant for grocery. |
| N | Best Seller (Optional) | Dropdown `Best_Option` (Yes/No), currently `No`. |
| O | HSN Code (Optional) | Empty. |
| P | Product Image1 | The image URL. Display-resized for the UI only — **original must reach the file**. |
| Q–U | Product Image2–6 | Empty. |
| V–Y | Size Guide / SEO fields | Empty. |

**About "grams".** You will be asked for pack-size editing. Understand the reality before you build
it: grams are *inside the product name* (`5 STAR 20 GM`), and column K `Size` — the template's
proper home for it — is **blank in all 650 rows**. So pack-size editing = editing **Name** (D) and
optionally filling **Size** (K). There is no grams column to expose. Do not invent one.

### Hard validation rules — these come from the template's own `dataValidation` blocks, not from taste

| Field | Rule | Source |
|---|---|---|
| E MRP | numeric, `> 0`, `<= 999999.99`, **max 2 decimal places** | `dataValidation` custom on `E2:E25000` |
| F Selling Price | numeric, `>= 0`, and **`F <= E`** | `dataValidation` custom on `F2:F25000`, plus `conditionalFormatting` on E and F that flags `F>E` |
| D Name | non-empty, `<= 200` chars | `dataValidation` textLength via `PName_TextLimit` + header |
| K Size | `<= 50` chars | `dataValidation` textLength on `K2:K25000` |
| C Custom SKU | `<= 40` chars | header |
| I Description | `<= 2000` chars | header |

**Selling price must never exceed MRP.** Enforce it in the UI at the moment of typing, with a plain
message, not on submit. This is the one edit mistake that gets the whole file rejected.

### The structures that must survive export (from `SPEC.md §4.2`, re-verified)

23 `dataValidation` blocks bound to named ranges on a hidden `DataSheet`; `sheetProtection` with a
SHA-512 hash and `insertRows="0" deleteRows="0"`; `conditionalFormatting` on E and F; 28 table
definitions (`table1.xml` is `ref="A1:Y25000"`); 20+ `definedName` entries; and
**`sharedStrings.xml` with `count="14952" uniqueCount="2416"` — data cells reference strings by
index**.

This is why the export does not rebuild the workbook. It keeps each chosen row's **original XML
verbatim** and splices it into an otherwise byte-identical copy of the file. The only thing it
changes is a row's number. `scripts/verify-xlsx.mjs` T-1.3 asserts 46 of 47 parts are
hash-identical. **That property is the product.** Everything in §7 is built to preserve it.

---

## 4. Who you are designing for

Not a user persona exercise. These are load-bearing facts about the person holding the phone.

- He runs a kirana / general store in a tier-3 city. He is not stupid; he is **busy and
  non-technical**. Assume he has never deliberately used a web app that wasn't WhatsApp, YouTube,
  Google Pay, or a delivery partner app.
- **Phone**: budget Android, 5–6", possibly a cracked screen, one-handed, thumb only. Chrome.
  Possibly 360×640 CSS px. Sometimes bright sunlight.
- **Network**: intermittent 4G that drops inside the shop. He will lose connection mid-session.
- **Attention**: he is doing this between customers. He will be interrupted after 12 items and come
  back 3 days later. He may switch phones.
- **Language**: he reads some English, mostly product names and numbers. Long English sentences do
  not get read. Numbers, product photos, and ✓/✗ do.
- **Trust**: this file goes to Amazon and affects his actual revenue. If he thinks the app lost his
  work or got a price wrong, he stops using it and calls the operator. **Every design decision
  should be read through "does this make him more or less sure the app has it right?"**

### The fundamental truths I want you to design from

1. **He will make mistakes, and he knows it.** Therefore: nothing may be one-way. Every decision
   must be visibly changeable from an obvious place, at any time, forever.
2. **He does not believe the app saved his work until the app tells him.** Therefore: state is
   always on screen, in counts he can check against his own sense of his shop.
3. **He thinks in his inventory, not in our categories.** Therefore: search is not a power feature,
   it is a primary one. "Do I have Lay's?" must be answerable in 3 seconds.
4. **Most of a category is usually the same answer.** A sweet shop stocks almost all chocolates and
   almost no dry fruits. Therefore: deciding 158 items one at a time is the wrong default for
   someone who knows his answer in bulk. Give him both.
5. **Our data about his shop is partly wrong.** Prices differ, pack sizes differ, names are
   abbreviated. Therefore: the ability to correct a row is not a nice-to-have; without it he
   either rejects good products or ships a wrong file.
6. **If he can't find the downloaded file, the app failed** — even though the download "worked."
   Finding a file in Android's Downloads folder is a real wall for this user.

---

## 5. The audit — done, in `AUDIT.md`

Phase 0 is complete. `AUDIT.md` holds the authoritative defect register: **7 P0, 13 P1, 6 P2**,
each with an ID, a `file:line`, and measured evidence. It also contains the walk-through, the
state-coverage matrix, the tap-target and contrast measurements, a "what is good — do not break
it" list, and instructions for reproducing every number.

**Read it before Phase 1.** The rest of this section is the earlier, unmeasured seed list, kept
only so you can see how the findings were reached. `AUDIT.md §4` records where this seed list was
wrong — notably: the `Admin`/`Log out` adjacency affects the admin role only; the "card squeeze on
short viewports" concern did not reproduce and is withdrawn; and the footer problem is a **38px
dead zone where visible tiles cannot be tapped** (`D-05`), which is worse and more specific than
described below. One defect the seed list missed entirely — home tiles rendering as
`CHOCOLATES40 / 102` (`D-04`) — was only visible once rendered.

### 5.1 The original seed list (superseded by `AUDIT.md` — kept for provenance)

These are seeds. Verify every one against the code; some may be wrong, and there are certainly more.

**P0 — product holes, the app is not trustworthy without these**

1. **A decision cannot be changed after you leave the screen.** `deck.ts` keeps `history: string[]`
   in the mount closure. Undo only walks that in-memory array. Navigate away and back and
   `history` is empty — there is now *no path in the entire app* to change a yes to a no. For a
   user who will certainly mis-tap, this is the single biggest hole.
2. **Undo is not durable even within a session.** `store.clearDecision()` deletes locally and drops
   the item from the outbox, but if the debounced flush already shipped it, the server row survives
   (`POST /api/decisions` is upsert-only; there is no unset). On the next load the undone decision
   silently returns. `store.ts` comments acknowledge this. It becomes user-visible the moment a
   review screen exists.
3. **No way to see what you selected.** The export screen shows per-category *counts* only
   (`export.ts`). He cannot look at the 128 items he claims to stock, let alone the ones he
   rejected. He will not trust a number he can't inspect.
4. **No search.** 650 products, 11 categories, no way to answer "is Lay's in here?"
5. **No product editing at all** — and `SPEC.md §3` explicitly forbids it. See §6 and §7.
6. **Resume logic is load-bearing and fragile.** `deck.ts` computes the start position as
   `queue.findIndex(p => getDecision(p.s) === undefined)` — "first undecided" — and the file's own
   comment justifies this by asserting decisions within a category "always form a prefix."
   **That invariant is true only because the deck is the only way to decide.** The moment search,
   list mode, or a review screen lets him decide out of order, resume jumps to a hole in the middle
   and the progress bar (which counts `pointer`, not decided items) starts lying. This must be
   fixed *before* those features land, not after.
7. **Download discoverability.** `export.ts` does `<a download>` → Android Downloads folder. This
   user will not find it. No share path, and no success state after the click — the button just
   re-enables, so he cannot tell whether it worked.

**P1 — things he will notice and be annoyed by**

8. Home shows `N of M decided` but **never how many he said yes to** — the number he actually
   cares about ("how many items am I selling?"). `categories.ts renderHeader()`.
9. Per-category tiles show `done / total` but not the yes/no split.
10. **No "continue where you left off."** On every return visit he must remember which category he
    was in. This is the most valuable button on the home screen and it does not exist.
11. Finishing a category offers only "Back to categories" (`deck.ts renderComplete()`). No
    "Next category →", so 11 categories means 11 unnecessary round trips through home.
12. **Deck doesn't show the category name.** He taps `CHOCOLATES`, the top bar shows `12 / 102` and
    no title. The only place the category appears is a small chip on the card.
13. No bulk action. 158 one-at-a-time taps for a category he'd answer in one gesture.
14. **`Admin` and `Log out` are adjacent with `gap: 2px`** (`.cat-header__actions`, styles.css) and
    `.link-btn` renders ~30px tall (padding 8px, font-size 14). Two sub-44px targets 2px apart, one
    of which destroys the session without confirmation. Mis-tap is a matter of when.
15. Logout has no confirmation at all (`categories.ts onLogout`).
16. Status chip reads `Saved` on first load before anything has been saved — it is the initial
    value of `status`, not a fact.
17. Drag gives a colour tint but **no YES/NO stamp** — the affordance people actually recognise from
    every app that uses this gesture. Also, `styles.css` has `.swipe-tint[data-dir="yes"|"no"]`
    rules that are dead code: `deck.ts applyDragTransform()` sets `tintEl.style.background`
    inline instead.
18. `renderCurrent()` tears down and rebuilds both cards on every decision, so the peek card is
    discarded and re-created as the active card with a fresh `<img>`. Promote the existing element
    instead; otherwise there is a visible hitch on slow devices.
19. No dark mode. `:root` is light-only; a phone in dark mode gets a full-brightness white app.
20. Focus is styled only on `.form-field input`. No `:focus-visible` anywhere else — keyboard and
    switch-access users get nothing. Admin tests on a laptop.
21. Admin screen: raw unstyled `<input type="file">`, inline `style=` in the markup
    (`admin.ts` `.admin-card__header`), no byte progress on the multi-MB PUTs, no catalog history.
22. **`SPEC.md §2` promises admin can "export any user's file" — not implemented.** Either build it
    or strike it from the spec; do not leave a promised capability missing.
23. No toast/confirmation system anywhere. Every screen invents its own inline error paragraph.
24. Boot state is a bare line of text (`main.ts renderBootState`) — no skeleton, so a slow first
    load looks broken.
25. `.card-stack` is `flex: 1` with absolutely-positioned cards and no min-height guard. On a short
    viewport the image area and card body can squeeze. Verify at 360×640 and 320×568.
26. `main.ts` bounces unknown routes to `#/` silently. A mistyped/stale link gives no explanation.

**P2 — worth doing, cut if time is short**

27. No `prefers-color-scheme` support (see 19), no "add to home screen" hint for a returning user.
28. English only. For this audience a Hindi label set would plausibly matter more than anything
    else on this list — but it is a bounded, separable piece of work. See §8.8; treat it as opt-in
    and do not start it until P0 and P1 are shipped and green.

---

## 6. The contract change you must make explicitly

`SPEC.md` opens with **"Status: frozen contract"** and `§3 Non-goals` says, verbatim:

> No editing of product data. **Yes/no only** — no price, name, or image edits. (Confirmed with user.)

**That non-goal is now withdrawn.** I am the user and I am reversing it: editing name, pack
size/Size, MRP and selling price is in scope and is a core requirement.

Do not quietly violate the spec, and do not refuse the work because of it. Instead, as your first
code change:

1. Amend `SPEC.md §3` to remove the blanket ban and state precisely what *is* now editable
   (D, E, F, K) and what remains permanently non-editable and why (A, B identity; G, H, J
   dropdown-bound; P images).
2. Add a new section `§6.1 Per-user overrides` documenting the data model in §7.2.
3. Amend `§8` (export algorithm) with the override application step, and restate the invariant that
   survives it: **every part except the data sheet stays byte-identical, and every cell the user did
   not edit stays byte-identical.**
4. Amend `§9` with the new screens, and `§10` with the new tests (§7.5).
5. Note at the top of `SPEC.md` that it was amended, by whom, and the date.

Amended spec first, then code. The spec is the thing the next person reads.

Everything else in `§3 Non-goals` stands and you must respect it: no signup/password reset/OAuth,
no per-store catalogs, no dedup logic, no image hosting, no real-time collaboration, no analytics
or third-party scripts, no paid infrastructure, no service worker in v1.

---

## 7. The editing feature — full technical specification

This is the highest-risk work in the project, because the export's losslessness is the product.
Build it exactly this way.

### 7.1 Scope of editable fields

| UI label | Column | Type | Validation |
|---|---|---|---|
| Product name | D | text | required, trimmed, 1–200 chars |
| Pack size | K | text | 0–50 chars, optional |
| MRP (₹) | E | number | `> 0`, `<= 999999.99`, at most 2 decimals |
| Your selling price (₹) | F | number | `>= 0`, at most 2 decimals, **`<= MRP`** |

Nothing else in P0. Custom SKU (C) and Description (I) may be added later behind a "More details"
disclosure; they are plain text with limits 40 and 2000. **Never** expose A, B, G, H, J, N, or any
image column.

Overrides are **per user**. Two shopkeepers editing the same SKU must not see each other's edits —
same isolation model as decisions.

### 7.2 Data model

```sql
-- Per-user, per-field corrections to the catalog. Absent = use the catalog value.
-- Keyed by (username, sku) like `decision`, and for the same reason: corrections must
-- survive a catalog re-upload.
CREATE TABLE override (
  username   TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  field      TEXT    NOT NULL,   -- 'name' | 'size' | 'mrp' | 'price'
  value      TEXT    NOT NULL,   -- always stored as text; numbers are parsed at use
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, sku, field)
);
CREATE INDEX idx_override_user ON override (username);
```

One row per field, not a JSON blob per SKU: it makes "reset this one field" a `DELETE`, avoids
read-modify-write in the Worker, and keeps every statement a trivial indexed op inside the 10 ms
budget.

`schema.sql` must be updated, and the migration must be safe to run on the live D1 database
(`CREATE TABLE IF NOT EXISTS`). Document in `README.md` the one command the operator runs to apply
it.

### 7.3 API

```
GET  /api/overrides
     → { [sku]: { name?: string, size?: string, mrp?: string, price?: string } }
     Current user only.

POST /api/overrides
     { items: [ { sku, field, value } ] }    value: string = set, null = reset to catalog value
     ≤ 500 items per request. Validates field name and value length server-side.
     → { saved: n }
```

Plus the fix for defect #2 — decisions need a real "undecided":

```
POST /api/decisions
     { items: [ { sku, value } ] }    value: 0 | 1 = set, null = DELETE the row (undecided)
     Stays ≤ 500 items. Existing 0|1 behaviour unchanged.
```

Both go through the same outbox machinery in `store.ts`: synchronous `localStorage` write first,
debounced batched flush with backoff second. An edit must appear on screen instantly and survive
airplane mode exactly the way a swipe does. Extend the existing outbox; do not add a second
independent queue.

Worker-side: keep every handler a small indexed D1 statement or a KV pass-through. No loops over
the catalog, no JSON parsing of large bodies. Verify CPU stays under 10 ms in `wrangler` output.

### 7.4 Applying overrides to the export — the part that must not break

Add to `web/src/xlsx.js`:

```js
/**
 * @param {string} rowXml
 * @param {{name?:string,size?:string,mrp?:string,price?:string}} ov
 * @returns {string}
 */
export function applyOverrides(rowXml, ov) { /* ... */ }
```

and extend the builder with an optional fourth argument, **keeping the 3-argument call working so
existing tests are untouched**:

```js
export function buildWorkbook(skeleton, rows, skus, overridesBySku = {}) { /* ... */ }
```

Order of operations per row: **apply overrides, then `renumberRow`.** Rows with no override must
pass through completely untouched — byte-identical, not merely equivalent.

#### The exact cell shapes you are editing (measured from the real file)

Every data row in this workbook carries all 25 cells. Text cells are shared-string references,
numbers are explicit `t="n"`, and genuinely-empty-and-styled cells are self-closing:

```xml
<c r="D2" s="2" t="s"><v>457</v></c>      <!-- Product Name → sharedStrings[457] -->
<c r="E2" s="2" t="n"><v>10.0</v></c>     <!-- MRP -->
<c r="F2" s="2" t="n"><v>10.0</v></c>     <!-- Selling price -->
<c r="K2" s="14" t="s"><v>446</v></c>     <!-- Size → sharedStrings[446], which is "" -->
<c r="C2" s="2"/>                          <!-- self-closing: styled, no value -->
```

Rules, non-negotiable:

1. **Numeric fields (E, F).** Replace only the `<v>` body. Keep `t="n"`. Keep the `s="…"` style
   attribute byte-for-byte. Emit a bare decimal: `12`, `12.5`, `1234.75`. Never a currency symbol,
   never a thousands separator, never an exponent, never a trailing `.`. Amazon rejects text
   prices, and `verify-xlsx.mjs` T-1.10 asserts E and F stay `t="n"` — that test must keep passing
   *with overrides applied*.

2. **Text fields (D, K).** Do **not** append to `sharedStrings.xml`. Its header is
   `count="14952" uniqueCount="2416"` and every data cell references it by index; editing it
   invites a desync that openpyxl and Excel will notice, and it breaks T-1.3's byte-identity
   guarantee for that part. Instead rewrite the single cell as an inline string, preserving `r` and
   `s`:

   ```xml
   <c r="D2" s="2" t="inlineStr"><is><t xml:space="preserve">5 STAR 25 GM</t></is></c>
   ```

   `xml:space="preserve"` is required — without it leading/trailing spaces are lost.

3. **Self-closing and missing cells.** A self-closing `<c r="C2" s="2"/>` must become a full
   element with its `s` preserved. If a target cell is absent from the row entirely (it isn't in
   today's file, but do not assume it), insert it in correct column order — a row whose cells are
   out of `r` order is a file Excel will offer to repair.

4. **Escaping.** Escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in that order (ampersand first).
   Strip characters illegal in XML 1.0 (`U+0000`–`U+0008`, `U+000B`, `U+000C`, `U+000E`–`U+001F`).
   Test with a name containing `&`, `<`, `'`, `"`, a Devanagari string, and an emoji.

5. **Touch nothing else.** Not `calcChain.xml`, not `styles.xml`, not the tables, not the
   validations, not `sheetProtection`. The only bytes that differ from the original for an edited
   row are inside the cells that were edited.

6. **An override for a SKU that is not selected, or no longer in the catalog, is inert** — exactly
   like a stale decision. The export walks the current catalog's product list, never the overrides
   map. Keep that direction of iteration.

### 7.5 New tests — add these to the harness, they are part of "done"

Extend `scripts/verify-xlsx.mjs` (same `t(id, desc, fn)` harness style) and
`scripts/verify_xlsx_independent.py` (openpyxl reads it back with a different implementation, so
you are never validating the writer with the writer):

| # | Test | Pass criterion |
|---|---|---|
| T-1.13 | Override a price | Exported F is `t="n"` with the new value; E untouched |
| T-1.14 | Override a name | Cell is well-formed `t="inlineStr"`; openpyxl reads back the exact string; `sharedStrings.xml` is byte-identical to the original |
| T-1.15 | Fill an empty Size (K) | Value present and readable; the cell's `s` attribute is unchanged |
| T-1.16 | Rows with no override | Byte-identical to the master row, ignoring row number — i.e. T-1.1 still holds for unedited rows in a mixed export |
| T-1.17 | Every other part | Still hash-identical (T-1.3 extended to an export that contains overrides) |
| T-1.18 | Special characters in an override | `&`, `<`, `'`, `"`, Devanagari, emoji all survive; XML parses |
| T-1.19 | Self-closing cell override | `<c r="C2" s="2"/>` → valid populated cell, style preserved |
| T-1.20 | Opens clean with overrides | openpyxl loads with no warnings; no Excel/LibreOffice repair prompt; dropdowns in G/H/N still work |
| T-1.21 | `price <= MRP` invariant | An export can never contain F > E; attempting it is rejected before it reaches the file |
| T-1.22 | Decimal formatting | `12`, `12.5`, `1234.75` round-trip as numbers; no exponent, no trailing dot |

Save evidence files under `.test-output/` as the existing tests do. `npm test` must be green.

---

## 8. The UI work, screen by screen

Build with the grain of the existing code: vanilla TS, one `mount(root) => cleanup` per screen,
hash routes in `main.ts`, real DOM construction for anything user-supplied (the codebase already
avoids `innerHTML` for product data — keep that; XSS via a product name is a real path here since
names come from an uploaded file).

**No framework. No CSS framework. No new runtime dependency** without asking me first. `fflate` is
the only runtime dep and it should stay that way.

Before you write any CSS or lay out any screen, load the **`artifact-design`** skill for design
fundamentals, and use the **`dataviz`** skill's guidance if you build any chart or meter beyond a
plain progress bar (you probably shouldn't).

### 8.1 Design system (do this first, as a pass over `styles.css`)

The existing tokens are decent: `--bg #faf7f2`, `--surface`, `--line`, `--ink/-2/-3`,
`--accent #1f6feb`, `--yes #12855a`, `--no #c8362f`, `--r 16px`, `--tap 48px`, system font stack.
Keep the palette's character; make it complete and enforce it.

- Add a **dark palette** under `@media (prefers-color-scheme: dark)`, redefining tokens only.
  Check contrast ≥ 4.5:1 for body text and ≥ 3:1 for large text and UI boundaries in both themes.
  Yes/no greens and reds must stay distinguishable — and must not be the *only* carrier of meaning
  (use the ✓/✗ glyph and a text label too; assume red-green colour blindness).
- One **spacing scale** and one **radius scale** as tokens. No more ad-hoc `padding: 11px 0`.
- One **type scale** (5 sizes max). Minimum body size 15px; product names and prices larger.
  Numbers the user checks (counts, prices) get tabular figures: `font-variant-numeric: tabular-nums`.
- **44px minimum** on every interactive element, 48px for primary actions. Fix `.link-btn`.
  Minimum 8px between any two adjacent tap targets; 16px if one of them is destructive.
- `:focus-visible` ring on everything focusable, using `--accent`, 2px, with offset.
- Respect `prefers-reduced-motion` (already partly done) and `env(safe-area-inset-*)` (already
  partly done — verify on an iPhone-shaped viewport).
- Delete dead CSS as you go (e.g. the unused `.swipe-tint[data-dir]` rules) and remove the inline
  `style=` assignments in `categories.ts`, `deck.ts` and `admin.ts` in favour of real classes.

Write the rules down in a short `DESIGN.md` — tokens, the scale, the tap-target rule, the copy rules
from §8.9 — so the next person doesn't re-invent them.

### 8.2 Home (`#/`) — rebuild around "what have I got, and what do I do next"

Top to bottom:

1. **Header**: shop/user name, sync chip, and a single overflow/menu control (`⋯`) holding Admin
   (if admin) and Log out. Getting Log out out of the main row kills defect #14. Log out asks
   "Log out? Your work is saved." with Cancel / Log out.
2. **The one number that matters**: `You stock 128 items` — large, primary. Under it, secondary:
   `324 of 650 products checked · 196 not stocked`. Numbers must be internally consistent at all
   times (`yes + no + undecided = total`); if they can't be, the layout is wrong.
3. **Overall progress bar** with the percentage as text next to it, not only as a bar.
4. **Primary CTA, context-dependent** — this is the most important single element on the screen:
   - nothing decided yet → `Start checking products` → first category
   - partially done → `Continue — <Category>, item 47 of 158` → exactly where he stopped
   - everything decided → `Download my list (128 items)` promoted to primary
   Persist "where he stopped" (category + SKU) in `localStorage`; it is a UI convenience, not
   server state, so it does not need an endpoint.
5. **Search field** — always visible, `Search 650 products`. Searches name and SKU,
   case/diacritic-insensitive, debounced, and shows matches as toggleable rows (§8.4) with their
   category and current state. This is a P0 feature, not a nicety.
6. **Category list**. Each row: thumbnail, name, and a **three-part state** the user can read at a
   glance — `✓ 41 stocked · ✗ 18 no · 43 left` — plus the progress ring. A finished category is
   unmistakably finished (check mark, muted treatment) and still tappable for review. Order:
   unfinished first (largest first), finished last — he should not scroll past completed work.
   Keep the `groupByCategory` ordering available for reference but present it in the order that
   serves the task.
7. **Footer**: `Download my list (N items)`. Present always; when `N = 0`, do not show a dead
   disabled button as the most prominent thing on a first-time screen — show the Start CTA in its
   place and bring the download bar in once `N ≥ 1`.

### 8.3 Deck (`#/deck/<category>`) — keep the swipe, fix the surround

The swipe interaction is good. Changes:

- Top bar: **back**, **category name**, `47 / 158`, progress bar, sync chip. The category name is
  missing today and it disorients.
- Add a **mode toggle: Swipe | List**, persisted per user. Swipe stays the default.
- During drag, show a **YES / NO stamp** that fades in with the gesture, in addition to the tint.
  Make the tint CSS-driven (`data-dir`) instead of inline styles, so the dead rules become live.
- **Promote the peek card** to active instead of rebuilding both cards, so the image never re-mounts.
- Card body: name, **MRP struck through + selling price** when they differ (299 of 650 rows),
  category chip, and an **`Edit` affordance** (pencil + the word, ≥44px, top-right of the body —
  not hidden behind a long-press, he will never find a long-press).
- An edited product shows an **`Edited` badge** and displays the edited values everywhere,
  including here.
- Completion panel: `All done in CHOCOLATES`, with counts, then **`Next: INSTANTS & MIXES →`** as
  the primary action and `Review this category` / `Back to categories` as secondary.
- Undo stays, becomes durable (§7.3 `value: null`), and is joined by the review screen for
  anything older than the last action.
- Keyboard: keep `←` `→` `U`; show a small hint line on non-touch pointers only
  (`@media (hover: hover) and (pointer: fine)`).
- Fix the resume/progress correctness problem (defect #6): progress must be derived from
  **actual decided count for the category**, not from a cursor, and resume must handle a category
  decided out of order. Spell out the new invariant in a comment where the old one is asserted.
- Guard the gesture against the page scroll on Android (`touch-action`, and `preventDefault` on the
  pointer move once a horizontal drag is established). Test with one thumb on a real-sized viewport.

### 8.4 List mode + bulk select (inside the deck, same route)

A scrollable list of that category's products. Each row ≥64px: thumbnail (48px, lazy),
name (2 lines max), price, and a **state control on the right that is a 3-state toggle, clearly
labelled** — stocked / not stocked / undecided. Tapping the row toggles stocked. Virtualise or
window the list if 158 rows on a budget phone drops frames — measure before optimising.

Header of the list: `Select all (158)` and `Clear all`, each behind a confirm that states the
number and is undoable as one action (`Undo` in a toast for ~6 s). This is the answer to fundamental
truth #4, and it turns a 158-tap category into ~10 taps for a shopkeeper who stocks most of it.

Filter chips: `All · Stocked · Not stocked · Left to check`. Default `All`.

### 8.5 Review (`#/review` and `#/review/<category>`) — the trust screen

Three tabs: **Stocked (N) · Not stocked (N) · Left to check (N)**. Same row component as list mode,
so everything is one tap from changing. Per-row: thumbnail, name (edited value if edited), price
(edited if edited, with the original shown small and struck when changed), `Edited` badge, and the
state toggle. Reachable from home, from the category completion panel, and from export.

This screen is what converts "the app says 128" into "I have seen my 128." Do not skip it and do
not merge it into export.

### 8.6 Edit sheet (a modal/bottom sheet, not a route)

Opens over the deck, list, review or export. Bottom sheet on phones — thumb-reachable, dismiss by
swipe-down or an explicit Cancel.

- Fields in this order: **Product name**, **Pack size**, **MRP**, **Your selling price**. Labels in
  plain words, not column letters.
- `inputmode="decimal"` on prices so the numeric keypad appears. `maxlength` on text, plus a live
  character counter when within 20 of the limit.
- **Validate as he types**, with plain messages under the field:
  - `Selling price cannot be more than MRP (₹40)` — the critical one
  - `MRP must be more than ₹0`
  - `Name cannot be empty` / `Name is too long (200 letters maximum)`
  - `Use at most 2 decimal places`
  Save is disabled while any field is invalid, and the reason is on screen — never a disabled
  button with no explanation.
- Every changed field shows the original beside it: `Original: ₹40`.
- **`Reset to original`** per field and for the whole product. Resetting the last field removes the
  override entirely.
- Saving writes through the outbox: instant on screen, synced in the background, works offline.
- Show the SKU somewhere small and copyable — the operator will ask him for it on a support call.
- Closing with unsaved changes asks before discarding.

### 8.7 Export (`#/export`) — finish the job properly

- Header: `128 items ready`. Per-category breakdown (keep it).
- **The actual item list**, with each row removable (which sets that SKU back to "not stocked",
  reflected everywhere) and showing edited values with the `Edited` badge. A count of how many rows
  were edited: `6 products edited`.
- Primary: `Make my file`. Keep the existing "building…" state and the `yieldToPaint()` trick;
  3000 rows must stay under 5 s on a phone (`SPEC §T-4.3`).
- After it builds: a **real success state** — `Your file is ready` with the filename, the item
  count, and two actions:
  - **`Share`** via `navigator.share({ files: [...] })` when available — this is how he gets it to
    WhatsApp or email without ever opening Android's file manager. Feature-detect
    `navigator.canShare({ files })`; fall back to the existing download silently when absent.
  - **`Save to phone`** (the current download path).
  Then the instruction line, short: `Send this file as it is. Do not open it first.`
- Downloading again after edits must rebuild from current state — never serve a stale blob.
- Keep the filename scheme `<master>-<user>-<YYYYMMDD>.xlsx`.

### 8.8 Admin (`#/admin`) — make the operator's job boring

- Styled upload: a real drop zone / big button (`Choose the master sheet`), the chosen filename,
  and **byte progress** on the three large PUTs (use `Request` body progress or chunk the reads —
  whatever works without breaking the streamed upload; a determinate bar matters because this is
  multi-MB on Indian broadband).
- Keep the existing 5-step labels and the reassurance that a failure leaves the previous catalog
  live — that claim is true because of the `activate`-last flow, so keep the flow.
- Current catalog card: filename, product count, who uploaded it, when, in a readable format.
- Per-user progress table: username, stocked, not stocked, left, **last active**, progress bar —
  and an action to **download that user's file** (closes defect #22 / `SPEC §2`). The admin already
  has everything needed client-side: fetch that user's decisions and overrides and build the
  workbook in the browser. Add `GET /api/decisions?user=<username>` and
  `GET /api/overrides?user=<username>`, **admin-only**, and make the authorisation check explicit
  and tested — a picker must never be able to read another picker's data through these. Add a
  Worker test for exactly that.
- Warn visibly if the starter passwords in `worker/users.ts` are still in place, and point to
  `npm run user:add`.
- Optional language toggle (§5.1 item 28) if and only if P0+P1 are done and green: a single
  `web/src/i18n.ts` with a flat key→string map for English and Hindi, a toggle in the header
  persisted to `localStorage`, product names and numbers never translated. Ask me before starting
  this.

### 8.9 Copy rules

Every word on screen is part of the UI. Apply these:

- Short sentences. Common words. No jargon: not "SKU", "catalog", "sync", "export", "workbook",
  "override", "validation". Say: product, list, saved, file, your price, changed.
- Label buttons with the action's outcome: `Make my file`, `Save changes`, `Start checking
  products` — never `Submit`, `OK`, `Proceed`.
- Errors say what happened, then what to do: `No internet. Your work is saved on this phone and
  will sync when you're back online.`
- Counts always carry their noun: `128 items`, not `128`.
- ₹ always immediately before the number, `en-IN` grouping (`formatRupees` in `deck.ts` already
  does this — reuse it, don't re-implement).
- Destructive confirmations state the number: `Mark all 158 products as not stocked?`
- No emoji as UI controls. The existing inline SVG icons are right; keep that approach and keep
  explicit `width`/`height` on every `<svg>` (the codebase comments explain why — an `<svg>` with
  only a `viewBox` renders at 300×150).

### 8.10 Accessibility and resilience floor

- Every control reachable and operable by keyboard; visible focus; logical tab order.
- `aria-live="polite"` on the sync chip and on counts that change without a navigation.
- `aria-label` on icon-only buttons (already done in `deck.ts` — hold the standard).
- Screen reader: the 3-state toggle must announce its state, not just its name.
- Works at 200% browser zoom and at 320px width without horizontal scroll.
- Every async action has a loading state, a success state, and an error state with a retry.
- Offline: every write path (decide, bulk, edit, undecide) queues and survives a reload. Test in
  airplane mode, not just by mocking.
- Session expiry mid-session must land on login with a clear message and no lost local work.

---

## 9. Explicitly out of scope — do not build these

Scope creep is the main way this goes wrong. Do not build, and do not ask to build:

- Any new runtime dependency, framework, build step, or CSS library.
- Accounts, signup, password reset, email, OAuth, roles beyond admin/picker.
- Editing category, business category, images, SKU, variant fields, or Best Seller.
- Multiple catalogs, per-store catalogs, catalog versioning/rollback UI.
- Comments, chat, notifications, presence, real-time anything.
- Analytics, telemetry, third-party scripts, cookie banners.
- Onboarding carousels, tours, tutorials, animated mascots, confetti.
- Service worker / PWA install flow / push (SPEC `§3` keeps this out of v1).
- Charts, dashboards, trend lines, "insights", exports to CSV/PDF.
- AI/recommendations/auto-categorisation of any kind.
- Theme pickers beyond honouring `prefers-color-scheme`.
- Rewriting `xlsx.js` to use a spreadsheet library. `SPEC §4.2` explains why this destroys the
  product. Do not.

If you believe something here is genuinely required, say so in one sentence with the user moment
that demands it, and wait.

---

## 10. Phases and gates

Each phase ends with its gate green and a commit. Do not start the next phase with a red gate.

**Phase 0 — Audit. ✅ DONE.** See `AUDIT.md` and `audit-evidence/`. Start at Phase 1.

**Phase 1 — Spec + foundations.** `SPEC.md` amended (§6). `DESIGN.md` written. `styles.css`
tokenised: spacing/type/radius scales, dark mode (`D-14`), `:focus-visible` (`D-13`), 44px floor
(`D-12`), contrast fixes (`D-15`), dead CSS removed (`D-21`), inline styles moved to classes
(`D-24`). A shared toast/confirm primitive. A shared product-row component used by list, review,
search and export.

**Do `D-04` and `D-05` first, before anything else in this phase.** They are the two cheapest fixes
in the whole project and the two most visible: `D-04` is the home screen rendering
`CHOCOLATES40 / 102` (two CSS declarations), `D-05` is the 38px dead zone where visible category
tiles cannot be tapped. Ship them, look at the result, then continue.

*Gate:* `npm run typecheck` clean, `npm test` green, every existing screen still works, no visual
regression you can't justify, contrast ≥4.5:1 measured in both themes, and `D-04`/`D-05`
re-measured with `audit-evidence/probe2.mjs`.

**Phase 2 — Durable, changeable decisions.** `value: null` on `POST /api/decisions`; store and
outbox handle undecide; the resume/progress correctness fix (defect #6); `#/review` with three
tabs; list mode with bulk select and undo toast; search on home.
*Gate:* `npm test` green; `npm run verify:api` green with new cases for undecide and for
cross-user isolation; manual script — decide 20 items, flip 5 from review, reload, confirm the
server agrees; airplane-mode test on every new write path.

**Phase 3 — Editing.** `override` table + migration; `/api/overrides` both ways; outbox support;
`applyOverrides` in `xlsx.js`; the edit sheet with live validation; `Edited` badges; edited values
rendered everywhere; tests T-1.13 … T-1.22.
*Gate:* `npm test` green including all new T-1 tests. That includes `npm run verify:excel`, which
drives **real Excel via COM** on this machine and asserts the validations, table definitions and
sheet protection survived an actual Excel open — if Excel had silently repaired the file, those
assertions fail. So do not ask me to open Excel by hand; run the script. Also: openpyxl loads with
no warnings, unedited rows byte-identical, `sharedStrings.xml` byte-identical, price > MRP
impossible to export.

**Phase 4 — The surround.** Home rebuilt (§8.2), deck surround (§8.3), export with item list +
share + success state (§8.7), admin (§8.8), all copy passed against §8.9.
*Gate:* the full walk-through in §11 completed on a real phone-sized viewport, start to finish,
with nothing to explain out loud.

**Phase 5 — Hardening.** Run `code-review` at `high` over the whole diff and fix what it finds.
Run `security-review` (this thing authenticates users and serves per-user data; the new admin
cross-user endpoints are exactly the shape of bug that matters). Re-run `npm test`, `npm run
typecheck`, `npm run verify:api`, `npm run verify:scale`, `npm run verify:images`. Update
`README.md` for the new flows in language the operator can follow. Update `SPEC.md §10` with the
new tests and tick `§11`.
*Gate:* everything green, `README.md` and `SPEC.md` truthful, working tree clean.

### Git discipline

Work on a branch, not `main`. One commit per phase minimum, message stating what changed and why.
Never commit `.test-output/`, `.wrangler/`, `dist/`, or `node_modules`. Do not push or open a PR
unless I ask.

---

## 11. Definition of done — the walk-through

Not a checklist of features. This is the acceptance test, and I will run it myself. Do it on a
360×640 viewport with touch emulation, and then again on a real phone if you can.

1. Open the link cold on a phone. Log in. **Within 5 seconds I can tell what I'm being asked to
   do and where to tap**, without reading a paragraph.
2. Tap the primary action. Decide 10 products by swiping. The count on screen matches what I did.
3. Switch to List. Select all in this category, then unselect 3. Counts still agree. Undo the bulk
   action from the toast; counts return exactly.
4. Search `lay`. Results appear with their state. Toggle two from the results. Go home — those two
   are reflected in that category's numbers.
5. Open Review → Stocked. Flip one to not-stocked. Open Not stocked — it is there.
6. Kill the browser. Reopen. **Continue where you left off** takes me back to the right category
   and the right product. Nothing is lost.
7. Turn on airplane mode. Decide 5 products, bulk-select a category, edit a price. The chip says
   offline; nothing is blocked; nothing errors. Turn the network back on — everything syncs, and a
   reload confirms the server agrees.
8. Open a product's Edit sheet. Change the name from `5 STAR 20 GM` to `5 STAR 25 GM`. Set MRP 40
   and selling price 45 — **I am told I cannot, in words, before I can save**. Set 38 and save.
   The card, the list, review and export all show the new values with an `Edited` badge.
9. Reset that product's price to original. The badge stays for the name, the price shows the
   catalog value.
10. Log in as the same user on a different browser. **The edits and decisions are there.** Log in
    as a different picker — **they are not.**
11. Go to Export. The item list is there, counts agree with home, the 1 edited product is marked.
    Remove one item; the count drops everywhere.
12. Tap `Make my file`. It builds. I get a success state, a filename, and a Share button that
    actually opens the share sheet on Android.
13. **Open the file in Excel.** No repair prompt. The edited row shows `5 STAR 25 GM` and ₹38 as a
    *number*. Dropdowns in columns G/H/N still work. Every unedited row is exactly as it was in the
    master. Row count = selected count + 1 header.
14. Run `npm test` — green, including T-1.13 … T-1.22. Run `npm run typecheck` — clean.
15. Log in as admin. Upload the master sheet again: progress is visible, the catalog info updates,
    **decisions and edits survive the re-upload**. The progress table shows each user with last
    active, and downloading a user's file produces the same file that user would get.
16. Dark mode: switch the phone to dark. The app is dark, readable, and nothing is invisible.
17. Keyboard-only on a laptop: reach and operate every control, with visible focus throughout.
18. Nowhere in any of the above did I have to be told what a button does.

---

## 12. Skills and tools to use

- **`artifact-design`** — load before writing CSS or laying out any screen.
- **`run`** — to actually launch and drive the app. `npm run dev` (UI on :5173) with
  `npm run dev:api` (Worker on :8787) alongside; `npm run db:local` seeds the local D1. Audit and
  verify by looking at the running app, with screenshots, not by reading source.
- **`code-review`** at `high` — over the diff at the end of each phase, and over the whole diff in Phase 5.
- **`security-review`** — Phase 5, especially the admin cross-user endpoints.
- **`dataviz`** — only if you build anything chart- or meter-shaped beyond a progress bar.
- **Web search** — use it for current, verifiable answers on: `navigator.share` with files support
  on Android Chrome and iOS Safari; OOXML `inlineStr` acceptance in consumer spreadsheet tools;
  iOS Safari blob download behaviour; touch-gesture/`touch-action` pitfalls on Android. Cite what
  you relied on in `AUDIT.md`. Do not guess at platform behaviour you can check.

Prefer the repo's own scripts over ad-hoc checks: `npm test`, `npm run typecheck`,
`npm run verify:api`, `npm run verify:scale`, `npm run verify:images`, `npm run verify:excel`.

---

## 13. When to come to me, and when not to

I want to be interrupted rarely and for the right reasons. Respect this list in both directions —
do not stall waiting for me on something you can decide, and do not barrel past the three real gates.

**Stop and wait for me (only these):**

1. Before starting the Hindi language toggle (§8.8), if you get that far.
2. A decision that contradicts this brief or `AUDIT.md`, or a new runtime dependency. One
   sentence, your recommendation, then wait.

That is the whole list. Phase 0 is already signed off — do not ask me to approve a plan.

**Do not wait for me — verify it yourself:**

- Excel repair-prompt check → `npm run verify:excel` (real Excel via COM, automated here).
- Independent read-back of the file → `npm test` runs the openpyxl pass.
- Anything you'd be tempted to ask me to "look at" → re-run `audit-evidence/measure.mjs`, which
  boots the app in headless Chrome, measures every control and screenshots all seven screens. The
  before-picture is already in `audit-evidence/`; diff against it.
- Tap targets, contrast, hit-testing, focus rings, dark mode → `audit-evidence/probe2.mjs`.
- Offline/airplane-mode behaviour → devtools network offline, then reload and inspect what synced.
- Cross-user isolation on the new admin endpoints → write the Worker test; don't ask me to try it.

**Batch everything else.** At each phase gate, report in one message: what you built, gate output
(paste the real test lines), what you decided that I should know about, and anything you deferred.
Do not ask permission mid-phase for work this brief already authorises.

**Things only I can do, at the very end — list them for me, don't attempt them:**

- Applying the `override` table migration to the **live remote** D1 (`npm run db:remote`) and
  deploying (`npm run deploy`). Write the exact commands in your handover; I will run them.
- Testing on a real phone: the `navigator.share` sheet, sunlight legibility, one-thumb reach.
- Uploading a generated file to Amazon SmartBiz — the final acceptance in `SPEC §11`.
- Rotating the starter passwords in `worker/users.ts`.

---

## 14. How I will judge this

- **Did the file survive?** Byte-identity for untouched parts and untouched rows, no repair prompt,
  numbers still numbers. Everything else is negotiable; this is not.
- **Can a shopkeeper finish alone?** If any step in §11 needs a phone call, it's not done.
- **Is every decision reversible from somewhere obvious?**
- **Do the numbers on screen ever disagree with each other?** They must never.
- **Is it still small?** No framework, one runtime dependency, a Worker that stays under 10 ms, a
  bill of ₹0. A bigger codebase that does these things is a worse answer than a small one.
- **Would the next engineer understand why?** `SPEC.md`, `DESIGN.md`, `README.md` and the comments
  in `xlsx.js` and `store.ts` are part of the deliverable, not paperwork. The existing comments in
  this repo explain *why*, not *what* — match that standard.

Read `AUDIT.md`, then start with Phase 1 — `D-04` and `D-05` first.
