import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("conflict repair checks out fork heads without persisting GitHub credentials", async () => {
  const workflow = await fs.readFile(".github/workflows/review-reusable.yml", "utf8");
  const caller = await fs.readFile(".github/workflows/review.yml", "utf8");
  assert.match(workflow, /inputs\.auto_resolve_conflicts == 'true'/);
  assert.doesNotMatch(workflow, /pull_head_repository == format\('\{0\}\/\{1\}'/);
  assert.doesNotMatch(workflow, /allow-unsafe-pr-checkout:\s*true/);
  assert.match(workflow, /GHBOT_GOOSE_BINARY:\s*\$\{\{ runner\.temp \}\}\/goose\/bin\/goose/);
  assert.match(caller, /pull_head_repository:\s*\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| '' \}\}/);
});
