-- Close reverse-write gaps left by the original session/review migrations. These checks run before
-- installing the final fences so a database already corrupted after v5/v6 fails atomically instead
-- of blessing ambiguous review, recipient, or launch-reservation ownership.
CREATE TEMP TABLE hub_persistent_invariant_migration_guard (
  valid INTEGER NOT NULL CONSTRAINT hub_persistent_invariant_migration_safe CHECK(valid = 1)
);

INSERT INTO hub_persistent_invariant_migration_guard(valid)
SELECT 0
FROM reviews
WHERE status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED')
GROUP BY task_id
HAVING COUNT(*) > 1
LIMIT 1;

INSERT INTO hub_persistent_invariant_migration_guard(valid)
SELECT 0
FROM message_recipients AS recipient
JOIN messages AS message ON message.id = recipient.message_id
LEFT JOIN agent_sessions AS session ON session.id = recipient.recipient_session_id
WHERE recipient.recipient_session_id IS NOT NULL
  AND (
    session.id IS NULL
    OR session.project_id <> message.project_id
    OR session.agent_id <> recipient.recipient_agent_id
  )
LIMIT 1;

INSERT INTO hub_persistent_invariant_migration_guard(valid)
SELECT 0
FROM session_lineages AS lineage
LEFT JOIN session_launch_reservations AS active
  ON active.id = lineage.active_reservation_id
WHERE lineage.active_reservation_id IS NOT NULL
  AND (
    active.id IS NULL
    OR active.project_id <> lineage.project_id
    OR active.lineage_id <> lineage.id
    OR active.generation <> lineage.reserved_generation
    OR active.state <> 'ISSUED'
  )
LIMIT 1;

CREATE UNIQUE INDEX ux_reviews_one_active_per_task
  ON reviews(task_id)
  WHERE status IN ('PENDING', 'DELIVERED', 'IN_REVIEW', 'CHANGES_REQUESTED');

CREATE TRIGGER explicit_message_recipient_session_identity_guard
BEFORE UPDATE OF id, project_id, agent_id ON agent_sessions
WHEN EXISTS (
  SELECT 1
  FROM message_recipients AS recipient
  JOIN messages AS message ON message.id = recipient.message_id
  WHERE recipient.recipient_session_id = OLD.id
    AND (
      NEW.id IS NOT OLD.id
      OR NEW.project_id <> message.project_id
      OR NEW.agent_id <> recipient.recipient_agent_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'explicit message recipient binding would be invalidated');
END;

CREATE TRIGGER active_launch_reservation_update_guard
BEFORE UPDATE ON session_launch_reservations
WHEN EXISTS (
  SELECT 1
  FROM session_lineages AS lineage
  WHERE lineage.active_reservation_id = OLD.id
    AND (
      NEW.id IS NOT OLD.id
      OR NEW.project_id <> lineage.project_id
      OR NEW.lineage_id <> lineage.id
      OR NEW.generation <> lineage.reserved_generation
      OR NEW.state <> 'ISSUED'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'live session fence: active reservation must remain ISSUED while referenced');
END;

CREATE TRIGGER active_launch_reservation_delete_guard
BEFORE DELETE ON session_launch_reservations
WHEN EXISTS (
  SELECT 1
  FROM session_lineages AS lineage
  WHERE lineage.active_reservation_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'live session fence: active reservation cannot be deleted while referenced');
END;

DROP TABLE hub_persistent_invariant_migration_guard;
