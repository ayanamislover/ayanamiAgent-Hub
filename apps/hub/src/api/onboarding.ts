import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The two things the first-run wizard cannot see from the Hub's own tables: whether the local CLIs
 * were ever probed, and whether an Adapter is installed in the project directory. Everything else
 * on that screen — is a project registered, is a session live, has a message been delivered — is
 * already in the overview the Dashboard fetches anyway.
 *
 * This reads two fixed filenames under the data directory and three under a project root the Hub
 * itself registered. No request value reaches a path, and nothing here is a credential: a
 * compatibility report holds a version string, method names and a date.
 */

export type OnboardingAdapters = {
  claudeChannel: boolean;
  claudeHooks: boolean;
  codexHooks: boolean;
};

export type OnboardingState = {
  schemaVersion: 1;
  /** Whatever `crossagent compatibility probe` last wrote, or null if it was never run. */
  compatibility: { codex: unknown | null; claude: unknown | null };
  adapters: OnboardingAdapters;
  generatedAt: string;
};

function readReport(dataDir: string, client: "codex" | "claude"): unknown | null {
  try {
    return JSON.parse(
      readFileSync(resolve(dataDir, "compatibility", `${client}.json`), "utf8"),
    ) as unknown;
  } catch {
    // Never probed, unreadable, or half-written. All three mean the same thing to the wizard.
    return null;
  }
}

export function readOnboardingState(options: {
  dataDir: string;
  projectRoot: string | null;
  now?: () => Date;
}): OnboardingState {
  const root = options.projectRoot;
  return {
    schemaVersion: 1,
    compatibility: {
      codex: readReport(options.dataDir, "codex"),
      claude: readReport(options.dataDir, "claude"),
    },
    adapters: {
      claudeChannel: root ? channelInstalled(resolve(root, ".mcp.json")) : false,
      claudeHooks: root ? existsSync(resolve(root, ".claude", "settings.json")) : false,
      codexHooks: root ? existsSync(resolve(root, ".codex", "hooks.json")) : false,
    },
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

/** A `.mcp.json` that exists but names some other server is not this Adapter being installed. */
function channelInstalled(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    return Boolean(parsed.mcpServers?.["crossagent-channel"]);
  } catch {
    return false;
  }
}
