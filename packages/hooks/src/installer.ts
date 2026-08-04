import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HookClientKind } from "./runner.js";

type HookHandler = {
  type: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
  additionalContextLimit?: number;
  [key: string]: unknown;
};

type HookGroup = {
  matcher?: string;
  hooks: HookHandler[];
};

type HookSettings = {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
};

const EVENTS: Record<HookClientKind, string[]> = {
  codex: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"],
  claude: [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "PostToolBatch",
    "Stop",
    "SessionEnd",
    "FileChanged",
  ],
};

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function readSettings(path: string): HookSettings {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as HookSettings;
}

function isCrossAgentHandler(handler: HookHandler, client: HookClientKind): boolean {
  if (typeof handler.command !== "string") return false;
  if (!handler.command.includes(`--client ${client}`)) return false;
  return (
    /[\\/]packages[\\/]hooks[\\/]dist[\\/]hook\.js/i.test(handler.command) ||
    /\bcrossagent-hook(?:\.cmd|\.exe)?\b/i.test(handler.command)
  );
}

export function installHooks(options: {
  client: HookClientKind;
  projectDir: string;
  hookEntryPath: string;
  nodePath?: string;
  /** Static Agent credential used only to offer/enroll the Hook CONTROL ticket. */
  agentTokenPath?: string;
  /** Static capture credential used only to offer/enroll the Hook CAPTURE ticket. */
  captureTokenPath?: string;
  authorityTrustFilePath?: string;
  /** Owner-private store for the exact session-bound CONTROL/CAPTURE ticket bundle. */
  ticketStoreDir?: string;
  spoolDir?: string;
  baseUrl?: string;
}): { path: string; events: string[]; changed: boolean } {
  const configDir = resolve(options.projectDir, options.client === "codex" ? ".codex" : ".claude");
  const path = resolve(configDir, options.client === "codex" ? "hooks.json" : "settings.json");
  mkdirSync(configDir, { recursive: true });
  const settings = readSettings(path);
  const originalHooks = settings.hooks ?? {};
  const hooks = { ...originalHooks };
  const commandParts = [
    quote(options.nodePath ?? process.execPath),
    quote(options.hookEntryPath),
    "--client",
    options.client,
  ];
  if (options.agentTokenPath) {
    commandParts.push("--agent-token-file", quote(options.agentTokenPath));
  }
  if (options.captureTokenPath) {
    commandParts.push("--capture-token-file", quote(options.captureTokenPath));
  }
  if (options.authorityTrustFilePath) {
    commandParts.push("--authority-trust-file", quote(options.authorityTrustFilePath));
  }
  if (options.ticketStoreDir) {
    commandParts.push("--ticket-store-dir", quote(options.ticketStoreDir));
  }
  if (options.spoolDir) commandParts.push("--spool-dir", quote(options.spoolDir));
  if (options.baseUrl) commandParts.push("--base-url", quote(options.baseUrl));
  const command = commandParts.join(" ");
  for (const event of EVENTS[options.client]) {
    const groups = (hooks[event] ?? [])
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter(
          (handler) => handler.command !== command && !isCrossAgentHandler(handler, options.client),
        ),
      }))
      .filter((group) => group.hooks.length > 0);
    const handler: HookHandler = {
      type: "command",
      command,
      timeout: event === "SessionEnd" ? 3 : 15,
      statusMessage: `CrossAgent ${event}`,
    };
    if (
      options.client === "codex" &&
      ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolBatch"].includes(event)
    ) {
      handler.additionalContextLimit = 2000;
    }
    groups.push({
      ...(event === "PostToolUse" ? { matcher: "*" } : {}),
      hooks: [handler],
    });
    hooks[event] = groups;
  }
  const changed = JSON.stringify(originalHooks) !== JSON.stringify(hooks);
  if (changed) {
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ...settings,
          ...(options.client === "codex"
            ? { description: "CrossAgent Hub session-ticket lifecycle hooks." }
            : {}),
          hooks,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return { path, events: EVENTS[options.client], changed };
}
