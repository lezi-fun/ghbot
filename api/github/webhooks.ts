import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { createGitHubWebhooks } from "../../src/github/webhookHandler.js";
import { logger } from "../../src/logger.js";

export const config = {
  api: {
    bodyParser: false
  }
};

const webhooks = createGitHubWebhooks();

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method === "GET") {
    response.status(200).json({ ok: true });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("allow", "GET, POST");
    response.status(405).json({ error: "Method not allowed." });
    return;
  }

  const id = request.headers["x-github-delivery"];
  const name = request.headers["x-github-event"];
  const signature = request.headers["x-hub-signature-256"];

  if (typeof id !== "string" || typeof name !== "string" || typeof signature !== "string") {
    response.status(400).json({ error: "Missing GitHub webhook headers." });
    return;
  }

  const payload = await readRawBody(request);

  try {
    const verified = await webhooks.verify(payload, signature);
    if (!verified) {
      response.status(401).json({ error: "Invalid webhook signature." });
      return;
    }

    waitUntil(
      webhooks.receive({
        id,
        name,
        payload: JSON.parse(payload)
      } as Parameters<typeof webhooks.receive>[0])
    );

    response.status(202).json({ ok: true });
  } catch (error) {
    logger.error({ error }, "Failed to handle webhook.");
    response.status(400).json({ error: "Invalid or failed webhook." });
  }
}

async function readRawBody(request: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
