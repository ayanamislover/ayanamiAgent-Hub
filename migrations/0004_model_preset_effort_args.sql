-- Effort arguments have to be a separate list, not a filtered subset of the launch arguments.
--
-- The first design kept one template and dropped tokens containing {effort}. That leaves the
-- flag behind: `-m gpt-5.1-codex -c model_reasoning_effort={effort}` became `-m gpt-5.1-codex -c`
-- when no effort was chosen, and a dangling flag makes the CLI refuse to start. Flags and their
-- values only travel together, so they live in one list that is applied or omitted whole.
ALTER TABLE model_presets ADD COLUMN effort_args_json TEXT NOT NULL DEFAULT '[]';

UPDATE model_presets
   SET launch_args_json = '["-m","{model}"]',
       effort_args_json = '["-c","model_reasoning_effort={effort}"]',
       version = version + 1,
       updated_at = datetime('now')
 WHERE agent_id = 'codex'
   AND launch_args_json LIKE '%model_reasoning_effort%';
