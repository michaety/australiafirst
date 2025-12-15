-- Migration 0002: Division mappings table

CREATE TABLE IF NOT EXISTS division_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'pro' | 'anti'
  strength REAL DEFAULT 1.0,
  rationale TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  UNIQUE(division_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_division_mappings_division ON division_mappings(division_id);
CREATE INDEX IF NOT EXISTS idx_division_mappings_category ON division_mappings(category_id);
