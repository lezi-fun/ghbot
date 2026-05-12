import { Webhooks } from "@octokit/webhooks";
import { config } from "../config.js";
import { getInstallationOctokit } from "./app.js";
import { logger } from "../logger.js";
import { isLenientCheckAction, processLenientCheckRunAction, processPullRequest } from "../review/processor.js";

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

  webhooks.onError((error) => {
    logger.error({ error }, "Webhook handler failed.");
  });

  return webhooks;
}
