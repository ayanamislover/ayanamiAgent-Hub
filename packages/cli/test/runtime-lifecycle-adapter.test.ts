import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexBridgeRunFiles } from "../src/bridge-process-manager.js";
import {
  managedBridgeActiveSubjectKey,
  type ManagedBridgeIpcSubject,
} from "../src/managed-bridge-ipc.js";
import {
  ManagedBridgeRuntimeCoordinator,
  type ManagedBridgeRuntimeAdapter,
  type ManagedBridgeRuntimeCommand,
  type ManagedBridgeRuntimeCommandJournal,
  type ManagedBridgeRuntimeLease,
  type ManagedBridgeRuntimeLeaseFence,
  type ManagedBridgeRuntimeSidecar,
} from "../src/managed-bridge-runtime.js";
import {
  FileManagedBridgeRuntimeCommandStore,
  FileManagedBridgeRuntimeRegistrationStore,
  ProductionManagedBridgeRuntimeAdapter,
  type ManagedBridgeRuntimeLaunchMetadata,
} from "../src/runtime-lifecycle.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const WORKER_KEYS = generateKeyPairSync("ed25519");
const WORKER_PUBLIC_DER = WORKER_KEYS.publicKey.export({ format: "der", type: "spki" });
const WORKER_PUBLIC_BASE64 = WORKER_PUBLIC_DER.toString("base64");
const WORKER_PUBLIC_SHA256 = createHash("sha256").update(WORKER_PUBLIC_DER).digest("hex");
const AT = "2026-08-02T12:00:00.000Z";

class Lease implements ManagedBridgeRuntimeLease {
  active = true;
  readonly leaseId: string;
  readonly generation: number;

  constructor(name: string, generation = 1) {
    this.leaseId = `lease_${name}`;
    this.generation = generation;
  }

  assertActive(): void {
    if (!this.active) throw new Error("lease inactive");
  }
}

function root(): string {
  return mkdtempSync(resolve(tmpdir(), "crossagent-runtime-adapter-"));
}

function subject(overrides: Partial<ManagedBridgeIpcSubject> = {}): ManagedBridgeIpcSubject {
  return {
    schemaVersion: 1,
    projectId: "prj_runtime_adapter",
    originalThreadId: "019fa8ef-3525-7a31-9e9b-2da6e38253f8",
    agentId: "codex",
    runId: "run_runtime_adapter",
    sessionId: "ses_runtime_adapter",
    lineageId: "lin_runtime_adapter",
    incarnation: 2,
    bundleId: "bnd_runtime_adapter",
    build: {
      buildId: SHA_A,
      buildSessionId: "123e4567-e89b-42d3-a456-426614174000",
      protocolId: SHA_B,
      manifestSha256: SHA_A,
      migrationId: SHA_C,
    },
    vaultSha256: SHA_B,
    checkpointSha256: SHA_C,
    checkpointEventSequence: 27,
    fuseGeneration: 4,
    ...overrides,
  };
}

function launch(rootDir: string): ManagedBridgeRuntimeLaunchMetadata {
  return {
    schemaVersion: 1,
    entry: resolve(rootDir, "release", "bin.js"),
    projectRoot: resolve(rootDir, "project"),
    workerProofMode: "required",
    hookCaptureBindingMode: "disabled",
    historicalDeliveryProofMode: "disabled",
  };
}

function acl() {
  return {
    windowsOwnerPrivateAclVerifier: () => true,
    windowsOwnerPrivateAclHardener: () => true,
  };
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(dirname(path), 0o700);
    chmodSync(path, 0o600);
  }
}

function workerPipePath(path: string, sidecarId: string): string {
  const digest = createHash("sha256")
    .update(`${resolve(path)}\0${sidecarId}\0`, "utf8")
    .update(WORKER_PUBLIC_DER)
    .digest("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\crossagent-worker-proof-${digest}`
    : `${path}.${digest.slice(0, 24)}.sock`;
}

function writeSidecar(
  rootDir: string,
  active: ManagedBridgeIpcSubject,
  overrides: Partial<ManagedBridgeRuntimeSidecar> = {},
): ManagedBridgeRuntimeSidecar {
  const files = codexBridgeRunFiles(active.projectId, "codex", active.runId, rootDir);
  const sidecarId = String(overrides.sidecarId ?? "worker_runtime_adapter");
  const sidecar: ManagedBridgeRuntimeSidecar = {
    schemaVersion: 1,
    kind: "BRIDGE_WORKER_PROOF_SIDECAR",
    sidecarId,
    revision: 4,
    state: "STOPPED",
    subject: active,
    pid: null,
    workerPipePath: workerPipePath(files.workerProofPath, sidecarId),
    workerPublicKeySpkiDerBase64: WORKER_PUBLIC_BASE64,
    workerPublicKeySha256: WORKER_PUBLIC_SHA256,
    stateUpdatedAt: AT,
    ...overrides,
  };
  writePrivateJson(files.workerProofPath, sidecar);
  return sidecar;
}

function writeRunningControl(
  rootDir: string,
  active: ManagedBridgeIpcSubject,
  pid: number,
  buildIdentity = active.build,
): void {
  const files = codexBridgeRunFiles(active.projectId, "codex", active.runId, rootDir);
  writePrivateJson(files.pidPath, {
    version: 4,
    state: "RUNNING",
    pid,
    projectRoot: resolve(rootDir, "project"),
    buildIdentity,
    workerProofMode: "required",
    projectId: active.projectId,
    agentId: "codex",
    runId: active.runId,
    ownerNonce: "owner_runtime_adapter",
    threadId: active.originalThreadId,
    launchReservation: null,
    startedAt: AT,
    entry: resolve(rootDir, "release", "bin.js"),
    logPath: resolve(rootDir, "bridge.log"),
    updatedAt: AT,
  });
}

function coordinator(input: {
  adapter: ManagedBridgeRuntimeAdapter;
  store: FileManagedBridgeRuntimeCommandStore;
  controlLease: Lease;
  journalLease: Lease;
}) {
  return new ManagedBridgeRuntimeCoordinator({
    ...input,
    now: () => Date.parse(AT),
    createChallengeId: () => "d".repeat(64),
  });
}

function proxyAdapter(
  target: ProductionManagedBridgeRuntimeAdapter,
  beforeDispatch?: (command: ManagedBridgeRuntimeCommand) => void | Promise<void>,
  afterDispatch?: (command: ManagedBridgeRuntimeCommand) => void | Promise<void>,
): ManagedBridgeRuntimeAdapter {
  return {
    enumerateDesired: () => target.enumerateDesired(),
    enumerateSidecars: (key) => target.enumerateSidecars(key),
    challengeWorker: (input) => target.challengeWorker(input),
    readReleaseAuthorization: (input) => target.readReleaseAuthorization(input),
    dispatch: async (command) => {
      await beforeDispatch?.(command);
      const receipt = await target.dispatch(command);
      await afterDispatch?.(command);
      return receipt;
    },
  };
}

describe("production managed runtime lifecycle", () => {
  it("persists RUNNING registration and seals one exact idempotent STOPPED receipt", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });

    const running = await registrations.persistRunning({
      subject: active,
      launch: launch(rootDir),
    });
    const stopped = await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    const replay = await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });

    expect(running).toMatchObject({ revision: 0, desiredState: "RUNNING", stopReceipt: null });
    expect(stopped).toMatchObject({
      revision: 1,
      desiredState: "STOPPED",
      stopReceipt: {
        kind: "DESIRED_STOP_PERSISTED",
        desiredRevision: 1,
        subjectKey: managedBridgeActiveSubjectKey(active),
      },
    });
    expect(replay).toEqual(stopped);
    await expect(
      registrations.persistRunning({ subject: active, launch: launch(rootDir) }),
    ).rejects.toThrow(/cannot be revived/i);
  });

  it("fences command CLAIMED/list/CAS by the exact active journal lease", async () => {
    const rootDir = root();
    const active = subject();
    const commands = new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() });
    const lease = new Lease("journal", 3);
    const fence: ManagedBridgeRuntimeLeaseFence = {
      schemaVersion: 1,
      controlLeaseId: "lease_control",
      controlLeaseGeneration: 2,
      journalLeaseId: lease.leaseId,
      journalLeaseGeneration: lease.generation,
    };
    const commandId = "e".repeat(64);
    const requestHash = "f".repeat(64);
    const recoverySidecar = writeSidecar(rootDir, active);
    const command: ManagedBridgeRuntimeCommand = {
      schemaVersion: 1,
      kind: "START_EXACT",
      commandId,
      requestHash,
      subject: active,
      desiredRevision: 0,
      leaseFence: fence,
      recoverySidecar,
    };
    const claimed: ManagedBridgeRuntimeCommandJournal = {
      schemaVersion: 1,
      revision: 0,
      commandId,
      requestHash,
      state: "CLAIMED",
      command,
      attemptFences: [fence],
      receipt: null,
    };

    lease.active = false;
    await expect(commands.compareAndSwap(commandId, null, claimed, lease)).rejects.toThrow(
      /lease inactive/i,
    );
    lease.active = true;
    expect(await commands.compareAndSwap(commandId, null, claimed, lease)).toBe(true);
    expect(await commands.listClaimed()).toEqual([claimed]);
    const replacementLease = new Lease("replacement", 4);
    await expect(
      commands.compareAndSwap(commandId, 0, { ...claimed, revision: 1 }, replacementLease),
    ).rejects.toThrow(/lease fence/i);
  });

  it("persists one ALREADY_STOPPED effect CAS with zero start/stop process launches", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    writeSidecar(rootDir, active);
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    let starts = 0;
    let stops = 0;
    const adapter = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: (fence) => {
        expect(fence.controlLeaseId).toBe(controlLease.leaseId);
        expect(fence.journalLeaseId).toBe(journalLease.leaseId);
      },
      startProcess: async () => {
        starts += 1;
        throw new Error("must not spawn");
      },
      stopProcess: async () => {
        stops += 1;
        throw new Error("must not stop a terminal worker");
      },
      ...acl(),
    });
    const commandStore = new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() });

    const [outcome] = await coordinator({
      adapter,
      store: commandStore,
      controlLease,
      journalLease,
    }).reconcileAll();

    expect(outcome).toMatchObject({ status: "ALREADY_STOPPED", disposition: "APPLIED" });
    expect(starts).toBe(0);
    expect(stops).toBe(0);
    const effectFiles = readdirSync(resolve(rootDir, "runtime-lifecycle", "effects")).filter(
      (name) => name.endsWith(".json"),
    );
    expect(effectFiles).toHaveLength(1);
  });

  it("never treats a live exact control with a missing required sidecar as already stopped", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    writeRunningControl(rootDir, active, 55_420);
    let stops = 0;
    const adapter = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      stopProcess: async () => {
        stops += 1;
        throw new Error("must not stop without exact worker proof");
      },
      ...acl(),
    });

    await expect(
      coordinator({
        adapter,
        store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
        controlLease: new Lease("control"),
        journalLease: new Lease("journal"),
      }).reconcileAll(),
    ).rejects.toThrow(/control record exists without its required worker sidecar/i);
    expect(stops).toBe(0);
  });

  it("rejects a terminal worker sidecar while the exact control record is still active", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    writeSidecar(rootDir, active, { state: "STOPPED" });
    writeRunningControl(rootDir, active, 55_421);

    await expect(
      coordinator({
        adapter: new ProductionManagedBridgeRuntimeAdapter({
          rootDir,
          registrationStore: registrations,
          assertLeaseFence: () => undefined,
          ...acl(),
        }),
        store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
        controlLease: new Lease("control"),
        journalLease: new Lease("journal"),
      }).reconcileAll(),
    ).rejects.toThrow(/terminal worker sidecar conflicts with an active control record/i);
  });

  it("starts only the exact terminal run identity and persists a STARTED receipt", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    writeSidecar(rootDir, active, { state: "EXITED" });
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    let starts = 0;
    const adapter = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      startProcess: async (input) => {
        starts += 1;
        expect(input).toMatchObject({
          projectId: active.projectId,
          threadId: active.originalThreadId,
          expectedRunId: active.runId,
          workerProofMode: "required",
          buildIdentity: active.build,
        });
        return {
          record: {
            projectId: active.projectId,
            runId: active.runId,
            threadId: active.originalThreadId,
            pid: 54_321,
          },
          alreadyRunning: false,
        };
      },
      ...acl(),
    });

    const [outcome] = await coordinator({
      adapter,
      store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
      controlLease,
      journalLease,
    }).reconcileAll();

    expect(outcome).toMatchObject({ status: "STARTED", disposition: "APPLIED" });
    expect(starts).toBe(1);
  });

  it("rejects desired drift inside the effect Adapter before start", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    writeSidecar(rootDir, active, { state: "EXITED" });
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    let starts = 0;
    const production = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      startProcess: async () => {
        starts += 1;
        throw new Error("must not start after drift");
      },
      ...acl(),
    });
    const adapter = proxyAdapter(production, async () => {
      await registrations.sealStopped({
        projectId: active.projectId,
        originalThreadId: active.originalThreadId,
        runId: active.runId,
      });
    });

    await expect(
      coordinator({
        adapter,
        store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
        controlLease,
        journalLease,
      }).reconcileAll(),
    ).rejects.toMatchObject({ code: "EFFECT_RESPONSE_UNKNOWN" });
    expect(starts).toBe(0);
  });

  it("rejects sidecar drift inside the effect Adapter before start", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    writeSidecar(rootDir, active, { state: "EXITED" });
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    let starts = 0;
    const production = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      startProcess: async () => {
        starts += 1;
        throw new Error("must not start after drift");
      },
      ...acl(),
    });
    const adapter = proxyAdapter(production, () => {
      writeSidecar(rootDir, active, { state: "EXITED", revision: 5 });
    });

    await expect(
      coordinator({
        adapter,
        store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
        controlLease,
        journalLease,
      }).reconcileAll(),
    ).rejects.toMatchObject({ code: "EFFECT_RESPONSE_UNKNOWN" });
    expect(starts).toBe(0);
  });

  it("rejects PID reuse when the exact control PID no longer matches the running sidecar", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    const running = writeSidecar(rootDir, active, { state: "RUNNING", pid: 44_210 });
    writeRunningControl(rootDir, active, running.pid!);
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    let stops = 0;
    const production = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      stopProcess: async () => {
        stops += 1;
        throw new Error("must not stop reused PID");
      },
      ...acl(),
    });
    const adapter = proxyAdapter(production, () => {
      writeRunningControl(rootDir, active, running.pid! + 1);
    });

    await expect(
      coordinator({
        adapter,
        store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
        controlLease,
        journalLease,
      }).reconcileAll(),
    ).rejects.toMatchObject({ code: "EFFECT_RESPONSE_UNKNOWN" });
    expect(stops).toBe(0);
  });

  it("rejects a RUNNING control whose build identity drifts from the sealed subject", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    const running = writeSidecar(rootDir, active, { state: "RUNNING", pid: 44_211 });
    writeRunningControl(rootDir, active, running.pid!, {
      ...active.build,
      buildId: "d".repeat(64),
    });
    let stops = 0;

    await expect(
      coordinator({
        adapter: new ProductionManagedBridgeRuntimeAdapter({
          rootDir,
          registrationStore: registrations,
          assertLeaseFence: () => undefined,
          stopProcess: async () => {
            stops += 1;
            throw new Error("must not stop a drifted build");
          },
          ...acl(),
        }),
        store: new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() }),
        controlLease: new Lease("control"),
        journalLease: new Lease("journal"),
      }).reconcileAll(),
    ).rejects.toThrow(/control identity does not match the worker sidecar/i);
    expect(stops).toBe(0);
  });

  it("replays a durable effect after response loss without a second process launch", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    writeSidecar(rootDir, active, { state: "EXITED" });
    const controlLease = new Lease("control");
    const journalLease = new Lease("journal");
    let starts = 0;
    let loseFirstResponse = true;
    const production = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      startProcess: async () => {
        starts += 1;
        return {
          record: {
            projectId: active.projectId,
            runId: active.runId,
            threadId: active.originalThreadId,
            pid: 55_432,
          },
          alreadyRunning: false,
        };
      },
      ...acl(),
    });
    const adapter = proxyAdapter(production, undefined, () => {
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("response lost after durable effect");
      }
    });
    const commandStore = new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() });
    const runtime = coordinator({ adapter, store: commandStore, controlLease, journalLease });

    await expect(runtime.reconcileAll()).rejects.toMatchObject({
      code: "EFFECT_RESPONSE_UNKNOWN",
    });
    controlLease.active = false;
    journalLease.active = false;
    const [recovered] = await coordinator({
      adapter,
      store: commandStore,
      controlLease: new Lease("successor-control", 2),
      journalLease: new Lease("successor-journal", 2),
    }).reconcileAll();

    expect(recovered).toMatchObject({ status: "STARTED", disposition: "RECOVERED" });
    expect(starts).toBe(1);
    expect(await commandStore.listClaimed()).toEqual([]);
  });

  it("recovers a START crash after process effect but before the receiver receipt", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    writeSidecar(rootDir, active, { state: "EXITED" });
    let fenceChecks = 0;
    let startCalls = 0;
    let spawnEffects = 0;
    let running = false;
    const adapter = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => {
        fenceChecks += 1;
        if (fenceChecks === 5) throw new Error("lease lost after exact start effect");
      },
      startProcess: async (input) => {
        startCalls += 1;
        expect(input.expectedRunId).toBe(active.runId);
        if (!running) {
          running = true;
          spawnEffects += 1;
          writeSidecar(rootDir, active, { state: "RUNNING", pid: 55_433 });
          writeRunningControl(rootDir, active, 55_433);
        }
        return {
          record: {
            projectId: active.projectId,
            runId: active.runId,
            threadId: active.originalThreadId,
            pid: 55_433,
          },
          alreadyRunning: startCalls > 1,
        };
      },
      ...acl(),
    });
    const commandStore = new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() });

    await expect(
      coordinator({
        adapter,
        store: commandStore,
        controlLease: new Lease("predecessor-control"),
        journalLease: new Lease("predecessor-journal"),
      }).reconcileAll(),
    ).rejects.toMatchObject({ code: "EFFECT_RESPONSE_UNKNOWN" });
    const [recovered] = await coordinator({
      adapter,
      store: commandStore,
      controlLease: new Lease("successor-control", 2),
      journalLease: new Lease("successor-journal", 2),
    }).reconcileAll();

    expect(recovered).toMatchObject({ status: "STARTED", disposition: "RECOVERED" });
    expect(startCalls).toBe(2);
    expect(spawnEffects).toBe(1);
    expect(await commandStore.listClaimed()).toEqual([]);
  });

  it("recovers a STOP crash from its terminal sidecar without a second stop effect", async () => {
    const rootDir = root();
    const active = subject();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    await registrations.persistRunning({ subject: active, launch: launch(rootDir) });
    await registrations.sealStopped({
      projectId: active.projectId,
      originalThreadId: active.originalThreadId,
      runId: active.runId,
    });
    writeSidecar(rootDir, active, { state: "RUNNING", pid: 55_434 });
    const files = codexBridgeRunFiles(active.projectId, "codex", active.runId, rootDir);
    writeRunningControl(rootDir, active, 55_434);
    let fenceChecks = 0;
    let stopEffects = 0;
    const adapter = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => {
        fenceChecks += 1;
        if (fenceChecks === 5) throw new Error("lease lost after exact stop effect");
      },
      stopProcess: async () => {
        stopEffects += 1;
        writeSidecar(rootDir, active, { state: "STOPPED", pid: null, revision: 5 });
        unlinkSync(files.pidPath);
        return { stopped: true, stale: false, runId: active.runId };
      },
      ...acl(),
    });
    const commandStore = new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() });

    await expect(
      coordinator({
        adapter,
        store: commandStore,
        controlLease: new Lease("predecessor-control"),
        journalLease: new Lease("predecessor-journal"),
      }).reconcileAll(),
    ).rejects.toMatchObject({ code: "EFFECT_RESPONSE_UNKNOWN" });
    const [recovered] = await coordinator({
      adapter,
      store: commandStore,
      controlLease: new Lease("successor-control", 2),
      journalLease: new Lease("successor-journal", 2),
    }).reconcileAll();

    expect(recovered).toMatchObject({ status: "STOPPED", disposition: "RECOVERED" });
    expect(stopEffects).toBe(1);
    expect(await commandStore.listClaimed()).toEqual([]);
  });

  it("rejects secret-shaped durable command fields before any journal write", async () => {
    const rootDir = root();
    const active = subject();
    const commands = new FileManagedBridgeRuntimeCommandStore({ rootDir, ...acl() });
    const lease = new Lease("journal", 1);
    const fence: ManagedBridgeRuntimeLeaseFence = {
      schemaVersion: 1,
      controlLeaseId: "lease_control",
      controlLeaseGeneration: 1,
      journalLeaseId: lease.leaseId,
      journalLeaseGeneration: lease.generation,
    };
    const commandId = "a".repeat(64);
    const requestHash = "b".repeat(64);
    const command = {
      schemaVersion: 1,
      kind: "START_EXACT",
      commandId,
      requestHash,
      subject: active,
      desiredRevision: 0,
      leaseFence: fence,
      recoverySidecar: writeSidecar(rootDir, active),
      credential: "must-not-persist",
      authorizationHeader: "must-not-persist",
    } as unknown as ManagedBridgeRuntimeCommand;

    await expect(
      commands.compareAndSwap(
        commandId,
        null,
        {
          schemaVersion: 1,
          revision: 0,
          commandId,
          requestHash,
          state: "CLAIMED",
          command,
          attemptFences: [fence],
          receipt: null,
        },
        lease,
      ),
    ).rejects.toThrow(/Secret-shaped fields/i);
    expect(await commands.load(commandId)).toBeNull();
  });

  it("fails closed for release authorization and never synthesizes release authority", async () => {
    const rootDir = root();
    const registrations = new FileManagedBridgeRuntimeRegistrationStore({ rootDir, ...acl() });
    const adapter = new ProductionManagedBridgeRuntimeAdapter({
      rootDir,
      registrationStore: registrations,
      assertLeaseFence: () => undefined,
      ...acl(),
    });

    await expect(
      adapter.readReleaseAuthorization({ operationId: "rel_missing", subjectKey: SHA_A }),
    ).rejects.toThrow(/not configured/i);
  });
});
