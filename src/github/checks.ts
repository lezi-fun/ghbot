import type { Octokit } from "@octokit/rest";

const IGNORED_CHECK_RUN_NAMES = new Set([
  "ghbot review",
  "bot-review",
  "bot-schedule-recheck",
  "review-schedule-recheck"
]);

const IGNORED_CHECK_RUN_SUFFIXES = ["/ bot-review", "/ bot-schedule-recheck"];

export async function requiredChecksAreGreen(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    ref: string;
  }
): Promise<{ ok: boolean; reason?: string }> {
  const [checks, statuses] = await Promise.all([
    octokit.rest.checks.listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.ref
    }),
    octokit.rest.repos.getCombinedStatusForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.ref
    })
  ]);

  const failedCheck = checks.data.check_runs.find((check) => {
    if (shouldIgnoreCheckRun(check.name)) {
      return false;
    }

    return (
      check.status !== "completed" ||
      !["success", "neutral", "skipped"].includes(check.conclusion ?? "")
    );
  });

  if (failedCheck) {
    return {
      ok: false,
      reason: `Check "${failedCheck.name}" is ${failedCheck.status}/${failedCheck.conclusion ?? "pending"}.`
    };
  }

  if (statuses.data.state !== "success" && statuses.data.statuses.length > 0) {
    return {
      ok: false,
      reason: `Commit status is ${statuses.data.state}.`
    };
  }

  return { ok: true };
}

function shouldIgnoreCheckRun(name: string): boolean {
  return (
    IGNORED_CHECK_RUN_NAMES.has(name) ||
    IGNORED_CHECK_RUN_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}
