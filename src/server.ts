import express from "express";
import pinoHttpModule from "pino-http";
import { config } from "./config.js";
import { createGitHubWebhooks } from "./github/webhookHandler.js";
import { logger } from "./logger.js";

const app = express();
const webhooks = createGitHubWebhooks();
const pinoHttp = pinoHttpModule.default ?? pinoHttpModule;

app.use(pinoHttp({ logger }));
app.get("/healthz", (_request, response) => {
  response.json({ ok: true });
});

app.post("/webhooks/github", express.raw({ type: "application/json" }), async (request, response) => {
  const id = request.header("x-github-delivery");
  const name = request.header("x-github-event");
  const signature = request.header("x-hub-signature-256");

  if (!id || !name || !signature) {
    logger.warn(
      {
        method: request.method,
        path: request.originalUrl,
        hasDeliveryId: Boolean(id),
        hasEventName: Boolean(name),
        hasSignature: Boolean(signature)
      },
      "GitHub webhook request is missing required headers."
    );
    response.status(400).json({ error: "Missing GitHub webhook headers." });
    return;
  }

  try {
    logger.info(
      {
        id,
        name,
        path: request.originalUrl,
        payloadBytes: Buffer.byteLength(request.body)
      },
      "Received GitHub webhook request."
    );
    await webhooks.verifyAndReceive({
      id,
      name,
      signature,
      payload: request.body.toString("utf8")
    });
    response.status(202).json({ ok: true });
  } catch (error) {
    logger.error({ err: error, id, name, path: request.originalUrl }, "Failed to handle webhook.");
    response.status(400).json({ error: "Invalid or failed webhook." });
  }
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, "GitHub bot is listening.");
});
