import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { logger } from "../logger.js";

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    installationId
  });

  try {
    logger.info({ installationId, appId: config.githubAppId }, "Requesting GitHub installation token.");
    const installationAuthentication = await auth({ type: "installation" });

    logger.info(
      {
        installationId,
        appId: config.githubAppId,
        expiresAt: installationAuthentication.expiresAt
      },
      "GitHub installation token created."
    );

    return new Octokit({
      auth: installationAuthentication.token
    });
  } catch (error) {
    logger.error({ err: error, installationId, appId: config.githubAppId }, "Failed to create GitHub installation token.");
    throw error;
  }
}
