import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";

export type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class JsonLineRpcConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly lines: readline.Interface;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    super();
    this.lines = readline.createInterface({ input, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.onLine(line));
    this.lines.on("close", () => this.rejectAll(new Error("Codex app-server stream closed")));
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    this.write({ method, id, params });
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  close(): void {
    this.lines.close();
    this.rejectAll(new Error("Codex app-server connection closed"));
  }

  private write(message: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit("protocol-error", new Error("Codex app-server emitted invalid JSONL"));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          `Codex app-server error ${message.error.code}: ${message.error.message}`,
        );
        Object.assign(error, { code: message.error.code, data: message.error.data });
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
