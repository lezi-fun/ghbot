import { config } from "../config.js";

export type RuntimeMode = "actions" | "webhook" | "local";

/**
 * Where is this ghbot process running? Action-mode workflow runs set
 * GITHUB_ACTIONS; the optional webhook service opts in via WEBHOOK_ENABLED.
 * Anything else is a local simulation.
 */
export function detectRuntimeMode(): RuntimeMode {
  if (process.env.GITHUB_ACTIONS === "true") {
    return "actions";
  }
  return config.webhookEnabled ? "webhook" : "local";
}

function gooseVersion(): string | undefined {
  const version = process.env.GOOSE_VERSION?.trim();
  return version ? version : undefined;
}

function hostLine(): string {
  const os = process.env.RUNNER_OS ?? process.platform;
  return `${os} / ${process.arch} · Node.js ${process.version}`;
}

function eventLine(): string | undefined {
  const eventName = process.env.GHBOT_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME;
  const eventAction = process.env.GHBOT_EVENT_ACTION;
  if (!eventName) {
    return undefined;
  }
  return eventAction ? `\`${eventName}\` / ${eventAction}` : `\`${eventName}\``;
}

function r2CacheEnabled(): boolean {
  return Boolean(
    config.r2Endpoint &&
    config.r2BucketName &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey
  );
}

/**
 * Collapsed <details> block appended to comments in which the bot announces or
 * performs an operation. The visual template is identical for every runtime
 * mode (Actions, webhook service, local); only the fact lines differ. It must
 * never contain credentials: only non-secret configuration and host facts.
 */
export function formatRuntimeEnvironmentDetails(mode: RuntimeMode = detectRuntimeMode()): string {
  const lines: string[] = [];

  if (mode === "webhook") {
    lines.push(
      "- **Mode:** GitHub App webhook service (read-only chat)",
      `- **Host:** ${hostLine()}`
    );
  } else {
    const event = eventLine();
    const modeLabel = mode === "actions"
      ? event ? `GitHub Actions (${event})` : "GitHub Actions"
      : event ? `local run (${event})` : "local run";
    lines.push(
      `- **Mode:** ${modeLabel}`,
      `- **Runner:** ${hostLine()}`
    );
  }

  const gooseParts = [
    gooseVersion(),
    `model \`${config.gooseModel ?? "unknown"}\``,
    `thinking effort \`${config.gooseThinkingEffort ?? "high"}\``
  ].filter(Boolean);
  lines.push(`- **goose:** ${gooseParts.join(" · ")}`);

  if (mode === "webhook") {
    lines.push(
      `- **Chat permission policy:** \`${config.webhookChatPermission}\``,
      "- **Tools:** none · cannot edit files, run commands, or push commits"
    );
  } else {
    lines.push(
      `- **Review policy:** \`${config.reviewPolicy}\` · strictness \`${config.reviewStrictness}\` · max patch ${config.maxPatchChars} chars`,
      `- **Automation:** auto-merge ${config.autoMerge ? "on" : "off"} · conflict repair ${config.autoResolveConflicts ? "on" : "off"}`,
      `- **Cache:** R2 ${r2CacheEnabled() ? "enabled" : "disabled"} · repository knowledge ${config.repositoryKnowledgeEnabled ? "enabled" : "disabled"}`
    );
  }

  return [
    "<details>",
    "<summary>⚙️ Runtime environment</summary>",
    "",
    ...lines,
    "",
    "</details>"
  ].join("\n");
}

/**
 * Attribution footer appended after the environment block on the comments in
 * which the bot announces or performs an operation.
 */
export function formatBotSignature(): string {
  return "🤖 Created By [**GHBot**](https://github.com/lezi-fun/ghbot)";
}
