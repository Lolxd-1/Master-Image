# Stock Picker — Design System (production v2)

Companion to `SPEC.md §9` and `AUDIT.md`. Read before writing CSS or laying out a screen.

## Tokens

Palette keeps its character (`--bg #faf7f2`, paper + ink), made complete and themeable.
All colour is consumed via tokens — no literal hex outside `:root` / dark block.

```
--bg, --surface, --line
--ink (#1c1a17), --ink-2 (#4a4440 — 4.5:1-safe body secondary), --ink-3 (#5c554d — large/bold only)
--accent #0b5bd3 (4.5:1 on white), --accent-ink #ffffff
--yes #0e6b43 (4.5:1 on white), --yes-soft #dff2e6, --yes-ink #0b5a38
--no #b3261e (4.5:1 on white), --no-soft #fbe4e1, --no-ink #8f1d17
```

Contrast floor: body text ≥ 4.5:1, large (≥18px / 14px bold) + UI boundaries ≥ 3:1, both themes.
Greens/reds never the sole carrier — always paired with ✓/✗ glyph + text label (red-green safe).

Dark palette under `@media (prefers-color-scheme: dark)` redefines tokens only —
no component rewrites. Verified: body text ≥ 4.5:1 on dark surface.

## Scale

Spacing: `--sp-1 4px · --sp-2 8px · --sp-3 12px · --sp-4 16px · --sp-5 20px · --sp-6 24px · --sp-8 32px`
Radius: `--r-sm 10px · --r 16px · --r-lg 20px · --pill 999px`
Type (5 max, tabular numbers for counts/prices): `--fs-xs 12px · --fs-sm 13px · --fs 15px (min body) · --fs-lg 17px · --fs-xl 21px · --fs-2xl 30px`
`font-variant-numeric: tabular-nums` on counts, prices, progress labels.

## Tap targets & layout

- 44px minimum every interactive element, 48px primary actions (D-12). 8px min gap, 16px if destructive.
- Fixed footers: opaque (`pointer-events:auto` only on the bar itself) + `padding-bottom` on scroll content
  equal to footer height — never a transparent gradient dead zone over tappable content (D-05).
- Category tile name + count are block-level (stacked, never run-together) (D-04).
- `env(safe-area-inset-*)` on all fixed bars; `prefers-reduced-motion: reduce` disables motion.
- 320px width, no horizontal scroll; 200% zoom operable.

## Focus & a11y

- `:focus-visible` 2px `var(--accent)` ring + offset on everything focusable (D-13). Never `outline:none` without replacement.
- `aria-live="polite"` on sync chip + changing counts; icon-only buttons keep `aria-label`;
  3-state toggles expose state via `aria-pressed` / `role="switch"` labelling.
- Inline SVG icons carry explicit `width`/`height` (bare `viewBox` renders 300×150).

## Copy (SPEC §8.9, enforced)

Short sentences, common words. Never SKU/catalog/sync/export/workbook/override/validation on screen.
Say product / list / saved / file / your price / changed. Buttons name outcomes:
`Start checking products`, `Make my file`, `Save changes` — never Submit/OK/Proceed.
Errors say what happened + what to do. Counts carry nouns (`128 items`). ₹ immediately before number,
`en-IN` grouping. Destructive confirms state the number. No emoji as controls.
