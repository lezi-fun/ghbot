import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "../retry.js";
import type { PullRequestFile, ReviewDecision, ReviewMode } from "../types.js";

const CODEX_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

const reviewDecisionSchema = z.object({
  safeToMerge: z.boolean(),
  shouldClosePullRequest: z.boolean(),
  closeReason: z.string(),
  summary: z.string(),
  fixTips: z.array(z.string()),
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
      const codexHome = path.join(tempDir, "codex-home");
      const resultPath = path.join(process.cwd(), ".review-result.json");

      try {
        await fs.rm(resultPath, { force: true });
        await fs.mkdir(codexHome, { recursive: true });
        await fs.writeFile(path.join(codexHome, "config.toml"), buildCodexConfig(), "utf8");

        const prompt = buildPrompt(input, resultPath);
        const args = [
          "exec",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
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
          await runCodexExec(args, {
            CODEX_HOME: codexHome,
            CODEX_API_KEY: config.codexApiKey
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

        try {
          await fs.access(resultPath);
        } catch {
          throw new Error(`Codex CLI did not create ${resultPath}.`);
        }

        const raw = await fs.readFile(resultPath, "utf8");
        return reviewDecisionSchema.parse(JSON.parse(raw));
      } finally {
        await fs.rm(resultPath, { force: true });
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  }
}

async function runCodexExec(args: string[], extraEnv: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const childEnv = buildCodexChildEnv(extraEnv);
    const inheritedEnvKeys = Object.keys(childEnv).filter((key) => !(key in extraEnv));

    logger.info(
      {
        cmd: "codex",
        args,
        timeoutMs: CODEX_EXEC_TIMEOUT_MS,
        inheritedEnvKeys
      },
      "Spawning Codex CLI process."
    );

    const child = spawn("codex", args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }

      logger.error({ timeoutMs: CODEX_EXEC_TIMEOUT_MS }, "Codex CLI review timed out; terminating process.");
      child.kill("SIGTERM");
      reject(new Error(`Codex CLI review timed out after ${CODEX_EXEC_TIMEOUT_MS}ms.`));
    }, CODEX_EXEC_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      streamProcessOutput("stdout", text);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      streamProcessOutput("stderr", text);
    });

    child.on("error", (error) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);
      logger.error({ error }, "Codex CLI process emitted an error event.");
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeout);

      logger.info({ code, signal }, "Codex CLI process exited.");

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        Object.assign(new Error(`Codex CLI exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`), {
          code,
          signal,
          stdout,
          stderr,
          cmd: `codex ${args.join(" ")}`
        })
      );
    });
  });
}

function buildCodexChildEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  copyEnv(env, "PATH");
  copyEnv(env, "HOME");
  copyEnv(env, "USER");
  copyEnv(env, "SHELL");
  copyEnv(env, "TMPDIR");
  copyEnv(env, "TMP");
  copyEnv(env, "TEMP");
  copyEnv(env, "PATHEXT");
  copyEnv(env, "ComSpec");
  copyEnv(env, "SystemRoot");
  copyEnv(env, "WINDIR");
  copyEnv(env, "LANG");
  copyEnv(env, "LC_ALL");
  copyEnv(env, "TERM");
  copyEnv(env, "NO_COLOR");
  copyEnv(env, "FORCE_COLOR");
  copyEnv(env, "CI");
  copyEnv(env, "HTTP_PROXY");
  copyEnv(env, "HTTPS_PROXY");
  copyEnv(env, "NO_PROXY");
  copyEnv(env, "http_proxy");
  copyEnv(env, "https_proxy");
  copyEnv(env, "no_proxy");
  copyEnv(env, "ALL_PROXY");
  copyEnv(env, "all_proxy");
  copyEnv(env, "NODE_EXTRA_CA_CERTS");
  copyEnv(env, "SSL_CERT_FILE");
  copyEnv(env, "SSL_CERT_DIR");

  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }

  return env;
}

function copyEnv(target: NodeJS.ProcessEnv, key: string): void {
  const value = process.env[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

function streamProcessOutput(stream: "stdout" | "stderr", text: string): void {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const prefixed = `[codex-cli ${stream}] ${line}`;
    if (stream === "stdout") {
      process.stdout.write(`${prefixed}\n`);
      logger.info({ stream, line }, "Codex CLI output.");
      continue;
    }

    process.stderr.write(`${prefixed}\n`);
    logger.warn({ stream, line }, "Codex CLI output.");
  }
}

function buildCodexConfig(): string {
  const lines = [
    `model = ${toTomlString(config.codexModel)}`,
    'model_provider = "bot"',
    'approvals_reviewer = "user"'
  ];

  if (config.codexReasoningEffort) {
    lines.push(`model_reasoning_effort = ${toTomlString(config.codexReasoningEffort)}`);
  }

  lines.push("", "[model_providers.bot]");
  lines.push('name = "bot"');
  lines.push(`base_url = ${toTomlString(normalizeBaseUrl(config.codexBaseUrl))}`);
  lines.push('env_key = "CODEX_API_KEY"');
  lines.push('wire_api = "responses"');

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

function buildPrompt(input: {
  title: string;
  body: string | null;
  files: PullRequestFile[];
  mode: ReviewMode;
}, resultPath: string): string {
  return [
    buildSystemPrompt(input.mode),
    "",
    `Write your final JSON review result to ${resultPath}.`,
    "Do not wrap the JSON in markdown.",
    "Do not print the final JSON to stdout.",
    "The JSON must have exactly these top-level keys: safeToMerge, shouldClosePullRequest, closeReason, summary, fixTips, findings.",
    "fixTips must be an array of short strings describing related areas the author should double-check while fixing the findings to avoid rework. Use an empty array when there are no useful tips.",
    "Each item in findings must have exactly these keys: path, line, severity, title, body.",
    'Valid severity values are only "blocking" or "suggestion".',
    `After writing ${resultPath}, you may print short progress logs, but the file contents must be valid JSON.`,
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
    "Produce a final result object that exactly matches the requested JSON structure.",
    "Only set safeToMerge=true when there are no blocking findings.",
    "Find as many real issues as you can in this single pass. Do not stop after the first blocking issue if there are additional actionable findings in the diff.",
    "When you identify a bug, also check nearby code paths and obvious related regressions, but stay close to what the diff actually makes plausible.",
    "Prefer false negatives over false positives. Do not report a finding unless you can explain a concrete failure mode, misuse case, or broken behavior from the diff itself.",
    "Do not report hypothetical, speculative, low-probability, style-only, architecture-preference, or vague maintainability concerns.",
    "When reviewing branch cleanup logic, judge the ordinary feature-branch case first. Do not block the change by bringing in extreme repository-specific examples such as shared long-lived branches or unusual protected branch workflows unless the diff is explicitly about those cases.",
    "If a concern is really about a repository-specific exception, prefer a configurable skip list or existing branch protection instead of rejecting the feature for the common case.",
    "Set shouldClosePullRequest=true only for clearly malicious code: backdoors, credential theft, token exfiltration, destructive commands, malware, hidden persistence, privilege escalation, supply-chain compromise, or intentionally abusive behavior.",
    "Do not set shouldClosePullRequest=true for ordinary bugs, crashes, failing tests, incomplete code, suspicious-but-unproven code, or low-quality changes.",
    "When shouldClosePullRequest=true, explain the evidence in closeReason. Otherwise closeReason must be an empty string.",
    "For each finding, choose a line number that exists on an added line in the supplied patch whenever possible.",
    "Use fixTips only for concrete, high-confidence reminders about nearby code paths, platform compatibility, configuration, or tests that are directly connected to an actual finding.",
    "Do not use fixTips for speculative edge cases, general cleanup ideas, or broad best-practice reminders.",
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
    "Find correctness bugs, security issues, data-loss risks, broken tests, and bad error handling that are concrete and actionable.",
    "Use suggestion severity only for concrete, non-blocking issues that still have a clear technical downside.",
    "Do not raise findings for style, naming, minor refactors, subjective clarity preferences, or weak maintainability concerns."
  ].join(" ");
}
