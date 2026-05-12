import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  const auth = createAppAuth({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    installationId
  });

  const installationAuthentication = await auth({ type: "installation" });

  return new Octokit({
    auth: installationAuthentication.token
  });
}
