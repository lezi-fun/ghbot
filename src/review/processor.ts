import type { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { requiredChecksAreGreen } from "../github/checks.js";
import { collectValidNewLines, toDiffPosition } from "../github/diff.js";
import { logger } from "../logger.js";
import type { PullRequestFile, PullRequestRef, ReviewDecision, ReviewFinding } from "../types.js";
import { formatReviewBody } from "./format.js";
import { OpenAiReviewer } from "./openaiReviewer.js";
import { compactFilesForReview } from "./prompt.js";

const reviewer = new OpenAiReviewer();

export async function processPullRequest(octokit: Octokit, ref: PullRequestRef): Promise<void> {
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
    files: compactFiles
  });

  await submitReview(octokit, {
    owner,
    repo,
    pullNumber,
    commitId: pullRequest.head.sha,
    files,
    decision
  });

  if (!decision.safeToMerge) {
    logger.info({ owner, repo, pullNumber }, "Review requested changes; not merging.");
    return;
  }

  if (!config.autoMerge) {
    logger.info({ owner, repo, pullNumber }, "AUTO_MERGE is disabled; approved only.");
    return;
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
      ref: pullRequest.head.sha
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
    commit_title: `${pullRequest.title} (#${pullNumber})`
  });
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
    body: formatReviewBody(params.decision, unpostedFindings),
    comments
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
