-- Production v2 migration (SPEC.md §6.1): per-user, per-field catalog overrides.
--
-- A pre-production `override(username, sku, patch)` table may exist from an earlier
-- iteration. Its shape is incompatible with the v2 contract, so it is replaced.
-- Safe to run on the live database: decisions and catalogs are untouched, and v2
-- overrides did not exist before this migration (nothing to preserve).
-- Operator runs (from the repo root):
--   local:  npx wrangler d1 execute stock-picker-db --local --config wrangler.local.toml --file=./scripts/migrate-v2.sql
--   live:   npm run db:migrate
DROP TABLE IF EXISTS override;
CREATE TABLE override (
  username   TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  field      TEXT    NOT NULL,   -- 'name' | 'size' | 'mrp' | 'price'
  value      TEXT    NOT NULL,   -- always stored as text; numbers are parsed at use
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, sku, field)
);
CREATE INDEX idx_override_user ON override (username);
