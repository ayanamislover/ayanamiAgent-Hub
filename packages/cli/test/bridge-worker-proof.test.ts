import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ManagedBridgeIpcSubject } from "../src/managed-bridge-ipc.js";
import {
  BridgeWorkerProofError,
  bridgeWorkerProofSubjectThreadId,
  challengeBridgeWorker,
  createBridgeWorkerChallengeId,
  readBridgeWorkerProofSidecar,
  startBridgeWorkerProofLifecycle,
  verifyBridgeWorkerProof,
  type BridgeWorkerProofSubject,
  type WindowsOwnerPrivateAclHardener,
} from "../src/bridge-worker-proof.js";

const build = Object.freeze({
  buildSessionId: "00000000-0000-4000-8000-000000000000",
  buildId: "0".repeat(64),
  migrationId: "1".repeat(64),
  protocolId: "2".repeat(64),
  manifestSha256: "3".repeat(64),
});

function subject(overrides: Partial<BridgeWorkerProofSubject> = {}): BridgeWorkerProofSubject {
  return {
    schemaVersion: 1,
    projectId: "prj_worker_proof",
    agentId: "codex",
    runId: "run_worker_proof",
    threadId: "thr_worker_proof",
    build,
    ...overrides,
  };
}

function fixture(name: string) {
  const root = mkdtempSync(resolve(tmpdir(), `crossagent-${name}-`));
  const controlPath = resolve(root, "bridges", "run.pid.json");
  const sidecarPath = resolve(root, "bridges", "run.worker-proof.json");
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 });
  writeFileSync(controlPath, '{"state":"RUNNING"}\n', "utf8");
  if (process.platform !== "win32") chmodSync(controlPath, 0o600);
  return { root, controlPath, sidecarPath };
}

function aclVerifier(path: string): boolean {
  return path.length > 0;
}

const aclHardener: WindowsOwnerPrivateAclHardener = (path, kind) =>
  path.length > 0 && (kind === "directory" || kind === "file");

describe("Bridge worker proof", () => {
  it("keeps the generated private key out of durable control/sidecar data while an Adapter proves a fresh challenge", async () => {
    const files = fixture("worker-proof-public-only");
    const lifecycle = await startBridgeWorkerProofLifecycle({
      ...files,
      subject: subject(),
      pid: 61_001,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
      now: () => "2026-08-02T12:00:00.000Z",
    });
    try {
      const challengeId = createBridgeWorkerChallengeId();
      const proof = await challengeBridgeWorker({ sidecar: lifecycle.sidecar, challengeId });
      const loaded = await readBridgeWorkerProofSidecar({
        controlPath: files.controlPath,
        sidecarPath: files.sidecarPath,
        windowsOwnerPrivateAclVerifier: aclVerifier,
      });

      expect(verifyBridgeWorkerProof({ sidecar: lifecycle.sidecar, challengeId, proof })).toBe(
        true,
      );
      expect(loaded).toEqual(lifecycle.sidecar);
      expect(lifecycle.sidecar).toMatchObject({
        state: "RUNNING",
        pid: 61_001,
        workerPublicKeySpkiDerBase64: expect.any(String),
        workerPublicKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        workerPipePath: expect.any(String),
      });
      expect(Object.keys(lifecycle.sidecar).sort()).toEqual([
        "kind",
        "pid",
        "revision",
        "schemaVersion",
        "sidecarId",
        "state",
        "stateUpdatedAt",
        "subject",
        "workerPipePath",
        "workerPublicKeySha256",
        "workerPublicKeySpkiDerBase64",
      ]);

      const durable = readdirSync(dirname(files.controlPath))
        .filter((name) => !name.endsWith(".sock"))
        .map((name) => readFileSync(resolve(dirname(files.controlPath), name), "utf8"))
        .join("\n");
      expect(durable).not.toContain("worker-private-canary-never-persist");
      expect(durable).not.toMatch(/pkcs8|private.?key|privateKey|canary/i);
    } finally {
      await lifecycle.close("STOPPED");
    }
  });

  it("rejects a durable pipe path that was not derived from the exact sidecar path and public key", async () => {
    const files = fixture("worker-proof-pipe-drift");
    const lifecycle = await startBridgeWorkerProofLifecycle({
      ...files,
      subject: subject(),
      pid: 61_006,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
    });
    try {
      writeFileSync(
        files.sidecarPath,
        `${JSON.stringify({ ...lifecycle.sidecar, workerPipePath: "arbitrary-worker-pipe" })}\n`,
        "utf8",
      );
      await expect(
        readBridgeWorkerProofSidecar({
          controlPath: files.controlPath,
          sidecarPath: files.sidecarPath,
          windowsOwnerPrivateAclVerifier: aclVerifier,
        }),
      ).rejects.toMatchObject({ code: "INVALID_SIDECAR" });
    } finally {
      await lifecycle.close("STOPPED");
    }
  });

  it("reads exact terminal public evidence after the consumed control record is removed", async () => {
    const files = fixture("worker-proof-terminal-recovery");
    const lifecycle = await startBridgeWorkerProofLifecycle({
      ...files,
      subject: subject(),
      pid: 61_008,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
    });
    await lifecycle.close("EXITED");
    unlinkSync(files.controlPath);

    await expect(
      readBridgeWorkerProofSidecar({
        controlPath: files.controlPath,
        sidecarPath: files.sidecarPath,
        controlRequired: false,
        windowsOwnerPrivateAclVerifier: aclVerifier,
      }),
    ).resolves.toMatchObject({ state: "EXITED", pid: null });
  });

  it("rejects wrong-key, replay, signature-bit-flip, signed-field drift, and PID-reuse proofs", async () => {
    const firstFiles = fixture("worker-proof-first");
    const secondFiles = fixture("worker-proof-second");
    const first = await startBridgeWorkerProofLifecycle({
      ...firstFiles,
      subject: subject(),
      pid: 61_002,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
    });
    const second = await startBridgeWorkerProofLifecycle({
      ...secondFiles,
      subject: subject({ runId: "run_worker_proof_reused_pid" }),
      pid: 61_002,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
    });
    try {
      const challengeId = createBridgeWorkerChallengeId();
      const proof = await challengeBridgeWorker({ sidecar: first.sidecar, challengeId });
      expect(verifyBridgeWorkerProof({ sidecar: second.sidecar, challengeId, proof })).toBe(false);
      expect(
        verifyBridgeWorkerProof({
          sidecar: first.sidecar,
          challengeId: createBridgeWorkerChallengeId(),
          proof,
        }),
      ).toBe(false);

      const flipped = Buffer.from(proof.signatureBase64, "base64");
      flipped[0] = flipped[0]! ^ 1;
      expect(
        verifyBridgeWorkerProof({
          sidecar: first.sidecar,
          challengeId,
          proof: { ...proof, signatureBase64: flipped.toString("base64") },
        }),
      ).toBe(false);
      expect(
        verifyBridgeWorkerProof({
          sidecar: first.sidecar,
          challengeId,
          proof: { ...proof, subject: { ...proof.subject, threadId: "thr_field_drift" } },
        }),
      ).toBe(false);
    } finally {
      await first.close("EXITED");
      await second.close("EXITED");
    }
  });

  it("revisions its public sidecar on thread registration and leaves only public terminal evidence after a child crash-equivalent close", async () => {
    const files = fixture("worker-proof-terminal");
    const lifecycle = await startBridgeWorkerProofLifecycle({
      ...files,
      subject: subject({ threadId: null }),
      pid: 61_003,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
      now: () => "2026-08-02T12:00:00.000Z",
    });
    await lifecycle.rebindSubject(subject({ threadId: "thr_registered" }));
    const beforeClose = lifecycle.sidecar;
    expect(beforeClose.revision).toBe(2);
    expect(bridgeWorkerProofSubjectThreadId(beforeClose.subject)).toBe("thr_registered");

    await lifecycle.close("EXITED");
    expect(lifecycle.sidecar).toMatchObject({ state: "EXITED", pid: null, revision: 3 });
    await expect(
      challengeBridgeWorker({
        sidecar: beforeClose,
        challengeId: createBridgeWorkerChallengeId(),
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "PIPE_UNAVAILABLE" });
    const durable = readFileSync(files.sidecarPath, "utf8");
    expect(durable).not.toMatch(/pkcs8|private.?key|privateKey|canary/i);
  });

  it("rebinds launch proof to the exact post-registration runtime subject and signs real health freshness", async () => {
    const files = fixture("worker-proof-runtime-rebind");
    let healthUpdatedAt: string | null = null;
    const lifecycle = await startBridgeWorkerProofLifecycle({
      ...files,
      subject: subject(),
      pid: 61_007,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
      healthUpdatedAt: () => healthUpdatedAt,
    });
    const runtimeSubject: ManagedBridgeIpcSubject = {
      schemaVersion: 1,
      projectId: "prj_worker_proof",
      originalThreadId: "thr_worker_proof",
      agentId: "codex",
      runId: "run_worker_proof",
      sessionId: "ses_worker_proof",
      lineageId: "lin_worker_proof",
      incarnation: 2,
      bundleId: "stb_worker_proof",
      build,
      vaultSha256: "4".repeat(64),
      checkpointSha256: "5".repeat(64),
      checkpointEventSequence: 17,
      fuseGeneration: 3,
    };
    try {
      await expect(
        challengeBridgeWorker({
          sidecar: lifecycle.sidecar,
          challengeId: createBridgeWorkerChallengeId(),
          timeoutMs: 100,
        }),
      ).rejects.toMatchObject({ code: "PIPE_UNAVAILABLE" });

      healthUpdatedAt = "2026-08-02T12:00:00.000Z";
      await lifecycle.rebindSubject(runtimeSubject);
      const challengeId = createBridgeWorkerChallengeId();
      const proof = await challengeBridgeWorker({ sidecar: lifecycle.sidecar, challengeId });
      expect(proof).toMatchObject({
        subject: runtimeSubject,
        healthUpdatedAt,
      });
      expect(verifyBridgeWorkerProof({ sidecar: lifecycle.sidecar, challengeId, proof })).toBe(
        true,
      );
    } finally {
      await lifecycle.close("STOPPED");
    }
  });

  it("rejects an over-deep proof object with a bounded iterative scan instead of recursing", async () => {
    const files = fixture("worker-proof-bounded-scan");
    const lifecycle = await startBridgeWorkerProofLifecycle({
      ...files,
      subject: subject(),
      pid: 61_005,
      windowsOwnerPrivateAclVerifier: aclVerifier,
      windowsOwnerPrivateAclHardener: aclHardener,
    });
    try {
      const challengeId = createBridgeWorkerChallengeId();
      const proof = await challengeBridgeWorker({ sidecar: lifecycle.sidecar, challengeId });
      let nested: Record<string, unknown> = {};
      for (let depth = 0; depth < 10_000; depth += 1) nested = { next: nested };
      const poisoned = { ...proof, oversized: nested };

      expect(() =>
        verifyBridgeWorkerProof({
          sidecar: lifecycle.sidecar,
          challengeId,
          proof: poisoned as typeof proof,
        }),
      ).not.toThrow();
      expect(
        verifyBridgeWorkerProof({
          sidecar: lifecycle.sidecar,
          challengeId,
          proof: poisoned as typeof proof,
        }),
      ).toBe(false);
    } finally {
      await lifecycle.close("STOPPED");
    }
  });

  it.runIf(process.platform === "win32")(
    "fails closed when proof activation has no real Windows owner-private ACL verifier",
    async () => {
      const files = fixture("worker-proof-windows-acl");
      await expect(
        startBridgeWorkerProofLifecycle({ ...files, subject: subject(), pid: 61_004 }),
      ).rejects.toMatchObject({
        code: "WINDOWS_ACL_VERIFIER_UNAVAILABLE",
      } satisfies Partial<BridgeWorkerProofError>);
    },
  );
});
