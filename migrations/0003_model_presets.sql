-- Model presets for the console.
--
-- The requirement was that model choice stays dynamic "because models change or get updated",
-- so nothing here is compiled in. A preset carries the launch arguments as a template rather
-- than just a model id: when a CLI renames a flag or adds an effort level, that is a row edit in
-- Settings, not a code change and a release.
CREATE TABLE IF NOT EXISTS model_presets (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  label TEXT NOT NULL,
  -- Effort levels this model accepts. Empty means the agent exposes no effort control.
  reasoning_efforts_json TEXT NOT NULL DEFAULT '[]',
  -- Argument tokens with {model} and {effort} placeholders, e.g.
  -- ["-m","{model}","-c","model_reasoning_effort={effort}"]. Tokens containing {effort} are
  -- dropped when no effort is selected.
  launch_args_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_presets_identity ON model_presets(agent_id, model_id);
CREATE INDEX IF NOT EXISTS idx_model_presets_agent ON model_presets(agent_id, sort_order);

-- Seeded so the console is usable on first run. These are starting values, not a source of
-- truth: the user is expected to edit them as the CLIs move.
INSERT OR IGNORE INTO model_presets
  (id, agent_id, model_id, label, reasoning_efforts_json, launch_args_json, enabled, sort_order, version, created_at, updated_at)
VALUES
  ('mdp_codex_gpt51_codex', 'codex', 'gpt-5.1-codex', 'GPT-5.1 Codex',
   '["low","medium","high"]',
   '["-m","{model}","-c","model_reasoning_effort={effort}"]',
   1, 0, 0, datetime('now'), datetime('now')),
  ('mdp_codex_gpt51', 'codex', 'gpt-5.1', 'GPT-5.1',
   '["low","medium","high"]',
   '["-m","{model}","-c","model_reasoning_effort={effort}"]',
   1, 1, 0, datetime('now'), datetime('now')),
  ('mdp_claude_opus5', 'claude', 'claude-opus-5', 'Claude Opus 5',
   '[]', '["--model","{model}"]',
   1, 0, 0, datetime('now'), datetime('now')),
  ('mdp_claude_sonnet5', 'claude', 'claude-sonnet-5', 'Claude Sonnet 5',
   '[]', '["--model","{model}"]',
   1, 1, 0, datetime('now'), datetime('now')),
  ('mdp_claude_haiku45', 'claude', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5',
   '[]', '["--model","{model}"]',
   1, 2, 0, datetime('now'), datetime('now'));
