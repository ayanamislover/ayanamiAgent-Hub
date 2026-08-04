-- Static credential incident rotation.  Raw credential material remains in owner-private files;
-- SQLite persists only SHA-256 digests and immutable provenance.

CREATE TABLE static_credential_security_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  security_epoch INTEGER NOT NULL CHECK(typeof(security_epoch) = 'integer' AND security_epoch >= 0),
  active_operation_id TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO static_credential_security_state(singleton, security_epoch, active_operation_id, updated_at)
VALUES (1, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE static_credential_rotation_operations (
  id TEXT PRIMARY KEY CHECK(id GLOB 'scr_[A-Za-z0-9_-]*'),
  incident_started_at TEXT NOT NULL CHECK(
    unixepoch(incident_started_at) IS NOT NULL
    AND incident_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', incident_started_at)
  ),
  cutover_at TEXT NOT NULL CHECK(
    unixepoch(cutover_at) IS NOT NULL
    AND cutover_at = strftime('%Y-%m-%dT%H:%M:%fZ', cutover_at)
  ),
  epoch_before INTEGER NOT NULL CHECK(typeof(epoch_before) = 'integer' AND epoch_before >= 0),
  epoch_after INTEGER NOT NULL CHECK(
    typeof(epoch_after) = 'integer' AND epoch_after = epoch_before + 1
  ),
  authorization_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  authorization_kind TEXT NOT NULL CHECK(authorization_kind IN ('DASHBOARD_USER_TURN', 'SYSTEM_RECOVERY')),
  authorization_source_kind TEXT NOT NULL CHECK(
    authorization_source_kind IN ('USER_TURN', 'DASHBOARD_EVENT', 'EXTERNAL_RECEIPT')
  ),
  authorized_by_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  authorization_source_id TEXT NOT NULL,
  stop_receipt_sha256 TEXT NOT NULL CHECK(
    length(stop_receipt_sha256) = 64 AND stop_receipt_sha256 = lower(stop_receipt_sha256)
    AND stop_receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64 AND request_sha256 = lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK(unixepoch(cutover_at) >= unixepoch(incident_started_at))
);

CREATE TABLE static_credential_rotation_members (
  operation_id TEXT NOT NULL REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  slot TEXT NOT NULL CHECK(slot IN (
    'token', 'agent-codex', 'agent-claude', 'dashboard',
    'capture-codex', 'capture-claude', 'inject-codex', 'inject-claude'
  )),
  credential_id TEXT NOT NULL CHECK(credential_id IN (
    'crd_local_agent', 'crd_agent_codex', 'crd_agent_claude', 'crd_local_dashboard',
    'crd_capture_codex', 'crd_capture_claude', 'crd_inject_codex', 'crd_inject_claude'
  )),
  principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation > 0),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_sha256) = 64 AND token_sha256 = lower(token_sha256)
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  staged_file_sha256 TEXT NOT NULL CHECK(
    length(staged_file_sha256) = 64 AND staged_file_sha256 = lower(staged_file_sha256)
    AND staged_file_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, slot)
);

CREATE TABLE static_credential_generations (
  id TEXT PRIMARY KEY CHECK(id GLOB 'scg_[A-Za-z0-9_-]*'),
  slot TEXT NOT NULL CHECK(slot IN (
    'token', 'agent-codex', 'agent-claude', 'dashboard',
    'capture-codex', 'capture-claude', 'inject-codex', 'inject-claude'
  )),
  credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer' AND generation >= 0),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_sha256) = 64 AND token_sha256 = lower(token_sha256)
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  operation_id TEXT REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('PREPARED', 'ACTIVE', 'REVOKED', 'ABORTED')),
  activated_at TEXT,
  revoked_at TEXT,
  aborted_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(
    (state = 'PREPARED' AND activated_at IS NULL AND revoked_at IS NULL AND aborted_at IS NULL)
    OR (state = 'ACTIVE' AND activated_at IS NOT NULL AND revoked_at IS NULL AND aborted_at IS NULL)
    OR (state = 'REVOKED' AND activated_at IS NOT NULL
      AND revoked_at IS NOT NULL AND aborted_at IS NULL)
    OR (state = 'ABORTED' AND activated_at IS NULL AND revoked_at IS NULL AND aborted_at IS NOT NULL)
  )
);

CREATE TABLE static_credential_slots (
  slot TEXT PRIMARY KEY CHECK(slot IN (
    'token', 'agent-codex', 'agent-claude', 'dashboard',
    'capture-codex', 'capture-claude', 'inject-codex', 'inject-claude'
  )),
  credential_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  active_generation_id TEXT REFERENCES static_credential_generations(id) ON DELETE RESTRICT,
  active_generation INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(active_generation) = 'integer' AND active_generation >= 0
  ),
  security_epoch INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(security_epoch) = 'integer' AND security_epoch >= 0
  ),
  updated_at TEXT NOT NULL
);

INSERT INTO static_credential_slots(slot, credential_id, principal_id, updated_at) VALUES
  ('token', 'crd_local_agent', 'prn_local_agent', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('agent-codex', 'crd_agent_codex', 'prn_agent_codex', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('agent-claude', 'crd_agent_claude', 'prn_agent_claude', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dashboard', 'crd_local_dashboard', 'prn_local_dashboard', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('capture-codex', 'crd_capture_codex', 'prn_capture_codex', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('capture-claude', 'crd_capture_claude', 'prn_capture_claude', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('inject-codex', 'crd_inject_codex', 'prn_inject_codex', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('inject-claude', 'crd_inject_claude', 'prn_inject_claude', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Existing databases already have all eight legacy rows.  Fresh databases have none until the
-- post-migration bootstrap initializes their owner-private files and generation zero atomically.
CREATE TABLE migration_0013_static_credential_guard(valid INTEGER NOT NULL);
CREATE TRIGGER migration_0013_static_credential_guard_reject
BEFORE INSERT ON migration_0013_static_credential_guard WHEN NEW.valid = 0
BEGIN SELECT RAISE(ABORT, 'static credential generation bootstrap is partial or invalid'); END;

INSERT INTO migration_0013_static_credential_guard(valid)
SELECT 0 WHERE (SELECT COUNT(*) FROM auth_credentials) NOT IN (0, 8);

INSERT INTO migration_0013_static_credential_guard(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM static_credential_slots slot
  LEFT JOIN auth_credentials credential ON credential.id = slot.credential_id
  WHERE (SELECT COUNT(*) FROM auth_credentials) = 8
    AND (credential.id IS NULL OR credential.principal_id <> slot.principal_id
      OR credential.revoked_at IS NOT NULL)
);

INSERT INTO static_credential_generations(
  id, slot, credential_id, principal_id, generation, token_sha256, scopes_json,
  operation_id, state, activated_at, revoked_at, created_at
)
SELECT 'scg_' || replace(slot.slot, '-', '_') || '_0', slot.slot, slot.credential_id,
       slot.principal_id, 0, credential.token_sha256, credential.scopes_json,
       NULL, 'ACTIVE', credential.created_at, NULL, credential.created_at
FROM static_credential_slots slot
JOIN auth_credentials credential ON credential.id = slot.credential_id;

UPDATE static_credential_slots
SET active_generation_id = 'scg_' || replace(slot, '-', '_') || '_0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM auth_credentials credential WHERE credential.id = credential_id);

INSERT INTO migration_0013_static_credential_guard(valid)
SELECT 0 WHERE EXISTS (
  SELECT 1 FROM static_credential_generations generation
  JOIN adapter_session_tickets ticket ON ticket.token_sha256 = generation.token_sha256
);

DROP TRIGGER migration_0013_static_credential_guard_reject;
DROP TABLE migration_0013_static_credential_guard;

CREATE TABLE static_credential_rotation_events (
  operation_id TEXT NOT NULL REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence > 0),
  phase TEXT NOT NULL CHECK(phase IN (
    'AUTHORIZED', 'PREPARED', 'STAGED', 'SWITCHING', 'FILES_INSTALLED',
    'DB_COMMITTED', 'CLEANUP_PENDING', 'COMPLETED', 'ABORTED'
  )),
  event_sha256 TEXT NOT NULL CHECK(
    length(event_sha256) = 64 AND event_sha256 = lower(event_sha256)
    AND event_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, sequence)
);

CREATE TABLE static_credential_incident_ticket_receipts (
  operation_id TEXT NOT NULL REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  bundle_id TEXT NOT NULL,
  prior_state TEXT NOT NULL CHECK(prior_state IN ('PENDING', 'ACTIVE')),
  ticket_count INTEGER NOT NULL CHECK(typeof(ticket_count) = 'integer' AND ticket_count > 0),
  ticket_ids_sha256 TEXT NOT NULL CHECK(
    length(ticket_ids_sha256) = 64 AND ticket_ids_sha256 = lower(ticket_ids_sha256)
    AND ticket_ids_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  terminal_at TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL CHECK(
    length(receipt_sha256) = 64 AND receipt_sha256 = lower(receipt_sha256)
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(operation_id, bundle_id)
);

CREATE TABLE static_credential_incident_dependency_receipts (
  operation_id TEXT NOT NULL REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  dependency_kind TEXT NOT NULL CHECK(dependency_kind IN (
    'CAPTURE_BINDING', 'SYNTHETIC_PROMPT', 'LAUNCH_RESERVATION'
  )),
  dependency_id TEXT NOT NULL,
  prior_state TEXT NOT NULL,
  terminal_state TEXT NOT NULL,
  terminal_at TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL CHECK(
    length(receipt_sha256) = 64 AND receipt_sha256 = lower(receipt_sha256)
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(operation_id, dependency_kind, dependency_id),
  CHECK(
    (dependency_kind = 'CAPTURE_BINDING'
      AND prior_state = 'ACTIVE' AND terminal_state = 'REVOKED')
    OR (dependency_kind = 'SYNTHETIC_PROMPT'
      AND prior_state = 'PREPARED' AND terminal_state = 'ABORTED')
    OR (dependency_kind = 'LAUNCH_RESERVATION'
      AND prior_state = 'ISSUED' AND terminal_state = 'SUPERSEDED')
  )
);

CREATE TABLE static_credential_external_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  security_epoch INTEGER NOT NULL CHECK(typeof(security_epoch) = 'integer' AND security_epoch > 0),
  receipt_sha256 TEXT NOT NULL CHECK(
    length(receipt_sha256) = 64 AND receipt_sha256 = lower(receipt_sha256)
    AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at TEXT NOT NULL
);

CREATE TABLE static_credential_incident_head_proofs (
  operation_id TEXT NOT NULL REFERENCES static_credential_rotation_operations(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  adapter_client TEXT NOT NULL CHECK(adapter_client IN ('codex', 'claude')),
  lineage_id TEXT NOT NULL REFERENCES session_lineages(id) ON DELETE RESTRICT,
  head_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  predecessor_bundle_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL CHECK(
    typeof(credential_generation) = 'integer' AND credential_generation > 0
  ),
  consumed_at TEXT NOT NULL,
  proof_sha256 TEXT NOT NULL CHECK(
    length(proof_sha256) = 64 AND proof_sha256 = lower(proof_sha256)
    AND proof_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY(operation_id, project_id, adapter_client, lineage_id, credential_generation),
  UNIQUE(operation_id, predecessor_bundle_id)
);

CREATE TRIGGER static_credential_security_epoch_monotonic
BEFORE UPDATE ON static_credential_security_state
WHEN NEW.singleton <> OLD.singleton
  OR NEW.security_epoch < OLD.security_epoch
  OR (NEW.security_epoch > OLD.security_epoch + 1)
BEGIN SELECT RAISE(ABORT, 'static credential security epoch must advance monotonically'); END;

CREATE TRIGGER static_credential_generation_ticket_digest_guard
BEFORE INSERT ON static_credential_generations
WHEN EXISTS (
  SELECT 1 FROM adapter_session_tickets ticket WHERE ticket.token_sha256 = NEW.token_sha256
)
BEGIN SELECT RAISE(ABORT, 'static credential digest collides with a session ticket'); END;

CREATE TRIGGER adapter_session_ticket_generation_digest_guard
BEFORE INSERT ON adapter_session_tickets
WHEN EXISTS (
  SELECT 1 FROM static_credential_generations generation
  WHERE generation.token_sha256 = NEW.token_sha256
)
BEGIN SELECT RAISE(ABORT, 'session ticket digest collides with a static credential generation'); END;

CREATE TRIGGER static_credential_rotation_operations_immutable_update
BEFORE UPDATE ON static_credential_rotation_operations
BEGIN SELECT RAISE(ABORT, 'static credential rotation operations are append-only'); END;
CREATE TRIGGER static_credential_rotation_operations_immutable_delete
BEFORE DELETE ON static_credential_rotation_operations
BEGIN SELECT RAISE(ABORT, 'static credential rotation operations are append-only'); END;
CREATE TRIGGER static_credential_rotation_members_immutable_update
BEFORE UPDATE ON static_credential_rotation_members
BEGIN SELECT RAISE(ABORT, 'static credential rotation members are append-only'); END;
CREATE TRIGGER static_credential_rotation_members_immutable_delete
BEFORE DELETE ON static_credential_rotation_members
BEGIN SELECT RAISE(ABORT, 'static credential rotation members are append-only'); END;
CREATE TRIGGER static_credential_rotation_events_immutable_update
BEFORE UPDATE ON static_credential_rotation_events
BEGIN SELECT RAISE(ABORT, 'static credential rotation events are append-only'); END;
CREATE TRIGGER static_credential_rotation_events_immutable_delete
BEFORE DELETE ON static_credential_rotation_events
BEGIN SELECT RAISE(ABORT, 'static credential rotation events are append-only'); END;
CREATE TRIGGER static_credential_incident_ticket_receipts_immutable_update
BEFORE UPDATE ON static_credential_incident_ticket_receipts
BEGIN SELECT RAISE(ABORT, 'static credential ticket receipts are append-only'); END;
CREATE TRIGGER static_credential_incident_ticket_receipts_immutable_delete
BEFORE DELETE ON static_credential_incident_ticket_receipts
BEGIN SELECT RAISE(ABORT, 'static credential ticket receipts are append-only'); END;
CREATE TRIGGER static_credential_incident_dependency_receipts_immutable_update
BEFORE UPDATE ON static_credential_incident_dependency_receipts
BEGIN SELECT RAISE(ABORT, 'static credential dependency receipts are append-only'); END;
CREATE TRIGGER static_credential_incident_dependency_receipts_immutable_delete
BEFORE DELETE ON static_credential_incident_dependency_receipts
BEGIN SELECT RAISE(ABORT, 'static credential dependency receipts are append-only'); END;
CREATE TRIGGER static_credential_external_receipts_immutable_update
BEFORE UPDATE ON static_credential_external_receipts
BEGIN SELECT RAISE(ABORT, 'static credential external receipts are append-only'); END;
CREATE TRIGGER static_credential_external_receipts_immutable_delete
BEFORE DELETE ON static_credential_external_receipts
BEGIN SELECT RAISE(ABORT, 'static credential external receipts are append-only'); END;
CREATE TRIGGER static_credential_incident_head_proofs_immutable_update
BEFORE UPDATE ON static_credential_incident_head_proofs
BEGIN SELECT RAISE(ABORT, 'static credential incident head proofs are append-only'); END;
CREATE TRIGGER static_credential_incident_head_proofs_immutable_delete
BEFORE DELETE ON static_credential_incident_head_proofs
BEGIN SELECT RAISE(ABORT, 'static credential incident head proofs are append-only'); END;

CREATE TRIGGER static_credential_generations_restricted_update
BEFORE UPDATE ON static_credential_generations
WHEN NOT (
  OLD.id = NEW.id AND OLD.slot = NEW.slot AND OLD.credential_id = NEW.credential_id
  AND OLD.principal_id = NEW.principal_id AND OLD.generation = NEW.generation
  AND OLD.token_sha256 = NEW.token_sha256 AND OLD.scopes_json = NEW.scopes_json
  AND OLD.operation_id IS NEW.operation_id AND OLD.created_at = NEW.created_at
  AND (
    (OLD.state = 'PREPARED' AND NEW.state = 'ACTIVE'
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL
      AND OLD.aborted_at IS NULL AND NEW.aborted_at IS NULL)
    OR (OLD.state = 'PREPARED' AND NEW.state = 'ABORTED'
      AND OLD.activated_at IS NULL AND NEW.activated_at IS NULL
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL
      AND OLD.aborted_at IS NULL AND NEW.aborted_at IS NOT NULL)
    OR (OLD.state = 'ACTIVE' AND NEW.state = 'REVOKED'
      AND OLD.activated_at IS NEW.activated_at
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      AND OLD.aborted_at IS NULL AND NEW.aborted_at IS NULL)
  )
)
BEGIN SELECT RAISE(ABORT, 'static credential generations permit only activation, revocation, or abort'); END;

CREATE TRIGGER static_credential_generations_immutable_delete
BEFORE DELETE ON static_credential_generations
BEGIN SELECT RAISE(ABORT, 'static credential generations cannot be deleted'); END;

CREATE TRIGGER static_credential_slots_restricted_update
BEFORE UPDATE ON static_credential_slots
WHEN NOT (
  OLD.slot = NEW.slot AND OLD.credential_id = NEW.credential_id
  AND OLD.principal_id = NEW.principal_id
  AND (
    (OLD.active_generation_id IS NULL AND OLD.active_generation = 0
      AND OLD.security_epoch = 0 AND NEW.active_generation = 0
      AND NEW.security_epoch = 0 AND NEW.active_generation_id IS NOT NULL)
    OR
    (NEW.active_generation = OLD.active_generation + 1
      AND NEW.security_epoch = OLD.security_epoch + 1
      AND NEW.active_generation_id IS NOT OLD.active_generation_id)
  )
  AND EXISTS (
    SELECT 1 FROM static_credential_generations generation
    WHERE generation.id = NEW.active_generation_id AND generation.slot = NEW.slot
      AND generation.credential_id = NEW.credential_id
      AND generation.principal_id = NEW.principal_id
      AND generation.generation = NEW.active_generation
      AND generation.state = 'ACTIVE'
  )
)
BEGIN SELECT RAISE(ABORT, 'static credential slot update is not an exact next generation'); END;

CREATE TRIGGER static_credential_slots_immutable_delete
BEFORE DELETE ON static_credential_slots
BEGIN SELECT RAISE(ABORT, 'static credential slots cannot be deleted'); END;
