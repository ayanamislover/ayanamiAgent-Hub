-- Capability authorization that the local user grants by clicking in the Dashboard.
--
-- This exists because an agent relaying "the user approved X" is not evidence: during
-- development each agent refused the other's relayed authorization, correctly, and the work
-- stalled until the user repeated themselves in both chats. A grant row turns that into one
-- durable, timestamped, expiring, revocable record that either agent can verify for itself.
--
-- It is deliberately NOT a cryptographic barrier. Every local process that can read the token
-- file can call every Hub route, so a dishonest agent could approve its own request. What this
-- buys is an explicit record of user intent plus an audit event on every transition, so such an
-- act is visible after the fact rather than indistinguishable from a real approval.
CREATE TABLE IF NOT EXISTS authorization_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  requested_by_agent_id TEXT NOT NULL,
  requested_by_session_id TEXT,
  decided_by TEXT,
  decided_via TEXT,
  decided_at TEXT,
  decision_note TEXT,
  expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authorizations_project_status
  ON authorization_grants(project_id, status);
CREATE INDEX IF NOT EXISTS idx_authorizations_capability
  ON authorization_grants(project_id, capability, status);
