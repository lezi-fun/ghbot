import { OpenAI } from "openai";
import { z } from "zod";
import { config } from "../config.js";
import { withRetry } from "../retry.js";
import type { PullRequestFile, ReviewDecision, ReviewMode } from "../types.js";

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

export class OpenAiReviewer {
  private readonly client = new OpenAI({
    apiKey: config.openAiApiKey,
    baseURL: config.openAiBaseUrl
  });

  async review(input: {
    title: string;
    body: string | null;
    files: PullRequestFile[];
    mode: ReviewMode;
  }): Promise<ReviewDecision> {
    const response = await withRetry("openai.responses.create", async () => {
      return this.client.responses.create({
        model: config.openAiModel,
        temperature: 0.1,
        ...(config.openAiReasoningEffort ? { reasoning: { effort: config.openAiReasoningEffort } } : {}),
        text: {
          format: {
            name: "pull_request_review",
            type: "json_schema",
            strict: true,
            schema: {
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
            }
          }
        },
        instructions: buildSystemPrompt(input.mode),
        input: [
          {
            role: "user",
            content: JSON.stringify({
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
            })
          }
        ]
      });
    });

    const raw = response.output_text;
    if (!raw) {
      throw new Error("OpenAI returned an empty review response.");
    }

    return reviewDecisionSchema.parse(JSON.parse(raw));
  }
}

function buildSystemPrompt(mode: ReviewMode): string {
  const commonRules = [
    "You are a senior software engineer reviewing a GitHub pull request.",
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
      "This is a lenient review requested by the pull request author.",
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
