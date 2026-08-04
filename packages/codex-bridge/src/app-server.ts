import { EventEmitter } from "node:events";
import { execa, type ResultPromise } from "execa";
import { JsonLineRpcConnection, type JsonRpcMessage } from "./rpc.js";

export type CodexAppServerOptions = {
  command?: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  experimentalApi?: boolean;
  argsPrefix?: string[];
};

export class CodexAppServer extends EventEmitter {
  private process: ResultPromise | null = null;
  private connection: JsonLineRpcConnection | null = null;
  private generation = 0;
  private environment: NodeJS.ProcessEnv;

  constructor(private readonly options: CodexAppServerOptions) {
    super();
    this.environment = { ...(options.environment ?? {}) };
  }

  get activeGeneration(): number | null {
    return this.process ? this.generation : null;
  }

  /** Install the next child-only credential set; a running child is immutable and must restart. */
  replaceEnvironment(environment: NodeJS.ProcessEnv): void {
    if (this.process || this.connection) {
      throw new Error("Codex app-server environment can change only while the child is stopped");
    }
    this.environment = { ...environment };
  }

  async start(): Promise<Record<string, unknown>> {
    if (this.connection) throw new Error("Codex app-server is already running");
    const generation = ++this.generation;
    const child = execa(
      this.options.command ?? "codex",
      [...(this.options.argsPrefix ?? []), "app-server", "--listen", "stdio://"],
      {
        cwd: this.options.cwd,
        env: this.environment,
        extendEnv: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        reject: false,
        windowsHide: true,
      },
    );
    this.process = child;
    void child.then((result) => {
      this.emit("exit", {
        exitCode: result.exitCode,
        stderr: result.stderr,
        generation,
      });
    });
    try {
      if (!child.stdout || !child.stdin) {
        throw new Error("Codex app-server stdio was not created");
      }
      this.connection = new JsonLineRpcConnection(child.stdout, child.stdin);
      this.connection.on("notification", (message: JsonRpcMessage) =>
        this.emit("notification", message),
      );
      this.connection.on("protocol-error", (error) => this.emit("protocol-error", error));
      child.stderr?.on("data", (chunk) => this.emit("stderr", String(chunk)));
      const initialized = await this.connection.request<Record<string, unknown>>(
        "initialize",
        {
          clientInfo: {
            name: "crossagent_hub",
            title: "CrossAgent Hub",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: this.options.experimentalApi ?? true,
            optOutNotificationMethods: ["item/agentMessage/delta"],
          },
        },
        20_000,
      );
      this.connection.notify("initialized", {});
      return initialized;
    } catch (error: unknown) {
      // Starting is transactional at this Module's Interface. Once a child or connection is exposed
      // through fields, every failing path must roll both back so callers can safely retry.
      await this.stop();
      throw error;
    }
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.connection) throw new Error("Codex app-server is not running");
    return this.connection.request<T>(method, params, timeoutMs);
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.connection) throw new Error("Codex app-server is not running");
    this.connection.notify(method, params);
  }

  async probeCapabilities(): Promise<{
    models: unknown[];
    methods: string[];
    experimentalApi: boolean;
  }> {
    const response = await this.request<{ data?: unknown[] }>("model/list", {
      limit: 20,
      includeHidden: false,
    });
    return {
      models: response.data ?? [],
      methods: ["thread/start", "thread/resume", "turn/start", "turn/steer", "thread/inject_items"],
      experimentalApi: this.options.experimentalApi ?? true,
    };
  }

  async stop(): Promise<void> {
    this.connection?.close();
    this.connection = null;
    const child = this.process;
    this.process = null;
    if (!child) return;
    let exited = false;
    const exit = child.then(
      () => {
        exited = true;
      },
      () => {
        exited = true;
      },
    );
    child.kill("SIGTERM");
    let graceTimer: NodeJS.Timeout | null = null;
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, 3_000);
        graceTimer.unref();
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    // ChildProcess.killed only means kill() accepted the signal. A process may ignore SIGTERM and
    // remain alive, so escalation must be based on observed exit settlement instead.
    if (!exited) {
      child.kill("SIGKILL");
      await exit;
    }
  }
}
