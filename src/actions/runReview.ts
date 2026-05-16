import fs from "node:fs";
import { config } from "../config.js";
import { createGitHubClient } from "../github/client.js";
import { logger } from "../logger.js";
import {
  processLenientCheckComment,
  processPullRequest,
  processPullRequestReviewApproval
} from "../review/processor.js";

type GitHubRepository = {
  name: string;
  owner: {
    login: string;
  };
  full_name: string;
};

type PullRequestPayload = {
  action: string;
  pull_request: {
    number: number;
    draft: boolean;
  };
  repository: GitHubRepository;
};

type IssueCommentPayload = {
  action: string;
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  comment: {
    body: string;
    user: {
      login: string;
    };
  };
  repository: GitHubRepository;
};

type PullRequestReviewPayload = {
  action: string;
  review: {
    state: string;
    commit_id: string;
    user?: {
      login?: string;
    };
  };
  pull_request: {
    number: number;
  };
  repository: GitHubRepository;
};

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventName || !eventPath) {
    throw new Error("GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are required.");
  }

  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8")) as PullRequestPayload | IssueCommentPayload | PullRequestReviewPayload;
  const octokit = createGitHubClient();

  logger.info({ eventName }, "Handling GitHub Actions review event.");

  if (eventName === "pull_request_target") {
    const prPayload = payload as PullRequestPayload;
    if (prPayload.action === "opened") {
      await octokit.rest.issues.createComment({
        owner: prPayload.repository.owner.login,
        repo: prPayload.repository.name,
        issue_number: prPayload.pull_request.number,
        body: "Automated review has started. I am checking this pull request now."
      });
    }

    await processPullRequest(
      octokit,
      {
        owner: prPayload.repository.owner.login,
        repo: prPayload.repository.name,
        pullNumber: prPayload.pull_request.number
      },
      "strict"
    );
    return;
  }

  if (eventName === "issue_comment") {
    const commentPayload = payload as IssueCommentPayload;
    if (!commentPayload.issue.pull_request) {
      logger.info({ issueNumber: commentPayload.issue.number }, "Skipping issue comment because it is not on a pull request.");
      return;
    }

    await processLenientCheckComment(octokit, {
      owner: commentPayload.repository.owner.login,
      repo: commentPayload.repository.name,
      pullNumber: commentPayload.issue.number,
      commenterLogin: commentPayload.comment.user.login,
      commentBody: commentPayload.comment.body
    });
    return;
  }

  if (eventName === "pull_request_review") {
    const reviewPayload = payload as PullRequestReviewPayload;
    const reviewerLogin = reviewPayload.review.user?.login;
    if (!reviewerLogin) {
      logger.warn({ pullNumber: reviewPayload.pull_request.number }, "Skipping review event without reviewer login.");
      return;
    }

    await processPullRequestReviewApproval(octokit, {
      owner: reviewPayload.repository.owner.login,
      repo: reviewPayload.repository.name,
      pullNumber: reviewPayload.pull_request.number,
      reviewerLogin,
      state: reviewPayload.review.state,
      commitId: reviewPayload.review.commit_id
    });
    return;
  }

  logger.warn({ eventName }, "Unhandled GitHub Actions event.");
}

main().catch((error) => {
  logger.error({ error, botName: config.botName }, "GitHub Actions review run failed.");
  process.exitCode = 1;
});
