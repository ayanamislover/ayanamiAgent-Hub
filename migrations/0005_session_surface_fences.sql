CREATE TABLE IF NOT EXISTS session_lineages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  client TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK(identity_kind IN ('external_thread', 'external_session')),
  identity_value TEXT NOT NULL,
  head_session_id TEXT,
  head_incarnation INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(head_incarnation) = 'integer' AND head_incarnation >= 0),
  launch_fence_required INTEGER NOT NULL DEFAULT 0,
  reserved_generation INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(reserved_generation) = 'integer' AND reserved_generation >= 0),
  active_reservation_id TEXT,
  head_run_id TEXT,
  head_run_generation INTEGER
    CHECK(head_run_generation IS NULL OR (typeof(head_run_generation) = 'integer' AND head_run_generation > 0)),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, agent_id, client, delivery_mode, identity_kind, identity_value)
);

CREATE TABLE IF NOT EXISTS session_launch_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lineage_id TEXT NOT NULL REFERENCES session_lineages(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0),
  expected_head_session_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('ISSUED', 'CONSUMED', 'SUPERSEDED')),
  consumed_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(lineage_id, generation),
  CHECK(
    (state = 'CONSUMED' AND consumed_session_id IS NOT NULL)
    OR (state IN ('ISSUED', 'SUPERSEDED') AND consumed_session_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_session_launch_reservations_issued
  ON session_launch_reservations(lineage_id)
  WHERE state = 'ISSUED';

ALTER TABLE agent_sessions ADD COLUMN lineage_id TEXT REFERENCES session_lineages(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN incarnation INTEGER;
ALTER TABLE agent_sessions ADD COLUMN predecessor_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN superseded_by_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD COLUMN launcher_run_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN launch_generation INTEGER;

INSERT INTO session_lineages(
  id, project_id, agent_id, client, delivery_mode, identity_kind, identity_value,
  head_session_id, head_incarnation, launch_fence_required, reserved_generation,
  active_reservation_id, head_run_id, head_run_generation,
  version, created_at, updated_at
)
SELECT
  'lin_' || lower(hex(randomblob(12))),
  project_id,
  agent_id,
  client,
  delivery_mode,
  CASE WHEN NULLIF(external_thread_id, '') IS NOT NULL
    THEN 'external_thread'
    ELSE 'external_session'
  END,
  COALESCE(NULLIF(external_thread_id, ''), NULLIF(external_session_id, '')),
  NULL,
  0,
  CASE WHEN client = 'codex-app-server' THEN 1 ELSE 0 END,
  0,
  NULL,
  NULL,
  NULL,
  0,
  MIN(connected_at),
  MAX(connected_at)
FROM agent_sessions
WHERE role = 'primary'
  AND COALESCE(NULLIF(external_thread_id, ''), NULLIF(external_session_id, '')) IS NOT NULL
GROUP BY
  project_id,
  agent_id,
  client,
  delivery_mode,
  CASE WHEN NULLIF(external_thread_id, '') IS NOT NULL
    THEN 'external_thread'
    ELSE 'external_session'
  END,
  COALESCE(NULLIF(external_thread_id, ''), NULLIF(external_session_id, ''));

UPDATE agent_sessions AS session
SET lineage_id = (
  SELECT lineage.id
  FROM session_lineages AS lineage
  WHERE lineage.project_id = session.project_id
    AND lineage.agent_id = session.agent_id
    AND lineage.client = session.client
    AND lineage.delivery_mode = session.delivery_mode
    AND lineage.identity_kind = CASE WHEN NULLIF(session.external_thread_id, '') IS NOT NULL
      THEN 'external_thread'
      ELSE 'external_session'
    END
    AND lineage.identity_value = COALESCE(
      NULLIF(session.external_thread_id, ''),
      NULLIF(session.external_session_id, '')
    )
)
WHERE session.role = 'primary'
  AND COALESCE(
    NULLIF(session.external_thread_id, ''),
    NULLIF(session.external_session_id, '')
  ) IS NOT NULL;

CREATE TEMP TABLE session_lineage_backfill_order (
  session_id TEXT PRIMARY KEY,
  lineage_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL
);

WITH registration_events AS (
  SELECT project_id, aggregate_id AS session_id, MIN(sequence) AS sequence
  FROM events
  WHERE type = 'session.registered'
    AND aggregate_type = 'session'
  GROUP BY project_id, aggregate_id
),
lineage_coverage AS (
  SELECT
    session.lineage_id,
    COUNT(*) AS session_count,
    COUNT(registration.sequence) AS registration_count
  FROM agent_sessions AS session
  LEFT JOIN registration_events AS registration
    ON registration.project_id = session.project_id
   AND registration.session_id = session.id
  WHERE session.lineage_id IS NOT NULL
  GROUP BY session.lineage_id
)
INSERT INTO session_lineage_backfill_order(session_id, lineage_id, ordinal)
SELECT
  session.id,
  session.lineage_id,
  ROW_NUMBER() OVER (
    PARTITION BY session.lineage_id
    ORDER BY
      CASE
        WHEN coverage.session_count = coverage.registration_count
          THEN registration.sequence
        ELSE 0
      END,
      CASE
        WHEN coverage.session_count = coverage.registration_count
          THEN ''
        ELSE session.connected_at
      END,
      session.id
  )
FROM agent_sessions AS session
JOIN lineage_coverage AS coverage
  ON coverage.lineage_id = session.lineage_id
LEFT JOIN registration_events AS registration
  ON registration.project_id = session.project_id
 AND registration.session_id = session.id
WHERE session.lineage_id IS NOT NULL;

UPDATE agent_sessions AS session
SET incarnation = (
  SELECT current.ordinal
  FROM session_lineage_backfill_order AS current
  WHERE current.session_id = session.id
)
WHERE session.lineage_id IS NOT NULL;

UPDATE agent_sessions AS session
SET predecessor_session_id = (
  SELECT predecessor.session_id
  FROM session_lineage_backfill_order AS current
  JOIN session_lineage_backfill_order AS predecessor
    ON predecessor.lineage_id = current.lineage_id
   AND predecessor.ordinal = current.ordinal - 1
  WHERE current.session_id = session.id
)
WHERE session.lineage_id IS NOT NULL;

UPDATE agent_sessions AS session
SET superseded_by_session_id = (
  SELECT successor.session_id
  FROM session_lineage_backfill_order AS current
  JOIN session_lineage_backfill_order AS successor
    ON successor.lineage_id = current.lineage_id
   AND successor.ordinal = current.ordinal + 1
  WHERE current.session_id = session.id
)
WHERE session.lineage_id IS NOT NULL;

DROP TABLE session_lineage_backfill_order;

UPDATE session_lineages
SET
  head_session_id = (
    SELECT session.id
    FROM agent_sessions AS session
    WHERE session.lineage_id = session_lineages.id
    ORDER BY session.incarnation DESC
    LIMIT 1
  ),
  head_incarnation = COALESCE((
    SELECT MAX(session.incarnation)
    FROM agent_sessions AS session
    WHERE session.lineage_id = session_lineages.id
  ), 0),
  version = COALESCE((
    SELECT MAX(session.incarnation)
    FROM agent_sessions AS session
    WHERE session.lineage_id = session_lineages.id
  ), 0);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_lineage
  ON agent_sessions(lineage_id, incarnation);

ALTER TABLE message_recipients ADD COLUMN surface_fence INTEGER NOT NULL DEFAULT 0;

CREATE TEMP TABLE session_surface_migration_guard (
  valid INTEGER NOT NULL CONSTRAINT session_surface_migration_safe CHECK(valid = 1)
);

-- An agent-wide row and any explicit row for the same logical recipient can be claimed by
-- different sessions. There is no safe automatic merge because either row may carry independent
-- delivery/ack evidence, so fail the migration atomically and leave the pre-migration backup as the
-- recovery source.
INSERT INTO session_surface_migration_guard(valid)
SELECT 0
FROM message_recipients
GROUP BY message_id, recipient_agent_id
HAVING COUNT(*) > 1
   AND SUM(CASE WHEN recipient_session_id IS NULL THEN 1 ELSE 0 END) > 0
LIMIT 1;

-- An explicit recipient is an ownership reference, not an arbitrary label. It must resolve to the
-- same project and agent as the message row before lineage convergence can safely move it.
INSERT INTO session_surface_migration_guard(valid)
SELECT 0
FROM message_recipients AS recipient
JOIN messages AS message
  ON message.id = recipient.message_id
LEFT JOIN agent_sessions AS session
  ON session.id = recipient.recipient_session_id
WHERE recipient.recipient_session_id IS NOT NULL
  AND (
    session.id IS NULL
    OR session.project_id <> message.project_id
    OR session.agent_id <> recipient.recipient_agent_id
  )
LIMIT 1;

-- Historical rows explicitly pinned to two incarnations of the same lineage would converge on one
-- head and violate exact-recipient identity. That is ambiguous evidence, not data the migration may
-- silently delete.
INSERT INTO session_surface_migration_guard(valid)
SELECT 0
FROM message_recipients AS recipient
JOIN agent_sessions AS session
  ON session.id = recipient.recipient_session_id
JOIN session_lineages AS lineage
  ON lineage.id = session.lineage_id
WHERE recipient.state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED')
GROUP BY recipient.message_id, recipient.recipient_agent_id, lineage.id
HAVING COUNT(*) > 1
LIMIT 1;

-- A task may have only one active immutable review. Looking only at the mutable Session projection
-- is insufficient: legacy data can contain two active rows while projecting only the newest one,
-- and the older review would still be able to write a verdict into the task state machine.
INSERT INTO session_surface_migration_guard(valid)
SELECT 0
FROM reviews AS review
WHERE review.status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED')
GROUP BY review.task_id
HAVING COUNT(*) > 1
LIMIT 1;

-- Collapse every safe active ownership reference onto the authoritative migrated head before
-- non-head sessions become immutable history. Without this, a later B -> C replacement only moves
-- rows pinned to B and permanently strands legacy rows that were still pinned to A.
UPDATE tasks
SET
  owner_session_id = (
    SELECT lineage.head_session_id
    FROM agent_sessions AS owner
    JOIN session_lineages AS lineage ON lineage.id = owner.lineage_id
    WHERE owner.id = tasks.owner_session_id
  ),
  owner_agent_id = (
    SELECT lineage.agent_id
    FROM agent_sessions AS owner
    JOIN session_lineages AS lineage ON lineage.id = owner.lineage_id
    WHERE owner.id = tasks.owner_session_id
  ),
  claim_stale_at = NULL,
  version = version + 1
WHERE status NOT IN ('BACKLOG', 'READY', 'APPROVED', 'DONE', 'CANCELLED')
  AND owner_session_id IN (
    SELECT session.id
    FROM agent_sessions AS session
    JOIN session_lineages AS lineage ON lineage.id = session.lineage_id
    WHERE session.id <> lineage.head_session_id
  );

UPDATE write_intents
SET
  session_id = (
    SELECT lineage.head_session_id
    FROM agent_sessions AS owner
    JOIN session_lineages AS lineage ON lineage.id = owner.lineage_id
    WHERE owner.id = write_intents.session_id
  ),
  version = version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE released_at IS NULL
  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND session_id IN (
    SELECT session.id
    FROM agent_sessions AS session
    JOIN session_lineages AS lineage ON lineage.id = session.lineage_id
    WHERE session.id <> lineage.head_session_id
  );

UPDATE message_recipients
SET recipient_session_id = (
  SELECT lineage.head_session_id
  FROM agent_sessions AS owner
  JOIN session_lineages AS lineage ON lineage.id = owner.lineage_id
  WHERE owner.id = message_recipients.recipient_session_id
)
WHERE state IN ('PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED')
  AND recipient_session_id IN (
    SELECT session.id
    FROM agent_sessions AS session
    JOIN session_lineages AS lineage ON lineage.id = session.lineage_id
    WHERE session.id <> lineage.head_session_id
  );

UPDATE agent_sessions AS head
SET
  current_task_id = (
    SELECT task.id
    FROM tasks AS task
    WHERE task.owner_session_id = head.id
      AND task.status NOT IN ('BACKLOG', 'READY', 'APPROVED', 'DONE', 'CANCELLED')
    ORDER BY task.updated_at DESC, task.id DESC
    LIMIT 1
  ),
  current_review_id = (
    SELECT prior.current_review_id
    FROM agent_sessions AS prior
    JOIN reviews AS review
      ON review.id = prior.current_review_id
     AND review.status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED')
    WHERE prior.lineage_id = head.lineage_id
    ORDER BY prior.incarnation DESC
    LIMIT 1
  ),
  work_state = CASE
    WHEN EXISTS (
      SELECT 1
      FROM tasks AS task
      WHERE task.owner_session_id = head.id
        AND task.status NOT IN ('BACKLOG', 'READY', 'APPROVED', 'DONE', 'CANCELLED')
    ) OR EXISTS (
      SELECT 1
      FROM agent_sessions AS prior
      JOIN reviews AS review
        ON review.id = prior.current_review_id
       AND review.status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED')
      WHERE prior.lineage_id = head.lineage_id
    )
      THEN 'WORKING'
    ELSE head.work_state
  END,
  version = version + 1
WHERE head.id IN (SELECT head_session_id FROM session_lineages);

UPDATE agent_sessions AS historical
SET
  current_task_id = NULL,
  current_review_id = NULL,
  work_state = 'IDLE',
  connection_state = 'CLOSED',
  closed_at = COALESCE(closed_at, transport_last_seen_at, connected_at),
  version = version + 1
WHERE historical.lineage_id IS NOT NULL
  AND historical.id <> (
    SELECT lineage.head_session_id
    FROM session_lineages AS lineage
    WHERE lineage.id = historical.lineage_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS ux_message_recipients_unbound_agent
  ON message_recipients(message_id, recipient_agent_id)
  WHERE recipient_session_id IS NULL;

CREATE TRIGGER IF NOT EXISTS message_recipients_reject_mixed_insert
BEFORE INSERT ON message_recipients
WHEN EXISTS (
  SELECT 1
  FROM message_recipients AS existing
  WHERE existing.message_id = NEW.message_id
    AND existing.recipient_agent_id = NEW.recipient_agent_id
    AND (
      (existing.recipient_session_id IS NULL AND NEW.recipient_session_id IS NOT NULL)
      OR
      (existing.recipient_session_id IS NOT NULL AND NEW.recipient_session_id IS NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'message recipient cannot mix agent-wide and explicit ownership');
END;

CREATE TRIGGER IF NOT EXISTS message_recipients_reject_mixed_update
BEFORE UPDATE OF message_id, recipient_agent_id, recipient_session_id ON message_recipients
WHEN EXISTS (
  SELECT 1
  FROM message_recipients AS existing
  WHERE existing.id <> OLD.id
    AND existing.message_id = NEW.message_id
    AND existing.recipient_agent_id = NEW.recipient_agent_id
    AND (
      (existing.recipient_session_id IS NULL AND NEW.recipient_session_id IS NOT NULL)
      OR
      (existing.recipient_session_id IS NOT NULL AND NEW.recipient_session_id IS NULL)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'message recipient cannot mix agent-wide and explicit ownership');
END;

CREATE TRIGGER IF NOT EXISTS message_recipients_validate_explicit_insert
BEFORE INSERT ON message_recipients
WHEN NEW.recipient_session_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM agent_sessions AS session
   JOIN messages AS message ON message.id = NEW.message_id
   WHERE session.id = NEW.recipient_session_id
     AND session.project_id = message.project_id
     AND session.agent_id = NEW.recipient_agent_id
 )
BEGIN
  SELECT RAISE(ABORT, 'message recipient session must match message project and recipient agent');
END;

CREATE TRIGGER IF NOT EXISTS message_recipients_validate_explicit_update
BEFORE UPDATE OF message_id, recipient_agent_id, recipient_session_id ON message_recipients
WHEN NEW.recipient_session_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1
   FROM agent_sessions AS session
   JOIN messages AS message ON message.id = NEW.message_id
   WHERE session.id = NEW.recipient_session_id
     AND session.project_id = message.project_id
     AND session.agent_id = NEW.recipient_agent_id
 )
BEGIN
  SELECT RAISE(ABORT, 'message recipient session must match message project and recipient agent');
END;

DROP TABLE session_surface_migration_guard;

CREATE TABLE IF NOT EXISTS message_surface_attempts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES message_recipients(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  session_incarnation INTEGER NOT NULL,
  recipient_fence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'CONFIRMED', 'ABORTED', 'AMBIGUOUS')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  UNIQUE(recipient_id, recipient_fence)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_message_surface_attempts_unresolved
  ON message_surface_attempts(recipient_id)
  WHERE state IN ('ACTIVE', 'AMBIGUOUS');

CREATE INDEX IF NOT EXISTS idx_message_surface_attempts_message
  ON message_surface_attempts(message_id, state);
