import type { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { requiredChecksAreGreen } from "../github/checks.js";
import { collectValidNewLines, toDiffPosition } from "../github/diff.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import type { PullRequestFile, PullRequestRef, ReviewDecision, ReviewMode } from "../types.js";
import {
  deleteLocalReviewCache,
  loadPreviousReview,
  saveReviewCache
} from "./cache.js";
import { GooseReviewer } from "./gooseReviewer.js";
import { formatReviewBody, type CategorizedFinding } from "./format.js";
import {
  approvedLoginsForHead,
  evaluateReviewDecision,
  formatReviewExternalId,
  isReviewBranchEnabled,
  parseReviewExternalId,
  parseReviewStateMarker
} from "./policy.js";
import { compactFilesForReview } from "./prompt.js";
import { loadRepositoryKnowledge } from "../repository/knowledge.js";
import { canAutoResolveConflicts, resolvePullRequestConflicts } from "./conflictResolver.js";

const reviewer = new GooseReviewer();
const CHECK_RUN_NAME = "ghbot review";
export const RECHECK_COMMENT_COMMAND = "/recheck";

export async function processPullRequest(
  octokit: Octokit,
  ref: PullRequestRef,
  mode: ReviewMode = "normal",
  gitToken?: string
): Promise<void> {
  const { owner, repo, pullNumber } = ref;

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });

  if (pullRequest.draft) {
    logger.info({ owner, repo, pullNumber }, "Skipping draft pull request.");
    return;
  }

  if (pullRequest.state !== "open") {
    logger.info({ owner, repo, pullNumber, state: pullRequest.state }, "Skipping non-open pull request.");
    return;
  }

  if (!isReviewBranchEnabled(pullRequest.base.ref)) {
    logger.info(
      { owner, repo, pullNumber, baseBranch: pullRequest.base.ref, reviewBranches: config.reviewBranches },
      "Skipping pull request because its base branch does not match REVIEW_BRANCHES."
    );
    return;
  }

  const files = await listPullRequestFiles(octokit, owner, repo, pullNumber);
  const compactFiles = compactFilesForReview(files, config.maxPatchChars);
  const previousReview = await loadPreviousReview({
    owner,
    repo,
    pullNumber,
    currentHeadSha: pullRequest.head.sha
  });
  const repositoryKnowledge = config.repositoryKnowledgeEnabled
    ? await loadRepositoryKnowledge().catch((error: unknown) => {
        logger.warn({ error, owner, repo, pullNumber }, "Ignoring unavailable repository knowledge.");
        return undefined;
      })
    : undefined;
  const decision = await reviewer.review({
    title: pullRequest.title,
    body: pullRequest.body,
    files: compactFiles,
    mode,
    previousReview,
    repositoryKnowledge
  });

  const { data: currentPullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });
  if (currentPullRequest.state !== "open" || currentPullRequest.head.sha !== pullRequest.head.sha) {
    await deleteLocalReviewCache(pullNumber);
    logger.info(
      {
        owner,
        repo,
        pullNumber,
        reviewedHead: pullRequest.head.sha,
        currentHead: currentPullRequest.head.sha,
        currentState: currentPullRequest.state
      },
      "Discarding stale review because the pull request changed while goose was running."
    );
    return;
  }

  await saveReviewCache({ owner, repo, pullNumber, headSha: pullRequest.head.sha, decision });

  await submitReview(octokit, {
    owner,
    repo,
    pullNumber,
    commitId: pullRequest.head.sha,
    files,
    decision,
    mode
  });

  await upsertReviewCheckRun(octokit, {
    owner,
    repo,
    headSha: pullRequest.head.sha,
    pullNumber,
    decision,
    mode
  });

  if (decision.result.shouldClosePullRequest) {
    await closeMaliciousPullRequest(octokit, {
      owner,
      repo,
      pullNumber,
      reason: decision.result.closeReason || "The automated review found clearly malicious code."
    });
    logger.warn({ owner, repo, pullNumber }, "Closed pull request because malicious code was detected.");
    return;
  }

  const disposition = evaluateReviewDecision(decision);
  if (disposition.requiresAdminApproval) {
    const alreadyApprovedByAdmin = await hasCurrentHeadApprovalFrom(octokit, {
      owner,
      repo,
      pullNumber,
      headSha: pullRequest.head.sha,
      requireAdmin: true
    });

    if (alreadyApprovedByAdmin) {
      await markReviewCheckApproved(octokit, {
        owner,
        repo,
        headSha: pullRequest.head.sha,
        pullNumber
      });
    }
  }

  if (disposition.blocksMerge) {
    logger.info({ owner, repo, pullNumber }, "Review requested changes; not merging.");
    return;
  }

  const mergeablePullRequest = await waitForMergeable(octokit, owner, repo, pullNumber);
  const conflictResolutionEligible = canAutoResolveConflicts({
    enabled: config.autoResolveConflicts,
    reviewPassed: true,
    mergeable: mergeablePullRequest.mergeable,
    mergeableState: mergeablePullRequest.mergeable_state,
    baseRepository: `${owner}/${repo}`,
    headRepository: pullRequest.head.repo?.full_name ?? null,
    expectedHeadSha: pullRequest.head.sha,
    currentHeadSha: currentPullRequest.head.sha
  });
  if (conflictResolutionEligible) {
    const worktree = process.env.GHBOT_PR_WORKTREE;
    if (!gitToken || !worktree) {
      logger.warn(
        { owner, repo, pullNumber, hasGitToken: Boolean(gitToken), hasWorktree: Boolean(worktree) },
        "Cannot resolve pull request conflicts without a git token and PR worktree."
      );
    } else {
      try {
        const resolved = await resolvePullRequestConflicts(octokit, {
          owner,
          repo,
          pullNumber,
          expectedHeadSha: pullRequest.head.sha,
          baseBranch: pullRequest.base.ref,
          headBranch: pullRequest.head.ref,
          headRepository: pullRequest.head.repo?.full_name ?? null,
          worktree,
          gitToken,
          repositoryKnowledge
        });
        if (resolved) {
          await withRetry("github.issues.createComment.conflictsResolved", async () => {
            return octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: pullNumber,
              body: "goose resolved the merge conflicts, validated the final changes, and pushed a new commit. The new head will be reviewed again before any merge decision."
            });
          });
          return;
        }
      } catch (error) {
        logger.error({ error, owner, repo, pullNumber }, "Automatic conflict resolution failed safely.");
        await withRetry("github.issues.createComment.conflictResolutionFailed", async () => {
          return octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: "Automated review passed, but goose could not safely resolve and validate the merge conflicts. No conflict-resolution commit was pushed."
          });
        });
        return;
      }
    }
  }

  await maybeMergePullRequest(octokit, {
    owner,
    repo,
    pullNumber,
    title: pullRequest.title,
    headSha: pullRequest.head.sha,
    mode,
    requireAdminApproval: disposition.requiresAdminApproval,
    emitStatusComments: true,
    mergeablePullRequest
  });
}

export async function processScheduledPendingMerges(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
  }
): Promise<void> {
  if (!config.autoMerge) {
    logger.info({ owner: params.owner, repo: params.repo }, "Skipping scheduled pending merge check because AUTO_MERGE is disabled.");
    return;
  }

  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner: params.owner,
    repo: params.repo,
    state: "open",
    per_page: 100
  });

  for (const pullRequest of pullRequests) {
    if (pullRequest.draft || !isReviewBranchEnabled(pullRequest.base.ref)) {
      continue;
    }

    const latestReviewOutcome = await getLatestBotReviewOutcomeForHead(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number,
      headSha: pullRequest.head.sha
    });

    if (!latestReviewOutcome || latestReviewOutcome.outcome !== "pass") {
      continue;
    }

    if (!latestReviewOutcome.requiresAdminApproval) {
      continue;
    }

    const approvedByEligibleReviewer = await hasCurrentHeadApprovalFrom(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number,
      headSha: pullRequest.head.sha,
      requireAdmin: true
    });

    if (!approvedByEligibleReviewer) {
      continue;
    }

    if (latestReviewOutcome.requiresAdminApproval) {
      await markReviewCheckApproved(octokit, {
        owner: params.owner,
        repo: params.repo,
        headSha: pullRequest.head.sha,
        pullNumber: pullRequest.number
      });
    }

    await maybeMergePullRequest(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number,
      title: pullRequest.title,
      headSha: pullRequest.head.sha,
      mode: latestReviewOutcome.mode,
      requireAdminApproval: latestReviewOutcome.requiresAdminApproval,
      emitStatusComments: false
    });
  }
}

export async function shouldReviewPullRequest(
  octokit: Octokit,
  params: { owner: string; repo: string; pullNumber: number }
): Promise<boolean> {
  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber
  });
  return isReviewBranchEnabled(pullRequest.base.ref);
}

export async function processPullRequestReviewApproval(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    reviewerLogin: string;
    state: string;
    commitId: string;
  }
): Promise<void> {
  if (params.state !== "approved") {
    return;
  }

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber
  });

  if (pullRequest.head.sha !== params.commitId) {
    logger.info(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        approvedCommit: params.commitId,
        currentHead: pullRequest.head.sha
      },
      "Ignoring approval because it does not match the current PR head."
    );
    return;
  }

  if (!isReviewBranchEnabled(pullRequest.base.ref)) {
    logger.info(
      { owner: params.owner, repo: params.repo, pullNumber: params.pullNumber, baseBranch: pullRequest.base.ref },
      "Ignoring approval for a pull request outside REVIEW_BRANCHES."
    );
    return;
  }

  const latestReviewOutcome = await getLatestBotReviewOutcomeForHead(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    headSha: params.commitId
  });

  if (!latestReviewOutcome || latestReviewOutcome.outcome !== "pass") {
    logger.info(
      { owner: params.owner, repo: params.repo, pullNumber: params.pullNumber, commitId: params.commitId },
      "Ignoring approval because there is no successful bot review for the current head."
    );
    return;
  }

  const { data: permission } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner: params.owner,
    repo: params.repo,
    username: params.reviewerLogin
  }).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return { data: { permission: null } };
    }

    throw error;
  });

  const requireAdmin = latestReviewOutcome.requiresAdminApproval;
  const allowedPermissions = requireAdmin
    ? new Set(["admin"])
    : new Set(["admin", "maintain", "write"]);

  if (!permission.permission || !allowedPermissions.has(permission.permission)) {
    logger.info(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        reviewerLogin: params.reviewerLogin,
        permission: permission.permission,
        requireAdmin
      },
      "Ignoring approval because reviewer does not meet the current permission threshold."
    );
    return;
  }

  if (latestReviewOutcome.requiresAdminApproval) {
    await markReviewCheckApproved(octokit, {
      owner: params.owner,
      repo: params.repo,
      headSha: pullRequest.head.sha,
      pullNumber: params.pullNumber
    });
  }

  await maybeMergePullRequest(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    title: pullRequest.title,
    headSha: pullRequest.head.sha,
    mode: latestReviewOutcome.mode,
    requireAdminApproval: latestReviewOutcome.requiresAdminApproval,
    emitStatusComments: true
  });
}

export async function processRecheckComment(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commenterLogin: string;
    commentBody: string;
    gitToken?: string;
  }
): Promise<void> {
  if (!isRecheckComment(params.commentBody)) {
    return;
  }


  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber
  });
  if (!isReviewBranchEnabled(pullRequest.base.ref)) {
    logger.info(
      { owner: params.owner, repo: params.repo, pullNumber: params.pullNumber, baseBranch: pullRequest.base.ref },
      "Ignoring recheck outside REVIEW_BRANCHES."
    );
    return;
  }

  const { data: permission } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner: params.owner,
    repo: params.repo,
    username: params.commenterLogin
  }).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return { data: { permission: null } };
    }

    throw error;
  });

  const allowedPermissions = new Set(["admin", "maintain", "write"]);

  if (!permission.permission || !allowedPermissions.has(permission.permission)) {
    logger.info(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        commenterLogin: params.commenterLogin,
        permission: permission.permission,
      },
      "Ignoring recheck comment because commenter does not have write permission."
    );
    return;
  }

  logger.info(
    {
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      commenterLogin: params.commenterLogin,
      permission: permission.permission
    },
    "Processing recheck comment command."
  );

  await withRetry("github.issues.createComment.recheckRequested", async () => {
    return octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: `Recheck requested by @${params.commenterLogin}. Re-running the review with the repository's current strictness settings.`
    });
  });

  await processPullRequest(
    octokit,
    {
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber
    },
    config.reviewStrictness === "strict" ? "strict" : "normal",
    params.gitToken
  );
}

async function maybeMergePullRequest(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    title: string;
    headSha: string;
    mode: ReviewMode;
    requireAdminApproval: boolean;
    emitStatusComments: boolean;
    mergeablePullRequest?: Awaited<ReturnType<typeof waitForMergeable>>;
  }
): Promise<void> {
  const { owner, repo, pullNumber } = params;

  if (!config.autoMerge) {
    logger.info({ owner, repo, pullNumber }, "AUTO_MERGE is disabled; approved only.");
    return;
  }

  if (params.requireAdminApproval) {
    const approvedByEligibleReviewer = await hasCurrentHeadApprovalFrom(octokit, {
      owner,
      repo,
      pullNumber,
      headSha: params.headSha,
      requireAdmin: true
    });

    if (!approvedByEligibleReviewer) {
      if (params.emitStatusComments) {
        await withRetry("github.issues.createComment.awaitAdminApproval", async () => {
          return octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: `Automated review passed, but this PR will not be merged until a repository administrator approves the current head commit.\n\nNext step: in the GitHub pull request UI, click "Review changes" and submit an "Approve" review. No extra command is needed.`
          });
        });
      }
      logger.info({ owner, repo, pullNumber }, "Waiting for administrator approval before merging.");
      return;
    }
  }

  const mergeablePullRequest = params.mergeablePullRequest ?? await waitForMergeable(octokit, owner, repo, pullNumber);
  if (mergeablePullRequest.mergeable !== true || mergeablePullRequest.mergeable_state === "dirty") {
    if (params.emitStatusComments) {
      await withRetry("github.issues.createComment.notMergeable", async () => {
        return octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: `Automated review approved this PR, but it was not merged because GitHub reports mergeable=${mergeablePullRequest.mergeable} and mergeable_state=${mergeablePullRequest.mergeable_state}.`
        });
      });
    }
    return;
  }

  if (config.requireChecks) {
    const checks = await requiredChecksAreGreen(octokit, {
      owner,
      repo,
      ref: params.headSha
    });
    if (!checks.ok) {
      if (params.emitStatusComments) {
        await withRetry("github.issues.createComment.requiredChecks", async () => {
          return octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: `Automated review approved this PR, but it was not merged because required checks are not green. ${checks.reason ?? ""}`.trim()
          });
        });
      }
      return;
    }
  }

  await withRetry("github.pulls.merge", async () => {
    return octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: config.mergeMethod,
      commit_title: `${params.title} (#${pullNumber})`
    });
  });
}

async function hasCurrentHeadApprovalFrom(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    requireAdmin: boolean;
  }
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100
  });

  const approvedLogins = approvedLoginsForHead(
    reviews.map((review) => ({
      id: review.id,
      state: review.state,
      commitId: review.commit_id,
      login: review.user?.login,
      submittedAt: review.submitted_at
    })),
    params.headSha
  );

  for (const login of approvedLogins) {
    try {
      const { data: permission } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: params.owner,
        repo: params.repo,
        username: login
      }).catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return { data: { permission: null } };
        }

        throw error;
      });

      if (!permission.permission) {
        continue;
      }

      if (params.requireAdmin) {
        if (permission.permission === "admin") {
          return true;
        }
        continue;
      }

      if (new Set(["admin", "maintain", "write"]).has(permission.permission)) {
        return true;
      }
    } catch (error) {
      logger.warn(
        {
          error,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.pullNumber,
          login
        },
        "Failed to resolve collaborator permission while checking approval eligibility."
      );
    }
  }

  return false;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

async function getLatestBotReviewOutcomeForHead(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
  }
) {
  const checks = await octokit.rest.checks.listForRef({
    owner: params.owner,
    repo: params.repo,
    ref: params.headSha,
    check_name: CHECK_RUN_NAME,
    per_page: 100
  });

  const botChecks = checks.data.check_runs
    .filter((check) => check.name === CHECK_RUN_NAME)
    .sort((left, right) => {
      const leftTime = left.started_at ? Date.parse(left.started_at) : 0;
      const rightTime = right.started_at ? Date.parse(right.started_at) : 0;
      return rightTime - leftTime;
    });

  for (const check of botChecks) {
    const outcome = parseReviewExternalId(check.external_id);
    if (outcome) {
      return outcome;
    }
  }

  return null;
}

async function listPullRequestFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<PullRequestFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100
  });

  return files.map((file) => ({
    filename: file.filename,
    patch: file.patch,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions
  }));
}

async function submitReview(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
    files: PullRequestFile[];
    decision: ReviewDecision;
    mode: ReviewMode;
  }
): Promise<void> {
  await dismissExistingBotReviews(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    commitId: params.commitId
  });

  const validLines = collectValidNewLines(params.files);
  const filesByPath = new Map(params.files.map((file) => [file.filename, file]));
  const unpostedFindings: CategorizedFinding[] = [];
  const categorizedFindings: CategorizedFinding[] = [
    ...params.decision.change.map((finding) => ({ ...finding, category: "change" as const })),
    ...params.decision.review.map((finding) => ({ ...finding, category: "review" as const }))
  ];

  const comments = categorizedFindings.flatMap((finding) => {
    const file = filesByPath.get(finding.path);
    if (!file) {
      unpostedFindings.push(finding);
      return [];
    }

    const position = toDiffPosition(file, finding.line, validLines);
    if (!position) {
      unpostedFindings.push(finding);
      return [];
    }

    return [
      {
        path: position.path,
        line: position.line,
        side: position.side,
        body: `**${finding.category === "change" ? "Required change" : "Review note"}: ${finding.title}**\n\n${finding.body}`
      }
    ];
  });

  const disposition = evaluateReviewDecision(params.decision);
  const event = disposition.event;
  const body = formatReviewBody(params.decision, unpostedFindings, params.mode, disposition);

  try {
    await withRetry("github.pulls.createReview", async () => {
      return octokit.rest.pulls.createReview({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        commit_id: params.commitId,
        event,
        body,
        comments
      });
    });
  } catch (error) {
    if (!shouldFallbackToCommentReview(error, event)) {
      throw error;
    }

    logger.warn(
      {
        error,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        commitId: params.commitId
      },
      "Falling back to COMMENT review because the current token is not allowed to approve pull requests."
    );

    await withRetry("github.pulls.createReview.commentFallback", async () => {
      return octokit.rest.pulls.createReview({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        commit_id: params.commitId,
        event: "COMMENT",
        body,
        comments
      });
    });
  }
}

async function upsertReviewCheckRun(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    headSha: string;
    pullNumber: number;
    decision: ReviewDecision;
    mode: ReviewMode;
  }
): Promise<void> {
  const disposition = evaluateReviewDecision(params.decision);
  const conclusion = disposition.blocksMerge || disposition.requiresAdminApproval
    ? "action_required"
    : "success";

  await withRetry("github.checks.create", async () => {
    return octokit.rest.checks.create({
      owner: params.owner,
      repo: params.repo,
      name: CHECK_RUN_NAME,
      head_sha: params.headSha,
      status: "completed",
      conclusion,
      external_id: formatReviewExternalId(params.mode, disposition),
      output: {
        title: params.decision.result.shouldClosePullRequest
          ? "Malicious code detected"
          : disposition.requiresAdminApproval
            ? "Review notes require administrator approval"
          : `${params.mode === "strict" ? "Strict" : "Normal"} review completed`,
        summary: params.decision.result.shouldClosePullRequest
          ? `${params.decision.result.summary}\n\nClose reason: ${params.decision.result.closeReason}`
          : params.decision.result.summary
      },
      details_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.pullNumber}`
    });
  });
}

async function markReviewCheckApproved(
  octokit: Octokit,
  params: { owner: string; repo: string; headSha: string; pullNumber: number }
): Promise<void> {
  const checks = await octokit.rest.checks.listForRef({
    owner: params.owner,
    repo: params.repo,
    ref: params.headSha,
    check_name: CHECK_RUN_NAME,
    per_page: 100
  });
  const check = checks.data.check_runs
    .filter((item) => item.name === CHECK_RUN_NAME)
    .sort((left, right) => Date.parse(right.started_at ?? "") - Date.parse(left.started_at ?? ""))[0];

  if (!check) {
    throw new Error(`Could not find ${CHECK_RUN_NAME} check for ${params.headSha}.`);
  }

  await withRetry("github.checks.update.adminApproved", async () => {
    return octokit.rest.checks.update({
      owner: params.owner,
      repo: params.repo,
      check_run_id: check.id,
      status: "completed",
      conclusion: "success",
      external_id: check.external_id ?? undefined,
      output: {
        title: "Repository administrator approved review notes",
        summary: "The current pull request head has the administrator approval required by REVIEW_POLICY=require_approval."
      },
      details_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.pullNumber}`
    });
  });
}

export function isRecheckComment(body: string): boolean {
  return body.trim() === RECHECK_COMMENT_COMMAND;
}

async function closeMaliciousPullRequest(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    reason: string;
  }
): Promise<void> {
  await withRetry("github.issues.createComment.closeMalicious", async () => {
    return octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: `This PR was automatically closed because the review detected clearly malicious code.\n\nReason: ${params.reason}`
    });
  });

  await withRetry("github.pulls.update.closeMalicious", async () => {
    return octokit.rest.pulls.update({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      state: "closed"
    });
  });
}

async function waitForMergeable(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber
    });

    if (data.mergeable !== null) {
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber
  });
  return data;
}

async function dismissExistingBotReviews(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
  }
): Promise<void> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100
  });

  for (const review of reviews) {
    if (review.user?.type !== "Bot" || !parseReviewStateMarker(review.body)) {
      continue;
    }

    if (!review.id || review.state === "DISMISSED") {
      continue;
    }

    try {
      await octokit.rest.pulls.dismissReview({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        review_id: review.id,
        message: "Superseded by a newer automated review run."
      });
    } catch (error) {
      logger.warn(
        {
          error,
          owner: params.owner,
          repo: params.repo,
          pullNumber: params.pullNumber,
          reviewId: review.id
        },
        "Failed to dismiss existing bot review."
      );
    }
  }
}

function shouldFallbackToCommentReview(error: unknown, event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"): boolean {
  if (event !== "APPROVE") {
    return false;
  }

  if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 422) {
    return false;
  }

  if (!("message" in error) || typeof error.message !== "string") {
    return false;
  }

  return error.message.includes("GitHub Actions is not permitted to approve pull requests.");
}
