import type { Octokit } from "@octokit/rest";

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
