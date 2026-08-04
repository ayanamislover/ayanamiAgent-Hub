CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_branch TEXT,
  active_objective_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  current_sequence INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_paths (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL,
  worktree_branch TEXT,
  git_head TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_path)
);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_of_done_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  owner_agent_id TEXT,
  owner_session_id TEXT,
  reviewer_agent_id TEXT,
  capability_tags_json TEXT NOT NULL DEFAULT '[]',
  scope_globs_json TEXT NOT NULL DEFAULT '[]',
  protected_scope INTEGER NOT NULL DEFAULT 0,
  review_required INTEGER NOT NULL DEFAULT 1,
  blocked_reason TEXT,
  waiting_for TEXT,
  base_sha TEXT,
  head_sha TEXT,
  self_reported_summary TEXT,
  agent_estimate REAL,
  computed_progress REAL NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 1,
  claim_stale_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  evidence_required INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  completed_by_session_id TEXT,
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(id, project_id)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  client TEXT NOT NULL,
  transport TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  external_session_id TEXT,
  external_thread_id TEXT,
  external_turn_id TEXT,
  host TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT NOT NULL,
  git_branch TEXT,
  git_head TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  connected_at TEXT NOT NULL,
  transport_last_seen_at TEXT NOT NULL,
  activity_last_seen_at TEXT,
  current_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  current_review_id TEXT,
  active_files_json TEXT NOT NULL DEFAULT '[]',
  work_state TEXT NOT NULL,
  connection_state TEXT NOT NULL,
  heartbeat_sequence INTEGER NOT NULL DEFAULT 0,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_heartbeats (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  work_state TEXT NOT NULL,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  sampled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS write_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  globs_json TEXT NOT NULL DEFAULT '[]',
  symbols_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_changed_files_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  released_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS write_conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  left_intent_id TEXT NOT NULL REFERENCES write_intents(id) ON DELETE CASCADE,
  right_intent_id TEXT NOT NULL REFERENCES write_intents(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  overlap_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(left_intent_id, right_intent_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  review_id TEXT,
  waiting_for_agent_id TEXT,
  proposal_rounds INTEGER NOT NULL DEFAULT 0,
  objection_rounds INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  review_id TEXT,
  from_agent_id TEXT NOT NULL,
  from_session_id TEXT,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  requires_ack INTEGER NOT NULL DEFAULT 0,
  requires_response INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  detail_json TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, dedupe_key)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  summary,
  detail_text,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(message_id, summary, detail_text)
  VALUES (new.id, new.summary, COALESCE(new.detail_json, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF summary, detail_json ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(message_id, summary, detail_text)
  VALUES (new.id, new.summary, COALESCE(new.detail_json, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TABLE IF NOT EXISTS message_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL,
  recipient_session_id TEXT,
  state TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  processed_at TEXT,
  responded_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(message_id, recipient_agent_id, recipient_session_id)
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES message_recipients(id) ON DELETE CASCADE,
  session_id TEXT,
  transport TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS message_acks (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES message_recipients(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  ack_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(message_id, session_id, ack_type)
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  review_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  author_agent_id TEXT NOT NULL,
  author_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  reviewer_agent_id TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  patch_sha256 TEXT NOT NULL,
  patch_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  test_evidence_json TEXT NOT NULL DEFAULT '[]',
  author_claims_json TEXT NOT NULL DEFAULT '[]',
  known_risks_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  verdict_summary TEXT,
  supersedes_review_id TEXT REFERENCES reviews(id),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, revision)
);

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  impact TEXT NOT NULL,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  symbol TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  suggested_direction TEXT,
  status TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_evidence (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  output_summary TEXT NOT NULL,
  artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, sequence)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY(project_id, key)
);

CREATE TABLE IF NOT EXISTS settings (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id, key)
);

CREATE INDEX IF NOT EXISTS idx_project_paths_project ON project_paths(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project_state ON agent_sessions(project_id, connection_state);
CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON agent_sessions(transport_last_seen_at);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_session_id, status);
CREATE INDEX IF NOT EXISTS idx_todos_task ON todo_items(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_project_sequence ON messages(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS idx_recipients_agent_state ON message_recipients(recipient_agent_id, state);
CREATE INDEX IF NOT EXISTS idx_intents_project_active ON write_intents(project_id, released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_conflicts_project_status ON write_conflicts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_project_status ON reviews(project_id, status);
CREATE INDEX IF NOT EXISTS idx_events_project_sequence ON events(project_id, sequence);
