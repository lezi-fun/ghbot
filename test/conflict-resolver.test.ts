import assert from "node:assert/strict";
import test from "node:test";
import {
  canAutoResolveConflicts,
  diffSnapshotInventories
} from "../src/review/conflictResolver.js";

const eligible = {
  enabled: true,
  reviewPassed: true,
  mergeable: false,
  mergeableState: "dirty",
  baseRepository: "forumlify/public",
  headRepository: "forumlify/public",
  expectedHeadSha: "abc",
  currentHeadSha: "abc"
} as const;

test("only a passing conflicted same-repository current head is eligible", () => {
  assert.equal(canAutoResolveConflicts(eligible), true);
  assert.equal(canAutoResolveConflicts({ ...eligible, reviewPassed: false }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, mergeable: true, mergeableState: "clean" }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, headRepository: "contributor/fork" }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, currentHeadSha: "new-head" }), false);
  assert.equal(canAutoResolveConflicts({ ...eligible, enabled: false }), false);
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
