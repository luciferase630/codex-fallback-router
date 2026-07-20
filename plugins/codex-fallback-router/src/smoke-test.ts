import { readCodexConfig, inspectRootModel } from "./codex-config.js";
import { fallbackResponsesUrl, readRouterConfig, type RouterConfig } from "./config.js";
import { readApiKey } from "./dpapi.js";
import { getAppPaths, type AppPaths } from "./paths.js";
import { openUpstreamRequest } from "./transport.js";

const MAX_SMOKE_RESPONSE_BYTES = 2 * 1024 * 1024;
const SMOKE_TIMEOUT_MS = 45_000;

export interface SmokeTestResult {
  endpoint: string;
  model: string;
  status: number;
  responseIdPresent: boolean;
}

function safeNetworkCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(record.code)) {
      return record.code;
    }
    current = record.cause;
  }
  return "NETWORK_ERROR";
}

async function readLimitedResponse(response: import("node:http").IncomingMessage): Promise<string> {
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SMOKE_RESPONSE_BYTES) {
    throw new Error("Fallback smoke test response exceeded the 2 MiB safety limit.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_SMOKE_RESPONSE_BYTES) {
      response.destroy();
      throw new Error("Fallback smoke test response exceeded the 2 MiB safety limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function smokeTestFallback(options: {
  config: RouterConfig;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): Promise<SmokeTestResult> {
  const model = options.model.trim();
  if (!model) throw new Error("A model is required for the fallback smoke test.");
  const target = fallbackResponsesUrl(options.config);
  let response: import("node:http").IncomingMessage;
  const requestBody = Buffer.from(JSON.stringify({
    model,
    input: "Reply with exactly: OK",
    max_output_tokens: 16,
    store: false,
    stream: false,
  }));
  try {
    response = await openUpstreamRequest({
      target,
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "content-length": requestBody.length,
      },
      body: requestBody,
      timeoutMs: options.timeoutMs ?? SMOKE_TIMEOUT_MS,
      ...(options.config.upstreamProxyUrl ? { proxyUrl: options.config.upstreamProxyUrl } : {}),
    });
  } catch (error) {
    throw new Error(
      `Fallback smoke test failed before receiving an HTTP response (${safeNetworkCode(error)}).`,
    );
  }

  const responseText = await readLimitedResponse(response);
  const status = response.statusCode ?? 502;
  if (status < 200 || status >= 300) {
    throw new Error(`Fallback smoke test failed with HTTP ${status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Fallback smoke test returned a non-JSON success response.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Fallback smoke test returned an invalid Responses API object.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.error) throw new Error("Fallback smoke test returned an error object with HTTP success.");
  const responseIdPresent = typeof record.id === "string" && record.id.length > 0;
  if (!responseIdPresent && record.object !== "response" && !Array.isArray(record.output)) {
    throw new Error("Fallback smoke test success was not compatible with the Responses API schema.");
  }
  return {
    endpoint: target.origin + target.pathname,
    model,
    status,
    responseIdPresent,
  };
}

export async function runConfiguredSmokeTest(options: {
  model?: string;
  paths?: AppPaths;
} = {}): Promise<SmokeTestResult> {
  const paths = options.paths ?? getAppPaths();
  const config = await readRouterConfig(paths);
  const apiKey = await readApiKey(paths);
  let model = options.model?.trim() || config.fallbackModel?.trim();
  if (!model) {
    model = inspectRootModel(await readCodexConfig(paths.codexConfigFile));
  }
  if (!model) {
    throw new Error("No current model was found; pass one with 'smoke-test --model <id>'.");
  }
  return smokeTestFallback({ config, apiKey, model });
}
