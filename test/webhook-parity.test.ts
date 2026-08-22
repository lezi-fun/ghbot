import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isUninitializedRepositoryKnowledge,
  loadRepositoryKnowledge
} from "../src/repository/knowledge.js";
import {
  buildWebhookChatPrompt,
  loadWebhookRepositoryKnowledge,
  matchWebhookReadonlyCommand,
  parseWebhookTriageEvent,
  type WebhookContext,
  type WebhookMention
} from "../src/webhook/processor.js";

function triagePayload(extra: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 42 },
    repository: { id: 7, name: "public", owner: { login: "forumlify" } },
    ...extra
  };
}

test("triage events are parsed for issues and pull requests on open/edit/reopen", () => {
  const issue = parseWebhookTriageEvent("issues", triagePayload({ issue: { number: 5 } }));
  assert.deepEqual(issue, {
    action: "opened",
    installationId: 42,
    owner: "forumlify",
    repo: "public",
    kind: "issue",
    number: 5
  });

  const pull = parseWebhookTriageEvent("pull_request", triagePayload({
    action: "reopened",
    pull_request: { number: 9 }
  }));
  assert.equal(pull?.kind, "pull_request");
  assert.equal(pull?.number, 9);
});

test("triage parsing rejects other events, pushes, PR issues, and missing installation", () => {
  assert.equal(parseWebhookTriageEvent("issues", triagePayload({ action: "synchronize", issue: { number: 5 } })), null);
  assert.equal(parseWebhookTriageEvent("pull_request", triagePayload({ action: "closed", pull_request: { number: 9 } })), null);
  assert.equal(parseWebhookTriageEvent("issues", triagePayload({ issue: { number: 5, pull_request: { url: "x" } } })), null);
  assert.equal(parseWebhookTriageEvent("issues", triagePayload({ installation: undefined, issue: { number: 5 } })), null);
  assert.equal(parseWebhookTriageEvent("issue_comment", triagePayload()), null);
});

test("readonly command matching keeps Action-mode exact semantics", () => {
  assert.equal(matchWebhookReadonlyCommand("/recheck"), "/recheck");
  assert.equal(matchWebhookReadonlyCommand("  /conflict \n"), "/conflict");
  assert.equal(matchWebhookReadonlyCommand("/recheck please"), null);
  assert.equal(matchWebhookReadonlyCommand("@bot /recheck"), null);
  assert.equal(matchWebhookReadonlyCommand(""), null);
});

const mention: WebhookMention = {
  eventName: "issue_comment",
  action: "created",
  deliveryId: "d-1",
  installationId: 42,
  owner: "forumlify",
  repo: "public",
  issueNumber: 3,
  targetKind: "pull_request",
  sourceCommentId: 11,
  commentBody: "@bot what does this PR change?",
  commenterLogin: "octocat",
  replyMode: "conversation"
};

const baseContext: WebhookContext = {
  repository: { fullName: "forumlify/public", description: null, defaultBranch: "main", readme: "" },
  item: { number: 3, title: "t", body: "", state: "open", url: "", kind: "pull_request", author: null },
  discussion: []
};

test("webhook chat prompt embeds host-curated knowledge when available", () => {
  const withKnowledge = buildWebhookChatPrompt(mention, {
    ...baseContext,
    knowledge: "# ghbot repository knowledge\nTests run with npm test."
  });
  assert.match(withKnowledge, /Verified repository knowledge curated by the host process/);
  assert.match(withKnowledge, /npm test\./);
  assert.match(withKnowledge, /current repository evidence always takes precedence over cached knowledge/);

  const withoutKnowledge = buildWebhookChatPrompt(mention, baseContext);
  assert.doesNotMatch(withoutKnowledge, /Verified repository knowledge/);
});

test("uninitialized knowledge scaffold is detected and never injected", async () => {
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ghbot-knowledge-"));
  try {
    const scaffold = await loadRepositoryKnowledge(runtimeDirectory);
    assert.equal(isUninitializedRepositoryKnowledge(scaffold), true);
    assert.equal(isUninitializedRepositoryKnowledge("# ghbot repository knowledge\n\nTests: npm test.\n"), false);
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("webhook knowledge loader degrades to undefined without R2 or repository id", async () => {
  assert.equal(await loadWebhookRepositoryKnowledge({ owner: "forumlify", repo: "public" }), undefined);
  assert.equal(await loadWebhookRepositoryKnowledge({ repositoryId: 7, owner: "forumlify", repo: "public" }), undefined);
});

test("webhook chat prompt stays read-only in both variants", () => {
  for (const context of [baseContext, { ...baseContext, knowledge: "k" }]) {
    const prompt = buildWebhookChatPrompt(mention, context);
    assert.match(prompt, /no repository tools/);
    assert.match(prompt, /Do not claim that you ran commands/);
  }
});
