import { randomUUID } from "node:crypto";
import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import { once } from "node:events";

import { fallbackResponsesUrl, type RouterConfig, type RoutingMode } from "./config.js";
import { DEFAULT_FALLBACK_RETRIES } from "./constants.js";
import { prepareFallbackRequestBody } from "./context.js";
import { safeNetworkCode } from "./errors.js";
import {
  fallbackRequestHeaders,
  primaryRequestHeaders,
  responseHeaders,
} from "./headers.js";
import { QuotaLatch } from "./latch.js";
import { SafeLogger } from "./logger.js";
import { classifyQuotaResponse, classifyQuotaSseEvent } from "./quota.js";
import { createUpstreamRequest, openUpstreamRequest } from "./transport.js";

const MAX_RESPONSE_REQUEST_BYTES = 128 * 1024 * 1024;
const MAX_ERROR_BYTES = 2 * 1024 * 1024;
const INITIAL_SSE_BYTES = 64 * 1024;
const INITIAL_SSE_TIMEOUT_MS = 5_000;
const FALLBACK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const LOCAL_PREFIX = "/backend-api/codex";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestModule(target: URL): typeof http | typeof https {
  return target.protocol === "https:" ? https : http;
}

async function readLimited(stream: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maximum) throw new Error("Upstream error response exceeded the safety limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_RESPONSE_REQUEST_BYTES) {
      throw new Error("Responses request exceeds the 128 MiB in-memory retry limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function officialTarget(config: RouterConfig, incomingUrl: string | undefined): URL {
  const incoming = new URL(incomingUrl ?? "/", "http://127.0.0.1");
  const target = new URL(config.officialBaseUrl);
  const suffix = incoming.pathname.startsWith(LOCAL_PREFIX)
    ? incoming.pathname.slice(LOCAL_PREFIX.length)
    : incoming.pathname;
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
  target.search = incoming.search;
  return target;
}

function isResponsesRequest(request: IncomingMessage): boolean {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "");
  return request.method === "POST" && path.endsWith("/responses");
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  const body = Buffer.from(
    JSON.stringify({ error: { message, type: "fallback_router_error", code } }),
    "utf8",
  );
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeBufferedResponse(
  client: ServerResponse,
  upstream: IncomingMessage,
  body: Buffer,
): void {
  const headers = responseHeaders(upstream.headers);
  headers["content-length"] = body.length;
  client.writeHead(upstream.statusCode ?? 502, headers);
  client.end(body);
}

async function writeChunk(response: ServerResponse, chunk: Buffer): Promise<void> {
  if (response.write(chunk)) return;
  await once(response, "drain");
}

async function streamResponse(client: ServerResponse, upstream: IncomingMessage): Promise<void> {
  client.writeHead(upstream.statusCode ?? 200, responseHeaders(upstream.headers));
  for await (const chunk of upstream) await writeChunk(client, Buffer.from(chunk));
  client.end();
}

async function readInitialSseEvent(
  upstream: IncomingMessage,
): Promise<{ buffer: Buffer; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (ended: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upstream.pause();
      cleanup();
      resolve({ buffer: Buffer.concat(chunks), ended });
    };
    const cleanup = () => {
      upstream.off("data", onData);
      upstream.off("end", onEnd);
      upstream.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      total += buffer.length;
      const combined = Buffer.concat(chunks);
      if (combined.includes("\n\n") || combined.includes("\r\n\r\n") || total >= INITIAL_SSE_BYTES) {
        finish(false);
      }
    };
    const onEnd = () => finish(true);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => finish(false), INITIAL_SSE_TIMEOUT_MS);
    upstream.on("data", onData);
    upstream.on("end", onEnd);
    upstream.on("error", onError);
    upstream.resume();
  });
}

export interface RouterRuntime {
  server: Server;
  latch: QuotaLatch;
}

type ActiveProvider = "primary" | "fallback";

export async function createRouterServer(options: {
  config: RouterConfig;
  apiKey: string;
  logger: SafeLogger;
  getRoutingMode?: () => RoutingMode | Promise<RoutingMode>;
  health: (
    routingMode: RoutingMode,
    activeProvider: ActiveProvider,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}): Promise<RouterRuntime> {
  const { config, apiKey, logger } = options;
  const latch = new QuotaLatch(config.latchMinutes * 60_000);
  const getRoutingMode = options.getRoutingMode ?? (() => config.routingMode);

  async function proxyPassthrough(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = officialTarget(config, request.url);
    let upstreamRequest;
    try {
      upstreamRequest = await createUpstreamRequest(
        {
          target,
          method: request.method ?? "GET",
          headers: primaryRequestHeaders(request.headers),
          ...(config.upstreamProxyUrl ? { proxyUrl: config.upstreamProxyUrl } : {}),
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers));
          upstream.pipe(response);
        },
      );
    } catch {
      writeError(response, 502, "primary_unreachable", "Official ChatGPT backend is unreachable.");
      return;
    }
    upstreamRequest.once("error", () => {
      if (!response.headersSent) writeError(response, 502, "primary_unreachable", "Official ChatGPT backend is unreachable.");
      else response.destroy();
    });
    request.pipe(upstreamRequest);
  }

  async function sendFallback(
    request: IncomingMessage,
    response: ServerResponse,
    originalBody: Buffer,
    requestId: string,
  ): Promise<void> {
    const started = Date.now();
    let fallbackBody: Buffer;
    try {
      fallbackBody = prepareFallbackRequestBody(originalBody, config.fallbackModel).body;
    } catch (error) {
      writeError(response, 502, "fallback_body_invalid", (error as Error).message);
      return;
    }
    const maxRetries = config.fallbackRetries ?? DEFAULT_FALLBACK_RETRIES;
    // Stop hammering the provider as soon as the Codex client has given up;
    // nothing may be written to a disconnected client.
    let clientGone = response.destroyed;
    response.on("close", () => {
      clientGone = true;
    });
    let upstream: IncomingMessage;
    for (let attempt = 0; ; attempt += 1) {
      if (clientGone) {
        await logger.write({
          event: "client_aborted",
          requestId,
          provider: "fallback",
          durationMs: Date.now() - started,
        });
        return;
      }
      try {
        upstream = await openUpstreamRequest({
          target: fallbackResponsesUrl(config),
          method: request.method ?? "POST",
          headers: fallbackRequestHeaders(request.headers, apiKey, fallbackBody.length),
          body: fallbackBody,
          ...(config.upstreamProxyUrl ? { proxyUrl: config.upstreamProxyUrl } : {}),
        });
        break;
      } catch (error) {
        const detail = safeNetworkCode(error);
        if (clientGone) {
          await logger.write({
            event: "client_aborted",
            requestId,
            provider: "fallback",
            durationMs: Date.now() - started,
            detail,
          });
          return;
        }
        // ECONNREFUSED means the provider (or the local proxy) is down rather
        // than flaky; retrying immediately only adds to the failure storm.
        if (detail === "ECONNREFUSED" || attempt >= maxRetries) {
          await logger.write({
            event: "upstream_error",
            requestId,
            provider: "fallback",
            durationMs: Date.now() - started,
            detail,
          });
          if (!response.destroyed) {
            writeError(response, 502, "fallback_unreachable", "Fallback Responses API is unreachable.");
          }
          return;
        }
        // Nothing has been written to the client yet, so a transport-level
        // failure (TLS reset, CONNECT failure) is safe to retry.
        await logger.write({
          event: "upstream_retry",
          requestId,
          provider: "fallback",
          durationMs: Date.now() - started,
          detail: `attempt=${attempt + 1} ${detail}`,
        });
        await delay(FALLBACK_RETRY_DELAYS_MS[Math.min(attempt, FALLBACK_RETRY_DELAYS_MS.length - 1)] ?? 10_000);
      }
    }
    try {
      await logger.write({
        event: "upstream_response",
        requestId,
        provider: "fallback",
        ...(upstream.statusCode !== undefined ? { status: upstream.statusCode } : {}),
        durationMs: Date.now() - started,
      });
      if ((upstream.statusCode ?? 500) < 200 || (upstream.statusCode ?? 500) >= 300) {
        await readLimited(upstream, MAX_ERROR_BYTES);
        writeError(
          response,
          502,
          "fallback_rejected",
          `Fallback provider rejected the request with HTTP ${upstream.statusCode ?? 502}.`,
        );
        return;
      }
      await streamResponse(response, upstream);
    } catch (error) {
      await logger.write({
        event: "upstream_error",
        requestId,
        provider: "fallback",
        durationMs: Date.now() - started,
        detail: safeNetworkCode(error),
      });
      if (!response.headersSent) {
        writeError(response, 502, "fallback_unreachable", "Fallback Responses API is unreachable.");
      } else {
        response.destroy();
      }
    }
  }

  async function sendPrimary(
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
    requestId: string,
  ): Promise<void> {
    const started = Date.now();
    try {
      const upstream = await openUpstreamRequest({
        target: officialTarget(config, request.url),
        method: request.method ?? "POST",
        headers: { ...primaryRequestHeaders(request.headers), "content-length": body.length },
        body,
        ...(config.upstreamProxyUrl ? { proxyUrl: config.upstreamProxyUrl } : {}),
      });
      await logger.write({
        event: "upstream_response",
        requestId,
        provider: "primary",
        ...(upstream.statusCode !== undefined ? { status: upstream.statusCode } : {}),
        durationMs: Date.now() - started,
      });
      await streamResponse(response, upstream);
    } catch (error) {
      await logger.write({
        event: "upstream_error",
        requestId,
        provider: "primary",
        durationMs: Date.now() - started,
        detail: safeNetworkCode(error),
      });
      if (!response.headersSent) {
        writeError(response, 502, "primary_unreachable", "Official ChatGPT backend is unreachable.");
      } else {
        response.destroy();
      }
    }
  }

  async function handleResponses(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    let body: Buffer;
    try {
      body = await readRequestBody(request);
    } catch (error) {
      writeError(response, 413, "request_too_large", (error as Error).message);
      return;
    }
    let routingMode: RoutingMode;
    try {
      routingMode = await getRoutingMode();
    } catch {
      writeError(response, 500, "routing_mode_invalid", "Routing mode configuration is invalid.");
      return;
    }
    if (routingMode === "fallback") {
      await logger.write({ event: "manual_route", requestId, provider: "fallback" });
      await sendFallback(request, response, body, requestId);
      return;
    }
    if (routingMode === "primary") {
      await logger.write({ event: "manual_route", requestId, provider: "primary" });
      await sendPrimary(request, response, body, requestId);
      return;
    }
    if (latch.isActive()) {
      await logger.write({ event: "fallback_latch_hit", requestId, provider: "fallback" });
      await sendFallback(request, response, body, requestId);
      return;
    }

    const started = Date.now();
    let upstream: IncomingMessage;
    try {
      upstream = await openUpstreamRequest({
        target: officialTarget(config, request.url),
        method: request.method ?? "POST",
        headers: { ...primaryRequestHeaders(request.headers), "content-length": body.length },
        body,
        ...(config.upstreamProxyUrl ? { proxyUrl: config.upstreamProxyUrl } : {}),
      });
    } catch (error) {
      await logger.write({
        event: "upstream_error",
        requestId,
        provider: "primary",
        durationMs: Date.now() - started,
        detail: safeNetworkCode(error),
      });
      writeError(response, 502, "primary_unreachable", "Official ChatGPT backend is unreachable.");
      return;
    }

    const status = upstream.statusCode ?? 502;
    await logger.write({
      event: "upstream_response",
      requestId,
      provider: "primary",
      status,
      durationMs: Date.now() - started,
    });
    if (status < 200 || status >= 300) {
      let errorBody: Buffer;
      try {
        errorBody = await readLimited(upstream, MAX_ERROR_BYTES);
      } catch {
        writeError(response, 502, "primary_error_too_large", "Official error response exceeded the safety limit.");
        return;
      }
      const quota = classifyQuotaResponse(status, errorBody);
      if (!quota.isQuotaExhausted) {
        writeBufferedResponse(response, upstream, errorBody);
        return;
      }
      const until = latch.activate(quota.resetAt);
      await logger.write({
        event: "quota_latched",
        requestId,
        provider: "primary",
        status,
        detail: `until=${new Date(until).toISOString()}`,
      });
      await sendFallback(request, response, body, requestId);
      return;
    }

    const contentType = String(upstream.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      await streamResponse(response, upstream);
      return;
    }
    const initial = await readInitialSseEvent(upstream);
    const lfBoundary = initial.buffer.indexOf("\n\n");
    const crlfBoundary = initial.buffer.indexOf("\r\n\r\n");
    const candidates = [
      ...(lfBoundary >= 0 ? [lfBoundary + 2] : []),
      ...(crlfBoundary >= 0 ? [crlfBoundary + 4] : []),
    ];
    const firstEventEnd = candidates.length > 0 ? Math.min(...candidates) : initial.buffer.length;
    const quota = classifyQuotaSseEvent(initial.buffer.subarray(0, firstEventEnd));
    if (quota.isQuotaExhausted) {
      upstream.destroy();
      const until = latch.activate(quota.resetAt);
      await logger.write({
        event: "quota_latched",
        requestId,
        provider: "primary",
        status,
        detail: `until=${new Date(until).toISOString()}`,
      });
      await sendFallback(request, response, body, requestId);
      return;
    }
    response.writeHead(status, responseHeaders(upstream.headers));
    if (initial.buffer.length > 0) await writeChunk(response, initial.buffer);
    if (initial.ended) {
      response.end();
      return;
    }
    upstream.resume();
    for await (const chunk of upstream) await writeChunk(response, Buffer.from(chunk));
    response.end();
  }

  const server = http.createServer((request, response) => {
    // Clients (Codex) may disconnect at any time; socket errors must be
    // absorbed here so they can never crash the daemon process.
    request.on("error", (error) => {
      void logger.write({ event: "client_error", detail: `request ${safeNetworkCode(error)}` });
    });
    response.on("error", (error) => {
      void logger.write({ event: "client_error", detail: `response ${safeNetworkCode(error)}` });
    });
    void (async () => {
      if (request.url === "/_codex-fallback/health") {
        const routingMode = await getRoutingMode();
        const activeProvider: ActiveProvider = routingMode === "auto"
          ? (latch.isActive() ? "fallback" : "primary")
          : routingMode;
        const body = Buffer.from(
          JSON.stringify(await options.health(routingMode, activeProvider)),
          "utf8",
        );
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": body.length,
          "cache-control": "no-store",
        });
        response.end(body);
        return;
      }
      if (isResponsesRequest(request)) await handleResponses(request, response);
      else await proxyPassthrough(request, response);
    })().catch(async () => {
      await logger.write({ event: "request_error" });
      if (!response.headersSent) writeError(response, 500, "router_internal_error", "Fallback router internal error.");
      else response.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  // Must exceed the Node default (5s) so idle pooled connections from the
  // Codex client are not closed underneath it, which surfaces as
  // "error sending request" on the next reuse.
  server.keepAliveTimeout = 75_000;
  return { server, latch };
}
