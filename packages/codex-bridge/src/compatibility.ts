import type { CodexAppServer } from "./app-server.js";

/**
 * The Bridge depends on measured app-server behaviour, not on a documented contract, and a Codex
 * release can take a surface away without this repository changing a line. Until now the method
 * list handed to the Hub -- and shown on the Agents page -- was written down rather than measured,
 * so a surface that had gone away still read as present.
 *
 * This asks the running app-server directly, and it deliberately asks in the cheapest order: the
 * thread lifecycle and the readback surfaces cost nothing, while anything that would start a turn
 * spends a model call and stays off unless it is explicitly asked for.
 */

/**
 * `inconclusive` is not hedging. JSON-RPC only says "this method does not exist" with -32601;
 * every other error means the call was routed and refused for a state reason, and calling that
 * "unsupported" would be the same kind of assertion this replaces. The first real run found one:
 * `thread/resume` on a thread that has not run a turn yet answers "no rollout found", which says
 * something about rollout timing and nothing about whether resume exists.
 */
export type MethodSupport = "supported" | "unsupported" | "inconclusive";

const METHOD_NOT_FOUND = -32601;

export type CodexCompatibilityReport = {
  client: "codex";
  version: string | null;
  threadStart: MethodSupport;
  threadResume: MethodSupport;
  itemsList: MethodSupport;
  threadRead: MethodSupport;
  injectAccepted: boolean;
  /** null when no readback surface exists at all, so acceptance can be neither confirmed nor denied. */
  injectReadable: boolean | null;
  /** null unless a model turn was explicitly allowed, because confirming a steer needs one. */
  steerReadable: boolean | null;
  methods: string[];
  recommendedDeliveryMode: "inject" | "wake" | "mailbox";
  testedAt: string;
  notes: Record<string, string>;
};

export type ProbeOptions = {
  cwd: string;
  version?: string | null;
  /** Starting a turn calls the model and costs the user tokens, so it is opt-in. */
  allowModelTurn?: boolean;
  timeoutMs?: number;
  now?: () => Date;
};

type Attempt<T> = { ok: true; value: T } | { ok: false; message: string; code: number | null };

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      code: typeof code === "number" ? code : null,
    };
  }
}

function threadIdOf(value: unknown): string | null {
  const thread = (value as { thread?: { id?: unknown } } | undefined)?.thread;
  return typeof thread?.id === "string" ? thread.id : null;
}

/** Any JSON serialisation of the response is enough to answer "did the marker come back". */
function contains(value: unknown, marker: string): boolean {
  try {
    return JSON.stringify(value ?? null).includes(marker);
  } catch {
    return false;
  }
}

export async function probeCodexCompatibility(
  server: CodexAppServer,
  options: ProbeOptions,
): Promise<CodexCompatibilityReport> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 20_000;
  const marker = `crossagent-probe-${now().getTime().toString(36)}`;
  const notes: Record<string, string> = {};
  const request = <T>(method: string, params: Record<string, unknown>) =>
    attempt<T>(() => server.request<T>(method, params, timeoutMs));

  const started = await request<unknown>("thread/start", { cwd: options.cwd });
  if (!started.ok) notes["thread/start"] = started.message;
  const threadId = started.ok ? threadIdOf(started.value) : null;

  const resumed = threadId
    ? await request<unknown>("thread/resume", { threadId })
    : ({ ok: false, message: "no thread to resume", code: null } as const);
  if (!resumed.ok) notes["thread/resume"] = resumed.message;

  const listed = threadId
    ? await request<unknown>("thread/items/list", { threadId })
    : ({ ok: false, message: "no thread to list", code: null } as const);
  if (!listed.ok) notes["thread/items/list"] = listed.message;

  const injected = threadId
    ? await request<unknown>("thread/inject_items", {
        threadId,
        items: [{ type: "text", text: marker }],
      })
    : ({ ok: false, message: "no thread to inject into", code: null } as const);
  if (!injected.ok) notes["thread/inject_items"] = injected.message;

  // Readback is attempted through both surfaces, because a build can carry one and not the other.
  const readBackList =
    threadId && injected.ok
      ? await request<unknown>("thread/items/list", { threadId })
      : ({ ok: false, message: "not attempted", code: null } as const);
  const readBackRead = threadId
    ? await request<unknown>("thread/read", { threadId })
    : ({ ok: false, message: "no thread to read", code: null } as const);
  if (!readBackRead.ok) notes["thread/read"] = readBackRead.message;

  const anyReadback = readBackList.ok || readBackRead.ok;
  const injectReadable = !injected.ok
    ? false
    : anyReadback
      ? (readBackList.ok && contains(readBackList.value, marker)) ||
        (readBackRead.ok && contains(readBackRead.value, marker))
      : null;
  if (injectReadable === null) {
    notes.injectReadable =
      "the app-server accepted the item but exposes no surface to read it back, so delivery cannot be confirmed";
  }

  let steerReadable: boolean | null = null;
  if (!options.allowModelTurn) {
    notes.steerReadable =
      "not probed: confirming a steer requires starting a turn, which calls the model";
  } else if (threadId) {
    const turn = await request<{ turn?: { id?: unknown } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: marker }],
    });
    const turnId = turn.ok && typeof turn.value?.turn?.id === "string" ? turn.value.turn.id : null;
    if (!turn.ok) notes["turn/start"] = turn.message;
    if (turnId) {
      const steered = await request<unknown>("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: `${marker}-steer` }],
      });
      if (!steered.ok) notes["turn/steer"] = steered.message;
      const afterSteer = await request<unknown>("thread/read", { threadId });
      steerReadable = steered.ok && afterSteer.ok && contains(afterSteer.value, `${marker}-steer`);
    } else {
      steerReadable = false;
    }
  }

  const support = (result: Attempt<unknown>): MethodSupport =>
    result.ok ? "supported" : result.code === METHOD_NOT_FOUND ? "unsupported" : "inconclusive";
  const methods = [
    ...(started.ok ? ["thread/start"] : []),
    ...(resumed.ok ? ["thread/resume"] : []),
    ...(listed.ok ? ["thread/items/list"] : []),
    ...(injected.ok ? ["thread/inject_items"] : []),
    ...(readBackRead.ok ? ["thread/read"] : []),
  ];

  // Injection only counts as a delivery surface when the item can be read back; otherwise waking
  // the peer with a turn is the only thing that demonstrably reaches it.
  const recommendedDeliveryMode: CodexCompatibilityReport["recommendedDeliveryMode"] =
    injectReadable === true ? "inject" : started.ok ? "wake" : "mailbox";

  return {
    client: "codex",
    version: options.version ?? null,
    threadStart: support(started),
    threadResume: support(resumed),
    itemsList: support(listed),
    threadRead: support(readBackRead),
    injectAccepted: injected.ok,
    injectReadable,
    steerReadable,
    methods,
    recommendedDeliveryMode,
    testedAt: now().toISOString(),
    notes,
  };
}
