import { ArrowsOutLineHorizontal, Check, File, WarningOctagon } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { hub, idempotency } from "../api.js";
import { EmptyState, Panel, Pill } from "../components/primitives.js";
import type { ConflictView } from "../types.js";
import { t } from "../i18n.js";

export function ConflictsPage({
  projectId,
  conflicts,
}: {
  projectId: string;
  conflicts: ConflictView[];
}) {
  const queryClient = useQueryClient();
  const resolveMutation = useMutation({
    mutationFn: (id: string) =>
      hub.request("POST", `/api/conflicts/${id}/resolve`, {
        reason: "Resolved by local user after scope review",
        actorId: "local-user",
        idempotencyKey: idempotency("dashboard-conflict"),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
  });
  return (
    <div className="standard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Write safety")}</span>
          <h1>{t("Conflicts")}</h1>
          <p>{t("Declared write overlap reconciled against actual Git changes.")}</p>
        </div>
      </div>
      {conflicts.length === 0 ? (
        <Panel>
          <EmptyState
            title={t("No open write conflicts")}
            text={t("Exclusive scopes and protected paths are currently clear.")}
          />
        </Panel>
      ) : (
        <div className="conflict-list">
          {conflicts.map((conflict) => (
            <Panel key={conflict.id} className={`conflict-card ${conflict.severity}`}>
              <div className="conflict-head">
                <span className="conflict-icon">
                  <WarningOctagon size={22} weight="fill" />
                </span>
                <div>
                  <span className="eyebrow">{t("Write intent overlap")}</span>
                  <h2 title={conflict.id}>{conflict.id}</h2>
                </div>
                <Pill tone={conflict.severity === "critical" ? "red" : "amber"}>
                  {conflict.severity}
                </Pill>
              </div>
              <div className="conflict-sides">
                <div>
                  <strong>{conflict.left.agentId}</strong>
                  <span>{conflict.left.taskId}</span>
                  <code>{conflict.left.globs.join(", ")}</code>
                </div>
                <ArrowsOutLineHorizontal size={24} />
                <div>
                  <strong>{conflict.right.agentId}</strong>
                  <span>{conflict.right.taskId}</span>
                  <code>{conflict.right.globs.join(", ")}</code>
                </div>
              </div>
              <div className="overlap-files">
                {conflict.overlapFiles.map((path) => (
                  <span key={path}>
                    <File size={13} /> {path}
                  </span>
                ))}
                {conflict.overlapSymbols.map((symbol) => (
                  <span key={symbol}>
                    <File size={13} /> symbol:{symbol}
                  </span>
                ))}
                {conflict.overlapFiles.length === 0 && conflict.overlapSymbols.length === 0 && (
                  <span>
                    {t(
                      "No intersecting files or symbols were reported. Review the intent patterns before resolving.",
                    )}
                  </span>
                )}
              </div>
              <footer>
                <time dateTime={conflict.createdAt}>
                  {new Date(conflict.createdAt).toLocaleString()}
                </time>
                <button
                  type="button"
                  disabled={resolveMutation.isPending && resolveMutation.variables === conflict.id}
                  aria-label={t("Mark conflict {id} resolved", { id: conflict.id })}
                  onClick={() => resolveMutation.mutate(conflict.id)}
                >
                  <Check size={15} />{" "}
                  {resolveMutation.isPending && resolveMutation.variables === conflict.id
                    ? t("Resolving…")
                    : t("Mark resolved")}
                </button>
              </footer>
            </Panel>
          ))}
          {resolveMutation.error && (
            <span className="project-register-error" role="alert">
              {resolveMutation.error.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
