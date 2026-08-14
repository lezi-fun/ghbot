import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("pull_request_target checks out a PR worktree only for same-repository heads", async () => {
  const workflow = await fs.readFile(".github/workflows/review-reusable.yml", "utf8");
  const caller = await fs.readFile(".github/workflows/review.yml", "utf8");
  assert.match(workflow, /pull_head_repository == format\('\{0\}\/\{1\}'/);
  assert.doesNotMatch(workflow, /allow-unsafe-pr-checkout:\s*true/);
  assert.match(caller, /pull_head_repository:\s*\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| '' \}\}/);
});
