import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const IMMUTABLE_DIRECTORY_MODE = 0o500;
const IMMUTABLE_FILE_MODE = 0o400;
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_ID_PATTERN = /^rel_[A-Za-z0-9_-]{1,120}$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReleaseContentIdentity = {
  buildId: string;
  buildSessionId: string;
  protocolId: string;
  migrationId: string;
  manifestSha256: string;
};

/** The canonical immutable root containing the verified exact five-part release identity. */
export type ReleaseDescriptor = ReleaseContentIdentity & {
  releaseRoot: string;
};

export interface ReleaseContentVerifier {
  /**
   * Verify the complete release contents rooted at `releaseRoot` and return the identity derived
   * from those bytes. Implementations must not trust a descriptor stored beside the release.
   */
  verify(releaseRoot: string): Promise<ReleaseContentIdentity>;
}

export interface ReleaseLayoutLease {
  /** Cross-process exclusive lease. Implementations must not run two callbacks concurrently. */
  withLease<T>(input: { leaseName: string; ownerId: string }, work: () => Promise<T>): Promise<T>;
}

export type CurrentReleasePointer = {
  schemaVersion: 1;
  revision: number;
  operationId: string;
  descriptor: ReleaseDescriptor;
  updatedAt: string;
};

export type ReleaseOperationRequest = {
  operationId: string;
  expectedCurrentRevision: number | null;
  candidate: ReleaseDescriptor;
};

export type ReleaseOperationHandle = {
  operationId: string;
  operationRevision: number;
  ownerId: string;
  requestFingerprint: string;
};

export type ReleaseOperationRecord = {
  schemaVersion: 1;
  revision: number;
  operationRevision: number;
  operationId: string;
  ownerId: string;
  requestFingerprint: string;
  expectedCurrentRevision: number | null;
  candidate: ReleaseDescriptor;
  state: "ACTIVE" | "COMPLETED";
  activatedPointerRevision: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ReleaseLayoutErrorCode =
  | "DATA_DIR_INVALID"
  | "UNSAFE_DATA_DIR"
  | "DESCRIPTOR_INVALID"
  | "RELEASE_ROOT_MISMATCH"
  | "UNSAFE_RELEASE_TREE"
  | "CONTENT_VERIFICATION_FAILED"
  | "CONTENT_IDENTITY_MISMATCH"
  | "OPERATION_INVALID"
  | "ACTIVE_OPERATION_EXISTS"
  | "STALE_OPERATION"
  | "STALE_POINTER_REVISION"
  | "OPERATION_NOT_ACTIVATED"
  | "POINTER_CORRUPT"
  | "OPERATION_CORRUPT"
  | "CONTROL_FILE_UNSAFE"
  | "DURABILITY_FAILED";

export class ReleaseLayoutError extends Error {
  constructor(
    readonly code: ReleaseLayoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReleaseLayoutError";
  }
}

export type ReleaseLayoutOptions = {
  dataDir: string;
  ownerId: string;
  lease: ReleaseLayoutLease;
  verifier: ReleaseContentVerifier;
  now?: () => string;
};

type MaterializeRelease = (stagingRoot: string) => Promise<void>;

export class ReleaseLayout {
  private readonly dataDir: string;
  private readonly releasesDir: string;
  private readonly currentPointerPath: string;
  private readonly operationPath: string;
  private readonly ownerId: string;
  private readonly lease: ReleaseLayoutLease;
  private readonly verifier: ReleaseContentVerifier;
  private readonly now: () => string;
  private readonly leaseName: string;

  constructor(options: ReleaseLayoutOptions) {
    assertPlainExactObject(options, ["dataDir", "ownerId", "lease", "verifier", "now"], {
      code: "DATA_DIR_INVALID",
      allowMissing: ["now"],
    });
    if (typeof options.dataDir !== "string" || !isAbsolute(options.dataDir)) {
      throw new ReleaseLayoutError("DATA_DIR_INVALID", "dataDir must be an absolute path");
    }
    if (resolve(options.dataDir) !== options.dataDir) {
      throw new ReleaseLayoutError("DATA_DIR_INVALID", "dataDir must be canonical");
    }
    if (!OWNER_ID_PATTERN.test(options.ownerId)) {
      throw new ReleaseLayoutError("DATA_DIR_INVALID", "ownerId is invalid");
    }
    if (!options.lease || typeof options.lease.withLease !== "function") {
      throw new ReleaseLayoutError("DATA_DIR_INVALID", "a cross-process lease Adapter is required");
    }
    if (!options.verifier || typeof options.verifier.verify !== "function") {
      throw new ReleaseLayoutError("DATA_DIR_INVALID", "a content verifier Adapter is required");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new ReleaseLayoutError("DATA_DIR_INVALID", "now must be a function");
    }
    this.dataDir = options.dataDir;
    this.releasesDir = join(this.dataDir, "releases");
    this.currentPointerPath = join(this.dataDir, "current-release.json");
    this.operationPath = join(this.dataDir, "release-operation.json");
    this.ownerId = options.ownerId;
    this.lease = options.lease;
    this.verifier = options.verifier;
    this.now = options.now ?? (() => new Date().toISOString());
    this.leaseName = `release-layout:${createHash("sha256").update(this.dataDir).digest("hex")}`;
  }

  releaseRoot(buildSessionId: string): string {
    assertBuildSessionId(buildSessionId, "DESCRIPTOR_INVALID");
    return join(this.releasesDir, buildSessionId);
  }

  async createRelease(
    descriptor: ReleaseDescriptor,
    materialize: MaterializeRelease,
  ): Promise<ReleaseDescriptor> {
    this.validateDescriptor(descriptor);
    if (typeof materialize !== "function") {
      throw new ReleaseLayoutError("DESCRIPTOR_INVALID", "materialize must be a function");
    }
    return this.withLease(async () => {
      this.ensureLayout();
      const finalRoot = this.releaseRoot(descriptor.buildSessionId);
      if (existsSync(finalRoot)) {
        return this.verifyReleaseUnlocked(descriptor);
      }

      const stagingRoot = join(
        this.releasesDir,
        `.${descriptor.buildSessionId}.${safeFilePart(this.ownerId)}.${randomBytes(12).toString("hex")}.tmp`,
      );
      mkdirSync(stagingRoot, { mode: PRIVATE_DIRECTORY_MODE });
      try {
        await materialize(stagingRoot);
        assertSafeTree(stagingRoot, "UNSAFE_RELEASE_TREE", false);
        await this.verifyIdentityAt(stagingRoot, descriptor);
        sealImmutableTree(stagingRoot);
        if (existsSync(finalRoot)) {
          await this.verifyReleaseUnlocked(descriptor);
          makeTreeWritable(stagingRoot);
          rmSync(stagingRoot, { recursive: true, force: true });
          return descriptor;
        }
        renameSync(stagingRoot, finalRoot);
        fsyncDirectory(this.releasesDir);
        return this.verifyReleaseUnlocked(descriptor);
      } catch (error) {
        if (existsSync(stagingRoot)) {
          makeTreeWritable(stagingRoot);
          rmSync(stagingRoot, { recursive: true, force: true });
        }
        throw error;
      }
    });
  }

  async verifyRelease(descriptor: ReleaseDescriptor): Promise<ReleaseDescriptor> {
    this.validateDescriptor(descriptor);
    return this.withLease(async () => {
      this.ensureLayout();
      return this.verifyReleaseUnlocked(descriptor);
    });
  }

  async readCurrent(): Promise<CurrentReleasePointer | null> {
    return this.withLease(async () => {
      this.ensureLayout();
      const pointer = this.readCurrentRecord();
      if (pointer) await this.verifyReleaseUnlocked(pointer.descriptor);
      return pointer;
    });
  }

  async readOperation(): Promise<ReleaseOperationRecord | null> {
    return this.withLease(async () => {
      this.ensureLayout();
      const operation = this.readOperationRecord();
      if (operation) await this.verifyReleaseUnlocked(operation.candidate);
      return operation;
    });
  }

  async beginOperation(request: ReleaseOperationRequest): Promise<ReleaseOperationHandle> {
    this.validateOperationRequest(request);
    return this.withLease(async () => {
      this.ensureLayout();
      await this.verifyReleaseUnlocked(request.candidate);
      const fingerprint = requestFingerprint(request);
      const existing = this.readOperationRecord();
      if (
        existing &&
        existing.operationId === request.operationId &&
        existing.ownerId === this.ownerId &&
        existing.requestFingerprint === fingerprint
      ) {
        return handleFor(existing);
      }
      if (existing?.state === "ACTIVE") {
        throw new ReleaseLayoutError(
          "ACTIVE_OPERATION_EXISTS",
          `release operation ${existing.operationId} is already active`,
        );
      }

      const current = this.readCurrentRecord();
      if (current) await this.verifyReleaseUnlocked(current.descriptor);
      assertExpectedPointerRevision(current, request.expectedCurrentRevision);
      const now = this.timestamp();
      const record: ReleaseOperationRecord = {
        schemaVersion: 1,
        revision: (existing?.revision ?? 0) + 1,
        operationRevision: (existing?.operationRevision ?? 0) + 1,
        operationId: request.operationId,
        ownerId: this.ownerId,
        requestFingerprint: fingerprint,
        expectedCurrentRevision: request.expectedCurrentRevision,
        candidate: cloneDescriptor(request.candidate),
        state: "ACTIVE",
        activatedPointerRevision: null,
        createdAt: now,
        updatedAt: now,
      };
      this.writeControlFile(this.operationPath, record);
      return handleFor(record);
    });
  }

  async activate(handle: ReleaseOperationHandle): Promise<CurrentReleasePointer> {
    validateHandle(handle);
    return this.withLease(async () => {
      this.ensureLayout();
      const operation = this.requireOperation(handle);
      await this.verifyReleaseUnlocked(operation.candidate);
      const current = this.readCurrentRecord();
      if (current) await this.verifyReleaseUnlocked(current.descriptor);
      const intendedRevision = (operation.expectedCurrentRevision ?? 0) + 1;
      if (
        current &&
        current.operationId === operation.operationId &&
        current.revision === intendedRevision &&
        sameDescriptor(current.descriptor, operation.candidate)
      ) {
        return current;
      }
      if (operation.state !== "ACTIVE") {
        throw new ReleaseLayoutError(
          "STALE_OPERATION",
          "completed operation does not own the current pointer",
        );
      }
      assertExpectedPointerRevision(current, operation.expectedCurrentRevision);
      const pointer: CurrentReleasePointer = {
        schemaVersion: 1,
        revision: intendedRevision,
        operationId: operation.operationId,
        descriptor: cloneDescriptor(operation.candidate),
        updatedAt: this.timestamp(),
      };
      this.writeControlFile(this.currentPointerPath, pointer);
      return pointer;
    });
  }

  async complete(handle: ReleaseOperationHandle): Promise<ReleaseOperationRecord> {
    validateHandle(handle);
    return this.withLease(async () => {
      this.ensureLayout();
      const operation = this.requireOperation(handle);
      if (operation.state === "COMPLETED") return operation;
      const current = this.readCurrentRecord();
      if (
        !current ||
        current.operationId !== operation.operationId ||
        current.revision !== (operation.expectedCurrentRevision ?? 0) + 1 ||
        !sameDescriptor(current.descriptor, operation.candidate)
      ) {
        throw new ReleaseLayoutError(
          "OPERATION_NOT_ACTIVATED",
          "operation cannot complete without its exact current pointer",
        );
      }
      await this.verifyReleaseUnlocked(current.descriptor);
      const completed: ReleaseOperationRecord = {
        ...operation,
        revision: operation.revision + 1,
        state: "COMPLETED",
        activatedPointerRevision: current.revision,
        updatedAt: this.timestamp(),
      };
      this.writeControlFile(this.operationPath, completed);
      return completed;
    });
  }

  private async withLease<T>(work: () => Promise<T>): Promise<T> {
    return this.lease.withLease({ leaseName: this.leaseName, ownerId: this.ownerId }, work);
  }

  private ensureLayout(): void {
    ensurePrivateDirectory(this.dataDir, "UNSAFE_DATA_DIR");
    ensurePrivateDirectory(this.releasesDir, "UNSAFE_DATA_DIR");
    assertControlFileSafeIfPresent(this.currentPointerPath);
    assertControlFileSafeIfPresent(this.operationPath);
  }

  private validateDescriptor(descriptor: ReleaseDescriptor): void {
    assertPlainExactObject(
      descriptor,
      ["buildId", "buildSessionId", "protocolId", "migrationId", "manifestSha256", "releaseRoot"],
      { code: "DESCRIPTOR_INVALID" },
    );
    assertSha256(descriptor.buildId, "buildId", "DESCRIPTOR_INVALID");
    assertBuildSessionId(descriptor.buildSessionId, "DESCRIPTOR_INVALID");
    assertSha256(descriptor.protocolId, "protocolId", "DESCRIPTOR_INVALID");
    assertSha256(descriptor.migrationId, "migrationId", "DESCRIPTOR_INVALID");
    assertSha256(descriptor.manifestSha256, "manifestSha256", "DESCRIPTOR_INVALID");
    if (typeof descriptor.releaseRoot !== "string" || !isAbsolute(descriptor.releaseRoot)) {
      throw new ReleaseLayoutError("DESCRIPTOR_INVALID", "releaseRoot must be absolute");
    }
    const expected = this.releaseRoot(descriptor.buildSessionId);
    if (descriptor.releaseRoot !== expected || resolve(descriptor.releaseRoot) !== expected) {
      throw new ReleaseLayoutError(
        "RELEASE_ROOT_MISMATCH",
        "releaseRoot must be the exact releases/buildSessionId root",
      );
    }
  }

  private validateOperationRequest(request: ReleaseOperationRequest): void {
    assertPlainExactObject(request, ["operationId", "expectedCurrentRevision", "candidate"], {
      code: "OPERATION_INVALID",
    });
    if (
      typeof request.operationId !== "string" ||
      !OPERATION_ID_PATTERN.test(request.operationId)
    ) {
      throw new ReleaseLayoutError("OPERATION_INVALID", "operationId is invalid");
    }
    if (
      request.expectedCurrentRevision !== null &&
      (!Number.isSafeInteger(request.expectedCurrentRevision) ||
        request.expectedCurrentRevision < 1)
    ) {
      throw new ReleaseLayoutError("OPERATION_INVALID", "expectedCurrentRevision is invalid");
    }
    try {
      this.validateDescriptor(request.candidate);
    } catch (error) {
      if (error instanceof ReleaseLayoutError) {
        throw new ReleaseLayoutError("OPERATION_INVALID", error.message);
      }
      throw error;
    }
  }

  private async verifyReleaseUnlocked(descriptor: ReleaseDescriptor): Promise<ReleaseDescriptor> {
    this.validateDescriptor(descriptor);
    if (!existsSync(descriptor.releaseRoot)) {
      throw new ReleaseLayoutError(
        "CONTENT_VERIFICATION_FAILED",
        "immutable release root does not exist",
      );
    }
    assertSafeTree(descriptor.releaseRoot, "UNSAFE_RELEASE_TREE", true);
    await this.verifyIdentityAt(descriptor.releaseRoot, descriptor);
    return cloneDescriptor(descriptor);
  }

  private async verifyIdentityAt(root: string, descriptor: ReleaseDescriptor): Promise<void> {
    let observed: ReleaseContentIdentity;
    try {
      observed = await this.verifier.verify(root);
    } catch {
      throw new ReleaseLayoutError(
        "CONTENT_VERIFICATION_FAILED",
        "release content verification failed",
      );
    }
    try {
      validateContentIdentity(observed);
    } catch {
      throw new ReleaseLayoutError(
        "CONTENT_VERIFICATION_FAILED",
        "release content verifier returned invalid metadata",
      );
    }
    if (!sameReleaseIdentity(observed, descriptor)) {
      throw new ReleaseLayoutError(
        "CONTENT_IDENTITY_MISMATCH",
        "verified release identity does not match the descriptor",
      );
    }
  }

  private readCurrentRecord(): CurrentReleasePointer | null {
    if (!existsSync(this.currentPointerPath)) return null;
    const value = readJsonControlFile(this.currentPointerPath, "POINTER_CORRUPT");
    try {
      assertPlainExactObject(
        value,
        ["schemaVersion", "revision", "operationId", "descriptor", "updatedAt"],
        { code: "POINTER_CORRUPT" },
      );
      if (value.schemaVersion !== 1) throw new Error("schemaVersion");
      assertPositiveInteger(value.revision, "revision");
      if (typeof value.operationId !== "string" || !OPERATION_ID_PATTERN.test(value.operationId)) {
        throw new Error("operationId");
      }
      this.validateDescriptor(value.descriptor as ReleaseDescriptor);
      assertTimestamp(value.updatedAt);
      return {
        schemaVersion: 1,
        revision: value.revision as number,
        operationId: value.operationId,
        descriptor: cloneDescriptor(value.descriptor as ReleaseDescriptor),
        updatedAt: value.updatedAt as string,
      };
    } catch (error) {
      if (error instanceof ReleaseLayoutError && error.code === "CONTROL_FILE_UNSAFE") throw error;
      throw new ReleaseLayoutError("POINTER_CORRUPT", "current release pointer is corrupt");
    }
  }

  private readOperationRecord(): ReleaseOperationRecord | null {
    if (!existsSync(this.operationPath)) return null;
    const value = readJsonControlFile(this.operationPath, "OPERATION_CORRUPT");
    try {
      assertPlainExactObject(
        value,
        [
          "schemaVersion",
          "revision",
          "operationRevision",
          "operationId",
          "ownerId",
          "requestFingerprint",
          "expectedCurrentRevision",
          "candidate",
          "state",
          "activatedPointerRevision",
          "createdAt",
          "updatedAt",
        ],
        { code: "OPERATION_CORRUPT" },
      );
      if (value.schemaVersion !== 1) throw new Error("schemaVersion");
      assertPositiveInteger(value.revision, "revision");
      assertPositiveInteger(value.operationRevision, "operationRevision");
      if (typeof value.operationId !== "string" || !OPERATION_ID_PATTERN.test(value.operationId)) {
        throw new Error("operationId");
      }
      if (typeof value.ownerId !== "string" || !OWNER_ID_PATTERN.test(value.ownerId)) {
        throw new Error("ownerId");
      }
      assertSha256(value.requestFingerprint, "requestFingerprint", "OPERATION_CORRUPT");
      const expectedCurrentRevision = value.expectedCurrentRevision;
      if (
        expectedCurrentRevision !== null &&
        (typeof expectedCurrentRevision !== "number" ||
          !Number.isSafeInteger(expectedCurrentRevision) ||
          expectedCurrentRevision < 1)
      ) {
        throw new Error("expectedCurrentRevision");
      }
      this.validateDescriptor(value.candidate as ReleaseDescriptor);
      if (value.state !== "ACTIVE" && value.state !== "COMPLETED") throw new Error("state");
      const activatedPointerRevision = value.activatedPointerRevision;
      if (
        activatedPointerRevision !== null &&
        (typeof activatedPointerRevision !== "number" ||
          !Number.isSafeInteger(activatedPointerRevision) ||
          activatedPointerRevision < 1)
      ) {
        throw new Error("activatedPointerRevision");
      }
      if (value.state === "ACTIVE" && value.activatedPointerRevision !== null) {
        throw new Error("active operation has activation receipt");
      }
      if (value.state === "COMPLETED" && value.activatedPointerRevision === null) {
        throw new Error("completed operation lacks activation receipt");
      }
      assertTimestamp(value.createdAt);
      assertTimestamp(value.updatedAt);
      const record: ReleaseOperationRecord = {
        schemaVersion: 1,
        revision: value.revision as number,
        operationRevision: value.operationRevision as number,
        operationId: value.operationId,
        ownerId: value.ownerId,
        requestFingerprint: value.requestFingerprint,
        expectedCurrentRevision: value.expectedCurrentRevision as number | null,
        candidate: cloneDescriptor(value.candidate as ReleaseDescriptor),
        state: value.state,
        activatedPointerRevision: value.activatedPointerRevision as number | null,
        createdAt: value.createdAt as string,
        updatedAt: value.updatedAt as string,
      };
      if (
        requestFingerprint({
          operationId: record.operationId,
          expectedCurrentRevision: record.expectedCurrentRevision,
          candidate: record.candidate,
        }) !== record.requestFingerprint
      ) {
        throw new Error("request fingerprint mismatch");
      }
      return record;
    } catch (error) {
      if (error instanceof ReleaseLayoutError && error.code === "CONTROL_FILE_UNSAFE") throw error;
      throw new ReleaseLayoutError("OPERATION_CORRUPT", "release operation record is corrupt");
    }
  }

  private requireOperation(handle: ReleaseOperationHandle): ReleaseOperationRecord {
    const operation = this.readOperationRecord();
    if (
      !operation ||
      operation.operationId !== handle.operationId ||
      operation.operationRevision !== handle.operationRevision ||
      operation.ownerId !== handle.ownerId ||
      operation.requestFingerprint !== handle.requestFingerprint ||
      operation.ownerId !== this.ownerId
    ) {
      throw new ReleaseLayoutError("STALE_OPERATION", "operation handle is stale or forged");
    }
    return operation;
  }

  private writeControlFile(path: string, value: unknown): void {
    assertControlFileSafeIfPresent(path);
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload) > MAX_CONTROL_FILE_BYTES) {
      throw new ReleaseLayoutError("DURABILITY_FAILED", "control file exceeds size limit");
    }
    const tempPath = join(
      dirname(path),
      `.${basename(path)}.${safeFilePart(this.ownerId)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    let file: number | null = null;
    try {
      file = openSync(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        PRIVATE_FILE_MODE,
      );
      writeFileSync(file, payload, "utf8");
      fsyncSync(file);
      closeSync(file);
      file = null;
      renameSync(tempPath, path);
      chmodSync(path, PRIVATE_FILE_MODE);
      fsyncDirectory(dirname(path));
    } catch {
      if (file !== null) closeSync(file);
      if (existsSync(tempPath)) rmSync(tempPath, { force: true });
      throw new ReleaseLayoutError("DURABILITY_FAILED", "durable control-file update failed");
    }
  }

  private timestamp(): string {
    const value = this.now();
    assertTimestamp(value);
    return value;
  }
}

function handleFor(record: ReleaseOperationRecord): ReleaseOperationHandle {
  return {
    operationId: record.operationId,
    operationRevision: record.operationRevision,
    ownerId: record.ownerId,
    requestFingerprint: record.requestFingerprint,
  };
}

function validateHandle(handle: ReleaseOperationHandle): void {
  assertPlainExactObject(
    handle,
    ["operationId", "operationRevision", "ownerId", "requestFingerprint"],
    { code: "OPERATION_INVALID" },
  );
  if (typeof handle.operationId !== "string" || !OPERATION_ID_PATTERN.test(handle.operationId)) {
    throw new ReleaseLayoutError("OPERATION_INVALID", "operation handle id is invalid");
  }
  assertPositiveInteger(handle.operationRevision, "operationRevision");
  if (typeof handle.ownerId !== "string" || !OWNER_ID_PATTERN.test(handle.ownerId)) {
    throw new ReleaseLayoutError("OPERATION_INVALID", "operation handle owner is invalid");
  }
  assertSha256(handle.requestFingerprint, "requestFingerprint", "OPERATION_INVALID");
}

function requestFingerprint(request: ReleaseOperationRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operationId: request.operationId,
        expectedCurrentRevision: request.expectedCurrentRevision,
        candidate: cloneDescriptor(request.candidate),
      }),
    )
    .digest("hex");
}

function cloneDescriptor(descriptor: ReleaseDescriptor): ReleaseDescriptor {
  return {
    buildId: descriptor.buildId,
    buildSessionId: descriptor.buildSessionId,
    protocolId: descriptor.protocolId,
    migrationId: descriptor.migrationId,
    manifestSha256: descriptor.manifestSha256,
    releaseRoot: descriptor.releaseRoot,
  };
}

function sameDescriptor(left: ReleaseDescriptor, right: ReleaseDescriptor): boolean {
  return sameReleaseIdentity(left, right) && left.releaseRoot === right.releaseRoot;
}

function sameReleaseIdentity(left: ReleaseContentIdentity, right: ReleaseContentIdentity): boolean {
  return (
    left.buildId === right.buildId &&
    left.buildSessionId === right.buildSessionId &&
    left.protocolId === right.protocolId &&
    left.migrationId === right.migrationId &&
    left.manifestSha256 === right.manifestSha256
  );
}

function validateContentIdentity(identity: ReleaseContentIdentity): void {
  assertPlainExactObject(
    identity,
    ["buildId", "buildSessionId", "protocolId", "migrationId", "manifestSha256"],
    {
      code: "CONTENT_VERIFICATION_FAILED",
    },
  );
  assertSha256(identity.buildId, "buildId", "CONTENT_VERIFICATION_FAILED");
  assertBuildSessionId(identity.buildSessionId, "CONTENT_VERIFICATION_FAILED");
  assertSha256(identity.protocolId, "protocolId", "CONTENT_VERIFICATION_FAILED");
  assertSha256(identity.migrationId, "migrationId", "CONTENT_VERIFICATION_FAILED");
  assertSha256(identity.manifestSha256, "manifestSha256", "CONTENT_VERIFICATION_FAILED");
}

function assertExpectedPointerRevision(
  current: CurrentReleasePointer | null,
  expected: number | null,
): void {
  if ((current?.revision ?? null) !== expected) {
    throw new ReleaseLayoutError(
      "STALE_POINTER_REVISION",
      "current release pointer revision changed",
    );
  }
}

function ensurePrivateDirectory(path: string, code: ReleaseLayoutErrorCode): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ReleaseLayoutError(code, "managed directory cannot be inspected");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ReleaseLayoutError(code, "managed directory must be a real directory");
  }
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function assertControlFileSafeIfPresent(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CONTROL_FILE_BYTES) {
    throw new ReleaseLayoutError(
      "CONTROL_FILE_UNSAFE",
      "control file must be a bounded regular file",
    );
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new ReleaseLayoutError("CONTROL_FILE_UNSAFE", "control file is not owner-private");
  }
}

function readJsonControlFile(
  path: string,
  code: "POINTER_CORRUPT" | "OPERATION_CORRUPT",
): Record<string, unknown> {
  assertControlFileSafeIfPresent(path);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) throw new Error("not object");
    return parsed;
  } catch (error) {
    if (error instanceof ReleaseLayoutError) throw error;
    throw new ReleaseLayoutError(code, "control file contains invalid JSON");
  }
}

function assertSafeTree(
  root: string,
  code: ReleaseLayoutErrorCode,
  requireImmutable: boolean,
): void {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ReleaseLayoutError(code, "release root must be a real directory");
  }
  if (
    requireImmutable &&
    process.platform !== "win32" &&
    (rootStat.mode & 0o777) !== IMMUTABLE_DIRECTORY_MODE
  ) {
    throw new ReleaseLayoutError(code, "release root is not owner-private and immutable");
  }
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === "." || name === ".." || name.includes("\0")) {
        throw new ReleaseLayoutError(code, "release tree contains an unsafe path");
      }
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new ReleaseLayoutError(code, "release tree contains a symbolic link");
      }
      if (stat.isDirectory()) {
        if (
          requireImmutable &&
          process.platform !== "win32" &&
          (stat.mode & 0o777) !== IMMUTABLE_DIRECTORY_MODE
        ) {
          throw new ReleaseLayoutError(code, "release directory is not immutable");
        }
        visit(path);
      } else if (!stat.isFile()) {
        throw new ReleaseLayoutError(code, "release tree contains a non-regular entry");
      } else if (
        requireImmutable &&
        process.platform !== "win32" &&
        (stat.mode & 0o777) !== IMMUTABLE_FILE_MODE
      ) {
        throw new ReleaseLayoutError(code, "release file is not immutable");
      }
    }
  };
  visit(root);
}

function sealImmutableTree(root: string): void {
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
        chmodSync(path, IMMUTABLE_DIRECTORY_MODE);
      } else {
        chmodSync(path, IMMUTABLE_FILE_MODE);
      }
    }
  };
  visit(root);
  chmodSync(root, IMMUTABLE_DIRECTORY_MODE);
}

function makeTreeWritable(root: string): void {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  chmodSync(root, PRIVATE_DIRECTORY_MODE);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const entry = lstatSync(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeTreeWritable(path);
    else if (!entry.isSymbolicLink()) chmodSync(path, PRIVATE_FILE_MODE);
  }
}

function fsyncDirectory(path: string): void {
  let directory: number | null = null;
  try {
    directory = openSync(path, constants.O_RDONLY);
    fsyncSync(directory);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") throw error;
  } finally {
    if (directory !== null) closeSync(directory);
  }
}

function assertPlainExactObject(
  value: unknown,
  keys: readonly string[],
  options: { code: ReleaseLayoutErrorCode; allowMissing?: readonly string[] },
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ReleaseLayoutError(options.code, "metadata must be a plain object");
  }
  const actual = Object.keys(value).sort();
  const allowed = [...keys].sort();
  if (actual.some((key) => !allowed.includes(key))) {
    throw new ReleaseLayoutError(options.code, "metadata contains an unrecognized field");
  }
  const optional = new Set(options.allowMissing ?? []);
  if (allowed.some((key) => !optional.has(key) && !actual.includes(key))) {
    throw new ReleaseLayoutError(options.code, "metadata is missing a required field");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function assertSha256(
  value: unknown,
  name: string,
  code: ReleaseLayoutErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new ReleaseLayoutError(code, `${name} must be a lowercase SHA-256`);
  }
}

function assertBuildSessionId(
  value: unknown,
  code: ReleaseLayoutErrorCode,
): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ReleaseLayoutError(code, "buildSessionId must be a UUID");
  }
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("timestamp must be canonical ISO-8601 UTC");
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
