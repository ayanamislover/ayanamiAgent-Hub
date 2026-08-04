import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { parseRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./build-identity.js";

export const CREDENTIAL_ROTATION_SLOTS = [
  { slot: "token", filename: "token" },
  { slot: "agent-codex", filename: "agent-codex-token" },
  { slot: "agent-claude", filename: "agent-claude-token" },
  { slot: "dashboard", filename: "dashboard-token" },
  { slot: "capture-codex", filename: "capture-codex-token" },
  { slot: "capture-claude", filename: "capture-claude-token" },
  { slot: "inject-codex", filename: "inject-codex-token" },
  { slot: "inject-claude", filename: "inject-claude-token" },
] as const;

export const CANONICAL_CREDENTIAL_SCOPES = Object.freeze({
  token: Object.freeze(["project:select"]),
  "agent-codex": Object.freeze([
    "project:join",
    "project:select",
    "session-ticket:offer",
    "session:enroll:first",
  ]),
  "agent-claude": Object.freeze([
    "project:join",
    "project:select",
    "session-ticket:offer",
    "session:enroll:first",
  ]),
  dashboard: Object.freeze(["hub:dashboard"]),
  "capture-codex": Object.freeze(["session-ticket:offer:capture"]),
  "capture-claude": Object.freeze(["session-ticket:offer:capture"]),
  "inject-codex": Object.freeze(["session-ticket:offer:injector"]),
  "inject-claude": Object.freeze(["session-ticket:offer:injector"]),
} satisfies Record<CredentialRotationSlot, readonly string[]>);

export type CredentialRotationSlot = (typeof CREDENTIAL_ROTATION_SLOTS)[number]["slot"];

export type CredentialRotationPhase =
  | "AUTHORIZED"
  | "PREPARED"
  | "STAGED"
  | "SWITCHING"
  | "FILES_INSTALLED"
  | "DB_COMMITTED"
  | "CLEANUP_PENDING"
  | "COMPLETED"
  | "ABORTED";

const SLOT_SET = new Set<string>(CREDENTIAL_ROTATION_SLOTS.map(({ slot }) => slot));
const OPERATION_ID = /^scr_[A-Za-z0-9_-]{1,112}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INSTANCE_ID = /^[a-f0-9]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{32,512}$/u;
const ROTATION_PHASES = new Set<CredentialRotationPhase>([
  "AUTHORIZED",
  "PREPARED",
  "STAGED",
  "SWITCHING",
  "FILES_INSTALLED",
  "DB_COMMITTED",
  "CLEANUP_PENDING",
  "COMPLETED",
  "ABORTED",
]);
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const JOURNAL_RELATIVE = path.join("security", "credential-rotation-journal.jsonl");

const phaseCrashPoints = [
  "after-journal-AUTHORIZED",
  "after-db-PREPARED",
  "after-journal-PREPARED",
  ...CREDENTIAL_ROTATION_SLOTS.map(({ slot }) => `after-stage-${slot}`),
  "after-db-STAGED",
  "after-journal-STAGED",
  "after-db-ABORTED",
  "after-journal-ABORTED",
  "after-db-SWITCHING",
  "after-journal-SWITCHING",
  ...CREDENTIAL_ROTATION_SLOTS.flatMap(({ slot }) => [
    `after-quarantine-${slot}`,
    `after-install-${slot}`,
  ]),
  "after-db-FILES_INSTALLED",
  "after-journal-FILES_INSTALLED",
  "after-db-DB_COMMITTED",
  "after-journal-DB_COMMITTED",
  "after-journal-CLEANUP_PENDING",
  ...CREDENTIAL_ROTATION_SLOTS.map(({ slot }) => `after-cleanup-${slot}`),
  "after-journal-COMPLETED",
] as const;

export const CREDENTIAL_ROTATION_CRASH_POINTS: readonly string[] = phaseCrashPoints;

export type CredentialRotationErrorCode =
  | "ROTATION_REQUEST_INVALID"
  | "ROTATION_CONFLICT"
  | "INLINE_CREDENTIAL_OVERRIDE"
  | "HUB_STOP_RECEIPT_INVALID"
  | "TOKEN_GENERATION_INVALID"
  | "FILE_NOT_OWNER_PRIVATE"
  | "FILE_NOT_REGULAR"
  | "FILE_PATH_INVALID"
  | "FILE_WRITE_FAILED"
  | "CANONICAL_CREDENTIAL_UNKNOWN"
  | "STAGED_CREDENTIAL_MISSING"
  | "EXTERNAL_JOURNAL_INVALID"
  | "SECURITY_EPOCH_FORK"
  | "DATABASE_RECEIPT_INVALID"
  | "DATABASE_RECONCILIATION_REQUIRED"
  | "SENSITIVE_SECURITY_STATE_PATH";

export class CredentialRotationError extends Error {
  constructor(
    readonly code: CredentialRotationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialRotationError";
  }
}

export type ExactHubIdentity = {
  instanceId: string;
  pid: number;
  startedAt: string;
  buildIdentity: RuntimeBuildIdentity;
};

export type ExactHubStopReceipt = ExactHubIdentity & {
  state: "CONFIRMED";
  operationId: string;
  projectId: string;
  idempotencyKey: string;
  stoppedAt: string;
};

export type CredentialRotationAuthorizationSource =
  | { kind: "USER_TURN"; id: string; projectId: string }
  | { kind: "DASHBOARD_EVENT"; id: string; projectId: string };

export type CredentialRotationVerifiedStopReceipt = {
  operationId: string;
  projectId: string;
  stoppedAt: string;
  receiptSha256: string;
};

export type CredentialRotationRequest = {
  operationId: string;
  projectId: string;
  authorizationSource: CredentialRotationAuthorizationSource;
  authorizationReceiptSha256: string;
  incidentStartedAt: string;
  expectedHub: ExactHubIdentity;
};

export type CredentialRotationMember = {
  slot: CredentialRotationSlot;
  generation: number;
  oldTokenSha256: string;
  tokenSha256: string;
  stagedFileSha256: string;
  scopes: readonly string[];
};

export type CredentialRotationDatabasePrepareInput = {
  operationId: string;
  projectId: string;
  authorizationSource: CredentialRotationAuthorizationSource;
  requestSha256: string;
  authorizationReceiptSha256: string;
  stopReceipt: CredentialRotationVerifiedStopReceipt;
  incidentStartedAt: string;
  securityEpochBefore: number;
  securityEpochAfter: number;
  members: readonly CredentialRotationMember[];
};

export type CredentialRotationDatabaseCommitInput = Omit<
  CredentialRotationDatabasePrepareInput,
  "authorizationReceiptSha256"
>;

export type CredentialRotationDatabaseCommitReceipt = {
  operationId: string;
  requestSha256: string;
  securityEpoch: number;
  memberCount: 8;
  oldRootRevocationCount: 8;
  revokedIncidentBundleCount: number;
  revokedIncidentTicketCount: number;
  revokedCaptureBindingCount: number;
  abortedPreparedSyntheticPromptCount: number;
  supersededIssuedLaunchReservationCount: number;
  incidentStartedAt: string;
  cutoverAt: string;
  committedAt: string;
  terminalUnrestrictedReviewRequired: true;
  incidentAuditSha256: string;
  atomic: true;
  receiptSha256: string;
};

export type CredentialRotationDatabaseObservation = {
  securityEpoch: number;
  activeSlots: Array<{
    slot: CredentialRotationSlot;
    generation: number;
    tokenSha256: string;
    scopes: readonly string[];
  }>;
  operation: null | {
    operationId: string;
    phase: CredentialRotationPhase;
    requestSha256: string;
    securityEpochBefore: number;
    securityEpochAfter: number;
    members: readonly CredentialRotationMember[];
    commitReceipt: CredentialRotationDatabaseCommitReceipt | null;
  };
};

export interface CredentialRotationDatabaseAdapter {
  inspect(operationId: string): Promise<CredentialRotationDatabaseObservation>;
  prepare(input: CredentialRotationDatabasePrepareInput): Promise<void>;
  advance(
    operationId: string,
    expected: CredentialRotationPhase,
    next: CredentialRotationPhase,
  ): Promise<void>;
  abortPrepared(operationId: string, requestSha256: string): Promise<void>;
  /** Must atomically install all eight generations and all incident revocations in one DB tx. */
  commit(
    input: CredentialRotationDatabaseCommitInput,
  ): Promise<CredentialRotationDatabaseCommitReceipt>;
  /** Forward-only recovery used when the external epoch survived an older DB restore. */
  recoverExternal(
    input: CredentialRotationDatabaseCommitInput,
  ): Promise<CredentialRotationDatabaseCommitReceipt>;
}

export type CredentialRotationResult = {
  operationId: string;
  phase: "ABORTED" | "CLEANUP_PENDING" | "COMPLETED";
  securityEpoch: number;
  incidentAudit: null | {
    sha256: string;
    terminalUnrestrictedReviewRequired: true;
  };
};

type JournalPlan = CredentialRotationDatabasePrepareInput & {
  authorizationFingerprint: string;
};

type JournalRecord = {
  schemaVersion: 1;
  sequence: number;
  operationId: string;
  phase: CredentialRotationPhase;
  securityEpoch: number;
  operation: JournalPlan | null;
  evidenceSha256: string | null;
  recordedAt: string;
  previousHash: string | null;
  recordHash: string;
};

type LoadedOperation = {
  records: JournalRecord[];
  plan: JournalPlan;
  phase: CredentialRotationPhase;
};

export type CredentialRotationCoordinatorOptions = {
  dataDir: string;
  database: CredentialRotationDatabaseAdapter;
  stopExactHub: (
    expected: ExactHubIdentity,
    operation: { operationId: string; projectId: string },
  ) => Promise<ExactHubStopReceipt>;
  generateToken: (slot: CredentialRotationSlot) => string;
  now?: () => string;
  environment?: NodeJS.ProcessEnv;
  verifyOwnerPrivateAcl: (filePath: string) => Promise<boolean>;
  faultInjector?: (point: string) => void;
  sharingRetry?: {
    attempts: number;
    delayMs: number;
    sleep: (delayMs: number) => Promise<void>;
  };
};

function fail(code: CredentialRotationErrorCode, message: string): never {
  throw new CredentialRotationError(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestCredentialToken(value: string): string {
  return sha256(value);
}

export function digestCredentialRotationCommitReceipt(
  value: Omit<CredentialRotationDatabaseCommitReceipt, "receiptSha256">,
): string {
  return sha256(canonicalJson(value));
}

function assertSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("ROTATION_REQUEST_INVALID", `${field} must be SHA-256`);
  }
}

function assertInstant(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("ROTATION_REQUEST_INVALID", `${field} must be a canonical instant`);
  }
}

function sameBuild(left: RuntimeBuildIdentity, right: RuntimeBuildIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateRequest(value: CredentialRotationRequest): void {
  if (!OPERATION_ID.test(value.operationId))
    fail("ROTATION_REQUEST_INVALID", "operationId is invalid");
  if (!STABLE_ID.test(value.projectId)) fail("ROTATION_REQUEST_INVALID", "projectId is invalid");
  if (
    !value.authorizationSource ||
    !["USER_TURN", "DASHBOARD_EVENT"].includes(value.authorizationSource.kind) ||
    !STABLE_ID.test(value.authorizationSource.id) ||
    value.authorizationSource.projectId !== value.projectId
  ) {
    fail("ROTATION_REQUEST_INVALID", "authorization source is invalid or cross-project");
  }
  assertSha(value.authorizationReceiptSha256, "authorizationReceiptSha256");
  assertInstant(value.incidentStartedAt, "incidentStartedAt");
  const expected = value.expectedHub;
  if (
    !INSTANCE_ID.test(expected.instanceId) ||
    !Number.isSafeInteger(expected.pid) ||
    expected.pid <= 0 ||
    !parseRuntimeBuildIdentity(expected.buildIdentity)
  ) {
    fail("ROTATION_REQUEST_INVALID", "expected Hub identity is invalid");
  }
  assertInstant(expected.startedAt, "expectedHub.startedAt");
}

function requestFingerprint(value: CredentialRotationRequest): string {
  return sha256(canonicalJson(value));
}

export function assertNoInlineCredentialOverrides(environment: NodeJS.ProcessEnv): void {
  const offenders = Object.keys(environment).filter(
    (name) =>
      /^CROSSAGENT(?:_[A-Z0-9]+)*_TOKEN$/u.test(name.toUpperCase()) ||
      name.toUpperCase() === "CROSSAGENT_TOKEN",
  );
  if (offenders.length > 0) {
    fail("INLINE_CREDENTIAL_OVERRIDE", "Inline CrossAgent credential overrides must be removed");
  }
}

export function assertCredentialRotationSnapshotBoundary(logicalPaths: readonly string[]): void {
  const credentialFiles = new Set<string>(
    CREDENTIAL_ROTATION_SLOTS.map(({ filename }) => filename),
  );
  for (const logicalPath of logicalPaths) {
    const segments = logicalPath
      .replaceAll("\\", "/")
      .normalize("NFKC")
      .toLowerCase()
      .split("/")
      .filter(Boolean);
    const basename = segments.at(-1) ?? "";
    const compact = basename.replace(/[^a-z0-9]/gu, "");
    if (
      credentialFiles.has(basename) ||
      segments.join("/") === "authority/ed25519-private-key.pem" ||
      segments.join("/") === "authority/trusted-signing-keys.json" ||
      compact.startsWith("credentialrotationjournal") ||
      compact.startsWith("securityrotationjournal") ||
      compact.startsWith("securityepoch") ||
      compact.startsWith("credentialepoch") ||
      (segments.includes("security") && compact.startsWith("epoch"))
    ) {
      fail(
        "SENSITIVE_SECURITY_STATE_PATH",
        "Credential, Authority trust, rotation journal, and security epoch state is never ordinary snapshot data",
      );
    }
  }
}

function assertExactSlots(
  slots: readonly {
    slot: CredentialRotationSlot;
    generation: number;
    tokenSha256: string;
    scopes: readonly string[];
  }[],
): void {
  if (slots.length !== CREDENTIAL_ROTATION_SLOTS.length) {
    fail("SECURITY_EPOCH_FORK", "database credential slot set is incomplete");
  }
  const seen = new Set<string>();
  for (const member of slots) {
    if (
      !SLOT_SET.has(member.slot) ||
      seen.has(member.slot) ||
      !Number.isSafeInteger(member.generation) ||
      member.generation < 0 ||
      !SHA256.test(member.tokenSha256) ||
      canonicalJson([...member.scopes]) !== canonicalJson(CANONICAL_CREDENTIAL_SCOPES[member.slot])
    ) {
      fail("SECURITY_EPOCH_FORK", "database credential slot set is invalid");
    }
    seen.add(member.slot);
  }
}

function sameMembers(
  left: readonly CredentialRotationMember[],
  right: readonly CredentialRotationMember[],
): boolean {
  const normalize = (items: readonly CredentialRotationMember[]) =>
    [...items].sort((a, b) => a.slot.localeCompare(b.slot));
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

function validateStopReceipt(
  request: CredentialRotationRequest,
  receipt: ExactHubStopReceipt,
): void {
  const expected = request.expectedHub;
  if (
    receipt.state !== "CONFIRMED" ||
    receipt.operationId !== request.operationId ||
    receipt.projectId !== request.projectId ||
    receipt.instanceId !== expected.instanceId ||
    receipt.pid !== expected.pid ||
    receipt.startedAt !== expected.startedAt ||
    !sameBuild(receipt.buildIdentity, expected.buildIdentity) ||
    !UUID.test(receipt.idempotencyKey)
  ) {
    fail(
      "HUB_STOP_RECEIPT_INVALID",
      "cooperative stop receipt does not bind the exact Hub instance",
    );
  }
  assertInstant(receipt.stoppedAt, "stopReceipt.stoppedAt");
  if (receipt.stoppedAt < expected.startedAt || receipt.stoppedAt < request.incidentStartedAt) {
    fail("HUB_STOP_RECEIPT_INVALID", "cooperative stop receipt predates the incident window");
  }
}

function validateCommitReceipt(
  receipt: CredentialRotationDatabaseCommitReceipt,
  plan: JournalPlan,
): void {
  const { receiptSha256, ...unsigned } = receipt;
  if (
    receipt.operationId !== plan.operationId ||
    receipt.requestSha256 !== plan.requestSha256 ||
    receipt.securityEpoch !== plan.securityEpochAfter ||
    receipt.memberCount !== 8 ||
    receipt.oldRootRevocationCount !== 8 ||
    receipt.incidentStartedAt !== plan.incidentStartedAt ||
    receipt.cutoverAt !== plan.stopReceipt.stoppedAt ||
    receipt.atomic !== true ||
    receipt.terminalUnrestrictedReviewRequired !== true ||
    ![
      receipt.revokedIncidentBundleCount,
      receipt.revokedIncidentTicketCount,
      receipt.revokedCaptureBindingCount,
      receipt.abortedPreparedSyntheticPromptCount,
      receipt.supersededIssuedLaunchReservationCount,
    ].every((count) => Number.isSafeInteger(count) && count >= 0) ||
    !SHA256.test(receipt.incidentAuditSha256) ||
    !SHA256.test(receiptSha256) ||
    digestCredentialRotationCommitReceipt(unsigned) !== receiptSha256
  ) {
    fail("DATABASE_RECEIPT_INVALID", "database rotation receipt is incomplete or mismatched");
  }
  assertInstant(receipt.committedAt, "commitReceipt.committedAt");
}

function exactRecordKeys(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).sort().join(",") ===
    "evidenceSha256,operation,operationId,phase,previousHash,recordHash,recordedAt,schemaVersion,securityEpoch,sequence"
  );
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && exactKeys(value, expected);
}

function isCanonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isCredentialRotationSlot(value: unknown): value is CredentialRotationSlot {
  return typeof value === "string" && SLOT_SET.has(value);
}

function hasCanonicalScopes(
  value: unknown,
  slot: CredentialRotationSlot,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((scope) => typeof scope === "string") &&
    canonicalJson(value) === canonicalJson(CANONICAL_CREDENTIAL_SCOPES[slot])
  );
}

function isCredentialRotationAuthorizationSource(
  value: unknown,
  projectId: string,
): value is CredentialRotationAuthorizationSource {
  return (
    isExactRecord(value, ["id", "kind", "projectId"]) &&
    (value.kind === "USER_TURN" || value.kind === "DASHBOARD_EVENT") &&
    typeof value.id === "string" &&
    STABLE_ID.test(value.id) &&
    value.projectId === projectId
  );
}

function isVerifiedStopReceipt(
  value: unknown,
  operationId: string,
  projectId: string,
): value is CredentialRotationVerifiedStopReceipt {
  return (
    isExactRecord(value, ["operationId", "projectId", "receiptSha256", "stoppedAt"]) &&
    value.operationId === operationId &&
    value.projectId === projectId &&
    typeof value.receiptSha256 === "string" &&
    SHA256.test(value.receiptSha256) &&
    isCanonicalInstant(value.stoppedAt)
  );
}

function isCredentialRotationMember(value: unknown): value is CredentialRotationMember {
  return (
    isExactRecord(value, [
      "generation",
      "oldTokenSha256",
      "scopes",
      "slot",
      "stagedFileSha256",
      "tokenSha256",
    ]) &&
    isCredentialRotationSlot(value.slot) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 1 &&
    typeof value.oldTokenSha256 === "string" &&
    SHA256.test(value.oldTokenSha256) &&
    typeof value.tokenSha256 === "string" &&
    SHA256.test(value.tokenSha256) &&
    value.tokenSha256 !== value.oldTokenSha256 &&
    typeof value.stagedFileSha256 === "string" &&
    SHA256.test(value.stagedFileSha256) &&
    hasCanonicalScopes(value.scopes, value.slot)
  );
}

function isJournalPlan(value: unknown): value is JournalPlan {
  return (
    isExactRecord(value, [
      "authorizationFingerprint",
      "authorizationReceiptSha256",
      "authorizationSource",
      "incidentStartedAt",
      "members",
      "operationId",
      "projectId",
      "requestSha256",
      "securityEpochAfter",
      "securityEpochBefore",
      "stopReceipt",
    ]) &&
    typeof value.operationId === "string" &&
    OPERATION_ID.test(value.operationId) &&
    typeof value.authorizationFingerprint === "string" &&
    SHA256.test(value.authorizationFingerprint) &&
    typeof value.authorizationReceiptSha256 === "string" &&
    SHA256.test(value.authorizationReceiptSha256) &&
    typeof value.projectId === "string" &&
    STABLE_ID.test(value.projectId) &&
    isCredentialRotationAuthorizationSource(value.authorizationSource, value.projectId) &&
    typeof value.requestSha256 === "string" &&
    SHA256.test(value.requestSha256) &&
    typeof value.securityEpochBefore === "number" &&
    Number.isSafeInteger(value.securityEpochBefore) &&
    value.securityEpochBefore >= 0 &&
    typeof value.securityEpochAfter === "number" &&
    Number.isSafeInteger(value.securityEpochAfter) &&
    value.securityEpochAfter === value.securityEpochBefore + 1 &&
    isCanonicalInstant(value.incidentStartedAt) &&
    isVerifiedStopReceipt(value.stopReceipt, value.operationId, value.projectId) &&
    value.incidentStartedAt <= value.stopReceipt.stoppedAt &&
    Array.isArray(value.members) &&
    value.members.length === CREDENTIAL_ROTATION_SLOTS.length &&
    value.members.every(isCredentialRotationMember)
  );
}

function assertJournalPlan(value: unknown): asserts value is JournalPlan {
  if (!isJournalPlan(value)) {
    fail("EXTERNAL_JOURNAL_INVALID", "rotation journal plan is invalid");
  }
  const seen = new Set<string>();
  const newDigests = new Set<string>();
  for (const member of value.members) {
    if (seen.has(member.slot) || newDigests.has(member.tokenSha256)) {
      fail("EXTERNAL_JOURNAL_INVALID", "rotation journal member is invalid");
    }
    seen.add(member.slot);
    newDigests.add(member.tokenSha256);
  }
  const expectedRequestSha256 = sha256(
    canonicalJson({
      operationId: value.operationId,
      projectId: value.projectId,
      authorizationSource: value.authorizationSource,
      authorizationReceiptSha256: value.authorizationReceiptSha256,
      stopReceipt: value.stopReceipt,
      incidentStartedAt: value.incidentStartedAt,
      securityEpochBefore: value.securityEpochBefore,
      securityEpochAfter: value.securityEpochAfter,
      members: value.members,
    }),
  );
  if (value.requestSha256 !== expectedRequestSha256) {
    fail("EXTERNAL_JOURNAL_INVALID", "rotation journal request digest is invalid");
  }
}

function unsignedRecord(record: JournalRecord): Omit<JournalRecord, "recordHash"> {
  const { recordHash: _recordHash, ...unsigned } = record;
  return unsigned;
}

export class CredentialRotationFiles {
  readonly dataDir: string;
  readonly journalPath: string;
  private readonly verifyOwnerPrivateAcl: (filePath: string) => Promise<boolean>;

  constructor(dataDir: string, verifyOwnerPrivateAcl: (filePath: string) => Promise<boolean>) {
    if (!path.isAbsolute(dataDir))
      fail("FILE_PATH_INVALID", "credential data root must be absolute");
    this.dataDir = path.resolve(dataDir);
    this.journalPath = path.join(this.dataDir, JOURNAL_RELATIVE);
    this.verifyOwnerPrivateAcl = verifyOwnerPrivateAcl;
  }

  canonicalPath(slot: CredentialRotationSlot): string {
    return path.join(this.dataDir, this.definition(slot).filename);
  }

  stagedPath(operationId: string, slot: CredentialRotationSlot): string {
    return path.join(
      this.dataDir,
      `.crossagent-rotation.${operationId}.${this.definition(slot).filename}.staged`,
    );
  }

  quarantinePath(operationId: string, slot: CredentialRotationSlot): string {
    return path.join(
      this.dataDir,
      `.crossagent-rotation.${operationId}.${this.definition(slot).filename}.old`,
    );
  }

  async initialize(): Promise<void> {
    await this.assertDirectory(this.dataDir);
    if (!(await this.verifyOwnerPrivateAcl(this.dataDir))) {
      fail("FILE_NOT_OWNER_PRIVATE", "credential data directory is not owner-private");
    }
    const security = path.dirname(this.journalPath);
    await mkdir(security, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(security, 0o700);
    await this.assertDirectory(security);
    if (!(await this.verifyOwnerPrivateAcl(security))) {
      fail("FILE_NOT_OWNER_PRIVATE", "security journal directory is not owner-private");
    }
  }

  async inspectCredential(filePath: string): Promise<{
    tokenSha256: string;
    fileSha256: string;
  } | null> {
    let descriptor;
    try {
      descriptor = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      if (isNodeError(error, "ELOOP")) {
        fail("FILE_NOT_REGULAR", "credential path must not be a symbolic link");
      }
      throw error;
    }
    try {
      const metadata = await descriptor.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("FILE_NOT_REGULAR", "credential path must be a non-linked regular file");
      }
      const resolved = await realpath(filePath);
      if (path.resolve(resolved) !== path.resolve(filePath)) {
        fail("FILE_NOT_REGULAR", "credential path traverses a reparse point");
      }
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        fail("FILE_NOT_OWNER_PRIVATE", "credential file has group or world permissions");
      }
      if (!(await this.verifyOwnerPrivateAcl(filePath))) {
        fail("FILE_NOT_OWNER_PRIVATE", "credential ACL grants Everyone or Users access");
      }
      const bytes = await descriptor.readFile();
      const raw = bytes.toString("utf8");
      if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n") || !TOKEN.test(raw.slice(0, -1))) {
        fail("FILE_NOT_REGULAR", "credential file content is invalid");
      }
      return { tokenSha256: digestCredentialToken(raw.slice(0, -1)), fileSha256: sha256(bytes) };
    } finally {
      await descriptor.close();
    }
  }

  async writeStaged(
    operationId: string,
    slot: CredentialRotationSlot,
    rawToken: string,
  ): Promise<{ tokenSha256: string; fileSha256: string }> {
    const target = this.stagedPath(operationId, slot);
    const bytes = Buffer.from(`${rawToken}\n`, "utf8");
    let descriptor;
    try {
      descriptor = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await descriptor.writeFile(bytes);
      await descriptor.sync();
      await descriptor.close();
      descriptor = undefined;
      if (process.platform !== "win32") await chmod(target, 0o600);
      await this.syncDirectory(this.dataDir);
    } catch (error) {
      if (descriptor) await descriptor.close().catch(() => undefined);
      if (!isNodeError(error, "EEXIST")) {
        fail("FILE_WRITE_FAILED", "credential staging write failed");
      }
    }
    const observed = await this.inspectCredential(target);
    if (!observed || observed.fileSha256 !== sha256(bytes)) {
      fail("FILE_WRITE_FAILED", "credential staging file did not reopen with the expected digest");
    }
    return observed;
  }

  async renameNoReplace(source: string, target: string): Promise<void> {
    if (path.dirname(source) !== path.dirname(target)) {
      fail("FILE_PATH_INVALID", "credential rename must remain in the canonical directory");
    }
    if (await this.pathExists(target)) fail("FILE_WRITE_FAILED", "credential rename target exists");
    try {
      await rename(source, target);
      const descriptor = await open(target, constants.O_RDWR);
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
      await this.syncDirectory(path.dirname(target));
    } catch (error) {
      if (await this.pathExists(target)) {
        fail("FILE_WRITE_FAILED", "credential rename completed but write-through flush failed");
      }
      throw error;
    }
  }

  async removeQuarantine(operationId: string, slot: CredentialRotationSlot): Promise<void> {
    await rm(this.quarantinePath(operationId, slot), { force: true });
    await rm(this.stagedPath(operationId, slot), { force: true });
    await this.syncDirectory(this.dataDir);
  }

  async readJournal(): Promise<JournalRecord[]> {
    let bytes: Buffer;
    try {
      const metadata = await lstat(this.journalPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal is not a regular unlinked file");
      }
      if (metadata.size > MAX_JOURNAL_BYTES) {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal is too large");
      }
      if (!(await this.verifyOwnerPrivateAcl(this.journalPath))) {
        fail("FILE_NOT_OWNER_PRIVATE", "rotation journal is not owner-private");
      }
      bytes = await readFile(this.journalPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const raw = bytes.toString("utf8");
    if (!raw.endsWith("\n"))
      fail("EXTERNAL_JOURNAL_INVALID", "rotation journal has a partial tail");
    const records: JournalRecord[] = [];
    let previousHash: string | null = null;
    for (const [index, line] of raw.slice(0, -1).split("\n").entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal contains malformed JSON");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal record is invalid");
      }
      const record = value as JournalRecord;
      if (
        !exactRecordKeys(value as Record<string, unknown>) ||
        record.schemaVersion !== 1 ||
        record.sequence !== index + 1 ||
        record.previousHash !== previousHash ||
        !SHA256.test(record.recordHash) ||
        sha256(canonicalJson(unsignedRecord(record))) !== record.recordHash
      ) {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal hash chain is invalid");
      }
      if (
        !OPERATION_ID.test(record.operationId) ||
        !ROTATION_PHASES.has(record.phase) ||
        !Number.isSafeInteger(record.securityEpoch) ||
        record.securityEpoch < 1 ||
        !Number.isSafeInteger(record.sequence) ||
        !(
          record.evidenceSha256 === null ||
          (typeof record.evidenceSha256 === "string" && SHA256.test(record.evidenceSha256))
        ) ||
        typeof record.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(record.recordedAt)) ||
        new Date(record.recordedAt).toISOString() !== record.recordedAt
      ) {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal record fields are invalid");
      }
      if (record.operation !== null) assertJournalPlan(record.operation);
      previousHash = record.recordHash;
      records.push(record);
    }
    return records;
  }

  async appendJournal(
    operationId: string,
    phase: CredentialRotationPhase,
    securityEpoch: number,
    operation: JournalPlan | null,
    evidenceSha256: string | null,
    recordedAt: string,
  ): Promise<void> {
    const records = await this.readJournal();
    const unsigned: Omit<JournalRecord, "recordHash"> = {
      schemaVersion: 1,
      sequence: records.length + 1,
      operationId,
      phase,
      securityEpoch,
      operation,
      evidenceSha256,
      recordedAt,
      previousHash: records.at(-1)?.recordHash ?? null,
    };
    const record: JournalRecord = { ...unsigned, recordHash: sha256(canonicalJson(unsigned)) };
    const serialized = `${canonicalJson(record)}\n`;
    if (/crx_[A-Za-z0-9._~-]{16,}/u.test(serialized)) {
      fail(
        "EXTERNAL_JOURNAL_INVALID",
        "rotation journal attempted to persist raw credential material",
      );
    }
    const descriptor = await open(
      this.journalPath,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
      0o600,
    );
    try {
      await descriptor.writeFile(serialized, "utf8");
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    if (process.platform !== "win32") await chmod(this.journalPath, 0o600);
    if (!(await this.verifyOwnerPrivateAcl(this.journalPath))) {
      fail("FILE_NOT_OWNER_PRIVATE", "rotation journal is not owner-private");
    }
    await this.syncDirectory(path.dirname(this.journalPath));
    const reopened = await this.readJournal();
    if (reopened.at(-1)?.recordHash !== record.recordHash) {
      fail("EXTERNAL_JOURNAL_INVALID", "rotation journal write-through verification failed");
    }
  }

  private definition(slot: CredentialRotationSlot) {
    const found = CREDENTIAL_ROTATION_SLOTS.find((entry) => entry.slot === slot);
    if (!found) fail("FILE_PATH_INVALID", "unknown credential slot");
    return found;
  }

  private async assertDirectory(directory: string): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail("FILE_PATH_INVALID", "credential directory must not be a reparse point");
    }
    if (path.resolve(await realpath(directory)) !== path.resolve(directory)) {
      fail("FILE_PATH_INVALID", "credential directory resolves outside its configured path");
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await lstat(filePath);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    // Node cannot open Windows directories as fsync handles. Every staged/canonical/journal file is
    // explicitly FlushFileBuffers'd through FileHandle.sync(); POSIX additionally fsyncs the parent
    // directory so rename durability has the strongest primitive exposed by the host runtime.
    if (process.platform === "win32") return;
    const descriptor = await open(directory, constants.O_RDONLY);
    try {
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function phaseOrder(phase: CredentialRotationPhase): number {
  return [
    "AUTHORIZED",
    "PREPARED",
    "STAGED",
    "SWITCHING",
    "FILES_INSTALLED",
    "DB_COMMITTED",
    "CLEANUP_PENDING",
    "COMPLETED",
  ].indexOf(phase);
}

function loadOperation(
  records: readonly JournalRecord[],
  operationId: string,
): LoadedOperation | null {
  const selected = records.filter((record) => record.operationId === operationId);
  if (selected.length === 0) return null;
  const first = selected[0]!;
  if (first.phase !== "AUTHORIZED" || !first.operation) {
    fail("EXTERNAL_JOURNAL_INVALID", "rotation operation has no authorization record");
  }
  const phases = selected.map(({ phase }) => phase);
  const forward = [
    "AUTHORIZED",
    "PREPARED",
    "STAGED",
    "SWITCHING",
    "FILES_INSTALLED",
    "DB_COMMITTED",
    "CLEANUP_PENDING",
    "COMPLETED",
  ];
  const validForward = phases.every((phase, index) => phase === forward[index]);
  const validAbort = phases.join(",") === "AUTHORIZED,PREPARED,STAGED,ABORTED";
  if (!validForward && !validAbort) {
    fail("EXTERNAL_JOURNAL_INVALID", "rotation phase chain is invalid");
  }
  if (
    selected.some(
      (record, index) =>
        record.securityEpoch !== first.operation!.securityEpochAfter ||
        (index > 0 && record.operation !== null) ||
        (["DB_COMMITTED", "CLEANUP_PENDING", "COMPLETED"].includes(record.phase)
          ? record.evidenceSha256 === null
          : record.evidenceSha256 !== null),
    )
  ) {
    fail("EXTERNAL_JOURNAL_INVALID", "rotation journal operation metadata forked");
  }
  return { records: [...selected], plan: first.operation, phase: selected.at(-1)!.phase };
}

export class CredentialRotationCoordinator {
  readonly files: CredentialRotationFiles;
  private readonly options: CredentialRotationCoordinatorOptions;

  constructor(options: CredentialRotationCoordinatorOptions) {
    this.options = options;
    this.files = new CredentialRotationFiles(options.dataDir, options.verifyOwnerPrivateAcl);
  }

  async rotate(request: CredentialRotationRequest): Promise<CredentialRotationResult> {
    assertNoInlineCredentialOverrides(this.options.environment ?? process.env);
    validateRequest(request);
    await this.files.initialize();
    const journal = await this.files.readJournal();
    const existing = loadOperation(journal, request.operationId);
    if (existing) {
      if (existing.plan.authorizationFingerprint !== requestFingerprint(request)) {
        fail("ROTATION_CONFLICT", "operation id is bound to another authorized request");
      }
      return this.reconcile(request.operationId);
    }
    for (const priorOperationId of new Set(journal.map(({ operationId }) => operationId))) {
      const prior = loadOperation(journal, priorOperationId)!;
      if (!["COMPLETED", "ABORTED"].includes(prior.phase)) {
        fail("ROTATION_CONFLICT", `credential rotation ${priorOperationId} is unfinished`);
      }
    }
    const observed = await this.options.database.inspect(request.operationId);
    if (observed.operation) {
      fail("SECURITY_EPOCH_FORK", "database contains an unjournaled rotation operation");
    }
    assertExactSlots(observed.activeSlots);
    const latestExternalEpoch = this.latestExternalEpoch(journal);
    if (observed.securityEpoch !== latestExternalEpoch) {
      fail("SECURITY_EPOCH_FORK", "database and external security epoch diverged");
    }
    await this.assertCanonicalMatches(observed.activeSlots);
    const material = this.createMemberMaterial(observed.activeSlots);
    const stop = await this.options.stopExactHub(request.expectedHub, {
      operationId: request.operationId,
      projectId: request.projectId,
    });
    validateStopReceipt(request, stop);
    const stopReceipt: CredentialRotationVerifiedStopReceipt = {
      operationId: request.operationId,
      projectId: request.projectId,
      stoppedAt: stop.stoppedAt,
      receiptSha256: sha256(canonicalJson(stop)),
    };
    const authorizationFingerprint = requestFingerprint(request);
    const prepareWithoutHash = {
      operationId: request.operationId,
      projectId: request.projectId,
      authorizationSource: request.authorizationSource,
      authorizationReceiptSha256: request.authorizationReceiptSha256,
      stopReceipt,
      incidentStartedAt: request.incidentStartedAt,
      securityEpochBefore: observed.securityEpoch,
      securityEpochAfter: observed.securityEpoch + 1,
      members: material.members,
    };
    const requestSha256 = sha256(canonicalJson(prepareWithoutHash));
    const plan: JournalPlan = {
      ...prepareWithoutHash,
      requestSha256,
      authorizationFingerprint,
    };
    await this.append(plan, "AUTHORIZED", null, true);
    await this.options.database.prepare(plan);
    this.fault("after-db-PREPARED");
    await this.append(plan, "PREPARED", null, true);
    await this.stageMembers(plan, material.secrets);
    await this.options.database.advance(plan.operationId, "PREPARED", "STAGED");
    this.fault("after-db-STAGED");
    await this.append(plan, "STAGED", null, true);
    await this.options.database.advance(plan.operationId, "STAGED", "SWITCHING");
    this.fault("after-db-SWITCHING");
    await this.append(plan, "SWITCHING", null, true);
    return this.continueForward(plan);
  }

  async reconcile(operationId: string): Promise<CredentialRotationResult> {
    assertNoInlineCredentialOverrides(this.options.environment ?? process.env);
    if (!OPERATION_ID.test(operationId)) fail("ROTATION_REQUEST_INVALID", "operationId is invalid");
    await this.files.initialize();
    let loaded = loadOperation(await this.files.readJournal(), operationId);
    if (!loaded) fail("EXTERNAL_JOURNAL_INVALID", "rotation operation is absent from journal");
    let observation = await this.options.database.inspect(operationId);
    if (loaded.phase === "ABORTED") {
      this.assertAbortedObservation(observation, loaded.plan);
      await this.cleanupArtifacts(loaded.plan);
      return this.result(loaded.plan, "ABORTED", null);
    }
    if (observation.securityEpoch > loaded.plan.securityEpochAfter) {
      fail("SECURITY_EPOCH_FORK", "database security epoch is ahead of the external journal");
    }
    if (observation.securityEpoch === loaded.plan.securityEpochAfter) {
      const receipt = this.exactCommittedObservation(observation, loaded.plan);
      await this.assertCanonicalNew(loaded.plan);
      if (phaseOrder(loaded.phase) < phaseOrder("DB_COMMITTED")) {
        await this.append(loaded.plan, "DB_COMMITTED", receipt.receiptSha256, true);
      }
      return this.cleanup(loaded.plan, receipt);
    }

    if (!observation.operation) {
      if (phaseOrder(loaded.phase) >= phaseOrder("DB_COMMITTED")) {
        await this.assertCanonicalNew(loaded.plan);
        const receipt = await this.options.database.recoverExternal(this.commitInput(loaded.plan));
        validateCommitReceipt(receipt, loaded.plan);
        this.fault("after-db-DB_COMMITTED");
        observation = await this.options.database.inspect(operationId);
        this.exactCommittedObservation(observation, loaded.plan);
        return this.cleanup(loaded.plan, receipt);
      }
      await this.options.database.prepare(loaded.plan);
      this.fault("after-db-PREPARED");
      observation = await this.options.database.inspect(operationId);
    }
    this.assertOperationMatches(observation, loaded.plan);
    const databaseOperation = observation.operation;
    if (!databaseOperation) {
      fail(
        "DATABASE_RECONCILIATION_REQUIRED",
        "database operation disappeared during reconciliation",
      );
    }
    loaded = await this.catchJournalUpToDatabase(loaded, databaseOperation.phase);

    if (phaseOrder(loaded.phase) < phaseOrder("STAGED")) {
      if (databaseOperation.phase === "PREPARED") {
        await this.options.database.advance(operationId, "PREPARED", "STAGED");
        this.fault("after-db-STAGED");
      }
      await this.append(loaded.plan, "STAGED", null, true);
      loaded = loadOperation(await this.files.readJournal(), operationId)!;
    }

    const fileStates = await this.inspectFileStates(loaded.plan);
    const anyNew = fileStates.some((state) => state === "NEW");
    const allOld = fileStates.every((state) => state === "OLD");
    const databaseSwitching = phaseOrder(databaseOperation.phase) >= phaseOrder("SWITCHING");
    if (loaded.phase === "STAGED" && !databaseSwitching && allOld) {
      try {
        await this.options.database.abortPrepared(operationId, loaded.plan.requestSha256);
      } catch {
        observation = await this.options.database.inspect(operationId);
        this.assertAbortedObservation(observation, loaded.plan);
      }
      this.fault("after-db-ABORTED");
      observation = await this.options.database.inspect(operationId);
      this.assertAbortedObservation(observation, loaded.plan);
      await this.append(loaded.plan, "ABORTED", null, true);
      await this.cleanupArtifacts(loaded.plan);
      return this.result(loaded.plan, "ABORTED", null);
    }
    if (!databaseSwitching && !allOld && !anyNew) {
      fail("CANONICAL_CREDENTIAL_UNKNOWN", "canonical credential state cannot be reconciled");
    }
    if (phaseOrder(databaseOperation.phase) < phaseOrder("SWITCHING")) {
      await this.options.database.advance(operationId, "STAGED", "SWITCHING");
      this.fault("after-db-SWITCHING");
    }
    if (loaded.phase === "STAGED") await this.append(loaded.plan, "SWITCHING", null, true);
    return this.continueForward(loaded.plan);
  }

  private async continueForward(plan: JournalPlan): Promise<CredentialRotationResult> {
    await this.installAll(plan);
    let loaded = loadOperation(await this.files.readJournal(), plan.operationId)!;
    let observation = await this.options.database.inspect(plan.operationId);
    this.assertOperationMatches(observation, plan);
    if (phaseOrder(observation.operation!.phase) < phaseOrder("FILES_INSTALLED")) {
      await this.options.database.advance(plan.operationId, "SWITCHING", "FILES_INSTALLED");
      this.fault("after-db-FILES_INSTALLED");
    }
    if (phaseOrder(loaded.phase) < phaseOrder("FILES_INSTALLED")) {
      await this.append(plan, "FILES_INSTALLED", null, true);
    }
    let receipt: CredentialRotationDatabaseCommitReceipt;
    try {
      receipt = await this.options.database.commit(this.commitInput(plan));
    } catch {
      observation = await this.options.database.inspect(plan.operationId);
      receipt = this.exactCommittedObservation(observation, plan);
    }
    validateCommitReceipt(receipt, plan);
    this.fault("after-db-DB_COMMITTED");
    loaded = loadOperation(await this.files.readJournal(), plan.operationId)!;
    if (phaseOrder(loaded.phase) < phaseOrder("DB_COMMITTED")) {
      await this.append(plan, "DB_COMMITTED", receipt.receiptSha256, true);
    }
    return this.cleanup(plan, receipt);
  }

  private async cleanup(
    plan: JournalPlan,
    receipt: CredentialRotationDatabaseCommitReceipt,
  ): Promise<CredentialRotationResult> {
    let loaded = loadOperation(await this.files.readJournal(), plan.operationId)!;
    this.assertJournalReceiptEvidence(loaded, receipt);
    await this.assertCanonicalNew(plan);
    if (loaded.phase === "COMPLETED") return this.result(plan, "COMPLETED", receipt);
    if (loaded.phase === "DB_COMMITTED") {
      await this.append(plan, "CLEANUP_PENDING", receipt.receiptSha256, true);
    }
    for (const { slot } of CREDENTIAL_ROTATION_SLOTS) {
      try {
        await this.files.removeQuarantine(plan.operationId, slot);
      } catch {
        return this.result(plan, "CLEANUP_PENDING", receipt);
      }
      this.fault(`after-cleanup-${slot}`);
    }
    loaded = loadOperation(await this.files.readJournal(), plan.operationId)!;
    if (loaded.phase !== "COMPLETED") {
      await this.append(plan, "COMPLETED", receipt.receiptSha256, true);
    }
    return this.result(plan, "COMPLETED", receipt);
  }

  private createMemberMaterial(active: CredentialRotationDatabaseObservation["activeSlots"]): {
    members: CredentialRotationMember[];
    secrets: Map<CredentialRotationSlot, string>;
  } {
    const bySlot = new Map(active.map((member) => [member.slot, member]));
    const activeDigests = new Set(active.map(({ tokenSha256 }) => tokenSha256));
    const generated = new Set<string>();
    const members: CredentialRotationMember[] = [];
    const secrets = new Map<CredentialRotationSlot, string>();
    for (const { slot } of CREDENTIAL_ROTATION_SLOTS) {
      const old = bySlot.get(slot)!;
      if (old.generation >= Number.MAX_SAFE_INTEGER) {
        fail("SECURITY_EPOCH_FORK", "credential generation cannot advance safely");
      }
      const rawToken = this.options.generateToken(slot);
      if (!TOKEN.test(rawToken) || generated.has(rawToken)) {
        fail(
          "TOKEN_GENERATION_INVALID",
          "credential generator returned weak or duplicate material",
        );
      }
      generated.add(rawToken);
      const tokenSha256 = digestCredentialToken(rawToken);
      if (activeDigests.has(tokenSha256)) {
        fail("TOKEN_GENERATION_INVALID", "credential generator reused an active secret root");
      }
      const stagedFileSha256 = sha256(Buffer.from(`${rawToken}\n`, "utf8"));
      secrets.set(slot, rawToken);
      members.push({
        slot,
        generation: old.generation + 1,
        oldTokenSha256: old.tokenSha256,
        tokenSha256,
        stagedFileSha256,
        scopes: [...CANONICAL_CREDENTIAL_SCOPES[slot]],
      });
    }
    return { members, secrets };
  }

  private async stageMembers(
    plan: JournalPlan,
    secrets: ReadonlyMap<CredentialRotationSlot, string>,
  ): Promise<void> {
    for (const member of plan.members) {
      const rawToken = secrets.get(member.slot);
      if (!rawToken) fail("TOKEN_GENERATION_INVALID", "credential staging material is absent");
      const staged = await this.files.writeStaged(plan.operationId, member.slot, rawToken);
      if (
        staged.tokenSha256 !== member.tokenSha256 ||
        staged.fileSha256 !== member.stagedFileSha256
      ) {
        fail("FILE_WRITE_FAILED", "credential staging digest differs from durable plan");
      }
      this.fault(`after-stage-${member.slot}`);
    }
  }

  private async installAll(plan: JournalPlan): Promise<void> {
    for (const member of plan.members) {
      const canonical = this.files.canonicalPath(member.slot);
      const quarantine = this.files.quarantinePath(plan.operationId, member.slot);
      const staged = this.files.stagedPath(plan.operationId, member.slot);
      const current = await this.files.inspectCredential(canonical);
      const old = await this.files.inspectCredential(quarantine);
      if (current?.tokenSha256 === member.tokenSha256) {
        if (current.fileSha256 !== member.stagedFileSha256) {
          fail("CANONICAL_CREDENTIAL_UNKNOWN", "installed credential file digest drifted");
        }
        continue;
      }
      if (current?.tokenSha256 === member.oldTokenSha256) {
        if (old) fail("CANONICAL_CREDENTIAL_UNKNOWN", "old credential exists twice");
        await this.renameWithSharingRetry(canonical, quarantine);
        this.fault(`after-quarantine-${member.slot}`);
      } else if (current) {
        fail("CANONICAL_CREDENTIAL_UNKNOWN", "canonical credential is neither old nor new");
      } else if (!old || old.tokenSha256 !== member.oldTokenSha256) {
        fail("CANONICAL_CREDENTIAL_UNKNOWN", "credential old root has no exact quarantine proof");
      }
      const stagedState = await this.files.inspectCredential(staged);
      if (
        !stagedState ||
        stagedState.tokenSha256 !== member.tokenSha256 ||
        stagedState.fileSha256 !== member.stagedFileSha256
      ) {
        fail("STAGED_CREDENTIAL_MISSING", "forward credential stage is missing or corrupted");
      }
      await this.renameWithSharingRetry(staged, canonical);
      const reopened = await this.files.inspectCredential(canonical);
      if (
        !reopened ||
        reopened.tokenSha256 !== member.tokenSha256 ||
        reopened.fileSha256 !== member.stagedFileSha256
      ) {
        fail("FILE_WRITE_FAILED", "installed credential failed write-through digest validation");
      }
      this.fault(`after-install-${member.slot}`);
    }
  }

  private async renameWithSharingRetry(source: string, target: string): Promise<void> {
    const retry = this.options.sharingRetry ?? {
      attempts: 5,
      delayMs: 50,
      sleep: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    };
    if (!Number.isSafeInteger(retry.attempts) || retry.attempts < 1 || retry.attempts > 20) {
      fail("ROTATION_REQUEST_INVALID", "sharing retry policy is invalid");
    }
    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      try {
        await this.files.renameNoReplace(source, target);
        return;
      } catch (error) {
        const retryable = ["EBUSY", "EACCES", "EPERM"].some((code) => isNodeError(error, code));
        if (!retryable || attempt === retry.attempts) throw error;
        await retry.sleep(retry.delayMs);
      }
    }
  }

  private async inspectFileStates(plan: JournalPlan): Promise<Array<"OLD" | "NEW" | "MISSING">> {
    const states: Array<"OLD" | "NEW" | "MISSING"> = [];
    for (const member of plan.members) {
      const observed = await this.files.inspectCredential(this.files.canonicalPath(member.slot));
      if (!observed) states.push("MISSING");
      else if (observed.tokenSha256 === member.oldTokenSha256) states.push("OLD");
      else if (
        observed.tokenSha256 === member.tokenSha256 &&
        observed.fileSha256 === member.stagedFileSha256
      ) {
        states.push("NEW");
      } else fail("CANONICAL_CREDENTIAL_UNKNOWN", "canonical credential digest is unknown");
    }
    return states;
  }

  private async assertCanonicalMatches(
    active: CredentialRotationDatabaseObservation["activeSlots"],
  ): Promise<void> {
    const bySlot = new Map(active.map((member) => [member.slot, member]));
    for (const { slot } of CREDENTIAL_ROTATION_SLOTS) {
      const observed = await this.files.inspectCredential(this.files.canonicalPath(slot));
      if (!observed || observed.tokenSha256 !== bySlot.get(slot)!.tokenSha256) {
        fail("SECURITY_EPOCH_FORK", "canonical credential does not match active database slot");
      }
    }
  }

  private async assertCanonicalNew(plan: JournalPlan): Promise<void> {
    for (const member of plan.members) {
      const observed = await this.files.inspectCredential(this.files.canonicalPath(member.slot));
      if (
        !observed ||
        observed.tokenSha256 !== member.tokenSha256 ||
        observed.fileSha256 !== member.stagedFileSha256
      ) {
        fail(
          "CANONICAL_CREDENTIAL_UNKNOWN",
          "committed credential cleanup requires all eight exact new canonical files",
        );
      }
    }
  }

  private assertOperationMatches(
    observation: CredentialRotationDatabaseObservation,
    plan: JournalPlan,
  ): void {
    const operation = observation.operation;
    if (
      !operation ||
      operation.operationId !== plan.operationId ||
      operation.requestSha256 !== plan.requestSha256 ||
      operation.securityEpochBefore !== plan.securityEpochBefore ||
      operation.securityEpochAfter !== plan.securityEpochAfter ||
      !sameMembers(operation.members, plan.members)
    ) {
      fail("SECURITY_EPOCH_FORK", "database operation does not match external journal");
    }
  }

  private exactCommittedObservation(
    observation: CredentialRotationDatabaseObservation,
    plan: JournalPlan,
  ): CredentialRotationDatabaseCommitReceipt {
    this.assertOperationMatches(observation, plan);
    const operation = observation.operation;
    if (
      observation.securityEpoch !== plan.securityEpochAfter ||
      !operation ||
      operation.phase !== "DB_COMMITTED" ||
      !operation.commitReceipt
    ) {
      fail("SECURITY_EPOCH_FORK", "database commit receipt is absent or forked");
    }
    assertExactSlots(observation.activeSlots);
    for (const member of plan.members) {
      const active = observation.activeSlots.find(({ slot }) => slot === member.slot);
      if (
        active?.generation !== member.generation ||
        active.tokenSha256 !== member.tokenSha256 ||
        canonicalJson(active.scopes) !== canonicalJson(member.scopes)
      ) {
        fail("SECURITY_EPOCH_FORK", "database active credential generation is forked");
      }
    }
    validateCommitReceipt(operation.commitReceipt, plan);
    return operation.commitReceipt;
  }

  private assertAbortedObservation(
    observation: CredentialRotationDatabaseObservation,
    plan: JournalPlan,
  ): void {
    this.assertOperationMatches(observation, plan);
    if (
      observation.securityEpoch !== plan.securityEpochBefore ||
      observation.operation?.phase !== "ABORTED" ||
      observation.operation.commitReceipt !== null
    ) {
      fail("DATABASE_RECONCILIATION_REQUIRED", "database abort is not durably observable");
    }
    assertExactSlots(observation.activeSlots);
    for (const member of plan.members) {
      const active = observation.activeSlots.find(({ slot }) => slot === member.slot);
      if (
        active?.generation !== member.generation - 1 ||
        active.tokenSha256 !== member.oldTokenSha256 ||
        canonicalJson(active.scopes) !== canonicalJson(member.scopes)
      ) {
        fail("DATABASE_RECONCILIATION_REQUIRED", "aborted database roots are not exact old roots");
      }
    }
  }

  private async catchJournalUpToDatabase(
    loaded: LoadedOperation,
    databasePhase: CredentialRotationPhase,
  ): Promise<LoadedOperation> {
    const recoverable: CredentialRotationPhase[] = [
      "PREPARED",
      "STAGED",
      "SWITCHING",
      "FILES_INSTALLED",
    ];
    for (const phase of recoverable) {
      if (
        phaseOrder(phase) > phaseOrder(loaded.phase) &&
        phaseOrder(phase) <= phaseOrder(databasePhase)
      ) {
        await this.append(loaded.plan, phase, null, true);
        loaded = loadOperation(await this.files.readJournal(), loaded.plan.operationId)!;
      }
    }
    return loaded;
  }

  private latestExternalEpoch(records: readonly JournalRecord[]): number {
    if (records.length === 0) return 0;
    let epoch = 0;
    for (const operationId of new Set(records.map((record) => record.operationId))) {
      const loaded = loadOperation(records, operationId)!;
      epoch = Math.max(
        epoch,
        ["DB_COMMITTED", "CLEANUP_PENDING", "COMPLETED"].includes(loaded.phase)
          ? loaded.plan.securityEpochAfter
          : loaded.plan.securityEpochBefore,
      );
    }
    return epoch;
  }

  private async append(
    plan: JournalPlan,
    phase: CredentialRotationPhase,
    evidenceSha256: string | null,
    injectFault: boolean,
  ): Promise<void> {
    const existing = loadOperation(await this.files.readJournal(), plan.operationId);
    if (phase === "ABORTED") {
      if (existing?.phase === "ABORTED") return;
      if (existing?.phase !== "STAGED") {
        fail("EXTERNAL_JOURNAL_INVALID", "only a staged all-old rotation may abort");
      }
    }
    if (
      phase !== "ABORTED" &&
      (existing?.phase === phase || phaseOrder(existing?.phase ?? "AUTHORIZED") > phaseOrder(phase))
    ) {
      return;
    }
    await this.files.appendJournal(
      plan.operationId,
      phase,
      plan.securityEpochAfter,
      phase === "AUTHORIZED" ? plan : null,
      evidenceSha256,
      this.now(),
    );
    if (injectFault) this.fault(`after-journal-${phase}`);
  }

  private commitInput(plan: JournalPlan): CredentialRotationDatabaseCommitInput {
    return {
      operationId: plan.operationId,
      projectId: plan.projectId,
      authorizationSource: plan.authorizationSource,
      requestSha256: plan.requestSha256,
      stopReceipt: plan.stopReceipt,
      incidentStartedAt: plan.incidentStartedAt,
      securityEpochBefore: plan.securityEpochBefore,
      securityEpochAfter: plan.securityEpochAfter,
      members: plan.members,
    };
  }

  private result(
    plan: JournalPlan,
    phase: CredentialRotationResult["phase"],
    receipt: CredentialRotationDatabaseCommitReceipt | null,
  ): CredentialRotationResult {
    return {
      operationId: plan.operationId,
      phase,
      securityEpoch: phase === "ABORTED" ? plan.securityEpochBefore : plan.securityEpochAfter,
      incidentAudit: receipt
        ? {
            sha256: receipt.incidentAuditSha256,
            terminalUnrestrictedReviewRequired: true,
          }
        : null,
    };
  }

  private assertJournalReceiptEvidence(
    loaded: LoadedOperation,
    receipt: CredentialRotationDatabaseCommitReceipt,
  ): void {
    for (const record of loaded.records) {
      if (
        ["DB_COMMITTED", "CLEANUP_PENDING", "COMPLETED"].includes(record.phase) &&
        record.evidenceSha256 !== receipt.receiptSha256
      ) {
        fail("EXTERNAL_JOURNAL_INVALID", "rotation journal receipt evidence is forked");
      }
    }
  }

  private async cleanupArtifacts(plan: JournalPlan): Promise<void> {
    for (const { slot } of CREDENTIAL_ROTATION_SLOTS) {
      await this.files.removeQuarantine(plan.operationId, slot);
    }
  }

  private now(): string {
    const value = (this.options.now ?? (() => new Date().toISOString()))();
    assertInstant(value, "now");
    return value;
  }

  private fault(point: string): void {
    this.options.faultInjector?.(point);
  }
}
