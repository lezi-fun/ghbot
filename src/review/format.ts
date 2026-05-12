import type { ReviewDecision, ReviewFinding, ReviewMode } from "../types.js";

export function formatReviewBody(decision: ReviewDecision, unpostedFindings: ReviewFinding[], mode: ReviewMode): string {
  const lines = [
    `## Automated review`,
    "",
    `Mode: ${mode === "lenient" ? "lenient" : "strict"}`,
    "",
    decision.summary,
    "",
    `Decision: ${decision.safeToMerge ? "safe to merge" : "changes requested"}`
  ];

  if (unpostedFindings.length > 0) {
    lines.push("", "Findings that could not be attached inline:");
    for (const finding of unpostedFindings) {
      lines.push(
        "",
        `- ${finding.path}:${finding.line} [${finding.severity}] ${finding.title}`,
        `  ${finding.body}`
      );
    }
  }

  return lines.join("\n");
}
