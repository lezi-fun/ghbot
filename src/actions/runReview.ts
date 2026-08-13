import fs from "node:fs";
import { config } from "../config.js";
import { createGitHubClient } from "../github/client.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import { processPullRequestChat } from "../chat/processor.js";
import { processIssueTriage, processPullRequestTriage } from "../triage/processor.js";
import { deleteLocalReviewCache } from "../review/cache.js";
import {
  cleanupPullRequestReviewCache,
  processLenientCheckComment,
  processPullRequest,
  processScheduledLenientMerges,
  processPullRequestReviewApproval,
  shouldReviewPullRequest
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
    id: number;
    body: string;
    user: {
      login: string;
    };
  };
  repository: GitHubRepository;
};

type IssuePayload = {
  action: string;
  issue: {
    number: number;
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

type ScheduledPayload = {
  repository: GitHubRepository;
};

async function main(): Promise<void> {
  const workflowCallEventName = process.env.GHBOT_EVENT_NAME;
  const payload = workflowCallEventName
    ? buildPayloadFromWorkflowCallEnv(workflowCallEventName)
    : readPayloadFromGitHubEventPath();
  const repository = payload.repository;
  const octokit = await createGitHubClient({
    owner: repository.owner.login,
    repo: repository.name
  });
  const eventName = workflowCallEventName ?? process.env.GITHUB_EVENT_NAME;

  if (!eventName) {
    throw new Error("GITHUB_EVENT_NAME is required.");
  }

  logger.info({ eventName }, "Handling GitHub Actions review event.");

  if (eventName === "pull_request_target") {
    const prPayload = payload as PullRequestPayload;
    const ref = {
      owner: prPayload.repository.owner.login,
      repo: prPayload.repository.name,
      pullNumber: prPayload.pull_request.number
    };

    if (prPayload.action === "closed") {
      await cleanupPullRequestReviewCache(octokit, {
        ...ref,
        repositoryId:
          process.env.GHBOT_REPOSITORY_ID ||
          process.env.GITHUB_REPOSITORY_ID ||
          prPayload.repository.full_name.replace("/", "-")
      });
      return;
    }

    if (["opened", "edited", "reopened"].includes(prPayload.action)) {
      try {
        await processPullRequestTriage(octokit, {
          owner: ref.owner,
          repo: ref.repo,
          pullNumber: ref.pullNumber
        });
      } catch (error) {
        logger.warn(
          { error, ...ref },
          "Pull request triage failed; continuing with code review."
        );
      }
    }

    if (!(await shouldReviewPullRequest(octokit, ref))) {
      await deleteLocalReviewCache(ref.pullNumber);
      logger.info({ ...ref }, "Skipping pull request event outside REVIEW_BRANCHES.");
      return;
    }

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

    await processPullRequest(octokit, ref, "strict");
    return;
  }

  if (eventName === "issues") {
    const issuePayload = payload as IssuePayload;
    if (["opened", "edited", "reopened"].includes(issuePayload.action)) {
      await processIssueTriage(octokit, {
        owner: issuePayload.repository.owner.login,
        repo: issuePayload.repository.name,
        issueNumber: issuePayload.issue.number
      });
    }
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
    await processPullRequestChat(octokit, {
      owner: commentPayload.repository.owner.login,
      repo: commentPayload.repository.name,
      pullNumber: commentPayload.issue.number,
      commentId: commentPayload.comment.id,
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

  if (eventName === "schedule") {
    const scheduledPayload = payload as ScheduledPayload;
    await processScheduledLenientMerges(octokit, {
      owner: scheduledPayload.repository.owner.login,
      repo: scheduledPayload.repository.name
    });
    return;
  }

  logger.warn({ eventName }, "Unhandled GitHub Actions event.");
}

function readPayloadFromGitHubEventPath(): PullRequestPayload | IssuePayload | IssueCommentPayload | PullRequestReviewPayload | ScheduledPayload {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required when workflow_call inputs are not provided.");
  }

  return JSON.parse(fs.readFileSync(eventPath, "utf8")) as PullRequestPayload | IssuePayload | IssueCommentPayload | PullRequestReviewPayload | ScheduledPayload;
}

function buildPayloadFromWorkflowCallEnv(eventName: string): PullRequestPayload | IssuePayload | IssueCommentPayload | PullRequestReviewPayload | ScheduledPayload {
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
        id: Number(process.env.GHBOT_COMMENT_ID) || 0,
        body: process.env.GHBOT_COMMENT_BODY ?? "",
        user: {
          login: process.env.GHBOT_COMMENTER_LOGIN ?? ""
        }
      },
      repository
    };
  }

  if (eventName === "issues") {
    return {
      action,
      issue: {
        number: pullNumber
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

  if (eventName === "schedule") {
    return {
      repository
    };
  }

  throw new Error(`Unsupported GHBOT_EVENT_NAME: ${eventName}`);
}

main().catch((error) => {
  logger.error({ error, botName: config.botName }, "GitHub Actions review run failed.");
  process.exitCode = 1;
});
