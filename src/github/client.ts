import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

export function createGitHubClient(): Octokit {
  return new Octokit({
    auth: config.githubToken
  });
}
