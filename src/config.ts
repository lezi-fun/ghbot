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

function csvListWithDefault(defaultValue: string[]) {
  return z.preprocess((value) => {
    if (typeof value !== "string") {
      return value ?? defaultValue;
    }

    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }, z.array(z.string()));
}

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
  openCodeModel: optionalString.default("gpt-5.4"),
  openCodeReasoningEffort: z.preprocess((value) => {
    return value === "" ? undefined : value;
  }, z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional()),
  openCodeBaseUrl: optionalString,
  openCodeApiKey: optionalString,
  reviewPolicy: z.enum(["allow", "require_approval", "reject"]).default("require_approval"),
  reviewInstructions: optionalString,
  reviewBranches: csvListWithDefault([]),
  triageEnabled: envBoolean.default(true),
  triageLabels: csvListWithDefault(["bug", "enhancement", "documentation", "question", "maintenance"])
    .refine((labels) => labels.length > 0, "TRIAGE_LABELS must contain at least one label."),
  triageDuplicateLabel: z.string().min(1).default("duplicate"),
  triageCandidateLimit: z.coerce.number().int().positive().max(100).default(50),
  triageInstructions: optionalString,
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
  githubAppId: process.env.GH_APP_ID ?? process.env.GITHUB_APP_ID,
  githubAppPrivateKey: process.env.GH_APP_PRIVATE_KEY ?? process.env.GITHUB_APP_PRIVATE_KEY,
  githubAppInstallationId: process.env.GH_APP_INSTALLATION_ID ?? process.env.GITHUB_APP_INSTALLATION_ID,
  openCodeModel: process.env.OPENCODE_MODEL,
  openCodeReasoningEffort: process.env.OPENCODE_REASONING_EFFORT,
  openCodeBaseUrl: process.env.OPENCODE_BASE_URL,
  openCodeApiKey: process.env.OPENCODE_API_KEY,
  reviewPolicy: process.env.REVIEW_POLICY,
  reviewInstructions: process.env.REVIEW_INSTRUCTIONS,
  reviewBranches: process.env.REVIEW_BRANCHES,
  triageEnabled: process.env.TRIAGE_ENABLED,
  triageLabels: process.env.TRIAGE_LABELS,
  triageDuplicateLabel: process.env.TRIAGE_DUPLICATE_LABEL,
  triageCandidateLimit: process.env.TRIAGE_CANDIDATE_LIMIT,
  triageInstructions: process.env.TRIAGE_INSTRUCTIONS,
  botName: process.env.BOT_NAME,
  autoMerge: process.env.AUTO_MERGE,
  mergeMethod: process.env.MERGE_METHOD,
  requireChecks: process.env.REQUIRE_CHECKS,
  maxPatchChars: process.env.MAX_PATCH_CHARS,
  logLevel: process.env.LOG_LEVEL
});
