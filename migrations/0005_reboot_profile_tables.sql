-- Migration 0005: Accountability Platform Tables
-- Adds tables for the face-first politician accountability platform

-- Alter politicians table to add photo and profile fields
ALTER TABLE politicians ADD COLUMN photo_url TEXT;
ALTER TABLE politicians ADD COLUMN mugshot_r2_key TEXT;
ALTER TABLE politicians ADD COLUMN bio TEXT;
ALTER TABLE politicians ADD COLUMN website TEXT;
ALTER TABLE politicians ADD COLUMN social_media TEXT; -- JSON

-- Politician photos pipeline tracking
CREATE TABLE IF NOT EXISTS politician_photos (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL UNIQUE,
  source_url TEXT,
  r2_key TEXT,
  r2_key_mugshot TEXT,
  fetched_at TEXT,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/fetched/processed/error
  error TEXT,
  FOREIGN KEY (politician_id) REFERENCES politicians(id)
);

-- Actions: documented votes and policy decisions against the public interest
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  date TEXT,
  category TEXT,
  source_url TEXT,
  evidence_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (politician_id) REFERENCES politicians(id)
);

CREATE INDEX IF NOT EXISTS idx_actions_politician ON actions(politician_id);
CREATE INDEX IF NOT EXISTS idx_actions_date ON actions(date);

-- Donations: AEC donor breakdown with amounts and years
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL,
  donor_name TEXT NOT NULL,
  amount_cents INTEGER,
  year INTEGER,
  source TEXT NOT NULL DEFAULT 'AEC',
  source_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (politician_id) REFERENCES politicians(id)
);

CREATE INDEX IF NOT EXISTS idx_donations_politician ON donations(politician_id);
CREATE INDEX IF NOT EXISTS idx_donations_year ON donations(year);

-- Promises: election promises vs reality
CREATE TABLE IF NOT EXISTS promises (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  made_date TEXT,
  deadline_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- kept/broken/partial/pending
  evidence_url TEXT,
  source_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (politician_id) REFERENCES politicians(id)
);

CREATE INDEX IF NOT EXISTS idx_promises_politician ON promises(politician_id);
CREATE INDEX IF NOT EXISTS idx_promises_status ON promises(status);

-- Foreign ties: foreign entity associations with risk ratings
CREATE TABLE IF NOT EXISTS foreign_ties (
  id TEXT PRIMARY KEY,
  politician_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_country TEXT,
  relationship_type TEXT, -- donation/directorship/travel/lobbying/membership
  risk_rating TEXT NOT NULL DEFAULT 'low', -- low/medium/high/critical
  description TEXT,
  date_start TEXT,
  date_end TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (politician_id) REFERENCES politicians(id)
);

CREATE INDEX IF NOT EXISTS idx_foreign_ties_politician ON foreign_ties(politician_id);
CREATE INDEX IF NOT EXISTS idx_foreign_ties_risk ON foreign_ties(risk_rating);
