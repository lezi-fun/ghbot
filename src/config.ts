import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => {
  return value === "" ? undefined : value;
}, z.string().optional());

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  switch (value.toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      return value;
  }
}, z.boolean());

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  githubToken: optionalString,
  githubAppId: optionalString,
  githubAppPrivateKey: optionalString,
  githubAppInstallationId: z.preprocess((value) => {
    if (value === "" || value === undefined) {
      return undefined;
    }

    return value;
  }, z.coerce.number().int().positive().optional()),
  codexModel: optionalString.default("gpt-5.4"),
  codexReasoningEffort: z.preprocess((value) => {
    return value === "" ? undefined : value;
  }, z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional()),
  codexBaseUrl: optionalString,
  codexApiKey: z.string().min(1),
  botName: z.string().min(1).default("ghbot"),
  autoMerge: envBoolean.default(false),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
  requireChecks: envBoolean.default(true),
  maxPatchChars: z.coerce.number().int().positive().default(120_000),
  logLevel: z.string().min(1).default("info")
});

export const config = configSchema.parse({
  port: process.env.PORT,
  githubToken: process.env.GITHUB_TOKEN,
  githubAppId: process.env.GITHUB_APP_ID,
  githubAppPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  githubAppInstallationId: process.env.GITHUB_APP_INSTALLATION_ID,
  codexModel: process.env.CODEX_MODEL,
  codexReasoningEffort: process.env.CODEX_REASONING_EFFORT,
  codexBaseUrl: process.env.CODEX_BASE_URL,
  codexApiKey: process.env.CODEX_API_KEY,
  botName: process.env.BOT_NAME,
  autoMerge: process.env.AUTO_MERGE,
  mergeMethod: process.env.MERGE_METHOD,
  requireChecks: process.env.REQUIRE_CHECKS,
  maxPatchChars: process.env.MAX_PATCH_CHARS,
  logLevel: process.env.LOG_LEVEL
});
