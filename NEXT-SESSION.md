# Where this stands

Last updated 2026-09-14. Every number below was measured or run, not estimated.

## Verification status

| Suite | Result |
|---|---|
| `npm test` (Excel fidelity, scale, independent openpyxl, real Excel via COM) | **50 passed, 0 failed** |
| `node .probe/ui-check.mjs` (browser, 320/360/414px, light + dark) | **39 passed, 0 failed** |
| `node .probe/ui-check-admin.mjs` (admin + export at full catalog size) | **18 passed, 0 failed** |
| `npm run typecheck`, `npm run build` | clean |

---

## Production status

**The code is deployed** to the project's `workers.dev` URL
(version `fe59b22e-3b93-47a2-9b7f-b0b41e7edf4d`, deployed 2026-09-14).
Run `npx wrangler deployments list` for the address — this repository is public, so the live
URL is deliberately not written down here.

Deliberately **not** deployed: the QuickVerse catalog. See below.

Verified after deploy — nothing was disturbed:

| | Before | After |
|---|---|---|
| Live catalog | Master excel.xlsx, 650 products | unchanged |
| store1's decisions | 375 (212 stocked) | unchanged |
| Frontend bundle | old | new build serving (`index-D9qt21iN.js`) |
| `GET /api/me` unauthenticated | 401 | 401 |

The new UI was run against the **650-product live catalog shape** before deploying, not just
against QuickVerse: list scroll, steppers, swipe, edit sheet, and overflow at 320/360/414px all
pass. The only assertions that failed were the harness's own hard-coded QuickVerse numbers
(`2,279 products`, `27 categories`, and a price-equals-MRP case that legitimately differs).

### Still outstanding

**1. The QuickVerse catalog swap — held on purpose.**
`store1` has **375 decisions (212 stocked)** on the live 650-product catalog. QuickVerse has no
real SKUs (all synthetic `qv-…`), and the old catalog uses real column-A SKUs, so **the overlap
is zero** — activating QuickVerse makes all 375 invisible and restarts store1 at 0 / 2,279.
Nothing is deleted; re-activating catalog `id 1` brings it back. But tell store1 first.

When ready:
```bash
node scripts/seed-local.mjs <your-live-url> "QuickVerse_Master_Catalog.xlsx"
```
(or upload it from the Admin screen — same 5-step flow). No DB migration needed; the `override`
table already exists live.

**2. Rotate every account password — do this first.**
`worker/users.ts` still carries the starter accounts shipped with the project, and this
repository is **public**, so those defaults are readable by anyone. The app is now live. Until
the accounts are rotated, treat the deployment as open to whoever finds the URL.

```bash
npm run user:add admin <a-real-password>    # repeat for each store account
# paste each printed line into worker/users.ts, replacing that user's entry
npm run deploy
```

**3. Try it on a real phone.** Everything here was Chromium emulation. Haptics
(`navigator.vibrate`) and momentum scrolling cannot be judged any other way.

---

## What was fixed

### The new catalog can be loaded at all
`QuickVerse_Master_Catalog.xlsx` has **no SKU IDs** — column A blank on all 2,279 rows (normal;
SmartBiz assigns them). The parser rejected the file outright.

`web/src/xlsx.js` now derives a **synthetic SKU** for any named row with a blank column A:
an FNV-1a 64-bit hash of name + product category + business category + MRP + image URL, as
`qv-<16 hex>` (e.g. `qv-6e65a79f1fc77d1e`), with `-2`/`-3` suffixes on collision.

- Stable across processes and re-uploads → **choices and price fixes survive a re-upload.**
- Internal only — column A stays blank in every export (proven byte-for-byte, `T-QV.4`).
- Real column-A SKUs still take precedence and still reject duplicates.

Catalog: **2,279 products, 27 categories**, 2 without images, 0 rows with price > MRP.

### List mode could not scroll
Root cause: `.screen-deck` was `overflow:hidden` and was never actually `display:flex`, and the
list panel had no scroll container. 316 rows rendered, nothing past the fold reachable.
Now a strict flex column with `.deck-list` as the single scroller — verified `3919px of content
in a 523px viewport, scrolled to 3396`.

### Editing is direct manipulation
`web/src/stepper.ts` + `web/src/units.ts`, used on the card and in the sheet:
- `[−] value [+]`, minus left, plus right. Tap steps once.
- **Press-and-hold ramps up** (400ms delay, 220→90→45ms ticks, ×1→×5→×10) and **stops dead on
  release** — verified: a 2.2s hold moved 19 steps, then held still.
- **Drag the number** to scrub, 14px per step. Tap it cleanly to type an exact value.
- Verified a stepper drag does **not** fling the card, while a card swipe still decides.
- Price clamps at MRP (`+` disables) because the export fails closed above it.

Pack size is `[−] 250 [+] [g]` with a `g/kg/ml/L/pc` pill, pre-filled by parsing the product
name — **88% of the 2,279 names auto-detect** (2,010), with correct rejections (`Maggi
2-Minute Noodles` → nothing, `Vitamin B12` → nothing). Changing unit does not convert the number.

The old four-field scrolling form is gone: the sheet is **492px of content in a 492px box —
no scrolling** on a 640px phone.

### Layout, measured before → after at 360px
| | Before | After |
|---|---|---|
| List-mode toolbar height | 116px (chips wrapped to 3 rows) | **108px**, chips on one swipeable row |
| Card body | 225px | **207px** |
| Product image | 188px | **206px** |
| Gap between progress label and sync chip | **−81px (overlapping)** | **+8px** |

The overlap had a real cause: `.deck-progress__label` is a `<span>`, so `text-overflow:
ellipsis` never applied — an inline element ignores width constraints. Fixed with `display:
block`. At 320px the overlap was −121px.

Also: the redundant ` · <category>` is gone from deck list rows (you are already inside that
category); it survives in search and export, where rows span categories.

### Admin was reporting numbers that were wrong
Found by the new harness: `/api/progress` counts **every** `decision` row a user has. Decisions
are keyed by `(username, sku)` on purpose so they survive a re-upload, so a shop carries rows
for SKUs from older catalogs — and the raw count can exceed the catalog size. The table then
invented "no" decisions nobody made (a shop showed **Yes 2279, No 4** on a 2,279-product list).

The worker can't filter it — the SKU list is in KV and parsing it per request would blow the
10ms CPU budget. So `admin.ts` now recounts client-side the way `store.ts` does everywhere else:
walk the live products, look each SKU up, never the reverse. Now reads **Yes 2279, No 0, Left 0**.

### Everything else
- Home search results moved out of the `position:sticky` header — they used to grow it past the
  viewport and push the category grid out of reach.
- Search placeholder was hard-coded "650 products" → derived (2,279).
- Review's 300-item cap and "search on home" dead-end → incremental rendering, in-scope search,
  sticky tabs.
- `main.ts` catches a throwing screen instead of showing a blank white page.
- Admin: table scrolls sideways, upload confirms and names the file, drag-and-drop, progress bars.
- Toasts raised above dialog scrims; `trapFocus` + ref-counted `lockBodyScroll`.
- `--overlay`/`--overlay-strong` tokens — the old `rgba(0,0,0,.05)` overlays were invisible in
  dark mode. No hard-coded overlay colours remain outside `:root`.
- Undo moved to the top bar so both decide buttons get full footer width.
- Export's "Review my list" was a 17px inline link → a real button.
- A raw NUL byte (0x00) in `review.ts` replaced with the ``\u0000`` escape — it made the file read
  as *binary* to git, grep and diff.
- `README.md` and `SPEC.md` corrected: the "every product needs a SKU ID in column A" claim was
  false and was the first thing anyone would read when an upload misbehaved.

Export of the full 2,279-item catalog builds in the browser in **250ms**.

---

## Housekeeping

- **Nothing is committed.** `git status` shows the full diff.
- Local dev DB now has `store2` with all 2,279 products stocked — scale-test data, local only.
- `.probe/` is gitignored scratch (Playwright, the two harnesses, screenshots in
  `.probe/shots/`). Safe to delete. Worth keeping if you want the browser suite; promoting it
  to `scripts/` would mean adding Playwright as a devDependency.
- A local `wrangler dev` may still be running on port 8787.

## Re-running the checks

```bash
npm test
npm run typecheck && npm run build
npx wrangler dev --config wrangler.local.toml --port 8787          # terminal 1
node scripts/seed-local.mjs http://127.0.0.1:8787 "QuickVerse_Master_Catalog.xlsx"
node .probe/ui-check.mjs
node .probe/ui-check-admin.mjs
```
