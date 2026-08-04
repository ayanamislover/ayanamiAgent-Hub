import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HookSessionTicketStore,
  createInitialTicketRecord,
  nextTicketRecord,
  type HookTicketSessionIdentity,
} from "../src/session-ticket-store.js";

const identity: HookTicketSessionIdentity = {
  projectId: "prj_store",
  adapterClient: "codex",
  agentId: "codex",
  sessionClient: "codex-cli-hooks",
  externalSessionId: "external secret identity",
  externalThreadId: "external secret identity",
};

describe("HookSessionTicketStore", () => {
  it("persists one private integrity-checked bundle without exposing identity or secrets in names", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-store-"));
    const store = new HookSessionTicketStore({ directory });
    const record = createInitialTicketRecord(identity, {
      controlToken: randomBytes(32).toString("base64url"),
      captureToken: randomBytes(32).toString("base64url"),
      now: "2026-08-01T00:00:00.000Z",
    });

    await store.withRecord(identity, async (transaction) => {
      expect(transaction.current).toBeNull();
      transaction.save(record);
    });

    const names = readdirSync(directory);
    const bundleName = names.find((name) => name.endsWith(".bundle.json"));
    expect(bundleName).toMatch(/^[a-f0-9]{64}\.bundle\.json$/u);
    expect(names.join("\n")).not.toContain(identity.externalSessionId);
    const path = resolve(directory, bundleName!);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const serialized = readFileSync(path, "utf8");
    expect(serialized).toContain(record.pending!.control.rawToken);
    expect(serialized).toContain(record.pending!.capture.rawToken);
    await expect(store.read(identity)).resolves.toEqual(record);
  });

  it("serializes concurrent creators for the same external session", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-concurrent-"));
    const first = new HookSessionTicketStore({ directory });
    const second = new HookSessionTicketStore({ directory });
    let creators = 0;

    await Promise.all(
      [first, second].map((store) =>
        store.withRecord(identity, async (transaction) => {
          if (transaction.current) return;
          creators += 1;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
          transaction.save(
            createInitialTicketRecord(identity, {
              controlToken: randomBytes(32).toString("base64url"),
              captureToken: randomBytes(32).toString("base64url"),
              now: "2026-08-01T00:00:00.000Z",
            }),
          );
        }),
      ),
    );

    expect(creators).toBe(1);
  });

  it("fails closed on a corrupt existing bundle instead of treating it as missing", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-corrupt-"));
    const store = new HookSessionTicketStore({ directory });
    const path = store.bundlePath(identity);
    writeFileSync(path, '{"version":1,"payload":{},"payloadSha256":"bad"}\n', {
      encoding: "utf8",
      mode: 0o600,
    });

    await expect(store.read(identity)).rejects.toThrow(/ticket_store_integrity/u);
    await expect(
      store.withRecord(identity, async () => {
        throw new Error("must_not_run");
      }),
    ).rejects.toThrow(/ticket_store_integrity/u);
    expect(readFileSync(path, "utf8")).toContain('"payloadSha256":"bad"');
  });

  it("keeps a terminal tombstone when deletion is interrupted", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "crossagent-hook-ticket-delete-"));
    const store = new HookSessionTicketStore({ directory, retainDeleteTombstone: true });
    const record = createInitialTicketRecord(identity, {
      controlToken: randomBytes(32).toString("base64url"),
      captureToken: randomBytes(32).toString("base64url"),
      now: "2026-08-01T00:00:00.000Z",
    });
    const pending = record.pending!;
    const active = nextTicketRecord(record, {
      state: "ACTIVE",
      pending: null,
      active: {
        ...pending,
        control: { ...pending.control, offerId: "stk_control" },
        capture: { ...pending.capture, offerId: "stk_capture" },
        session: {
          id: "ses_store",
          projectId: identity.projectId,
          agentId: "codex",
          role: "primary",
          client: "codex-cli-hooks",
          transport: "hook-poll",
          deliveryMode: "hook_poll",
          externalSessionId: identity.externalSessionId,
          externalThreadId: identity.externalThreadId,
          externalTurnId: null,
          host: "test",
          pid: 1,
          cwd: "C:/projects/example",
          gitBranch: null,
          gitHead: null,
          capabilities: [],
          connectedAt: "2026-08-01T00:00:01.000Z",
          transportLastSeenAt: "2026-08-01T00:00:01.000Z",
          activityLastSeenAt: "2026-08-01T00:00:01.000Z",
          workState: "IDLE",
          connectionState: "ONLINE",
          currentTaskId: null,
          currentReviewId: null,
          activeFiles: [],
          queueDepth: 0,
          lineageId: "lin_store",
          incarnation: 1,
          predecessorSessionId: null,
          supersededBySessionId: null,
          launcherRunId: null,
          launchGeneration: null,
          version: 0,
        },
        binding: {
          bundleId: pending.bundleId,
          state: "ACTIVE",
          projectId: identity.projectId,
          agentId: "codex",
          adapterClient: "codex",
          hubSessionId: "ses_store",
          lineageId: "lin_store",
          incarnation: 1,
          runId: pending.runId,
          activatedAt: "2026-08-01T00:00:01.000Z",
          expiresAt: "2026-08-02T00:00:01.000Z",
          purposes: [
            { id: "stk_control", purpose: "CONTROL", state: "ACTIVE" },
            { id: "stk_capture", purpose: "CAPTURE", state: "ACTIVE" },
          ],
        },
        serverNow: "2026-08-01T00:00:01.000Z",
        observedAt: "2026-08-01T00:00:01.000Z",
      },
    });
    await store.withRecord(identity, (transaction) => transaction.save(record));
    await store.withRecord(identity, (transaction) => transaction.save(active));
    await store.withRecord(identity, (transaction) =>
      transaction.remove({
        bundleId: pending.bundleId,
        hubSessionId: "ses_store",
        state: "REVOKED",
        terminalAt: "2026-08-01T00:00:02.000Z",
      }),
    );

    await expect(store.read(identity)).resolves.toBeNull();
    expect(readdirSync(directory)).toContain(`${store.identityDigest(identity)}.deleted.json`);
    await expect(
      store.withRecord(identity, (transaction) => {
        transaction.save(
          createInitialTicketRecord(identity, {
            controlToken: randomBytes(32).toString("base64url"),
            captureToken: randomBytes(32).toString("base64url"),
            now: "2026-08-01T00:00:03.000Z",
          }),
        );
      }),
    ).rejects.toThrow(/^ticket_store_terminal_identity_reuse_forbidden$/u);
    expect(readdirSync(directory).filter((name) => name.endsWith(".bundle.json"))).toEqual([]);
  });
});
