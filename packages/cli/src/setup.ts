import { resolve } from "node:path";

/**
 * The whole first run as one command.
 *
 * Every step here already existed as its own subcommand; what did not exist was the order, and the
 * order is most of the difficulty. A new user had to know that the Hub must be running before an
 * Adapter can be installed, that the Adapter to install depends on what the probe found, and that
 * `doctor` is only meaningful after all of it. This runs that sequence and reports what each step
 * actually did.
 *
 * It keeps going past a step that fails when the rest is still worth doing — a missing Codex CLI
 * does not stop Claude being wired up — and stops when it cannot honestly continue, which is only
 * the Hub itself. Nothing is inferred: each step's detail is what the underlying call returned.
 */

export type SetupStepState = "OK" | "SKIPPED" | "FAILED";

export type SetupStep = {
  step: number;
  name: string;
  state: SetupStepState;
  detail: string;
};

export type SetupReport = {
  ok: boolean;
  root: string;
  projectId: string | null;
  dashboardUrl: string | null;
  steps: SetupStep[];
  /** What the user still has to do themselves, in order. Empty when there is nothing left. */
  nextSteps: string[];
};

type ProbeResult = { available?: boolean; version?: string | null; customChannel?: string };

export type SetupDependencies = {
  initializeProject: (root: string) => unknown;
  startHub: (options: { port?: number }) => Promise<{ port: number; reused: boolean }>;
  joinProject: (root: string) => Promise<{ project: { id: string }; root: string }>;
  probeCodex: (options: { cwd: string }) => Promise<unknown>;
  probeClaude: () => unknown;
  installClaudeChannel: (root: string, projectId: string) => unknown;
  installClaudeHooks: (root: string) => unknown;
  installCodexHooks: (root: string) => unknown;
  collectDiagnostics: () => Promise<Record<string, unknown>>;
  openDashboard: (baseUrl: string) => Promise<string>;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function probe(value: unknown): ProbeResult | null {
  return value && typeof value === "object" ? (value as ProbeResult) : null;
}

export async function runSetup(
  options: { path?: string; port?: number; open?: boolean },
  dependencies: SetupDependencies,
): Promise<SetupReport> {
  const root = resolve(options.path ?? ".");
  const steps: SetupStep[] = [];
  const nextSteps: string[] = [];
  let stepNumber = 0;
  const record = (name: string, state: SetupStepState, detail: string): SetupStep => {
    const entry = { step: (stepNumber += 1), name, state, detail };
    steps.push(entry);
    return entry;
  };
  const attempt = async (name: string, run: () => Promise<string> | string): Promise<boolean> => {
    try {
      record(name, "OK", await run());
      return true;
    } catch (error: unknown) {
      record(name, "FAILED", describe(error));
      return false;
    }
  };

  await attempt("Initialize project", () => {
    dependencies.initializeProject(root);
    return `prepared ${root}`;
  });

  // One mutable record rather than several locals: every value below is written inside a callback,
  // which is exactly the shape control-flow narrowing gets wrong.
  const found: {
    port: number | null;
    projectId: string | null;
    codex: ProbeResult | null;
    claude: ProbeResult | null;
    dashboardUrl: string | null;
  } = { port: null, projectId: null, codex: null, claude: null, dashboardUrl: null };

  await attempt("Start Hub", async () => {
    const started = await dependencies.startHub({ port: options.port });
    found.port = started.port;
    return started.reused
      ? `reused the Hub on port ${started.port}`
      : `started on port ${started.port}`;
  });
  if (found.port === null) {
    // Nothing after this can be answered honestly without a Hub, so the report stops here rather
    // than filling in six more failures that all say the same thing.
    return {
      ok: false,
      root,
      projectId: null,
      dashboardUrl: null,
      steps,
      nextSteps: ["Fix the Hub start failure above, then run crossagent setup . again"],
    };
  }
  const baseUrl = `http://127.0.0.1:${found.port}`;

  await attempt("Register project", async () => {
    const joined = await dependencies.joinProject(root);
    found.projectId = joined.project.id;
    return `registered ${joined.project.id}`;
  });

  await attempt("Detect Codex CLI", async () => {
    found.codex = probe(await dependencies.probeCodex({ cwd: root }));
    return found.codex?.available === false
      ? "no codex executable answered"
      : (found.codex?.version ?? "probed");
  });

  await attempt("Detect Claude CLI", () => {
    found.claude = probe(dependencies.probeClaude());
    return found.claude?.available === false
      ? "no claude executable answered"
      : `${found.claude?.version ?? "probed"} (custom Channel ${found.claude?.customChannel ?? "unknown"})`;
  });

  // The Adapter to install is chosen by what the probe found, not by a version comparison.
  if (found.claude === null || found.claude.available === false) {
    record("Install the Claude Adapter", "SKIPPED", "no claude executable to install it for");
  } else if (found.claude.customChannel === "supported") {
    await attempt("Install the Claude Adapter", () => {
      dependencies.installClaudeChannel(root, found.projectId ?? "");
      return "installed the custom Channel";
    });
  } else {
    await attempt("Install the Claude Adapter", () => {
      dependencies.installClaudeHooks(root);
      return "installed the Hook fallback";
    });
  }

  if (found.codex?.available === false) {
    record("Install the Codex hooks", "SKIPPED", "no codex executable to install them for");
  } else {
    await attempt("Install the Codex hooks", () => {
      dependencies.installCodexHooks(root);
      return "installed the lifecycle hooks";
    });
  }

  await attempt("Run diagnostics", async () => {
    const diagnostics = await dependencies.collectDiagnostics();
    const hub = diagnostics.hub as { health?: unknown } | undefined;
    return hub?.health ? "Hub answered its health check" : "Hub did not answer its health check";
  });

  if (options.open === false) {
    record("Open the Dashboard", "SKIPPED", baseUrl);
  } else {
    await attempt("Open the Dashboard", async () => {
      found.dashboardUrl = await dependencies.openDashboard(baseUrl);
      return baseUrl;
    });
  }

  // What is left is what nobody can do on the user's behalf: a Bridge needs its own terminal, and
  // a test message needs two agents connected.
  if (found.codex?.available !== false) nextSteps.push("crossagent codex --detach");
  nextSteps.push("Send one message from the Dashboard to confirm the round trip");

  return {
    ok: steps.every((entry) => entry.state !== "FAILED"),
    root,
    projectId: found.projectId,
    dashboardUrl: found.dashboardUrl,
    steps,
    nextSteps,
  };
}
