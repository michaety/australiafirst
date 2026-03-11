-- Migration 0006: Add party_id support to donations table
-- Allows party-level donations where politician_id is NULL

-- Recreate table with nullable politician_id and new party_id column
CREATE TABLE IF NOT EXISTS donations_new (
  id TEXT PRIMARY KEY,
  politician_id TEXT,
  party_id TEXT,
  donor_name TEXT NOT NULL,
  amount_cents INTEGER,
  year INTEGER,
  source TEXT NOT NULL DEFAULT 'AEC',
  source_url TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO donations_new SELECT id, politician_id, NULL, donor_name, amount_cents, year, source, source_url, notes, created_at FROM donations;
DROP TABLE donations;
ALTER TABLE donations_new RENAME TO donations;

CREATE INDEX IF NOT EXISTS idx_donations_politician ON donations(politician_id);
CREATE INDEX IF NOT EXISTS idx_donations_party ON donations(party_id);
