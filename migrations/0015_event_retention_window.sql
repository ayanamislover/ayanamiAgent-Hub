-- The events log was append-only with no exit. 0007 installed
-- authority_events_immutable_delete BEFORE DELETE ON events with no WHEN clause, so no row could
-- ever leave, at any age, for any reason. Measured on a six-day-old database: 44,696 rows and
-- 27.5 MB of the 88 MB total, arriving at ~7,450 rows/day, of which 77% are adapter.item.started,
-- adapter.item.completed and adapter.history.reference_missing -- Codex transcript telemetry that
-- backs no authority record. Left alone that is roughly 2.7M rows and 1.3 GB after a year.
--
-- What the unconditional trigger was protecting is already protected more precisely: every table
-- that builds on an event -- authority_events, delegation_events, message_surface_handoffs and the
-- directive tables -- references events(id) and events(project_id, sequence) ON DELETE RESTRICT,
-- and the Hub runs with foreign_keys = ON. A load-bearing event cannot be deleted whatever this
-- trigger says. The trigger's own contribution was blanket coverage of everything else.
--
-- So the guarantee is narrowed from "no event may ever be deleted" to "no event inside the
-- retention window may be deleted", which is a rule the schema can state and enforce against any
-- client rather than one that depends on which script an operator ran. The window is a single
-- stored row so the database, not the caller, decides what "recent" means; a caller passing a
-- longer --days than the stored policy still cannot reach past it.
--
-- Fail-closed on purpose: with the policy row missing the COALESCE floor is older than every
-- possible timestamp, so the WHEN clause matches every row and all deletes abort. Losing the
-- policy locks the log rather than opening it.
--
-- authority_events_immutable_update is deliberately untouched. Editing history and expiring it are
-- different acts; an event's contents remain immutable for as long as the row exists.

CREATE TABLE event_retention_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  days INTEGER NOT NULL CHECK (days IN (7, 14, 30, 90, 180, 365)),
  updated_at TEXT NOT NULL
);

INSERT INTO event_retention_policy (id, days, updated_at)
VALUES (1, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

DROP TRIGGER authority_events_immutable_delete;

CREATE TRIGGER events_retention_delete BEFORE DELETE ON events
WHEN OLD.created_at >= COALESCE(
  (
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || days || ' days')
      FROM event_retention_policy WHERE id = 1
  ),
  '0000-01-01T00:00:00.000Z'
)
BEGIN
  SELECT RAISE(ABORT, 'authority event log is append-only inside the retention window');
END;
