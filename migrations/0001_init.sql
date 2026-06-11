-- Rolling event log. details is a JSON blob of rule-specific facts.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,            -- ulid: sortable by creation time
  ts INTEGER NOT NULL,            -- epoch ms
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL,
  prefix TEXT,
  label TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  commentary TEXT,
  narrated INTEGER NOT NULL DEFAULT 0,  -- 1 = AI text, 0 = template fallback
  replay INTEGER NOT NULL DEFAULT 0     -- 1 = replayed incident, excluded from "real" queries
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
