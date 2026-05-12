import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  webhookSecret: z.string().min(1),
  githubAppId: z.coerce.number().int().positive(),
  githubPrivateKey: z.string().min(1).transform((value) => value.replace(/\\n/g, "\n")),
  openAiApiKey: z.string().min(1),
  openAiModel: z.string().min(1).default("gpt-4.1"),
  botName: z.string().min(1).default("ghbot"),
  autoMerge: z.coerce.boolean().default(false),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
  requireChecks: z.coerce.boolean().default(true),
  maxPatchChars: z.coerce.number().int().positive().default(120_000)
});

export const config = configSchema.parse({
  port: process.env.PORT,
  webhookSecret: process.env.WEBHOOK_SECRET,
  githubAppId: process.env.GITHUB_APP_ID,
  githubPrivateKey: process.env.GITHUB_PRIVATE_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL,
  botName: process.env.BOT_NAME,
  autoMerge: process.env.AUTO_MERGE,
  mergeMethod: process.env.MERGE_METHOD,
  requireChecks: process.env.REQUIRE_CHECKS,
  maxPatchChars: process.env.MAX_PATCH_CHARS
});
