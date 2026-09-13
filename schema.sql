-- Stock Picker D1 schema. See SPEC.md §6 (frozen contract) — do not alter shape here
-- without updating SPEC.md first.

-- One row per uploaded master sheet. Only one is active.
CREATE TABLE catalog (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL,
  uploaded_by TEXT    NOT NULL,
  uploaded_at INTEGER NOT NULL,
  product_count INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0
);

-- One row per user per product. Absent = undecided. Keyed by SKU alone (not by
-- catalog): SKU IDs are stable Amazon UUIDs, and decisions must survive a
-- catalog re-upload (SPEC.md §6). The export only ever walks the *current*
-- catalog's product list, so a decision for a SKU that later disappears is
-- simply never shown or exported — it is inert, not deleted.
CREATE TABLE decision (
  username   TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  value      INTEGER NOT NULL,   -- 1 = yes (stocks it), 0 = no
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, sku)
);
CREATE INDEX idx_decision_user ON decision (username);

-- Per-user, per-field corrections to the catalog. Absent = use the catalog value.
-- Keyed by (username, sku) like `decision`: corrections survive a catalog re-upload.
-- Apply with: npm run db:local (local) and npm run db:remote (live) — CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS override (
  username   TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  field      TEXT    NOT NULL,   -- 'name' | 'size' | 'mrp' | 'price'
  value      TEXT    NOT NULL,   -- always stored as text; numbers are parsed at use
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, sku, field)
);
CREATE INDEX IF NOT EXISTS idx_override_user ON override (username);
