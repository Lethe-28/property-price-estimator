-- Property Price Estimator: database setup (SQLite).
--
-- The app runs SQLite inside the browser (sql.js, a WebAssembly build of SQLite) and keeps the
-- database file in the browser's IndexedDB. The app executes this file when it opens the database,
-- so it is safe to run repeatedly. You can also run it by hand:
--     sqlite3 listings.db < database/schema.sql
-- and open a file exported from the app ("Download database") with any SQLite tool.

PRAGMA foreign_keys = ON;

-- One row per imported file.
CREATE TABLE IF NOT EXISTS imports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT    NOT NULL,
  imported_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  rows_read      INTEGER NOT NULL DEFAULT 0,   -- data rows found in the file
  rows_stored    INTEGER NOT NULL DEFAULT 0,   -- rows that passed validation
  rows_rejected  INTEGER NOT NULL DEFAULT 0    -- rows with no usable price or property type
);

-- One row per accepted listing. Columns match the public dataset the model was trained on.
CREATE TABLE IF NOT EXISTS listings (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id            INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  source_id            TEXT,                                   -- the file's own listing id, if it had one
  property_type        TEXT    NOT NULL CHECK (property_type IN ('house', 'condo', 'lot', 'commercial')),
  price_php            REAL    NOT NULL CHECK (price_php > 0), -- asking price in pesos
  sqm                  REAL,                                   -- floor area, m2
  lot_area_m2          REAL,
  bedrooms             REAL,
  bathrooms            REAL,
  city                 TEXT,
  province             TEXT,
  region               TEXT,
  lat                  REAL,
  lng                  REAL,
  city_known           INTEGER NOT NULL DEFAULT 0 CHECK (city_known IN (0, 1)), -- 1 if the city is in the model's training data
  predicted_price_php  REAL                                    -- Random Forest estimate, filled in at import
);

CREATE INDEX IF NOT EXISTS idx_listings_type   ON listings(property_type);
CREATE INDEX IF NOT EXISTS idx_listings_region ON listings(region);
CREATE INDEX IF NOT EXISTS idx_listings_import ON listings(import_id);

-- Asking price against the model's estimate. gap_pct = -0.30 means "asks 30% less than the model says".
CREATE VIEW IF NOT EXISTS listing_gap AS
SELECT l.*,
       (l.price_php - l.predicted_price_php) / l.predicted_price_php AS gap_pct
FROM listings AS l
WHERE l.predicted_price_php IS NOT NULL AND l.predicted_price_php > 0;
