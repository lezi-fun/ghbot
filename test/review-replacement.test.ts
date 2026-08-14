import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "@octokit/rest";
import {
  formatSupersededReviewBody,
  supersedePreviousBotReviews
} from "../src/review/processor.js";

const marker = "<!-- ghbot-review:v1 mode=normal outcome=block requires-admin=false review=1 change=1 -->";

test("superseded review body removes old findings and points to the current commit", () => {
  const body = formatSupersededReviewBody({
    originalMarker: marker,
    oldCommitId: "a".repeat(40),
    currentCommitId: "b".repeat(40)
  });
  assert.match(body, /Superseded automated review/);
  assert.match(body, /`aaaaaaaaaaaa`/);
  assert.match(body, /`bbbbbbbbbbbb`/);
  assert.doesNotMatch(body, /Required changes:/);
  assert.match(body, /inline `review` and `change` comments were removed/);
});

test("old bot reviews are cleaned only while the current review is preserved", async () => {
  const deletedComments: number[] = [];
  const updatedReviews: Array<{ review_id: number; body: string }> = [];
  const dismissedReviews: number[] = [];
  const reviews = [
    { id: 10, user: { type: "Bot" }, body: marker, state: "CHANGES_REQUESTED", commit_id: "a".repeat(40) },
    { id: 20, user: { type: "Bot" }, body: marker, state: "APPROVED", commit_id: "b".repeat(40) },
    { id: 30, user: { type: "User" }, body: marker, state: "COMMENTED", commit_id: "c".repeat(40) },
    { id: 40, user: { type: "Bot" }, body: marker, state: "DISMISSED", commit_id: "d".repeat(40) },
    { id: 50, user: { type: "Bot" }, body: "Unrelated automation", state: "COMMENTED", commit_id: "e".repeat(40) },
    { id: 60, user: { type: "Bot" }, body: marker, state: "CHANGES_REQUESTED", commit_id: "b".repeat(40) }
  ];
  const octokit = {
    paginate: async (method: unknown, params: { review_id?: number }) => {
      if (method === pulls.listReviews) {
        return reviews;
      }
      if (params.review_id === 10) {
        return [{ id: 101 }, { id: 102 }];
      }
      if (params.review_id === 40) {
        return [{ id: 401 }];
      }
      if (params.review_id === 60) {
        return [{ id: 601 }];
      }
      return [];
    },
    rest: {
      pulls: {
        listReviews: async () => ({ data: reviews }),
        listCommentsForReview: async () => ({ data: [] }),
        deleteReviewComment: async ({ comment_id }: { comment_id: number }) => {
          deletedComments.push(comment_id);
          return { data: undefined };
        },
        updateReview: async ({ review_id, body }: { review_id: number; body: string }) => {
          updatedReviews.push({ review_id, body });
          return { data: {} };
        },
        dismissReview: async ({ review_id }: { review_id: number }) => {
          dismissedReviews.push(review_id);
          return { data: {} };
        }
      }
    }
  } as unknown as Octokit;
  const pulls = (octokit.rest as unknown as { pulls: { listReviews: unknown } }).pulls;

  await supersedePreviousBotReviews(octokit, {
    owner: "forumlify",
    repo: "public",
    pullNumber: 17,
    currentReviewId: 20,
    currentCommitId: "b".repeat(40)
  });

  assert.deepEqual(deletedComments, [101, 102, 401, 601]);
  assert.deepEqual(updatedReviews.map((item) => item.review_id), [10, 40, 60]);
  assert.match(updatedReviews[0]!.body, /bbbbbbbbbbbb/);
  assert.deepEqual(dismissedReviews, [10, 60]);
  assert.ok(pulls.listReviews);
});
