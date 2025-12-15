-- Migration 0003: Score materialization tables

-- Score runs (versioned scoring)
CREATE TABLE IF NOT EXISTS score_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  framework_version TEXT NOT NULL,
  ran_at TEXT DEFAULT (datetime('now')),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_score_runs_ran_at ON score_runs(ran_at DESC);

-- Politician category scores
CREATE TABLE IF NOT EXISTS politician_category_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_run_id INTEGER NOT NULL,
  politician_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  score_0_100 REAL,
  score_signed REAL,
  coverage REAL,
  last_division_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (score_run_id) REFERENCES score_runs(id),
  FOREIGN KEY (politician_id) REFERENCES politicians(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  UNIQUE(score_run_id, politician_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_politician_category_scores_run ON politician_category_scores(score_run_id);
CREATE INDEX IF NOT EXISTS idx_politician_category_scores_politician ON politician_category_scores(politician_id);
CREATE INDEX IF NOT EXISTS idx_politician_category_scores_category ON politician_category_scores(category_id);

-- Politician overall scores
CREATE TABLE IF NOT EXISTS politician_overall_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_run_id INTEGER NOT NULL,
  politician_id TEXT NOT NULL,
  overall_0_100 REAL,
  coverage REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (score_run_id) REFERENCES score_runs(id),
  FOREIGN KEY (politician_id) REFERENCES politicians(id),
  UNIQUE(score_run_id, politician_id)
);

CREATE INDEX IF NOT EXISTS idx_politician_overall_scores_run ON politician_overall_scores(score_run_id);
CREATE INDEX IF NOT EXISTS idx_politician_overall_scores_politician ON politician_overall_scores(politician_id);

-- Score explanations (evidence)
CREATE TABLE IF NOT EXISTS score_explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score_run_id INTEGER NOT NULL,
  politician_id TEXT NOT NULL,
  category_id TEXT,
  division_id TEXT NOT NULL,
  vote TEXT NOT NULL,
  effect REAL,
  rationale_snapshot TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (score_run_id) REFERENCES score_runs(id),
  FOREIGN KEY (politician_id) REFERENCES politicians(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (division_id) REFERENCES divisions(id)
);

CREATE INDEX IF NOT EXISTS idx_score_explanations_run ON score_explanations(score_run_id);
CREATE INDEX IF NOT EXISTS idx_score_explanations_politician ON score_explanations(politician_id);
CREATE INDEX IF NOT EXISTS idx_score_explanations_category ON score_explanations(category_id);
