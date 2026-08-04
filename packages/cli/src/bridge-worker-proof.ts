import { createConnection, createServer, type Server, type Socket } from "node:net";
import { statIdentityDivergence } from "./stat-divergence.js";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  assertManagedBridgeIpcSubject,
  type ManagedBridgeIpcSubject,
} from "./managed-bridge-ipc.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_FRAME_BYTES = 4 * 1024;
const MAX_SIDECAR_BYTES = 16 * 1024;
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_NODES = 4_096;
const SHA256 = /^[a-f0-9]{64}$/u;

export type BridgeWorkerProofMode = "disabled" | "required";

/**
 * This is deliberately the small launch subject, not a Hub authority claim. It binds a proof to
 * one managed child before the real Adapter has registered a session/runtime subject.
 */
export type BridgeWorkerProofLaunchSubject = {
  schemaVersion: 1;
  projectId: string;
  agentId: "codex";
  runId: string;
  threadId: string | null;
  build: {
    buildSessionId: string;
    buildId: string;
    migrationId: string;
    protocolId: string;
    manifestSha256: string;
  };
};

export type BridgeWorkerProofSubject = BridgeWorkerProofLaunchSubject | ManagedBridgeIpcSubject;

/** Public-only durable evidence. It must remain safe to retain after either process crashes. */
export type BridgeWorkerProofSidecar = {
  schemaVersion: 1;
  kind: "BRIDGE_WORKER_PROOF_SIDECAR";
  sidecarId: string;
  revision: number;
  state: "RUNNING" | "EXITED" | "STOPPED";
  subject: BridgeWorkerProofSubject;
  pid: number | null;
  workerPipePath: string;
  workerPublicKeySpkiDerBase64: string;
  workerPublicKeySha256: string;
  stateUpdatedAt: string;
};

export type BridgeWorkerProof = {
  schemaVersion: 1;
  kind: "BRIDGE_WORKER_CHALLENGE_OK";
  challengeId: string;
  sidecarId: string;
  sidecarRevision: number;
  subject: BridgeWorkerProofSubject;
  pid: number;
  healthUpdatedAt: string;
  signatureBase64: string;
};

type ChallengeRequest = {
  schemaVersion: 1;
  kind: "BRIDGE_WORKER_CHALLENGE";
  challengeId: string;
};

export type WindowsOwnerPrivateAclVerifier = (path: string) => boolean | Promise<boolean>;
export type WindowsOwnerPrivateAclHardener = (
  path: string,
  kind: "directory" | "file",
) => boolean | Promise<boolean>;

export class BridgeWorkerProofError extends Error {
  constructor(
    readonly code:
      | "WINDOWS_ACL_VERIFIER_UNAVAILABLE"
      | "PATH_NOT_OWNER_PRIVATE"
      | "INVALID_SIDECAR"
      | "INVALID_PROOF"
      | "PIPE_PROTOCOL_ERROR"
      | "PIPE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "BridgeWorkerProofError";
  }
}

export type BridgeWorkerProofLifecycle = {
  readonly sidecar: BridgeWorkerProofSidecar;
  rebindSubject(subject: BridgeWorkerProofSubject): Promise<void>;
  close(state: "EXITED" | "STOPPED"): Promise<void>;
};

/** A fresh unpredictable challenge is required for each parent/Adapter probe. */
export function createBridgeWorkerChallengeId(): string {
  return randomBytes(32).toString("hex");
}

export function bridgeWorkerProofSubjectThreadId(subject: BridgeWorkerProofSubject): string | null {
  return "originalThreadId" in subject ? subject.originalThreadId : subject.threadId;
}

/**
 * Reads one exact public sidecar through a regular-file handle, repeats the path/ACL observation,
 * and derives the pipe name instead of trusting an arbitrary durable endpoint.
 */
export async function readBridgeWorkerProofSidecar(input: {
  controlPath: string;
  sidecarPath: string;
  /** Terminal recovery may retain the exact sidecar after its consumed control record is removed. */
  controlRequired?: boolean;
  windowsOwnerPrivateAclVerifier?: WindowsOwnerPrivateAclVerifier;
}): Promise<BridgeWorkerProofSidecar> {
  const controlPath = resolve(input.controlPath);
  const sidecarPath = resolve(input.sidecarPath);
  const expectedSidecarName = basename(controlPath).replace(/\.pid\.json$/u, ".worker-proof.json");
  if (
    dirname(controlPath) !== dirname(sidecarPath) ||
    basename(sidecarPath) !== expectedSidecarName
  ) {
    invalid("INVALID_SIDECAR", "Worker sidecar does not match its managed control path");
  }
  if (input.controlRequired !== false) {
    await assertOwnerPrivatePath(controlPath, input.windowsOwnerPrivateAclVerifier, true);
  } else if (existsSync(controlPath)) {
    invalid("INVALID_SIDECAR", "Terminal worker proof unexpectedly regained control authority");
  }
  await assertOwnerPrivatePath(dirname(sidecarPath), input.windowsOwnerPrivateAclVerifier, false);
  await assertOwnerPrivatePath(sidecarPath, input.windowsOwnerPrivateAclVerifier, true);

  const descriptor = openSync(
    sidecarPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let raw: Buffer;
  let opened: ReturnType<typeof fstatSync>;
  try {
    opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size <= 0 || opened.size > MAX_SIDECAR_BYTES) {
      invalid("INVALID_SIDECAR", "Worker proof sidecar is not a bounded regular file");
    }
    raw = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const observed = lstatSync(sidecarPath);
  const divergence = statIdentityDivergence(opened, observed, ["dev", "ino", "size"]);
  if (divergence.length > 0) {
    invalid(
      "INVALID_SIDECAR",
      `Worker proof sidecar changed during read (${divergence.join("; ")})`,
    );
  }
  await assertOwnerPrivatePath(sidecarPath, input.windowsOwnerPrivateAclVerifier, true);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    invalid("INVALID_SIDECAR", "Worker proof sidecar is not JSON");
  }
  validateSidecar(value);
  const publicKeyDer = Buffer.from(value.workerPublicKeySpkiDerBase64, "base64");
  if (value.workerPipePath !== workerPipePath(sidecarPath, value.sidecarId, publicKeyDer)) {
    invalid("INVALID_SIDECAR", "Worker proof sidecar pipe is not derived from its exact path");
  }
  return structuredClone(value);
}

/**
 * Starts the only production key lifecycle in this vertical: the private Ed25519 KeyObject is
 * created after path safety checks, captured only by this process's pipe callback, and has no
 * serialization path. The sidecar/control checks intentionally fail closed on Windows until a
 * real owner-private ACL verifier is wired in by the installer/runtime.
 */
export async function startBridgeWorkerProofLifecycle(input: {
  controlPath: string;
  sidecarPath: string;
  subject: BridgeWorkerProofSubject;
  pid: number;
  windowsOwnerPrivateAclVerifier?: WindowsOwnerPrivateAclVerifier;
  windowsOwnerPrivateAclHardener?: WindowsOwnerPrivateAclHardener;
  healthUpdatedAt?: () => string | null;
  now?: () => string;
}): Promise<BridgeWorkerProofLifecycle> {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    invalid("INVALID_SIDECAR", "Worker proof requires one positive child PID");
  }
  const controlPath = resolve(input.controlPath);
  const sidecarPath = resolve(input.sidecarPath);
  const expectedSidecarName = basename(controlPath).replace(/\.pid\.json$/u, ".worker-proof.json");
  if (
    dirname(controlPath) !== dirname(sidecarPath) ||
    basename(sidecarPath) !== expectedSidecarName
  ) {
    invalid("INVALID_SIDECAR", "Worker sidecar does not match its managed control path");
  }
  validateSubject(input.subject, "INVALID_SIDECAR");
  await assertOwnerPrivatePath(controlPath, input.windowsOwnerPrivateAclVerifier, true);
  await assertOwnerPrivatePath(dirname(sidecarPath), input.windowsOwnerPrivateAclVerifier, false);

  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
  const sidecarId = randomBytes(24).toString("base64url");
  const pipePath = workerPipePath(sidecarPath, sidecarId, publicKeyDer);
  const now = input.now ?? (() => new Date().toISOString());
  let sidecar: BridgeWorkerProofSidecar = {
    schemaVersion: 1,
    kind: "BRIDGE_WORKER_PROOF_SIDECAR",
    sidecarId,
    revision: 1,
    state: "RUNNING",
    subject: structuredClone(input.subject),
    pid: input.pid,
    workerPipePath: pipePath,
    workerPublicKeySpkiDerBase64: publicKeyDer.toString("base64"),
    workerPublicKeySha256: createHash("sha256").update(publicKeyDer).digest("hex"),
    stateUpdatedAt: now(),
  };
  validateSidecar(sidecar);

  let server: Server | null = null;
  try {
    server = await listenWorkerPipe(
      pipePath,
      () => sidecar,
      keyPair.privateKey,
      input.healthUpdatedAt ?? (() => sidecar.stateUpdatedAt),
    );
    atomicWritePublicSidecar(sidecarPath, sidecar);
    await hardenOwnerPrivatePath(sidecarPath, "file", input.windowsOwnerPrivateAclHardener);
    await assertOwnerPrivatePath(sidecarPath, input.windowsOwnerPrivateAclVerifier, true);
  } catch (error) {
    await closeWorkerPipe(server, pipePath);
    throw error;
  }

  return {
    get sidecar() {
      return structuredClone(sidecar);
    },
    async rebindSubject(subject) {
      if (sidecar.state !== "RUNNING") {
        invalid("INVALID_SIDECAR", "A terminal worker sidecar cannot be rebound");
      }
      validateSubject(subject, "INVALID_SIDECAR");
      sidecar = {
        ...sidecar,
        revision: sidecar.revision + 1,
        subject: structuredClone(subject),
        stateUpdatedAt: now(),
      };
      atomicWritePublicSidecar(sidecarPath, sidecar);
      await hardenOwnerPrivatePath(sidecarPath, "file", input.windowsOwnerPrivateAclHardener);
      await assertOwnerPrivatePath(sidecarPath, input.windowsOwnerPrivateAclVerifier, true);
    },
    async close(state) {
      if (sidecar.state === "RUNNING") {
        sidecar = {
          ...sidecar,
          revision: sidecar.revision + 1,
          state,
          pid: null,
          stateUpdatedAt: now(),
        };
        atomicWritePublicSidecar(sidecarPath, sidecar);
        await hardenOwnerPrivatePath(sidecarPath, "file", input.windowsOwnerPrivateAclHardener);
        await assertOwnerPrivatePath(sidecarPath, input.windowsOwnerPrivateAclVerifier, true);
      }
      await closeWorkerPipe(server, pipePath);
      server = null;
    },
  };
}

/** A real Adapter may use this against the exact pipe named by a public-only sidecar. */
export async function challengeBridgeWorker(input: {
  sidecar: BridgeWorkerProofSidecar;
  challengeId: string;
  timeoutMs?: number;
}): Promise<BridgeWorkerProof> {
  validateSidecar(input.sidecar);
  validateChallengeId(input.challengeId, "INVALID_PROOF");
  if (input.sidecar.state !== "RUNNING" || input.sidecar.pid === null) {
    invalid("PIPE_UNAVAILABLE", "The worker sidecar is not running");
  }
  const timeoutMs = input.timeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    invalid("PIPE_PROTOCOL_ERROR", "Worker proof timeout must be a positive integer");
  }
  return new Promise<BridgeWorkerProof>((resolveProof, reject) => {
    const socket = createConnection(input.sidecar.workerPipePath);
    let settled = false;
    let raw = "";
    const finish = (error?: Error, proof?: BridgeWorkerProof) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolveProof(proof!);
    };
    const timeout = setTimeout(
      () => finish(new BridgeWorkerProofError("PIPE_UNAVAILABLE", "Worker proof pipe timed out")),
      timeoutMs,
    );
    timeout.unref?.();
    socket.setEncoding("utf8");
    socket.once("error", () =>
      finish(new BridgeWorkerProofError("PIPE_UNAVAILABLE", "Worker proof pipe is unavailable")),
    );
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
        finish(
          new BridgeWorkerProofError("PIPE_PROTOCOL_ERROR", "Worker proof response is too large"),
        );
        return;
      }
      const newline = raw.indexOf("\n");
      if (newline < 0) return;
      try {
        const proof = parseProofFrame(raw.slice(0, newline));
        finish(undefined, proof);
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new BridgeWorkerProofError("PIPE_PROTOCOL_ERROR", "Invalid worker proof response"),
        );
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: "BRIDGE_WORKER_CHALLENGE",
          challengeId: input.challengeId,
        } satisfies ChallengeRequest)}\n`,
      );
    });
  });
}

/** Verifies a received proof against one sidecar and the caller-owned fresh challenge. */
export function verifyBridgeWorkerProof(input: {
  sidecar: BridgeWorkerProofSidecar;
  challengeId: string;
  proof: BridgeWorkerProof;
}): boolean {
  try {
    validateSidecar(input.sidecar);
    validateChallengeId(input.challengeId, "INVALID_PROOF");
    validateProof(input.proof);
    const { proof, sidecar } = input;
    if (
      sidecar.state !== "RUNNING" ||
      sidecar.pid === null ||
      proof.challengeId !== input.challengeId ||
      proof.sidecarId !== sidecar.sidecarId ||
      proof.sidecarRevision !== sidecar.revision ||
      proof.pid !== sidecar.pid ||
      canonicalJson(proof.subject) !== canonicalJson(sidecar.subject)
    ) {
      return false;
    }
    return verifyBridgeWorkerProofSignature({
      workerPublicKeySpkiDerBase64: sidecar.workerPublicKeySpkiDerBase64,
      proof,
    });
  } catch {
    return false;
  }
}

/** Verifies the self-contained signed worker statement against an already authenticated key. */
export function verifyBridgeWorkerProofSignature(input: {
  workerPublicKeySpkiDerBase64: string;
  proof: BridgeWorkerProof;
}): boolean {
  try {
    validateProof(input.proof);
    const { signatureBase64, ...signed } = input.proof;
    const publicKey = createPublicKey({
      key: Buffer.from(input.workerPublicKeySpkiDerBase64, "base64"),
      format: "der",
      type: "spki",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    return verify(
      null,
      Buffer.from(canonicalJson(signed), "utf8"),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

function workerPipePath(sidecarPath: string, sidecarId: string, publicKeyDer: Buffer): string {
  const digest = createHash("sha256")
    .update(`${resolve(sidecarPath)}\0${sidecarId}\0`, "utf8")
    .update(publicKeyDer)
    .digest("hex");
  if (process.platform === "win32") return `\\\\.\\pipe\\crossagent-worker-proof-${digest}`;
  return `${sidecarPath}.${digest.slice(0, 24)}.sock`;
}

function listenWorkerPipe(
  pipePath: string,
  currentSidecar: () => BridgeWorkerProofSidecar,
  privateKey: KeyObject,
  healthUpdatedAt: () => string | null,
): Promise<Server> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((socket) =>
      handleWorkerConnection(socket, currentSidecar, privateKey, healthUpdatedAt),
    );
    const fail = (_error: Error) => {
      server.close();
      reject(new BridgeWorkerProofError("PIPE_UNAVAILABLE", "Worker proof pipe could not bind"));
    };
    server.once("error", fail);
    server.once("listening", () => {
      server.off("error", fail);
      server.on("error", () => undefined);
      server.unref();
      resolveServer(server);
    });
    server.listen(pipePath);
  });
}

function handleWorkerConnection(
  socket: Socket,
  currentSidecar: () => BridgeWorkerProofSidecar,
  privateKey: KeyObject,
  currentHealthUpdatedAt: () => string | null,
): void {
  let raw = "";
  socket.setEncoding("utf8");
  socket.setTimeout(2_000, () => socket.destroy());
  socket.on("data", (chunk: string) => {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) return socket.destroy();
    const newline = raw.indexOf("\n");
    if (newline < 0) return;
    try {
      const request = parseChallengeFrame(raw.slice(0, newline));
      const sidecar = currentSidecar();
      if (sidecar.state !== "RUNNING" || sidecar.pid === null) return socket.destroy();
      const healthUpdatedAt = currentHealthUpdatedAt();
      if (healthUpdatedAt === null || !isCanonicalIsoTimestamp(healthUpdatedAt)) {
        return socket.destroy();
      }
      const signed = {
        schemaVersion: 1 as const,
        kind: "BRIDGE_WORKER_CHALLENGE_OK" as const,
        challengeId: request.challengeId,
        sidecarId: sidecar.sidecarId,
        sidecarRevision: sidecar.revision,
        subject: structuredClone(sidecar.subject),
        pid: sidecar.pid,
        healthUpdatedAt,
      };
      const signatureBase64 = sign(
        null,
        Buffer.from(canonicalJson(signed), "utf8"),
        privateKey,
      ).toString("base64");
      socket.end(`${JSON.stringify({ ...signed, signatureBase64 } satisfies BridgeWorkerProof)}\n`);
    } catch {
      socket.destroy();
    }
  });
}

function parseChallengeFrame(raw: string): ChallengeRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("PIPE_PROTOCOL_ERROR", "Worker proof request is not JSON");
  }
  const record = strictRecord(
    value,
    ["schemaVersion", "kind", "challengeId"],
    "PIPE_PROTOCOL_ERROR",
  );
  if (record.schemaVersion !== 1 || record.kind !== "BRIDGE_WORKER_CHALLENGE") {
    invalid("PIPE_PROTOCOL_ERROR", "Invalid worker proof request envelope");
  }
  validateChallengeId(record.challengeId, "PIPE_PROTOCOL_ERROR");
  return record as ChallengeRequest;
}

function parseProofFrame(raw: string): BridgeWorkerProof {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("PIPE_PROTOCOL_ERROR", "Worker proof response is not JSON");
  }
  validateProof(value);
  return value as BridgeWorkerProof;
}

function validateSidecar(value: unknown): asserts value is BridgeWorkerProofSidecar {
  assertNoPrivateMaterial(value, "INVALID_SIDECAR");
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "sidecarId",
      "revision",
      "state",
      "subject",
      "pid",
      "workerPipePath",
      "workerPublicKeySpkiDerBase64",
      "workerPublicKeySha256",
      "stateUpdatedAt",
    ],
    "INVALID_SIDECAR",
  );
  if (record.schemaVersion !== 1 || record.kind !== "BRIDGE_WORKER_PROOF_SIDECAR") {
    invalid("INVALID_SIDECAR", "Invalid worker proof sidecar envelope");
  }
  assertIdentifier(record.sidecarId, "sidecarId", "INVALID_SIDECAR");
  assertNonNegativeInteger(record.revision, "revision", "INVALID_SIDECAR");
  if (record.state !== "RUNNING" && record.state !== "EXITED" && record.state !== "STOPPED") {
    invalid("INVALID_SIDECAR", "Invalid worker proof sidecar state");
  }
  validateSubject(record.subject, "INVALID_SIDECAR");
  if (record.state === "RUNNING") assertPositiveInteger(record.pid, "pid", "INVALID_SIDECAR");
  else if (record.pid !== null) invalid("INVALID_SIDECAR", "Terminal sidecar retains a PID");
  if (typeof record.workerPipePath !== "string" || record.workerPipePath.length === 0) {
    invalid("INVALID_SIDECAR", "Invalid worker proof pipe path");
  }
  const publicKeyDer = decodeCanonicalBase64(
    record.workerPublicKeySpkiDerBase64,
    "workerPublicKeySpkiDerBase64",
    128,
    "INVALID_SIDECAR",
  );
  try {
    if (
      createPublicKey({ key: publicKeyDer, format: "der", type: "spki" }).asymmetricKeyType !==
      "ed25519"
    ) {
      invalid("INVALID_SIDECAR", "Worker proof public key is not Ed25519");
    }
  } catch (error) {
    if (error instanceof BridgeWorkerProofError) throw error;
    invalid("INVALID_SIDECAR", "Invalid worker proof public key");
  }
  if (
    typeof record.workerPublicKeySha256 !== "string" ||
    !SHA256.test(record.workerPublicKeySha256) ||
    createHash("sha256").update(publicKeyDer).digest("hex") !== record.workerPublicKeySha256
  ) {
    invalid("INVALID_SIDECAR", "Worker proof fingerprint does not match its public key");
  }
  if (
    typeof record.stateUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.stateUpdatedAt))
  ) {
    invalid("INVALID_SIDECAR", "Invalid worker proof sidecar timestamp");
  }
}

function validateProof(value: unknown): asserts value is BridgeWorkerProof {
  assertNoPrivateMaterial(value, "INVALID_PROOF");
  const record = strictRecord(
    value,
    [
      "schemaVersion",
      "kind",
      "challengeId",
      "sidecarId",
      "sidecarRevision",
      "subject",
      "pid",
      "healthUpdatedAt",
      "signatureBase64",
    ],
    "INVALID_PROOF",
  );
  if (record.schemaVersion !== 1 || record.kind !== "BRIDGE_WORKER_CHALLENGE_OK") {
    invalid("INVALID_PROOF", "Invalid worker proof envelope");
  }
  validateChallengeId(record.challengeId, "INVALID_PROOF");
  assertIdentifier(record.sidecarId, "sidecarId", "INVALID_PROOF");
  assertNonNegativeInteger(record.sidecarRevision, "sidecarRevision", "INVALID_PROOF");
  validateSubject(record.subject, "INVALID_PROOF");
  assertPositiveInteger(record.pid, "pid", "INVALID_PROOF");
  if (
    typeof record.healthUpdatedAt !== "string" ||
    !isCanonicalIsoTimestamp(record.healthUpdatedAt)
  ) {
    invalid("INVALID_PROOF", "Invalid worker proof health timestamp");
  }
  const signature = decodeCanonicalBase64(
    record.signatureBase64,
    "signatureBase64",
    64,
    "INVALID_PROOF",
  );
  if (signature.length !== 64) invalid("INVALID_PROOF", "Invalid Ed25519 signature length");
}

function validateSubject(value: unknown, code: BridgeWorkerProofError["code"]): void {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "originalThreadId")
  ) {
    try {
      assertManagedBridgeIpcSubject(value);
      return;
    } catch {
      invalid(code, "Invalid managed worker proof subject");
    }
  }
  const subject = strictRecord(
    value,
    ["schemaVersion", "projectId", "agentId", "runId", "threadId", "build"],
    code,
  );
  if (subject.schemaVersion !== 1 || subject.agentId !== "codex") {
    invalid(code, "Invalid worker proof subject envelope");
  }
  assertIdentifier(subject.projectId, "subject.projectId", code);
  assertIdentifier(subject.runId, "subject.runId", code);
  if (subject.threadId !== null) assertIdentifier(subject.threadId, "subject.threadId", code);
  const build = strictRecord(
    subject.build,
    ["buildSessionId", "buildId", "migrationId", "protocolId", "manifestSha256"],
    code,
  );
  assertIdentifier(build.buildSessionId, "subject.build.buildSessionId", code);
  for (const field of ["buildId", "migrationId", "protocolId", "manifestSha256"] as const) {
    if (typeof build[field] !== "string" || !SHA256.test(build[field])) {
      invalid(code, `Invalid worker proof ${field}`);
    }
  }
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function atomicWritePublicSidecar(path: string, value: BridgeWorkerProofSidecar): void {
  validateSidecar(value);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const temporary = `${path}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

async function assertOwnerPrivatePath(
  path: string,
  windowsOwnerPrivateAclVerifier: WindowsOwnerPrivateAclVerifier | undefined,
  requireRegularFile: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    if (!windowsOwnerPrivateAclVerifier) {
      invalid(
        "WINDOWS_ACL_VERIFIER_UNAVAILABLE",
        "Worker proof activation requires a real Windows owner-private ACL verifier",
      );
    }
    if (!(await windowsOwnerPrivateAclVerifier(path))) {
      invalid("PATH_NOT_OWNER_PRIVATE", "Worker proof path is not owner-private");
    }
    return;
  }
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch {
    invalid("PATH_NOT_OWNER_PRIVATE", "Worker proof path is unavailable");
  }
  if (
    metadata.isSymbolicLink() ||
    (requireRegularFile ? !metadata.isFile() : !metadata.isDirectory())
  ) {
    invalid("PATH_NOT_OWNER_PRIVATE", "Worker proof path is not a private regular path");
  }
  if ((metadata.mode & 0o077) !== 0) {
    invalid("PATH_NOT_OWNER_PRIVATE", "Worker proof path is not owner-private");
  }
}

async function hardenOwnerPrivatePath(
  path: string,
  kind: "directory" | "file",
  windowsOwnerPrivateAclHardener: WindowsOwnerPrivateAclHardener | undefined,
): Promise<void> {
  if (process.platform !== "win32") return;
  if (!windowsOwnerPrivateAclHardener) {
    invalid(
      "WINDOWS_ACL_VERIFIER_UNAVAILABLE",
      "Worker proof activation requires a real Windows owner-private ACL hardener",
    );
  }
  if (!(await windowsOwnerPrivateAclHardener(path, kind))) {
    invalid("PATH_NOT_OWNER_PRIVATE", "Worker proof path ACL could not be hardened");
  }
}

async function closeWorkerPipe(server: Server | null, pipePath: string): Promise<void> {
  if (server) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  if (process.platform !== "win32" && existsSync(pipePath)) {
    try {
      if (lstatSync(pipePath).isSocket()) unlinkSync(pipePath);
    } catch {
      // A crash/replacement may remove the socket between the check and unlink. It has no key data.
    }
  }
}

function decodeCanonicalBase64(
  value: unknown,
  path: string,
  maxBytes: number,
  code: BridgeWorkerProofError["code"],
): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) {
    invalid(code, `Invalid ${path}`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) {
    invalid(code, `Invalid ${path}`);
  }
  return bytes;
}

function assertNoPrivateMaterial(value: unknown, code: BridgeWorkerProofError["code"]): void {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: "value", depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > MAX_SCAN_NODES || current.depth > MAX_SCAN_DEPTH) {
      invalid(code, "Worker proof object exceeds bounded private-material scan limits");
    }
    if (
      typeof current.value === "string" &&
      /(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bPKCS#?8\b|\bcanary\b)/iu.test(current.value)
    ) {
      invalid(code, `Private worker proof material is forbidden: ${current.path}`);
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    for (const [key, nested] of Object.entries(current.value)) {
      const normalized = key.replaceAll(/[_-]/g, "").toLowerCase();
      if (["private", "pkcs8", "secret", "canary"].some((part) => normalized.includes(part))) {
        invalid(code, `Private-shaped worker proof field is forbidden: ${current.path}.${key}`);
      }
      pending.push({ value: nested, path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
  }
}

function strictRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: BridgeWorkerProofError["code"],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(code, "Expected an exact worker proof object");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code, "Worker proof object has unexpected fields");
  }
  return record;
}

function validateChallengeId(value: unknown, code: BridgeWorkerProofError["code"]): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    invalid(code, "Worker proof challenge must be a SHA-256 hex value");
  }
}

function assertIdentifier(
  value: unknown,
  path: string,
  code: BridgeWorkerProofError["code"],
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    [...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point < 32 || point === 127;
    })
  ) {
    invalid(code, `Invalid worker proof ${path}`);
  }
}

function assertPositiveInteger(
  value: unknown,
  path: string,
  code: BridgeWorkerProofError["code"],
): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    invalid(code, `Invalid worker proof ${path}`);
}

function assertNonNegativeInteger(
  value: unknown,
  path: string,
  code: BridgeWorkerProofError["code"],
): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalid(code, `Invalid worker proof ${path}`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function invalid(code: BridgeWorkerProofError["code"], message: string): never {
  throw new BridgeWorkerProofError(code, message);
}
