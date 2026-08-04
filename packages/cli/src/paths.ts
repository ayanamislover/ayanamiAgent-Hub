import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TrustedAuthorityKeyManifestSchema,
  type TrustedAuthorityKeyManifest,
} from "@crossagent/protocol";

export const dataDir = resolve(
  process.env.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent"),
);
export const tokenPath = resolve(process.env.CROSSAGENT_TOKEN_FILE ?? resolve(dataDir, "token"));
export const dashboardTokenPath = resolve(
  process.env.CROSSAGENT_DASHBOARD_TOKEN_FILE ?? resolve(dataDir, "dashboard-token"),
);
export const agentTokenPaths = {
  codex: resolve(
    process.env.CROSSAGENT_CODEX_AGENT_TOKEN_FILE ?? resolve(dataDir, "agent-codex-token"),
  ),
  claude: resolve(
    process.env.CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE ?? resolve(dataDir, "agent-claude-token"),
  ),
} as const;
export const captureTokenPaths = {
  codex: resolve(
    process.env.CROSSAGENT_CODEX_CAPTURE_TOKEN_FILE ?? resolve(dataDir, "capture-codex-token"),
  ),
  claude: resolve(
    process.env.CROSSAGENT_CLAUDE_CAPTURE_TOKEN_FILE ?? resolve(dataDir, "capture-claude-token"),
  ),
} as const;
export const injectorTokenPaths = {
  codex: resolve(
    process.env.CROSSAGENT_CODEX_INJECTOR_TOKEN_FILE ?? resolve(dataDir, "inject-codex-token"),
  ),
  claude: resolve(
    process.env.CROSSAGENT_CLAUDE_INJECTOR_TOKEN_FILE ?? resolve(dataDir, "inject-claude-token"),
  ),
} as const;
export const authorityTrustManifestPath = resolve(
  process.env.CROSSAGENT_AUTHORITY_TRUST_FILE ??
    resolve(dataDir, "authority", "trusted-signing-keys.json"),
);
export const pidPath = resolve(dataDir, "hub.pid.json");
export const logPath = resolve(dataDir, "hub.log");
export const defaultBaseUrl =
  process.env.CROSSAGENT_URL ?? `http://127.0.0.1:${Number(process.env.CROSSAGENT_PORT ?? 4387)}`;

const moduleDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(moduleDir, "../../..");

export function workspaceFile(...parts: string[]): string {
  return resolve(workspaceRoot, ...parts);
}

export function readToken(): string {
  if (process.env.CROSSAGENT_TOKEN) return process.env.CROSSAGENT_TOKEN;
  if (!existsSync(tokenPath)) {
    throw new Error(`Hub token not found at ${tokenPath}. Run crossagent start first.`);
  }
  return readFileSync(tokenPath, "utf8").trim();
}

export function readDashboardToken(): string {
  if (process.env.CROSSAGENT_DASHBOARD_TOKEN) return process.env.CROSSAGENT_DASHBOARD_TOKEN;
  if (!existsSync(dashboardTokenPath)) {
    throw new Error(
      `Dashboard credential not found at ${dashboardTokenPath}. Run crossagent start first.`,
    );
  }
  return readFileSync(dashboardTokenPath, "utf8").trim();
}

export function readAgentToken(
  client: keyof typeof agentTokenPaths,
  options: { dataDir?: string; environment?: NodeJS.ProcessEnv } = {},
): string {
  const environment = options.environment ?? process.env;
  const environmentPrefix = `CROSSAGENT_${client.toUpperCase()}_AGENT_TOKEN`;
  const fromEnvironment = environment[environmentPrefix];
  if (fromEnvironment) return fromEnvironment;
  const fallbackDataDir = options.dataDir ?? dataDir;
  const path = resolve(
    environment[`${environmentPrefix}_FILE`] ??
      (options.dataDir
        ? resolve(fallbackDataDir, `agent-${client}-token`)
        : agentTokenPaths[client]),
  );
  if (!existsSync(path)) {
    throw new Error(
      `${client === "codex" ? "Codex" : "Claude"} Agent credential not found at ${path}. Run crossagent start first.`,
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`Agent credential is empty at ${path}. Run crossagent start first.`);
  return token;
}

export function readInjectorToken(
  client: keyof typeof injectorTokenPaths,
  options: { dataDir?: string; environment?: NodeJS.ProcessEnv } = {},
): string {
  const environment = options.environment ?? process.env;
  const environmentName = `CROSSAGENT_${client.toUpperCase()}_INJECTOR_TOKEN`;
  const fromEnvironment = environment[environmentName];
  if (fromEnvironment) return fromEnvironment;
  const fallbackDataDir = options.dataDir ?? dataDir;
  const path = resolve(
    environment[`${environmentName}_FILE`] ??
      (options.dataDir
        ? resolve(fallbackDataDir, `inject-${client}-token`)
        : injectorTokenPaths[client]),
  );
  if (!existsSync(path)) {
    throw new Error(`Bridge injector credential not found at ${path}. Run crossagent start first.`);
  }
  return readFileSync(path, "utf8").trim();
}

/**
 * Read the local, installer-pinned Authority trust root. This deliberately has no Hub or shared
 * credential fallback: live signing keys may refresh status for an existing pin, but cannot enroll
 * themselves as trusted during the delivery they are meant to authenticate.
 */
export function readAuthorityTrustManifest(
  options: {
    path?: string;
    dataDir?: string;
    environment?: NodeJS.ProcessEnv;
  } = {},
): TrustedAuthorityKeyManifest {
  const environment = options.environment ?? process.env;
  const path = resolve(
    options.path ??
      environment.CROSSAGENT_AUTHORITY_TRUST_FILE ??
      (options.dataDir
        ? resolve(options.dataDir, "authority", "trusted-signing-keys.json")
        : authorityTrustManifestPath),
  );
  if (!existsSync(path)) {
    throw new Error(`Authority trust manifest not found at ${path}. Run crossagent start first.`);
  }
  try {
    const parsed = TrustedAuthorityKeyManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    const frozen = {
      schemaVersion: parsed.schemaVersion,
      keys: parsed.keys.map((key) => Object.freeze({ ...key })),
    };
    Object.freeze(frozen.keys);
    return Object.freeze(frozen) as TrustedAuthorityKeyManifest;
  } catch {
    throw new Error(`Invalid Authority trust manifest at ${path}. Refusing Adapter coordination.`);
  }
}
