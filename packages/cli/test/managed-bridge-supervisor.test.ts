import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileManagedBridgeSupervisorJournal,
  ManagedBridgeSupervisor,
  managedBridgeBackoff,
  managedBridgeSupervisorKey,
  type ManagedBridgeActiveSubjectAdapter,
  type ManagedBridgeIdentity,
  type ManagedBridgeProbeAdapter,
  type ManagedBridgeSupervisorJournal,
  type ManagedBridgeSupervisorStore,
} from "../src/managed-bridge-supervisor.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identity(overrides: Partial<ManagedBridgeIdentity> = {}): ManagedBridgeIdentity {
  return {
    projectId: "prj_supervisor",
    agentId: "codex",
    runId: "run_supervisor",
    originalThreadId: "thr_original",
    projectRoot: "R:\\Project_All\\project",
    entry: "R:\\Project_All\\ayanamiAgent Hub\\packages\\codex-bridge\\dist\\cli.js",
    build: {
      buildId: "1".repeat(64),
      buildSessionId: "123e4567-e89b-42d3-a456-426614174000",
      protocolId: "2".repeat(64),
      manifestSha256: "3".repeat(64),
      migrationId: "4".repeat(64),
    },
    recovery: {
      sessionId: "ses_exact",
      lineageId: "lin_exact",
      incarnation: 7,
      bundleId: "stb_exact",
      vaultPath: "C:\\Users\\test\\.crossagent\\vault.json",
      vaultSha256: "a".repeat(64),
      checkpointPath: "C:\\Users\\test\\.crossagent\\checkpoint.json",
      checkpointSha256: "b".repeat(64),
      checkpointEventSequence: 91,
    },
    ...overrides,
  };
}

class MemoryActiveSubjects implements ManagedBridgeActiveSubjectAdapter {
  readonly running = new Map<string, ManagedBridgeIdentity>();
  readonly events: string[] = [];

  async ensureRunning(subject: ManagedBridgeIdentity): Promise<void> {
    const key = `${subject.projectId}\0${subject.originalThreadId}`;
    const current = this.running.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(subject)) {
      throw new Error("ACTIVE_SUBJECT_CONFLICT");
    }
    this.events.push(`ensure:${subject.runId}`);
    this.running.set(key, structuredClone(subject));
  }

  async advanceRunning(
    expected: ManagedBridgeIdentity,
    next: ManagedBridgeIdentity,
  ): Promise<void> {
    const key = `${expected.projectId}\0${expected.originalThreadId}`;
    const current = this.running.get(key);
    if (!current) throw new Error("ACTIVE_SUBJECT_MISSING");
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error("ACTIVE_SUBJECT_MISMATCH");
    }
    this.events.push(`advance:${expected.recovery.sessionId}->${next.recovery.sessionId}`);
    this.running.set(key, structuredClone(next));
  }

  async stop(subject: ManagedBridgeIdentity): Promise<void> {
    const key = `${subject.projectId}\0${subject.originalThreadId}`;
    const current = this.running.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(subject)) {
      throw new Error("ACTIVE_SUBJECT_MISMATCH");
    }
    this.events.push(`stop:${subject.runId}`);
    this.running.delete(key);
  }
}

function createSupervisor(
  options: Omit<ConstructorParameters<typeof ManagedBridgeSupervisor>[0], "activeSubjects"> & {
    activeSubjects?: ManagedBridgeActiveSubjectAdapter;
  },
): ManagedBridgeSupervisor {
  return new ManagedBridgeSupervisor({
    ...options,
    activeSubjects: options.activeSubjects ?? new MemoryActiveSubjects(),
  });
}

class MemoryStore implements ManagedBridgeSupervisorStore {
  readonly values = new Map<string, ManagedBridgeSupervisorJournal>();

  async load(key: string): Promise<ManagedBridgeSupervisorJournal | null> {
    return structuredClone(this.values.get(key) ?? null);
  }

  async compareAndSwap(
    key: string,
    expectedRevision: number | null,
    next: ManagedBridgeSupervisorJournal,
  ): Promise<boolean> {
    const current = this.values.get(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    this.values.set(key, structuredClone(next));
    return true;
  }
}

function fuseOpen(subject: ManagedBridgeIdentity, fuseGeneration = 11) {
  return {
    kind: "FUSE_OPEN" as const,
    identity: structuredClone(subject),
    fuseGeneration,
  };
}

function healthy(subject: ManagedBridgeIdentity, fuseGeneration = 0) {
  return {
    kind: "HEALTHY" as const,
    identity: structuredClone(subject),
    fuseGeneration,
  };
}

function recovered(command: Parameters<ManagedBridgeProbeAdapter["issue"]>[0]) {
  return {
    kind: "RECOVERED" as const,
    commandId: command.commandId,
    commandGeneration: command.commandGeneration,
    fuseGeneration: command.fuseGeneration,
    identity: structuredClone(command.identity),
    stability: "STABLE" as const,
  };
}

async function openAndReachDue(input: {
  supervisor: ManagedBridgeSupervisor;
  store: ManagedBridgeSupervisorStore;
  identity: ManagedBridgeIdentity;
  setNow: (value: number) => void;
}): Promise<ManagedBridgeSupervisorJournal> {
  await input.supervisor.ensureRunning(input.identity);
  await input.supervisor.reconcile(input.identity);
  const opened = await input.store.load(managedBridgeSupervisorKey(input.identity));
  expect(opened?.circuit).toBe("OPEN");
  input.setNow(Date.parse(opened!.nextAttemptAt!));
  return opened!;
}

describe("ManagedBridgeSupervisor", () => {
  it("rejects incomplete or non-canonical five-field build identity before any Adapter side effect", async () => {
    const store = new MemoryStore();
    const activeSubjects = new MemoryActiveSubjects();
    const probe: ManagedBridgeProbeAdapter = {
      inspect: vi.fn(async () => healthy(identity())),
      issue: vi.fn(async (command) => recovered(command)),
    };
    const supervisor = createSupervisor({ store, activeSubjects, probe });
    const invalidUuid = identity({
      build: { ...identity().build, buildSessionId: "not-a-build-session-uuid" },
    });
    await expect(supervisor.ensureRunning(invalidUuid)).rejects.toThrow(/UUID/);
    const missingMigration = identity({
      build: Object.fromEntries(
        Object.entries(identity().build).filter(([key]) => key !== "migrationId"),
      ) as ManagedBridgeIdentity["build"],
    });
    await expect(supervisor.ensureRunning(missingMigration)).rejects.toThrow(
      /Missing supervisor field: migrationId/,
    );
    expect(activeSubjects.events).toEqual([]);
    expect(store.values.size).toBe(0);
    expect(probe.inspect).not.toHaveBeenCalled();
    expect(probe.issue).not.toHaveBeenCalled();
  });

  it("uses the frozen 5s/30s/2m/10m/30m schedule with deterministic capped jitter", () => {
    const subject = identity();
    const bases = [5_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000];
    for (let failureCount = 1; failureCount <= bases.length; failureCount += 1) {
      const first = managedBridgeBackoff(subject, 9, failureCount);
      const replay = managedBridgeBackoff(subject, 9, failureCount);
      expect(first).toEqual(replay);
      expect(first.baseMs).toBe(bases[failureCount - 1]);
      expect(first.delayMs).toBeGreaterThanOrEqual(Math.floor(first.baseMs * 0.8));
      expect(first.delayMs).toBeLessThanOrEqual(1_800_000);
    }
    expect(managedBridgeBackoff(identity({ runId: "run_other" }), 9, 2).delayMs).not.toBe(
      managedBridgeBackoff(subject, 9, 2).delayMs,
    );
  });

  it("writes HALF_OPEN and the exact command before issuing one stable recovery", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let issued = 0;
    const probe: ManagedBridgeProbeAdapter = {
      inspect: async () => fuseOpen(subject),
      issue: async (command) => {
        issued += 1;
        const durable = await store.load(managedBridgeSupervisorKey(subject));
        expect(durable).toMatchObject({
          circuit: "HALF_OPEN",
          activeCommand: { commandId: command.commandId },
        });
        return recovered(command);
      },
    };
    const supervisor = createSupervisor({
      store,
      probe,
      instanceId: "supervisor-a",
      now: () => now,
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });

    await supervisor.reconcile(subject);

    expect(issued).toBe(1);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      failureCount: 0,
      activeCommand: null,
    });
  });

  it("replays the same idempotent command after a lost response and process restart", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const commandIds: string[] = [];
    const first = createSupervisor({
      store,
      instanceId: "supervisor-before-crash",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          commandIds.push(command.commandId);
          throw new Error("injected lost response after dispatch");
        },
      },
    });
    await openAndReachDue({
      supervisor: first,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    await expect(first.reconcile(subject)).resolves.toMatchObject({ circuit: "HALF_OPEN" });
    const ambiguous = await first.status(subject);
    expect(ambiguous).toMatchObject({ circuit: "HALF_OPEN", activeCommand: { dispatchCount: 1 } });
    now = Date.parse(ambiguous!.nextAttemptAt!);

    const restarted = createSupervisor({
      store,
      instanceId: "supervisor-after-crash",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          commandIds.push(command.commandId);
          return recovered(command);
        },
      },
    });
    await restarted.reconcile(subject);

    expect(commandIds).toHaveLength(2);
    expect(new Set(commandIds).size).toBe(1);
    await expect(restarted.status(subject)).resolves.toMatchObject({ circuit: "CLOSED" });
  });

  it("coalesces concurrent reconcile calls instead of dispatching a duplicate command", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    let issues = 0;
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-one-process",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          issues += 1;
          await gate;
          return recovered(command);
        },
      },
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });

    const a = supervisor.reconcile(subject);
    const b = supervisor.reconcile(subject);
    await vi.waitFor(() => expect(issues).toBe(1));
    release();
    await Promise.all([a, b]);

    expect(issues).toBe(1);
  });

  it("does not let a second supervisor steal an unexpired HALF_OPEN command claim", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    const commandIds: string[] = [];
    const probe: ManagedBridgeProbeAdapter = {
      inspect: async () => fuseOpen(subject),
      issue: async (command) => {
        commandIds.push(command.commandId);
        await gate;
        return recovered(command);
      },
    };
    const first = createSupervisor({
      store,
      probe,
      instanceId: "supervisor-cas-winner",
      now: () => now,
    });
    const second = createSupervisor({
      store,
      probe,
      instanceId: "supervisor-cas-loser",
      now: () => now,
    });
    await openAndReachDue({
      supervisor: first,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });

    const winner = first.reconcile(subject);
    const loser = second.reconcile(subject);
    await vi.waitFor(() => expect(commandIds).toHaveLength(1));
    await expect(loser).resolves.toMatchObject({
      circuit: "HALF_OPEN",
      activeCommand: { claimedBy: "supervisor-cas-winner" },
    });
    release();
    await winner;
    expect(commandIds).toHaveLength(1);
  });

  it("advances explicit failures through a new command generation", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const commands: Parameters<ManagedBridgeProbeAdapter["issue"]>[0][] = [];
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-explicit-failure",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          commands.push(command);
          if (commands.length === 1) {
            return {
              kind: "STILL_OPEN",
              commandId: command.commandId,
              commandGeneration: command.commandGeneration,
              fuseGeneration: command.fuseGeneration,
              identity: command.identity,
              reason: "worker fuse remains open",
            };
          }
          return recovered(command);
        },
      },
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    await supervisor.reconcile(subject);
    const secondOpen = (await supervisor.status(subject))!;
    expect(secondOpen).toMatchObject({ circuit: "OPEN", failureCount: 2 });
    now = Date.parse(secondOpen.nextAttemptAt!);
    await supervisor.reconcile(subject);
    expect(commands).toHaveLength(2);
    expect(commands[1]!.commandGeneration).toBe(commands[0]!.commandGeneration + 1);
    expect(commands[1]!.commandId).not.toBe(commands[0]!.commandId);
    await expect(supervisor.status(subject)).resolves.toMatchObject({ circuit: "CLOSED" });
  });

  it("blocks a malformed Adapter result instead of treating typed IPC as trusted", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-malformed-result",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) =>
          ({ ...recovered(command), stability: "WARM" }) as unknown as ReturnType<typeof recovered>,
      },
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "BLOCKED",
      blockedReason: expect.stringContaining("INVALID_COMMAND_RESULT"),
    });
  });

  it("adopts a monotonic healthy checkpoint proof but blocks a proof regression", async () => {
    const store = new MemoryStore();
    const subject = identity();
    const advanced = identity({
      recovery: {
        ...subject.recovery,
        bundleId: "stb_auxiliary",
        vaultSha256: "c".repeat(64),
        checkpointSha256: "d".repeat(64),
        checkpointEventSequence: 92,
      },
    });
    let observation: Awaited<ReturnType<ManagedBridgeProbeAdapter["inspect"]>> = healthy(
      advanced,
      7,
    );
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-proof-refresh",
      probe: {
        inspect: async () => observation,
        issue: async (command) => recovered(command),
      },
    });
    await supervisor.ensureRunning(subject);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      identity: advanced,
    });

    observation = healthy(subject, 7);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "BLOCKED",
      blockedReason: "RECOVERY_PROOF_REGRESSION",
      identity: advanced,
    });
  });

  it("ignores an ABA-late result after another owner has fenced the command", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-old-owner",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          await gate;
          return recovered(command);
        },
      },
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    const pending = supervisor.reconcile(subject);
    await vi.waitFor(async () => {
      expect((await supervisor.status(subject))?.circuit).toBe("HALF_OPEN");
    });
    const current = (await supervisor.status(subject))!;
    await store.compareAndSwap(managedBridgeSupervisorKey(subject), current.revision, {
      ...current,
      revision: current.revision + 1,
      circuit: "BLOCKED",
      blockedReason: "BUILD_ID_MISMATCH",
      activeCommand: null,
      nextAttemptAt: null,
      updatedAt: new Date(now + 1).toISOString(),
    });
    release();
    await pending;

    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "BLOCKED",
      blockedReason: "BUILD_ID_MISMATCH",
    });
  });

  it("blocks a mismatched result and never adopts a different build or recovery proof", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-mismatch",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) =>
          recovered({
            ...command,
            identity: identity({
              build: { ...subject.build, manifestSha256: "f".repeat(64) },
            }),
          }),
      },
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "BLOCKED",
      blockedReason: "COMMAND_RESULT_BINDING_MISMATCH",
    });

    const altered = identity({
      recovery: { ...subject.recovery, checkpointSha256: "c".repeat(64) },
    });
    await expect(supervisor.ensureRunning(altered)).resolves.toMatchObject({
      circuit: "BLOCKED",
      identity: subject,
    });
  });

  it("persists the last observed fuse generation, ignores stale reopen, and accepts only N+1", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let observation: Awaited<ReturnType<ManagedBridgeProbeAdapter["inspect"]>> = healthy(
      subject,
      0,
    );
    const issue = vi.fn(async (command) => recovered(command));
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-fuse-monotonic",
      now: () => now,
      probe: { inspect: async () => observation, issue },
    });
    await supervisor.ensureRunning(subject);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      lastObservedFuseGeneration: 0,
    });

    observation = fuseOpen(subject, 1);
    await supervisor.reconcile(subject);
    const opened = (await supervisor.status(subject))!;
    now = Date.parse(opened.nextAttemptAt!);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      lastObservedFuseGeneration: 1,
    });
    expect(issue).toHaveBeenCalledTimes(1);

    observation = fuseOpen(subject, 1);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      lastObservedFuseGeneration: 1,
    });
    expect(issue).toHaveBeenCalledTimes(1);

    observation = fuseOpen(subject, 2);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "OPEN",
      fuseGeneration: 2,
      lastObservedFuseGeneration: 2,
    });
  });

  it("blocks a fuse generation gap after the durable generation was established", async () => {
    const store = new MemoryStore();
    const subject = identity();
    let observation: Awaited<ReturnType<ManagedBridgeProbeAdapter["inspect"]>> = healthy(
      subject,
      4,
    );
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-fuse-gap",
      probe: {
        inspect: async () => observation,
        issue: async (command) => recovered(command),
      },
    });
    await supervisor.ensureRunning(subject);
    await supervisor.reconcile(subject);
    observation = fuseOpen(subject, 6);
    await supervisor.reconcile(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      circuit: "BLOCKED",
      blockedReason: "FUSE_GENERATION_GAP",
      lastObservedFuseGeneration: 4,
    });
  });

  it("treats UNKNOWN, STARTING, and RECOVERING as transient rather than permanently blocked", async () => {
    for (const kind of ["UNKNOWN", "STARTING", "RECOVERING"] as const) {
      const store = new MemoryStore();
      const subject = identity({ runId: `run_${kind.toLowerCase()}` });
      const issue = vi.fn(async (command) => recovered(command));
      const supervisor = createSupervisor({
        store,
        instanceId: `supervisor-${kind.toLowerCase()}`,
        probe: {
          inspect: async () => ({ kind, identity: subject, fuseGeneration: 0 }),
          issue,
        },
      });
      await supervisor.ensureRunning(subject);
      await supervisor.reconcile(subject);
      await expect(supervisor.status(subject)).resolves.toMatchObject({
        circuit: "CLOSED",
        desiredState: "RUNNING",
        blockedReason: null,
        lastObservedFuseGeneration: 0,
      });
      expect(issue).not.toHaveBeenCalled();
    }
  });

  it("re-inspects an expired HALF_OPEN claim, fences an AUX rebind, and signs a new command", async () => {
    const store = new MemoryStore();
    const activeSubjects = new MemoryActiveSubjects();
    const subject = identity();
    const rebound = identity({
      recovery: {
        ...subject.recovery,
        sessionId: "ses_auxiliary",
        incarnation: subject.recovery.incarnation + 1,
        bundleId: "stb_auxiliary",
        vaultSha256: "c".repeat(64),
        checkpointSha256: "d".repeat(64),
        checkpointEventSequence: subject.recovery.checkpointEventSequence + 1,
      },
    });
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let inspectSubject = subject;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolveGate) => (releaseOld = resolveGate));
    const commands: Parameters<ManagedBridgeProbeAdapter["issue"]>[0][] = [];
    const probe: ManagedBridgeProbeAdapter = {
      inspect: async () => fuseOpen(inspectSubject, 11),
      issue: async (command) => {
        commands.push(command);
        if (commands.length === 1) {
          await oldGate;
          return recovered(command);
        }
        return recovered(command);
      },
    };
    const oldOwner = createSupervisor({
      store,
      activeSubjects,
      probe,
      instanceId: "supervisor-old-half-open-owner",
      now: () => now,
      commandLeaseMs: 1_000,
    });
    await openAndReachDue({
      supervisor: oldOwner,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    const oldPending = oldOwner.reconcile(subject);
    await vi.waitFor(() => expect(commands).toHaveLength(1));

    now += 1_001;
    inspectSubject = rebound;
    const newOwner = createSupervisor({
      store,
      activeSubjects,
      probe,
      instanceId: "supervisor-new-half-open-owner",
      now: () => now,
      commandLeaseMs: 1_000,
    });
    await newOwner.reconcile(subject);
    expect(commands).toHaveLength(2);
    expect(commands[1]!.commandId).not.toBe(commands[0]!.commandId);
    expect(commands[1]!.identity).toEqual(rebound);
    await expect(newOwner.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      identity: rebound,
      lastObservedFuseGeneration: 11,
    });

    releaseOld();
    await oldPending;
    await expect(newOwner.status(subject)).resolves.toMatchObject({
      circuit: "CLOSED",
      identity: rebound,
    });
  });

  it("rejects two active runs for one project and original thread before creating the loser journal", async () => {
    const store = new MemoryStore();
    const activeSubjects = new MemoryActiveSubjects();
    const firstSubject = identity();
    const conflicting = identity({ runId: "run_conflicting" });
    const first = createSupervisor({
      store,
      activeSubjects,
      probe: {
        inspect: async () => healthy(firstSubject),
        issue: async (command) => recovered(command),
      },
    });
    const second = createSupervisor({
      store,
      activeSubjects,
      probe: {
        inspect: async () => healthy(conflicting),
        issue: async (command) => recovered(command),
      },
    });
    await first.ensureRunning(firstSubject);
    await expect(second.ensureRunning(conflicting)).rejects.toThrow(/ACTIVE_SUBJECT_CONFLICT/);
    await expect(second.status(conflicting)).resolves.toBeNull();
  });

  it("rebinds and rolls back only an exact STOPPED release identity", async () => {
    const store = new MemoryStore();
    const activeSubjects = new MemoryActiveSubjects();
    const previous = identity();
    const candidate = identity({
      entry: "R:\\Project_All\\ayanamiAgent Hub\\releases\\candidate\\cli.js",
      build: {
        buildId: "5".repeat(64),
        buildSessionId: "123e4567-e89b-42d3-a456-426614174001",
        protocolId: "6".repeat(64),
        manifestSha256: "7".repeat(64),
        migrationId: "8".repeat(64),
      },
    });
    const supervisor = createSupervisor({
      store,
      activeSubjects,
      probe: {
        inspect: async () => healthy(previous),
        issue: async (command) => recovered(command),
      },
    });
    await supervisor.ensureRunning(previous);
    await expect(supervisor.rebindRelease(previous, candidate)).rejects.toThrow(/STOPPED/);
    await supervisor.requestStop(previous);
    await expect(supervisor.rebindRelease(previous, candidate)).resolves.toMatchObject({
      desiredState: "STOPPED",
      identity: candidate,
    });
    await expect(supervisor.rebindRelease(previous, candidate)).resolves.toMatchObject({
      identity: candidate,
    });
    await expect(supervisor.rollbackRelease(candidate, previous)).resolves.toMatchObject({
      desiredState: "STOPPED",
      identity: previous,
    });
  });

  it("persists STOPPED before active-subject release and ignores an in-flight late recovery", async () => {
    const store = new MemoryStore();
    const activeSubjects = new MemoryActiveSubjects();
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    const supervisor = createSupervisor({
      store,
      activeSubjects,
      instanceId: "supervisor-stop-fence",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          await gate;
          return recovered(command);
        },
      },
    });
    await openAndReachDue({
      supervisor,
      store,
      identity: subject,
      setNow: (value) => (now = value),
    });
    const pending = supervisor.reconcile(subject);
    await vi.waitFor(async () =>
      expect((await supervisor.status(subject))?.circuit).toBe("HALF_OPEN"),
    );
    await supervisor.requestStop(subject);
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      desiredState: "STOPPED",
      activeCommand: null,
    });
    expect(activeSubjects.events.at(-1)).toBe(`stop:${subject.runId}`);
    release();
    await pending;
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      desiredState: "STOPPED",
      activeCommand: null,
    });
  });

  it("keeps the durable STOPPED fence when active-subject release loses its receipt", async () => {
    const store = new MemoryStore();
    const base = new MemoryActiveSubjects();
    const subject = identity();
    const activeSubjects: ManagedBridgeActiveSubjectAdapter = {
      ensureRunning: (value) => base.ensureRunning(value),
      advanceRunning: (expected, next) => base.advanceRunning(expected, next),
      stop: async (value) => {
        const durable = await store.load(managedBridgeSupervisorKey(value));
        expect(durable?.desiredState).toBe("STOPPED");
        throw new Error("injected lost active-subject STOP receipt");
      },
    };
    const supervisor = createSupervisor({
      store,
      activeSubjects,
      probe: {
        inspect: async () => healthy(subject),
        issue: async (command) => recovered(command),
      },
    });
    await supervisor.ensureRunning(subject);
    await expect(supervisor.requestStop(subject)).rejects.toThrow(
      /lost active-subject STOP receipt/,
    );
    await expect(supervisor.status(subject)).resolves.toMatchObject({
      desiredState: "STOPPED",
      activeCommand: null,
    });
  });

  it("honors desired STOPPED without inspecting or issuing", async () => {
    const store = new MemoryStore();
    const subject = identity();
    const inspect = vi.fn(async () => fuseOpen(subject));
    const issue = vi.fn(async (command) => recovered(command));
    const supervisor = createSupervisor({
      store,
      probe: { inspect, issue },
      instanceId: "supervisor-stop",
    });
    await supervisor.ensureRunning(subject);
    await supervisor.requestStop(subject);
    await supervisor.reconcile(subject);
    expect(inspect).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    await expect(supervisor.status(subject)).resolves.toMatchObject({ desiredState: "STOPPED" });
  });
});

describe("FileManagedBridgeSupervisorJournal", () => {
  it("persists an owner-private CAS journal across restart and rejects stale revisions", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-supervisor-journal-"));
    roots.push(root);
    const lease = { assertActive: vi.fn() };
    const store = new FileManagedBridgeSupervisorJournal({ rootDir: root, lease });
    const subject = identity();
    const supervisor = createSupervisor({
      store,
      instanceId: "supervisor-file",
      probe: {
        inspect: async () => healthy(subject),
        issue: async (command) => recovered(command),
      },
    });
    const created = await supervisor.ensureRunning(subject);
    const cold = new FileManagedBridgeSupervisorJournal({ rootDir: root, lease });
    await expect(cold.load(managedBridgeSupervisorKey(subject))).resolves.toEqual(created);
    await expect(
      cold.compareAndSwap(managedBridgeSupervisorKey(subject), created.revision - 1, {
        ...created,
        revision: created.revision + 1,
      }),
    ).resolves.toBe(false);
    expect(lease.assertActive).toHaveBeenCalled();
    const raw = readFileSync(store.pathFor(managedBridgeSupervisorKey(subject)), "utf8");
    expect(raw).not.toMatch(/token|credential|MODEL_MCP|raw/i);
  });

  it("keeps the last committed revision when an injected atomic rename crashes", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-supervisor-rename-"));
    roots.push(root);
    const subject = identity();
    const stable = new FileManagedBridgeSupervisorJournal({
      rootDir: root,
      lease: { assertActive: () => undefined },
    });
    const supervisor = createSupervisor({
      store: stable,
      instanceId: "supervisor-stable",
      probe: {
        inspect: async () => healthy(subject),
        issue: async (command) => recovered(command),
      },
    });
    const committed = await supervisor.ensureRunning(subject);
    const faulted = new FileManagedBridgeSupervisorJournal({
      rootDir: root,
      lease: { assertActive: () => undefined },
      fileAdapters: {
        rename: (oldPath, newPath) => {
          chmodSync(oldPath, 0o600);
          throw new Error(`injected crash before ${newPath}`);
        },
      },
    });
    await expect(
      faulted.compareAndSwap(managedBridgeSupervisorKey(subject), committed.revision, {
        ...committed,
        revision: committed.revision + 1,
        desiredState: "STOPPED",
      }),
    ).rejects.toThrow(/injected crash/);
    await expect(stable.load(managedBridgeSupervisorKey(subject))).resolves.toEqual(committed);
  });

  it("cold-restarts an ambiguous command from the durable journal without changing its id", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-supervisor-cold-replay-"));
    roots.push(root);
    const lease = { assertActive: () => undefined };
    const subject = identity();
    let now = Date.parse("2026-08-01T00:00:00.000Z");
    const commandIds: string[] = [];
    const beforeCrashStore = new FileManagedBridgeSupervisorJournal({ rootDir: root, lease });
    const beforeCrash = createSupervisor({
      store: beforeCrashStore,
      instanceId: "file-supervisor-before-crash",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          commandIds.push(command.commandId);
          throw new Error("injected response loss");
        },
      },
    });
    await openAndReachDue({
      supervisor: beforeCrash,
      store: beforeCrashStore,
      identity: subject,
      setNow: (value) => (now = value),
    });
    await beforeCrash.reconcile(subject);
    const ambiguous = (await beforeCrash.status(subject))!;
    now = Date.parse(ambiguous.nextAttemptAt!);

    const afterCrashStore = new FileManagedBridgeSupervisorJournal({ rootDir: root, lease });
    const afterCrash = createSupervisor({
      store: afterCrashStore,
      instanceId: "file-supervisor-after-crash",
      now: () => now,
      probe: {
        inspect: async () => fuseOpen(subject),
        issue: async (command) => {
          commandIds.push(command.commandId);
          return recovered(command);
        },
      },
    });
    await afterCrash.reconcile(subject);
    expect(commandIds).toHaveLength(2);
    expect(new Set(commandIds).size).toBe(1);
    await expect(afterCrash.status(subject)).resolves.toMatchObject({ circuit: "CLOSED" });
  });

  it("rejects secret-shaped or otherwise undeclared journal fields", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-supervisor-secret-field-"));
    roots.push(root);
    const subject = identity();
    const store = new FileManagedBridgeSupervisorJournal({
      rootDir: root,
      lease: { assertActive: () => undefined },
    });
    const supervisor = createSupervisor({
      store,
      probe: {
        inspect: async () => healthy(subject),
        issue: async (command) => recovered(command),
      },
    });
    const committed = await supervisor.ensureRunning(subject);
    await expect(
      store.compareAndSwap(managedBridgeSupervisorKey(subject), committed.revision, {
        ...committed,
        revision: committed.revision + 1,
        hubToken: "forbidden",
      } as unknown as ManagedBridgeSupervisorJournal),
    ).rejects.toThrow(/Unexpected supervisor field: hubToken/);
  });
});
