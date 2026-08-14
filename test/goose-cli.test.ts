import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGooseAgentDockerArgs,
  extractGooseFinalText
} from "../src/ai/gooseCli.js";

test("goose agent mounts the workflow binary read-only and keeps a visible install fallback", () => {
  const args = buildGooseAgentDockerArgs({
    containerName: "ghbot-agent-test",
    realWorkingDirectory: "/tmp/worktree",
    containerEnv: { OPENAI_API_KEY: "one-run-token" },
    hostGooseBinary: "/tmp/goose/bin/goose",
    prompt: "introduce this pull request"
  });

  assert.ok(args.includes("type=bind,source=/tmp/goose/bin/goose,target=/usr/local/bin/goose,readonly"));
  const bootstrap = args[args.indexOf("-lc") + 1];
  assert.match(bootstrap!, /command -v goose/);
  assert.match(bootstrap!, /cat \/tmp\/goose-install\.log >&2/);
  assert.equal(args.at(-1), "introduce this pull request");
});

test("goose agent can fall back to installing inside the container", () => {
  const args = buildGooseAgentDockerArgs({
    containerName: "ghbot-agent-test",
    realWorkingDirectory: "/tmp/worktree",
    containerEnv: {},
    prompt: "inspect this pull request"
  });

  assert.equal(args.some((arg) => arg.includes("target=/usr/local/bin/goose")), false);
  assert.match(args[args.indexOf("-lc") + 1]!, /GOOSE_VERSION="v1\.46\.0"/);
});

test("goose output extracts the latest assistant text", () => {
  const output = JSON.stringify({
    messages: [
      { role: "user", content: [{ type: "text", text: "review this" }] },
      { role: "assistant", content: [{ type: "text", text: "first response" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "final " },
          { type: "text", text: "response" }
        ]
      }
    ],
    metadata: { status: "completed" }
  });

  assert.equal(extractGooseFinalText(output), "final response");
});

test("goose output strips a surrounding JSON markdown fence", () => {
  const output = JSON.stringify({
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "```json\n{\"ok\":true}\n```" }]
      }
    ]
  });

  assert.equal(extractGooseFinalText(output), '{"ok":true}');
});

test("goose output rejects a response without assistant text", () => {
  assert.throws(
    () => extractGooseFinalText(JSON.stringify({ messages: [{ role: "user", content: [] }] })),
    /final assistant text/
  );
});
