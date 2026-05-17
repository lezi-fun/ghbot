import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import { logger } from "../logger.js";

export async function createGitHubClient(params?: {
  owner: string;
  repo: string;
}): Promise<Octokit> {
  if (config.githubAppId && config.githubAppPrivateKey) {
    try {
      const privateKey = normalizePrivateKey(config.githubAppPrivateKey);
      const auth = createAppAuth({
        appId: config.githubAppId,
        privateKey
      });

      const installationId =
        config.githubAppInstallationId ??
        (params ? await resolveInstallationId(auth, params.owner, params.repo) : undefined);

      if (!installationId) {
        throw new Error("GitHub App installation id is not configured and could not be resolved from the repository.");
      }

      const installationAuthentication = await auth({
        type: "installation",
        installationId
      });

      return new Octokit({
        auth: installationAuthentication.token
      });
    } catch (error) {
      logger.warn(
        {
          error,
          githubAppId: config.githubAppId,
          githubAppInstallationId: config.githubAppInstallationId,
          owner: params?.owner,
          repo: params?.repo
        },
        "Failed to create GitHub App installation client; falling back to GITHUB_TOKEN."
      );
    }
  }

  return new Octokit({
    auth: config.githubToken
  });
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

async function resolveInstallationId(
  auth: ReturnType<typeof createAppAuth>,
  owner: string,
  repo: string
): Promise<number | undefined> {
  const appAuthentication = await auth({ type: "app" });
  const appOctokit = new Octokit({
    auth: appAuthentication.token
  });

  const { data } = await appOctokit.request("GET /repos/{owner}/{repo}/installation", {
    owner,
    repo
  });

  return data.id;
}
