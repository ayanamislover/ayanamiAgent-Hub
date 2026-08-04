import type { ReviewFinding } from "@crossagent/protocol";
import { bool, json } from "./context.js";

/**
 * The one row mapper two domains need.
 *
 * Every other mapper lives inside the single domain that uses it. This one does not: reviews maps
 * findings for its own reads, and tasks maps them too, because a task's computed progress is partly
 * derived from whether its latest review left blocking findings open. Putting it here keeps the
 * module graph acyclic -- tasks and reviews both depend on this, rather than on each other.
 *
 * Worth noting for a later cleanup, deliberately not acted on inside a mechanical extraction:
 * computeTaskProgress only reads `blocking` and `status`, so the tasks side could select those two
 * columns instead and this shared mapper would stop being shared.
 */
export function findingFromRow(row: any): ReviewFinding {
  return {
    id: row.id,
    reviewId: row.review_id,
    severity: row.severity,
    category: row.category,
    title: row.title,
    claim: row.claim,
    impact: row.impact,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    symbol: row.symbol,
    evidence: json(row.evidence_json, []),
    suggestedDirection: row.suggested_direction,
    status: row.status,
    blocking: bool(row.blocking),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as ReviewFinding;
}
