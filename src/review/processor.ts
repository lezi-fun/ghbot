import type { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { requiredChecksAreGreen } from "../github/checks.js";
import { collectValidNewLines, toDiffPosition } from "../github/diff.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import type { PullRequestFile, PullRequestRef, ReviewDecision, ReviewFinding, ReviewMode } from "../types.js";
import { CodexCliReviewer } from "./codexCliReviewer.js";
import { formatReviewBody } from "./format.js";
import { compactFilesForReview } from "./prompt.js";

const reviewer = new CodexCliReviewer();
const CHECK_RUN_NAME = "ghbot review";
export const LENIENT_COMMENT_COMMAND = "/lenient-check";
const ADMIN_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOSED_BRANCH_DELETE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export async function processPullRequest(octokit: Octokit, ref: PullRequestRef, mode: ReviewMode = "strict"): Promise<void> {
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

  const files = await listPullRequestFiles(octokit, owner, repo, pullNumber);
  const compactFiles = compactFilesForReview(files, config.maxPatchChars);
  const decision = await reviewer.review({
    title: pullRequest.title,
    body: pullRequest.body,
    files: compactFiles,
    mode
  });

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

  if (decision.shouldClosePullRequest) {
    await closeMaliciousPullRequest(octokit, {
      owner,
      repo,
      pullNumber,
      reason: decision.closeReason || "The automated review found clearly malicious code."
    });
    logger.warn({ owner, repo, pullNumber }, "Closed pull request because malicious code was detected.");
    return;
  }

  if (!decision.safeToMerge) {
    logger.info({ owner, repo, pullNumber }, "Review requested changes; not merging.");
    return;
  }

  await maybeMergePullRequest(octokit, {
    owner,
    repo,
    pullNumber,
    title: pullRequest.title,
    headSha: pullRequest.head.sha,
    mode,
    emitStatusComments: true
  });
}

export async function processScheduledLenientMerges(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
  }
): Promise<void> {
  if (!config.autoMerge) {
    logger.info({ owner: params.owner, repo: params.repo }, "Skipping scheduled lenient recheck because AUTO_MERGE is disabled.");
    return;
  }

  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner: params.owner,
    repo: params.repo,
    state: "open",
    per_page: 100
  });

  for (const pullRequest of pullRequests) {
    if (pullRequest.draft) {
      continue;
    }

    const hasSuccessfulLenientReview = await hasSuccessfulLenientReviewForHead(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number,
      headSha: pullRequest.head.sha
    });

    if (!hasSuccessfulLenientReview) {
      continue;
    }

    const adminRecentlyResponded = await hasRecentAdminResponse(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number
    });

    const approvedByEligibleReviewer = await hasCurrentHeadApprovalFrom(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number,
      headSha: pullRequest.head.sha,
      requireAdmin: adminRecentlyResponded
    });

    if (!approvedByEligibleReviewer) {
      continue;
    }

    await maybeMergePullRequest(octokit, {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number,
      title: pullRequest.title,
      headSha: pullRequest.head.sha,
      mode: "lenient",
      emitStatusComments: false
    });
  }
}

export async function processScheduledBranchCleanup(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
  }
): Promise<void> {
  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner: params.owner,
    repo: params.repo,
    state: "all",
    per_page: 100
  });

  const now = Date.now();

  for (const pullRequest of pullRequests) {
    if (!pullRequest.head?.ref || pullRequest.head.repo?.full_name !== `${params.owner}/${params.repo}`) {
      continue;
    }

    if (pullRequest.merged_at) {
      await deleteBranchIfPresent(octokit, {
        owner: params.owner,
        repo: params.repo,
        branch: pullRequest.head.ref,
        reason: `merged PR #${pullRequest.number}`
      });
      continue;
    }

    if (pullRequest.state !== "closed" || !pullRequest.closed_at) {
      continue;
    }

    const closedAt = Date.parse(pullRequest.closed_at);
    if (Number.isNaN(closedAt) || now - closedAt < CLOSED_BRANCH_DELETE_AFTER_MS) {
      continue;
    }

    await deleteBranchIfPresent(octokit, {
      owner: params.owner,
      repo: params.repo,
      branch: pullRequest.head.ref,
      reason: `closed PR #${pullRequest.number} older than 3 days`
    });
  }
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

  const hasSuccessfulLenientReview = await hasSuccessfulLenientReviewForHead(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    headSha: params.commitId
  });

  if (!hasSuccessfulLenientReview) {
    logger.info(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        reviewerLogin: params.reviewerLogin,
        commitId: params.commitId
      },
      "Ignoring lenient approval because there is no successful lenient review for the current head."
    );
    return;
  }

  const adminRecentlyResponded = await hasRecentAdminResponse(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber
  });

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

  const allowedPermissions = adminRecentlyResponded
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
        adminRecentlyResponded
      },
      "Ignoring lenient approval because reviewer does not meet the current permission threshold."
    );
    return;
  }

  await maybeMergePullRequest(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    title: pullRequest.title,
    headSha: pullRequest.head.sha,
    mode: "lenient",
    emitStatusComments: true
  });
}

export async function processLenientCheckComment(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commenterLogin: string;
    commentBody: string;
  }
): Promise<void> {
  if (!isLenientCheckComment(params.commentBody)) {
    return;
  }

  const adminRecentlyResponded = await hasRecentAdminResponse(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber
  });

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

  const allowedPermissions = adminRecentlyResponded
    ? new Set(["admin"])
    : new Set(["admin", "maintain", "write"]);

  if (!permission.permission || !allowedPermissions.has(permission.permission)) {
    logger.info(
      {
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        commenterLogin: params.commenterLogin,
        permission: permission.permission,
        adminRecentlyResponded
      },
      "Ignoring lenient check comment because commenter does not meet the current permission threshold."
    );
    return;
  }

  logger.info(
    {
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber,
      commenterLogin: params.commenterLogin,
      adminRecentlyResponded,
      permission: permission.permission
    },
    "Processing lenient check comment command."
  );

  await withRetry("github.issues.createComment.lenientRequested", async () => {
    return octokit.rest.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body: `Lenient check requested by @${params.commenterLogin}. Re-running the review with runtime and security focus only.`
    });
  });

  await processPullRequest(
    octokit,
    {
      owner: params.owner,
      repo: params.repo,
      pullNumber: params.pullNumber
    },
    "lenient"
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
    emitStatusComments: boolean;
  }
): Promise<void> {
  const { owner, repo, pullNumber } = params;

  if (!config.autoMerge) {
    logger.info({ owner, repo, pullNumber }, "AUTO_MERGE is disabled; approved only.");
    return;
  }

  if (params.mode === "lenient") {
    const adminRecentlyResponded = await hasRecentAdminResponse(octokit, {
      owner,
      repo,
      pullNumber
    });

    const approvalRequirement = adminRecentlyResponded
      ? "a repository administrator"
      : "a repository user with write permission or above";

    const approvedByEligibleReviewer = await hasCurrentHeadApprovalFrom(octokit, {
      owner,
      repo,
      pullNumber,
      headSha: params.headSha,
      requireAdmin: adminRecentlyResponded
    });

    if (!approvedByEligibleReviewer) {
      if (params.emitStatusComments) {
        await withRetry("github.issues.createComment.awaitLenientApproval", async () => {
          return octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: `Lenient check passed, but this PR will not be merged until ${approvalRequirement} approves the current head commit.\n\nNext step: in the GitHub pull request UI, click "Review changes" and submit an "Approve" review. No extra command is needed.`
          });
        });
      }
      logger.info({ owner, repo, pullNumber, adminRecentlyResponded }, "Waiting for eligible lenient approval before merging.");
      return;
    }
  }

  const mergeablePullRequest = await waitForMergeable(octokit, owner, repo, pullNumber);
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

  const approvedLogins = reviews
    .filter((review) => review.state === "APPROVED" && review.commit_id === params.headSha)
    .map((review) => review.user?.login)
    .filter((login): login is string => Boolean(login));

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
        "Failed to resolve collaborator permission while checking lenient approval eligibility."
      );
    }
  }

  return false;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

async function hasSuccessfulLenientReviewForHead(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
  }
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100
  });

  const botReviews = reviews
    .filter((review) => {
      return (
        review.user?.login === config.botName &&
        review.commit_id === params.headSha &&
        review.state !== "DISMISSED"
      );
    })
    .sort((left, right) => {
      const leftTime = left.submitted_at ? Date.parse(left.submitted_at) : 0;
      const rightTime = right.submitted_at ? Date.parse(right.submitted_at) : 0;
      return rightTime - leftTime;
    });

  for (const review of botReviews) {
    if (!review.body?.includes("Mode: lenient")) {
      continue;
    }

    return review.state === "APPROVED";
  }

  return false;
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
  const unpostedFindings: ReviewFinding[] = [];

  const comments = params.decision.findings.flatMap((finding) => {
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
        body: `**${finding.title}**\n\n${finding.body}`
      }
    ];
  });

  const hasBlockingFinding = params.decision.findings.some((finding) => finding.severity === "blocking");
  const event: "APPROVE" | "REQUEST_CHANGES" =
    params.decision.safeToMerge && !hasBlockingFinding ? "APPROVE" : "REQUEST_CHANGES";
  const body = formatReviewBody(params.decision, unpostedFindings, params.mode);

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
  const hasBlockingFinding = params.decision.findings.some((finding) => finding.severity === "blocking");
  const conclusion =
    params.decision.shouldClosePullRequest || hasBlockingFinding || !params.decision.safeToMerge ? "action_required" : "success";

  await withRetry("github.checks.create", async () => {
    return octokit.rest.checks.create({
      owner: params.owner,
      repo: params.repo,
      name: CHECK_RUN_NAME,
      head_sha: params.headSha,
      status: "completed",
      conclusion,
      output: {
        title: params.decision.shouldClosePullRequest
          ? "Malicious code detected"
          : params.mode === "lenient"
            ? "Lenient review completed"
            : "Strict review completed",
        summary: params.decision.shouldClosePullRequest
          ? `${params.decision.summary}\n\nClose reason: ${params.decision.closeReason}`
          : params.decision.summary
      },
      details_url: `https://github.com/${params.owner}/${params.repo}/pull/${params.pullNumber}`
    });
  });
}

export function isLenientCheckComment(body: string): boolean {
  return body.trim().startsWith(LENIENT_COMMENT_COMMAND);
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
    if (review.user?.login !== config.botName) {
      continue;
    }

    if (review.commit_id !== params.commitId) {
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

async function deleteBranchIfPresent(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    branch: string;
    reason: string;
  }
): Promise<void> {
  try {
    await withRetry("github.git.deleteRef", async () => {
      return octokit.rest.git.deleteRef({
        owner: params.owner,
        repo: params.repo,
        ref: `heads/${params.branch}`
      });
    });

    logger.info(
      {
        owner: params.owner,
        repo: params.repo,
        branch: params.branch,
        reason: params.reason
      },
      "Deleted branch after PR cleanup."
    );
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    logger.warn(
      {
        error,
        owner: params.owner,
        repo: params.repo,
        branch: params.branch,
        reason: params.reason
      },
      "Failed to delete branch during PR cleanup."
    );
  }
}

function shouldFallbackToCommentReview(error: unknown, event: "APPROVE" | "REQUEST_CHANGES"): boolean {
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

async function hasRecentAdminResponse(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }
): Promise<boolean> {
  const threshold = Date.now() - ADMIN_RESPONSE_WINDOW_MS;

  const [comments, reviews] = await Promise.all([
    octokit.paginate(octokit.rest.issues.listComments, {
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      per_page: 100
    }),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pullNumber,
      per_page: 100
    })
  ]);

  const actors = new Map<string, number>();

  for (const comment of comments) {
    const login = comment.user?.login;
    const createdAt = comment.created_at ? Date.parse(comment.created_at) : NaN;
    if (!login || Number.isNaN(createdAt) || createdAt < threshold) {
      continue;
    }

    actors.set(login, Math.max(actors.get(login) ?? 0, createdAt));
  }

  for (const review of reviews) {
    const login = review.user?.login;
    const submittedAt = review.submitted_at ? Date.parse(review.submitted_at) : NaN;
    if (!login || Number.isNaN(submittedAt) || submittedAt < threshold) {
      continue;
    }

    actors.set(login, Math.max(actors.get(login) ?? 0, submittedAt));
  }

  for (const login of actors.keys()) {
    try {
      const { data: permission } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: params.owner,
        repo: params.repo,
        username: login
      });

      if (permission.permission === "admin") {
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
        "Failed to resolve collaborator permission while checking for recent admin response."
      );
    }
  }

  return false;
}
