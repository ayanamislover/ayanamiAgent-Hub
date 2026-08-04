import { describe, expect, it } from "vitest";
import { sanitizeModelEnvironment } from "../src/model-environment.js";

describe("sanitizeModelEnvironment", () => {
  it("default-denies every CrossAgent parent variable and installs only MODEL_MCP", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "fixture-path",
      CROSSAGENT_TOKEN: "stale-agent-token",
      CROSSAGENT_TOKEN_FILE: "agent-token-file",
      CROSSAGENT_AGENT_TOKEN: "generic-agent-secret",
      CROSSAGENT_AGENT_TOKEN_FILE: "generic-agent-file",
      CROSSAGENT_CODEX_AGENT_TOKEN: "codex-agent-secret",
      CROSSAGENT_CODEX_AGENT_TOKEN_FILE: "codex-agent-file",
      CROSSAGENT_CLAUDE_AGENT_TOKEN: "claude-agent-secret",
      CROSSAGENT_CLAUDE_AGENT_TOKEN_FILE: "claude-agent-file",
      CROSSAGENT_DASHBOARD_TOKEN: "dashboard-secret",
      CROSSAGENT_DASHBOARD_TOKEN_FILE: "dashboard-file",
      CROSSAGENT_CAPTURE_TOKEN: "capture-secret",
      CROSSAGENT_CAPTURE_TOKEN_FILE: "capture-file",
      CROSSAGENT_CODEX_CAPTURE_TOKEN: "codex-capture-secret",
      CROSSAGENT_CODEX_CAPTURE_TOKEN_FILE: "codex-capture-file",
      CROSSAGENT_CLAUDE_CAPTURE_TOKEN: "claude-capture-secret",
      CROSSAGENT_CLAUDE_CAPTURE_TOKEN_FILE: "claude-capture-file",
      CROSSAGENT_INJECTOR_TOKEN: "inject-secret",
      CROSSAGENT_INJECTOR_TOKEN_FILE: "inject-file",
      CROSSAGENT_CODEX_INJECTOR_TOKEN: "codex-inject-secret",
      CROSSAGENT_CODEX_INJECTOR_TOKEN_FILE: "codex-inject-file",
      CROSSAGENT_CLAUDE_INJECTOR_TOKEN: "claude-inject-secret",
      CROSSAGENT_CLAUDE_INJECTOR_TOKEN_FILE: "claude-inject-file",
      CROSSAGENT_AUTHORITY_TRUST_FILE: "authority-trust-file",
      CROSSAGENT_AUTHORITY_TRUST_MANIFEST: "authority-trust-json",
      CROSSAGENT_CLAUDE_BOOTSTRAP_TOKEN: "claude-bootstrap-secret",
      CROSSAGENT_CLAUDE_BOOTSTRAP_TOKEN_FILE: "claude-bootstrap-file",
      CROSSAGENT_SESSION_TICKET_VAULT: "vault-secret",
      CROSSAGENT_FUTURE_CREDENTIAL: "future-secret",
      CROSSAGENT_URL: "http://parent-only.test",
      CrossAgent_Codex_Injector_Token: "mixed-case-secret",
      crossagent_claude_agent_token_file: "mixed-case-agent-file",
      cRoSsAgEnT_cLaUdE_bOoTsTrAp_ToKeN: "mixed-case-bootstrap-secret",
      crossagent_authority_trust_file: "mixed-case-trust-file",
    };

    const result = sanitizeModelEnvironment(source, "ordinary-agent-token");

    expect(result).toEqual({ PATH: "fixture-path", CROSSAGENT_TOKEN: "ordinary-agent-token" });
    expect(source.CROSSAGENT_DASHBOARD_TOKEN).toBe("dashboard-secret");
  });
});
