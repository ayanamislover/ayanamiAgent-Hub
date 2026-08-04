import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DirectiveAttestationPayloadSchema,
  DirectiveAttestationSchema,
  canonicalJson,
  createId,
  nowIso,
  type DirectiveAttestation,
  type DirectiveAttestationPayload,
} from "@crossagent/protocol";
import type Database from "better-sqlite3";

type SigningKeyRow = {
  key_id: string;
  public_key_spki_base64url: string;
  fingerprint_sha256: string;
  created_at: string;
  status: "ACTIVE" | "RETIRED" | "REVOKED";
};

export type AttestationVerification =
  { valid: true; attestation: DirectiveAttestation } | { valid: false; reason: string };

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function privateKeyPath(dataDir: string): string {
  return resolve(dataDir, "authority", "ed25519-private-key.pem");
}

function trustPinManifestPath(dataDir: string): string {
  return resolve(dataDir, "authority", "trusted-signing-keys.json");
}

function assertTrustPinManifest(
  path: string,
  expected: { keyId: string; fingerprintSha256: string },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Authority trust pin manifest is unreadable: ${String(error)}`);
  }
  const manifest = parsed as {
    schemaVersion?: unknown;
    keys?: Array<{ keyId?: unknown; fingerprintSha256?: unknown }>;
  };
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.keys) ||
    manifest.keys.length !== 1 ||
    manifest.keys[0]?.keyId !== expected.keyId ||
    manifest.keys[0]?.fingerprintSha256 !== expected.fingerprintSha256
  ) {
    throw new Error("Authority trust pin manifest does not match the registered active key");
  }
}

/**
 * Persist the Adapter's non-secret trust anchor before it can consume a signed directive.
 *
 * An existing manifest is never silently replaced: doing so would turn restart into TOFU for an
 * attacker-controlled key. Explicit key rotation must enroll the successor in a separate user-
 * authenticated operation.
 */
function ensureTrustPinManifest(
  dataDir: string,
  expected: { keyId: string; fingerprintSha256: string },
): void {
  const path = trustPinManifestPath(dataDir);
  if (existsSync(path)) {
    assertTrustPinManifest(path, expected);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const contents = `${JSON.stringify(
    {
      schemaVersion: 1,
      keys: [{ keyId: expected.keyId, fingerprintSha256: expected.fingerprintSha256 }],
    },
    null,
    2,
  )}\n`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      chmodSync(temporaryPath, 0o600);
    } catch {
      // Windows uses the containing account ACL; the manifest contains public fingerprints only.
    }
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (existsSync(path)) {
      assertTrustPinManifest(path, expected);
      return;
    }
    throw error;
  }
  assertTrustPinManifest(path, expected);
}

function readPrivateKey(path: string): KeyObject {
  return createPrivateKey(readFileSync(path, "utf8"));
}

function writePrivateKey(path: string, privateKey: KeyObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      chmodSync(temporaryPath, 0o600);
    } catch {
      // Windows uses the containing account ACL; the documented host boundary still applies.
    }
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function publicIdentity(privateKey: KeyObject): {
  publicKey: KeyObject;
  spki: Buffer;
  fingerprint: string;
  keyId: string;
} {
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const fingerprint = sha256(spki);
  const keyId = `ed25519:${Buffer.from(fingerprint, "hex").toString("base64url")}`;
  return { publicKey, spki, fingerprint, keyId };
}

/**
 * The signer is an application-level trust boundary. Its private key is never placed in SQLite,
 * HTTP responses, events, or model environments. On this local deployment the Windows account is
 * still trusted: unrestricted same-user code can read the file despite the mode/ACL best effort.
 */
export class AuthorityAttestationService {
  readonly keyId: string;
  readonly publicKeySpkiBase64Url: string;
  private readonly privateKey: KeyObject;

  constructor(
    private readonly sqlite: Database.Database,
    dataDir: string,
  ) {
    const path = privateKeyPath(dataDir);
    const registered = sqlite
      .prepare(
        `SELECT key.key_id, key.public_key_spki_base64url, key.fingerprint_sha256,
                key.created_at,
                CASE
                  WHEN EXISTS (
                    SELECT 1 FROM authority_key_events event
                    WHERE event.key_id = key.key_id AND event.event_type = 'REVOKED'
                  ) THEN 'REVOKED'
                  WHEN EXISTS (
                    SELECT 1 FROM authority_key_events event
                    WHERE event.key_id = key.key_id AND event.event_type = 'RETIRED'
                  ) THEN 'RETIRED'
                  ELSE 'ACTIVE'
                END AS status
         FROM authority_signing_keys key
         JOIN authority_key_events activated
           ON activated.key_id = key.key_id AND activated.event_type = 'ACTIVATED'
         ORDER BY key.created_at, key.key_id`,
      )
      .all() as SigningKeyRow[];
    const active = registered.filter((row) => row.status === "ACTIVE");
    if (active.length > 1) {
      throw new Error("Authority signing registry has more than one active key");
    }
    if (active.length === 0 && registered.length > 0) {
      // A terminal trust root cannot authorize its own replacement. Rotation/enrollment must be a
      // separate authenticated operation that pins a successor before the old key is retired, or a
      // Dashboard trust-anchor recovery after revocation. Failing here is safer than accepting a
      // self-signed replacement merely because it can write the same data directory.
      throw new Error(
        "Authority registry has no active trusted Authority signing key; explicit key enrollment is required",
      );
    }

    const shouldRegister = registered.length === 0;
    let selectedPrivateKey: KeyObject;
    if (!shouldRegister) {
      if (!existsSync(path)) {
        throw new Error("Authority signing private key is missing for the registered active key");
      }
      selectedPrivateKey = readPrivateKey(path);
    } else {
      selectedPrivateKey = existsSync(path)
        ? readPrivateKey(path)
        : generateKeyPairSync("ed25519").privateKey;
      if (!existsSync(path)) writePrivateKey(path, selectedPrivateKey);
    }
    this.privateKey = selectedPrivateKey;
    if (this.privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Authority signing key is not Ed25519");
    }
    const identity = publicIdentity(this.privateKey);
    this.keyId = identity.keyId;
    this.publicKeySpkiBase64Url = identity.spki.toString("base64url");
    if (shouldRegister) {
      const createdAt = nowIso();
      const statement = canonicalJson({
        type: "crossagent.authority-key-bootstrap.v1",
        key_id: identity.keyId,
        public_key_spki_base64url: this.publicKeySpkiBase64Url,
        created_at: createdAt,
      });
      const transitionSignature = sign(
        null,
        Buffer.from(statement, "utf8"),
        this.privateKey,
      ).toString("base64url");
      sqlite.transaction(() => {
        sqlite
          .prepare(
            `INSERT INTO authority_signing_keys(
               key_id, algorithm, public_key_spki_base64url, fingerprint_sha256, created_at
             ) VALUES (?, 'Ed25519', ?, ?, ?)`,
          )
          .run(identity.keyId, this.publicKeySpkiBase64Url, identity.fingerprint, createdAt);
        sqlite
          .prepare(
            `INSERT INTO authority_key_events(
               id, key_id, event_type, previous_key_id, transition_statement_json,
               transition_signature, created_at
             ) VALUES (?, ?, 'ACTIVATED', NULL, ?, ?, ?)`,
          )
          .run(createId("ake"), identity.keyId, statement, transitionSignature, createdAt);
      })();
    } else {
      const row = active[0]!;
      if (
        row.key_id !== identity.keyId ||
        row.public_key_spki_base64url !== this.publicKeySpkiBase64Url ||
        row.fingerprint_sha256 !== identity.fingerprint
      ) {
        throw new Error("Authority signing private key does not match the pinned registry");
      }
    }
    ensureTrustPinManifest(dataDir, {
      keyId: identity.keyId,
      fingerprintSha256: identity.fingerprint,
    });
  }

  private assertKeyActive(): void {
    const active = this.sqlite
      .prepare(
        `SELECT 1 FROM authority_key_events activated
         WHERE activated.key_id = ? AND activated.event_type = 'ACTIVATED'
           AND NOT EXISTS (
             SELECT 1 FROM authority_key_events terminal
             WHERE terminal.key_id = activated.key_id
               AND terminal.event_type IN ('RETIRED', 'REVOKED')
           )`,
      )
      .get(this.keyId);
    if (!active) throw new Error("Authority signing key is not active");
  }

  sign(payloadInput: DirectiveAttestationPayload): DirectiveAttestation {
    this.assertKeyActive();
    const payload = DirectiveAttestationPayloadSchema.parse(payloadInput);
    if (payload.key_id !== this.keyId) {
      throw new Error("Attestation payload key_id does not match the active signer");
    }
    const canonical = canonicalJson(payload);
    const signature = sign(null, Buffer.from(canonical, "utf8"), this.privateKey).toString(
      "base64url",
    );
    return DirectiveAttestationSchema.parse({
      payload,
      canonical_payload_sha256: sha256(canonical),
      signature,
    });
  }

  verify(input: unknown): AttestationVerification {
    let attestation: DirectiveAttestation;
    try {
      attestation = DirectiveAttestationSchema.parse(input);
    } catch (error) {
      return { valid: false, reason: `ATTESTATION_SCHEMA_INVALID: ${String(error)}` };
    }
    const row = this.sqlite
      .prepare(
        `SELECT key.public_key_spki_base64url
         FROM authority_signing_keys key
         JOIN authority_key_events activated
           ON activated.key_id = key.key_id AND activated.event_type = 'ACTIVATED'
         WHERE key.key_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM authority_key_events terminal
             WHERE terminal.key_id = key.key_id
               AND terminal.event_type = 'REVOKED'
           )`,
      )
      .get(attestation.payload.key_id) as { public_key_spki_base64url: string } | undefined;
    if (!row) return { valid: false, reason: "DIRECTIVE_KEY_UNTRUSTED" };
    const canonical = canonicalJson(attestation.payload);
    if (sha256(canonical) !== attestation.canonical_payload_sha256) {
      return { valid: false, reason: "DIRECTIVE_HASH_MISMATCH" };
    }
    if (
      (attestation.payload.quote &&
        sha256(attestation.payload.quote.verbatim_text) !==
          attestation.payload.quote.verbatim_text_sha256) ||
      (attestation.payload.delegated_instruction &&
        sha256(attestation.payload.delegated_instruction.text) !==
          attestation.payload.delegated_instruction.text_sha256)
    ) {
      return { valid: false, reason: "DIRECTIVE_CONTENT_HASH_MISMATCH" };
    }
    let signature: Buffer;
    try {
      signature = Buffer.from(attestation.signature, "base64url");
    } catch {
      return { valid: false, reason: "DIRECTIVE_SIGNATURE_INVALID" };
    }
    if (signature.length !== 64) {
      return { valid: false, reason: "DIRECTIVE_SIGNATURE_INVALID" };
    }
    const publicKey = createPublicKey({
      key: Buffer.from(row.public_key_spki_base64url, "base64url"),
      type: "spki",
      format: "der",
    });
    if (!verify(null, Buffer.from(canonical, "utf8"), publicKey, signature)) {
      return { valid: false, reason: "DIRECTIVE_SIGNATURE_INVALID" };
    }
    return { valid: true, attestation };
  }
}
