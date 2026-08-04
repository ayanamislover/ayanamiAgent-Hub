-- Migration 0009 was exercised during development by databases whose legacy migration ledger did
-- not yet record content hashes. If that early draft was marked applied, the integrity upgrade can
-- only baseline the current file; it cannot prove that the final static-scope block ran. Repair the
-- finite known predecessor states in a new immutable migration instead of editing 0009 again.

CREATE TABLE migration_0010_static_credential_guard(value INTEGER NOT NULL);

CREATE TRIGGER migration_0010_static_credential_guard_reject
BEFORE INSERT ON migration_0010_static_credential_guard
WHEN NEW.value = 0
BEGIN
  SELECT RAISE(ABORT, 'unexpected static credential identity or scope before migration 0010');
END;

INSERT INTO migration_0010_static_credential_guard(value)
SELECT 0
WHERE EXISTS (
  WITH expected(
    id,
    principal_id,
    principal_kind,
    client_type,
    legacy_scopes,
    current_scopes
  ) AS (
    VALUES
      (
        'crd_local_agent',
        'prn_local_agent',
        'AGENT',
        NULL,
        '["hub:agent"]',
        '["project:select"]'
      ),
      (
        'crd_agent_codex',
        'prn_agent_codex',
        'AGENT',
        'codex',
        '["directive:relay","hub:agent"]',
        '["project:join","project:select","session-ticket:offer","session:enroll:first"]'
      ),
      (
        'crd_agent_claude',
        'prn_agent_claude',
        'AGENT',
        'claude',
        '["directive:relay","hub:agent"]',
        '["project:join","project:select","session-ticket:offer","session:enroll:first"]'
      ),
      (
        'crd_capture_codex',
        'prn_capture_codex',
        'BRIDGE_CAPTURE',
        'codex',
        '["user_turn:capture"]',
        '["session-ticket:offer:capture"]'
      ),
      (
        'crd_capture_claude',
        'prn_capture_claude',
        'BRIDGE_CAPTURE',
        'claude',
        '["user_turn:capture"]',
        '["session-ticket:offer:capture"]'
      ),
      (
        'crd_inject_codex',
        'prn_inject_codex',
        'BRIDGE_INJECTOR',
        'codex',
        '["synthetic_prompt:reserve"]',
        '["session-ticket:offer:injector"]'
      ),
      (
        'crd_inject_claude',
        'prn_inject_claude',
        'BRIDGE_INJECTOR',
        'claude',
        '["synthetic_prompt:reserve"]',
        '["session-ticket:offer:injector"]'
      )
  )
  SELECT 1
  FROM expected
  LEFT JOIN auth_credentials credential ON credential.id = expected.id
  LEFT JOIN auth_principals principal ON principal.id = expected.principal_id
  WHERE (
    credential.id IS NOT NULL
    AND (
      credential.principal_id <> expected.principal_id
      OR credential.expires_at IS NOT NULL
      OR credential.revoked_at IS NOT NULL
      OR credential.scopes_json NOT IN (expected.legacy_scopes, expected.current_scopes)
      OR principal.id IS NULL
    )
  ) OR (
    principal.id IS NOT NULL
    AND (
      principal.kind <> expected.principal_kind
      OR principal.client_type IS NOT expected.client_type
      OR principal.project_id IS NOT NULL
      OR principal.session_id IS NOT NULL
      OR principal.status <> 'ACTIVE'
    )
  )
);

DROP TRIGGER migration_0010_static_credential_guard_reject;
DROP TABLE migration_0010_static_credential_guard;

DROP TRIGGER auth_credentials_restricted_update;

UPDATE auth_credentials
SET scopes_json = CASE id
  WHEN 'crd_local_agent'
    THEN '["project:select"]'
  WHEN 'crd_agent_codex'
    THEN '["project:join","project:select","session-ticket:offer","session:enroll:first"]'
  WHEN 'crd_agent_claude'
    THEN '["project:join","project:select","session-ticket:offer","session:enroll:first"]'
  WHEN 'crd_capture_codex'
    THEN '["session-ticket:offer:capture"]'
  WHEN 'crd_capture_claude'
    THEN '["session-ticket:offer:capture"]'
  WHEN 'crd_inject_codex'
    THEN '["session-ticket:offer:injector"]'
  WHEN 'crd_inject_claude'
    THEN '["session-ticket:offer:injector"]'
  ELSE scopes_json
END
WHERE id IN (
  'crd_local_agent',
  'crd_agent_codex',
  'crd_agent_claude',
  'crd_capture_codex',
  'crd_capture_claude',
  'crd_inject_codex',
  'crd_inject_claude'
);

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
