export const RUNTIME_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const RUNTIME_LOG_MAX_ARCHIVES = 4;
export const RUNTIME_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
export const RUNTIME_LOG_TOTAL_BUDGET_BYTES = 80 * 1024 * 1024;

export interface RuntimeLogFileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * The process which owns the open log handle implements this seam. In particular,
 * renameAtomicSameDirectory must never fall back to copy/unlink.
 */
export interface RuntimeLogStorageAdapter {
  stat(path: string): Promise<RuntimeLogFileEntry | undefined>;
  list(directory: string): Promise<RuntimeLogFileEntry[]>;
  append(path: string, completeLine: string): Promise<void>;
  closeOwner(path: string): Promise<void>;
  renameAtomicSameDirectory(source: string, destination: string): Promise<void>;
  reopenOwner(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  now(): number;
}

export type RuntimeLogFailureCode =
  | "UNSAFE_LOG_EVENT"
  | "LOG_DISK_FULL"
  | "LOG_APPEND_FAILED"
  | "LOG_ROTATION_SHARING_VIOLATION"
  | "LOG_ROTATION_FAILED"
  | "LOG_REOPEN_FAILED"
  | "LOG_RETENTION_FAILED";

export class RuntimeLogFailure extends Error {
  readonly code: RuntimeLogFailureCode;

  constructor(code: RuntimeLogFailureCode) {
    super(code);
    this.name = "RuntimeLogFailure";
    this.code = code;
  }
}

type RuntimeStartedEvent = {
  event: "runtime.started";
  buildId: string;
  instanceId: string;
  port: number;
};

type RuntimeStoppedEvent = {
  event: "runtime.stopped";
  reasonCode: string;
};

type RuntimeStateChangedEvent = {
  event: "runtime.state_changed";
  component: string;
  from: string;
  to: string;
  reasonCode?: string;
};

type RuntimeErrorEvent = {
  event: "runtime.error";
  operation: string;
  code: string;
  retryable: boolean;
  errorClass?: string;
};

type BridgeStateChangedEvent = {
  event: "bridge.state_changed";
  projectId: string;
  agentId: string;
  from: string;
  to: string;
  reasonCode?: string;
};

type BridgeErrorEvent = {
  event: "bridge.error";
  projectId: string;
  agentId: string;
  operation: string;
  code: string;
  retryable: boolean;
};

type HttpFailureEvent = {
  event: "http.failure";
  method: string;
  routeTemplate: string;
  statusCode: number;
  durationMs: number;
  errorCode?: string;
};

type SecurityRejectedEvent = {
  event: "security.rejected";
  surface: string;
  code: string;
  actorType?: string;
};

export type RuntimeLogEvent =
  | RuntimeStartedEvent
  | RuntimeStoppedEvent
  | RuntimeStateChangedEvent
  | RuntimeErrorEvent
  | BridgeStateChangedEvent
  | BridgeErrorEvent
  | HttpFailureEvent
  | SecurityRejectedEvent;

export interface RuntimeLogOptions {
  currentPath: string;
  storage: RuntimeLogStorageAdapter;
  maxBytes?: number;
  maxArchives?: number;
  maxAgeMs?: number;
  totalBudgetBytes?: number;
}

export interface HttpObservation {
  method: string;
  routeTemplate: string;
  statusCode: number;
  durationMs: number;
  errorCode?: string;
}

type FieldKind = "boolean" | "code" | "id" | "method" | "number" | "port" | "route" | "status";

interface EventSchema {
  required: Readonly<Record<string, FieldKind>>;
  optional?: Readonly<Record<string, FieldKind>>;
}

const schemas: Readonly<Record<RuntimeLogEvent["event"], EventSchema>> = {
  "runtime.started": {
    required: { buildId: "id", instanceId: "id", port: "port" },
  },
  "runtime.stopped": {
    required: { reasonCode: "code" },
  },
  "runtime.state_changed": {
    required: { component: "code", from: "code", to: "code" },
    optional: { reasonCode: "code" },
  },
  "runtime.error": {
    required: { operation: "code", code: "code", retryable: "boolean" },
    optional: { errorClass: "code" },
  },
  "bridge.state_changed": {
    required: { projectId: "id", agentId: "id", from: "code", to: "code" },
    optional: { reasonCode: "code" },
  },
  "bridge.error": {
    required: {
      projectId: "id",
      agentId: "id",
      operation: "code",
      code: "code",
      retryable: "boolean",
    },
  },
  "http.failure": {
    required: {
      method: "method",
      routeTemplate: "route",
      statusCode: "status",
      durationMs: "number",
    },
    optional: { errorCode: "code" },
  },
  "security.rejected": {
    required: { surface: "code", code: "code" },
    optional: { actorType: "code" },
  },
};

const prohibitedKeys = new Set([
  "authorization",
  "body",
  "cookie",
  "credential",
  "credentials",
  "header",
  "headers",
  "password",
  "prompt",
  "query",
  "rawbody",
  "rawheaders",
  "rawurl",
  "secret",
  "setcookie",
  "stderr",
  "token",
  "url",
]);

const codePattern = /^[A-Za-z0-9_.:-]{1,160}$/u;
const idPattern = /^[A-Za-z0-9_.:-]{1,256}$/u;
const routeTemplatePattern = /^\/[A-Za-z0-9_./:-]{0,255}$/u;
const methodPattern = /^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/u;
const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /(?:^|[?&;\s])(?:access[_-]?token|api[_-]?key|credential|password|secret|token)\s*=/iu,
  /(?:authorization|cookie|proxy-authorization|set-cookie)\s*[:=]/iu,
  /\b(?:gh[opsu]|github_pat|sk|xox[baprs])[-_][A-Za-z0-9_-]{8,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;

function unsafe(): never {
  throw new RuntimeLogFailure("UNSAFE_LOG_EVENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scanForUnsafeMaterial(value: unknown, depth = 0): void {
  if (depth > 4) unsafe();
  if (typeof value === "string") {
    if (secretPatterns.some((pattern) => pattern.test(value))) unsafe();
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return;
  if (!isRecord(value)) unsafe();
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/gu, "");
    if (prohibitedKeys.has(normalizedKey)) unsafe();
    scanForUnsafeMaterial(nested, depth + 1);
  }
}

function validateField(kind: FieldKind, value: unknown): void {
  if (kind === "boolean") {
    if (typeof value !== "boolean") unsafe();
    return;
  }
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 3_600_000)
      unsafe();
    return;
  }
  if (kind === "port") {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65_535) unsafe();
    return;
  }
  if (kind === "status") {
    if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599) unsafe();
    return;
  }
  if (typeof value !== "string") unsafe();
  const valid =
    kind === "code"
      ? codePattern.test(value)
      : kind === "id"
        ? idPattern.test(value)
        : kind === "method"
          ? methodPattern.test(value)
          : routeTemplatePattern.test(value);
  if (!valid) unsafe();
}

function validateEvent(input: unknown): RuntimeLogEvent {
  scanForUnsafeMaterial(input);
  if (!isRecord(input) || typeof input.event !== "string" || !(input.event in schemas)) unsafe();
  const schema = schemas[input.event as RuntimeLogEvent["event"]];
  const allowed = new Set([
    "event",
    ...Object.keys(schema.required),
    ...Object.keys(schema.optional ?? {}),
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) unsafe();
  for (const [key, kind] of Object.entries(schema.required)) {
    if (!(key in input)) unsafe();
    validateField(kind, input[key]);
  }
  for (const [key, kind] of Object.entries(schema.optional ?? {})) {
    if (key in input && input[key] !== undefined) validateField(kind, input[key]);
  }
  return input as RuntimeLogEvent;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function pathDirectory(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0 ? "." : path.slice(0, slash);
}

function validateFileEntry(entry: RuntimeLogFileEntry | undefined, expectedPath?: string): void {
  if (entry === undefined) return;
  if (
    (expectedPath !== undefined && entry.path !== expectedPath) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    !Number.isFinite(entry.mtimeMs)
  ) {
    throw new RuntimeLogFailure("LOG_RETENTION_FAILED");
  }
}

export function shouldRotateRuntimeLog(
  existingBytes: number,
  maxBytes = RUNTIME_LOG_MAX_BYTES,
): boolean {
  return Number.isFinite(existingBytes) && existingBytes >= maxBytes;
}

export class RuntimeLog {
  private readonly currentPath: string;
  private readonly storage: RuntimeLogStorageAdapter;
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private readonly maxAgeMs: number;
  private readonly totalBudgetBytes: number;
  private readonly directory: string;
  private readonly archivePrefix: string;
  private rotationSequence = 0;
  private rotationInFlight: Promise<void> | undefined;
  private ownerTail: Promise<void> = Promise.resolve();

  constructor(options: RuntimeLogOptions) {
    this.currentPath = options.currentPath;
    this.storage = options.storage;
    this.maxBytes = options.maxBytes ?? RUNTIME_LOG_MAX_BYTES;
    this.maxArchives = options.maxArchives ?? RUNTIME_LOG_MAX_ARCHIVES;
    this.maxAgeMs = options.maxAgeMs ?? RUNTIME_LOG_MAX_AGE_MS;
    this.totalBudgetBytes = options.totalBudgetBytes ?? RUNTIME_LOG_TOTAL_BUDGET_BYTES;
    this.directory = pathDirectory(this.currentPath);
    this.archivePrefix = `${this.currentPath}.archive-`;
    if (
      !this.currentPath ||
      this.maxBytes <= 0 ||
      this.maxArchives < 0 ||
      this.maxAgeMs < 0 ||
      this.totalBudgetBytes <= 0
    ) {
      unsafe();
    }
  }

  async emit(input: RuntimeLogEvent): Promise<void> {
    const event = validateEvent(input);
    await this.enqueueOwnerOperation(async () => {
      try {
        const current = await this.storage.stat(this.currentPath);
        validateFileEntry(current, this.currentPath);
        if (current && shouldRotateRuntimeLog(current.size, this.maxBytes)) {
          await this.performRotation();
        }
        const completeLine = `${JSON.stringify({ at: new Date(this.storage.now()).toISOString(), ...event })}\n`;
        try {
          await this.storage.append(this.currentPath, completeLine);
        } catch (error) {
          if (errorCode(error) === "ENOSPC") throw new RuntimeLogFailure("LOG_DISK_FULL");
          throw new RuntimeLogFailure("LOG_APPEND_FAILED");
        }
      } catch (error) {
        if (error instanceof RuntimeLogFailure) throw error;
        throw new RuntimeLogFailure("LOG_APPEND_FAILED");
      }
    });
  }

  async observeHttp(observation: HttpObservation): Promise<boolean> {
    const event = validateEvent({ event: "http.failure", ...observation });
    if (observation.statusCode < 400) return false;
    await this.emit(event);
    return true;
  }

  rotate(): Promise<void> {
    if (this.rotationInFlight) return this.rotationInFlight;
    const operation = this.enqueueOwnerOperation(async () => {
      try {
        await this.performRotation();
      } catch (error) {
        if (error instanceof RuntimeLogFailure) throw error;
        const code = errorCode(error);
        if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
          throw new RuntimeLogFailure("LOG_ROTATION_SHARING_VIOLATION");
        }
        throw new RuntimeLogFailure("LOG_ROTATION_FAILED");
      }
    }).finally(() => {
      if (this.rotationInFlight === operation) this.rotationInFlight = undefined;
    });
    this.rotationInFlight = operation;
    return operation;
  }

  private enqueueOwnerOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.ownerTail.then(operation, operation);
    this.ownerTail = result.catch(() => undefined);
    return result;
  }

  private async performRotation(): Promise<void> {
    const current = await this.storage.stat(this.currentPath);
    validateFileEntry(current, this.currentPath);
    if (!current || current.size === 0) return;
    const existingPaths = new Set(
      (await this.storage.list(this.directory)).map(({ path }) => path),
    );
    let destination: string;
    do {
      this.rotationSequence += 1;
      destination = `${this.archivePrefix}${this.storage.now()}-${this.rotationSequence}`;
    } while (existingPaths.has(destination));

    await this.storage.closeOwner(this.currentPath);
    try {
      await this.storage.renameAtomicSameDirectory(this.currentPath, destination);
    } catch (error) {
      try {
        await this.storage.reopenOwner(this.currentPath);
      } catch {
        throw new RuntimeLogFailure("LOG_REOPEN_FAILED");
      }
      const code = errorCode(error);
      if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
        throw new RuntimeLogFailure("LOG_ROTATION_SHARING_VIOLATION");
      }
      throw new RuntimeLogFailure("LOG_ROTATION_FAILED");
    }
    try {
      await this.storage.reopenOwner(this.currentPath);
    } catch {
      throw new RuntimeLogFailure("LOG_REOPEN_FAILED");
    }
    await this.enforceRetention();
  }

  private async enforceRetention(): Promise<void> {
    try {
      let archives = (await this.storage.list(this.directory))
        .filter(({ path }) => {
          const suffix = path.slice(this.archivePrefix.length);
          return (
            path.startsWith(this.archivePrefix) &&
            pathDirectory(path) === this.directory &&
            /^\d+-\d+$/u.test(suffix)
          );
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
      for (const entry of archives) validateFileEntry(entry);
      const cutoff = this.storage.now() - this.maxAgeMs;
      const expired = archives.filter(({ mtimeMs }) => mtimeMs < cutoff);
      for (const entry of expired) await this.storage.remove(entry.path);
      const expiredPaths = new Set(expired.map(({ path }) => path));
      archives = archives.filter(({ path }) => !expiredPaths.has(path));

      const overCount = archives.slice(this.maxArchives);
      for (const entry of overCount) await this.storage.remove(entry.path);
      const overCountPaths = new Set(overCount.map(({ path }) => path));
      archives = archives.filter(({ path }) => !overCountPaths.has(path));

      const retainedCurrent = await this.storage.stat(this.currentPath);
      validateFileEntry(retainedCurrent, this.currentPath);
      const currentBytes = retainedCurrent?.size ?? 0;
      let totalBytes = currentBytes + archives.reduce((sum, entry) => sum + entry.size, 0);
      const oldestFirst = [...archives].sort(
        (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
      );
      while (totalBytes > this.totalBudgetBytes && oldestFirst.length > 0) {
        const oldest = oldestFirst.shift();
        if (!oldest) break;
        await this.storage.remove(oldest.path);
        totalBytes -= oldest.size;
      }
    } catch (error) {
      if (error instanceof RuntimeLogFailure) throw error;
      throw new RuntimeLogFailure("LOG_RETENTION_FAILED");
    }
  }
}
