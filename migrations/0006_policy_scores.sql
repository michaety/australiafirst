CREATE TABLE IF NOT EXISTS politician_policy_scores (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL REFERENCES politicians(id),
  policy_id INTEGER NOT NULL,
  policy_name TEXT NOT NULL,
  policy_description TEXT,
  agreement_pct REAL,
  votes_count INTEGER,
  source TEXT NOT NULL DEFAULT 'TVFY',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(politician_id, policy_id)
);
