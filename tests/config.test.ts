import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const baseEnv = {
  ...process.env,
  WEBHOOK_SECRET: "webhook-secret",
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "private-key",
  OPENAI_API_KEY: "openai-key"
};

function readConfig(extraEnv: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--eval",
      "import { config } from './src/config.ts'; console.log(JSON.stringify({ autoMerge: config.autoMerge, requireChecks: config.requireChecks, openAiBaseUrl: config.openAiBaseUrl }));"
    ],
    {
      cwd: process.cwd(),
      env: {
        ...baseEnv,
        ...extraEnv
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as {
    autoMerge: boolean;
    requireChecks: boolean;
    openAiBaseUrl?: string;
  };
}

assert.deepEqual(readConfig({ AUTO_MERGE: "false", REQUIRE_CHECKS: "false" }), {
  autoMerge: false,
  requireChecks: false
});

assert.deepEqual(readConfig({ AUTO_MERGE: "true", REQUIRE_CHECKS: "true" }), {
  autoMerge: true,
  requireChecks: true
});

assert.deepEqual(readConfig({ AUTO_MERGE: "0", REQUIRE_CHECKS: "1", OPENAI_BASE_URL: "" }), {
  autoMerge: false,
  requireChecks: true
});

console.log("config env parsing ok");
