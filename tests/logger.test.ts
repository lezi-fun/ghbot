import assert from "node:assert/strict";
import { serializeError } from "../src/logger.js";

const headers = new Headers({
  "x-request-id": "req_123",
  "x-ratelimit-remaining": "42",
  "content-type": "application/json"
});

const serialized = serializeError({
  name: "RequestError",
  message: "boom",
  stack: "stack",
  status: 401,
  statusCode: 401,
  code: "bad_credentials",
  request_id: "root_req",
  documentation_url: "https://docs.github.com",
  request: {
    method: "POST",
    url: "https://api.github.com/app/installations/1/access_tokens",
    request_id: "inner_req"
  },
  response: {
    status: 401,
    url: "https://api.github.com/app/installations/1/access_tokens",
    headers,
    data: {
      message: "Integration must generate a public key"
    }
  },
  cause: new Error("nested")
});

assert.ok(serialized && typeof serialized === "object");
const cause = (serialized as { cause?: unknown }).cause;
assert.ok(cause && typeof cause === "object");
assert.equal((cause as { name?: string }).name, "Error");
assert.equal((cause as { message?: string }).message, "nested");
assert.equal(typeof (cause as { stack?: string }).stack, "string");

assert.deepEqual(
  {
    ...(serialized as Record<string, unknown>),
    cause: {
      name: (cause as { name?: string }).name,
      message: (cause as { message?: string }).message,
      stack: "[stack]"
    }
  },
  {
  name: "RequestError",
  message: "boom",
  stack: "stack",
  status: 401,
  statusCode: 401,
  code: "bad_credentials",
  requestId: "root_req",
  documentationUrl: "https://docs.github.com",
  request: {
    method: "POST",
    url: "https://api.github.com/app/installations/1/access_tokens",
    requestId: "inner_req"
  },
  response: {
    status: 401,
    url: "https://api.github.com/app/installations/1/access_tokens",
    headers: {
      "x-request-id": "req_123",
      "x-ratelimit-remaining": "42"
    },
    data: {
      message: "Integration must generate a public key"
    }
  },
  cause: {
    name: "Error",
    message: "nested",
    stack: "[stack]"
  }
}
);

assert.equal(serializeError("plain"), "plain");

console.log("logger serialization ok");
