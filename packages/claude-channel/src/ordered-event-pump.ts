import type { DomainEvent } from "@crossagent/protocol";

export type EventHandlingOutcome = {
  status: "processed" | "suppressed";
};

export type OrderedEventPumpFrame =
  | { type: "subscribed"; currentSequence: number }
  | { type: "event"; event: DomainEvent; historicalReplay?: boolean }
  | { type: "resync_required"; currentSequence?: number };

export type OrderedProjectEventPumpOptions = {
  projectId: string;
  initialSequence: number;
  pageSize?: number;
  maxQueuedFrames?: number;
  fetchEvents: (
    afterSequence: number,
    limit: number,
    signal: AbortSignal,
  ) => Promise<readonly DomainEvent[]>;
  handleEvent: (
    event: DomainEvent,
    signal: AbortSignal,
    historicalReplay: boolean,
  ) => Promise<EventHandlingOutcome>;
  commitCursor: (sequence: number, signal: AbortSignal) => Promise<void>;
};

export class EventPumpStoppedError extends Error {
  constructor() {
    super("The ordered event pump has stopped");
    this.name = "EventPumpStoppedError";
  }
}

export class EventPumpQueueFullError extends Error {
  constructor(maxQueuedFrames: number) {
    super(`The ordered event pump queue is full (${maxQueuedFrames} waiting frames)`);
    this.name = "EventPumpQueueFullError";
  }
}

export class EventPumpGapError extends Error {
  readonly expectedSequence: number;
  readonly receivedSequence: number | null;

  constructor(expectedSequence: number, receivedSequence: number | null) {
    super(
      receivedSequence === null
        ? `Event replay ended before sequence ${expectedSequence}`
        : `Expected event sequence ${expectedSequence}, received ${receivedSequence}`,
    );
    this.name = "EventPumpGapError";
    this.expectedSequence = expectedSequence;
    this.receivedSequence = receivedSequence;
  }
}

const DEFAULT_PAGE_SIZE = 5_000;
const DEFAULT_MAX_QUEUED_FRAMES = 256;

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Serializes live frames and REST replay behind one transport-neutral ordering boundary.
 *
 * `handleEvent` may perform an idempotent delivery side effect. The cursor is persisted only after
 * that handler explicitly returns `processed` or `suppressed`; a rejected handler or cursor write
 * leaves the event retryable. No timer is owned by this class: replay happens only in response to a
 * subscribed high-water mark, a gap, or an explicit resync frame.
 */
export class OrderedProjectEventPump {
  private readonly abortController = new AbortController();
  private readonly pageSize: number;
  private readonly maxQueuedFrames: number;
  private tail: Promise<void> = Promise.resolve();
  private waitingFrames = 0;
  private stopped = false;
  private currentSequence: number;
  private highWaterSequence: number;

  constructor(private readonly options: OrderedProjectEventPumpOptions) {
    if (!options.projectId) throw new TypeError("projectId is required");
    requireNonNegativeInteger(options.initialSequence, "initialSequence");
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) {
      throw new RangeError("pageSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxQueuedFrames) || this.maxQueuedFrames < 0) {
      throw new RangeError("maxQueuedFrames must be a non-negative safe integer");
    }
    this.currentSequence = options.initialSequence;
    this.highWaterSequence = options.initialSequence;
  }

  get cursor(): number {
    return this.currentSequence;
  }

  get highWaterMark(): number {
    return this.highWaterSequence;
  }

  get queuedFrames(): number {
    return this.waitingFrames;
  }

  enqueue(frame: OrderedEventPumpFrame): Promise<void> {
    if (this.stopped) return Promise.reject(new EventPumpStoppedError());
    if (this.waitingFrames >= this.maxQueuedFrames) {
      return Promise.reject(new EventPumpQueueFullError(this.maxQueuedFrames));
    }
    this.waitingFrames += 1;
    const job = this.tail.then(async () => {
      this.waitingFrames -= 1;
      this.throwIfStopped();
      await this.processFrame(frame);
    });
    // A failed delivery must reject its own enqueue call without poisoning later retries.
    this.tail = job.catch(() => undefined);
    return job;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort(new EventPumpStoppedError());
  }

  async whenIdle(): Promise<void> {
    await this.tail;
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new EventPumpStoppedError();
  }

  private async processFrame(frame: OrderedEventPumpFrame): Promise<void> {
    switch (frame.type) {
      case "subscribed": {
        requireNonNegativeInteger(frame.currentSequence, "currentSequence");
        this.highWaterSequence = Math.max(this.highWaterSequence, frame.currentSequence);
        await this.catchUpTo(this.highWaterSequence);
        return;
      }
      case "resync_required": {
        // The production overflow frame intentionally carries no cursor. Treating that as a
        // no-op would leave an unknown range permanently skipped; the Channel must reconnect and
        // obtain a fresh `subscribed.currentSequence` before replay can be bounded safely.
        if (frame.currentSequence === undefined) {
          throw new EventPumpGapError(this.currentSequence + 1, null);
        }
        requireNonNegativeInteger(frame.currentSequence, "currentSequence");
        this.highWaterSequence = Math.max(this.highWaterSequence, frame.currentSequence);
        await this.catchUpTo(this.highWaterSequence);
        return;
      }
      case "event": {
        this.assertEvent(frame.event);
        this.highWaterSequence = Math.max(this.highWaterSequence, frame.event.sequence);
        if (frame.event.sequence <= this.currentSequence) return;
        if (frame.event.sequence > this.currentSequence + 1) {
          await this.catchUpTo(frame.event.sequence - 1);
        }
        if (frame.event.sequence <= this.currentSequence) return;
        if (frame.event.sequence !== this.currentSequence + 1) {
          throw new EventPumpGapError(this.currentSequence + 1, frame.event.sequence);
        }
        await this.processEvent(frame.event, frame.historicalReplay === true);
      }
    }
  }

  private async catchUpTo(targetSequence: number): Promise<void> {
    while (this.currentSequence < targetSequence) {
      this.throwIfStopped();
      const page = await this.options.fetchEvents(
        this.currentSequence,
        this.pageSize,
        this.abortController.signal,
      );
      this.throwIfStopped();
      if (page.length === 0) {
        throw new EventPumpGapError(this.currentSequence + 1, null);
      }

      let advanced = false;
      for (const candidate of page) {
        this.throwIfStopped();
        this.assertEvent(candidate);
        if (candidate.sequence <= this.currentSequence) continue;
        if (candidate.sequence > targetSequence) break;
        if (candidate.sequence !== this.currentSequence + 1) {
          throw new EventPumpGapError(this.currentSequence + 1, candidate.sequence);
        }
        // REST catch-up is a closed historical set, even when it was requested after a live gap.
        // This lets adapters quarantine deterministic stale references without weakening live
        // event failures.
        await this.processEvent(candidate, true);
        advanced = true;
        if (this.currentSequence >= targetSequence) return;
      }
      if (!advanced) throw new EventPumpGapError(this.currentSequence + 1, null);
    }
  }

  private async processEvent(event: DomainEvent, historicalReplay: boolean): Promise<void> {
    this.throwIfStopped();
    const outcome = await this.options.handleEvent(
      event,
      this.abortController.signal,
      historicalReplay,
    );
    this.throwIfStopped();
    if (outcome.status !== "processed" && outcome.status !== "suppressed") {
      throw new TypeError("handleEvent must return an explicit processed or suppressed outcome");
    }
    await this.options.commitCursor(event.sequence, this.abortController.signal);
    this.throwIfStopped();
    this.currentSequence = event.sequence;
  }

  private assertEvent(event: DomainEvent): void {
    if (event.projectId !== this.options.projectId) {
      throw new TypeError(
        `Event ${event.id} belongs to project ${event.projectId}, not ${this.options.projectId}`,
      );
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
      throw new RangeError(`Event ${event.id} has an invalid sequence`);
    }
  }
}
