import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { RouterConfig, RoutingMode } from "../../src/config.js";
import { SafeLogger } from "../../src/logger.js";
import { createRouterServer } from "../../src/proxy.js";

interface RunningServer {
  server: Server;
  origin: string;
}

async function listen(server: Server): Promise<RunningServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function quotaBody(resetAt?: number): string {
  return JSON.stringify({
    error: {
      code: "usage_limit_exceeded",
      message: "Usage limit has been reached",
      ...(resetAt ? { resets_at: resetAt } : {}),
    },
  });
}

function portableRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "current-model",
    input: [{ role: "user", content: [{ type: "input_text", text: "Continue this task" }] }],
    stream: true,
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    ...overrides,
  };
}

async function createHarness(
  t: TestContext,
  primaryHandler: (request: IncomingMessage, response: ServerResponse) => void,
  fallbackHandler: (request: IncomingMessage, response: ServerResponse) => void,
  initialRoutingMode: RoutingMode = "auto",
): Promise<{
  routerOrigin: string;
  logFile: string;
  apiKey: string;
  setRoutingMode: (mode: RoutingMode) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-fallback-proxy-"));
  const primary = await listen(http.createServer(primaryHandler));
  const fallback = await listen(http.createServer(fallbackHandler));
  const logFile = join(root, "router.log");
  const apiKey = ["fallback", "credential", "x".repeat(32)].join("-");
  let routingMode = initialRoutingMode;
  const config: RouterConfig = {
    version: 1,
    fallbackBaseUrl: fallback.origin,
    fallbackResponsesPath: "/v1/responses",
    listenHost: "127.0.0.1",
    listenPort: 45831,
    officialBaseUrl: `${primary.origin}/backend-api/codex`,
    latchMinutes: 15,
    routingMode,
  };
  const logger = new SafeLogger(logFile);
  await logger.initialize();
  const runtime = await createRouterServer({
    config,
    apiKey,
    logger,
    getRoutingMode: () => routingMode,
    health: (configuredMode, activeProvider) => ({
      ok: true,
      routingMode: configuredMode,
      mode: activeProvider,
    }),
  });
  const router = await listen(runtime.server);
  t.after(async () => {
    await Promise.all([close(router.server), close(primary.server), close(fallback.server)]);
    await rm(root, { recursive: true, force: true });
  });
  return {
    routerOrigin: router.origin,
    logFile,
    apiKey,
    setRoutingMode: (mode) => {
      routingMode = mode;
    },
  };
}

async function postResponses(
  origin: string,
  body: Record<string, unknown> = portableRequest(),
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${origin}/backend-api/codex/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: "Bearer primary-session-token",
      cookie: "session=primary",
      "chatgpt-account-id": "account-1",
      "x-openai-internal": "primary-only",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("primary success never calls fallback", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (_request, response) => {
      primaryCalls += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: {\"type\":\"response.completed\"}\n\n");
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.end();
    },
  );
  const response = await postResponses(harness.routerOrigin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response.completed/);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test("manual fallback skips primary and preserves portable context without ChatGPT credentials", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let receivedBody: Record<string, unknown> | undefined;
  let fallbackAuthorization = "";
  let fallbackCookie: string | undefined;
  let fallbackAccount: string | undefined;
  const harness = await createHarness(
    t,
    (_request, response) => {
      primaryCalls += 1;
      response.end();
    },
    (request, response) => {
      fallbackCalls += 1;
      fallbackAuthorization = String(request.headers.authorization ?? "");
      fallbackCookie = request.headers.cookie;
      fallbackAccount = request.headers["chatgpt-account-id"] as string | undefined;
      void readBody(request).then((body) => {
        receivedBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: {\"type\":\"response.completed\",\"provider\":\"fallback\"}\n\n");
      });
    },
    "fallback",
  );

  const response = await postResponses(harness.routerOrigin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /fallback/);
  assert.equal(primaryCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(fallbackAuthorization, `Bearer ${harness.apiKey}`);
  assert.equal(fallbackCookie, undefined);
  assert.equal(fallbackAccount, undefined);
  assert.equal(receivedBody?.model, "current-model");
  assert.equal(receivedBody?.store, false);
  assert.deepEqual(receivedBody?.input, portableRequest().input);
  assert.deepEqual(receivedBody?.tools, portableRequest().tools);

  const health = await fetch(`${harness.routerOrigin}/_codex-fallback/health`).then((value) => value.json());
  assert.deepEqual(health, { ok: true, routingMode: "fallback", mode: "fallback" });
});

test("manual primary returns quota exhaustion without calling fallback", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (_request, response) => {
      primaryCalls += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(quotaBody());
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.end();
    },
    "primary",
  );

  const response = await postResponses(harness.routerOrigin);
  assert.equal(response.status, 429);
  assert.match(await response.text(), /usage_limit_exceeded/);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
});

test("routing mode is fixed for an in-flight stream and changes on the next request", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (_request, response) => {
      primaryCalls += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"provider\":\"primary\",\"delta\":\"started\"}\n\n");
      setTimeout(() => response.end("data: {\"type\":\"response.completed\"}\n\n"), 50);
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: {\"provider\":\"fallback\",\"type\":\"response.completed\"}\n\n");
    },
    "primary",
  );

  const first = await postResponses(harness.routerOrigin);
  harness.setRoutingMode("fallback");
  const second = await postResponses(harness.routerOrigin);
  assert.match(await first.text(), /primary/);
  assert.match(await second.text(), /fallback/);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
});

test("strong quota failure retries once on fallback and latches future requests", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const receivedBodies: Record<string, unknown>[] = [];
  let fallbackAuthorization = "";
  let fallbackCookie: string | undefined;
  let fallbackAccount: string | undefined;
  let fallbackOpenAi: string | undefined;
  const harness = await createHarness(
    t,
    (_request, response) => {
      primaryCalls += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(quotaBody());
    },
    (request, response) => {
      fallbackCalls += 1;
      fallbackAuthorization = String(request.headers.authorization ?? "");
      fallbackCookie = request.headers.cookie;
      fallbackAccount = request.headers["chatgpt-account-id"] as string | undefined;
      fallbackOpenAi = request.headers["x-openai-internal"] as string | undefined;
      void readBody(request).then((body) => {
        receivedBodies.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: {\"type\":\"response.completed\",\"provider\":\"fallback\"}\n\n");
      });
    },
  );

  const first = await postResponses(harness.routerOrigin);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /fallback/);
  const second = await postResponses(harness.routerOrigin);
  assert.equal(second.status, 200);
  await second.text();

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 2);
  assert.equal(fallbackAuthorization, `Bearer ${harness.apiKey}`);
  assert.equal(fallbackCookie, undefined);
  assert.equal(fallbackAccount, undefined);
  assert.equal(fallbackOpenAi, undefined);
  assert.equal(receivedBodies[0]?.model, "current-model");
  assert.equal(receivedBodies[0]?.store, false);
  assert.deepEqual(receivedBodies[0]?.input, portableRequest().input);
  assert.deepEqual(receivedBodies[0]?.tools, portableRequest().tools);
});

test("quota signaled by the first SSE event switches before visible output", async (t) => {
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: error\ndata: ${quotaBody()}\n\n`);
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: {\"type\":\"response.completed\",\"provider\":\"fallback\"}\n\n");
    },
  );
  const response = await postResponses(harness.routerOrigin);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /fallback/);
  assert.equal(fallbackCalls, 1);
});

test("generic rate limits, authentication failures and 5xx never call fallback", async (t) => {
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (request, response) => {
      const scenario = new URL(request.url ?? "/", "http://localhost").searchParams.get("scenario");
      if (scenario === "auth") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_authentication" } }));
      } else if (scenario === "server") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "server_error" } }));
      } else {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
      }
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.end();
    },
  );

  for (const [scenario, expected] of [["rate", 429], ["auth", 401], ["server", 503]] as const) {
    const response = await fetch(`${harness.routerOrigin}/backend-api/codex/responses?scenario=${scenario}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(portableRequest()),
    });
    assert.equal(response.status, expected);
    await response.text();
  }
  assert.equal(fallbackCalls, 0);
});

test("visible primary output prevents later quota failover", async (t) => {
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n");
      setTimeout(() => response.end(`event: error\ndata: ${quotaBody()}\n\n`), 10);
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.end();
    },
  );
  const response = await postResponses(harness.routerOrigin);
  const text = await response.text();
  assert.match(text, /partial/);
  assert.match(text, /usage_limit_exceeded/);
  assert.equal(fallbackCalls, 0);
});

test("provider-scoped history blocks fallback without sending the request", async (t) => {
  let fallbackCalls = 0;
  const harness = await createHarness(
    t,
    (_request, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(quotaBody());
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.end();
    },
  );
  const response = await postResponses(
    harness.routerOrigin,
    portableRequest({ previous_response_id: "provider-response-1" }),
  );
  assert.equal(response.status, 502);
  assert.match(await response.text(), /fallback_body_invalid/);
  assert.equal(fallbackCalls, 0);
});

test("fallback rejection is sanitized and does not expose its body or secrets", async (t) => {
  const privateProviderDetail = "private-provider-diagnostic";
  const harness = await createHarness(
    t,
    (_request, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(quotaBody());
    },
    (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: privateProviderDetail } }));
    },
  );
  const response = await postResponses(harness.routerOrigin);
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.match(body, /fallback_rejected/);
  assert.doesNotMatch(body, new RegExp(privateProviderDetail));
  assert.doesNotMatch(body, new RegExp(harness.apiKey));
  assert.doesNotMatch(await readFile(harness.logFile, "utf8"), new RegExp(harness.apiKey));
});

test("network failure on primary does not send context to fallback", async (t) => {
  let fallbackCalls = 0;
  const root = await mkdtemp(join(tmpdir(), "codex-fallback-network-"));
  const unused = await listen(http.createServer());
  const unavailableOrigin = unused.origin;
  await close(unused.server);
  const fallback = await listen(http.createServer((_request, response) => {
    fallbackCalls += 1;
    response.end();
  }));
  const config: RouterConfig = {
    version: 1,
    fallbackBaseUrl: fallback.origin,
    fallbackResponsesPath: "/v1/responses",
    listenHost: "127.0.0.1",
    listenPort: 45831,
    officialBaseUrl: `${unavailableOrigin}/backend-api/codex`,
    latchMinutes: 15,
    routingMode: "auto",
  };
  const logger = new SafeLogger(join(root, "router.log"));
  await logger.initialize();
  const syntheticCredential = ["synthetic", "fallback", "credential", "value"].join("-");
  const runtime = await createRouterServer({ config, apiKey: syntheticCredential, logger, health: () => ({}) });
  const router = await listen(runtime.server);
  t.after(async () => {
    await Promise.all([close(router.server), close(fallback.server)]);
    await rm(root, { recursive: true, force: true });
  });

  const response = await postResponses(router.origin);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /primary_unreachable/);
  assert.equal(fallbackCalls, 0);
});

test("non-model routes keep official authentication in every routing mode", async (t) => {
  const primaryPaths: string[] = [];
  let fallbackCalls = 0;
  let officialAuthorization = "";
  let officialCookie = "";
  const harness = await createHarness(
    t,
    (request, response) => {
      primaryPaths.push(request.url ?? "");
      officialAuthorization = String(request.headers.authorization ?? "");
      officialCookie = String(request.headers.cookie ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ source: "primary" }));
    },
    (_request, response) => {
      fallbackCalls += 1;
      response.end();
    },
  );
  for (const mode of ["auto", "fallback", "primary"] as const) {
    harness.setRoutingMode(mode);
    const response = await fetch(`${harness.routerOrigin}/backend-api/codex/models?view=all`, {
      headers: {
        authorization: "Bearer primary-session-token",
        cookie: "session=primary",
      },
    });
    assert.deepEqual(await response.json(), { source: "primary" });
  }
  assert.deepEqual(primaryPaths, Array(3).fill("/backend-api/codex/models?view=all"));
  assert.equal(officialAuthorization, "Bearer primary-session-token");
  assert.equal(officialCookie, "session=primary");
  assert.equal(fallbackCalls, 0);
});
