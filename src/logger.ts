import pino from "pino";

type SerializedError = {
  name?: string;
  message?: string;
  stack?: string;
  status?: unknown;
  code?: unknown;
  response?: unknown;
  cause?: unknown;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: serializeError,
    error: serializeError
  }
});

function serializeError(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }

  const record = error as Record<string, unknown>;
  const serialized: SerializedError = {
    name: record.name as string | undefined,
    message: record.message as string | undefined,
    stack: record.stack as string | undefined,
    status: record.status,
    code: record.code
  };

  if (record.response && typeof record.response === "object") {
    const response = record.response as Record<string, unknown>;
    serialized.response = {
      status: response.status,
      url: response.url,
      data: response.data
    };
  }

  if (record.cause) {
    serialized.cause = serializeError(record.cause);
  }

  return serialized;
}
