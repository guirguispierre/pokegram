PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agent_api_keys (
  agent_id      TEXT PRIMARY KEY,
  key_hash      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  rotated_at    INTEGER NOT NULL,
  last_used_at  INTEGER DEFAULT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_api_keys_rotated_at ON agent_api_keys(rotated_at DESC);
