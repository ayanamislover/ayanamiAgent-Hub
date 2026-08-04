#!/usr/bin/env node
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import open from "open";
import { HubClient } from "@crossagent/client";
import { CodexBridge, CodexSessionTicketRuntime } from "@crossagent/codex-bridge";
import { probeClaude, probeCodex } from "./compatibility.js";
import { exportDiagnostics, collectDiagnostics } from "./diagnostics.js";
import { installClaudeChannel, installLifecycleHooks } from "./installers.js";
import {
  defaultBaseUrl,
  dataDir,
  logPath,
  readAgentToken,
  readAuthorityTrustManifest,
  readDashboardToken,
  readInjectorToken,
} from "./paths.js";
import {
  health,
  inspectHubRuntimeStatus,
  processExists,
  requireExactRuntimeBuild,
  startHub,
  stopHub,
} from "./process-manager.js";
import {
  assertExactBuildIdentity,
  assertRunningVerifiedCliEntrypoint,
  verifiedCliReleaseEntrypoint,
  withRuntimeBuildLock,
} from "./build-identity.js";
import { initializeProject, projectRoot } from "./project-init.js";
import { checkoutReview, cleanupReview } from "./review-worktree.js";
import { createBackup, restoreBackup } from "./backup.js";
import {
  awaitCodexBridgeRunOwnership,
  clearCodexBridgeRunIfOwned,
  clearCodexBridgePidIfOwned,
  clearStaleCodexBridgePid,
  codexBridgeTerminalCleanupEvidence,
  consumeCodexBridgeRunStopRequest,
  createCodexBridgeProcessTerminalController,
  isCodexBridgeHealthDegraded,
  isCodexBridgeHealthStale,
  listCodexBridgeFailedRuns,
  markCodexBridgeRunFailedIfOwned,
  probeCodexBridgeRunWorkerProof,
  promoteCodexBridgeRunThread,
  publicCodexBridgeRecord,
  readCodexBridgeManagedBuildIdentity,
  readCodexBridgeManagedLaunchContext,
  readCodexBridgeRunHealth,
  resolveCodexBridgeControlProjectId,
  selectCodexBridgePids,
  startCodexBridgeProcess,
  startCodexBridgeRunStopWatcher,
  stopCodexBridgeProcess,
  writeCodexBridgeHealth,
  writeCodexBridgeRunHealth,
  writeCodexBridgeRunOwnerLease,
  type CodexBridgeProcessTerminalOutcome,
} from "./bridge-process-manager.js";
import {
  bridgeWorkerProofSubjectThreadId,
  startBridgeWorkerProofLifecycle,
  type BridgeWorkerProofLifecycle,
  type BridgeWorkerProofMode,
} from "./bridge-worker-proof.js";
import {
  hardenWindowsOwnerPrivateAcl,
  verifyWindowsOwnerPrivateAcl,
} from "./windows-owner-private-acl.js";
import {
  FileCodexSessionOperationalCheckpointStore,
  FileCodexSessionTicketVault,
  codexSessionOperationalCheckpointPath,
  codexSessionTicketVaultPath,
} from "./session-ticket-store.js";
import {
  FileManagedBridgeRuntimeCommandStore,
  FileManagedBridgeRuntimeRegistrationStore,
  ProductionManagedBridgeRuntimeAdapter,
  sealManagedBridgeRuntimeSubjectFromFiles,
} from "./runtime-lifecycle.js";
import {
  ManagedBridgeRuntimeCoordinator,
  type ManagedBridgeRuntimeLeaseFence,
} from "./managed-bridge-runtime.js";
import { WindowsManagedBridgeSingleton } from "./windows-managed-bridge-supervisor.js";

const program = new Command();
program.name("crossagent").description("Local Codex × Claude coordination hub").version("0.1.0");

type HookCaptureBindingMode = "required" | "disabled";
type HistoricalDeliveryProofMode = "required" | "disabled";

function parseHookCaptureBindingMode(value: unknown): HookCaptureBindingMode {
  if (value === "required" || value === "disabled") return value;
  throw new Error("--hook-capture-binding must be required or disabled");
}

function parseHistoricalDeliveryProofMode(value: unknown): HistoricalDeliveryProofMode {
  if (value === "required" || value === "disabled") return value;
  throw new Error("--historical-delivery-proof must be required or disabled");
}

function parseBridgeWorkerProofMode(value: unknown): BridgeWorkerProofMode {
  if (value === "required" || value === "disabled") return value;
  throw new Error("--worker-proof must be required or disabled");
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function client(): HubClient {
  return new HubClient({ token: readDashboardToken(), baseUrl: defaultBaseUrl });
}

async function openDashboard(baseUrl = defaultBaseUrl): Promise<string> {
  const hub = new HubClient({ token: readDashboardToken(), baseUrl });
  const launch = await hub.request<{ code: string }>("POST", "/api/dashboard/launch", {});
  const url = `${baseUrl}/?launch=${encodeURIComponent(launch.code)}`;
  await open(url);
  return url;
}

async function joinedProject(path = ".", hub = client()) {
  return hub.joinProject({ cwd: resolve(path), allowCreate: true });
}

async function resolveProjectSelection(
  options: {
    project?: string;
    projectId?: string;
  },
  hub = client(),
): Promise<{ root: string; projectId: string }> {
  if (options.projectId) {
    const registration = await hub.getProjectRegistration(options.projectId);
    return { root: registration.root, projectId: registration.project.id };
  }
  const joined = await joinedProject(options.project ?? ".", hub);
  return { root: joined.root, projectId: joined.project.id };
}

program
  .command("init")
  .argument("[path]", "project path", ".")
  .action((path: string) => print(initializeProject(resolve(path))));

program
  .command("start")
  .option("--foreground", "keep Hub attached to this terminal")
  .option("--open", "open the dashboard after startup")
  .option("--port <port>", "listen port", (value) => Number(value))
  .action(async (options) => {
    const record = await startHub(options);
    print({
      ok: true,
      // An adopted Hub and a freshly started one used to print identically, so a rebuild that was
      // never actually served read as a successful deploy.
      reused: record.reused,
      ...(record.servingStaleBuild
        ? {
            servingStaleBuild: true,
            hint: "This Hub loaded its code before the current build was written. Run `crossagent stop` then `crossagent start` to serve it.",
          }
        : {}),
      pid: record.pid,
      url: `http://127.0.0.1:${record.port}`,
      logPath,
    });
    if (options.open) await openDashboard(`http://127.0.0.1:${record.port}`);
  });

program.command("stop").action(async () => print(await stopHub()));

program.command("status").action(async () => {
  print(await inspectHubRuntimeStatus());
});

program.command("open").action(async () => {
  if (!(await health(defaultBaseUrl))) throw new Error("Hub is not running");
  print({ opened: await openDashboard() });
});

program.command("doctor").action(async () => print(await collectDiagnostics()));

const managedBridge = program.command("managed-bridge");
managedBridge
  .command("supervise")
  .requiredOption("--data-dir <path>", "absolute CrossAgent data directory")
  .option("--once", "run one reconciliation pass and exit")
  .action(async (options) => {
    const runtimeRoot = resolve(options.dataDir as string);
    if (!isAbsolute(options.dataDir as string) || runtimeRoot !== options.dataDir) {
      throw new Error("--data-dir must be an exact absolute normalized path");
    }
    const singleton = new WindowsManagedBridgeSingleton({ dataDir: runtimeRoot });
    const lease = await singleton.acquire();
    let stopping = false;
    const requestStop = () => {
      stopping = true;
    };
    process.once("SIGINT", requestStop);
    process.once("SIGTERM", requestStop);
    try {
      const acl = {
        windowsOwnerPrivateAclHardener: hardenWindowsOwnerPrivateAcl,
        windowsOwnerPrivateAclVerifier: verifyWindowsOwnerPrivateAcl,
      };
      const registrations = new FileManagedBridgeRuntimeRegistrationStore({
        rootDir: runtimeRoot,
        ...acl,
      });
      const commandStore = new FileManagedBridgeRuntimeCommandStore({
        rootDir: runtimeRoot,
        ...acl,
      });
      const assertLeaseFence = (fence: ManagedBridgeRuntimeLeaseFence): void => {
        lease.assertOwned();
        if (
          fence.controlLeaseId !== lease.leaseId ||
          fence.controlLeaseGeneration !== lease.generation ||
          fence.journalLeaseId !== lease.leaseId ||
          fence.journalLeaseGeneration !== lease.generation
        ) {
          throw new Error("Managed Bridge supervisor lost its exact singleton lease fence");
        }
      };
      const adapter = new ProductionManagedBridgeRuntimeAdapter({
        rootDir: runtimeRoot,
        registrationStore: registrations,
        assertLeaseFence,
        ...acl,
        startProcess: async (input) => {
          const agentToken = readAgentToken("codex", { dataDir: runtimeRoot });
          const hub = new HubClient({ token: agentToken, baseUrl: defaultBaseUrl });
          return startCodexBridgeProcess({
            ...input,
            adapters: {
              hardenOwnerPrivateAcl: hardenWindowsOwnerPrivateAcl,
              verifyOwnerPrivateAcl: verifyWindowsOwnerPrivateAcl,
            },
            drainRecovery: ({ projectId, runId }) =>
              new CodexSessionTicketRuntime({
                baseUrl: defaultBaseUrl,
                bootstrapAgentToken: agentToken,
                bootstrapInjectorToken: readInjectorToken("codex", { dataDir: runtimeRoot }),
                vault: new FileCodexSessionTicketVault({
                  projectId,
                  runId,
                  rootDir: runtimeRoot,
                }),
                checkpointStore: new FileCodexSessionOperationalCheckpointStore(runtimeRoot),
              }).replayConfirmedClose(),
            reserveLaunch: ({ projectId, agentId, threadId, runId, idempotencyKey, signal }) =>
              hub.reserveSessionLaunch(
                projectId,
                {
                  agentId,
                  client: "codex-app-server",
                  deliveryMode: "app_server_push",
                  externalSessionId: threadId,
                  externalThreadId: threadId,
                  runId,
                  idempotencyKey,
                },
                signal,
              ),
          });
        },
        stopProcess: (projectId, agentId, rootDir, selector) =>
          stopCodexBridgeProcess(projectId, agentId, rootDir, selector),
      });
      const coordinator = new ManagedBridgeRuntimeCoordinator({
        adapter,
        store: commandStore,
        controlLease: lease,
        journalLease: lease,
      });
      do {
        try {
          const outcomes = await coordinator.reconcileAll();
          if (options.once) print({ ok: true, outcomes });
        } catch (error) {
          if (options.once) throw error;
          process.stderr.write(
            `[crossagent] managed Bridge reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        if (!options.once && !stopping) {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_000));
        }
      } while (!options.once && !stopping);
    } finally {
      process.removeListener("SIGINT", requestStop);
      process.removeListener("SIGTERM", requestStop);
      await lease.close();
    }
  });

program
  .command("codex")
  .option("--project <path>", "project path")
  .option("--project-id <id>", "stable project UUID registered in the Dashboard")
  .option("--agent <name>", "agent identity", "codex")
  .option("--thread <id>", "resume an existing Codex thread")
  .option("--prompt <text>", "start with one prompt")
  .option("--model <model>", "Codex model override")
  .option(
    "--hook-capture-binding <mode>",
    "require a live Hook capture binding, or explicitly disable that gate",
    "required",
  )
  .option(
    "--historical-delivery-proof <mode>",
    "require exact Codex thread evidence before settling an old ordinary ambiguous delivery",
    "required",
  )
  .option(
    "--worker-proof <mode>",
    "for --detach only: activate the child-only Ed25519 worker proof (required or disabled)",
    "disabled",
  )
  .option("--detach", "run the Bridge as a managed background process")
  .option("--foreground", "internal/advanced: keep the Bridge attached to this terminal")
  .option("--managed", "internal: enable the detached process stop channel")
  .option("--status", "show the managed Bridge process state")
  .option("--stop", "stop the managed Bridge process")
  .option("--run-id <id>", "select one managed Bridge run for status or stop")
  .option("--pid <pid>", "select a legacy managed Bridge by PID", (value) => Number(value))
  .option("--bridge-run-id <id>", "internal: launcher-assigned managed run identity")
  .option("--bridge-control-path <path>", "internal: owner-private managed launch handoff")
  .option("--bridge-worker-proof <mode>", "internal: managed child worker proof mode")
  .option("--bridge-worker-proof-sidecar-path <path>", "internal: public worker proof sidecar")
  .action(async (options) => {
    const agentId = options.agent as string;
    if (agentId !== "codex") {
      throw new Error("The Codex Bridge requires --agent codex");
    }
    const hookCaptureBindingMode = parseHookCaptureBindingMode(options.hookCaptureBinding);
    const historicalDeliveryProofMode = parseHistoricalDeliveryProofMode(
      options.historicalDeliveryProof,
    );
    const workerProofMode = parseBridgeWorkerProofMode(options.workerProof);
    const bridgeWorkerProofMode = parseBridgeWorkerProofMode(
      (options.bridgeWorkerProof as string | undefined) ?? "disabled",
    );
    const bridgeRunId = options.bridgeRunId as string | undefined;
    const bridgeControlPath = options.bridgeControlPath as string | undefined;
    const bridgeWorkerProofSidecarPath = options.bridgeWorkerProofSidecarPath as string | undefined;
    if (options.managed && !options.foreground) {
      throw new Error("--managed requires --foreground");
    }
    if (options.managed && (!bridgeRunId || !bridgeControlPath || !options.projectId)) {
      throw new Error("Managed Codex Bridge child is missing its run ownership context");
    }
    if (!options.managed && (bridgeRunId || bridgeControlPath)) {
      throw new Error("Managed launch context requires --managed");
    }
    if (
      !options.managed &&
      (bridgeWorkerProofMode !== "disabled" || bridgeWorkerProofSidecarPath !== undefined)
    ) {
      throw new Error("Internal worker proof launch context requires --managed");
    }
    if (options.managed && workerProofMode !== "disabled") {
      throw new Error("--worker-proof belongs to the detached parent, not the managed child");
    }
    if (
      options.managed &&
      ((bridgeWorkerProofMode === "required" && !bridgeWorkerProofSidecarPath) ||
        (bridgeWorkerProofMode === "disabled" && bridgeWorkerProofSidecarPath !== undefined))
    ) {
      throw new Error("Managed worker proof sidecar context is inconsistent");
    }
    if (!options.managed && workerProofMode !== "disabled" && !options.detach) {
      throw new Error("--worker-proof required only supports --detach");
    }
    if (options.managed) {
      // This check uses only the local release manifest and the executing path. It runs before the
      // child reads even the non-secret managed control header.
      assertRunningVerifiedCliEntrypoint(resolve(process.argv[1] ?? ""));
    }
    const managedBuildIdentity =
      options.managed && bridgeRunId && bridgeControlPath && options.projectId
        ? readCodexBridgeManagedBuildIdentity({
            controlPath: bridgeControlPath,
            projectId: options.projectId as string,
            agentId,
            runId: bridgeRunId,
            pid: process.pid,
          })
        : null;
    if (managedBuildIdentity) {
      // Validate the non-secret release provenance before parsing the launch reservation, reading
      // ticket material, creating owner proof, or starting a model process.
      await requireExactRuntimeBuild(managedBuildIdentity);
    }
    const managedLaunch =
      options.managed && bridgeRunId && bridgeControlPath && options.projectId
        ? readCodexBridgeManagedLaunchContext({
            controlPath: bridgeControlPath,
            projectId: options.projectId as string,
            agentId,
            runId: bridgeRunId,
            pid: process.pid,
          })
        : null;
    const managedOwner = managedLaunch?.owner ?? null;
    const launchReservation = managedLaunch?.launchReservation ?? undefined;
    if (managedBuildIdentity && managedLaunch) {
      assertExactBuildIdentity(
        managedBuildIdentity,
        managedLaunch.buildIdentity,
        "Managed control handoff",
      );
    }
    if (
      options.managed &&
      (launchReservation?.identityValue ?? null) !==
        ((options.thread as string | undefined) ?? null)
    ) {
      throw new Error("Managed Codex Bridge thread does not match its private launch handoff");
    }
    let managedOwnerLeaseTimer: NodeJS.Timeout | null = null;
    let managedStopTimer: NodeJS.Timeout | null = null;
    let requestBridgeStop: (() => void) | null = null;
    let preBridgeStopScheduled = false;
    const stopManagedBeforeBridge = () => {
      if (preBridgeStopScheduled || !managedOwner) return;
      preBridgeStopScheduled = true;
      if (managedStopTimer) clearInterval(managedStopTimer);
      if (managedOwnerLeaseTimer) clearInterval(managedOwnerLeaseTimer);
      let exitCode = 0;
      try {
        clearCodexBridgeRunIfOwned(managedOwner, {
          terminalCleanup: "NOT_ATTEMPTED",
        });
      } catch (error) {
        exitCode = 1;
        process.stderr.write(
          `[crossagent] pre-start Bridge control cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      process.exitCode = exitCode;
      process.exit(exitCode);
    };
    const dispatchManagedStop = () => {
      if (requestBridgeStop) requestBridgeStop();
      else stopManagedBeforeBridge();
    };
    // Prove local run ownership before reading Hub state or starting any Codex child.
    if (managedOwner) {
      await awaitCodexBridgeRunOwnership(managedOwner);
      if (consumeCodexBridgeRunStopRequest(managedOwner)) {
        clearCodexBridgeRunIfOwned(managedOwner, {
          terminalCleanup: "NOT_ATTEMPTED",
        });
        return;
      }
      if (!writeCodexBridgeRunOwnerLease(managedOwner)) {
        throw new Error("Managed Codex Bridge could not establish its child-owned run lease");
      }
      managedOwnerLeaseTimer = setInterval(() => {
        try {
          if (!writeCodexBridgeRunOwnerLease(managedOwner)) {
            throw new Error("managed run ownership changed");
          }
        } catch (error) {
          if (managedStopTimer) clearInterval(managedStopTimer);
          if (managedOwnerLeaseTimer) clearInterval(managedOwnerLeaseTimer);
          process.stderr.write(
            `[crossagent] managed Bridge owner lease failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 1;
          process.exit(1);
        }
      }, 1_000);
      managedOwnerLeaseTimer.unref();
      managedStopTimer = startCodexBridgeRunStopWatcher(managedOwner, dispatchManagedStop);
      // During preflight, Hub I/O itself owns process liveness; do not turn a rejected preflight into
      // a timer-only zombie. Once Bridge.start begins, this watcher is referenced again below.
      managedStopTimer.unref();
    }
    const selector = {
      runId: options.runId as string | undefined,
      threadId: options.thread as string | undefined,
      pid: options.pid as number | undefined,
    };
    if (selector.pid !== undefined && (!Number.isSafeInteger(selector.pid) || selector.pid <= 0)) {
      throw new Error("--pid must be a positive process id");
    }
    if (options.status || options.stop) {
      const projectId = await resolveCodexBridgeControlProjectId(
        options.projectId as string | undefined,
        async () => (await resolveProjectSelection(options)).projectId,
      );
      if (options.stop) {
        const selected = selectCodexBridgePids(projectId, agentId, selector).filter(
          (record) =>
            record.workerProofMode === "required" &&
            record.runId !== null &&
            record.threadId !== null,
        );
        if (selected.length === 1) {
          const record = selected[0]!;
          const registrations = new FileManagedBridgeRuntimeRegistrationStore({
            rootDir: dataDir,
            windowsOwnerPrivateAclHardener: hardenWindowsOwnerPrivateAcl,
            windowsOwnerPrivateAclVerifier: verifyWindowsOwnerPrivateAcl,
          });
          const registration = await registrations.loadByIdentity(
            record.projectId,
            record.threadId!,
          );
          if (registration) {
            if (registration.subject.runId !== record.runId) {
              throw new Error("Managed Bridge stop target changed from its durable registration");
            }
            await registrations.sealStopped({
              projectId: record.projectId,
              originalThreadId: record.threadId!,
              runId: record.runId!,
            });
          }
        }
        print(await stopCodexBridgeProcess(projectId, agentId, undefined, selector));
        return;
      }
      const stalePidRemoved = clearStaleCodexBridgePid(projectId, agentId);
      const bridges = await Promise.all(
        selectCodexBridgePids(projectId, agentId, selector).map(async (record) => {
          const health = readCodexBridgeRunHealth(record);
          const staleHealth = health !== null && isCodexBridgeHealthStale(health);
          const running = processExists(record.pid);
          const workerProof = await probeCodexBridgeRunWorkerProof(record);
          return {
            record: publicCodexBridgeRecord(record),
            health,
            workerProof,
            running,
            staleHealth,
            degraded:
              running &&
              (health === null ||
                staleHealth ||
                isCodexBridgeHealthDegraded(health) ||
                workerProof === "INVALID"),
          };
        }),
      );
      const single = bridges.length === 1 ? bridges[0] : null;
      const failedRuns = listCodexBridgeFailedRuns(projectId, agentId)
        .filter(
          (record) =>
            (!selector.runId || record.runId === selector.runId) &&
            (!selector.threadId || record.threadId === selector.threadId) &&
            (!selector.pid || record.pid === selector.pid),
        )
        .map(publicCodexBridgeRecord);
      print({
        running: bridges.some((bridge) => bridge.running),
        degraded: bridges.some((bridge) => bridge.degraded),
        stalePidRemoved,
        staleHealth: bridges.some((bridge) => bridge.staleHealth),
        // Preserve the old single-Bridge fields while exposing every independent run.
        bridge: single?.record ?? null,
        health: single?.health ?? null,
        bridges,
        failedRuns,
      });
      return;
    }
    let managedHealthUpdatedAt: string | null = null;
    let managedFuseGeneration: number | null = null;
    let managedWorkerProof: BridgeWorkerProofLifecycle | null = null;
    if (bridgeWorkerProofMode === "required") {
      if (
        !managedOwner ||
        !managedBuildIdentity ||
        !bridgeControlPath ||
        !bridgeWorkerProofSidecarPath
      ) {
        throw new Error("Managed worker proof launch context is unavailable");
      }
      // This runs after exact child ownership/lease proof but before any Hub state, ticket, or
      // Adapter registration. Its private KeyObject is child-local; only public sidecar metadata
      // is durable. On Windows the missing ACL verifier intentionally stops here fail-closed.
      managedWorkerProof = await startBridgeWorkerProofLifecycle({
        controlPath: bridgeControlPath,
        sidecarPath: bridgeWorkerProofSidecarPath,
        pid: process.pid,
        subject: {
          schemaVersion: 1,
          projectId: managedOwner.projectId,
          agentId: "codex",
          runId: managedOwner.runId,
          threadId: (options.thread as string | undefined) ?? null,
          build: managedBuildIdentity,
        },
        windowsOwnerPrivateAclHardener: hardenWindowsOwnerPrivateAcl,
        windowsOwnerPrivateAclVerifier: verifyWindowsOwnerPrivateAcl,
        healthUpdatedAt: () => managedHealthUpdatedAt,
      });
    }
    const agentToken = readAgentToken("codex");
    const agentHub = new HubClient({ token: agentToken, baseUrl: defaultBaseUrl });
    // A Bridge may never bootstrap trust from the live key response it is about to verify. Resolve
    // the installer-pinned manifest before project attachment or any managed launch side effect.
    const authorityTrustManifest = readAuthorityTrustManifest();
    const selection =
      managedLaunch?.projectAttachment ??
      (await resolveProjectSelection(
        options,
        new HubClient({ token: readDashboardToken(), baseUrl: defaultBaseUrl }),
      ));
    if (managedOwner && selection.projectId !== managedOwner.projectId) {
      throw new Error("Managed Codex Bridge project does not match its control record");
    }
    if (options.detach && options.foreground) {
      throw new Error("--detach and --foreground cannot be used together");
    }
    if (options.detach) {
      if (options.bridgeRunId || options.bridgeControlPath) {
        throw new Error("Internal managed launch options cannot be combined with --detach");
      }
      const hub = agentHub;
      const result = await withRuntimeBuildLock(async (buildIdentity) => {
        await requireExactRuntimeBuild(buildIdentity);
        const entry = verifiedCliReleaseEntrypoint(buildIdentity);
        return startCodexBridgeProcess({
          entry,
          projectId: selection.projectId,
          projectRoot: selection.root,
          agentId,
          threadId: options.thread,
          model: options.model,
          hookCaptureBindingMode,
          historicalDeliveryProofMode,
          workerProofMode,
          buildIdentity,
          adapters: {
            hardenOwnerPrivateAcl: hardenWindowsOwnerPrivateAcl,
            verifyOwnerPrivateAcl: verifyWindowsOwnerPrivateAcl,
          },
          drainRecovery: ({ projectId, runId }) =>
            new CodexSessionTicketRuntime({
              baseUrl: defaultBaseUrl,
              bootstrapAgentToken: agentToken,
              bootstrapInjectorToken: readInjectorToken("codex"),
              vault: new FileCodexSessionTicketVault({ projectId, runId }),
              checkpointStore: new FileCodexSessionOperationalCheckpointStore(),
            }).replayConfirmedClose(),
          reserveLaunch: ({ projectId, agentId, threadId, runId, idempotencyKey, signal }) =>
            hub.reserveSessionLaunch(
              projectId,
              {
                agentId,
                client: "codex-app-server",
                deliveryMode: "app_server_push",
                externalSessionId: threadId,
                externalThreadId: threadId,
                runId,
                idempotencyKey,
              },
              signal,
            ),
        });
      });
      print({
        ok: true,
        running: true,
        alreadyRunning: result.alreadyRunning,
        pid: result.record.pid,
        projectId: selection.projectId,
        agentId,
        runId: result.record.runId,
        threadId: result.record.threadId,
        hookCaptureBindingMode,
        historicalDeliveryProofMode,
        logPath: result.record.logPath,
      });
      return;
    }
    let lines: ReturnType<typeof createInterface> | null = null;
    let terminalExitScheduled = false;
    let terminalRequested = false;
    let requestBridgeTermination:
      ((termination: CodexBridgeProcessTerminalOutcome) => Promise<void>) | null = null;
    const sessionOperationalCheckpointStore = new FileCodexSessionOperationalCheckpointStore();
    const managedTicketVaultPath = managedOwner
      ? codexSessionTicketVaultPath(managedOwner.projectId, managedOwner.runId)
      : null;
    const bridge = new CodexBridge({
      cwd: selection.root,
      token: agentToken,
      injectorToken: readInjectorToken("codex"),
      authorityTrustManifest,
      baseUrl: defaultBaseUrl,
      agentId,
      threadId: options.thread,
      initialPrompt: options.prompt,
      model: options.model,
      hookCaptureBindingMode,
      historicalDeliveryProofMode,
      allowCreateProject: false,
      projectAttachment: selection,
      launchContext: managedOwner
        ? options.thread
          ? {
              mode: "managed-existing-thread",
              runId: managedOwner.runId,
              reservation: launchReservation!,
            }
          : {
              mode: "managed-new-thread",
              runId: managedOwner.runId,
            }
        : { mode: "foreground" },
      sessionTicketVaultFactory: (runId) => {
        const vault = new FileCodexSessionTicketVault({
          projectId: selection.projectId,
          runId,
        });
        return vault;
      },
      sessionOperationalCheckpointStore,
      onHealthChange: (health) => {
        managedHealthUpdatedAt = health.updatedAt;
        managedFuseGeneration = health.appServerRecoveryFuseGeneration;
        if (managedOwner) {
          writeCodexBridgeRunHealth(managedOwner, health);
        } else {
          writeCodexBridgeHealth(selection.projectId, agentId, health);
        }
      },
      onThreadResolved: managedOwner
        ? async (threadId) => {
            promoteCodexBridgeRunThread(managedOwner, threadId);
            if (
              managedWorkerProof &&
              bridgeWorkerProofSubjectThreadId(managedWorkerProof.sidecar.subject) !== threadId
            ) {
              await managedWorkerProof?.rebindSubject({
                ...managedWorkerProof.sidecar.subject,
                threadId,
              });
            }
          }
        : undefined,
      onTerminated: (termination) => {
        terminalRequested = true;
        lines?.close();
        return requestBridgeTermination?.(termination);
      },
    });
    const terminalController = createCodexBridgeProcessTerminalController({
      shutdown: async () => {
        await bridge.stop();
      },
      finalize: async (termination) => {
        if (terminalExitScheduled) return;
        terminalExitScheduled = true;
        if (managedStopTimer) clearInterval(managedStopTimer);
        if (managedOwnerLeaseTimer) clearInterval(managedOwnerLeaseTimer);
        lines?.close();
        let exitCode = termination.fatal ? 1 : 0;
        try {
          await managedWorkerProof?.close(termination.fatal ? "EXITED" : "STOPPED");
          const cleanupEvidence = codexBridgeTerminalCleanupEvidence(bridge.lastStopOutcome);
          if (managedOwner && termination.fatal) {
            markCodexBridgeRunFailedIfOwned(
              managedOwner,
              termination.error.message,
              cleanupEvidence,
            );
          } else if (managedOwner) {
            clearCodexBridgeRunIfOwned(managedOwner, cleanupEvidence);
          } else if (options.foreground) {
            clearCodexBridgePidIfOwned(selection.projectId, agentId, process.pid);
          }
        } catch (error) {
          exitCode = 1;
          process.stderr.write(
            `[crossagent] Bridge terminal control cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
        if (termination.fatal) {
          process.stderr.write(
            `[crossagent] fatal Bridge termination: ${termination.error.message}\n`,
          );
        }
        process.exitCode = exitCode;
        setImmediate(() => process.exit(exitCode));
      },
    });
    requestBridgeTermination = terminalController.request;
    const stop = () => {
      terminalRequested = true;
      lines?.close();
      void terminalController.request({ reason: "caller stop", fatal: false });
    };
    requestBridgeStop = stop;
    const stopFromSignal = () => stop();
    process.once("SIGINT", stopFromSignal);
    process.once("SIGTERM", stopFromSignal);
    managedStopTimer?.ref();
    let state: Awaited<ReturnType<CodexBridge["start"]>>;
    try {
      state = await bridge.start();
      if (managedWorkerProof) {
        if (
          !managedOwner ||
          !managedBuildIdentity ||
          !managedTicketVaultPath ||
          !state.threadId ||
          !state.sessionId ||
          managedFuseGeneration === null
        ) {
          throw new Error("Managed worker proof could not seal the registered runtime identity");
        }
        const subject = await sealManagedBridgeRuntimeSubjectFromFiles({
          projectId: managedOwner.projectId,
          originalThreadId: state.threadId,
          runId: managedOwner.runId,
          sessionId: state.sessionId,
          build: managedBuildIdentity,
          fuseGeneration: managedFuseGeneration,
          vaultPath: managedTicketVaultPath,
          checkpointPath: codexSessionOperationalCheckpointPath(
            managedOwner.projectId,
            state.threadId,
          ),
          windowsOwnerPrivateAclVerifier: verifyWindowsOwnerPrivateAcl,
        });
        await managedWorkerProof.rebindSubject(subject);
        await new FileManagedBridgeRuntimeRegistrationStore({
          rootDir: dataDir,
          windowsOwnerPrivateAclHardener: hardenWindowsOwnerPrivateAcl,
          windowsOwnerPrivateAclVerifier: verifyWindowsOwnerPrivateAcl,
        }).persistRunning({
          subject,
          launch: {
            schemaVersion: 1,
            entry: resolve(process.argv[1] ?? ""),
            projectRoot: selection.root,
            workerProofMode: "required",
            hookCaptureBindingMode,
            historicalDeliveryProofMode,
          },
        });
      }
    } catch (error) {
      if (managedStopTimer) clearInterval(managedStopTimer);
      if (managedOwnerLeaseTimer) clearInterval(managedOwnerLeaseTimer);
      process.removeListener("SIGINT", stopFromSignal);
      process.removeListener("SIGTERM", stopFromSignal);
      try {
        await managedWorkerProof?.close("EXITED");
      } catch (proofError) {
        process.stderr.write(
          `[crossagent] worker proof terminal sidecar update failed: ${proofError instanceof Error ? proofError.message : String(proofError)}\n`,
        );
      }
      if (managedOwner && !terminalRequested) {
        try {
          markCodexBridgeRunFailedIfOwned(
            managedOwner,
            error instanceof Error ? error.message : String(error),
            codexBridgeTerminalCleanupEvidence(bridge.lastStopOutcome),
          );
        } catch (controlError) {
          process.stderr.write(
            `[crossagent] Bridge startup failure record update failed: ${controlError instanceof Error ? controlError.message : String(controlError)}\n`,
          );
        }
      }
      throw error;
    }
    if (managedOwner && state.threadId) {
      promoteCodexBridgeRunThread(managedOwner, state.threadId);
      if (
        managedWorkerProof &&
        bridgeWorkerProofSubjectThreadId(managedWorkerProof.sidecar.subject) !== state.threadId
      ) {
        await managedWorkerProof?.rebindSubject({
          ...managedWorkerProof.sidecar.subject,
          threadId: state.threadId,
        });
      }
    }
    print(state);
    lines = createInterface({ input: process.stdin, terminal: true });
    if (!options.prompt) {
      process.stdout.write("CrossAgent Codex Bridge ready. Enter prompts; Ctrl+C stops.\n");
    }
    lines.on("line", (line) => {
      if (line.trim())
        void bridge.sendUserText(line).catch((error) => print({ error: error.message }));
    });
  });

const claudeChannel = program.command("claude-channel");
claudeChannel
  .command("install")
  .argument("[path]", "project path")
  .option("--project-id <id>", "stable project UUID registered in the Dashboard")
  .action(async (path: string | undefined, options) => {
    const selection = await resolveProjectSelection({
      project: path,
      projectId: options.projectId,
    });
    print(installClaudeChannel(selection.root, selection.projectId));
  });

const hooks = program.command("hooks");
hooks
  .command("install")
  .argument("<client>", "codex or claude")
  .argument("[path]", "project path", ".")
  .action((kind: string, path: string) => {
    if (!["codex", "claude"].includes(kind)) throw new Error("client must be codex or claude");
    print(installLifecycleHooks(kind as "codex" | "claude", resolve(path)));
  });

const project = program.command("project");
project.command("list").action(async () => print(await client().listProjects()));
project
  .command("get")
  .argument("<id>", "stable project UUID")
  .action(async (id: string) => print(await client().getProjectRegistration(id)));
project
  .command("join")
  .argument("[path]", "project path", ".")
  .action(async (path: string) => print(await joinedProject(path)));

const task = program.command("task");
task
  .command("list")
  .option("--project <path>", "project path", ".")
  .option("--ready", "only deterministically ready tasks")
  .action(async (options) => {
    const joined = await joinedProject(options.project);
    print(await client().listTasks(joined.project.id, { readyOnly: options.ready }));
  });

program
  .command("inbox")
  .option("--project <path>", "project path", ".")
  .option("--agent <name>", "recipient agent")
  .option("--all", "include already-read messages")
  .action(async (options) => {
    const joined = await joinedProject(options.project);
    print(
      await client().listMessages(joined.project.id, {
        agentId: options.agent,
        unread: !options.all,
        unresolved: true,
        limit: 100,
      }),
    );
  });

const review = program.command("review");
review
  .command("checkout")
  .argument("<id>", "review id")
  .option("--project <path>", "project root", ".")
  .action(async (id: string, options) => {
    print({ worktree: await checkoutReview(client(), id, projectRoot(resolve(options.project))) });
  });
review
  .command("cleanup")
  .argument("<id>", "review id")
  .requiredOption("--project-id <id>", "stable project id")
  .option("--project <path>", "project root", ".")
  .action((id: string, options) => {
    print({
      removed: cleanupReview(id, options.projectId, projectRoot(resolve(options.project))),
    });
  });

// Neither Adapter's host CLI announces what it can still do, so the answer has to be measured and
// dated rather than inferred from a version string. The result is written next to the other local
// state and is what `doctor` reports.
const compatibility = program.command("compatibility");
compatibility
  .command("probe")
  .argument("<client>", "codex or claude")
  .option("--project <path>", "project root the probe starts a thread in", ".")
  .option("--command <path>", "the client executable to probe")
  .option(
    "--allow-model-turn",
    "also probe the steer readback, which starts a turn and calls the model",
  )
  .action(async (client: string, options) => {
    if (client === "codex") {
      print(
        await probeCodex({
          cwd: resolve(options.project),
          command: options.command,
          allowModelTurn: Boolean(options.allowModelTurn),
        }),
      );
      return;
    }
    if (client === "claude") {
      print(probeClaude({ command: options.command }));
      return;
    }
    throw new Error(`Unknown client: ${client}. Use codex or claude.`);
  });

const diagnostics = program.command("diagnostics");
diagnostics
  .command("export")
  .argument("[path]", "output zip", `crossagent-diagnostics-${Date.now()}.zip`)
  .action(async (path: string) => print({ path: await exportDiagnostics(path) }));

const backup = program.command("backup");
backup
  .command("create")
  .argument("[path]", "new backup directory")
  .action(async (path?: string) => print(await createBackup(path)));
backup
  .command("restore")
  .argument("<path>", "backup directory")
  .action((path: string) => print(restoreBackup(path)));

program.configureOutput({
  outputError: (message) => process.stderr.write(message),
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
