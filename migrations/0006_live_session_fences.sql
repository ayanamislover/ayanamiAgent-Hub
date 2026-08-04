-- Migration 0005 was deployed from an earlier draft on one live Hub before its final
-- CHECK constraints were committed. Since migrations are keyed by integer version, editing
-- 0005 cannot repair that database. These guards give fresh and already-version-5 databases
-- the same fail-closed write semantics without a risky live table rebuild.

CREATE TEMP TABLE live_session_fence_migration_guard (
  valid INTEGER NOT NULL CONSTRAINT live_session_fence_migration_safe CHECK(valid = 1)
);

-- One deployed draft consumed a reservation before it learned to clear this derived pointer.
-- The immutable reservation and lineage head already prove the outcome, so clearing only the
-- exact aligned stale projection is deterministic and preserves all source evidence.
UPDATE session_lineages AS lineage
SET active_reservation_id = NULL,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE lineage.active_reservation_id IN (
  SELECT reservation.id
  FROM session_launch_reservations AS reservation
  WHERE reservation.project_id = lineage.project_id
    AND reservation.lineage_id = lineage.id
    AND reservation.generation = lineage.reserved_generation
    AND reservation.state = 'CONSUMED'
    AND reservation.consumed_session_id = lineage.head_session_id
    AND reservation.run_id = lineage.head_run_id
    AND reservation.generation = lineage.head_run_generation
);

INSERT INTO live_session_fence_migration_guard(valid)
SELECT 0
FROM session_lineages AS lineage
WHERE typeof(lineage.head_incarnation) <> 'integer'
   OR lineage.head_incarnation < 0
   OR typeof(lineage.reserved_generation) <> 'integer'
   OR lineage.reserved_generation < 0
   OR (
     lineage.head_run_generation IS NOT NULL
     AND (
       typeof(lineage.head_run_generation) <> 'integer'
       OR lineage.head_run_generation <= 0
     )
   )
   OR (
     lineage.head_session_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM agent_sessions AS head
       WHERE head.id = lineage.head_session_id
         AND head.project_id = lineage.project_id
         AND head.lineage_id = lineage.id
         AND head.incarnation = lineage.head_incarnation
     )
   )
   OR (
     lineage.active_reservation_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM session_launch_reservations AS active
       WHERE active.id = lineage.active_reservation_id
         AND active.project_id = lineage.project_id
         AND active.lineage_id = lineage.id
         AND active.generation = lineage.reserved_generation
         AND active.state = 'ISSUED'
     )
   )
   OR ((lineage.head_run_id IS NULL) <> (lineage.head_run_generation IS NULL))
   OR (
     lineage.head_run_id IS NOT NULL
     AND (
       NOT EXISTS (
         SELECT 1
         FROM session_launch_reservations AS head_run
         WHERE head_run.project_id = lineage.project_id
           AND head_run.lineage_id = lineage.id
           AND head_run.run_id = lineage.head_run_id
           AND head_run.generation = lineage.head_run_generation
       )
       OR NOT EXISTS (
         SELECT 1
         FROM agent_sessions AS head
         WHERE head.id = lineage.head_session_id
           AND head.launcher_run_id = lineage.head_run_id
           AND head.launch_generation = lineage.head_run_generation
       )
     )
   )
LIMIT 1;

INSERT INTO live_session_fence_migration_guard(valid)
SELECT 0
FROM session_launch_reservations AS reservation
JOIN session_lineages AS lineage ON lineage.id = reservation.lineage_id
WHERE typeof(reservation.generation) <> 'integer'
   OR reservation.generation <= 0
   OR reservation.project_id <> lineage.project_id
   OR (
     reservation.expected_head_session_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM agent_sessions AS expected_head
       WHERE expected_head.id = reservation.expected_head_session_id
         AND expected_head.project_id = reservation.project_id
         AND expected_head.lineage_id = reservation.lineage_id
     )
   )
   OR (
     reservation.consumed_session_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM agent_sessions AS consumed
         WHERE consumed.id = reservation.consumed_session_id
           AND consumed.project_id = reservation.project_id
           AND consumed.lineage_id = reservation.lineage_id
           AND consumed.launcher_run_id = reservation.run_id
           AND consumed.launch_generation = reservation.generation
     )
   )
LIMIT 1;

DROP TABLE live_session_fence_migration_guard;

CREATE TRIGGER live_session_fence_lineage_insert
BEFORE INSERT ON session_lineages
BEGIN
  SELECT CASE WHEN
    typeof(NEW.head_incarnation) <> 'integer' OR NEW.head_incarnation < 0
  THEN RAISE(ABORT, 'live session fence: invalid head_incarnation') END;
  SELECT CASE WHEN
    typeof(NEW.reserved_generation) <> 'integer' OR NEW.reserved_generation < 0
  THEN RAISE(ABORT, 'live session fence: invalid reserved_generation') END;
  SELECT CASE WHEN
    NEW.head_run_generation IS NOT NULL
    AND (typeof(NEW.head_run_generation) <> 'integer' OR NEW.head_run_generation <= 0)
  THEN RAISE(ABORT, 'live session fence: invalid head_run_generation') END;
  SELECT CASE WHEN
    NEW.head_session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM agent_sessions AS head
      WHERE head.id = NEW.head_session_id
        AND head.project_id = NEW.project_id
        AND head.lineage_id = NEW.id
        AND head.incarnation = NEW.head_incarnation
    )
  THEN RAISE(ABORT, 'live session fence: invalid head_session_id') END;
  SELECT CASE WHEN
    NEW.active_reservation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM session_launch_reservations AS active
      WHERE active.id = NEW.active_reservation_id
        AND active.project_id = NEW.project_id
        AND active.lineage_id = NEW.id
        AND active.generation = NEW.reserved_generation
        AND active.state = 'ISSUED'
    )
  THEN RAISE(ABORT, 'live session fence: invalid active_reservation_id') END;
  SELECT CASE WHEN
    (NEW.head_run_id IS NULL) <> (NEW.head_run_generation IS NULL)
    OR (
      NEW.head_run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM session_launch_reservations AS head_run
        WHERE head_run.project_id = NEW.project_id
          AND head_run.lineage_id = NEW.id
          AND head_run.run_id = NEW.head_run_id
          AND head_run.generation = NEW.head_run_generation
      )
    )
  THEN RAISE(ABORT, 'live session fence: invalid head_run identity') END;
END;

CREATE TRIGGER live_session_fence_lineage_update
BEFORE UPDATE ON session_lineages
BEGIN
  SELECT CASE WHEN
    typeof(NEW.head_incarnation) <> 'integer'
    OR NEW.head_incarnation < OLD.head_incarnation
    OR (
      NEW.head_session_id IS NOT OLD.head_session_id
      AND NEW.head_incarnation <= OLD.head_incarnation
    )
  THEN RAISE(ABORT, 'live session fence: invalid or non-monotonic head_incarnation') END;
  SELECT CASE WHEN
    typeof(NEW.reserved_generation) <> 'integer'
    OR NEW.reserved_generation < OLD.reserved_generation
  THEN RAISE(ABORT, 'live session fence: invalid or non-monotonic reserved_generation') END;
  SELECT CASE WHEN
    NEW.head_run_generation IS NOT NULL
    AND (typeof(NEW.head_run_generation) <> 'integer' OR NEW.head_run_generation <= 0)
    OR (
      OLD.head_run_generation IS NOT NULL
      AND (
        NEW.head_run_generation IS NULL
        OR NEW.head_run_generation < OLD.head_run_generation
      )
    )
  THEN RAISE(ABORT, 'live session fence: invalid head_run_generation') END;
  SELECT CASE WHEN
    NEW.head_session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM agent_sessions AS head
      WHERE head.id = NEW.head_session_id
        AND head.project_id = NEW.project_id
        AND head.lineage_id = NEW.id
        AND head.incarnation = NEW.head_incarnation
    )
  THEN RAISE(ABORT, 'live session fence: invalid head_session_id') END;
  SELECT CASE WHEN
    NEW.active_reservation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM session_launch_reservations AS active
      WHERE active.id = NEW.active_reservation_id
        AND active.project_id = NEW.project_id
        AND active.lineage_id = NEW.id
        AND active.generation = NEW.reserved_generation
        AND active.state = 'ISSUED'
    )
  THEN RAISE(ABORT, 'live session fence: invalid active_reservation_id') END;
  SELECT CASE WHEN
    (NEW.head_run_id IS NULL) <> (NEW.head_run_generation IS NULL)
    OR (
      NEW.head_run_id IS NOT NULL
      AND (
        NOT EXISTS (
          SELECT 1
          FROM session_launch_reservations AS head_run
          WHERE head_run.project_id = NEW.project_id
            AND head_run.lineage_id = NEW.id
            AND head_run.run_id = NEW.head_run_id
            AND head_run.generation = NEW.head_run_generation
        )
        OR NOT EXISTS (
          SELECT 1
          FROM agent_sessions AS head
          WHERE head.id = NEW.head_session_id
            AND head.launcher_run_id = NEW.head_run_id
            AND head.launch_generation = NEW.head_run_generation
        )
      )
    )
  THEN RAISE(ABORT, 'live session fence: invalid head_run identity') END;
END;

CREATE TRIGGER live_session_fence_session_identity_update
BEFORE UPDATE OF project_id, lineage_id, incarnation, launcher_run_id, launch_generation
ON agent_sessions
WHEN EXISTS (
  SELECT 1
  FROM session_lineages AS lineage
  WHERE lineage.head_session_id = OLD.id
    AND (
      NEW.project_id <> lineage.project_id
      OR NEW.lineage_id IS NOT lineage.id
      OR NEW.incarnation IS NOT lineage.head_incarnation
      OR (
        lineage.head_run_id IS NOT NULL
        AND (
          NEW.launcher_run_id IS NOT lineage.head_run_id
          OR NEW.launch_generation IS NOT lineage.head_run_generation
        )
      )
    )
)
OR EXISTS (
  SELECT 1
  FROM session_launch_reservations AS reservation
  WHERE reservation.expected_head_session_id = OLD.id
    AND (
      NEW.project_id <> reservation.project_id
      OR NEW.lineage_id IS NOT reservation.lineage_id
    )
)
OR EXISTS (
  SELECT 1
  FROM session_launch_reservations AS reservation
  WHERE reservation.consumed_session_id = OLD.id
    AND (
      NEW.project_id <> reservation.project_id
      OR NEW.lineage_id IS NOT reservation.lineage_id
      OR NEW.launcher_run_id IS NOT reservation.run_id
      OR NEW.launch_generation IS NOT reservation.generation
    )
)
BEGIN
  SELECT RAISE(ABORT, 'live session fence: referenced session identity is immutable');
END;

CREATE TRIGGER live_session_fence_reservation_insert
BEFORE INSERT ON session_launch_reservations
WHEN typeof(NEW.generation) <> 'integer'
  OR NEW.generation <= 0
  OR NOT EXISTS (
    SELECT 1
    FROM session_lineages AS lineage
    WHERE lineage.id = NEW.lineage_id
      AND lineage.project_id = NEW.project_id
      AND NEW.generation = lineage.reserved_generation + 1
  )
  OR (
    NEW.expected_head_session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM agent_sessions AS expected_head
      WHERE expected_head.id = NEW.expected_head_session_id
        AND expected_head.project_id = NEW.project_id
        AND expected_head.lineage_id = NEW.lineage_id
    )
  )
  OR NEW.state <> 'ISSUED'
  OR NEW.consumed_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'live session fence: invalid launch reservation');
END;

CREATE TRIGGER live_session_fence_reservation_update
BEFORE UPDATE ON session_launch_reservations
WHEN NEW.project_id <> OLD.project_id
  OR NEW.lineage_id <> OLD.lineage_id
  OR NEW.run_id <> OLD.run_id
  OR NEW.generation <> OLD.generation
  OR typeof(NEW.generation) <> 'integer'
  OR NEW.expected_head_session_id IS NOT OLD.expected_head_session_id
  OR (
    OLD.state <> 'ISSUED'
    AND NEW.state <> OLD.state
  )
  OR (
    OLD.state = 'ISSUED'
    AND NEW.state NOT IN ('ISSUED', 'CONSUMED', 'SUPERSEDED')
  )
  OR (
    NEW.state = 'CONSUMED'
    AND NOT EXISTS (
      SELECT 1
      FROM agent_sessions AS consumed
      WHERE consumed.id = NEW.consumed_session_id
        AND consumed.project_id = NEW.project_id
        AND consumed.lineage_id = NEW.lineage_id
        AND consumed.launcher_run_id = NEW.run_id
        AND consumed.launch_generation = NEW.generation
    )
  )
  OR (NEW.state IN ('ISSUED', 'SUPERSEDED') AND NEW.consumed_session_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'live session fence: invalid launch reservation update');
END;
