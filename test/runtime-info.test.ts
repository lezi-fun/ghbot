import assert from "node:assert/strict";
import test from "node:test";
import {
  detectRuntimeMode,
  formatBotSignature,
  formatRuntimeEnvironmentDetails
} from "../src/github/runtimeInfo.js";

test("environment block renders as a collapsed GitHub details section", () => {
  const body = formatRuntimeEnvironmentDetails("actions");
  assert.match(body, /^<details>\n<summary>⚙️ Runtime environment<\/summary>\n\n/);
  assert.ok(body.endsWith("\n\n</details>"));
});

test("actions mode reports trigger, runner, goose, policy, automation, cache", () => {
  const previousEvent = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = "pull_request_target";
  try {
    const body = formatRuntimeEnvironmentDetails("actions");
    assert.match(body, /- \*\*Mode:\*\* GitHub Actions \(\`pull_request_target\`\)/);
    assert.match(body, /- \*\*Runner:\*\* .+ · Node\.js v/);
    assert.match(body, /- \*\*goose:\*\* model \`[^\`]+\` · thinking effort \`[^\`]+\`/);
    assert.match(body, /- \*\*Review policy:\*\* \`(allow|require_approval|reject)\` · strictness \`(normal|strict)\`/);
    assert.match(body, /- \*\*Automation:\*\* auto-merge (on|off) · conflict repair (on|off)/);
    assert.match(body, /- \*\*Cache:\*\* R2 (enabled|disabled) · repository knowledge (enabled|disabled)/);
  } finally {
    if (previousEvent === undefined) {
      delete process.env.GITHUB_EVENT_NAME;
    } else {
      process.env.GITHUB_EVENT_NAME = previousEvent;
    }
  }
});

test("webhook mode keeps the identical template but swaps in service facts", () => {
  const actionsBody = formatRuntimeEnvironmentDetails("actions");
  const webhookBody = formatRuntimeEnvironmentDetails("webhook");

  assert.match(webhookBody, /^<details>\n<summary>⚙️ Runtime environment<\/summary>/);
  assert.match(webhookBody, /- \*\*Mode:\*\* GitHub App webhook service \(read-only chat\)/);
  assert.match(webhookBody, /- \*\*Host:\*\** .+Node\.js v/);
  assert.match(webhookBody, /- \*\*Chat permission policy:\*\* \`(anyone|read|write)\`/);
  assert.match(webhookBody, /- \*\*Tools:\*\* none · cannot edit files, run commands, or push commits/);
  assert.doesNotMatch(webhookBody, /GitHub Actions|Review policy|Runner:/);

  const summaryOf = (body: string) => body.split("\n").slice(0, 2).join("\n");
  assert.equal(summaryOf(actionsBody), summaryOf(webhookBody));
});

test("environment block never contains credentials", () => {
  for (const mode of ["actions", "webhook", "local"] as const) {
    const body = formatRuntimeEnvironmentDetails(mode);
    assert.doesNotMatch(body, /API_KEY|SECRET_ACCESS_KEY|PRIVATE_KEY|ghp_|sk-/i);
  }
});

test("bot signature is a single attribution footer line", () => {
  assert.equal(
    formatBotSignature(),
    "🤖 Created By [**GHBot**](https://github.com/lezi-fun/ghbot)"
  );
});

test("detection prefers Actions, then the webhook opt-in flag", () => {
  const previousActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    assert.equal(detectRuntimeMode(), "actions");
  } finally {
    if (previousActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = previousActions;
    }
  }
});
