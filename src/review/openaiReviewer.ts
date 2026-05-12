import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import type { PullRequestFile, ReviewDecision } from "../types.js";

const reviewDecisionSchema = z.object({
  safeToMerge: z.boolean(),
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
  private readonly client = new OpenAI({ apiKey: config.openAiApiKey });

  async review(input: {
    title: string;
    body: string | null;
    files: PullRequestFile[];
  }): Promise<ReviewDecision> {
    const response = await this.client.chat.completions.create({
      model: config.openAiModel,
      temperature: 0.1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "pull_request_review",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["safeToMerge", "summary", "findings"],
            properties: {
              safeToMerge: { type: "boolean" },
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
      messages: [
        {
          role: "system",
          content: [
            "You are a strict senior software engineer reviewing a GitHub pull request.",
            "Find correctness bugs, security issues, data-loss risks, broken tests, bad error handling, and maintainability problems.",
            "Only set safeToMerge=true when there are no blocking findings.",
            "Use suggestion severity for non-blocking style or clarity improvements.",
            "For each finding, choose a line number that exists on an added line in the supplied patch whenever possible.",
            "Do not invent files, line numbers, test results, or runtime behavior."
          ].join(" ")
        },
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

    const raw = response.choices[0]?.message.content;
    if (!raw) {
      throw new Error("OpenAI returned an empty review response.");
    }

    return reviewDecisionSchema.parse(JSON.parse(raw));
  }
}
