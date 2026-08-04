import type { DomainEvent } from "@crossagent/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  EventPumpGapError,
  EventPumpQueueFullError,
  EventPumpStoppedError,
  OrderedProjectEventPump,
  type EventHandlingOutcome,
} from "../src/ordered-event-pump.js";

const projectId = "prj_ordered_pump";

function event(sequence: number): DomainEvent {
  return {
    id: `evt_${sequence.toString().padStart(4, "0")}`,
    projectId,
    sequence,
    type: "message.posted",
    actorType: "agent",
    actorId: "codex",
    aggregateType: "message",
    aggregateId: `msg_${sequence.toString().padStart(4, "0")}`,
    causationId: null,
    correlationId: null,
    payload: {},
    createdAt: new Date(1_700_000_000_000 + sequence).toISOString(),
  };
}

const handled = (status: EventHandlingOutcome["status"] = "processed") => ({ status });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("OrderedProjectEventPump", () => {
  it("serializes concurrent frames and fills a sequence gap before handling the live event", async () => {
    const order: number[] = [];
    const commits: number[] = [];
    const releaseFirst = deferred();
    const fetchEvents = vi.fn(async (afterSequence: number) =>
      afterSequence === 0 ? [event(1), event(2)] : [],
    );
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents,
      handleEvent: vi.fn(async (item) => {
        if (item.sequence === 1) await releaseFirst.promise;
        order.push(item.sequence);
        return handled();
      }),
      commitCursor: vi.fn(async (sequence) => {
        commits.push(sequence);
      }),
    });

    const subscribed = pump.enqueue({ type: "subscribed", currentSequence: 2 });
    const live = pump.enqueue({ type: "event", event: event(3) });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst.resolve();
    await Promise.all([subscribed, live]);

    expect(order).toEqual([1, 2, 3]);
    expect(commits).toEqual([1, 2, 3]);
    expect(pump.cursor).toBe(3);
  });

  it("skips duplicate event frames without handling or committing them again", async () => {
    const handleEvent = vi.fn(async () => handled());
    const commitCursor = vi.fn(async () => undefined);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 7,
      fetchEvents: vi.fn(async () => []),
      handleEvent,
      commitCursor,
    });

    await pump.enqueue({ type: "event", event: event(7) });
    await pump.enqueue({ type: "event", event: event(6) });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(commitCursor).not.toHaveBeenCalled();
    expect(pump.cursor).toBe(7);
  });

  it("fails a gap on an empty or non-contiguous resync page without polling", async () => {
    const fetchEvents = vi.fn(async () => [event(3)]);
    const handleEvent = vi.fn(async () => handled());
    const commitCursor = vi.fn(async () => undefined);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents,
      handleEvent,
      commitCursor,
    });

    await expect(pump.enqueue({ type: "event", event: event(4) })).rejects.toBeInstanceOf(
      EventPumpGapError,
    );
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(handleEvent).not.toHaveBeenCalled();
    expect(commitCursor).not.toHaveBeenCalled();
    expect(pump.cursor).toBe(0);
  });

  it("forces a reconnect when an overflow resync frame omits its authoritative high-water mark", async () => {
    const fetchEvents = vi.fn(async () => [event(1)]);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents,
      handleEvent: vi.fn(async () => handled()),
      commitCursor: vi.fn(async () => undefined),
    });

    await expect(pump.enqueue({ type: "resync_required" })).rejects.toBeInstanceOf(
      EventPumpGapError,
    );
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(pump.cursor).toBe(0);
  });

  it("paginates to the subscribed high-water mark beyond the Hub 5000-row cap", async () => {
    const allEvents = Array.from({ length: 5_001 }, (_, index) => event(index + 1));
    const fetchEvents = vi.fn(async (afterSequence: number, limit: number) =>
      allEvents.slice(afterSequence, afterSequence + limit),
    );
    const handledSequences: number[] = [];
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      pageSize: 5_000,
      fetchEvents,
      handleEvent: async (item) => {
        handledSequences.push(item.sequence);
        return handled();
      },
      commitCursor: async () => undefined,
    });

    await pump.enqueue({ type: "subscribed", currentSequence: 5_001 });

    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(fetchEvents.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [0, 5_000],
      [5_000, 5_000],
    ]);
    expect(handledSequences).toHaveLength(5_001);
    expect(handledSequences.at(-1)).toBe(5_001);
    expect(pump.cursor).toBe(5_001);
  });

  it("does not advance the cursor when the handler rejects and permits an exact retry", async () => {
    const handleEvent = vi
      .fn<(item: DomainEvent) => Promise<EventHandlingOutcome>>()
      .mockRejectedValueOnce(new Error("temporary delivery failure"))
      .mockResolvedValueOnce(handled());
    const commitCursor = vi.fn(async () => undefined);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents: vi.fn(async () => []),
      handleEvent,
      commitCursor,
    });

    await expect(pump.enqueue({ type: "event", event: event(1) })).rejects.toThrow(
      "temporary delivery failure",
    );
    expect(pump.cursor).toBe(0);
    expect(commitCursor).not.toHaveBeenCalled();

    await pump.enqueue({ type: "event", event: event(1) });
    expect(handleEvent).toHaveBeenCalledTimes(2);
    expect(commitCursor).toHaveBeenCalledOnce();
    expect(pump.cursor).toBe(1);
  });

  it("does not advance the cursor when persistence fails and retries the event", async () => {
    const handleEvent = vi.fn(async () => handled());
    const commitCursor = vi
      .fn<(sequence: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(undefined);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents: vi.fn(async () => []),
      handleEvent,
      commitCursor,
    });

    await expect(pump.enqueue({ type: "event", event: event(1) })).rejects.toThrow(
      "disk unavailable",
    );
    expect(pump.cursor).toBe(0);

    await pump.enqueue({ type: "event", event: event(1) });
    expect(handleEvent).toHaveBeenCalledTimes(2);
    expect(commitCursor).toHaveBeenCalledTimes(2);
    expect(pump.cursor).toBe(1);
  });

  it("commits an explicitly suppressed terminal event", async () => {
    const commitCursor = vi.fn(async () => undefined);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents: vi.fn(async () => []),
      handleEvent: vi.fn(async () => handled("suppressed")),
      commitCursor,
    });

    await pump.enqueue({ type: "event", event: event(1) });

    expect(commitCursor).toHaveBeenCalledWith(1, expect.any(AbortSignal));
    expect(pump.cursor).toBe(1);
  });

  it("stop aborts an in-flight handler before any cursor write and rejects later frames", async () => {
    const entered = deferred();
    const release = deferred();
    const commitCursor = vi.fn(async () => undefined);
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      fetchEvents: vi.fn(async () => []),
      handleEvent: vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return handled();
      }),
      commitCursor,
    });

    const pending = pump.enqueue({ type: "event", event: event(1) });
    await entered.promise;
    pump.stop();
    release.resolve();

    await expect(pending).rejects.toBeInstanceOf(EventPumpStoppedError);
    await expect(pump.enqueue({ type: "event", event: event(1) })).rejects.toBeInstanceOf(
      EventPumpStoppedError,
    );
    expect(commitCursor).not.toHaveBeenCalled();
    expect(pump.cursor).toBe(0);
  });

  it("bounds queued frames while preserving the in-flight frame", async () => {
    const entered = deferred();
    const release = deferred();
    const pump = new OrderedProjectEventPump({
      projectId,
      initialSequence: 0,
      maxQueuedFrames: 1,
      fetchEvents: vi.fn(async () => []),
      handleEvent: vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return handled();
      }),
      commitCursor: vi.fn(async () => undefined),
    });

    const first = pump.enqueue({ type: "event", event: event(1) });
    await entered.promise;
    const queued = pump.enqueue({ type: "event", event: event(2) });
    await expect(pump.enqueue({ type: "event", event: event(3) })).rejects.toBeInstanceOf(
      EventPumpQueueFullError,
    );
    release.resolve();
    await Promise.all([first, queued]);
    expect(pump.cursor).toBe(2);
  });
});
