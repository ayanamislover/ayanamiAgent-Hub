/**
 * The first-run wizard's six steps, derived rather than remembered.
 *
 * Nothing here records "the user finished step 3". Every step is recomputed from what the Hub can
 * actually see, so a wizard reopened after an Adapter was uninstalled tells the truth instead of
 * replaying a checklist somebody ticked once. That also means there is no state to migrate and no
 * way for the screen to disagree with the Agents page.
 */

import type { MessageKey } from "./i18n.js";

export type OnboardingStepState = "DONE" | "WAITING" | "BLOCKED" | "NOT_STARTED";

export type OnboardingStepId =
  "project" | "codex-cli" | "codex-bridge" | "claude-cli" | "claude-adapter" | "test-message";

export type OnboardingStep = {
  id: OnboardingStepId;
  state: OnboardingStepState;
  /** A message-catalog key; the component translates it rather than formatting anything itself. */
  detail: MessageKey;
  detailValues?: Record<string, string | number>;
  /** The exact command that advances this step, or null when there is nothing to run. */
  command: string | null;
};

/** The `/api/onboarding` payload: the two things the Hub's own tables cannot answer. */
export type OnboardingEnvironment = {
  compatibility: { codex: unknown | null; claude: unknown | null };
  adapters: { claudeChannel: boolean; claudeHooks: boolean; codexHooks: boolean };
};

export type OnboardingInput = {
  projectCount: number;
  sessions: Array<{ agentId: string; connectionState: string }>;
  messageCount: number;
  environment: OnboardingEnvironment | null;
};

type ProbeReport = {
  available?: boolean;
  version?: string | null;
  customChannel?: "supported" | "unsupported" | "unknown";
};

function report(value: unknown): ProbeReport | null {
  return value && typeof value === "object" ? (value as ProbeReport) : null;
}

function online(sessions: OnboardingInput["sessions"], agentId: string): boolean {
  return sessions.some(
    (session) => session.agentId === agentId && session.connectionState === "ONLINE",
  );
}

export function deriveOnboardingSteps(input: OnboardingInput): OnboardingStep[] {
  const codex = report(input.environment?.compatibility.codex);
  const claude = report(input.environment?.compatibility.claude);
  const adapters = input.environment?.adapters;
  const claudeAdapterInstalled = Boolean(adapters?.claudeChannel || adapters?.claudeHooks);
  // A build with no custom Channel flag is not a broken install; it is the Hook route. Only an
  // unprobed or absent CLI leaves the choice genuinely unknown.
  const claudeRoute =
    claude?.customChannel === "supported"
      ? "crossagent claude-channel install ."
      : "crossagent hooks install claude .";

  return [
    {
      id: "project",
      state: input.projectCount > 0 ? "DONE" : "NOT_STARTED",
      detail:
        input.projectCount > 0 ? "{count} project(s) registered" : "No project is registered yet",
      detailValues: { count: input.projectCount },
      command: input.projectCount > 0 ? null : "crossagent project join .",
    },
    {
      id: "codex-cli",
      state: !codex ? "NOT_STARTED" : codex.available === false ? "BLOCKED" : "DONE",
      detail: !codex
        ? "Not probed yet"
        : codex.available === false
          ? "No codex executable answered"
          : "{version}",
      detailValues: { version: codex?.version ?? "" },
      command: codex && codex.available !== false ? null : "crossagent compatibility probe codex",
    },
    {
      id: "codex-bridge",
      state: online(input.sessions, "codex") ? "DONE" : "WAITING",
      detail: online(input.sessions, "codex") ? "Connected" : "Waiting for a Bridge session",
      command: online(input.sessions, "codex") ? null : "crossagent codex --detach",
    },
    {
      id: "claude-cli",
      state: !claude ? "NOT_STARTED" : claude.available === false ? "BLOCKED" : "DONE",
      detail: !claude
        ? "Not probed yet"
        : claude.available === false
          ? "No claude executable answered"
          : claude.customChannel === "supported"
            ? "Custom Channel available"
            : "Custom Channel unavailable, Hook fallback applies",
      command:
        claude && claude.available !== false ? null : "crossagent compatibility probe claude",
    },
    {
      id: "claude-adapter",
      state: claudeAdapterInstalled ? "DONE" : claude ? "NOT_STARTED" : "WAITING",
      detail: adapters?.claudeChannel
        ? "Custom Channel installed"
        : adapters?.claudeHooks
          ? "Hook fallback installed"
          : claude
            ? "Ready to install"
            : "Probe Claude first",
      command: claudeAdapterInstalled ? null : claudeRoute,
    },
    {
      id: "test-message",
      state: input.messageCount > 0 ? "DONE" : "NOT_STARTED",
      detail:
        input.messageCount > 0 ? "{count} message(s) exchanged" : "No message has been sent yet",
      detailValues: { count: input.messageCount },
      command: null,
    },
  ];
}

export function onboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.every((step) => step.state === "DONE");
}
