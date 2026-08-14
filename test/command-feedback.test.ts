import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "@octokit/rest";
import {
  formatPermissionDeniedMessage,
  postPermissionDeniedComment
} from "../src/github/commandFeedback.js";

test("permission denied feedback is friendly and actionable", () => {
  const body = formatPermissionDeniedMessage("contributor", "/recheck");
  assert.match(body, /^Hi! @contributor, we're sorry/);
  assert.match(body, /permission to run `\/recheck`/);
  assert.match(body, /write.*maintain.*admin/i);
  assert.match(body, /ask a repository maintainer/i);
});

test("permission denied feedback is deduplicated by source comment", async () => {
  const created: string[] = [];
  const comments: Array<{ body: string }> = [];
  const octokit = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: async () => ({ data: comments }),
        createComment: async ({ body }: { body: string }) => {
          created.push(body);
          comments.push({ body });
          return { data: { id: 1, body } };
        }
      }
    }
  } as unknown as Octokit;

  const params = {
    owner: "forumlify",
    repo: "public",
    pullNumber: 17,
    sourceCommentId: 123,
    commenterLogin: "contributor",
    command: "/conflict" as const
  };
  await postPermissionDeniedComment(octokit, params);
  await postPermissionDeniedComment(octokit, params);

  assert.equal(created.length, 1);
  assert.match(created[0]!, /comment=123/);
  assert.match(created[0]!, /permission to run `\/conflict`/);
});
