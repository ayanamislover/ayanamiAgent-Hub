import { describe, expect, it } from "vitest";
import {
  deriveOnboardingSteps,
  onboardingComplete,
  type OnboardingInput,
  type OnboardingStepId,
} from "./onboarding.js";

function input(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    projectCount: 1,
    sessions: [],
    messageCount: 0,
    environment: null,
    ...overrides,
  };
}

function step(steps: ReturnType<typeof deriveOnboardingSteps>, id: OnboardingStepId) {
  return steps.find((entry) => entry.id === id)!;
}

describe("first-run onboarding steps", () => {
  it("asks for a probe rather than guessing when nothing has been measured", () => {
    const steps = deriveOnboardingSteps(input());

    expect(step(steps, "codex-cli")).toMatchObject({
      state: "NOT_STARTED",
      command: "crossagent compatibility probe codex",
    });
    expect(step(steps, "claude-cli")).toMatchObject({
      state: "NOT_STARTED",
      command: "crossagent compatibility probe claude",
    });
    // Which Claude Adapter to install is not knowable before the probe, so it waits for it.
    expect(step(steps, "claude-adapter").state).toBe("WAITING");
    expect(onboardingComplete(steps)).toBe(false);
  });

  it("separates a CLI that is missing from one that merely lacks the custom Channel", () => {
    const missing = deriveOnboardingSteps(
      input({
        environment: {
          compatibility: { codex: { available: false, version: null }, claude: null },
          adapters: { claudeChannel: false, claudeHooks: false, codexHooks: false },
        },
      }),
    );
    expect(step(missing, "codex-cli")).toMatchObject({
      state: "BLOCKED",
      detail: "No codex executable answered",
    });

    const hookRoute = deriveOnboardingSteps(
      input({
        environment: {
          compatibility: {
            codex: null,
            claude: { available: true, customChannel: "unsupported" },
          },
          adapters: { claudeChannel: false, claudeHooks: false, codexHooks: false },
        },
      }),
    );
    // A build with no Channel flag is a supported configuration, not a failed detection.
    expect(step(hookRoute, "claude-cli")).toMatchObject({
      state: "DONE",
      detail: "Custom Channel unavailable, Hook fallback applies",
    });
    expect(step(hookRoute, "claude-adapter")).toMatchObject({
      state: "NOT_STARTED",
      command: "crossagent hooks install claude .",
    });
  });

  it("offers the Channel install only when the probe found the flag", () => {
    const steps = deriveOnboardingSteps(
      input({
        environment: {
          compatibility: {
            codex: null,
            claude: { available: true, customChannel: "supported" },
          },
          adapters: { claudeChannel: false, claudeHooks: false, codexHooks: false },
        },
      }),
    );

    expect(step(steps, "claude-adapter").command).toBe("crossagent claude-channel install .");
  });

  it("counts an installed Adapter through either route", () => {
    for (const adapters of [
      { claudeChannel: true, claudeHooks: false, codexHooks: false },
      { claudeChannel: false, claudeHooks: true, codexHooks: false },
    ]) {
      const steps = deriveOnboardingSteps(
        input({ environment: { compatibility: { codex: null, claude: null }, adapters } }),
      );
      expect(step(steps, "claude-adapter")).toMatchObject({ state: "DONE", command: null });
    }
  });

  it("only calls the Bridge connected when a session is actually online", () => {
    const offline = deriveOnboardingSteps(
      input({ sessions: [{ agentId: "codex", connectionState: "OFFLINE" }] }),
    );
    expect(step(offline, "codex-bridge")).toMatchObject({
      state: "WAITING",
      command: "crossagent codex --detach",
    });

    const online = deriveOnboardingSteps(
      input({ sessions: [{ agentId: "codex", connectionState: "ONLINE" }] }),
    );
    expect(step(online, "codex-bridge")).toMatchObject({ state: "DONE", command: null });

    // Another agent being online says nothing about the Codex Bridge.
    const other = deriveOnboardingSteps(
      input({ sessions: [{ agentId: "claude", connectionState: "ONLINE" }] }),
    );
    expect(step(other, "codex-bridge").state).toBe("WAITING");
  });

  it("is complete only when every step is measured done", () => {
    const steps = deriveOnboardingSteps(
      input({
        projectCount: 2,
        sessions: [{ agentId: "codex", connectionState: "ONLINE" }],
        messageCount: 4,
        environment: {
          compatibility: {
            codex: { version: "codex-cli 0.145.0" },
            claude: { available: true, customChannel: "supported" },
          },
          adapters: { claudeChannel: true, claudeHooks: false, codexHooks: false },
        },
      }),
    );

    expect(onboardingComplete(steps)).toBe(true);
  });
});
