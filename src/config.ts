import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess((value) => {
  return value === "" ? undefined : value;
}, z.string().optional());

const optionalNonEmptyString = z.preprocess((value) => {
  return value === "" ? undefined : value;
}, z.string().min(1).optional());

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
  githubToken: z.string().min(1),
  openAiApiKey: z.string().min(1),
  openAiBaseUrl: optionalString.pipe(z.string().url().optional()),
  openAiModel: optionalNonEmptyString.default("gpt-4.1"),
  openAiReasoningEffort: z.preprocess((value) => {
    return value === "" ? undefined : value;
  }, z.enum(["default", "low", "medium", "high"]).optional()).transform((value) => {
    return value === "default" ? undefined : value;
  }),
  botName: z.string().min(1).default("ghbot"),
  lenientApprovalUser: z.string().min(1).default("lezi-fun"),
  autoMerge: envBoolean.default(false),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
  requireChecks: envBoolean.default(true),
  maxPatchChars: z.coerce.number().int().positive().default(120_000),
  logLevel: z.string().min(1).default("info")
});

export const config = configSchema.parse({
  port: process.env.PORT,
  githubToken: process.env.GITHUB_TOKEN,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL,
  openAiModel: process.env.OPENAI_MODEL,
  openAiReasoningEffort: process.env.OPENAI_REASONING_EFFORT,
  botName: process.env.BOT_NAME,
  lenientApprovalUser: process.env.LENIENT_APPROVAL_USER,
  autoMerge: process.env.AUTO_MERGE,
  mergeMethod: process.env.MERGE_METHOD,
  requireChecks: process.env.REQUIRE_CHECKS,
  maxPatchChars: process.env.MAX_PATCH_CHARS,
  logLevel: process.env.LOG_LEVEL
});
