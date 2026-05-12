import type { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { requiredChecksAreGreen } from "../github/checks.js";
import { collectValidNewLines, toDiffPosition } from "../github/diff.js";
import { logger } from "../logger.js";
import type { PullRequestFile, PullRequestRef, ReviewDecision, ReviewFinding, ReviewMode } from "../types.js";
import { formatReviewBody } from "./format.js";
import { OpenAiReviewer } from "./openaiReviewer.js";
import { compactFilesForReview } from "./prompt.js";

const reviewer = new OpenAiReviewer();
const LENIENT_ACTION_IDENTIFIER = "lenient_check";
const CHECK_RUN_NAME = "ghbot review";

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
    mode
  });
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
  if (params.state !== "approved" || params.reviewerLogin !== config.lenientApprovalUser) {
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

  await maybeMergePullRequest(octokit, {
    owner: params.owner,
    repo: params.repo,
    pullNumber: params.pullNumber,
    title: pullRequest.title,
    headSha: pullRequest.head.sha,
    mode: "lenient"
  });
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
  }
): Promise<void> {
  const { owner, repo, pullNumber } = params;

  if (!config.autoMerge) {
    logger.info({ owner, repo, pullNumber }, "AUTO_MERGE is disabled; approved only.");
    return;
  }

  if (params.mode === "lenient") {
    const approvedByOwner = await hasCurrentHeadApprovalFrom(octokit, {
      owner,
      repo,
      pullNumber,
      headSha: params.headSha,
      reviewerLogin: config.lenientApprovalUser
    });

    if (!approvedByOwner) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: `Lenient check passed, but this PR will not be merged until @${config.lenientApprovalUser} approves the current head commit.`
      });
      logger.info({ owner, repo, pullNumber, reviewer: config.lenientApprovalUser }, "Waiting for lenient approval before merging.");
      return;
    }
  }

  const mergeablePullRequest = await waitForMergeable(octokit, owner, repo, pullNumber);
  if (mergeablePullRequest.mergeable !== true || mergeablePullRequest.mergeable_state === "dirty") {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: `Automated review approved this PR, but it was not merged because GitHub reports mergeable=${mergeablePullRequest.mergeable} and mergeable_state=${mergeablePullRequest.mergeable_state}.`
    });
    return;
  }

  if (config.requireChecks) {
    const checks = await requiredChecksAreGreen(octokit, {
      owner,
      repo,
      ref: params.headSha
    });
    if (!checks.ok) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: `Automated review approved this PR, but it was not merged because required checks are not green. ${checks.reason ?? ""}`.trim()
      });
      return;
    }
  }

  await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: config.mergeMethod,
    commit_title: `${params.title} (#${pullNumber})`
  });
}

async function hasCurrentHeadApprovalFrom(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    reviewerLogin: string;
  }
): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100
  });

  return reviews.some((review) => {
    return (
      review.user?.login === params.reviewerLogin &&
      review.state === "APPROVED" &&
      review.commit_id === params.headSha
    );
  });
}

export async function processLenientCheckRunAction(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    headSha: string;
  }
): Promise<void> {
  const pulls = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner: params.owner,
    repo: params.repo,
    commit_sha: params.headSha
  });

  const pullRequest = pulls.data.find((pull) => pull.state === "open");
  if (!pullRequest) {
    logger.warn(params, "No open pull request found for lenient check action.");
    return;
  }

  await processPullRequest(
    octokit,
    {
      owner: params.owner,
      repo: params.repo,
      pullNumber: pullRequest.number
    },
    "lenient"
  );
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

  await octokit.rest.pulls.createReview({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    commit_id: params.commitId,
    event,
    body: formatReviewBody(params.decision, unpostedFindings, params.mode),
    comments
  });
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

  await octokit.rest.checks.create({
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
    actions:
      params.mode === "strict" && conclusion === "action_required"
        ? [
            {
              label: "Lenient check",
              description: "Run only critical runtime checks.",
              identifier: LENIENT_ACTION_IDENTIFIER
            }
          ]
        : undefined
  });
}

export function isLenientCheckAction(identifier: string): boolean {
  return identifier === LENIENT_ACTION_IDENTIFIER;
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
  await octokit.rest.issues.createComment({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.pullNumber,
    body: `This PR was automatically closed because the review detected clearly malicious code.\n\nReason: ${params.reason}`
  });

  await octokit.rest.pulls.update({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    state: "closed"
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
