import assert from "node:assert/strict";
import test from "node:test";
import { reviewCacheKeyPrefix } from "../src/review/cache.js";

test("review cache keys are isolated by repository and pull request", () => {
  assert.equal(reviewCacheKeyPrefix("12345", 17), "ghbot-review-12345-pr-17-");
  assert.notEqual(reviewCacheKeyPrefix("12345", 17), reviewCacheKeyPrefix("12345", 18));
  assert.notEqual(reviewCacheKeyPrefix("12345", 17), reviewCacheKeyPrefix("67890", 17));
});
