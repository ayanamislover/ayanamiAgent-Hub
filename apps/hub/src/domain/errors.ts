export class HubError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = "HUB_ERROR",
    readonly current?: unknown,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export class NotFoundError extends HubError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 404, "NOT_FOUND");
  }
}

export class ConflictError extends HubError {
  constructor(message: string, current?: unknown) {
    super(message, 409, "VERSION_CONFLICT", current);
  }
}

export class ForbiddenError extends HubError {
  constructor(message: string) {
    super(message, 403, "FORBIDDEN");
  }
}

/** Message prefixes the migrations RAISE(ABORT) with. Each names a deliberate durable invariant. */
const DURABLE_FENCE_PREFIXES = ["live session fence: "];

function fenceCode(message: string): string {
  return message
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
}

/**
 * Translates a refusal by the database's own fences into an answer a caller can act on.
 *
 * A RAISE(ABORT) is not an internal fault: it is the durable layer stating that the write it was
 * asked for is not permitted, which is a 409 in every sense that matters. Left untranslated it
 * escaped as an unhandled 500, and a 500 is precisely the status clients are built to retry --
 * so a permanent refusal presented as a transient one, and at least one client retried it
 * indefinitely rather than changing what it asked for.
 *
 * Only the fences we author qualify. Every other constraint failure stays a 500, deliberately: a
 * uniqueness violation we did not anticipate, or a trigger firing where we expected none, is a
 * fault on this side, and the caller could not have asked for anything different. Narrowing this
 * way also keeps SQLite's own wording about our schema out of responses.
 */
export function hubErrorFromDatabase(error: unknown): HubError | null {
  if (!(error instanceof Error)) return null;
  const sqliteCode = (error as { code?: unknown }).code;
  if (typeof sqliteCode !== "string" || !sqliteCode.startsWith("SQLITE_CONSTRAINT")) return null;
  if (!DURABLE_FENCE_PREFIXES.some((prefix) => error.message.startsWith(prefix))) return null;
  return new HubError(error.message, 409, fenceCode(error.message));
}
