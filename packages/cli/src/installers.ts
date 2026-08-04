import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { installHooks } from "@crossagent/hooks";
import {
  agentTokenPaths,
  authorityTrustManifestPath,
  captureTokenPaths,
  dataDir,
  defaultBaseUrl,
  readAuthorityTrustManifest,
  workspaceFile,
} from "./paths.js";

export function installLifecycleHooks(client: "codex" | "claude", projectDir: string) {
  const hookEntryPath = workspaceFile("packages", "hooks", "dist", "hook.js");
  if (!existsSync(hookEntryPath)) {
    throw new Error(`Hook build not found at ${hookEntryPath}. Run pnpm build first.`);
  }
  const agentCredentialPath = agentTokenPaths[client];
  if (!existsSync(agentCredentialPath)) {
    throw new Error(
      `${client === "codex" ? "Codex" : "Claude"} Agent credential not found at ${agentCredentialPath}. Run crossagent start first.`,
    );
  }
  const captureCredentialPath = captureTokenPaths[client];
  if (!existsSync(captureCredentialPath)) {
    throw new Error(
      `Bridge capture credential not found at ${captureCredentialPath}. Run crossagent start first.`,
    );
  }
  readAuthorityTrustManifest({ path: authorityTrustManifestPath });
  return {
    ...installHooks({
      client,
      projectDir,
      hookEntryPath,
      nodePath: process.execPath,
      agentTokenPath: agentCredentialPath,
      captureTokenPath: captureCredentialPath,
      authorityTrustFilePath: authorityTrustManifestPath,
      spoolDir: resolve(dataDir, "spool", "user-turns"),
      baseUrl: defaultBaseUrl,
    }),
    agentCredentialPath,
    captureCredentialPath,
  };
}

export function installClaudeChannel(
  projectDir: string,
  projectId?: string,
): {
  path: string;
  serverName: string;
  changed: boolean;
  launchCommand: string;
} {
  const path = resolve(projectDir, ".mcp.json");
  const channelEntry = workspaceFile("packages", "claude-channel", "dist", "bin.js");
  if (!existsSync(channelEntry)) {
    throw new Error(`Claude Channel build not found at ${channelEntry}. Run pnpm build first.`);
  }
  const agentCredentialPath = agentTokenPaths.claude;
  if (!existsSync(agentCredentialPath)) {
    throw new Error(
      `Claude Agent credential not found at ${agentCredentialPath}. Run crossagent start first.`,
    );
  }
  readAuthorityTrustManifest({ path: authorityTrustManifestPath });
  const settings = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  const servers = {
    ...((settings.mcpServers as Record<string, unknown> | undefined) ?? {}),
  };
  const serverName = "crossagent-channel";
  const next = {
    type: "stdio",
    command: process.execPath,
    args: projectId
      ? [channelEntry, "--project-id", projectId]
      : [channelEntry, "--project", resolve(projectDir)],
    env: {
      CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE: agentCredentialPath,
      CROSSAGENT_AUTHORITY_TRUST_FILE: authorityTrustManifestPath,
      CROSSAGENT_URL:
        process.env.CROSSAGENT_URL ??
        `http://127.0.0.1:${Number(process.env.CROSSAGENT_PORT ?? 4387)}`,
    },
  };
  const changed = JSON.stringify(servers[serverName]) !== JSON.stringify(next);
  if (changed) {
    servers[serverName] = next;
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ ...settings, mcpServers: servers }, null, 2)}\n`,
      "utf8",
    );
  }
  return {
    path,
    serverName,
    changed,
    launchCommand: "claude --dangerously-load-development-channels server:crossagent-channel",
  };
}
