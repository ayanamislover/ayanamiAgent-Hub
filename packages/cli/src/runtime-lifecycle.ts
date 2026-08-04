import { createHash, randomBytes } from "node:crypto";
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
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { statIdentityDivergence } from "./stat-divergence.js";
import {
  parseCodexSessionOperationalCheckpoint,
  parseCodexSessionTicketVaultSnapshot,
} from "@crossagent/codex-bridge";
import {
  assertManagedBridgeIpcSubject,
  managedBridgeActiveSubjectKey,
  type ManagedBridgeBuildIdentity,
  type ManagedBridgeIpcSubject,
} from "./managed-bridge-ipc.js";
import {
  challengeBridgeWorker,
  readBridgeWorkerProofSidecar,
  type BridgeWorkerProofSidecar,
  type WindowsOwnerPrivateAclHardener,
  type WindowsOwnerPrivateAclVerifier,
} from "./bridge-worker-proof.js";
import {
  codexBridgeRunFiles,
  readCodexBridgeRunBuildIdentity,
  readCodexBridgeRunPid,
  startCodexBridgeProcess,
  stopCodexBridgeProcess,
} from "./bridge-process-manager.js";
import {
  type ManagedBridgeRuntimeAdapter,
  type ManagedBridgeRuntimeCommand,
  type ManagedBridgeRuntimeCommandJournal,
  type ManagedBridgeRuntimeCommandStore,
  type ManagedBridgeRuntimeDesiredRecord,
  type ManagedBridgeRuntimeEffectReceipt,
  type ManagedBridgeRuntimeLease,
  type ManagedBridgeRuntimeLeaseFence,
  type ManagedBridgeRuntimeSidecar,
  type ManagedBridgeRuntimeStopReceipt,
} from "./managed-bridge-runtime.js";

const MAX_RUNTIME_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_STATE_FILE_BYTES = 1024 * 1024;
const MAX_RUNTIME_REGISTRATIONS = 1_024;
const MAX_RUNTIME_COMMANDS = 1_024;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 10;
const ABANDONED_LOCK_MS = 30_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256 = /^[a-f0-9]{64}$/u;

type PrivateFileObservation = {
  bytes: Buffer;
  sha256: string;
};

/**
 * Seals the exact post-registration recovery identity into the public worker proof subject.
 * Raw ticket material is parsed only to prove its binding and never leaves this Module.
 */
export async function sealManagedBridgeRuntimeSubjectFromFiles(input: {
  projectId: string;
  originalThreadId: string;
  runId: string;
  sessionId: string;
  build: ManagedBridgeBuildIdentity;
  fuseGeneration: number;
  vaultPath: string;
  checkpointPath: string;
  windowsOwnerPrivateAclVerifier?: WindowsOwnerPrivateAclVerifier;
}): Promise<ManagedBridgeIpcSubject> {
  const [vaultFile, checkpointFile] = await Promise.all([
    readOwnerPrivateRegularFile(input.vaultPath, input.windowsOwnerPrivateAclVerifier),
    readOwnerPrivateRegularFile(input.checkpointPath, input.windowsOwnerPrivateAclVerifier),
  ]);
  let vaultValue: unknown;
  let checkpointValue: unknown;
  try {
    vaultValue = JSON.parse(vaultFile.bytes.toString("utf8"));
    checkpointValue = JSON.parse(checkpointFile.bytes.toString("utf8"));
  } catch {
    throw new Error("Managed Bridge recovery identity files are not valid JSON");
  }
  const vault = parseCodexSessionTicketVaultSnapshot(vaultValue);
  const checkpoint = parseCodexSessionOperationalCheckpoint(checkpointValue);
  const session = checkpoint.session;
  if (
    checkpoint.projectId !== input.projectId ||
    checkpoint.threadId !== input.originalThreadId ||
    checkpoint.ownerRunId !== input.runId ||
    session === null ||
    session.hubSessionId !== input.sessionId
  ) {
    throw new Error("Managed Bridge checkpoint does not match the registered runtime identity");
  }
  const active = [vault.current, vault.successor].find(
    (candidate) => candidate?.bundleId === session.bundleId,
  );
  const binding = active?.binding;
  if (
    !active ||
    active.phase !== "ACTIVE" ||
    !binding ||
    binding.bundleId !== session.bundleId ||
    binding.projectId !== input.projectId ||
    binding.agentId !== "codex" ||
    binding.adapterClient !== "codex" ||
    binding.hubSessionId !== input.sessionId ||
    binding.lineageId !== session.lineageId ||
    binding.incarnation !== session.incarnation ||
    binding.runId !== input.runId
  ) {
    throw new Error("Managed Bridge vault does not match the active checkpoint binding");
  }
  const subject: ManagedBridgeIpcSubject = {
    schemaVersion: 1,
    projectId: input.projectId,
    originalThreadId: input.originalThreadId,
    agentId: "codex",
    runId: input.runId,
    sessionId: input.sessionId,
    lineageId: session.lineageId,
    incarnation: session.incarnation,
    bundleId: session.bundleId,
    build: structuredClone(input.build),
    vaultSha256: vaultFile.sha256,
    checkpointSha256: checkpointFile.sha256,
    checkpointEventSequence: checkpoint.eventSequence,
    fuseGeneration: input.fuseGeneration,
  };
  assertManagedBridgeIpcSubject(subject);
  return subject;
}

async function readOwnerPrivateRegularFile(
  inputPath: string,
  windowsOwnerPrivateAclVerifier?: WindowsOwnerPrivateAclVerifier,
): Promise<PrivateFileObservation> {
  const path = resolve(inputPath);
  await assertOwnerPrivate(path, windowsOwnerPrivateAclVerifier);
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Managed Bridge recovery identity path is not a regular file");
  }
  if (before.size <= 0 || before.size > MAX_RUNTIME_IDENTITY_FILE_BYTES) {
    throw new Error("Managed Bridge recovery identity file exceeds its bounded size");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let bytes: Buffer;
  let opened: ReturnType<typeof fstatSync>;
  try {
    opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size) {
      throw new Error("Managed Bridge recovery identity file changed before read");
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  const divergence = statIdentityDivergence(opened, after);
  if (divergence.length > 0) {
    throw new Error(
      `Managed Bridge recovery identity file changed during read (${divergence.join("; ")})`,
    );
  }
  await assertOwnerPrivate(path, windowsOwnerPrivateAclVerifier);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function assertOwnerPrivate(
  path: string,
  windowsOwnerPrivateAclVerifier?: WindowsOwnerPrivateAclVerifier,
): Promise<void> {
  if (process.platform === "win32") {
    if (
      !windowsOwnerPrivateAclVerifier ||
      !(await windowsOwnerPrivateAclVerifier(dirname(path))) ||
      !(await windowsOwnerPrivateAclVerifier(path))
    ) {
      throw new Error("Managed Bridge recovery identity path is not owner-private");
    }
    return;
  }
  const directory = lstatSync(dirname(path));
  const file = lstatSync(path);
  if ((directory.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0) {
    throw new Error("Managed Bridge recovery identity path is not owner-private");
  }
}

export type ManagedBridgeRuntimeLaunchMetadata = {
  schemaVersion: 1;
  entry: string;
  projectRoot: string;
  workerProofMode: "required";
  hookCaptureBindingMode: "required" | "disabled";
  historicalDeliveryProofMode: "required" | "disabled";
};

export type ManagedBridgeRuntimeRegistration = {
  schemaVersion: 1;
  revision: number;
  desiredState: "RUNNING" | "STOPPED";
  subject: ManagedBridgeIpcSubject;
  stopReceipt: ManagedBridgeRuntimeStopReceipt | null;
  launch: ManagedBridgeRuntimeLaunchMetadata;
};

type RuntimeAclOptions = {
  windowsOwnerPrivateAclVerifier?: WindowsOwnerPrivateAclVerifier;
  windowsOwnerPrivateAclHardener?: WindowsOwnerPrivateAclHardener;
};

type RuntimeEffectState =
  | {
      schemaVersion: 1;
      revision: 0;
      state: "CLAIMED";
      commandId: string;
      requestHash: string;
      leaseFence: ManagedBridgeRuntimeLeaseFence;
      receipt: null;
    }
  | {
      schemaVersion: 1;
      revision: 1;
      state: "COMPLETED";
      commandId: string;
      requestHash: string;
      leaseFence: ManagedBridgeRuntimeLeaseFence;
      receipt: ManagedBridgeRuntimeEffectReceipt;
    };

export class FileManagedBridgeRuntimeRegistrationStore {
  readonly #directory: string;
  readonly #acl: RuntimeAclOptions;

  constructor(options: { rootDir: string } & RuntimeAclOptions) {
    this.#directory = resolve(options.rootDir, "runtime-lifecycle", "registrations");
    this.#acl = options;
  }

  /** Child-only registration. A persisted STOPPED intent cannot be resurrected by a late child. */
  async persistRunning(input: {
    subject: ManagedBridgeIpcSubject;
    launch: ManagedBridgeRuntimeLaunchMetadata;
  }): Promise<ManagedBridgeRuntimeRegistration> {
    validateRegistrationInput(input.subject, input.launch);
    const key = managedBridgeActiveSubjectKey(input.subject);
    return withBoundedFileLock(this.#lockPath(key), this.#acl, async () => {
      const current = await this.#read(key);
      if (current) {
        if (!sameSubject(current.subject, input.subject)) {
          throw new Error(
            "Managed Bridge runtime registration key is already bound to another run",
          );
        }
        if (!sameJson(current.launch, input.launch)) {
          throw new Error("Managed Bridge runtime launch metadata changed after registration");
        }
        if (current.desiredState === "STOPPED") {
          throw new Error("Managed Bridge runtime STOPPED intent cannot be revived by the child");
        }
        return structuredClone(current);
      }
      const created: ManagedBridgeRuntimeRegistration = {
        schemaVersion: 1,
        revision: 0,
        desiredState: "RUNNING",
        subject: structuredClone(input.subject),
        stopReceipt: null,
        launch: structuredClone(input.launch),
      };
      await atomicWriteOwnerPrivateJson(this.#path(key), created, this.#acl);
      return structuredClone(created);
    });
  }

  /** CLI/user intent mutation, exact to project + original thread + run. */
  async sealStopped(input: {
    projectId: string;
    originalThreadId: string;
    runId: string;
  }): Promise<ManagedBridgeRuntimeRegistration> {
    assertIdentifier(input.projectId, "projectId");
    assertIdentifier(input.originalThreadId, "originalThreadId");
    assertIdentifier(input.runId, "runId");
    const key = subjectKey(input.projectId, input.originalThreadId);
    return withBoundedFileLock(this.#lockPath(key), this.#acl, async () => {
      const current = await this.#read(key);
      if (
        !current ||
        current.subject.projectId !== input.projectId ||
        current.subject.originalThreadId !== input.originalThreadId ||
        current.subject.runId !== input.runId
      ) {
        throw new Error("Managed Bridge runtime registration does not match the exact stop target");
      }
      if (current.desiredState === "STOPPED") return structuredClone(current);
      const revision = current.revision + 1;
      const stopReceipt: ManagedBridgeRuntimeStopReceipt = {
        kind: "DESIRED_STOP_PERSISTED",
        receiptId: `runtime_stop_${digest({ key, revision, runId: input.runId }).slice(0, 32)}`,
        desiredRevision: revision,
        subjectKey: key,
      };
      const stopped: ManagedBridgeRuntimeRegistration = {
        ...current,
        revision,
        desiredState: "STOPPED",
        stopReceipt,
      };
      await atomicWriteOwnerPrivateJson(this.#path(key), stopped, this.#acl);
      return structuredClone(stopped);
    });
  }

  async loadBySubjectKey(
    subjectKeyValue: string,
  ): Promise<ManagedBridgeRuntimeRegistration | null> {
    assertSha256(subjectKeyValue, "subjectKey");
    return this.#read(subjectKeyValue);
  }

  async loadByIdentity(
    projectId: string,
    originalThreadId: string,
  ): Promise<ManagedBridgeRuntimeRegistration | null> {
    assertIdentifier(projectId, "projectId");
    assertIdentifier(originalThreadId, "originalThreadId");
    return this.#read(subjectKey(projectId, originalThreadId));
  }

  async list(): Promise<ManagedBridgeRuntimeRegistration[]> {
    await ensureOwnerPrivateDirectory(this.#directory, this.#acl);
    const names = readdirSync(this.#directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .sort();
    if (names.length > MAX_RUNTIME_REGISTRATIONS) {
      throw new Error("Managed Bridge runtime registration index exceeds its bound");
    }
    const registrations: ManagedBridgeRuntimeRegistration[] = [];
    for (const name of names) {
      const key = name.slice(0, 64);
      const registration = await this.#read(key);
      if (registration) registrations.push(registration);
    }
    return registrations;
  }

  #path(key: string): string {
    return resolve(this.#directory, `${key}.json`);
  }

  #lockPath(key: string): string {
    return resolve(this.#directory, `${key}.lock`);
  }

  async #read(key: string): Promise<ManagedBridgeRuntimeRegistration | null> {
    const path = this.#path(key);
    if (!existsSync(path)) return null;
    const value = await readOwnerPrivateJson(path, this.#acl);
    const registration = validateRegistration(value);
    if (managedBridgeActiveSubjectKey(registration.subject) !== key) {
      throw new Error("Managed Bridge runtime registration filename does not bind its subject");
    }
    return registration;
  }
}

export class FileManagedBridgeRuntimeCommandStore implements ManagedBridgeRuntimeCommandStore {
  readonly #directory: string;
  readonly #acl: RuntimeAclOptions;

  constructor(options: { rootDir: string } & RuntimeAclOptions) {
    this.#directory = resolve(options.rootDir, "runtime-lifecycle", "commands");
    this.#acl = options;
  }

  async load(commandId: string): Promise<ManagedBridgeRuntimeCommandJournal | null> {
    assertSha256(commandId, "commandId");
    const path = this.#path(commandId);
    if (!existsSync(path)) return null;
    return validateCommandJournal(await readOwnerPrivateJson(path, this.#acl));
  }

  async listClaimed(): Promise<ManagedBridgeRuntimeCommandJournal[]> {
    await ensureOwnerPrivateDirectory(this.#directory, this.#acl);
    const names = readdirSync(this.#directory)
      .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
      .sort();
    if (names.length > MAX_RUNTIME_COMMANDS) {
      throw new Error("Managed Bridge runtime command index exceeds its bound");
    }
    const claimed: ManagedBridgeRuntimeCommandJournal[] = [];
    for (const name of names) {
      const commandId = name.slice(0, 64);
      const row = await this.load(commandId);
      if (row?.state === "CLAIMED") claimed.push(row);
    }
    return claimed;
  }

  async compareAndSwap(
    commandId: string,
    expectedRevision: number | null,
    next: ManagedBridgeRuntimeCommandJournal,
    lease: ManagedBridgeRuntimeLease,
  ): Promise<boolean> {
    assertSha256(commandId, "commandId");
    const validated = validateCommandJournal(next);
    if (validated.commandId !== commandId) {
      throw new Error("Managed Bridge runtime journal path does not bind its command");
    }
    assertJournalLeaseFence(validated.command.leaseFence, lease);
    lease.assertActive();
    return withBoundedFileLock(this.#lockPath(commandId), this.#acl, async () => {
      lease.assertActive();
      const current = await this.load(commandId);
      const currentRevision = current?.revision ?? null;
      if (currentRevision !== expectedRevision) return false;
      if (
        expectedRevision === null
          ? validated.revision !== 0
          : validated.revision !== expectedRevision + 1
      ) {
        throw new Error("Managed Bridge runtime journal revision is not a strict successor");
      }
      lease.assertActive();
      await atomicWriteOwnerPrivateJson(this.#path(commandId), validated, this.#acl);
      lease.assertActive();
      return true;
    });
  }

  #path(commandId: string): string {
    return resolve(this.#directory, `${commandId}.json`);
  }

  #lockPath(commandId: string): string {
    return resolve(this.#directory, `${commandId}.lock`);
  }
}

export type ManagedBridgeRuntimeStartProcess = (input: {
  entry: string;
  projectId: string;
  agentId: "codex";
  projectRoot: string;
  threadId: string;
  hookCaptureBindingMode: "required" | "disabled";
  historicalDeliveryProofMode: "required" | "disabled";
  workerProofMode: "required";
  rootDir: string;
  buildIdentity: ManagedBridgeBuildIdentity;
  expectedRunId: string;
}) => Promise<{
  record: { projectId: string; runId: string | null; threadId: string | null; pid: number };
  alreadyRunning: boolean;
}>;

export type ManagedBridgeRuntimeStopProcess = (
  projectId: string,
  agentId: "codex",
  rootDir: string,
  selector: { runId: string; threadId: string; pid?: number },
) => Promise<{
  stopped: boolean;
  stale: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  runId?: string | null;
}>;

export class ProductionManagedBridgeRuntimeAdapter implements ManagedBridgeRuntimeAdapter {
  readonly #rootDir: string;
  readonly #registrations: FileManagedBridgeRuntimeRegistrationStore;
  readonly #acl: RuntimeAclOptions;
  readonly #assertLeaseFence: (fence: ManagedBridgeRuntimeLeaseFence) => void | Promise<void>;
  readonly #startProcess: ManagedBridgeRuntimeStartProcess;
  readonly #stopProcess: ManagedBridgeRuntimeStopProcess;
  readonly #challenge: typeof challengeBridgeWorker;
  readonly #effectDirectory: string;

  constructor(
    options: {
      rootDir: string;
      registrationStore: FileManagedBridgeRuntimeRegistrationStore;
      assertLeaseFence: (fence: ManagedBridgeRuntimeLeaseFence) => void | Promise<void>;
      startProcess?: ManagedBridgeRuntimeStartProcess;
      stopProcess?: ManagedBridgeRuntimeStopProcess;
      challengeWorker?: typeof challengeBridgeWorker;
    } & RuntimeAclOptions,
  ) {
    this.#rootDir = resolve(options.rootDir);
    this.#registrations = options.registrationStore;
    this.#acl = options;
    this.#assertLeaseFence = options.assertLeaseFence;
    this.#startProcess = options.startProcess ?? ((input) => startCodexBridgeProcess(input));
    this.#stopProcess =
      options.stopProcess ??
      ((projectId, agentId, rootDir, selector) =>
        stopCodexBridgeProcess(projectId, agentId, rootDir, selector));
    this.#challenge = options.challengeWorker ?? challengeBridgeWorker;
    this.#effectDirectory = resolve(this.#rootDir, "runtime-lifecycle", "effects");
  }

  async enumerateDesired(): Promise<ManagedBridgeRuntimeDesiredRecord[]> {
    return (await this.#registrations.list()).map(desiredFromRegistration);
  }

  async enumerateSidecars(subjectKeyValue: string): Promise<ManagedBridgeRuntimeSidecar[]> {
    assertSha256(subjectKeyValue, "subjectKey");
    const registration = await this.#registrations.loadBySubjectKey(subjectKeyValue);
    if (!registration) return [];
    const sidecar = await this.#readExactSidecar(registration);
    return sidecar ? [sidecar] : [];
  }

  async challengeWorker(input: {
    challengeId: string;
    sidecar: ManagedBridgeRuntimeSidecar;
  }): Promise<unknown> {
    assertSha256(input.challengeId, "challengeId");
    const registration = await this.#exactRegistrationForSubject(input.sidecar.subject);
    const current = await this.#readExactSidecar(registration);
    if (!current || !sameJson(current, input.sidecar) || current.state !== "RUNNING") {
      throw new Error("Managed Bridge worker sidecar changed before its fresh challenge");
    }
    return this.#challenge({
      challengeId: input.challengeId,
      sidecar: current as BridgeWorkerProofSidecar,
    });
  }

  async readReleaseAuthorization(_input: {
    operationId: string;
    subjectKey: string;
  }): Promise<never> {
    throw new Error("Managed Bridge release authorization Adapter is not configured");
  }

  async dispatch(command: ManagedBridgeRuntimeCommand): Promise<ManagedBridgeRuntimeEffectReceipt> {
    if (command.kind === "RELEASE_REBIND_EXACT" || command.kind === "RELEASE_ROLLBACK_EXACT") {
      throw new Error("Managed Bridge release effects require the Atomic/Supervisor Adapter");
    }
    const path = this.#effectPath(command.commandId);
    await this.#assertLeaseFence(command.leaseFence);
    return withBoundedFileLock(this.#effectLockPath(command), this.#acl, async () => {
      await this.#assertLeaseFence(command.leaseFence);
      const existing = existsSync(path)
        ? validateEffectState(await readOwnerPrivateJson(path, this.#acl), command)
        : null;
      if (existing?.state === "COMPLETED") return structuredClone(existing.receipt);

      await this.#assertLeaseFence(command.leaseFence);
      const registration = await this.#exactRegistrationForSubject(command.subject);
      assertDesiredForCommand(registration, command);
      let currentSidecar: ManagedBridgeRuntimeSidecar | null = null;
      if (existing === null) {
        currentSidecar = await this.#readExactSidecar(registration);
        assertSidecarForCommand(currentSidecar, command);
        const claimed: RuntimeEffectState = {
          schemaVersion: 1,
          revision: 0,
          state: "CLAIMED",
          commandId: command.commandId,
          requestHash: command.requestHash,
          leaseFence: structuredClone(command.leaseFence),
          receipt: null,
        };
        await atomicWriteOwnerPrivateJson(path, claimed, this.#acl);
      }
      await this.#assertLeaseFence(command.leaseFence);

      let receipt: ManagedBridgeRuntimeEffectReceipt;
      if (command.kind === "STOP_EXACT") {
        if (existing?.state === "CLAIMED") {
          currentSidecar = await this.#readExactSidecar(registration);
          if (currentSidecar === null && command.workerSidecar?.state === "RUNNING") {
            throw new Error("Managed Bridge exact stop effect is ambiguous after receiver restart");
          }
        }
        receipt = await this.#dispatchStop(command, currentSidecar, existing?.state === "CLAIMED");
      } else {
        // The exact start receiver is idempotent: expectedRunId returns the nonce-bound live owner
        // or resumes that same recoverable run, never a fresh logical run.
        receipt = await this.#dispatchStart(command);
      }
      await this.#assertLeaseFence(command.leaseFence);
      const state: RuntimeEffectState = {
        schemaVersion: 1,
        revision: 1,
        state: "COMPLETED",
        commandId: command.commandId,
        requestHash: command.requestHash,
        leaseFence: existing?.leaseFence ?? structuredClone(command.leaseFence),
        receipt,
      };
      await atomicWriteOwnerPrivateJson(path, state, this.#acl);
      return structuredClone(receipt);
    });
  }

  async #dispatchStop(
    command: Extract<ManagedBridgeRuntimeCommand, { kind: "STOP_EXACT" }>,
    sidecar: ManagedBridgeRuntimeSidecar | null,
    recoveringClaimedEffect = false,
  ): Promise<ManagedBridgeRuntimeEffectReceipt> {
    const running = sidecar?.state === "RUNNING";
    if (running) {
      const result = await this.#stopProcess(command.subject.projectId, "codex", this.#rootDir, {
        runId: command.subject.runId,
        threadId: command.subject.originalThreadId,
        pid: sidecar.pid!,
      });
      if (
        !result.stopped ||
        result.timedOut === true ||
        result.cancelled === true ||
        result.runId !== command.subject.runId
      ) {
        throw new Error("Managed Bridge exact stop did not confirm the selected run");
      }
    }
    return effectReceipt(
      command,
      running || (recoveringClaimedEffect && command.workerSidecar?.state === "RUNNING")
        ? "STOPPED"
        : "ALREADY_STOPPED",
    );
  }

  async #dispatchStart(
    command: Extract<ManagedBridgeRuntimeCommand, { kind: "START_EXACT" }>,
  ): Promise<ManagedBridgeRuntimeEffectReceipt> {
    const registration = await this.#exactRegistrationForSubject(command.subject);
    const result = await this.#startProcess({
      entry: registration.launch.entry,
      projectId: command.subject.projectId,
      agentId: "codex",
      projectRoot: registration.launch.projectRoot,
      threadId: command.subject.originalThreadId,
      hookCaptureBindingMode: registration.launch.hookCaptureBindingMode,
      historicalDeliveryProofMode: registration.launch.historicalDeliveryProofMode,
      workerProofMode: "required",
      rootDir: this.#rootDir,
      buildIdentity: structuredClone(command.subject.build),
      expectedRunId: command.subject.runId,
    });
    if (
      result.record.projectId !== command.subject.projectId ||
      result.record.runId !== command.subject.runId ||
      result.record.threadId !== command.subject.originalThreadId ||
      !Number.isSafeInteger(result.record.pid) ||
      result.record.pid <= 0
    ) {
      throw new Error("Managed Bridge exact start returned a different runtime identity");
    }
    return effectReceipt(command);
  }

  async #exactRegistrationForSubject(
    subject: ManagedBridgeIpcSubject,
  ): Promise<ManagedBridgeRuntimeRegistration> {
    assertManagedBridgeIpcSubject(subject);
    const registration = await this.#registrations.loadBySubjectKey(
      managedBridgeActiveSubjectKey(subject),
    );
    if (!registration || !sameSubject(registration.subject, subject)) {
      throw new Error("Managed Bridge desired registration changed before the process effect");
    }
    return registration;
  }

  async #readExactSidecar(
    registration: ManagedBridgeRuntimeRegistration,
  ): Promise<ManagedBridgeRuntimeSidecar | null> {
    const files = codexBridgeRunFiles(
      registration.subject.projectId,
      "codex",
      registration.subject.runId,
      this.#rootDir,
    );
    if (!existsSync(files.workerProofPath)) {
      if (existsSync(files.pidPath)) {
        throw new Error("Managed Bridge control record exists without its required worker sidecar");
      }
      return null;
    }
    const controlExists = existsSync(files.pidPath);
    const raw = await readBridgeWorkerProofSidecar({
      controlPath: files.pidPath,
      sidecarPath: files.workerProofPath,
      controlRequired: controlExists,
      windowsOwnerPrivateAclVerifier: this.#acl.windowsOwnerPrivateAclVerifier,
    });
    if (!("originalThreadId" in raw.subject) || !sameSubject(raw.subject, registration.subject)) {
      throw new Error("Managed Bridge worker sidecar does not bind the registered full subject");
    }
    if (!controlExists && raw.state === "RUNNING") {
      throw new Error("Managed Bridge RUNNING sidecar has no exact control record");
    }
    if (controlExists && raw.state !== "RUNNING") {
      throw new Error(
        "Managed Bridge terminal worker sidecar conflicts with an active control record",
      );
    }
    if (raw.state === "RUNNING") {
      const control = readCodexBridgeRunPid(
        registration.subject.projectId,
        "codex",
        registration.subject.runId,
        this.#rootDir,
      );
      const controlBuild = readCodexBridgeRunBuildIdentity(
        registration.subject.projectId,
        "codex",
        registration.subject.runId,
        this.#rootDir,
      );
      if (
        !control ||
        control.runId !== registration.subject.runId ||
        control.threadId !== registration.subject.originalThreadId ||
        control.pid !== raw.pid ||
        !sameJson(controlBuild, registration.subject.build) ||
        control.workerProofMode !== "required"
      ) {
        throw new Error("Managed Bridge control identity does not match the worker sidecar");
      }
    }
    return structuredClone(raw) as ManagedBridgeRuntimeSidecar;
  }

  #effectPath(commandId: string): string {
    assertSha256(commandId, "commandId");
    return resolve(this.#effectDirectory, `${commandId}.json`);
  }

  #effectLockPath(command: ManagedBridgeRuntimeCommand): string {
    return resolve(
      this.#effectDirectory,
      `${managedBridgeActiveSubjectKey(command.subject)}.subject.lock`,
    );
  }
}

function desiredFromRegistration(
  registration: ManagedBridgeRuntimeRegistration,
): ManagedBridgeRuntimeDesiredRecord {
  return {
    schemaVersion: 1,
    revision: registration.revision,
    desiredState: registration.desiredState,
    subject: structuredClone(registration.subject),
    stopReceipt: structuredClone(registration.stopReceipt),
  };
}

function effectReceipt(
  command: Extract<ManagedBridgeRuntimeCommand, { kind: "START_EXACT" }>,
): ManagedBridgeRuntimeEffectReceipt;
function effectReceipt(
  command: Extract<ManagedBridgeRuntimeCommand, { kind: "STOP_EXACT" }>,
  effect: "STOPPED" | "ALREADY_STOPPED",
): ManagedBridgeRuntimeEffectReceipt;
function effectReceipt(
  command: Extract<ManagedBridgeRuntimeCommand, { kind: "START_EXACT" | "STOP_EXACT" }>,
  effect?: "STOPPED" | "ALREADY_STOPPED",
): ManagedBridgeRuntimeEffectReceipt {
  const common = {
    schemaVersion: 1 as const,
    commandId: command.commandId,
    requestHash: command.requestHash,
    subject: structuredClone(command.subject),
    subjectKey: managedBridgeActiveSubjectKey(command.subject),
    recordRevision: command.desiredRevision,
    eventSequence: command.subject.checkpointEventSequence,
    leaseFence: structuredClone(command.leaseFence),
  };
  return command.kind === "START_EXACT"
    ? { ...common, kind: "STARTED" }
    : { ...common, kind: "STOPPED", effect: effect! };
}

function assertDesiredForCommand(
  registration: ManagedBridgeRuntimeRegistration,
  command: Extract<ManagedBridgeRuntimeCommand, { kind: "START_EXACT" | "STOP_EXACT" }>,
): void {
  if (
    registration.revision !== command.desiredRevision ||
    !sameSubject(registration.subject, command.subject)
  ) {
    throw new Error("Managed Bridge desired revision changed before the process effect");
  }
  if (command.kind === "START_EXACT") {
    if (registration.desiredState !== "RUNNING" || registration.stopReceipt !== null) {
      throw new Error("Managed Bridge START no longer has RUNNING desired state");
    }
    return;
  }
  if (
    registration.desiredState !== "STOPPED" ||
    !sameJson(registration.stopReceipt, command.persistedStopReceipt)
  ) {
    throw new Error("Managed Bridge STOP no longer has its exact sealed receipt");
  }
}

function assertSidecarForCommand(
  current: ManagedBridgeRuntimeSidecar | null,
  command: Extract<ManagedBridgeRuntimeCommand, { kind: "START_EXACT" | "STOP_EXACT" }>,
): void {
  const expected = command.kind === "START_EXACT" ? command.recoverySidecar : command.workerSidecar;
  if (!sameJson(current, expected)) {
    throw new Error("Managed Bridge worker sidecar changed before the process effect");
  }
  if (
    command.kind === "START_EXACT" &&
    current?.state !== "EXITED" &&
    current?.state !== "STOPPED"
  ) {
    throw new Error("Managed Bridge START requires one exact terminal recovery sidecar");
  }
}

function validateEffectState(
  value: unknown,
  command: ManagedBridgeRuntimeCommand,
): RuntimeEffectState {
  assertNoSecretFields(value);
  const record = exactRecord(value, [
    "schemaVersion",
    "revision",
    "state",
    "commandId",
    "requestHash",
    "leaseFence",
    "receipt",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.commandId !== command.commandId ||
    record.requestHash !== command.requestHash
  ) {
    throw new Error("Managed Bridge effect state does not bind the exact command");
  }
  const fence = exactRecord(record.leaseFence, [
    "schemaVersion",
    "controlLeaseId",
    "controlLeaseGeneration",
    "journalLeaseId",
    "journalLeaseGeneration",
  ]);
  assertIdentifier(fence.controlLeaseId, "effect.leaseFence.controlLeaseId");
  assertIdentifier(fence.journalLeaseId, "effect.leaseFence.journalLeaseId");
  if (
    fence.schemaVersion !== 1 ||
    !Number.isSafeInteger(fence.controlLeaseGeneration) ||
    Number(fence.controlLeaseGeneration) <= 0 ||
    !Number.isSafeInteger(fence.journalLeaseGeneration) ||
    Number(fence.journalLeaseGeneration) <= 0
  ) {
    throw new Error("Managed Bridge effect state has an invalid accepted lease fence");
  }
  if (record.state === "CLAIMED") {
    if (record.revision !== 0 || record.receipt !== null) {
      throw new Error("Managed Bridge claimed effect state is inconsistent");
    }
    return structuredClone(record) as RuntimeEffectState;
  }
  if (record.state !== "COMPLETED" || record.revision !== 1) {
    throw new Error("Managed Bridge effect state is not a strict terminal successor");
  }
  const receipt = record.receipt as ManagedBridgeRuntimeEffectReceipt;
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.commandId !== command.commandId ||
    receipt.requestHash !== command.requestHash ||
    !sameJson(receipt.subject, command.subject)
  ) {
    throw new Error("Managed Bridge effect receipt does not bind the exact command");
  }
  if (
    receipt.leaseFence === null ||
    typeof receipt.leaseFence !== "object" ||
    Array.isArray(receipt.leaseFence)
  ) {
    throw new Error("Managed Bridge effect receipt lost its accepted lease fence");
  }
  return structuredClone(record) as RuntimeEffectState;
}

function validateRegistrationInput(
  subject: ManagedBridgeIpcSubject,
  launch: ManagedBridgeRuntimeLaunchMetadata,
): void {
  assertManagedBridgeIpcSubject(subject);
  validateLaunchMetadata(launch);
  assertNoSecretFields({ subject, launch });
}

function validateRegistration(value: unknown): ManagedBridgeRuntimeRegistration {
  assertNoSecretFields(value);
  const record = exactRecord(value, [
    "schemaVersion",
    "revision",
    "desiredState",
    "subject",
    "stopReceipt",
    "launch",
  ]);
  if (record.schemaVersion !== 1) throw new Error("Invalid Managed Bridge registration schema");
  assertNonNegativeInteger(record.revision, "revision");
  assertManagedBridgeIpcSubject(record.subject);
  validateLaunchMetadata(record.launch);
  if (record.desiredState === "RUNNING") {
    if (record.stopReceipt !== null) throw new Error("RUNNING registration retained stop receipt");
  } else if (record.desiredState === "STOPPED") {
    validateStopReceipt(record.stopReceipt, record.subject, Number(record.revision));
  } else {
    throw new Error("Invalid Managed Bridge desired state");
  }
  return structuredClone(record) as ManagedBridgeRuntimeRegistration;
}

function validateLaunchMetadata(
  value: unknown,
): asserts value is ManagedBridgeRuntimeLaunchMetadata {
  const record = exactRecord(value, [
    "schemaVersion",
    "entry",
    "projectRoot",
    "workerProofMode",
    "hookCaptureBindingMode",
    "historicalDeliveryProofMode",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.workerProofMode !== "required" ||
    (record.hookCaptureBindingMode !== "required" &&
      record.hookCaptureBindingMode !== "disabled") ||
    (record.historicalDeliveryProofMode !== "required" &&
      record.historicalDeliveryProofMode !== "disabled") ||
    typeof record.entry !== "string" ||
    !isAbsolute(record.entry) ||
    resolve(record.entry) !== record.entry ||
    typeof record.projectRoot !== "string" ||
    !isAbsolute(record.projectRoot) ||
    resolve(record.projectRoot) !== record.projectRoot
  ) {
    throw new Error("Invalid Managed Bridge non-secret launch metadata");
  }
}

function validateStopReceipt(
  value: unknown,
  subject: ManagedBridgeIpcSubject,
  revision: number,
): asserts value is ManagedBridgeRuntimeStopReceipt {
  const record = exactRecord(value, ["kind", "receiptId", "desiredRevision", "subjectKey"]);
  assertIdentifier(record.receiptId, "stopReceipt.receiptId");
  if (
    record.kind !== "DESIRED_STOP_PERSISTED" ||
    record.desiredRevision !== revision ||
    record.subjectKey !== managedBridgeActiveSubjectKey(subject)
  ) {
    throw new Error("Managed Bridge stop receipt does not bind its desired revision");
  }
}

function validateCommandJournal(value: unknown): ManagedBridgeRuntimeCommandJournal {
  assertNoSecretFields(value);
  const record = exactRecord(value, [
    "schemaVersion",
    "revision",
    "commandId",
    "requestHash",
    "state",
    "command",
    "attemptFences",
    "receipt",
  ]);
  if (record.schemaVersion !== 1) throw new Error("Invalid Managed Bridge command schema");
  assertNonNegativeInteger(record.revision, "revision");
  assertSha256(record.commandId, "commandId");
  assertSha256(record.requestHash, "requestHash");
  if (record.state !== "CLAIMED" && record.state !== "COMPLETED") {
    throw new Error("Invalid Managed Bridge command state");
  }
  if (
    record.command === null ||
    typeof record.command !== "object" ||
    Array.isArray(record.command)
  ) {
    throw new Error("Invalid Managed Bridge command payload");
  }
  const command = record.command as ManagedBridgeRuntimeCommand;
  if (command.commandId !== record.commandId || command.requestHash !== record.requestHash) {
    throw new Error("Managed Bridge journal does not bind its command");
  }
  if (
    !Array.isArray(record.attemptFences) ||
    record.attemptFences.length < 1 ||
    record.attemptFences.length > 64
  ) {
    throw new Error("Managed Bridge command fence history is invalid");
  }
  if ((record.state === "CLAIMED") !== (record.receipt === null)) {
    throw new Error("Managed Bridge command terminal state is inconsistent");
  }
  return structuredClone(record) as ManagedBridgeRuntimeCommandJournal;
}

function assertJournalLeaseFence(
  fence: ManagedBridgeRuntimeLeaseFence,
  lease: ManagedBridgeRuntimeLease,
): void {
  if (
    fence?.schemaVersion !== 1 ||
    fence.journalLeaseId !== lease.leaseId ||
    fence.journalLeaseGeneration !== lease.generation ||
    lease.generation <= 0
  ) {
    throw new Error("Managed Bridge command mutation lost its exact journal lease fence");
  }
}

async function readOwnerPrivateJson(path: string, acl: RuntimeAclOptions): Promise<unknown> {
  await assertStatePathOwnerPrivate(path, acl, true);
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > MAX_RUNTIME_STATE_FILE_BYTES
  ) {
    throw new Error("Managed Bridge runtime state is not a bounded regular file");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  let opened: ReturnType<typeof fstatSync>;
  let bytes: Buffer;
  try {
    opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size) {
      throw new Error("Managed Bridge runtime state changed before read");
    }
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const after = lstatSync(path);
  const divergence = statIdentityDivergence(opened, after);
  if (divergence.length > 0) {
    throw new Error(`Managed Bridge runtime state changed during read (${divergence.join("; ")})`);
  }
  await assertStatePathOwnerPrivate(path, acl, true);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Managed Bridge runtime state is not valid JSON");
  }
}

async function atomicWriteOwnerPrivateJson(
  path: string,
  value: unknown,
  acl: RuntimeAclOptions,
): Promise<void> {
  assertNoSecretFields(value);
  await ensureOwnerPrivateDirectory(dirname(path), acl);
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
    await hardenStatePath(temporary, "file", acl);
    await assertStatePathOwnerPrivate(temporary, acl, true);
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
    await hardenStatePath(path, "file", acl);
    await assertStatePathOwnerPrivate(path, acl, true);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

async function ensureOwnerPrivateDirectory(path: string, acl: RuntimeAclOptions): Promise<void> {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  await hardenStatePath(path, "directory", acl);
  await assertStatePathOwnerPrivate(path, acl, false);
}

async function hardenStatePath(
  path: string,
  kind: "directory" | "file",
  acl: RuntimeAclOptions,
): Promise<void> {
  if (process.platform !== "win32") return;
  if (
    !acl.windowsOwnerPrivateAclHardener ||
    !(await acl.windowsOwnerPrivateAclHardener(path, kind))
  ) {
    throw new Error("Managed Bridge runtime state could not be hardened owner-private");
  }
}

async function assertStatePathOwnerPrivate(
  path: string,
  acl: RuntimeAclOptions,
  regularFile: boolean,
): Promise<void> {
  const observed = lstatSync(path);
  if (observed.isSymbolicLink() || (regularFile ? !observed.isFile() : !observed.isDirectory())) {
    throw new Error("Managed Bridge runtime state path is not a regular private path");
  }
  if (process.platform === "win32") {
    if (!acl.windowsOwnerPrivateAclVerifier || !(await acl.windowsOwnerPrivateAclVerifier(path))) {
      throw new Error("Managed Bridge runtime state path is not owner-private");
    }
  } else if ((observed.mode & 0o077) !== 0) {
    throw new Error("Managed Bridge runtime state path is not owner-private");
  }
}

async function withBoundedFileLock<T>(
  lockPath: string,
  acl: RuntimeAclOptions,
  work: () => Promise<T>,
): Promise<T> {
  await ensureOwnerPrivateDirectory(dirname(lockPath), acl);
  const nonce = randomBytes(24).toString("hex");
  const lockRecord = {
    schemaVersion: 1 as const,
    nonce,
    ownerPid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        PRIVATE_FILE_MODE,
      );
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(lockRecord)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(lockPath, PRIVATE_FILE_MODE);
      await hardenStatePath(lockPath, "file", acl);
      await assertStatePathOwnerPrivate(lockPath, acl, true);
      acquired = true;
      break;
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (created) removeLockIfOwned(lockPath, nonce);
      if (!existsSync(lockPath)) throw error;
      await reclaimAbandonedLock(lockPath, acl);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
  if (!acquired) throw new Error("Managed Bridge runtime state lock is busy");
  try {
    return await work();
  } finally {
    removeLockIfOwned(lockPath, nonce);
  }
}

async function reclaimAbandonedLock(lockPath: string, acl: RuntimeAclOptions): Promise<void> {
  try {
    await assertStatePathOwnerPrivate(lockPath, acl, true);
    const before = lstatSync(lockPath);
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    const record = exactRecord(value, ["schemaVersion", "nonce", "ownerPid", "acquiredAt"]);
    assertIdentifier(record.nonce, "lock.nonce");
    if (
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.ownerPid) ||
      Number(record.ownerPid) <= 0 ||
      typeof record.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(record.acquiredAt)) ||
      Date.now() - Date.parse(record.acquiredAt) <= ABANDONED_LOCK_MS ||
      processExists(Number(record.ownerPid))
    ) {
      return;
    }
    const after = lstatSync(lockPath);
    if (
      after.isFile() &&
      !after.isSymbolicLink() &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs
    ) {
      unlinkSync(lockPath);
    }
  } catch {
    // Invalid, replaced, or still-owned locks are never removed by recovery.
  }
}

function removeLockIfOwned(lockPath: string, nonce: string): void {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).nonce === nonce
    ) {
      unlinkSync(lockPath);
    }
  } catch {
    // A missing or replaced lock is never deleted by a non-owner.
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Bridge runtime state is not an exact object");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Managed Bridge runtime state has unexpected fields");
  }
  return record;
}

function assertNoSecretFields(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 4_096 || current.depth > 64) {
      throw new Error("Managed Bridge runtime state exceeds bounded validation limits");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    for (const [key, child] of Object.entries(current.value)) {
      const normalized = key.replaceAll(/[_-]/gu, "").toLowerCase();
      const allowedAuthorizationField =
        normalized === "releaseauthorization" ||
        normalized === "authorizationid" ||
        normalized === "authorizationsha256";
      if (
        [
          "token",
          "secret",
          "password",
          "cookie",
          "bearer",
          "privatekey",
          "pkcs8",
          "sessionticket",
          "mcpticket",
          "credential",
          "apikey",
          "accesskey",
          "clientsecret",
        ].some((part) => normalized.includes(part)) ||
        (normalized.includes("authorization") && !allowedAuthorizationField)
      ) {
        throw new Error("Secret-shaped fields are forbidden in Managed Bridge runtime state");
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point < 32 || point === 127;
    })
  ) {
    throw new Error(`Invalid Managed Bridge runtime ${path}`);
  }
}

function assertSha256(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`Invalid Managed Bridge runtime ${path}`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid Managed Bridge runtime ${path}`);
  }
}

function subjectKey(projectId: string, originalThreadId: string): string {
  return createHash("sha256").update(`${projectId}\0${originalThreadId}`).digest("hex");
}

function sameSubject(left: ManagedBridgeIpcSubject, right: ManagedBridgeIpcSubject): boolean {
  return sameJson(left, right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
