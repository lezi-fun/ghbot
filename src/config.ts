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
  webhookSecret: z.string().min(1),
  githubAppId: z.coerce.number().int().positive(),
  githubPrivateKey: z.string().min(1).transform((value) => value.replace(/\\n/g, "\n")),
  openAiApiKey: z.string().min(1),
  openAiBaseUrl: optionalString.pipe(z.string().url().optional()),
  openAiModel: z.string().min(1).default("gpt-4.1"),
  openAiReasoningEffort: z.enum(["default", "low", "medium", "high"]).optional().transform((value) => {
    return value === "default" ? undefined : value;
  }),
  botName: z.string().min(1).default("ghbot"),
  lenientApprovalUser: z.string().min(1).default("lezi-fun"),
  autoMerge: envBoolean.default(false),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
  requireChecks: envBoolean.default(true),
  maxPatchChars: z.coerce.number().int().positive().default(120_000)
});

export const config = configSchema.parse({
  port: process.env.PORT,
  webhookSecret: process.env.WEBHOOK_SECRET,
  githubAppId: process.env.GITHUB_APP_ID,
  githubPrivateKey: process.env.GITHUB_PRIVATE_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL,
  openAiModel: process.env.OPENAI_MODEL,
  openAiReasoningEffort: process.env.OPENAI_REASONING_EFFORT,
  botName: process.env.BOT_NAME,
  lenientApprovalUser: process.env.LENIENT_APPROVAL_USER,
  autoMerge: process.env.AUTO_MERGE,
  mergeMethod: process.env.MERGE_METHOD,
  requireChecks: process.env.REQUIRE_CHECKS,
  maxPatchChars: process.env.MAX_PATCH_CHARS
});
