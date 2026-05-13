import { Webhooks } from "@octokit/webhooks";
import { config } from "../config.js";
import { getInstallationOctokit } from "./app.js";
import { logger } from "../logger.js";
import {
  isLenientCheckAction,
  processLenientCheckRunAction,
  processPullRequest,
  processPullRequestReviewApproval
} from "../review/processor.js";

export function createGitHubWebhooks(): Webhooks {
  const webhooks = new Webhooks({
    secret: config.webhookSecret
  });

  webhooks.on(
    ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened", "pull_request.ready_for_review"],
    async ({ payload }) => {
      const installationId = payload.installation?.id;
      if (!installationId) {
        logger.warn({ repository: payload.repository.full_name, pullNumber: payload.pull_request.number }, "Skipping PR without installation id.");
        return;
      }

      logger.info(
        {
          repository: payload.repository.full_name,
          pullNumber: payload.pull_request.number,
          action: payload.action,
          installationId
        },
        "Handling pull request webhook."
      );
      const octokit = await getInstallationOctokit(installationId);
      await processPullRequest(octokit, {
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pullNumber: payload.pull_request.number
      });
    }
  );

  webhooks.on("check_run.requested_action", async ({ payload }) => {
    const actionIdentifier = payload.requested_action?.identifier;
    if (!actionIdentifier || !isLenientCheckAction(actionIdentifier)) {
      return;
    }

    const installationId = payload.installation?.id;
    if (!installationId) {
      logger.warn({ repository: payload.repository.full_name, checkRun: payload.check_run.id }, "Skipping check action without installation id.");
      return;
    }

    const octokit = await getInstallationOctokit(installationId);
    await processLenientCheckRunAction(octokit, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      headSha: payload.check_run.head_sha
    });
  });

  webhooks.on("pull_request_review.submitted", async ({ payload }) => {
    const reviewerLogin = payload.review.user?.login;
    if (!reviewerLogin) {
      logger.warn({ repository: payload.repository.full_name, pullNumber: payload.pull_request.number }, "Skipping review without reviewer login.");
      return;
    }

    const installationId = payload.installation?.id;
    if (!installationId) {
      logger.warn({ repository: payload.repository.full_name, pullNumber: payload.pull_request.number }, "Skipping review without installation id.");
      return;
    }

    const octokit = await getInstallationOctokit(installationId);
    await processPullRequestReviewApproval(octokit, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      pullNumber: payload.pull_request.number,
      reviewerLogin,
      state: payload.review.state,
      commitId: payload.review.commit_id
    });
  });

  webhooks.onError((error) => {
    logger.error({ err: error, error: getNestedWebhookError(error) }, "Webhook handler failed.");
  });

  return webhooks;
}

function getNestedWebhookError(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("error" in error)) {
    return undefined;
  }

  return (error as { error?: unknown }).error;
}
