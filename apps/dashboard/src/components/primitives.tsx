import type { PropsWithChildren, ReactNode } from "react";
import clsx from "clsx";
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { t } from "../i18n.js";

export function Panel({
  title,
  eyebrow,
  action,
  className,
  children,
}: PropsWithChildren<{
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  className?: string;
}>) {
  return (
    <section className={clsx("panel", className)}>
      {(title || eyebrow || action) && (
        <header className="panel-head">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && <h2>{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatusDot({ state }: { state: "ok" | "warn" | "danger" | "muted" }) {
  return <span className={`status-dot ${state}`} aria-label={state} />;
}

export function Pill({
  children,
  tone = "neutral",
}: PropsWithChildren<{
  tone?: "neutral" | "cyan" | "amber" | "red" | "green";
}>) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <div className="empty-glyph">·/·</div>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

export function Loading({ label = t("Loading live state") }: { label?: string }) {
  return (
    <div className="loading">
      <CircleNotch weight="bold" className="spin" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="error-state">
      <WarningCircle size={22} />
      <div>
        <strong>{t("Unable to load this surface")}</strong>
        <span>{error instanceof Error ? error.message : String(error)}</span>
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress-wrap">
      <div className="progress-meta">
        <span>{label ?? t("Verified progress")}</span>
        <strong>{Math.round(value)}%</strong>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}
