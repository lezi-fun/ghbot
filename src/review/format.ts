import type { ReviewDecision, ReviewFinding, ReviewMode } from "../types.js";
import { config } from "../config.js";
import { formatReviewStateMarker, type ReviewDisposition } from "./policy.js";

export type CategorizedFinding = ReviewFinding & {
  category: "review" | "change";
};

export function formatReviewBody(
  decision: ReviewDecision,
  unpostedFindings: CategorizedFinding[],
  mode: ReviewMode,
  disposition: ReviewDisposition
): string {
  const lines = [
    formatReviewStateMarker(mode, disposition, decision.review.length, decision.change.length),
    `## Automated review`,
    "",
    `Mode: ${mode === "lenient" ? "lenient" : "strict"}`,
    "",
    `### Comment`,
    "",
    decision.comment,
    "",
    `### Result for maintainers`,
    "",
    decision.result.summary,
    "",
    ...(decision.result.shouldClosePullRequest
      ? [`Close PR: yes`, "", `Close reason: ${decision.result.closeReason}`, ""]
      : []),
    `Model decision: ${decision.result.canMerge && decision.change.length === 0 ? "safe to merge" : "do not merge"}`,
    `Applied review policy: ${config.reviewPolicy}`,
    `Final status: ${formatDisposition(disposition)}`,
    "",
    `Required changes: ${decision.change.length}`,
    `Review notes: ${decision.review.length}`
  ];

  if (mode === "strict" && decision.change.length > 0 && !decision.result.shouldClosePullRequest) {
    lines.push("", "Need a narrower pass? Comment `/lenient-check` on this PR.");
  }

  if (unpostedFindings.length > 0) {
    lines.push("", "Findings that could not be attached inline:");
    for (const finding of unpostedFindings) {
      lines.push(
        "",
        `- ${finding.path}:${finding.line} [${finding.category}] ${finding.title}`,
        `  ${finding.body}`
      );
    }
  }

  return lines.join("\n");
}

function formatDisposition(disposition: ReviewDisposition): string {
  if (disposition.blocksMerge) {
    return "changes requested";
  }

  if (disposition.requiresAdminApproval) {
    return "waiting for repository administrator approval";
  }

  return "safe to merge";
}
