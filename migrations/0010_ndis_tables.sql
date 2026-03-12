-- NDIS Provider Red Flag Register tables
-- Migration 0010: Add NDIS compliance tracking tables

CREATE TABLE IF NOT EXISTS ndis_providers (
  id           TEXT PRIMARY KEY,          -- "ndis_" + ABN with no spaces
  abn          TEXT UNIQUE,
  legal_name   TEXT NOT NULL,
  trading_name TEXT,
  suburb       TEXT,
  state        TEXT,
  reg_status   TEXT,                      -- "registered" | "suspended" | "revoked"
  abn_status   TEXT,                      -- from ABR: "Active" | "Cancelled"
  entity_type  TEXT,                      -- from ABR: "Company" | "Individual" etc
  abn_reg_date TEXT,                      -- ISO date from ABR
  gst_reg_date TEXT,                      -- ISO date from ABR, nullable
  risk_score   INTEGER DEFAULT 0,
  risk_label   TEXT DEFAULT 'unknown',    -- "critical"|"high"|"medium"|"low"
  action_count INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ndis_providers_abn   ON ndis_providers(abn);
CREATE INDEX IF NOT EXISTS idx_ndis_providers_risk  ON ndis_providers(risk_label);
CREATE INDEX IF NOT EXISTS idx_ndis_providers_state ON ndis_providers(state);

CREATE TABLE IF NOT EXISTS ndis_compliance_actions (
  id           TEXT PRIMARY KEY,          -- hash of provider_name+action_type+start_date
  provider_id  TEXT REFERENCES ndis_providers(id),
  subject_name TEXT NOT NULL,             -- person or org name from register
  subject_type TEXT NOT NULL,             -- "provider" | "individual"
  action_type  TEXT NOT NULL,             -- "banning_order" | "compliance_notice"
                                          -- | "enforceable_undertaking"
                                          -- | "suspension" | "revocation"
  status       TEXT NOT NULL,             -- "in_force" | "expired" | "varied"
  start_date   TEXT,                      -- ISO date
  end_date     TEXT,                      -- ISO date, null = permanent
  is_permanent INTEGER DEFAULT 0,
  description  TEXT,                      -- full text from register
  state        TEXT,
  source_url   TEXT,
  scraped_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ndis_actions_provider ON ndis_compliance_actions(provider_id);
CREATE INDEX IF NOT EXISTS idx_ndis_actions_type     ON ndis_compliance_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_ndis_actions_status   ON ndis_compliance_actions(status);
