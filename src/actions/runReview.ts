import fs from "node:fs";
import { config } from "../config.js";
import { createGitHubClient } from "../github/client.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
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
  const workflowCallEventName = process.env.GHBOT_EVENT_NAME;
  const payload = workflowCallEventName
    ? buildPayloadFromWorkflowCallEnv(workflowCallEventName)
    : readPayloadFromGitHubEventPath();
  const octokit = createGitHubClient();
  const eventName = workflowCallEventName ?? process.env.GITHUB_EVENT_NAME;

  if (!eventName) {
    throw new Error("GITHUB_EVENT_NAME is required.");
  }

  logger.info({ eventName }, "Handling GitHub Actions review event.");

  if (eventName === "pull_request_target") {
    const prPayload = payload as PullRequestPayload;
    if (prPayload.action === "opened") {
      await withRetry("github.issues.createComment.started", async () => {
        return octokit.rest.issues.createComment({
          owner: prPayload.repository.owner.login,
          repo: prPayload.repository.name,
          issue_number: prPayload.pull_request.number,
          body: "Automated review has started. I am checking this pull request now."
        });
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

function readPayloadFromGitHubEventPath(): PullRequestPayload | IssueCommentPayload | PullRequestReviewPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required when workflow_call inputs are not provided.");
  }

  return JSON.parse(fs.readFileSync(eventPath, "utf8")) as PullRequestPayload | IssueCommentPayload | PullRequestReviewPayload;
}

function buildPayloadFromWorkflowCallEnv(eventName: string): PullRequestPayload | IssueCommentPayload | PullRequestReviewPayload {
  const action = process.env.GHBOT_EVENT_ACTION;
  const owner = process.env.GHBOT_REPOSITORY_OWNER;
  const repo = process.env.GHBOT_REPOSITORY_NAME;
  const pullNumber = Number(process.env.GHBOT_PULL_NUMBER);

  if (!action || !owner || !repo || !Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error("Missing required GHBOT_* workflow_call inputs.");
  }

  const repository = {
    name: repo,
    owner: {
      login: owner
    },
    full_name: `${owner}/${repo}`
  };

  if (eventName === "pull_request_target") {
    return {
      action,
      pull_request: {
        number: pullNumber,
        draft: false
      },
      repository
    };
  }

  if (eventName === "issue_comment") {
    return {
      action,
      issue: {
        number: pullNumber,
        pull_request: {
          url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`
        }
      },
      comment: {
        body: process.env.GHBOT_COMMENT_BODY ?? "",
        user: {
          login: process.env.GHBOT_COMMENTER_LOGIN ?? ""
        }
      },
      repository
    };
  }

  if (eventName === "pull_request_review") {
    return {
      action,
      review: {
        state: process.env.GHBOT_REVIEW_STATE ?? "",
        commit_id: process.env.GHBOT_REVIEW_COMMIT_ID ?? "",
        user: {
          login: process.env.GHBOT_REVIEWER_LOGIN ?? ""
        }
      },
      pull_request: {
        number: pullNumber
      },
      repository
    };
  }

  throw new Error(`Unsupported GHBOT_EVENT_NAME: ${eventName}`);
}

main().catch((error) => {
  logger.error({ error, botName: config.botName }, "GitHub Actions review run failed.");
  process.exitCode = 1;
});
