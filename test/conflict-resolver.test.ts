import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConflictDiffCheckArgs,
  buildValidationRepairPrompt,
  buildConflictPushArgs,
  buildConflictReviewDiffArgs,
  canAutoResolveConflicts,
  describeConflictResolutionFailure,
  diffSnapshotInventories,
  parseDiffCheckWhitespaceDiagnostics,
  parseFinalConfirmation,
  repairDiffCheckContent
} from "../src/review/conflictResolver.js";

const eligible = {
  enabled: true,
  reviewPassed: true,
  mergeable: false,
  mergeableState: "dirty",
  baseRepository: "forumlify/public",
  headRepository: "forumlify/public",
  maintainerCanModify: false,
  expectedHeadSha: "abc",
  currentHeadSha: "abc"
} as const;

test("only a passing conflicted writable current head is eligible", () => {
  assert.equal(canAutoResolveConflicts(eligible), true);
  assert.equal(canAutoResolveConflicts({ ...eligible, reviewPassed: false }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, mergeable: true, mergeableState: "clean" }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, headRepository: "contributor/fork" }), false);
  assert.equal(canAutoResolveConflicts({
    ...eligible,
    headRepository: "contributor/fork",
    maintainerCanModify: true
  }), true);
  assert.equal(canAutoResolveConflicts({ ...eligible, currentHeadSha: "new-head" }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, enabled: false }), false);
});

test("conflict final review scopes the diff to agent-changed files", () => {
  assert.deepEqual(buildConflictReviewDiffArgs(["server.js", "public/js/app.js"]), [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--unified=24",
    "--",
    "server.js",
    "public/js/app.js"
  ]);
  assert.throws(() => buildConflictReviewDiffArgs([]), /at least one agent-changed file/);
  assert.throws(() => buildConflictReviewDiffArgs([".env"]), /protected path/);
  assert.deepEqual(buildConflictDiffCheckArgs(["server.js", "public/js/app.js"]), [
    "diff",
    "--check",
    "--cached",
    "--",
    "server.js",
    "public/js/app.js"
  ]);
  assert.throws(() => buildConflictDiffCheckArgs([]), /at least one agent-changed file/);
});

test("conflict failures are actionable without exposing raw command output", () => {
  assert.match(
    describeConflictResolutionFailure(new Error("fatal: refusing to merge unrelated histories")),
    /did not contain enough Git history/
  );
  assert.match(
    describeConflictResolutionFailure(new Error("remote: Write access to repository not granted")),
    /Allow edits from maintainers/
  );
  assert.match(
    describeConflictResolutionFailure(new Error("Committer identity unknown")),
    /no bot committer identity/
  );
  assert.match(
    describeConflictResolutionFailure(new Error("git diff --check failed after goose correction")),
    /automatic correction pass/
  );
  assert.match(
    describeConflictResolutionFailure(new Error("git diff --check goose correction timed out")),
    /4-minute limit/
  );
  assert.match(
    describeConflictResolutionFailure(new Error("rejected: stale info")),
    /Run \/conflict again/
  );
  assert.doesNotMatch(
    describeConflictResolutionFailure(new Error("secret-token-value")),
    /secret-token-value/
  );
});

test("diff-check whitespace diagnostics are repaired without another agent run", () => {
  const diagnostics = parseDiffCheckWhitespaceDiagnostics([
    "src/app.js:2: trailing whitespace.",
    "+const value = true;   ",
    "src/app.js:3: space before tab in indent.",
    "+ \treturn value;",
    "src/app.js:4: leftover conflict marker."
  ].join("\n"));
  assert.deepEqual(diagnostics, [
    { file: "src/app.js", line: 2, kind: "trailing-whitespace" },
    { file: "src/app.js", line: 3, kind: "space-before-tab" }
  ]);
  assert.equal(
    repairDiffCheckContent("function check() {\nconst value = true;   \n \treturn value;\n}\n", diagnostics),
    "function check() {\nconst value = true;\n\treturn value;\n}\n"
  );
});

test("external fork conflict pushes use a head-SHA force lease", () => {
  assert.deepEqual(buildConflictPushArgs({
    baseRepository: "forumlify/public",
    headRepository: "contributor/forumlify",
    headBranch: "fix/conflicts",
    expectedHeadSha: "a".repeat(40)
  }), [
    "push",
    `--force-with-lease=refs/heads/fix/conflicts:${"a".repeat(40)}`,
    "https://github.com/contributor/forumlify.git",
    "HEAD:refs/heads/fix/conflicts"
  ]);
  assert.deepEqual(buildConflictPushArgs({
    baseRepository: "forumlify/public",
    headRepository: "forumlify/public",
    headBranch: "fix/conflicts",
    expectedHeadSha: "b".repeat(40)
  }), ["push", "origin", "HEAD:refs/heads/fix/conflicts"]);
  assert.throws(() => buildConflictPushArgs({
    baseRepository: "forumlify/public",
    headRepository: "contributor/forumlify",
    headBranch: "bad:branch",
    expectedHeadSha: "c".repeat(40)
  }), /Unsafe PR head branch/);
});

test("snapshot inventory detects related file additions, changes, and deletions", () => {
  const before = new Map([
    ["conflicted.ts", { hash: "old", size: 10 }],
    ["caller.ts", { hash: "same", size: 20 }],
    ["removed.test.ts", { hash: "remove", size: 30 }]
  ]);
  const after = new Map([
    ["conflicted.ts", { hash: "resolved", size: 12 }],
    ["caller.ts", { hash: "same", size: 20 }],
    ["compatibility.test.ts", { hash: "new", size: 40 }]
  ]);
  assert.deepEqual(
    diffSnapshotInventories(before, after),
    ["compatibility.test.ts", "conflicted.ts", "removed.test.ts"]
  );
});

test("validation repair prompt requires the exact command without allowing test weakening", () => {
  const prompt = buildValidationRepairPrompt({
    testCommand: "npm ci && npm test",
    output: "Exit code: 1\nThe handler and its test disagree."
  });
  assert.match(prompt, /npm ci && npm test/);
  assert.match(prompt, /handler and its test disagree/);
  assert.match(prompt, /do not .*weaken\/delete tests/i);
  assert.match(prompt, /related validation failures/i);
});

test("final confirmation parser accepts a JSON object surrounded by prose", () => {
  assert.deepEqual(
    parseFinalConfirmation('Result:\n{"safeToCommit":true,"summary":"validated","concerns":[]}\nDone.'),
    { safeToCommit: true, summary: "validated", concerns: [] }
  );
  assert.throws(
    () => parseFinalConfirmation("safe to commit"),
    /required JSON object/
  );
});
