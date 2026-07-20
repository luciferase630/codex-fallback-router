import assert from "node:assert/strict";
import test from "node:test";

import {
  fallbackRequestHeaders,
  primaryRequestHeaders,
  responseHeaders,
} from "../../src/headers.js";

test("keeps primary authorization but removes hop-by-hop headers", () => {
  const headers = primaryRequestHeaders({
    host: "local",
    connection: "keep-alive",
    authorization: "Bearer primary-token",
    cookie: "session=primary",
    "x-request-id": "request-1",
  });
  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers.authorization, "Bearer primary-token");
  assert.equal(headers.cookie, "session=primary");
  assert.equal(headers["x-request-id"], "request-1");
});

test("replaces authorization and strips ChatGPT-scoped headers for fallback", () => {
  const fallbackKey = ["fallback", "credential", "x".repeat(32)].join("-");
  const headers = fallbackRequestHeaders(
    {
      host: "local",
      authorization: "Bearer primary-token",
      cookie: "session=primary",
      origin: "https://chatgpt.com",
      referer: "https://chatgpt.com/codex",
      "chatgpt-account-id": "account-1",
      "chatgpt-project-id": "project-1",
      "x-chatgpt-session-id": "session-1",
      "x-openai-internal": "internal",
      "openai-organization": "organization-1",
      "x-request-id": "request-1",
      "content-type": "application/json",
    },
    fallbackKey,
    42,
  );
  assert.equal(headers.authorization, `Bearer ${fallbackKey}`);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.origin, undefined);
  assert.equal(headers.referer, undefined);
  assert.equal(headers["chatgpt-account-id"], undefined);
  assert.equal(headers["chatgpt-project-id"], undefined);
  assert.equal(headers["x-chatgpt-session-id"], undefined);
  assert.equal(headers["x-openai-internal"], undefined);
  assert.equal(headers["openai-organization"], undefined);
  assert.equal(headers["x-request-id"], "request-1");
  assert.equal(headers["content-length"], 42);
});

test("removes unsafe transport headers from upstream responses", () => {
  const headers = responseHeaders({
    connection: "keep-alive",
    "content-length": "10",
    "content-type": "application/json",
    "x-request-id": "request-1",
  });
  assert.equal(headers.connection, undefined);
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-request-id"], "request-1");
});
