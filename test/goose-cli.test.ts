import assert from "node:assert/strict";
import test from "node:test";
import { extractGooseFinalText } from "../src/ai/gooseCli.js";

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
