-- User Directive Authority trust root. Every object is deliberately created without IF NOT
-- EXISTS: a pre-created or partial object must abort version 7 instead of being mistaken for the
-- reviewed schema by the migration ledger.
CREATE TABLE auth_principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN (
    'AGENT', 'BRIDGE_CAPTURE', 'BRIDGE_INJECTOR', 'DASHBOARD_USER', 'SYSTEM'
  )),
  display_name TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  client_type TEXT CHECK(client_type IS NULL OR client_type IN ('codex', 'claude')),
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO auth_principals(
  id, kind, display_name, project_id, client_type, session_id, status, created_at, updated_at
) VALUES
  ('prn_local_agent', 'AGENT', 'Local Agent', NULL, NULL, NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('prn_local_dashboard', 'DASHBOARD_USER', 'Ayanamislover', NULL, NULL, NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('prn_capture_codex', 'BRIDGE_CAPTURE', 'Codex UserPromptSubmit Capture', NULL, 'codex', NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('prn_capture_claude', 'BRIDGE_CAPTURE', 'Claude UserPromptSubmit Capture', NULL, 'claude', NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('prn_inject_codex', 'BRIDGE_INJECTOR', 'Codex Synthetic Prompt Injector', NULL, 'codex', NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('prn_inject_claude', 'BRIDGE_INJECTOR', 'Claude Synthetic Prompt Injector', NULL, 'claude', NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE auth_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  token_sha256 TEXT NOT NULL UNIQUE CHECK(
    length(token_sha256) = 64
    AND token_sha256 = lower(token_sha256)
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_auth_credentials_principal
  ON auth_credentials(principal_id, revoked_at, expires_at);

-- A capture token is client-scoped. This immutable binding is the project/session capability:
-- it is created only for a real Hook session and capture resolves it server-side from the official
-- external session id. cwd is evidence only and never chooses a project.
CREATE TABLE capture_session_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE RESTRICT,
  client_type TEXT NOT NULL CHECK(client_type IN ('codex', 'claude')),
  source_session_id TEXT NOT NULL,
  hub_session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(credential_id, project_id, client_type, source_session_id, hub_session_id)
);

CREATE INDEX idx_capture_session_bindings_lookup
  ON capture_session_bindings(
    credential_id, project_id, client_type, source_session_id, revoked_at
  );

CREATE TRIGGER capture_session_bindings_authority_guard
BEFORE INSERT ON capture_session_bindings
WHEN NOT EXISTS (
  SELECT 1
  FROM auth_principals principal
  JOIN auth_credentials credential ON credential.principal_id = principal.id
  JOIN agent_sessions session ON session.id = NEW.hub_session_id
  WHERE principal.id = NEW.principal_id
    AND principal.kind = 'BRIDGE_CAPTURE' AND principal.status = 'ACTIVE'
    AND principal.client_type = NEW.client_type
    AND credential.id = NEW.credential_id AND credential.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM json_each(credential.scopes_json) WHERE value = 'user_turn:capture')
    AND (credential.expires_at IS NULL OR julianday(credential.expires_at) > julianday('now'))
    AND session.project_id = NEW.project_id AND session.agent_id = NEW.client_type
    AND session.client = CASE NEW.client_type
      WHEN 'codex' THEN 'codex-cli-hooks'
      WHEN 'claude' THEN 'claude-hooks'
    END
    AND session.connection_state <> 'CLOSED'
    AND session.external_session_id = NEW.source_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'capture session binding is not authorized for source');
END;

CREATE TABLE synthetic_prompt_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE RESTRICT,
  capture_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  capture_binding_id TEXT NOT NULL REFERENCES capture_session_bindings(id) ON DELETE RESTRICT,
  client_type TEXT NOT NULL CHECK(client_type IN ('codex', 'claude')),
  external_session_id TEXT NOT NULL,
  injector_hub_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  surface_attempt_id TEXT NOT NULL REFERENCES message_surface_attempts(id) ON DELETE RESTRICT,
  recipient_fence INTEGER NOT NULL CHECK(
    typeof(recipient_fence) = 'integer' AND recipient_fence > 0
  ),
  rpc_method TEXT NOT NULL CHECK(rpc_method IN ('turn/start', 'turn/steer', 'thread/inject_items')),
  origin_nonce TEXT NOT NULL UNIQUE CHECK(
    length(origin_nonce) BETWEEN 32 AND 128
    AND origin_nonce NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  raw_text TEXT NOT NULL,
  raw_text_sha256 TEXT NOT NULL CHECK(
    length(raw_text_sha256) = 64
    AND raw_text_sha256 = lower(raw_text_sha256)
    AND raw_text_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED', 'CONSUMED', 'ABORTED')),
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  aborted_at TEXT,
  abort_reason TEXT,
  abort_idempotency_key TEXT,
  abort_request_sha256 TEXT CHECK(
    abort_request_sha256 IS NULL OR (
      length(abort_request_sha256) = 64
      AND abort_request_sha256 = lower(abort_request_sha256)
      AND abort_request_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64
    AND request_sha256 = lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(credential_id, idempotency_key),
  UNIQUE(credential_id, abort_idempotency_key),
  UNIQUE(surface_attempt_id, rpc_method),
  CHECK(
    (state = 'PREPARED' AND consumed_at IS NULL AND aborted_at IS NULL
      AND abort_reason IS NULL AND abort_idempotency_key IS NULL
      AND abort_request_sha256 IS NULL)
    OR (state = 'CONSUMED' AND consumed_at IS NOT NULL AND aborted_at IS NULL
      AND abort_reason IS NULL AND abort_idempotency_key IS NULL
      AND abort_request_sha256 IS NULL)
    OR (state = 'ABORTED' AND consumed_at IS NULL AND aborted_at IS NOT NULL
      AND abort_reason IS NOT NULL AND abort_idempotency_key IS NOT NULL
      AND abort_request_sha256 IS NOT NULL)
  ),
  CHECK(julianday(expires_at) > julianday(prepared_at))
);

CREATE INDEX idx_synthetic_prompt_match
  ON synthetic_prompt_reservations(
    capture_binding_id, capture_principal_id, project_id, client_type, external_session_id,
    origin_nonce, raw_text_sha256, state
  );

CREATE TABLE user_turns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  source_credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE RESTRICT,
  source_binding_id TEXT NOT NULL REFERENCES capture_session_bindings(id) ON DELETE RESTRICT,
  source_hub_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  client_type TEXT NOT NULL CHECK(client_type IN ('codex', 'claude')),
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT,
  cwd TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  raw_text_sha256 TEXT NOT NULL CHECK(
    length(raw_text_sha256) = 64
    AND raw_text_sha256 = lower(raw_text_sha256)
    AND raw_text_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64
    AND request_sha256 = lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  correlation_id TEXT,
  UNIQUE(source_credential_id, idempotency_key)
);

CREATE INDEX idx_user_turns_project_received ON user_turns(project_id, received_at, id);
CREATE INDEX idx_user_turns_source
  ON user_turns(project_id, client_type, source_session_id, source_turn_id);
CREATE UNIQUE INDEX idx_user_turns_exact_source_turn
  ON user_turns(project_id, client_type, source_session_id, source_turn_id)
  WHERE source_turn_id IS NOT NULL;

CREATE TABLE user_turn_capture_receipts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES auth_principals(id) ON DELETE RESTRICT,
  credential_id TEXT NOT NULL REFERENCES auth_credentials(id) ON DELETE RESTRICT,
  binding_id TEXT NOT NULL REFERENCES capture_session_bindings(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64
    AND request_sha256 = lower(request_sha256)
    AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK(status IN ('CAPTURED', 'EXCLUDED')),
  user_turn_id TEXT REFERENCES user_turns(id) ON DELETE RESTRICT,
  synthetic_reservation_id TEXT REFERENCES synthetic_prompt_reservations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(credential_id, idempotency_key),
  CHECK(
    (status = 'CAPTURED' AND user_turn_id IS NOT NULL AND synthetic_reservation_id IS NULL)
    OR (status = 'EXCLUDED' AND user_turn_id IS NULL AND synthetic_reservation_id IS NOT NULL)
  )
);

CREATE TRIGGER auth_principals_closed_set_insert
BEFORE INSERT ON auth_principals
WHEN NEW.id NOT IN (
  'prn_local_agent', 'prn_local_dashboard', 'prn_capture_codex', 'prn_capture_claude',
  'prn_inject_codex', 'prn_inject_claude'
)
BEGIN
  SELECT RAISE(ABORT, 'auth principal set is closed');
END;

CREATE TRIGGER auth_principals_restricted_update
BEFORE UPDATE ON auth_principals
WHEN NOT (
  OLD.kind = NEW.kind AND OLD.display_name = NEW.display_name
  AND OLD.project_id IS NEW.project_id AND OLD.client_type IS NEW.client_type
  AND OLD.session_id IS NEW.session_id AND OLD.created_at = NEW.created_at
  AND OLD.status = 'ACTIVE' AND NEW.status = 'REVOKED'
)
BEGIN
  SELECT RAISE(ABORT, 'auth principals are immutable except for revocation');
END;

CREATE TRIGGER auth_principals_immutable_delete BEFORE DELETE ON auth_principals
BEGIN SELECT RAISE(ABORT, 'auth principals cannot be deleted'); END;

CREATE TRIGGER auth_credentials_closed_set_insert
BEFORE INSERT ON auth_credentials
WHEN NEW.id NOT IN (
  'crd_local_agent', 'crd_local_dashboard', 'crd_capture_codex', 'crd_capture_claude',
  'crd_inject_codex', 'crd_inject_claude'
)
BEGIN
  SELECT RAISE(ABORT, 'auth credential set is closed');
END;

CREATE TRIGGER auth_credentials_restricted_update
BEFORE UPDATE ON auth_credentials
WHEN NOT (
  OLD.principal_id = NEW.principal_id AND OLD.token_sha256 = NEW.token_sha256
  AND OLD.scopes_json = NEW.scopes_json AND OLD.expires_at IS NEW.expires_at
  AND OLD.created_at = NEW.created_at AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'auth credentials are immutable except for revocation');
END;

CREATE TRIGGER auth_credentials_immutable_delete BEFORE DELETE ON auth_credentials
BEGIN SELECT RAISE(ABORT, 'auth credentials cannot be deleted'); END;

CREATE TRIGGER capture_session_bindings_restricted_update
BEFORE UPDATE ON capture_session_bindings
WHEN NOT (
  OLD.project_id = NEW.project_id AND OLD.principal_id = NEW.principal_id
  AND OLD.credential_id = NEW.credential_id AND OLD.client_type = NEW.client_type
  AND OLD.source_session_id = NEW.source_session_id
  AND OLD.hub_session_id = NEW.hub_session_id AND OLD.created_at = NEW.created_at
  AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'capture bindings are immutable except for revocation');
END;

CREATE TRIGGER capture_session_bindings_immutable_delete BEFORE DELETE ON capture_session_bindings
BEGIN SELECT RAISE(ABORT, 'capture bindings cannot be deleted'); END;

CREATE TRIGGER synthetic_prompt_reservations_authority_guard
BEFORE INSERT ON synthetic_prompt_reservations
WHEN NOT EXISTS (
  SELECT 1
  FROM auth_principals injector
  JOIN auth_credentials credential ON credential.principal_id = injector.id
  JOIN agent_sessions session ON session.id = NEW.injector_hub_session_id
  JOIN messages message ON message.id = NEW.source_message_id
  JOIN message_surface_attempts surface ON surface.id = NEW.surface_attempt_id
  JOIN message_recipients recipient ON recipient.id = surface.recipient_id
  JOIN auth_principals capture ON capture.id = NEW.capture_principal_id
  JOIN capture_session_bindings binding ON binding.id = NEW.capture_binding_id
  JOIN auth_credentials capture_credential ON capture_credential.id = binding.credential_id
  JOIN agent_sessions capture_session ON capture_session.id = binding.hub_session_id
  WHERE injector.id = NEW.principal_id
    AND injector.kind = 'BRIDGE_INJECTOR' AND injector.status = 'ACTIVE'
    AND injector.client_type = NEW.client_type
    AND credential.id = NEW.credential_id AND credential.revoked_at IS NULL
    AND (credential.expires_at IS NULL OR julianday(credential.expires_at) > julianday('now'))
    AND session.project_id = NEW.project_id AND session.agent_id = NEW.client_type
    AND session.client = NEW.client_type || '-app-server'
    AND session.connection_state <> 'CLOSED'
    AND session.external_session_id = NEW.external_session_id
    AND message.project_id = NEW.project_id
    AND surface.message_id = NEW.source_message_id
    AND surface.session_id = NEW.injector_hub_session_id
    AND surface.recipient_fence = NEW.recipient_fence AND surface.state = 'ACTIVE'
    AND recipient.message_id = NEW.source_message_id
    AND recipient.recipient_agent_id = NEW.client_type
    AND capture.kind = 'BRIDGE_CAPTURE' AND capture.status = 'ACTIVE'
    AND capture.client_type = NEW.client_type
    AND binding.project_id = NEW.project_id
    AND binding.principal_id = NEW.capture_principal_id
    AND binding.client_type = NEW.client_type
    AND binding.source_session_id = NEW.external_session_id
    AND binding.revoked_at IS NULL
    AND capture_credential.principal_id = capture.id
    AND capture_credential.revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM json_each(capture_credential.scopes_json)
      WHERE value = 'user_turn:capture'
    )
    AND (capture_credential.expires_at IS NULL
      OR julianday(capture_credential.expires_at) > julianday('now'))
    AND capture_session.project_id = NEW.project_id
    AND capture_session.agent_id = NEW.client_type
    AND capture_session.client = CASE NEW.client_type
      WHEN 'codex' THEN 'codex-cli-hooks'
      WHEN 'claude' THEN 'claude-hooks'
    END
    AND capture_session.connection_state <> 'CLOSED'
    AND capture_session.external_session_id = NEW.external_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'synthetic prompt reservation is not authorized for surface');
END;

CREATE TRIGGER synthetic_prompt_reservations_restricted_update
BEFORE UPDATE ON synthetic_prompt_reservations
WHEN NOT (
  OLD.project_id = NEW.project_id AND OLD.principal_id = NEW.principal_id
  AND OLD.credential_id = NEW.credential_id
  AND OLD.capture_principal_id = NEW.capture_principal_id
  AND OLD.capture_binding_id = NEW.capture_binding_id
  AND OLD.client_type = NEW.client_type
  AND OLD.external_session_id = NEW.external_session_id
  AND OLD.injector_hub_session_id = NEW.injector_hub_session_id
  AND OLD.source_message_id = NEW.source_message_id
  AND OLD.surface_attempt_id = NEW.surface_attempt_id
  AND OLD.recipient_fence = NEW.recipient_fence AND OLD.rpc_method = NEW.rpc_method
  AND OLD.origin_nonce = NEW.origin_nonce AND OLD.raw_text = NEW.raw_text
  AND OLD.raw_text_sha256 = NEW.raw_text_sha256
  AND OLD.prepared_at = NEW.prepared_at AND OLD.expires_at = NEW.expires_at
  AND OLD.idempotency_key = NEW.idempotency_key AND OLD.request_sha256 = NEW.request_sha256
  AND OLD.correlation_id IS NEW.correlation_id AND OLD.created_at = NEW.created_at
  AND (
    (OLD.state = 'PREPARED' AND NEW.state = 'CONSUMED'
      AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
      AND OLD.aborted_at IS NULL AND NEW.aborted_at IS NULL)
    OR
    (OLD.state = 'PREPARED' AND NEW.state = 'ABORTED'
      AND OLD.aborted_at IS NULL AND NEW.aborted_at IS NOT NULL
      AND OLD.consumed_at IS NULL AND NEW.consumed_at IS NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'synthetic prompt reservations only permit one terminal transition');
END;

CREATE TRIGGER synthetic_prompt_reservations_immutable_delete
BEFORE DELETE ON synthetic_prompt_reservations
BEGIN SELECT RAISE(ABORT, 'synthetic prompt reservations cannot be deleted'); END;

CREATE TRIGGER user_turns_capture_binding_guard
BEFORE INSERT ON user_turns
WHEN NOT EXISTS (
  SELECT 1
  FROM capture_session_bindings b
  JOIN auth_principals p ON p.id = b.principal_id
  JOIN auth_credentials c ON c.id = b.credential_id
  JOIN agent_sessions s ON s.id = b.hub_session_id
  WHERE b.id = NEW.source_binding_id
    AND b.project_id = NEW.project_id
    AND b.principal_id = NEW.source_principal_id
    AND b.credential_id = NEW.source_credential_id
    AND b.client_type = NEW.client_type
    AND b.source_session_id = NEW.source_session_id
    AND b.hub_session_id = NEW.source_hub_session_id
    AND b.revoked_at IS NULL
    AND p.kind = 'BRIDGE_CAPTURE' AND p.status = 'ACTIVE'
    AND p.client_type = b.client_type
    AND c.principal_id = p.id
    AND EXISTS (SELECT 1 FROM json_each(c.scopes_json) WHERE value = 'user_turn:capture')
    AND c.revoked_at IS NULL
    AND (c.expires_at IS NULL OR julianday(c.expires_at) > julianday('now'))
    AND s.project_id = NEW.project_id AND s.agent_id = NEW.client_type
    AND s.client = CASE NEW.client_type
      WHEN 'codex' THEN 'codex-cli-hooks'
      WHEN 'claude' THEN 'claude-hooks'
    END
    AND s.external_session_id = NEW.source_session_id
    AND s.connection_state <> 'CLOSED'
)
BEGIN
  SELECT RAISE(ABORT, 'user_turn capture binding is not authorized for source');
END;

CREATE TRIGGER user_turns_immutable_update BEFORE UPDATE ON user_turns
BEGIN SELECT RAISE(ABORT, 'user_turns are immutable'); END;
CREATE TRIGGER user_turns_immutable_delete BEFORE DELETE ON user_turns
BEGIN SELECT RAISE(ABORT, 'user_turns are immutable'); END;
CREATE TRIGGER user_turn_capture_receipts_authority_guard
BEFORE INSERT ON user_turn_capture_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM capture_session_bindings binding
  WHERE binding.id = NEW.binding_id
    AND binding.principal_id = NEW.principal_id
    AND binding.credential_id = NEW.credential_id
    AND binding.revoked_at IS NULL
    AND (
      (NEW.status = 'CAPTURED' AND EXISTS (
        SELECT 1 FROM user_turns turn
        WHERE turn.id = NEW.user_turn_id
          AND turn.source_principal_id = NEW.principal_id
          AND turn.source_credential_id = NEW.credential_id
          AND turn.source_binding_id = NEW.binding_id
      ))
      OR
      (NEW.status = 'EXCLUDED' AND EXISTS (
        SELECT 1 FROM synthetic_prompt_reservations reservation
        WHERE reservation.id = NEW.synthetic_reservation_id
          AND reservation.capture_principal_id = NEW.principal_id
          AND reservation.capture_binding_id = NEW.binding_id
          AND reservation.project_id = binding.project_id
          AND reservation.client_type = binding.client_type
          AND reservation.external_session_id = binding.source_session_id
          AND reservation.state = 'CONSUMED'
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'user-turn receipt provenance is not authorized');
END;
CREATE TRIGGER user_turn_capture_receipts_immutable_update
BEFORE UPDATE ON user_turn_capture_receipts
BEGIN SELECT RAISE(ABORT, 'user_turn capture receipts are immutable'); END;
CREATE TRIGGER user_turn_capture_receipts_immutable_delete
BEFORE DELETE ON user_turn_capture_receipts
BEGIN SELECT RAISE(ABORT, 'user_turn capture receipts are immutable'); END;

CREATE TRIGGER authority_events_immutable_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'authority event log is append-only'); END;
CREATE TRIGGER authority_events_immutable_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'authority event log is append-only'); END;
