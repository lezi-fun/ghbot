import assert from "node:assert/strict";
import test from "node:test";
import { formatBotDisplayName } from "../src/github/botIdentity.js";

test("GitHub App logins become readable comment identities with a goose fallback", () => {
  assert.equal(formatBotDisplayName("forumlify[bot]"), "forumlify bot");
  assert.equal(formatBotDisplayName("@forumlify[bot]"), "forumlify bot");
  assert.equal(formatBotDisplayName("forumlify"), "forumlify");
  assert.equal(formatBotDisplayName("ghbot"), "goose");
  assert.equal(formatBotDisplayName(undefined), "goose");
});
