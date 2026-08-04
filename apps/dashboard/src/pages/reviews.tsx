import { CheckCircle, FileCode, GitDiff, ShieldWarning } from "@phosphor-icons/react";
import type { ReviewView } from "../types.js";
import { EmptyState, Panel, Pill } from "../components/primitives.js";
import { t } from "../i18n.js";

export function ReviewsPage({
  reviews,
  loading = false,
  error = null,
  onRetry,
}: {
  reviews: ReviewView[];
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const errorText = error instanceof Error ? error.message : String(error ?? "");
  return (
    <div className="standard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Independent assurance")}</span>
          <h1>{t("Review bundles")}</h1>
          <p>{t("Immutable patches, explicit evidence, and blocking findings before DONE.")}</p>
        </div>
        <div className="review-kpis">
          <span>
            {t("{count} live", {
              count: reviews.filter((item) => item.status === "IN_REVIEW").length,
            })}
          </span>
          <span>
            {t("{count} approved", {
              count: reviews.filter((item) => item.status === "APPROVED").length,
            })}
          </span>
        </div>
      </div>
      {loading ? (
        <Panel>
          <div className="empty-state" role="status" aria-live="polite">
            <strong>{t("Loading review bundles")}</strong>
            <span>{t("Verifying immutable patches and finding state…")}</span>
          </div>
        </Panel>
      ) : error ? (
        <Panel>
          <div className="error-state" role="alert">
            <div>
              <strong>{t("Unable to load review bundles")}</strong>
              <span>{errorText}</span>
              {onRetry && (
                <button className="primary-button" type="button" onClick={onRetry}>
                  {t("Try again")}
                </button>
              )}
            </div>
          </div>
        </Panel>
      ) : reviews.length === 0 ? (
        <Panel>
          <EmptyState
            title={t("No review bundles")}
            text={t(
              "A task author can request an immutable peer review after acceptance evidence is ready.",
            )}
          />
        </Panel>
      ) : (
        <div className="review-grid" aria-live="polite">
          {reviews.map((review) => (
            <Panel key={review.id} className="review-card">
              <div className="review-card-head">
                <span className="review-icon">
                  <GitDiff size={20} />
                </span>
                <div>
                  <span className="eyebrow">
                    {t("Revision {revision}", { revision: review.revision })}
                  </span>
                  <h2 title={review.id}>{review.id}</h2>
                </div>
                <Pill
                  tone={
                    review.status === "APPROVED"
                      ? "green"
                      : review.status === "CHANGES_REQUESTED"
                        ? "red"
                        : "amber"
                  }
                >
                  {review.status.replaceAll("_", " ")}
                </Pill>
              </div>
              <div className="sha-flow">
                <code>{review.baseSha.slice(0, 10)}</code>
                <span>→</span>
                <code>{review.headSha.slice(0, 10)}</code>
              </div>
              <dl className="review-meta">
                <div>
                  <dt>{t("Author")}</dt>
                  <dd>{review.authorAgentId}</dd>
                </div>
                <div>
                  <dt>{t("Reviewer")}</dt>
                  <dd>{review.reviewerAgentId}</dd>
                </div>
                <div>
                  <dt>{t("Files")}</dt>
                  <dd>{review.changedFiles.length}</dd>
                </div>
                <div>
                  <dt>{t("Patch hash")}</dt>
                  <dd>{review.patchSha256.slice(0, 12)}</dd>
                </div>
              </dl>
              <div className="acceptance-list" role="list" aria-label={t("Acceptance criteria")}>
                {review.acceptanceCriteria.slice(0, 4).map((criterion) => (
                  <div key={criterion} role="listitem">
                    <CheckCircle size={14} />
                    <span>{criterion}</span>
                  </div>
                ))}
              </div>
              <footer>
                <span>
                  <FileCode size={15} />{" "}
                  {t("{count} changed paths", { count: review.changedFiles.length })}
                </span>
                <span
                  className={review.findings?.some((finding) => finding.blocking) ? "danger" : ""}
                >
                  <ShieldWarning size={15} />{" "}
                  {t("{count} findings", { count: review.findings?.length ?? 0 })}
                </span>
              </footer>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
