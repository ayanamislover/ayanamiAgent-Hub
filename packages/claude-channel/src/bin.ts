#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HubClient } from "@crossagent/client";
import {
  TrustedAuthorityKeyManifestSchema,
  type TrustedAuthorityKeyManifest,
} from "@crossagent/protocol";
import { attachToHub } from "./attach.js";
import { createChannelLogger } from "./channel-log.js";
import { ClaudeChannel } from "./channel.js";
import { loadOrCreateClaudeChannelIdentity } from "./installation-identity.js";
import { FileClaudeSessionTicketVault } from "./session-ticket-runtime.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectId = arg("--project-id") ?? process.env.CROSSAGENT_PROJECT_ID;
const requestedProject = arg("--project") ?? process.env.CROSSAGENT_PROJECT ?? process.cwd();
const baseUrl = arg("--hub") ?? process.env.CROSSAGENT_URL;
const agentId = arg("--agent") ?? process.env.CROSSAGENT_AGENT_ID ?? "claude";

function readClaudeBootstrapToken(): string | undefined {
  const inline =
    process.env.CROSSAGENT_CLAUDE_BOOTSTRAP_TOKEN ?? process.env.CROSSAGENT_CLAUDE_AGENT_TOKEN;
  const file =
    process.env.CROSSAGENT_CLAUDE_BOOTSTRAP_TOKEN_FILE ??
    process.env.CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE;
  const token = inline ?? (file ? readFileSync(file, "utf8").trim() : undefined);
  delete process.env.CROSSAGENT_CLAUDE_BOOTSTRAP_TOKEN;
  delete process.env.CROSSAGENT_CLAUDE_AGENT_TOKEN;
  delete process.env.CROSSAGENT_CLAUDE_BOOTSTRAP_TOKEN_FILE;
  delete process.env.CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE;
  return token;
}

function readClaudeAuthorityTrustManifest(): TrustedAuthorityKeyManifest {
  const path = process.env.CROSSAGENT_AUTHORITY_TRUST_FILE;
  if (!path) {
    throw new Error(
      "CrossAgent Claude Channel requires CROSSAGENT_AUTHORITY_TRUST_FILE; live keys cannot bootstrap their own trust.",
    );
  }
  let parsed: TrustedAuthorityKeyManifest;
  try {
    parsed = TrustedAuthorityKeyManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
  } catch {
    throw new Error(`Invalid Authority trust manifest at ${path}. Refusing Claude coordination.`);
  }
  const frozen = {
    schemaVersion: parsed.schemaVersion,
    keys: parsed.keys.map((key) => Object.freeze({ ...key })),
  };
  Object.freeze(frozen.keys);
  return Object.freeze(frozen) as TrustedAuthorityKeyManifest;
}

if (agentId !== "claude") {
  process.stderr.write("CrossAgent Claude Channel requires --agent claude.\n");
  process.exitCode = 2;
} else if (arg("--token")) {
  process.stderr.write(
    "CrossAgent Claude Channel rejects --token; use its dedicated Claude Agent credential file.\n",
  );
  process.exitCode = 2;
} else {
  const bootstrapToken = readClaudeBootstrapToken();
  if (!bootstrapToken) {
    process.stderr.write(
      "CrossAgent Claude Channel requires its dedicated bootstrap credential file.\n",
    );
    process.exitCode = 2;
  } else {
    let authorityTrustManifest: TrustedAuthorityKeyManifest | undefined;
    try {
      authorityTrustManifest = readClaudeAuthorityTrustManifest();
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
    if (!authorityTrustManifest) {
      // Keep the MCP transport unstarted: without local pins no message may cross the model seam.
      process.exitCode = 2;
    } else {
      const stateRoot = resolve(
        process.env.CROSSAGENT_CLAUDE_CHANNEL_STATE_DIR ??
          join(homedir(), ".crossagent", "claude-channel"),
      );
      const identityPath = resolve(
        process.env.CROSSAGENT_CLAUDE_CHANNEL_IDENTITY_FILE ?? join(stateRoot, "installation.json"),
      );
      const identity = await loadOrCreateClaudeChannelIdentity(identityPath);
      const log = createChannelLogger(
        resolve(process.env.CROSSAGENT_CLAUDE_CHANNEL_LOG_FILE ?? join(stateRoot, "channel.log")),
      );
      const namespace = createHash("sha256")
        .update(`${baseUrl ?? "http://127.0.0.1:4387"}\0${projectId ?? resolve(requestedProject)}`)
        .digest("hex")
        .slice(0, 32);
      const ticketVault = new FileClaudeSessionTicketVault(
        resolve(
          process.env.CROSSAGENT_CLAUDE_CHANNEL_TICKET_VAULT ??
            join(stateRoot, "tickets", `${namespace}.json`),
        ),
      );
      const channel = new ClaudeChannel({
        // Provisional. When --project-id is given the Hub owns the real root, and attachToHub supplies
        // it once the Hub answers.
        cwd: resolve(requestedProject),
        bootstrapToken,
        installationId: identity.installationId,
        ticketVault,
        authorityTrustManifest,
        baseUrl,
        agentId,
        allowCreateProject: false,
        log,
      });
      log(
        `[crossagent] Claude Channel starting (pid ${process.pid}, project ${projectId ?? "by cwd"}).`,
      );
      // Serve the tools before reaching for the Hub. The client asks for them the moment it spawns this
      // process, and the Hub is a separate one that may still be starting.
      await channel.connect(new StdioServerTransport());
      void attachToHub(channel, {
        resolveCwd: async () =>
          projectId
            ? (
                await new HubClient({ baseUrl, token: bootstrapToken }).getProjectRegistration(
                  projectId,
                )
              ).root
            : resolve(requestedProject),
        onRetry: (error, attempt, waitMs) => {
          const line = `[crossagent] Hub not reachable (attempt ${attempt}), retrying in ${waitMs}ms: ${
            error instanceof Error ? error.message : String(error)
          }`;
          process.stderr.write(`${line}\n`);
          log(line);
        },
      }).catch((error: unknown) => {
        // Terminal for the life of this process: nothing re-enters attachToHub. Say so plainly, since
        // the tools stay served and will answer as if merely unregistered.
        const line = `[crossagent] gave up attaching to the Hub, this process will not retry: ${
          error instanceof Error ? error.message : String(error)
        }`;
        process.stderr.write(`${line}\n`);
        log(line);
      });
      const shutdown = async () => {
        await channel.stop();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    }
  }
}
