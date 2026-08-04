import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowClockwise, Check, Copy, X } from "@phosphor-icons/react";
import type { AgentSession } from "@crossagent/protocol";
import { hub } from "../api.js";
import { t, type MessageKey } from "../i18n.js";
import {
  deriveOnboardingSteps,
  onboardingComplete,
  type OnboardingEnvironment,
  type OnboardingStep,
  type OnboardingStepState,
} from "../onboarding.js";
import { Panel, Pill } from "./primitives.js";
import "./first-run-wizard.css";

const DISMISSED_KEY = "crossagent.wizard.dismissed";

const TITLES: Record<OnboardingStep["id"], MessageKey> = {
  project: "Register project",
  "codex-cli": "Detect Codex CLI",
  "codex-bridge": "Connect Codex Bridge",
  "claude-cli": "Detect Claude capabilities",
  "claude-adapter": "Install the Claude Adapter",
  "test-message": "Send a test message",
};

const TONES: Record<OnboardingStepState, "green" | "amber" | "red" | "neutral"> = {
  DONE: "green",
  WAITING: "amber",
  BLOCKED: "red",
  NOT_STARTED: "neutral",
};

const LABELS: Record<OnboardingStepState, MessageKey> = {
  DONE: "Done",
  WAITING: "Waiting",
  BLOCKED: "Blocked",
  NOT_STARTED: "Not started",
};

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="wizard-command">
      <code>{command}</code>
      <button
        type="button"
        className="icon-button compact"
        aria-label={copied ? t("Command copied") : t("Copy command")}
        onClick={() => {
          void navigator.clipboard
            .writeText(command)
            .then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            })
            // A denied clipboard is not an error worth a banner: the command is on screen to read.
            .catch(() => undefined);
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

export function FirstRunWizard({
  projectId,
  projectCount,
  sessions,
}: {
  projectId: string;
  projectCount: number;
  sessions: AgentSession[];
}) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === "true");
  const environment = useQuery<OnboardingEnvironment>({
    queryKey: ["onboarding", projectId],
    queryFn: () =>
      hub.request<OnboardingEnvironment>(
        "GET",
        `/api/onboarding?projectId=${encodeURIComponent(projectId)}`,
      ),
    refetchInterval: 15_000,
    retry: false,
  });
  // One message is all this step asks about, so it asks for one rather than a page of them.
  const messages = useQuery({
    queryKey: ["onboarding", projectId, "messages"],
    queryFn: () => hub.listMessages(projectId, { limit: 1 }),
    refetchInterval: 15_000,
    retry: false,
  });

  const steps = deriveOnboardingSteps({
    projectCount,
    sessions,
    messageCount: messages.data?.length ?? 0,
    environment: environment.data ?? null,
  });
  const done = steps.filter((step) => step.state === "DONE").length;
  // Once everything is connected the screen has nothing left to say, so it stops saying it.
  if (dismissed || onboardingComplete(steps)) return null;

  return (
    <Panel
      className="first-run-wizard"
      eyebrow={t("First run")}
      title={t("Finish connecting this workspace")}
      action={
        <div className="wizard-actions">
          <button
            type="button"
            className="icon-button compact"
            aria-label={t("Recheck setup")}
            onClick={() => void environment.refetch()}
          >
            <ArrowClockwise size={16} />
          </button>
          <button
            type="button"
            className="icon-button compact"
            aria-label={t("Hide setup steps")}
            onClick={() => {
              localStorage.setItem(DISMISSED_KEY, "true");
              setDismissed(true);
            }}
          >
            <X size={16} />
          </button>
        </div>
      }
    >
      <p className="muted">
        {t("{done} of {total} steps complete. Every step is measured, not remembered.", {
          done,
          total: steps.length,
        })}
      </p>
      <ol className="wizard-steps">
        {steps.map((step, index) => (
          <li key={step.id} className={`wizard-step ${step.state.toLowerCase()}`}>
            <span className="wizard-step-index">{index + 1}</span>
            <div className="wizard-step-body">
              <strong>{t(TITLES[step.id])}</strong>
              <span className="muted">{t(step.detail, step.detailValues)}</span>
              {step.command && <CopyCommand command={step.command} />}
            </div>
            <Pill tone={TONES[step.state]}>{t(LABELS[step.state])}</Pill>
          </li>
        ))}
      </ol>
      <p className="muted">
        {t("Or run crossagent setup . to do the whole sequence in one command.")}
      </p>
    </Panel>
  );
}
