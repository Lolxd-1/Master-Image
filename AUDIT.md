# Stock Picker — UI/UX Audit

**Date:** 2026-09-10 · **Auditor:** senior review, pre-production
**Subject:** the working MVP at commit `cddc801`, audited as a shopkeeper would meet it
**Companion document:** `UI-PRODUCTION-BRIEF.md` (the build brief this audit feeds)

---

## 0. Method — what was actually done

This audit was **measured against the running application**, not inferred from source. Anything
below marked *measured* has a number behind it in `audit-evidence/report.json`.

| Step | What was done |
|---|---|
| Build + serve | `npm run build`, then `wrangler dev --config wrangler.local.toml` on `:8787` (Worker + SPA on one origin, as in production) |
| Real data | `node scripts/seed-local.mjs` — the real `Master excel.xlsx`, all **650 products / 11 categories**, through the real 5-step admin upload flow |
| Real state | 65 decisions written through `POST /api/decisions` to create a *partly-done* category (CHOCOLATES 40/102), a *finished* one (CHEWING GUMS 10/10) and *untouched* ones. Combined with pre-existing local rows, `store1` measured at **209/650 decided, 137 yes** |
| Instrumentation | Headless Chrome driven over the DevTools Protocol by a zero-dependency driver (`audit-evidence/cdp.mjs`). No new project dependencies were installed |
| Measured | Every interactive element's rendered box, font size and **computed WCAG contrast against its effective background**; pairwise tap-target gaps; `elementFromPoint` hit-testing; horizontal overflow; focus-style deltas; dark-mode response |
| Viewports | **360×640** (budget Android — the target device), **390×844** (iPhone-class), **320×568** (worst realistic case) |
| Screens | login, home, deck-partial, deck-complete, deck-untouched, export, admin — as both `picker` and `admin` roles |

Evidence in `audit-evidence/`: `report.json` (full measurements), seven 360×640 screenshots, and the
three scripts, so every number here is reproducible.

**Baseline health, verified before auditing:** `npm run typecheck` clean;
`node scripts/verify-xlsx.mjs` → **11 passed, 0 failed**. The Excel engine is in good shape. This
audit is about everything wrapped around it.

---

## 1. Verdict

The MVP does the hard thing well. The swipe deck is genuinely good, the offline outbox is properly
engineered, and the export is faithful in a way that most implementations of this problem are not.

It is not shippable to a shopkeeper yet, for one reason above all others:

> **A decision cannot be changed once you leave the screen.**

Everything else on this list is a defect. That one is a *product hole* — and it is the thing a
real user hits within ten minutes, because he will mis-tap, and then discover the app has no way
to fix it. Measured proof is in §3, D-01.

Beyond it sit two more holes of the same kind — he cannot **see** what he selected, and he cannot
**correct** data that is wrong about his shop — plus one outright rendering bug on the home screen
that source review alone would never have caught (D-04).

Count: **7 P0**, **13 P1**, **6 P2**.

---

## 2. Walk-through — where a shopkeeper stops and has to think

Each line is a moment of hesitation, with where it comes from.

### Login → `web/src/screens/login.ts`
1. The screen says `Stock Picker` and nothing else. No line saying what this is or who sent it.
   For someone opening a link from WhatsApp, the first question — *am I in the right place?* — is
   unanswered. `login.ts:14`
2. Password is masked with no reveal toggle. On a cracked budget phone this is the single most
   common point of failure, and the only feedback is `Incorrect username or password.` after the
   fact. `login.ts:22-24`
3. No support route. When it fails he has nothing to do but phone the operator.

### Home → `web/src/screens/categories.ts`
4. **The category tiles are malformed.** They read `CHOCOLATES40 / 102`, `INSTANTS & MIXES0 / 68`
   — name and count glued together. This is a real rendering bug (D-04), visible in
   `audit-evidence/home-360x640.png`. His first impression of the app is a typo.
5. The big number is `209 of 650 decided`. He does not care how many he has *checked*; he cares
   **how many he stocks**. That number (137) appears only inside the download button's label.
   `categories.ts:129,134`
6. Nothing says *what to do next*. There is no "start" and no "continue" — on his second visit he
   must remember, unaided, which category he was in.
7. He wants to know if he stocks Lay's. There is no search anywhere in the app (*measured*:
   `hasSearchInput: false` on every screen).
8. `Download my list (137 items)` is the most prominent thing on screen from the very first visit,
   before he has decided anything. The most emphasised control is the one he should touch last.
9. The bottom tile is visibly cut by the download bar. **38px of `CRUSH & SYRUPS` sits under the
   footer** (*measured*), and the footer's gradient is transparent at its top edge — so he sees a
   tile, taps it, and hits the download bar instead (D-05).

### Deck → `web/src/screens/deck.ts`
10. He taps `CHOCOLATES` and the top bar reads — *measured, verbatim* — **`40 / 102 Saved`**. The
    category name is nowhere in the top bar. He has to infer from the small grey chip on the card
    that he is where he meant to be. `deck.ts:141-148`
11. The two big buttons are **icon-only** — a bare ✗ and ✓ with no words. `SPEC §9.3` specifies
    "✗ Don't stock / ✓ Stock it"; the words were never rendered. The labels exist only as
    `aria-label`. `deck.ts:147-148`
12. He mis-taps ✓ on item 12, backs out to home, returns — and **Undo is greyed out**. *Measured:*
    on CHOCOLATES with **40 prior decisions**, `undoDisabled: true` on mount. There is now no way,
    anywhere in the app, to change that decision. This is the moment the app loses him.
13. He finishes CHEWING GUMS. The only button is `Back to categories`. Eleven categories means
    eleven round trips through home. `deck.ts:326-350`
14. `40 / 102` is a cursor, not a fact. It counts how far the pointer has advanced, not how many
    products are decided — the two diverge the moment anything is decided out of order.
    `deck.ts:209-212`
15. Struck-through MRP is `--ink-3` at **3.64:1** contrast (*measured*) at 15px. In sunlight, the
    price comparison — the thing he is actually judging — is the least legible text on the card.

### Export → `web/src/screens/export.ts`
16. `137 items to export` — *export* is not a word he uses. Same for `Build & download file`.
17. He sees four category rows and four numbers. **He cannot see the 137 items.** *Measured:*
    `listsActualItems: false`, `breakdownRows: 4`. He is asked to trust a number he cannot inspect,
    on a file that affects his revenue. He cannot remove a single item from here either.
18. The one instruction that actually matters — `Upload this file to Amazon SmartBiz without
    opening it.` — is the smallest, lowest-contrast text on the screen, below the fold of
    attention. `export.ts:92`
19. He taps the button, the file goes to Android's Downloads folder, and **nothing on screen
    changes** to say it worked. He does not know where the file went and has no way to send it to
    anyone. `export.ts:32-46`

### Admin → `web/src/screens/admin.ts`
20. A raw, unstyled `<input type="file">` — *measured* **22px tall**, half the minimum tap target.
21. Multi-MB uploads show step labels but no byte progress. On a slow line the operator cannot
    tell "working" from "hung".
22. The progress table shows decided/yes/total but no *last active*, and there is no way to pull a
    user's file — which `SPEC §2` explicitly promises the admin can do.

---

## 3. Defect register

Severity: **P0** blocks shipping · **P1** he will notice and resent · **P2** worth fixing.

### P0

| ID | Defect | Location | Evidence | What he experiences |
|---|---|---|---|---|
| **D-01** | **Decisions are irreversible once you leave the screen.** Undo history is a mount-local array; it is empty on every fresh mount. There is no other path to change a decision anywhere in the app. | `deck.ts:194`, `deck.ts:216`, `deck.ts:277` | *Measured:* `undoDisabled: true` on CHOCOLATES with 40 prior decisions | Mis-taps are permanent. He either lives with a wrong file or gives up. |
| **D-02** | **Undo is not durable even in-session.** `clearDecision()` removes the row locally and drops it from the outbox, but `POST /api/decisions` is upsert-only — an already-flushed decision survives on the server and returns on next load. | `store.ts:255-261`; worker `handlePostDecisions` | Acknowledged in `deck.ts:10-14` header comment | Undo appears to work, then silently un-does itself days later. Worst possible failure: it lies. |
| **D-03** | **No way to review what was selected.** Export shows category counts only. No screen lists the chosen items, the rejected ones, or the undecided. | `export.ts:87,99-107` | *Measured:* `listsActualItems: false` | He must trust "137" on faith. He won't. |
| **D-04** | **Home tiles render name and count run together** — `CHOCOLATES40 / 102`. Both are `<span>` (inline); `.cat-tile__count`'s `margin-top` has no effect on an inline box, so it never starts a new line. | `categories.ts:67-73`; `styles.css:219-225` | `audit-evidence/home-360x640.png` | The main screen looks broken on first sight. |
| **D-05** | **Dead tap zone above the download bar.** The fixed footer is 78px tall with `pointer-events: auto` and a gradient transparent at its top; tiles scroll under it while still visible. | `styles.css:232-240` | *Measured:* footer `top:562 bottom:640`; `CRUSH & SYRUPS` `footerOverlapPx: 38` | He taps a tile he can clearly see and the app ignores him — or opens the download screen. |
| **D-06** | **No search.** 650 products, 11 categories, no lookup by name or SKU. | app-wide | *Measured:* `hasSearchInput: false`, all 7 screens | "Do I stock Lay's?" is unanswerable without scrolling 158 cards. |
| **D-07** | **No product editing** — and `SPEC §3` forbids it in writing. Prices, pack sizes and names that are wrong for his shop cannot be corrected. | `SPEC.md:46` | — | He rejects good products, or ships a file with wrong prices. |

### P1

| ID | Defect | Location | Evidence |
|---|---|---|---|
| **D-08** | Resume logic depends on a fragile invariant. Start position is "first undecided", justified by a comment asserting decisions form a *prefix* — true **only** because the deck is the sole way to decide. Search, list-select or review breaks it, and resume lands in a hole. | `deck.ts:20-24`, `deck.ts:191-193` | — |
| **D-09** | Progress is a cursor, not a count. `updateProgress()` renders `pointer`, not decided items — diverges as soon as anything is decided out of order. | `deck.ts:209-212` | — |
| **D-10** | Category name absent from the deck top bar. | `deck.ts:141-148` | *Measured:* top bar text = `"40 / 102 Saved"` |
| **D-11** | Decide buttons are icon-only; `SPEC §9.3` specifies text labels. | `deck.ts:147-148` | `audit-evidence/deck-partial-360x640.png` |
| **D-12** | `Admin` and `Log out` are **1.9px apart**, both **35px tall**, and logout has no confirmation. Admin role only. | `styles.css:181`, `styles.css:84-91`, `categories.ts:99,166` | *Measured:* gap `1.9`, both `35h` |
| **D-13** | **No focus indication on any button.** Every button computes `outline-style: none`; focusing changes nothing. | `styles.css` (no `:focus-visible` rule) | *Measured:* `focusVisibleChange: false`, `outline: "none 3px"` on every button |
| **D-14** | **Dark mode does nothing.** No `prefers-color-scheme` block. | `styles.css:6-20` | *Measured:* body bg stays `rgb(250,247,242)`; light/dark screenshots are **byte-identical** on all 5 screens |
| **D-15** | Contrast failures on the numbers he reads most. | `styles.css:11,160,225,322,328,366,455` | *Measured:* `.cat-tile__count` **3.64**, `.status-chip` **3.41**, `.card__chip` **3.64**, `.card__price-mrp` **3.64**, admin `th` **3.64**, `.btn-decide--yes` **4.09**, `.link-btn` (logout) **4.34** — all below 4.5:1 |
| **D-16** | No bulk selection. Largest category is 158 items, one tap each. | `deck.ts` | 158 products measured in `CRISP & NAMKEENS` |
| **D-17** | No "next category" after finishing one. | `deck.ts:326-350` | — |
| **D-18** | Yes-count is not a first-class number on home; it hides inside a button label. | `categories.ts:129,134` | *Measured:* header reads `209 of 650 decided` |
| **D-19** | Status chip reads `Saved` before anything has been saved — it is the initial field value, not a fact. | `store.ts:84` | *Measured:* `statusChip: "Saved"` on first paint |
| **D-20** | No download success state, and no share path — the file lands in Downloads and he must find it. | `export.ts:32-46` | *Measured:* export screen has **2 controls** total |

### P2

| ID | Defect | Location |
|---|---|---|
| **D-21** | Dead CSS: `.swipe-tint[data-dir]` rules exist but the deck sets `tintEl.style.background` inline. *Measured:* `tintDataDirUsed: false`. | `styles.css:338-339`, `deck.ts:235,262` |
| **D-22** | No YES/NO stamp during drag — colour tint only, and colour is the sole carrier of meaning. | `deck.ts:230-236` |
| **D-23** | Both cards are torn down and rebuilt every decision; the peek card is discarded rather than promoted, re-mounting its `<img>`. | `deck.ts:361-366` |
| **D-24** | Inline `style=` in markup and in JS. *Measured:* 5 inline-styled elements on admin, 3 on deck, 1 on home. | `admin.ts:90`, `categories.ts:56-61`, `deck.ts:38-44` |
| **D-25** | No `aria-live` anywhere — counts and sync status change silently for screen readers. *Measured:* `ariaLive: 0`. | app-wide |
| **D-26** | Unknown routes bounce to `#/` with no explanation. | `main.ts:112` |
| **D-27** | Admin promises in `SPEC §2` that admin can "export any user's file" — not implemented. | `SPEC.md:32`, `admin.ts` |
| **D-28** | English only. For a tier-3 kirana owner a Hindi label set plausibly outranks most of P1 — but it is separable. Deliberately deferred. | app-wide |

---

## 4. Corrections to the brief's seed list — things I got wrong

Stated plainly, because the brief will be read as authoritative.

1. **"Admin and Log out are adjacent" — narrower than claimed.** The `Admin` button renders only
   for the admin role (`categories.ts:98`). A picker sees one control. The 1.9px gap is real
   (*measured*) but affects the **operator only**, not shopkeepers. Still worth fixing; lower blast
   radius than stated.
2. **"Card stack may squeeze on short viewports" — not reproduced.** At the worst case tested,
   320×568, the card measured 395px with a 224px image area and a 153px body; no clipping and
   **no horizontal overflow at any of the three viewports**. Withdraw this concern.
3. **"`.link-btn` renders ~30px tall" — it is 35px.** Still under 44, still a defect, but the
   number in the brief was a guess and this one is measured.
4. **The footer problem is worse and different than described.** The brief flagged a disabled
   button as the issue. The measured defect is a **38px dead zone** where visible tiles cannot be
   tapped (D-05) — a hit-testing bug, not a styling preference.
5. **A defect the brief missed entirely: D-04**, the run-together tile labels. Source review could
   not catch it; it only appears when rendered. It is arguably the most embarrassing thing in the
   app and the cheapest to fix.
6. **`_SX400_` image sizing confirmed working** — *measured* `cardImageSrc` ends `._SX400_.jpg`.
   `SPEC` T-3.8 holds; do not "fix" it.

---

## 5. State-coverage matrix

✅ handled · ⚠️ handled badly · ❌ not handled

| State | Login | Home | Deck | Export | Admin |
|---|---|---|---|---|---|
| First-ever load, nothing decided | ✅ | ⚠️ no start CTA; download bar dominant | ✅ | ⚠️ empty-state is a dead end | ✅ |
| No catalog uploaded | ✅ | ✅ role-aware empty state | ✅ bounced home (`main.ts:88-93`) | ✅ bounced | ✅ |
| Loading / cold boot | n/a | ⚠️ bare text line, no skeleton (`main.ts:33-51`) | ⚠️ | ⚠️ | ⚠️ |
| Offline | ⚠️ generic error | ✅ chip + cache | ✅ writes queue | ❌ build needs network for rows+skeleton, no offline message | ❌ |
| Mid-save | n/a | ✅ chip | ✅ chip | n/a | ⚠️ step labels, no progress |
| Server error | ✅ | ⚠️ boot retry only | ⚠️ | ⚠️ generic | ✅ good messages |
| Partially decided | n/a | ✅ | ✅ resumes | ✅ | ✅ |
| Fully decided | n/a | ⚠️ nothing changes; no "you're done" | ✅ complete panel | ✅ | ✅ |
| 0 selected | n/a | ✅ button disabled | n/a | ✅ clear empty state | n/a |
| Exactly 1 selected | n/a | ✅ singular grammar | n/a | ✅ | n/a |
| All 650 selected | n/a | ✅ | ✅ | ⚠️ 650 rows, no list to scroll | n/a |
| Decision changed after leaving screen | n/a | ❌ **impossible** (D-01) | ❌ | ❌ | n/a |
| Catalog replaced mid-session | n/a | ⚠️ stale until reload | ⚠️ | ⚠️ | ✅ |
| Session expired | ⚠️ bounce, no message | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Product with no image | n/a | ✅ monogram tile | ✅ package icon | n/a | n/a |
| Very long product name | n/a | ✅ `overflow-wrap: anywhere` | ✅ | n/a | n/a |
| Smallest category (SWEETS, 2) | n/a | ✅ | ✅ verified | n/a | n/a |
| Largest category (158) | n/a | ✅ | ⚠️ 158 sequential taps | n/a | n/a |
| Dark mode | ❌ | ❌ | ❌ | ❌ | ❌ |
| Keyboard only | ⚠️ inputs only | ❌ no focus ring | ❌ | ❌ | ❌ |

---

## 6. Measured layout & tap targets

Full data in `audit-evidence/report.json`.

**Under 44px** (all viewports; sizes stable across 320/360/390):

| Element | Measured | Screen |
|---|---|---|
| `.link-btn[data-action=logout]` | **35 × 65.1** | home |
| `.link-btn[data-action=admin]` | **35 × 58.1** | home (admin only) |
| `.link-btn[data-action=refresh-progress]` | **35 × 63.3** | admin |
| `input[type=file]` | **22 × 294** | admin |

**Passing:** login inputs 48h · primary buttons 54h · deck decide buttons 60h × 124w · undo
60h × 52w · icon buttons 48 × 48 · category tiles 86 × 328. The core interaction is correctly sized.

**Adjacency** — `Admin | Log out` gap **1.9px** (both 35h). Category tiles 10px apart, acceptable.

**Hit-testing** — footer occupies `y 562→640` (78px, `pointer-events: auto`). `CRUSH & SYRUPS`
overlaps it by **38px** while fully visible. Scrolled, the sticky header (~100px, 16% of a 640px
viewport) covers tile centres: `INSTANTS & MIXES` centre resolves to `.progress-bar`, not the tile.

**Overflow** — none at 320, 360 or 390. ✅

**Contrast** — see D-15. Root cause is `--ink-3: #8d857a` (`styles.css:11`) used for six different
text roles, plus `--yes` on `--yes-soft` for the primary confirm button (4.09).

**Dark mode** — screenshots byte-identical light vs dark on all five screens.

**Focus** — every button: `outline-style: none`, no change on focus. Only `.form-field input` has a
focus rule (`styles.css:129`).

---

## 7. What is good — do not break it

A rebuild is not warranted. Preserve:

1. **`web/src/xlsx.js`** — the verbatim-splice export. 11/11 fidelity tests pass, 46 of 47 parts
   byte-identical. This is the product.
2. **The offline outbox** (`store.ts`) — synchronous `localStorage` write, debounced batched flush,
   exponential backoff, durable across reload. Extend it; do not replace it.
3. **The swipe interaction itself** — tilt, tint, threshold, prefetch of the next 3 images,
   animation lockout, `_SX400_` sizing. It measures well and reads well.
4. **The card layout** — image hero, 17px name, 21px price. Correct hierarchy.
5. **The Worker's thinness** — every handler a small indexed query or KV pass-through, inside the
   10 ms budget. The 5-step upload with `activate` last is genuinely well designed.
6. **The comments.** They explain *why*. Match that standard.

---

## 8. Recommended phase plan

Unchanged in shape from `UI-PRODUCTION-BRIEF.md §10`, with this audit's ordering applied.

| Phase | Contents | Gate |
|---|---|---|
| **1. Spec + foundations** | Amend `SPEC.md §3` (editing withdrawn as a non-goal). `DESIGN.md`. Tokenise `styles.css`: spacing/type/radius scales, dark palette, `:focus-visible`, 44px floor, contrast fixes (D-13/14/15). **Fix D-04 and D-05 first — one-line-class and one-rule fixes with the highest visible payoff.** Shared toast/confirm + shared product-row component. | typecheck clean · `npm test` green · contrast ≥4.5 measured in both themes · D-04/D-05 re-measured |
| **2. Changeable decisions** | `value: null` on `POST /api/decisions` (D-02). Outbox support. Resume/progress correctness (D-08, D-09). `#/review` three tabs (D-03). List mode + bulk select + undo toast (D-16). Search (D-06). | `npm test` · `verify:api` incl. undecide + cross-user isolation · decide→flip→reload→server agrees · airplane-mode on every new write path |
| **3. Editing** | `override` table + migration. `/api/overrides`. `applyOverrides` in `xlsx.js`. Edit sheet with live `price ≤ MRP` validation. `Edited` badges. Tests T-1.13–T-1.22. | `npm test` incl. `npm run verify:excel` (**real Excel via COM — no manual step**) · unedited rows byte-identical · `sharedStrings.xml` byte-identical |
| **4. Surround** | Home rebuild (D-04, D-18, start/continue CTA). Deck surround (D-10, D-11, D-17, D-22, D-23). Export item list + share + success (D-19, D-20). Admin (D-27 + upload progress). Copy pass. | full §11 walk-through in the brief, at 360×640 |
| **5. Hardening** | `code-review` high over the diff · `security-review` (new admin cross-user endpoints) · full suite · `README.md` + `SPEC.md` truthful | all green, tree clean |

**Sequencing note:** D-08 and D-09 (resume/progress correctness) **must land in Phase 2, before**
search and list-select ship. Those features are precisely what breaks the prefix invariant the
current resume logic silently depends on. Building them first creates a bug that is very hard to
attribute later.

**Cheapest high-value fixes, if you want visible progress on day one:** D-04 (two CSS
declarations), D-05 (one `pointer-events` / padding correction), D-10 (one line of markup),
D-15 (token adjustment), D-13 (one `:focus-visible` rule).

---

## 9. Reproducing this audit

```bash
npm run build
npx wrangler dev --config wrangler.local.toml --port 8787   # in one terminal
npx wrangler d1 execute stock-picker-db --local --config wrangler.local.toml --file=./schema.sql
node scripts/seed-local.mjs
node audit-evidence/measure.mjs     # writes report.json + screenshots
node audit-evidence/probe2.mjs      # hit-testing, adjacency, focus probes
```

`audit-evidence/` is measurement output, not source. Add it to `.gitignore` if you would rather it
not live in the repo — but keep it until Phase 4 is verified, since it is the before-picture.
