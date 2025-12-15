-- Migration 0004: Audit and raw document tables

-- Raw documents (audit trail)
CREATE TABLE IF NOT EXISTS raw_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now')),
  r2_key TEXT NOT NULL,
  sha256 TEXT,
  parse_status TEXT DEFAULT 'pending', -- 'pending' | 'success' | 'error'
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_raw_documents_source ON raw_documents(source_name);
CREATE INDEX IF NOT EXISTS idx_raw_documents_fetched_at ON raw_documents(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_documents_parse_status ON raw_documents(parse_status);

-- Mapping queue (divisions waiting to be mapped)
CREATE TABLE IF NOT EXISTS mapping_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id TEXT NOT NULL UNIQUE,
  discovered_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'new', -- 'new' | 'in_progress' | 'done'
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (division_id) REFERENCES divisions(id)
);

CREATE INDEX IF NOT EXISTS idx_mapping_queue_status ON mapping_queue(status);
CREATE INDEX IF NOT EXISTS idx_mapping_queue_discovered_at ON mapping_queue(discovered_at);
