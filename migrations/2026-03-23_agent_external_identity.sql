ALTER TABLE agents ADD COLUMN external_agent_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_external_agent_id
  ON agents(external_agent_id);
