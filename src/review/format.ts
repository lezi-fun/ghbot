import type { ReviewDecision, ReviewFinding, ReviewMode } from "../types.js";

export function formatReviewBody(decision: ReviewDecision, unpostedFindings: ReviewFinding[], mode: ReviewMode): string {
  const lines = [
    `## Automated review`,
    "",
    `Mode: ${mode === "lenient" ? "lenient" : "strict"}`,
    "",
    decision.summary,
    "",
    ...(decision.shouldClosePullRequest
      ? [`Close PR: yes`, "", `Close reason: ${decision.closeReason}`, ""]
      : []),
    `Decision: ${decision.safeToMerge ? "safe to merge" : "changes requested"}`
  ];

  if (mode === "strict" && !decision.safeToMerge && !decision.shouldClosePullRequest) {
    lines.push("", "Need a narrower pass? Comment `/lenient-check` on this PR.");
  }

  if (decision.fixTips.length > 0) {
    lines.push("", "While making changes, also double-check:");
    for (const tip of decision.fixTips) {
      lines.push(`- ${tip}`);
    }
  }

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
