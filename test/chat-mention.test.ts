import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  containsBotMention,
  createRepositorySnapshot,
  isTrustedChatPermission
} from "../src/chat/processor.js";

test("PR chat recognizes @bot and the configured bot login", () => {
  assert.equal(containsBotMention("@bot can this merge?", "github-actions[bot]"), true);
  assert.equal(containsBotMention("Could @github-actions explain this?", "github-actions[bot]"), true);
  assert.equal(containsBotMention("Ping @github-actions[bot]", "github-actions[bot]"), true);
});

test("PR chat does not trigger on partial usernames or ordinary text", () => {
  assert.equal(containsBotMention("@botany please check", "github-actions[bot]"), false);
  assert.equal(containsBotMention("This mentions bot without an at sign", "github-actions[bot]"), false);
});

test("only collaborators with write access can invoke the full repository agent", () => {
  assert.equal(isTrustedChatPermission("admin"), true);
  assert.equal(isTrustedChatPermission("maintain"), true);
  assert.equal(isTrustedChatPermission("write"), true);
  assert.equal(isTrustedChatPermission("triage"), false);
  assert.equal(isTrustedChatPermission("read"), false);
  assert.equal(isTrustedChatPermission(null), false);
});

test("PR chat snapshot excludes repository instructions, secrets, git data, and symlinks", async () => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "ghbot-chat-source-"));
  let snapshot: string | undefined;

  try {
    await fs.mkdir(path.join(source, ".git"));
    await fs.mkdir(path.join(source, ".opencode"));
    await fs.mkdir(path.join(source, ".agents"));
    await fs.mkdir(path.join(source, "src"));
    await Promise.all([
      fs.writeFile(path.join(source, ".git", "config"), "credential data"),
      fs.writeFile(path.join(source, ".opencode", "plugin.ts"), "untrusted plugin"),
      fs.writeFile(path.join(source, ".agents", "SKILL.md"), "untrusted skill"),
      fs.writeFile(path.join(source, ".env"), "TOKEN=secret"),
      fs.writeFile(path.join(source, ".env.local"), "TOKEN=local-secret"),
      fs.writeFile(path.join(source, "AGENTS.md"), "untrusted instructions"),
      fs.writeFile(path.join(source, "opencode.json"), "{}"),
      fs.writeFile(path.join(source, "src", "index.ts"), "export const safe = true;\n"),
      fs.symlink(path.join(source, ".env"), path.join(source, "secret-link"))
    ]);

    snapshot = await createRepositorySnapshot(source);
    assert.equal(await fs.readFile(path.join(snapshot, "src", "index.ts"), "utf8"), "export const safe = true;\n");
    for (const excluded of [
      ".git",
      ".opencode",
      ".agents",
      ".env",
      ".env.local",
      "AGENTS.md",
      "opencode.json",
      "secret-link"
    ]) {
      await assert.rejects(fs.lstat(path.join(snapshot, excluded)), { code: "ENOENT" });
    }
  } finally {
    await fs.rm(source, { recursive: true, force: true });
    if (snapshot) {
      await fs.rm(snapshot, { recursive: true, force: true });
    }
  }
});
