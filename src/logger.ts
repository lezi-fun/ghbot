import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ["gitToken", "*.gitToken", "GHBOT_GIT_TOKEN", "*.GHBOT_GIT_TOKEN"],
    censor: "[REDACTED]"
  }
});
