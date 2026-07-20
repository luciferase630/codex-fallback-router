import assert from "node:assert/strict";
import http, { type IncomingMessage, type Server } from "node:http";
import test, { type TestContext } from "node:test";

import type { RouterConfig } from "../../src/config.js";
import { smokeTestFallback } from "../../src/smoke-test.js";

async function listen(server: Server): Promise<{ server: Server; origin: string }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function config(origin: string): RouterConfig {
  return {
    version: 1,
    fallbackBaseUrl: origin,
    fallbackResponsesPath: "/v1/responses",
    listenHost: "127.0.0.1",
    listenPort: 45831,
    officialBaseUrl: "https://chatgpt.com/backend-api/codex",
    latchMinutes: 15,
    routingMode: "auto",
  };
}

test("smoke test sends a minimal non-stored Responses API request", async (t: TestContext) => {
  let path = "";
  let authorization = "";
  let requestBody: Record<string, unknown> | undefined;
  const server = await listen(http.createServer((request, response) => {
    path = request.url ?? "";
    authorization = String(request.headers.authorization ?? "");
    void readBody(request).then((body) => {
      requestBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "response_test", object: "response", output: [] }));
    });
  }));
  t.after(async () => close(server.server));
  const credential = ["smoke", "credential", "x".repeat(32)].join("-");
  const result = await smokeTestFallback({
    config: config(server.origin),
    apiKey: credential,
    model: "current-model",
  });

  assert.deepEqual(result, {
    endpoint: `${server.origin}/v1/responses`,
    model: "current-model",
    status: 200,
    responseIdPresent: true,
  });
  assert.equal(path, "/v1/responses");
  assert.equal(authorization, `Bearer ${credential}`);
  assert.equal(requestBody?.model, "current-model");
  assert.equal(requestBody?.store, false);
  assert.equal(requestBody?.stream, false);
  assert.equal(requestBody?.input, "Reply with exactly: OK");
});

test("smoke test never exposes a provider error body or credential", async (t: TestContext) => {
  const providerDetail = "private-upstream-diagnostic";
  const server = await listen(http.createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: providerDetail } }));
  }));
  t.after(async () => close(server.server));
  const credential = ["smoke", "credential", "y".repeat(32)].join("-");

  await assert.rejects(
    smokeTestFallback({ config: config(server.origin), apiKey: credential, model: "current-model" }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, new RegExp(providerDetail));
      assert.doesNotMatch(error.message, new RegExp(credential));
      return true;
    },
  );
});

test("smoke test reports a sanitized network code", async () => {
  const unavailable = await listen(http.createServer());
  await close(unavailable.server);
  await assert.rejects(
    smokeTestFallback({
      config: config(unavailable.origin),
      apiKey: ["smoke", "credential", "z".repeat(32)].join("-"),
      model: "current-model",
      timeoutMs: 2_000,
    }),
    /failed before receiving an HTTP response \([A-Z0-9_]+\)/,
  );
});
