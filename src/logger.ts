import pino from "pino";

type SerializedHeaders = Record<string, unknown>;
type SerializedRequest = {
  method?: unknown;
  url?: unknown;
  requestId?: unknown;
};

type SerializedResponse = {
  status?: unknown;
  url?: unknown;
  headers?: SerializedHeaders;
  data?: unknown;
};

type SerializedError = {
  name?: string;
  message?: string;
  stack?: string;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  param?: unknown;
  requestId?: unknown;
  documentationUrl?: unknown;
  request?: SerializedRequest;
  response?: SerializedResponse;
  details?: unknown;
  errors?: unknown;
  cause?: unknown;
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    err: serializeError,
    error: serializeError
  }
});

export function serializeError(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }

  const record = error as Record<string, unknown>;
  const serialized: SerializedError = {
    name: record.name as string | undefined,
    message: record.message as string | undefined,
    stack: record.stack as string | undefined,
    status: record.status,
    statusCode: record.statusCode,
    code: record.code,
    type: record.type,
    param: record.param,
    requestId: record.request_id ?? record.requestId,
    documentationUrl: record.documentation_url ?? record.documentationUrl
  };

  const request = serializeRequest(record.request);
  if (request) {
    serialized.request = request;
  }

  const response = serializeResponse(record.response);
  if (response) {
    serialized.response = response;
  }

  if ("details" in record) {
    serialized.details = record.details;
  }

  if ("errors" in record) {
    serialized.errors = record.errors;
  }

  if (record.cause) {
    serialized.cause = serializeError(record.cause);
  }

  return compactUndefined(serialized);
}

function serializeRequest(request: unknown): SerializedRequest | undefined {
  if (!request || typeof request !== "object") {
    return undefined;
  }

  const record = request as Record<string, unknown>;
  const serialized: SerializedRequest = {
    method: record.method,
    url: record.url,
    requestId: record.request_id ?? record.requestId
  };

  return hasDefinedValue(serialized) ? compactUndefined(serialized) : undefined;
}

function serializeResponse(response: unknown): SerializedResponse | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const record = response as Record<string, unknown>;
  const headers = serializeHeaders(record.headers);
  const serialized: SerializedResponse = {
    status: record.status,
    url: record.url,
    headers,
    data: record.data
  };

  return hasDefinedValue(serialized) ? compactUndefined(serialized) : undefined;
}

function serializeHeaders(headers: unknown): SerializedHeaders | undefined {
  const source = toHeaderRecord(headers);
  if (!source) {
    return undefined;
  }

  const serializedEntries = [
    "x-request-id",
    "x-github-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "openai-processing-ms"
  ].flatMap((key) => {
    const value = source[key];
    return value === undefined ? [] : [[key, value] as const];
  });

  if (serializedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(serializedEntries);
}

function toHeaderRecord(headers: unknown): Record<string, unknown> | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (typeof headers === "object") {
    return headers as Record<string, unknown>;
  }

  return undefined;
}

function hasDefinedValue(record: Record<string, unknown>): boolean {
  return Object.values(record).some((value) => value !== undefined);
}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}
