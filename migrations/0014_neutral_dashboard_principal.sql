-- Migration 0007 seeded six principals with functional display names -- 'Local Agent',
-- 'Codex UserPromptSubmit Capture', and so on -- except the Dashboard user, which received the
-- original author's personal handle. That name is the one identity string a user ever sees, and it
-- is wrong for anyone else's installation.
--
-- It cannot be fixed by editing 0007: schema_migrations records a content_sha256 per applied
-- migration, so rewriting applied history makes an existing database fail its integrity check on
-- the next boot. It cannot be fixed in code alone either, because registerCredential re-reads the
-- stored principal and refuses to start when the stored name differs from the constant it holds.
--
-- So it is corrected forward, here. 0007 also installed auth_principals_restricted_update, which
-- permits no update other than ACTIVE -> REVOKED; that guard exists to stop the running Hub from
-- editing identities, not to stop authorised schema evolution, so it is dropped for this statement
-- and restored verbatim below. Anything that fails in between aborts the whole migration.
--
-- The events log is deliberately left alone. A first draft of this migration also rewrote
-- events.actor_id, on the theory that authority provenance compares an event's actor_id against
-- its principal's current display name. It does -- but only in assertAuthorityEventBacking, and
-- only for directive.* events that back an authority_events row. Ordinary events carrying the old
-- label are never read that way, so nothing needed rewriting; 0007 installs
-- authority_events_immutable_update BEFORE UPDATE ON events, and that statement aborted the whole
-- migration on the first real database it met.
--
-- It survived review because it was only ever run on fresh databases, where the WHERE clause
-- matched no rows and the trigger therefore never fired. An append-only log should not be edited
-- to tidy a display name in any case: the historical rows name who acted at the time, and the
-- column is a denormalised label for a principal that is identified by id.
--
-- The statement below is keyed on the exact shipped literal, so this is inert on any database that
-- never carried it.

DROP TRIGGER auth_principals_restricted_update;

UPDATE auth_principals
   SET display_name = 'Local User',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 'prn_local_dashboard'
   AND display_name = 'Ayanamislover';

-- Restored exactly as 0007 defined it.
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
