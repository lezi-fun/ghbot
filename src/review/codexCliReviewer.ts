import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import type { PullRequestFile, ReviewDecision, ReviewMode } from "../types.js";

const execFileAsync = promisify(execFile);

const reviewDecisionSchema = z.object({
  safeToMerge: z.boolean(),
  shouldClosePullRequest: z.boolean(),
  closeReason: z.string(),
  summary: z.string(),
  findings: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      severity: z.enum(["blocking", "suggestion"]),
      title: z.string(),
      body: z.string()
    })
  )
});

export class CodexCliReviewer {
  async review(input: {
    title: string;
    body: string | null;
    files: PullRequestFile[];
    mode: ReviewMode;
  }): Promise<ReviewDecision> {
    return withRetry("codex.exec.review", async () => {
      const tempRoot = path.join(process.cwd(), ".ghbot-tmp");
      await fs.mkdir(tempRoot, { recursive: true });
      const tempDir = await fs.mkdtemp(path.join(tempRoot, "codex-"));
      const schemaPath = path.join(tempDir, "review-schema.json");
      const outputPath = path.join(tempDir, "review-output.json");
      const codexHome = path.join(tempDir, "codex-home");

      try {
        await fs.mkdir(codexHome, { recursive: true });
        await fs.writeFile(path.join(codexHome, "config.toml"), buildCodexConfig(), "utf8");
        await fs.writeFile(schemaPath, JSON.stringify(buildSchema(), null, 2), "utf8");

        const prompt = buildPrompt(input);
        const args = [
          "exec",
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "-C",
          process.cwd(),
          "--ephemeral"
        ];

        args.push(prompt);

        logger.info(
          {
            mode: input.mode,
            fileCount: input.files.length,
            model: config.codexModel,
            reasoningEffort: config.codexReasoningEffort,
            baseUrl: normalizeBaseUrl(config.codexBaseUrl)
          },
          "Running Codex CLI review."
        );

        try {
          await execFileAsync("codex", args, {
            cwd: process.cwd(),
            env: {
              ...process.env,
              CODEX_HOME: codexHome,
              CODEX_API_KEY: config.codexApiKey
            },
            maxBuffer: 10 * 1024 * 1024
          });
        } catch (error) {
          logger.error(
            {
              error,
              mode: input.mode,
              fileCount: input.files.length,
              model: config.codexModel,
              reasoningEffort: config.codexReasoningEffort,
              baseUrl: normalizeBaseUrl(config.codexBaseUrl)
            },
            "Codex CLI review command failed."
          );
          throw error;
        }

        const raw = await fs.readFile(outputPath, "utf8");
        return reviewDecisionSchema.parse(JSON.parse(raw));
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  }
}

function buildCodexConfig(): string {
  const lines = [
    `model = ${toTomlString(config.codexModel)}`,
    'model_provider = "ghbot"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"'
  ];

  if (config.codexReasoningEffort) {
    lines.push(`model_reasoning_effort = ${toTomlString(config.codexReasoningEffort)}`);
  }

  lines.push("", "[model_providers.ghbot]");
  lines.push('name = "ghbot"');
  lines.push(`base_url = ${toTomlString(normalizeBaseUrl(config.codexBaseUrl))}`);
  lines.push('env_key = "CODEX_API_KEY"');
  lines.push('wire_api = "responses"');
  lines.push("requires_openai_auth = false");

  return `${lines.join("\n")}\n`;
}

function normalizeBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim();
  if (!baseUrl) {
    return "https://api.openai.com/v1";
  }

  return baseUrl.replace(/\/+$/, "");
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["safeToMerge", "shouldClosePullRequest", "closeReason", "summary", "findings"],
    properties: {
      safeToMerge: { type: "boolean" },
      shouldClosePullRequest: { type: "boolean" },
      closeReason: { type: "string" },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "line", "severity", "title", "body"],
          properties: {
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            severity: { type: "string", enum: ["blocking", "suggestion"] },
            title: { type: "string" },
            body: { type: "string" }
          }
        }
      }
    }
  };
}

function buildPrompt(input: {
  title: string;
  body: string | null;
  files: PullRequestFile[];
  mode: ReviewMode;
}): string {
  return [
    buildSystemPrompt(input.mode),
    "",
    "Pull request payload:",
    JSON.stringify(
      {
        pullRequest: {
          title: input.title,
          body: input.body ?? ""
        },
        files: input.files.map((file) => ({
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? ""
        }))
      },
      null,
      2
    )
  ].join("\n");
}

function buildSystemPrompt(mode: ReviewMode): string {
  const commonRules = [
    "You are a senior software engineer reviewing a GitHub pull request.",
    "Return JSON that exactly matches the provided schema.",
    "Only set safeToMerge=true when there are no blocking findings.",
    "Set shouldClosePullRequest=true only for clearly malicious code: backdoors, credential theft, token exfiltration, destructive commands, malware, hidden persistence, privilege escalation, supply-chain compromise, or intentionally abusive behavior.",
    "Do not set shouldClosePullRequest=true for ordinary bugs, crashes, failing tests, incomplete code, suspicious-but-unproven code, or low-quality changes.",
    "When shouldClosePullRequest=true, explain the evidence in closeReason. Otherwise closeReason must be an empty string.",
    "For each finding, choose a line number that exists on an added line in the supplied patch whenever possible.",
    "Do not invent files, line numbers, test results, or runtime behavior."
  ];

  if (mode === "lenient") {
    return [
      ...commonRules,
      "This is a lenient review requested by the pull request flow.",
      "Only report issues that are dangerous, affect runtime behavior, can cause errors, can crash, can break builds/tests, can lose data, or create clear security problems.",
      "Do not block on style, naming, subjective maintainability, small refactors, missing comments, formatting, or non-dangerous best-practice preferences.",
      "Use suggestion severity only when the issue is still runtime-relevant but not necessarily blocking."
    ].join(" ");
  }

  return [
    ...commonRules,
    "This is a strict review.",
    "Find correctness bugs, security issues, data-loss risks, broken tests, bad error handling, and maintainability problems.",
    "Use suggestion severity for non-blocking style or clarity improvements."
  ].join(" ");
}
