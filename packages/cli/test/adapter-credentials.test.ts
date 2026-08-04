import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  agentTokenPaths,
  authorityTrustManifestPath,
  readAgentToken,
  readAuthorityTrustManifest,
} from "../src/paths.js";

const VALID_KEY_ID = `ed25519:${"a".repeat(43)}`;
const VALID_FINGERPRINT = "b".repeat(64);

describe("adapter credential resolution", () => {
  it("resolves independent per-client credential files", () => {
    expect(basename(agentTokenPaths.codex)).toBe("agent-codex-token");
    expect(basename(agentTokenPaths.claude)).toBe("agent-claude-token");
    expect(agentTokenPaths.codex).not.toBe(agentTokenPaths.claude);
  });

  it("uses one explicit local Authority trust manifest path", () => {
    expect(basename(authorityTrustManifestPath)).toBe("trusted-signing-keys.json");
    expect(basename(dirname(authorityTrustManifestPath))).toBe("authority");
  });

  it("reads only the selected Agent credential without a shared or cross-role fallback", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-adapter-read-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, "token"), "shared-token\n", "utf8");
    writeFileSync(resolve(root, "agent-claude-token"), "claude-token\n", "utf8");
    const options = {
      dataDir: root,
      environment: {
        CROSSAGENT_TOKEN: "shared-environment-token",
        CROSSAGENT_CLAUDE_AGENT_TOKEN: "claude-environment-token",
      },
    };

    expect(readAgentToken("claude", options)).toBe("claude-environment-token");
    expect(() => readAgentToken("codex", options)).toThrow(/agent-codex-token/);
  });

  it("honours only the selected client's role-specific path override", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-adapter-path-"));
    const codexPath = resolve(root, "codex", "credential");
    const claudePath = resolve(root, "claude", "credential");
    mkdirSync(resolve(root, "codex"), { recursive: true });
    mkdirSync(resolve(root, "claude"), { recursive: true });
    writeFileSync(codexPath, "codex-file-token\n", "utf8");
    writeFileSync(claudePath, "claude-file-token\n", "utf8");
    const options = {
      dataDir: root,
      environment: {
        CROSSAGENT_CODEX_AGENT_TOKEN_FILE: codexPath,
        CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE: claudePath,
      },
    };

    expect(readAgentToken("codex", options)).toBe("codex-file-token");
    expect(readAgentToken("claude", options)).toBe("claude-file-token");
  });

  it("strictly parses and freezes the locally pinned Authority trust manifest", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-authority-trust-"));
    const path = resolve(root, "authority", "trusted-signing-keys.json");
    mkdirSync(resolve(root, "authority"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        keys: [{ keyId: VALID_KEY_ID, fingerprintSha256: VALID_FINGERPRINT }],
      }),
      "utf8",
    );

    const manifest = readAuthorityTrustManifest({ dataDir: root, environment: {} });

    expect(manifest).toEqual({
      schemaVersion: 1,
      keys: [{ keyId: VALID_KEY_ID, fingerprintSha256: VALID_FINGERPRINT }],
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.keys)).toBe(true);
    expect(Object.isFrozen(manifest.keys[0])).toBe(true);
  });

  it("fails loudly for missing, empty, malformed, empty-key, or extended trust manifests", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-authority-trust-invalid-"));
    const path = resolve(root, "authority", "trusted-signing-keys.json");
    mkdirSync(resolve(root, "authority"), { recursive: true });
    const read = () => readAuthorityTrustManifest({ dataDir: root, environment: {} });

    expect(read).toThrow(/trust manifest not found/i);
    writeFileSync(path, "", "utf8");
    expect(read).toThrow(/invalid Authority trust manifest/i);
    writeFileSync(path, "{", "utf8");
    expect(read).toThrow(/invalid Authority trust manifest/i);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, keys: [] }), "utf8");
    expect(read).toThrow(/invalid Authority trust manifest/i);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        keys: [{ keyId: VALID_KEY_ID, fingerprintSha256: VALID_FINGERPRINT }],
        attackerSuppliedLiveKey: true,
      }),
      "utf8",
    );
    expect(read).toThrow(/invalid Authority trust manifest/i);
  });

  it("installs Claude Channel with only the dedicated Agent token file and trust-file pin", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-authority-install-"));
    const projectDir = resolve(root, "project");
    const testDataDir = resolve(root, "data");
    const trustDir = resolve(testDataDir, "authority");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(resolve(testDataDir, "agent-claude-token"), "claude-token\n", "utf8");
    writeFileSync(
      resolve(trustDir, "trusted-signing-keys.json"),
      JSON.stringify({
        schemaVersion: 1,
        keys: [{ keyId: VALID_KEY_ID, fingerprintSha256: VALID_FINGERPRINT }],
      }),
      "utf8",
    );
    vi.resetModules();
    vi.stubEnv("CROSSAGENT_DATA_DIR", testDataDir);
    try {
      const { installClaudeChannel } = await import("../src/installers.js");
      const result = installClaudeChannel(projectDir, "prj_fixture");
      const settings = JSON.parse(readFileSync(result.path, "utf8")) as {
        mcpServers: Record<string, { env: Record<string, string> }>;
      };
      const environment = settings.mcpServers[result.serverName]!.env;

      expect(environment).toEqual(
        expect.objectContaining({
          CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE: resolve(testDataDir, "agent-claude-token"),
          CROSSAGENT_AUTHORITY_TRUST_FILE: resolve(trustDir, "trusted-signing-keys.json"),
        }),
      );
      expect(environment).not.toHaveProperty("CROSSAGENT_TOKEN_FILE");
      expect(environment).not.toHaveProperty("CROSSAGENT_TOKEN");
      expect(environment).not.toHaveProperty("CROSSAGENT_CLAUDE_AGENT_TOKEN");
      expect(environment).not.toHaveProperty("CROSSAGENT_AUTHORITY_TRUST_MANIFEST");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
