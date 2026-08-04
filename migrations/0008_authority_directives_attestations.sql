-- Signed directives, bounded delegation, and append-only Authority provenance.

DROP TRIGGER auth_principals_closed_set_insert;
CREATE TRIGGER auth_principals_closed_set_insert
BEFORE INSERT ON auth_principals
WHEN NEW.id NOT IN (
  'prn_local_agent', 'prn_agent_codex', 'prn_agent_claude', 'prn_local_dashboard',
  'prn_capture_codex', 'prn_capture_claude', 'prn_inject_codex', 'prn_inject_claude',
  'prn_authority_system'
)
BEGIN
  SELECT RAISE(ABORT, 'auth principal set is closed');
END;

INSERT INTO auth_principals(
  id, kind, display_name, project_id, client_type, session_id, status, created_at, updated_at
) VALUES (
  'prn_authority_system', 'SYSTEM', 'Authority lifecycle clock', NULL, NULL, NULL,
  'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

DROP TRIGGER auth_credentials_closed_set_insert;
CREATE TRIGGER auth_credentials_closed_set_insert
BEFORE INSERT ON auth_credentials
WHEN NEW.id NOT IN (
  'crd_local_agent', 'crd_agent_codex', 'crd_agent_claude', 'crd_local_dashboard',
  'crd_capture_codex', 'crd_capture_claude', 'crd_inject_codex', 'crd_inject_claude'
)
BEGIN
  SELECT RAISE(ABORT, 'auth credential set is closed');
END;

CREATE TABLE authority_signing_keys (
  key_id TEXT PRIMARY KEY,
  algorithm TEXT NOT NULL CHECK(algorithm = 'Ed25519'),
  public_key_spki_base64url TEXT NOT NULL UNIQUE,
  fingerprint_sha256 TEXT NOT NULL UNIQUE CHECK(length(fingerprint_sha256) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE authority_key_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES authority_signing_keys(key_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('ACTIVATED', 'RETIRED', 'REVOKED')),
  previous_key_id TEXT REFERENCES authority_signing_keys(key_id) ON DELETE RESTRICT,
  transition_statement_json TEXT NOT NULL,
  transition_signature TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(key_id, event_type)
);

CREATE UNIQUE INDEX one_bootstrap_authority_key
  ON authority_key_events(event_type)
  WHERE event_type = 'ACTIVATED' AND previous_key_id IS NULL;

CREATE TABLE delegation_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_user_turn_id TEXT REFERENCES user_turns(id) ON DELETE RESTRICT,
  created_by_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE delegation_grant_versions (
  grant_id TEXT NOT NULL REFERENCES delegation_grants(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version > 0),
  delegator_agent_ids_json TEXT NOT NULL CHECK(json_valid(delegator_agent_ids_json)),
  target_agent_ids_json TEXT NOT NULL CHECK(json_valid(target_agent_ids_json)),
  allowed_actions_json TEXT NOT NULL CHECK(json_valid(allowed_actions_json)),
  objective_ids_json TEXT NOT NULL CHECK(json_valid(objective_ids_json)),
  task_ids_json TEXT NOT NULL CHECK(json_valid(task_ids_json)),
  file_globs_json TEXT NOT NULL CHECK(json_valid(file_globs_json)),
  max_priority TEXT NOT NULL CHECK(max_priority IN ('BACKGROUND', 'NORMAL', 'IMPORTANT', 'INTERRUPT')),
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  issued_by_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  supersedes_version INTEGER,
  PRIMARY KEY(grant_id, version),
  FOREIGN KEY(grant_id, supersedes_version)
    REFERENCES delegation_grant_versions(grant_id, version) ON DELETE RESTRICT,
  CHECK((version = 1 AND supersedes_version IS NULL) OR (version > 1 AND supersedes_version = version - 1))
);

CREATE TABLE delegation_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  grant_id TEXT NOT NULL REFERENCES delegation_grants(id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('ISSUED', 'MODIFIED', 'TERMINATED', 'EXPIRED')),
  actor_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  actor_session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  server_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(grant_id, grant_version)
    REFERENCES delegation_grant_versions(grant_id, version) ON DELETE RESTRICT,
  FOREIGN KEY(project_id, server_sequence)
    REFERENCES events(project_id, sequence) ON DELETE RESTRICT,
  UNIQUE(event_id),
  UNIQUE(grant_id, grant_version, event_type)
);

CREATE UNIQUE INDEX one_terminal_delegation_event
  ON delegation_events(grant_id)
  WHERE event_type IN ('TERMINATED', 'EXPIRED');

CREATE TABLE authority_directives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  authority TEXT NOT NULL CHECK(authority IN (
    'USER_ATTESTED', 'USER_DELEGATED', 'AGENT_PROPOSAL'
  )),
  source_user_turn_id TEXT REFERENCES user_turns(id) ON DELETE RESTRICT,
  raw_user_turn_sha256 TEXT CHECK(raw_user_turn_sha256 IS NULL OR length(raw_user_turn_sha256) = 64),
  quote_start INTEGER CHECK(quote_start IS NULL OR (typeof(quote_start) = 'integer' AND quote_start >= 0)),
  quote_end INTEGER CHECK(quote_end IS NULL OR (typeof(quote_end) = 'integer' AND quote_end > 0)),
  verbatim_text TEXT,
  verbatim_text_sha256 TEXT CHECK(verbatim_text_sha256 IS NULL OR length(verbatim_text_sha256) = 64),
  delegated_text TEXT,
  agent_interpretation TEXT,
  relay_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  relay_agent_id TEXT NOT NULL CHECK(relay_agent_id IN ('codex', 'claude')),
  relay_session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  target_agent_ids_json TEXT NOT NULL CHECK(json_valid(target_agent_ids_json)),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  priority TEXT NOT NULL CHECK(priority IN ('BACKGROUND', 'NORMAL', 'IMPORTANT', 'INTERRUPT')),
  delegation_grant_id TEXT REFERENCES delegation_grants(id) ON DELETE RESTRICT,
  delegation_version INTEGER,
  attempted_delegation_grant_id TEXT REFERENCES delegation_grants(id) ON DELETE RESTRICT,
  attempted_delegation_version INTEGER,
  supersedes_directive_id TEXT REFERENCES authority_directives(id) ON DELETE RESTRICT,
  server_sequence INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  key_id TEXT REFERENCES authority_signing_keys(key_id) ON DELETE RESTRICT,
  canonical_payload_json TEXT,
  canonical_payload_sha256 TEXT CHECK(canonical_payload_sha256 IS NULL OR length(canonical_payload_sha256) = 64),
  signature TEXT,
  carrier_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE RESTRICT,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  downgrade_reason TEXT,
  FOREIGN KEY(project_id, server_sequence)
    REFERENCES events(project_id, sequence) ON DELETE RESTRICT,
  FOREIGN KEY(delegation_grant_id, delegation_version)
    REFERENCES delegation_grant_versions(grant_id, version) ON DELETE RESTRICT,
  FOREIGN KEY(attempted_delegation_grant_id, attempted_delegation_version)
    REFERENCES delegation_grant_versions(grant_id, version) ON DELETE RESTRICT,
  CHECK(
    (attempted_delegation_grant_id IS NULL AND attempted_delegation_version IS NULL)
    OR (authority = 'AGENT_PROPOSAL'
      AND attempted_delegation_grant_id IS NOT NULL
      AND attempted_delegation_version IS NOT NULL)
  ),
  CHECK(
    (authority IN ('USER_ATTESTED', 'USER_DELEGATED')
      AND key_id IS NOT NULL AND canonical_payload_json IS NOT NULL
      AND canonical_payload_sha256 IS NOT NULL AND signature IS NOT NULL
      AND downgrade_reason IS NULL)
    OR
    (authority = 'AGENT_PROPOSAL'
      AND key_id IS NULL AND canonical_payload_json IS NULL
      AND canonical_payload_sha256 IS NULL AND signature IS NULL
      AND delegated_text IS NOT NULL AND downgrade_reason IS NOT NULL)
  ),
  CHECK(
    (authority = 'USER_ATTESTED'
      AND source_user_turn_id IS NOT NULL AND raw_user_turn_sha256 IS NOT NULL
      AND quote_start IS NOT NULL AND quote_end IS NOT NULL AND quote_start < quote_end
      AND verbatim_text IS NOT NULL AND verbatim_text_sha256 IS NOT NULL
      AND delegation_grant_id IS NULL AND delegation_version IS NULL AND delegated_text IS NULL
      AND attempted_delegation_grant_id IS NULL AND attempted_delegation_version IS NULL)
    OR
    (authority = 'USER_DELEGATED' AND delegation_grant_id IS NOT NULL
      AND delegation_version IS NOT NULL AND delegated_text IS NOT NULL
      AND attempted_delegation_grant_id IS NULL AND attempted_delegation_version IS NULL)
    OR
    (authority = 'AGENT_PROPOSAL' AND delegation_grant_id IS NULL AND delegation_version IS NULL)
  )
);

CREATE TABLE message_directive_links (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE RESTRICT,
  directive_id TEXT NOT NULL UNIQUE REFERENCES authority_directives(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE TABLE authority_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  directive_id TEXT NOT NULL REFERENCES authority_directives(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'PROCESSED', 'RESULT_RECORDED',
    'SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED'
  )),
  actor_principal_id TEXT REFERENCES auth_principals(id) ON DELETE RESTRICT,
  actor_session_id TEXT REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  target_agent_id TEXT CHECK(target_agent_id IS NULL OR target_agent_id IN ('codex', 'claude')),
  server_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  from_lifecycle TEXT,
  to_lifecycle TEXT,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id, server_sequence)
    REFERENCES events(project_id, sequence) ON DELETE RESTRICT,
  UNIQUE(event_id)
);

CREATE UNIQUE INDEX one_terminal_directive_event
  ON authority_events(directive_id)
  WHERE event_type IN ('SUPERSEDED', 'REVOKED', 'COMPLETED', 'EXPIRED');

CREATE UNIQUE INDEX one_directive_issuance_event
  ON authority_events(directive_id)
  WHERE event_type = 'ISSUED';

CREATE UNIQUE INDEX one_directive_target_delivery_fact
  ON authority_events(directive_id, target_agent_id, event_type)
  WHERE event_type IN ('DELIVERED', 'ACKNOWLEDGED', 'PROCESSED');

CREATE UNIQUE INDEX one_directive_target_result_fact
  ON authority_events(directive_id, target_agent_id)
  WHERE event_type = 'RESULT_RECORDED';

CREATE TABLE directive_execution_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  directive_id TEXT NOT NULL REFERENCES authority_directives(id) ON DELETE RESTRICT,
  target_agent_id TEXT NOT NULL CHECK(target_agent_id IN ('codex', 'claude')),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('SUCCEEDED', 'FAILED', 'DECLINED')),
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  server_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id, server_sequence)
    REFERENCES events(project_id, sequence) ON DELETE RESTRICT,
  UNIQUE(directive_id, target_agent_id),
  UNIQUE(event_id)
);

CREATE TRIGGER authority_signing_keys_immutable_update BEFORE UPDATE ON authority_signing_keys
BEGIN SELECT RAISE(ABORT, 'authority signing keys are immutable'); END;
CREATE TRIGGER authority_signing_keys_immutable_delete BEFORE DELETE ON authority_signing_keys
BEGIN SELECT RAISE(ABORT, 'authority signing keys cannot be deleted'); END;
CREATE TRIGGER authority_key_events_immutable_update BEFORE UPDATE ON authority_key_events
BEGIN SELECT RAISE(ABORT, 'authority key events are immutable'); END;
CREATE TRIGGER authority_key_events_immutable_delete BEFORE DELETE ON authority_key_events
BEGIN SELECT RAISE(ABORT, 'authority key events cannot be deleted'); END;
CREATE TRIGGER delegation_grants_immutable_update BEFORE UPDATE ON delegation_grants
BEGIN SELECT RAISE(ABORT, 'delegation grants are immutable'); END;
CREATE TRIGGER delegation_grants_immutable_delete BEFORE DELETE ON delegation_grants
BEGIN SELECT RAISE(ABORT, 'delegation grants cannot be deleted'); END;
CREATE TRIGGER delegation_grant_versions_immutable_update BEFORE UPDATE ON delegation_grant_versions
BEGIN SELECT RAISE(ABORT, 'delegation grant versions are immutable'); END;
CREATE TRIGGER delegation_grant_versions_immutable_delete BEFORE DELETE ON delegation_grant_versions
BEGIN SELECT RAISE(ABORT, 'delegation grant versions cannot be deleted'); END;
CREATE TRIGGER delegation_events_immutable_update BEFORE UPDATE ON delegation_events
BEGIN SELECT RAISE(ABORT, 'delegation events are immutable'); END;
CREATE TRIGGER delegation_events_immutable_delete BEFORE DELETE ON delegation_events
BEGIN SELECT RAISE(ABORT, 'delegation events cannot be deleted'); END;
CREATE TRIGGER authority_directives_immutable_update BEFORE UPDATE ON authority_directives
BEGIN SELECT RAISE(ABORT, 'authority directives are immutable'); END;
CREATE TRIGGER authority_directives_immutable_delete BEFORE DELETE ON authority_directives
BEGIN SELECT RAISE(ABORT, 'authority directives cannot be deleted'); END;
CREATE TRIGGER message_directive_links_immutable_update BEFORE UPDATE ON message_directive_links
BEGIN SELECT RAISE(ABORT, 'message directive links are immutable'); END;
CREATE TRIGGER message_directive_links_immutable_delete BEFORE DELETE ON message_directive_links
BEGIN SELECT RAISE(ABORT, 'message directive links cannot be deleted'); END;
CREATE TRIGGER directive_authority_events_immutable_update BEFORE UPDATE ON authority_events
BEGIN SELECT RAISE(ABORT, 'authority events are immutable'); END;
CREATE TRIGGER directive_authority_events_immutable_delete BEFORE DELETE ON authority_events
BEGIN SELECT RAISE(ABORT, 'authority events cannot be deleted'); END;
CREATE TRIGGER directive_execution_results_immutable_update BEFORE UPDATE ON directive_execution_results
BEGIN SELECT RAISE(ABORT, 'directive execution results are immutable'); END;
CREATE TRIGGER directive_execution_results_immutable_delete BEFORE DELETE ON directive_execution_results
BEGIN SELECT RAISE(ABORT, 'directive execution results cannot be deleted'); END;

CREATE TRIGGER delegation_grants_dashboard_guard
BEFORE INSERT ON delegation_grants
WHEN NOT EXISTS (
  SELECT 1 FROM auth_principals principal
  WHERE principal.id = NEW.created_by_principal_id
    AND principal.kind = 'DASHBOARD_USER' AND principal.status = 'ACTIVE'
)
BEGIN SELECT RAISE(ABORT, 'delegation grants require a Dashboard user'); END;

CREATE TRIGGER delegation_grant_versions_dashboard_guard
BEFORE INSERT ON delegation_grant_versions
WHEN NOT EXISTS (
  SELECT 1 FROM auth_principals principal
  WHERE principal.id = NEW.issued_by_principal_id
    AND principal.kind = 'DASHBOARD_USER' AND principal.status = 'ACTIVE'
)
BEGIN SELECT RAISE(ABORT, 'delegation grant versions require a Dashboard user'); END;

CREATE TRIGGER delegation_events_guard
BEFORE INSERT ON delegation_events
WHEN NOT EXISTS (
  SELECT 1 FROM delegation_grants grant
  JOIN events event ON event.id = NEW.event_id
  JOIN auth_principals principal ON principal.id = NEW.actor_principal_id
  WHERE grant.id = NEW.grant_id AND grant.project_id = NEW.project_id
    AND event.project_id = NEW.project_id AND event.sequence = NEW.server_sequence
    AND event.aggregate_type = 'delegation_grant' AND event.aggregate_id = NEW.grant_id
    AND event.type = 'delegation.' || lower(NEW.event_type)
    AND event.actor_type = CASE WHEN principal.kind = 'SYSTEM' THEN 'system' ELSE 'user' END
    AND event.actor_id = principal.display_name
    AND principal.status = 'ACTIVE'
    AND NEW.actor_session_id IS NULL
    AND (
      (NEW.event_type = 'ISSUED' AND NEW.grant_version = 1)
      OR (NEW.event_type = 'MODIFIED' AND NEW.grant_version > 1)
      OR NEW.event_type IN ('TERMINATED', 'EXPIRED')
    )
    AND (
      (NEW.event_type = 'EXPIRED' AND principal.kind = 'SYSTEM')
      OR (NEW.event_type <> 'EXPIRED' AND principal.kind = 'DASHBOARD_USER')
    )
)
BEGIN SELECT RAISE(ABORT, 'delegation event provenance is invalid'); END;

CREATE TRIGGER authority_directives_issuance_guard
BEFORE INSERT ON authority_directives
WHEN NOT EXISTS (
  SELECT 1 FROM events event
  JOIN auth_principals relay ON relay.id = NEW.relay_principal_id
  WHERE event.project_id = NEW.project_id AND event.sequence = NEW.server_sequence
    AND event.type = 'directive.issued' AND event.aggregate_id = NEW.id
    AND relay.kind = 'AGENT' AND relay.client_type = NEW.relay_agent_id
    AND relay.status = 'ACTIVE'
)
OR (
  NEW.source_user_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM user_turns turn
    WHERE turn.id = NEW.source_user_turn_id AND turn.project_id = NEW.project_id
      AND turn.raw_text_sha256 = NEW.raw_user_turn_sha256
  )
)
OR (
  NEW.delegation_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM delegation_grants grant
    WHERE grant.id = NEW.delegation_grant_id AND grant.project_id = NEW.project_id
  )
)
OR (
  NEW.attempted_delegation_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM delegation_grants grant
    WHERE grant.id = NEW.attempted_delegation_grant_id AND grant.project_id = NEW.project_id
  )
)
OR (
  NEW.supersedes_directive_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM authority_directives old
    WHERE old.id = NEW.supersedes_directive_id AND old.project_id = NEW.project_id
  )
)
OR (
  NEW.relay_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_sessions session
    WHERE session.id = NEW.relay_session_id AND session.project_id = NEW.project_id
      AND session.agent_id = NEW.relay_agent_id
  )
)
BEGIN SELECT RAISE(ABORT, 'directive provenance is invalid'); END;

CREATE TRIGGER message_directive_links_guard
BEFORE INSERT ON message_directive_links
WHEN NOT EXISTS (
  SELECT 1 FROM authority_directives directive
  JOIN messages message ON message.id = NEW.message_id
  WHERE directive.id = NEW.directive_id
    AND directive.carrier_message_id = NEW.message_id
    AND message.project_id = directive.project_id
    AND message.from_agent_id = directive.relay_agent_id
)
BEGIN SELECT RAISE(ABORT, 'directive carrier link is invalid'); END;

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
      (
        NEW.actor_session_id IS NOT NULL AND NEW.actor_principal_id IS NULL
        AND EXISTS (
          SELECT 1 FROM agent_sessions session
          WHERE session.id = NEW.actor_session_id AND session.project_id = NEW.project_id
            AND (NEW.target_agent_id IS NULL OR session.agent_id = NEW.target_agent_id)
            AND event.actor_type = 'agent' AND event.actor_id = session.agent_id
        )
      )
      OR
      (
        NEW.actor_session_id IS NULL AND NEW.actor_principal_id IS NOT NULL
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
        )
      )
    )
    AND (
      NEW.event_type NOT IN ('REVOKED', 'SUPERSEDED', 'EXPIRED', 'COMPLETED')
      OR (
        NEW.event_type IN ('REVOKED', 'SUPERSEDED')
        AND NEW.actor_session_id IS NULL
        AND EXISTS (
          SELECT 1 FROM auth_principals principal
          WHERE principal.id = NEW.actor_principal_id
            AND principal.kind = 'DASHBOARD_USER' AND principal.status = 'ACTIVE'
        )
      )
      OR (
        NEW.event_type = 'EXPIRED'
        AND NEW.actor_session_id IS NULL
        AND NEW.actor_principal_id = 'prn_authority_system'
        AND EXISTS (
          SELECT 1 FROM auth_principals principal
          WHERE principal.id = NEW.actor_principal_id
            AND principal.kind = 'SYSTEM' AND principal.status = 'ACTIVE'
        )
      )
      OR (
        NEW.event_type = 'COMPLETED'
        AND NEW.actor_principal_id IS NULL AND NEW.actor_session_id IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT result.target_agent_id)
          FROM directive_execution_results result
          WHERE result.directive_id = NEW.directive_id
        ) = json_array_length(directive.target_agent_ids_json)
      )
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
            WHERE terminal.directive_id = NEW.directive_id
              AND terminal.event_type = NEW.from_lifecycle
              AND terminal.server_sequence < NEW.server_sequence
              AND delivered.event_type = 'DELIVERED'
              AND delivered.target_agent_id = NEW.target_agent_id
              AND delivered.actor_session_id = NEW.actor_session_id
              AND delivered.server_sequence < terminal.server_sequence
              AND json_extract(delivered.payload_json, '$.surfaceAttemptId') =
                    json_extract(NEW.payload_json, '$.surfaceAttemptId')
              AND json_extract(delivered.payload_json, '$.recipientFence') =
                    json_extract(NEW.payload_json, '$.recipientFence')
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
            AND surface.session_id = NEW.actor_session_id
            AND surface.recipient_fence = json_extract(NEW.payload_json, '$.recipientFence')
            AND surface.state = 'CONFIRMED'
            AND recipient.message_id = directive.carrier_message_id
            AND recipient.recipient_agent_id = NEW.target_agent_id
        )
      )
    )
    AND (
      NEW.event_type NOT IN ('ACKNOWLEDGED', 'PROCESSED')
      OR EXISTS (
        SELECT 1 FROM authority_events delivered
        WHERE delivered.directive_id = NEW.directive_id
          AND delivered.event_type = 'DELIVERED'
          AND delivered.target_agent_id = NEW.target_agent_id
          AND delivered.actor_session_id = NEW.actor_session_id
          AND delivered.server_sequence < NEW.server_sequence
          AND json_extract(delivered.payload_json, '$.surfaceAttemptId') =
                json_extract(NEW.payload_json, '$.surfaceAttemptId')
          AND json_extract(delivered.payload_json, '$.recipientFence') =
                json_extract(NEW.payload_json, '$.recipientFence')
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

CREATE TRIGGER directive_execution_results_guard
BEFORE INSERT ON directive_execution_results
WHEN NOT EXISTS (
  SELECT 1 FROM authority_directives directive
  JOIN agent_sessions session ON session.id = NEW.session_id
  JOIN events event ON event.id = NEW.event_id
  JOIN authority_events result_event ON result_event.event_id = NEW.event_id
  WHERE directive.id = NEW.directive_id AND directive.project_id = NEW.project_id
    AND session.project_id = NEW.project_id AND session.agent_id = NEW.target_agent_id
    AND EXISTS (
      SELECT 1 FROM json_each(directive.target_agent_ids_json) audience
      WHERE audience.value = NEW.target_agent_id
    )
    AND EXISTS (
      SELECT 1 FROM authority_events processed
      WHERE processed.directive_id = NEW.directive_id
        AND processed.event_type = 'PROCESSED'
        AND processed.target_agent_id = NEW.target_agent_id
        AND processed.actor_session_id = NEW.session_id
    )
    AND event.project_id = NEW.project_id AND event.sequence = NEW.server_sequence
    AND event.type = 'directive.result_recorded'
    AND event.actor_type = 'agent' AND event.actor_id = NEW.target_agent_id
    AND event.aggregate_type = 'authority_directive'
    AND event.aggregate_id = NEW.directive_id
    AND result_event.project_id = NEW.project_id
    AND result_event.directive_id = NEW.directive_id
    AND result_event.event_type = 'RESULT_RECORDED'
    AND result_event.target_agent_id = NEW.target_agent_id
    AND result_event.actor_session_id = NEW.session_id
    AND result_event.server_sequence = NEW.server_sequence
    AND json_extract(result_event.payload_json, '$.targetAgentId') = NEW.target_agent_id
    AND json_extract(result_event.payload_json, '$.sessionId') = NEW.session_id
    AND json_extract(result_event.payload_json, '$.status') = NEW.status
    AND json_extract(result_event.payload_json, '$.summary') = NEW.summary
    AND json_type(result_event.payload_json, '$.evidence') = 'array'
    AND json(json_extract(result_event.payload_json, '$.evidence')) = json(NEW.evidence_json)
)
BEGIN SELECT RAISE(ABORT, 'directive execution result provenance is invalid'); END;
