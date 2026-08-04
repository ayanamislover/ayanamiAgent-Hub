import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import {
  ManagedBridgeIpcLeaseController,
  type ManagedBridgeIpcLease,
  type ManagedBridgeIpcListenerLifecycle,
} from "./managed-bridge-ipc.js";

export type WindowsManagedBridgeTaskDefinition = {
  nodePath: string;
  entryPath: string;
  dataDir: string;
};

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteWindowsArgument(value: string): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("Windows supervisor argument contains a forbidden control character");
  }
  if (!/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2) + '"';
  return result;
}

/**
 * Build the per-user Task Scheduler definition. The action intentionally carries only immutable
 * executable paths and dataDir; Hub URLs, bearer credentials, MODEL_MCP tickets, and vault content
 * are outside this Adapter's Interface.
 */
export function buildWindowsManagedBridgeTaskXml(
  definition: WindowsManagedBridgeTaskDefinition,
): string {
  for (const [name, value] of Object.entries(definition)) {
    assertAbsolutePath(value, name);
  }
  const argumentsLine = [
    quoteWindowsArgument(definition.entryPath),
    "managed-bridge",
    "supervise",
    "--data-dir",
    quoteWindowsArgument(definition.dataDir),
  ].join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CrossAgent managed Bridge supervisor</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowHardTerminate>true</AllowHardTerminate>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(definition.nodePath)}</Command>
      <Arguments>${xmlEscape(argumentsLine)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export type WindowsTaskCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface WindowsTaskCommandAdapter {
  execute(executable: string, args: readonly string[]): Promise<WindowsTaskCommandResult>;
}

const nodeWindowsTaskCommandAdapter: WindowsTaskCommandAdapter = {
  execute: async (executable, args) =>
    new Promise<WindowsTaskCommandResult>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    }),
};

export class WindowsManagedBridgeTaskScheduler {
  readonly #adapter: WindowsTaskCommandAdapter;

  constructor(options: { adapter?: WindowsTaskCommandAdapter } = {}) {
    this.#adapter = options.adapter ?? nodeWindowsTaskCommandAdapter;
  }

  install(taskName: string, xmlPath: string): Promise<WindowsTaskCommandResult> {
    assertTaskName(taskName);
    assertAbsolutePath(xmlPath, "xmlPath");
    return this.#run(["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
  }

  query(taskName: string): Promise<WindowsTaskCommandResult> {
    assertTaskName(taskName);
    return this.#run(["/Query", "/TN", taskName]);
  }

  start(taskName: string): Promise<WindowsTaskCommandResult> {
    assertTaskName(taskName);
    return this.#run(["/Run", "/TN", taskName]);
  }

  uninstall(taskName: string): Promise<WindowsTaskCommandResult> {
    assertTaskName(taskName);
    return this.#run(["/Delete", "/TN", taskName, "/F"]);
  }

  async #run(args: readonly string[]): Promise<WindowsTaskCommandResult> {
    const result = await this.#adapter.execute("schtasks.exe", args);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.exitCode}`)
        .replace(/[\r\n\0]+/g, " ")
        .trim()
        .slice(0, 500);
      throw new Error(`schtasks.exe failed: ${detail}`);
    }
    return result;
  }
}

export interface WindowsManagedBridgeIpcListener extends ManagedBridgeIpcListenerLifecycle {
  close(): Promise<void>;
}

export interface WindowsNamedPipeAdapter {
  listen(pipePath: string): Promise<WindowsManagedBridgeIpcListener>;
}

const nodeWindowsNamedPipeAdapter: WindowsNamedPipeAdapter = {
  listen: async (pipePath) =>
    new Promise((resolve, reject) => {
      const server = createServer((socket) => socket.destroy());
      const onError = (error: Error) => {
        server.close();
        reject(error);
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        // Keep EventEmitter error delivery non-fatal during the narrow resolve/bind handoff. The
        // typed lifecycle listener installed by ManagedBridgeIpcLeaseController still receives it.
        server.on("error", () => undefined);
        const lifecycle: WindowsManagedBridgeIpcListener = {
          get listening() {
            return server.listening;
          },
          on: (event, listener) => server.on(event, listener),
          close: () =>
            new Promise<void>((resolveClose, rejectClose) => {
              server.close((error) => (error ? rejectClose(error) : resolveClose()));
            }),
        };
        resolve(lifecycle);
      });
      server.listen(pipePath);
    }),
};

export type WindowsManagedBridgeSingletonLease = ManagedBridgeIpcLease & {
  pipePath: string;
  assertOwned(): void;
  close(): Promise<void>;
};

export function windowsManagedBridgePipePath(dataDir: string): string {
  assertAbsolutePath(dataDir, "dataDir");
  const digest = createHash("sha256")
    .update(dataDir.replace(/[\\/]+$/u, "").toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return `\\\\.\\pipe\\crossagent-managed-bridge-${digest}`;
}

export class WindowsManagedBridgeSingleton {
  readonly #pipePath: string;
  readonly #adapter: WindowsNamedPipeAdapter;
  readonly #leaseController = new ManagedBridgeIpcLeaseController();
  #currentLease: ManagedBridgeIpcLease | null = null;

  constructor(options: { dataDir: string; adapter?: WindowsNamedPipeAdapter }) {
    this.#pipePath = windowsManagedBridgePipePath(options.dataDir);
    this.#adapter = options.adapter ?? nodeWindowsNamedPipeAdapter;
  }

  async acquire(): Promise<WindowsManagedBridgeSingletonLease> {
    if (this.#currentLease?.active) {
      throw new Error("Managed Bridge named pipe is already owned by this instance");
    }
    const underlying = await this.#adapter.listen(this.#pipePath);
    let ipcLease: ManagedBridgeIpcLease;
    try {
      ipcLease = this.#leaseController.bindAfterListen(underlying);
    } catch (error) {
      await underlying.close().catch(() => undefined);
      throw error;
    }
    this.#currentLease = ipcLease;
    let closed = false;
    return {
      pipePath: this.#pipePath,
      get leaseId() {
        return ipcLease.leaseId;
      },
      get generation() {
        return ipcLease.generation;
      },
      get active() {
        return !closed && ipcLease.active;
      },
      assertActive: () => {
        if (closed) throw new Error("Managed Bridge named-pipe lease is not active");
        ipcLease.assertActive();
      },
      assertOwned: () => {
        if (closed) throw new Error("Managed Bridge named-pipe lease is not owned");
        try {
          ipcLease.assertActive();
        } catch {
          throw new Error("Managed Bridge named-pipe lease is not owned");
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await underlying.close();
        if (this.#currentLease === ipcLease) this.#currentLease = null;
      },
    };
  }
}

function assertTaskName(value: string): void {
  if (!value || value.length > 238 || /[\r\n\0]/.test(value)) {
    throw new Error("Task name must be non-empty, bounded, and single-line");
  }
}

function assertAbsolutePath(value: string, name: string): void {
  if (!value || value.length > 4_096 || !isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be an absolute bounded path`);
  }
}
