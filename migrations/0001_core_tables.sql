-- Migration 0001: Core tables for politicians, parties, divisions, votes, categories

-- Parties table
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  abbreviation TEXT,
  color TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Politicians table
CREATE TABLE IF NOT EXISTS politicians (
  id TEXT PRIMARY KEY,
  external_ids TEXT, -- JSON: { "openaustralia": "...", "tvfy": "..." }
  name TEXT NOT NULL,
  chamber TEXT, -- 'house' | 'senate'
  jurisdiction TEXT DEFAULT 'commonwealth',
  party_id TEXT,
  electorate TEXT,
  dates TEXT, -- JSON: { "entered": "...", "left": "..." }
  image_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (party_id) REFERENCES parties(id)
);

CREATE INDEX IF NOT EXISTS idx_politicians_chamber ON politicians(chamber);
CREATE INDEX IF NOT EXISTS idx_politicians_party ON politicians(party_id);
CREATE INDEX IF NOT EXISTS idx_politicians_name ON politicians(name);

-- Divisions (vote events)
CREATE TABLE IF NOT EXISTS divisions (
  id TEXT PRIMARY KEY,
  external_id TEXT UNIQUE, -- OpenAustralia division ID
  chamber TEXT NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  motion TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_divisions_date ON divisions(date);
CREATE INDEX IF NOT EXISTS idx_divisions_chamber ON divisions(chamber);
CREATE INDEX IF NOT EXISTS idx_divisions_external_id ON divisions(external_id);

-- Votes
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id TEXT NOT NULL,
  politician_id TEXT NOT NULL,
  vote TEXT NOT NULL, -- 'aye' | 'no' | 'abstain' | 'absent'
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (politician_id) REFERENCES politicians(id),
  UNIQUE(division_id, politician_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_division ON votes(division_id);
CREATE INDEX IF NOT EXISTS idx_votes_politician ON votes(politician_id);
CREATE INDEX IF NOT EXISTS idx_votes_vote ON votes(vote);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_weight REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);
