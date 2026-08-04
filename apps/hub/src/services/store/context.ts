import { createHash } from "node:crypto";
import { createId, nowIso } from "@crossagent/protocol";
import type Database from "better-sqlite3";
import type { DomainEvent } from "@crossagent/protocol";
import { ConflictError, NotFoundError } from "../../domain/errors.js";
import type { EventBus } from "../../events/event-bus.js";

export type HubStoreOptions = {
  dataDir: string;
};

export type EventDraft = Omit<DomainEvent, "id" | "sequence" | "createdAt">;
export type MutationContext = { emit: (draft: EventDraft) => DomainEvent };
export type MutationOptions = {
  requestFingerprint?: string;
  validateReplay?: (cachedResponse: unknown) => void;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/** A bounded, property-order-independent identity for an idempotent mutation request. */
export function mutationFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "undefined")
    .digest("hex");
}

/**
 * What every domain module is allowed to reach for.
 *
 * The store used to be one class, so any method could touch any other method's tables and any of the
 * injected dependencies. Handing the domain modules this narrow context instead is what makes the
 * split mean something: a module can open the database and it can emit events inside a transaction,
 * but it cannot reach sideways into another domain's internals. Cross-domain work goes through the
 * other domain's exported function, so the dependency shows up as an import and stays reviewable.
 */
export type StoreContext = {
  readonly sqlite: Database.Database;
  readonly bus: EventBus;
  readonly options: HubStoreOptions;
  mutate<T>(
    projectId: string,
    idempotencyKey: string,
    operation: string,
    action: (context: MutationContext) => T,
    options?: MutationOptions,
  ): T;
  /**
   * Exposed because six operations legitimately run their own transaction instead of going through
   * `mutate`: they are either not idempotency-keyed (presence derivation, terminal audit) or they
   * write outside the database first (joinProject touches .crossagent/ on disk). Those callers own
   * publishing the returned event themselves, which is why this is not folded into `mutate`.
   */
  appendEvent(draft: EventDraft): DomainEvent;
};

export function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function bool(value: unknown): boolean {
  return Number(value) === 1;
}

export function createStoreContext(
  sqlite: Database.Database,
  bus: EventBus,
  options: HubStoreOptions,
): StoreContext {
  // Nested aggregate mutations share one publication buffer. SQLite turns the inner transaction
  // into a savepoint, while events stay invisible to WebSocket subscribers until the outermost
  // transaction commits. This is the composition seam used by task/review mutations that must
  // create their collaboration message atomically with the aggregate state change.
  let activeMutationEvents: DomainEvent[] | null = null;

  /**
   * Allocates the next project sequence and writes the event in the same statement, so two
   * concurrent mutations can never hand out the same sequence number.
   */
  const appendEvent = (draft: EventDraft): DomainEvent => {
    const sequenceRow = sqlite
      .prepare(
        "UPDATE projects SET current_sequence = current_sequence + 1, updated_at = ? WHERE id = ? RETURNING current_sequence",
      )
      .get(nowIso(), draft.projectId) as { current_sequence: number } | undefined;
    if (!sequenceRow) throw new NotFoundError("Project", draft.projectId);
    const event: DomainEvent = {
      ...draft,
      id: createId("evt"),
      sequence: sequenceRow.current_sequence,
      createdAt: nowIso(),
    };
    sqlite
      .prepare(
        `INSERT INTO events(
          id, project_id, sequence, type, actor_type, actor_id, aggregate_type,
          aggregate_id, causation_id, correlation_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.projectId,
        event.sequence,
        event.type,
        event.actorType,
        event.actorId,
        event.aggregateType,
        event.aggregateId,
        event.causationId,
        event.correlationId,
        JSON.stringify(event.payload ?? null),
        event.createdAt,
      );
    return event;
  };

  /**
   * One write, one transaction, one idempotency record. Events are collected during the transaction
   * and only published after it commits, so a subscriber can never observe an event for a mutation
   * that later rolled back. A replayed key returns the stored response and publishes nothing.
   */
  const mutate = <T>(
    projectId: string,
    idempotencyKey: string,
    operation: string,
    action: (context: MutationContext) => T,
    mutationOptions?: MutationOptions,
  ): T => {
    const outermost = activeMutationEvents === null;
    const events = activeMutationEvents ?? [];
    const eventCheckpoint = events.length;
    if (outermost) activeMutationEvents = events;
    const idempotencyOperation = mutationOptions?.requestFingerprint
      ? `${operation}#${mutationOptions.requestFingerprint}`
      : operation;
    const transaction = sqlite.transaction(() => {
      const cached = sqlite
        .prepare(
          "SELECT operation, response_json FROM idempotency_keys WHERE project_id = ? AND key = ?",
        )
        .get(projectId, idempotencyKey) as { operation: string; response_json: string } | undefined;
      if (cached) {
        if (cached.operation !== idempotencyOperation) {
          throw new ConflictError(`Idempotency key was already used for ${cached.operation}`);
        }
        const cachedResponse = JSON.parse(cached.response_json) as T;
        mutationOptions?.validateReplay?.(cachedResponse);
        return cachedResponse;
      }
      const result = action({
        emit: (draft) => {
          const event = appendEvent(draft);
          events.push(event);
          return event;
        },
      });
      sqlite
        .prepare(
          `INSERT INTO idempotency_keys(project_id, key, operation, response_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(projectId, idempotencyKey, idempotencyOperation, JSON.stringify(result), nowIso());
      return result;
    });
    let result: T;
    try {
      result = transaction();
    } catch (error) {
      // A nested savepoint may already have appended events before a later statement failed. Those
      // rows rolled back with SQLite and must not leak through a caught inner exception.
      events.length = eventCheckpoint;
      if (outermost) activeMutationEvents = null;
      throw error;
    }
    if (outermost) {
      // Commit is complete before publishing. Clear the nesting marker first so a synchronous bus
      // subscriber that starts a new mutation owns a fresh transaction and publication buffer.
      activeMutationEvents = null;
      for (const event of events) bus.publish(event);
    }
    return result;
  };

  return { sqlite, bus, options, mutate, appendEvent };
}
