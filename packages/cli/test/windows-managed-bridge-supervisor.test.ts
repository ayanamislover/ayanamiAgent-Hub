import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  WindowsManagedBridgeSingleton,
  WindowsManagedBridgeTaskScheduler,
  buildWindowsManagedBridgeTaskXml,
  windowsManagedBridgePipePath,
  type WindowsNamedPipeAdapter,
  type WindowsTaskCommandAdapter,
} from "../src/windows-managed-bridge-supervisor.js";

describe("Windows managed Bridge supervisor activation", () => {
  it("builds a least-privilege multi-day Task Scheduler definition with no secret arguments", () => {
    const xml = buildWindowsManagedBridgeTaskXml({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryPath: "C:\\work\\crossagent-hub\\packages\\cli\\dist\\bin.js",
      dataDir: "C:\\Users\\Example\\.crossagent",
    });

    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>999</Count>");
    expect(xml).toContain("managed-bridge supervise --data-dir");
    expect(xml).not.toMatch(/--token|credential|bearer|MODEL_MCP/i);
  });

  it("uses schtasks.exe only and keeps create/query/run/delete explicit", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const adapter: WindowsTaskCommandAdapter = {
      execute: async (executable, args) => {
        calls.push({ executable, args });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };
    const scheduler = new WindowsManagedBridgeTaskScheduler({ adapter });
    await scheduler.install("CrossAgent Managed Bridge", "C:\\Temp\\crossagent-task.xml");
    await scheduler.query("CrossAgent Managed Bridge");
    await scheduler.start("CrossAgent Managed Bridge");
    await scheduler.uninstall("CrossAgent Managed Bridge");

    expect(calls.map((call) => call.executable)).toEqual([
      "schtasks.exe",
      "schtasks.exe",
      "schtasks.exe",
      "schtasks.exe",
    ]);
    expect(calls.map((call) => call.args[0])).toEqual(["/Create", "/Query", "/Run", "/Delete"]);
    expect(calls[0]?.args).toEqual([
      "/Create",
      "/TN",
      "CrossAgent Managed Bridge",
      "/XML",
      "C:\\Temp\\crossagent-task.xml",
      "/F",
    ]);
  });

  it("fails closed when schtasks.exe reports an error", async () => {
    const scheduler = new WindowsManagedBridgeTaskScheduler({
      adapter: {
        execute: async () => ({ exitCode: 5, stdout: "", stderr: "access denied" }),
      },
    });
    await expect(
      scheduler.install("CrossAgent Managed Bridge", "C:\\Temp\\crossagent-task.xml"),
    ).rejects.toThrow(/schtasks.*access denied/i);
  });

  it("rejects control characters in every Task Scheduler path before producing XML", () => {
    const valid = {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entryPath: "C:\\work\\crossagent-hub\\packages\\cli\\dist\\bin.js",
      dataDir: "C:\\Users\\Example\\.crossagent",
    };
    for (const field of ["nodePath", "entryPath", "dataDir"] as const) {
      expect(() =>
        buildWindowsManagedBridgeTaskXml({ ...valid, [field]: `${valid[field]}\rforged` }),
      ).toThrow(/absolute bounded path|forbidden control/i);
    }
  });
});

describe("Windows managed Bridge named-pipe singleton", () => {
  it("derives a stable non-secret per-data-dir pipe path", () => {
    const first = windowsManagedBridgePipePath("C:\\Users\\Example\\.crossagent");
    expect(first).toBe(windowsManagedBridgePipePath("C:\\Users\\Example\\.crossagent"));
    expect(first).toMatch(/^\\\\\.\\pipe\\crossagent-managed-bridge-[a-f0-9]{32}$/);
    expect(first).not.toContain("ayanami");
  });

  it("holds exactly one lease and releases it for crash/restart recovery", async () => {
    const occupied = new Set<string>();
    class FakeListener extends EventEmitter {
      listening = true;

      constructor(readonly path: string) {
        super();
      }

      async close(): Promise<void> {
        if (!this.listening) return;
        this.listening = false;
        occupied.delete(this.path);
        this.emit("close");
      }
    }
    const listen = vi.fn(async (path: string) => {
      if (occupied.has(path))
        throw Object.assign(new Error("pipe already owned"), { code: "EADDRINUSE" });
      occupied.add(path);
      return new FakeListener(path);
    });
    const adapter: WindowsNamedPipeAdapter = { listen };
    const first = new WindowsManagedBridgeSingleton({
      dataDir: "C:\\Users\\Example\\.crossagent",
      adapter,
    });
    const duplicate = new WindowsManagedBridgeSingleton({
      dataDir: "C:\\Users\\Example\\.crossagent",
      adapter,
    });

    const lease = await first.acquire();
    await expect(duplicate.acquire()).rejects.toThrow(/already owned/i);
    await lease.close();
    expect(() => lease.assertOwned()).toThrow(/not owned/i);
    await expect(duplicate.acquire()).resolves.toMatchObject({ pipePath: lease.pipePath });
  });

  it.each(["error", "close"] as const)(
    "invalidates the typed IPC lease on a post-listen %s event",
    async (event) => {
      class FaultableListener extends EventEmitter {
        listening = true;

        async close(): Promise<void> {
          if (!this.listening) return;
          this.listening = false;
          this.emit("close");
        }

        fail(): void {
          this.listening = false;
          if (event === "error") this.emit("error", new Error("injected pipe failure"));
          else this.emit("close");
        }
      }
      const listener = new FaultableListener();
      const singleton = new WindowsManagedBridgeSingleton({
        dataDir: "C:\\Users\\Example\\.crossagent",
        adapter: { listen: async () => listener },
      });
      const lease = await singleton.acquire();
      expect(lease.active).toBe(true);
      listener.fail();
      expect(lease.active).toBe(false);
      expect(() => lease.assertOwned()).toThrow(/not active|not owned/i);
    },
  );
});
