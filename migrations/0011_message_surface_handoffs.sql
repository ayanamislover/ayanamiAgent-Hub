-- Durable, append-only proof that one confirmed model surface was inherited by an exact
-- same-lineage successor. The original surface remains immutable; this ledger records who may
-- continue ACK/PROCESSED lifecycle work without pretending to have performed the model delivery.
CREATE TABLE message_surface_handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  recipient_id TEXT NOT NULL REFERENCES message_recipients(id) ON DELETE RESTRICT,
  surface_attempt_id TEXT NOT NULL REFERENCES message_surface_attempts(id) ON DELETE RESTRICT,
  lineage_id TEXT NOT NULL REFERENCES session_lineages(id) ON DELETE RESTRICT,
  source_surface_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  predecessor_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  successor_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  source_surface_incarnation INTEGER NOT NULL
    CHECK(typeof(source_surface_incarnation) = 'integer' AND source_surface_incarnation > 0),
  predecessor_incarnation INTEGER NOT NULL
    CHECK(typeof(predecessor_incarnation) = 'integer' AND predecessor_incarnation > 0),
  successor_incarnation INTEGER NOT NULL
    CHECK(typeof(successor_incarnation) = 'integer' AND successor_incarnation > 0),
  recipient_fence INTEGER NOT NULL
    CHECK(typeof(recipient_fence) = 'integer' AND recipient_fence > 0),
  server_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id, server_sequence)
    REFERENCES events(project_id, sequence) ON DELETE RESTRICT,
  UNIQUE(surface_attempt_id, predecessor_session_id),
  UNIQUE(surface_attempt_id, successor_session_id),
  UNIQUE(event_id)
);

-- A v10 process may already have committed event-backed handoffs before this forward migration is
-- installed. Reconstruct only rows whose complete immutable surface/delivery/session provenance is
-- still provable. The guard below makes any partial, forged, or non-contiguous history fail the
-- whole migration rather than silently stranding the next successor.
INSERT INTO message_surface_handoffs(
  id, project_id, message_id, recipient_id, surface_attempt_id, lineage_id,
  source_surface_session_id, predecessor_session_id, successor_session_id,
  source_surface_incarnation, predecessor_incarnation, successor_incarnation,
  recipient_fence, server_sequence, event_id, created_at
)
SELECT
  'msh_legacy_' || event.id,
  event.project_id,
  event.aggregate_id,
  json_extract(event.payload_json, '$.recipientId'),
  event.causation_id,
  json_extract(event.payload_json, '$.lineageId'),
  json_extract(event.payload_json, '$.sessionId'),
  json_extract(event.payload_json, '$.previousRecipientSessionId'),
  json_extract(event.payload_json, '$.reboundToSessionId'),
  json_extract(event.payload_json, '$.sessionIncarnation'),
  predecessor.incarnation,
  successor.incarnation,
  json_extract(event.payload_json, '$.recipientFence'),
  event.sequence,
  event.id,
  event.created_at
FROM events event
JOIN messages message ON message.id = event.aggregate_id AND message.project_id = event.project_id
JOIN message_surface_attempts surface
  ON surface.id = event.causation_id AND surface.message_id = message.id
JOIN message_recipients recipient
  ON recipient.id = json_extract(event.payload_json, '$.recipientId')
 AND recipient.message_id = message.id AND recipient.id = surface.recipient_id
JOIN agent_sessions source_session
  ON source_session.id = json_extract(event.payload_json, '$.sessionId')
JOIN agent_sessions predecessor
  ON predecessor.id = json_extract(event.payload_json, '$.previousRecipientSessionId')
JOIN agent_sessions successor
  ON successor.id = json_extract(event.payload_json, '$.reboundToSessionId')
JOIN session_lineages lineage
  ON lineage.id = json_extract(event.payload_json, '$.lineageId')
JOIN agent_sessions current_recipient ON current_recipient.id = recipient.recipient_session_id
WHERE event.type = 'message.surface.confirmed_handoff'
  AND event.actor_type = 'system' AND event.actor_id = 'session-replacement'
  AND event.aggregate_type = 'message' AND event.correlation_id = message.thread_id
  AND surface.session_id = source_session.id
  AND surface.session_incarnation = json_extract(event.payload_json, '$.sessionIncarnation')
  AND surface.recipient_fence = json_extract(event.payload_json, '$.recipientFence')
  AND surface.state = 'CONFIRMED' AND surface.error IS NULL AND surface.confirmed_at IS NOT NULL
  AND recipient.recipient_agent_id = source_session.agent_id
  AND recipient.surface_fence = surface.recipient_fence
  AND recipient.state IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED', 'RESPONDED')
  AND source_session.project_id = event.project_id AND source_session.lineage_id = lineage.id
  AND source_session.incarnation = surface.session_incarnation
  AND predecessor.project_id = event.project_id
  AND predecessor.agent_id = source_session.agent_id AND predecessor.lineage_id = lineage.id
  AND successor.project_id = event.project_id
  AND successor.agent_id = source_session.agent_id AND successor.lineage_id = lineage.id
  AND successor.predecessor_session_id = predecessor.id
  AND successor.incarnation = predecessor.incarnation + 1
  AND lineage.project_id = event.project_id AND lineage.agent_id = source_session.agent_id
  AND current_recipient.project_id = event.project_id
  AND current_recipient.agent_id = source_session.agent_id
  AND current_recipient.lineage_id = lineage.id
  AND current_recipient.incarnation >= successor.incarnation
  AND EXISTS (
    SELECT 1 FROM message_deliveries delivery
    WHERE delivery.recipient_id = recipient.id AND delivery.session_id = source_session.id
      AND delivery.state = 'DELIVERED' AND delivery.completed_at IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM events receipt
    WHERE receipt.project_id = event.project_id
      AND receipt.type IN (
        'message.delivered', 'message.acknowledged', 'message.processed', 'message.responded'
      )
      AND receipt.actor_type = 'agent' AND receipt.actor_id = source_session.agent_id
      AND receipt.aggregate_type = 'message' AND receipt.aggregate_id = message.id
      AND json_extract(receipt.payload_json, '$.recipientId') = recipient.id
      AND json_extract(receipt.payload_json, '$.sessionId') = source_session.id
       AND json_extract(receipt.payload_json, '$.surfaceAttemptId') = surface.id
       AND json_extract(receipt.payload_json, '$.recipientFence') = surface.recipient_fence
      AND receipt.sequence < event.sequence
  )
  AND (
    NOT EXISTS (SELECT 1 FROM message_directive_links link WHERE link.message_id = message.id)
    OR EXISTS (
      SELECT 1 FROM message_directive_links link
      JOIN authority_events delivered ON delivered.directive_id = link.directive_id
      WHERE link.message_id = message.id AND delivered.event_type = 'DELIVERED'
        AND delivered.target_agent_id = source_session.agent_id
        AND delivered.actor_session_id = source_session.id
        AND json_extract(delivered.payload_json, '$.carrierMessageId') = message.id
        AND json_extract(delivered.payload_json, '$.targetAgentId') = source_session.agent_id
        AND json_extract(delivered.payload_json, '$.sessionId') = source_session.id
       AND json_extract(delivered.payload_json, '$.surfaceAttemptId') = surface.id
       AND json_extract(delivered.payload_json, '$.recipientFence') = surface.recipient_fence
      AND delivered.server_sequence < event.sequence
    )
  )
ORDER BY event.sequence;

CREATE TEMP TABLE message_surface_handoff_migration_guard (
  valid INTEGER NOT NULL CONSTRAINT message_surface_handoff_migration_safe CHECK(valid = 1)
);
INSERT INTO message_surface_handoff_migration_guard(valid)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM events WHERE type = 'message.surface.confirmed_handoff') =
    (SELECT COUNT(*) FROM message_surface_handoffs)
  AND NOT EXISTS (
    SELECT 1 FROM message_surface_handoffs handoff
    WHERE handoff.source_surface_session_id <> handoff.predecessor_session_id
      AND NOT EXISTS (
        SELECT 1 FROM message_surface_handoffs prior
        WHERE prior.project_id = handoff.project_id
          AND prior.message_id = handoff.message_id
          AND prior.recipient_id = handoff.recipient_id
          AND prior.surface_attempt_id = handoff.surface_attempt_id
          AND prior.lineage_id = handoff.lineage_id
          AND prior.source_surface_session_id = handoff.source_surface_session_id
          AND prior.source_surface_incarnation = handoff.source_surface_incarnation
          AND prior.successor_session_id = handoff.predecessor_session_id
          AND prior.successor_incarnation = handoff.predecessor_incarnation
          AND prior.recipient_fence = handoff.recipient_fence
          AND prior.server_sequence < handoff.server_sequence
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM message_surface_attempts surface
    JOIN message_recipients recipient ON recipient.id = surface.recipient_id
    JOIN messages message ON message.id = surface.message_id
    JOIN agent_sessions source_session ON source_session.id = surface.session_id
    WHERE surface.state = 'CONFIRMED'
      AND surface.error IS NULL
      AND surface.confirmed_at IS NOT NULL
      AND recipient.recipient_session_id IS NOT surface.session_id
      AND recipient.message_id = message.id
      AND recipient.recipient_agent_id = source_session.agent_id
      AND recipient.surface_fence = surface.recipient_fence
      AND NOT EXISTS (
        SELECT 1
        FROM agent_sessions current_recipient
        JOIN session_lineages lineage ON lineage.id = current_recipient.lineage_id
        JOIN message_surface_handoffs final_handoff
          ON final_handoff.successor_session_id = current_recipient.id
        WHERE current_recipient.id = recipient.recipient_session_id
          AND current_recipient.project_id = message.project_id
          AND current_recipient.agent_id = source_session.agent_id
          AND current_recipient.lineage_id = source_session.lineage_id
          AND lineage.project_id = message.project_id
          AND lineage.agent_id = source_session.agent_id
          AND lineage.head_session_id = current_recipient.id
          AND lineage.head_incarnation = current_recipient.incarnation
          AND final_handoff.project_id = message.project_id
          AND final_handoff.message_id = message.id
          AND final_handoff.recipient_id = recipient.id
          AND final_handoff.surface_attempt_id = surface.id
          AND final_handoff.lineage_id = source_session.lineage_id
          AND final_handoff.source_surface_session_id = surface.session_id
          AND final_handoff.source_surface_incarnation = surface.session_incarnation
          AND final_handoff.successor_session_id = current_recipient.id
          AND final_handoff.successor_incarnation = current_recipient.incarnation
          AND final_handoff.recipient_fence = surface.recipient_fence
      )
  )
THEN 1 ELSE 0 END;
DROP TABLE message_surface_handoff_migration_guard;

CREATE TRIGGER message_surface_handoffs_immutable_update
BEFORE UPDATE ON message_surface_handoffs
BEGIN SELECT RAISE(ABORT, 'message surface handoffs are immutable'); END;

CREATE TRIGGER message_surface_handoffs_immutable_delete
BEFORE DELETE ON message_surface_handoffs
BEGIN SELECT RAISE(ABORT, 'message surface handoffs cannot be deleted'); END;

CREATE TRIGGER message_surface_handoffs_guard
BEFORE INSERT ON message_surface_handoffs
WHEN NOT EXISTS (
  SELECT 1
  FROM message_surface_attempts surface
  JOIN message_recipients recipient ON recipient.id = NEW.recipient_id
  JOIN messages message ON message.id = NEW.message_id
  JOIN agent_sessions source_session ON source_session.id = NEW.source_surface_session_id
  JOIN agent_sessions predecessor ON predecessor.id = NEW.predecessor_session_id
  JOIN agent_sessions successor ON successor.id = NEW.successor_session_id
  JOIN session_lineages lineage ON lineage.id = NEW.lineage_id
  JOIN events event ON event.id = NEW.event_id
  WHERE surface.id = NEW.surface_attempt_id
    AND surface.message_id = NEW.message_id
    AND surface.recipient_id = NEW.recipient_id
    AND surface.session_id = NEW.source_surface_session_id
    AND surface.session_incarnation = NEW.source_surface_incarnation
    AND surface.recipient_fence = NEW.recipient_fence
    AND surface.state = 'CONFIRMED' AND surface.error IS NULL
    AND surface.confirmed_at IS NOT NULL
    AND recipient.message_id = NEW.message_id
    AND recipient.recipient_agent_id = source_session.agent_id
    AND recipient.recipient_session_id = NEW.predecessor_session_id
    AND recipient.surface_fence = NEW.recipient_fence
    AND recipient.state IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED', 'RESPONDED')
    AND message.project_id = NEW.project_id
    AND source_session.project_id = NEW.project_id
    AND source_session.lineage_id = NEW.lineage_id
    AND source_session.incarnation = NEW.source_surface_incarnation
    AND predecessor.project_id = NEW.project_id
    AND predecessor.agent_id = source_session.agent_id
    AND predecessor.lineage_id = NEW.lineage_id
    AND predecessor.incarnation = NEW.predecessor_incarnation
    AND successor.project_id = NEW.project_id
    AND successor.agent_id = source_session.agent_id
    AND successor.lineage_id = NEW.lineage_id
    AND successor.predecessor_session_id = NEW.predecessor_session_id
    AND successor.incarnation = NEW.successor_incarnation
    AND NEW.successor_incarnation = NEW.predecessor_incarnation + 1
    AND lineage.project_id = NEW.project_id
    AND lineage.agent_id = source_session.agent_id
    AND lineage.head_session_id = NEW.predecessor_session_id
    AND lineage.head_incarnation = NEW.predecessor_incarnation
    AND EXISTS (
      SELECT 1 FROM message_deliveries delivery
      WHERE delivery.recipient_id = NEW.recipient_id
        AND delivery.session_id = NEW.source_surface_session_id
        AND delivery.state = 'DELIVERED' AND delivery.completed_at IS NOT NULL
    )
    AND EXISTS (
      SELECT 1 FROM events receipt
      WHERE receipt.project_id = NEW.project_id
        AND receipt.type IN (
          'message.delivered', 'message.acknowledged',
          'message.processed', 'message.responded'
        )
        AND receipt.actor_type = 'agent' AND receipt.actor_id = source_session.agent_id
        AND receipt.aggregate_type = 'message' AND receipt.aggregate_id = NEW.message_id
        AND json_extract(receipt.payload_json, '$.recipientId') = NEW.recipient_id
        AND json_extract(receipt.payload_json, '$.sessionId') = NEW.source_surface_session_id
         AND json_extract(receipt.payload_json, '$.surfaceAttemptId') = NEW.surface_attempt_id
         AND json_extract(receipt.payload_json, '$.recipientFence') = NEW.recipient_fence
        AND receipt.sequence < NEW.server_sequence
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM message_directive_links link WHERE link.message_id = NEW.message_id
      )
      OR EXISTS (
        SELECT 1 FROM message_directive_links link
        JOIN authority_events delivered ON delivered.directive_id = link.directive_id
        WHERE link.message_id = NEW.message_id AND delivered.event_type = 'DELIVERED'
          AND delivered.target_agent_id = source_session.agent_id
          AND delivered.actor_session_id = NEW.source_surface_session_id
          AND json_extract(delivered.payload_json, '$.carrierMessageId') = NEW.message_id
          AND json_extract(delivered.payload_json, '$.targetAgentId') = source_session.agent_id
          AND json_extract(delivered.payload_json, '$.sessionId') = NEW.source_surface_session_id
           AND json_extract(delivered.payload_json, '$.surfaceAttemptId') = NEW.surface_attempt_id
           AND json_extract(delivered.payload_json, '$.recipientFence') = NEW.recipient_fence
          AND delivered.server_sequence < NEW.server_sequence
      )
    )
    AND (
      NEW.source_surface_session_id = NEW.predecessor_session_id
      OR EXISTS (
        SELECT 1 FROM message_surface_handoffs prior
        WHERE prior.project_id = NEW.project_id
          AND prior.message_id = NEW.message_id
          AND prior.recipient_id = NEW.recipient_id
          AND prior.surface_attempt_id = NEW.surface_attempt_id
          AND prior.lineage_id = NEW.lineage_id
          AND prior.source_surface_session_id = NEW.source_surface_session_id
          AND prior.source_surface_incarnation = NEW.source_surface_incarnation
          AND prior.successor_session_id = NEW.predecessor_session_id
           AND prior.successor_incarnation = NEW.predecessor_incarnation
           AND prior.recipient_fence = NEW.recipient_fence
          AND prior.server_sequence < NEW.server_sequence
      )
    )
    AND event.project_id = NEW.project_id AND event.sequence = NEW.server_sequence
    AND event.created_at = NEW.created_at
    AND event.type = 'message.surface.confirmed_handoff'
    AND event.actor_type = 'system' AND event.actor_id = 'session-replacement'
    AND event.aggregate_type = 'message' AND event.aggregate_id = NEW.message_id
    AND event.causation_id = NEW.surface_attempt_id
    AND event.correlation_id = message.thread_id
    AND json_extract(event.payload_json, '$.recipientId') = NEW.recipient_id
    AND json_extract(event.payload_json, '$.sessionId') = NEW.source_surface_session_id
    AND json_extract(event.payload_json, '$.sessionIncarnation') = NEW.source_surface_incarnation
    AND json_extract(event.payload_json, '$.recipientFence') = NEW.recipient_fence
    AND json_extract(event.payload_json, '$.previousRecipientSessionId') = NEW.predecessor_session_id
    AND json_extract(event.payload_json, '$.reboundToSessionId') = NEW.successor_session_id
    AND json_extract(event.payload_json, '$.lineageId') = NEW.lineage_id
)
BEGIN SELECT RAISE(ABORT, 'message surface handoff provenance is invalid'); END;

-- 0008 correctly required the delivery actor to own the immutable surface. A later same-lineage
-- successor must not rewrite that fact, but it may truthfully ACK/PROCESS it when the exact handoff
-- ledger above proves the ordered inheritance. Rebuild the trigger forward; never rewrite 0008.
DROP TRIGGER authority_events_guard;

CREATE TRIGGER authority_events_guard
BEFORE INSERT ON authority_events
WHEN NOT EXISTS (
  SELECT 1 FROM authority_directives directive
  JOIN events event ON event.id = NEW.event_id
  WHERE directive.id = NEW.directive_id AND directive.project_id = NEW.project_id
    AND event.project_id = NEW.project_id AND event.sequence = NEW.server_sequence
    AND event.type = 'directive.' || lower(NEW.event_type)
    AND event.aggregate_type = 'authority_directive' AND event.aggregate_id = NEW.directive_id
    AND event.correlation_id = NEW.correlation_id
    AND event.causation_id IS NEW.causation_id
    AND json(event.payload_json) = json(NEW.payload_json)
    AND (
      NEW.target_agent_id IS NULL
      OR EXISTS (
        SELECT 1 FROM json_each(directive.target_agent_ids_json) audience
        WHERE audience.value = NEW.target_agent_id
      )
    )
    AND (
      (NEW.actor_session_id IS NOT NULL AND NEW.actor_principal_id IS NULL
        AND EXISTS (
          SELECT 1 FROM agent_sessions session
          WHERE session.id = NEW.actor_session_id AND session.project_id = NEW.project_id
            AND (NEW.target_agent_id IS NULL OR session.agent_id = NEW.target_agent_id)
            AND event.actor_type = 'agent' AND event.actor_id = session.agent_id
        ))
      OR
      (NEW.actor_session_id IS NULL AND NEW.actor_principal_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM auth_principals principal
          WHERE principal.id = NEW.actor_principal_id AND principal.status = 'ACTIVE'
            AND (
              (principal.kind = 'DASHBOARD_USER'
                AND event.actor_type = 'user' AND event.actor_id = principal.display_name)
              OR (principal.kind = 'AGENT'
                AND event.actor_type = 'agent'
                AND event.actor_id = COALESCE(principal.client_type, principal.display_name))
              OR (principal.kind = 'SYSTEM'
                AND event.actor_type = 'system' AND event.actor_id = principal.display_name)
            )
        ))
    )
    AND (
      NEW.event_type NOT IN ('REVOKED', 'SUPERSEDED', 'EXPIRED', 'COMPLETED')
      OR (NEW.event_type IN ('REVOKED', 'SUPERSEDED')
        AND NEW.actor_session_id IS NULL
        AND EXISTS (
          SELECT 1 FROM auth_principals principal
          WHERE principal.id = NEW.actor_principal_id
            AND principal.kind = 'DASHBOARD_USER' AND principal.status = 'ACTIVE'
        ))
      OR (NEW.event_type = 'EXPIRED'
        AND NEW.actor_session_id IS NULL
        AND NEW.actor_principal_id = 'prn_authority_system'
        AND EXISTS (
          SELECT 1 FROM auth_principals principal
          WHERE principal.id = NEW.actor_principal_id
            AND principal.kind = 'SYSTEM' AND principal.status = 'ACTIVE'
        ))
      OR (NEW.event_type = 'COMPLETED'
        AND NEW.actor_principal_id IS NULL AND NEW.actor_session_id IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT result.target_agent_id)
          FROM directive_execution_results result
          WHERE result.directive_id = NEW.directive_id
        ) = json_array_length(directive.target_agent_ids_json))
    )
    AND (
      (NEW.event_type = 'ISSUED'
        AND NEW.from_lifecycle IS NULL AND NEW.to_lifecycle = 'ACTIVE')
      OR (NEW.event_type IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED', 'RESULT_RECORDED')
        AND NEW.from_lifecycle = 'ACTIVE' AND NEW.to_lifecycle = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM authority_events terminal
          WHERE terminal.directive_id = NEW.directive_id
            AND terminal.event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
        ))
      OR (NEW.event_type IN ('ACKNOWLEDGED', 'PROCESSED', 'RESULT_RECORDED')
        AND NEW.from_lifecycle = NEW.to_lifecycle
        AND NEW.from_lifecycle IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
        AND EXISTS (
          SELECT 1 FROM authority_events terminal
          WHERE terminal.directive_id = NEW.directive_id
            AND terminal.event_type = NEW.from_lifecycle
            AND terminal.server_sequence < NEW.server_sequence
        )
        AND (
          NEW.event_type = 'RESULT_RECORDED'
          OR EXISTS (
            SELECT 1
            FROM authority_events terminal
            JOIN authority_events delivered ON delivered.directive_id = terminal.directive_id
            JOIN message_surface_attempts surface
              ON surface.id = json_extract(NEW.payload_json, '$.surfaceAttemptId')
            WHERE terminal.directive_id = NEW.directive_id
              AND terminal.event_type = NEW.from_lifecycle
              AND terminal.server_sequence < NEW.server_sequence
              AND delivered.event_type = 'DELIVERED'
              AND delivered.target_agent_id = NEW.target_agent_id
              AND delivered.actor_session_id = surface.session_id
              AND delivered.server_sequence < terminal.server_sequence
              AND json_extract(delivered.payload_json, '$.surfaceAttemptId') = surface.id
              AND json_extract(delivered.payload_json, '$.recipientFence') = surface.recipient_fence
          )
        ))
      OR (NEW.event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED')
        AND NEW.from_lifecycle = 'ACTIVE' AND NEW.to_lifecycle = NEW.event_type)
    )
    AND (
      NEW.event_type NOT IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED')
      OR (
        NEW.causation_id = directive.carrier_message_id
        AND json_extract(NEW.payload_json, '$.carrierMessageId') = directive.carrier_message_id
        AND json_extract(NEW.payload_json, '$.targetAgentId') = NEW.target_agent_id
        AND json_extract(NEW.payload_json, '$.sessionId') = NEW.actor_session_id
        AND json_type(NEW.payload_json, '$.surfaceAttemptId') = 'text'
        AND json_type(NEW.payload_json, '$.recipientFence') = 'integer'
        AND EXISTS (
          SELECT 1
          FROM message_directive_links link
          JOIN message_surface_attempts surface
            ON surface.id = json_extract(NEW.payload_json, '$.surfaceAttemptId')
          JOIN message_recipients recipient ON recipient.id = surface.recipient_id
          WHERE link.directive_id = directive.id
            AND link.message_id = directive.carrier_message_id
            AND surface.message_id = directive.carrier_message_id
            AND surface.recipient_fence = json_extract(NEW.payload_json, '$.recipientFence')
            AND surface.state = 'CONFIRMED'
            AND recipient.message_id = directive.carrier_message_id
            AND recipient.recipient_agent_id = NEW.target_agent_id
            AND recipient.recipient_session_id = NEW.actor_session_id
            AND recipient.surface_fence = surface.recipient_fence
            AND EXISTS (
              SELECT 1 FROM agent_sessions actor_session
              JOIN session_lineages actor_lineage ON actor_lineage.id = actor_session.lineage_id
              WHERE actor_session.id = NEW.actor_session_id
                AND actor_session.project_id = NEW.project_id
                AND actor_session.agent_id = NEW.target_agent_id
                AND actor_session.incarnation = actor_lineage.head_incarnation
                AND actor_lineage.head_session_id = actor_session.id
            )
            AND (
              (NEW.event_type = 'DELIVERED' AND surface.session_id = NEW.actor_session_id)
              OR (NEW.event_type IN ('ACKNOWLEDGED', 'PROCESSED') AND (
                surface.session_id = NEW.actor_session_id
                OR EXISTS (
                  SELECT 1 FROM message_surface_handoffs handoff
                  WHERE handoff.project_id = NEW.project_id
                    AND handoff.message_id = directive.carrier_message_id
                    AND handoff.recipient_id = surface.recipient_id
                    AND handoff.surface_attempt_id = surface.id
                    AND handoff.source_surface_session_id = surface.session_id
                    AND handoff.source_surface_incarnation = surface.session_incarnation
                    AND handoff.successor_session_id = NEW.actor_session_id
                    AND handoff.recipient_fence = surface.recipient_fence
                )
              ))
            )
        )
      )
    )
    AND (
      NEW.event_type NOT IN ('ACKNOWLEDGED', 'PROCESSED')
      OR EXISTS (
        SELECT 1 FROM authority_events delivered
        JOIN message_surface_attempts surface
          ON surface.id = json_extract(NEW.payload_json, '$.surfaceAttemptId')
        WHERE delivered.directive_id = NEW.directive_id
          AND delivered.event_type = 'DELIVERED'
          AND delivered.target_agent_id = NEW.target_agent_id
          AND delivered.actor_session_id = surface.session_id
          AND delivered.server_sequence < NEW.server_sequence
          AND json_extract(delivered.payload_json, '$.surfaceAttemptId') = surface.id
          AND json_extract(delivered.payload_json, '$.recipientFence') = surface.recipient_fence
      )
    )
    AND (
      NEW.event_type <> 'RESULT_RECORDED'
      OR EXISTS (
        SELECT 1 FROM authority_events processed
        WHERE processed.directive_id = NEW.directive_id
          AND processed.event_type = 'PROCESSED'
          AND processed.target_agent_id = NEW.target_agent_id
          AND processed.actor_session_id = NEW.actor_session_id
          AND (
            NEW.from_lifecycle = 'ACTIVE'
            OR EXISTS (
              SELECT 1 FROM authority_events terminal
              WHERE terminal.directive_id = NEW.directive_id
                AND terminal.event_type = NEW.from_lifecycle
                AND processed.server_sequence < terminal.server_sequence
            )
          )
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'authority event provenance is invalid'); END;
