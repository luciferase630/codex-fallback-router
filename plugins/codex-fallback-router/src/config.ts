import { readFile } from "node:fs/promises";

import {
  CONFIG_VERSION,
  DEFAULT_HOST,
  DEFAULT_LATCH_MINUTES,
  DEFAULT_PORT,
  OFFICIAL_CHATGPT_BASE_URL,
} from "./constants.js";
import { atomicWriteFile, pathExists } from "./file-utils.js";
import type { AppPaths } from "./paths.js";

export interface RouterConfig {
  version: number;
  fallbackBaseUrl: string;
  fallbackResponsesPath: string;
  fallbackModel?: string;
  listenHost: string;
  listenPort: number;
  officialBaseUrl: string;
  latchMinutes: number;
  upstreamProxyUrl?: string;
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Fallback base URL is required.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Fallback base URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Fallback base URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Fallback base URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Fallback base URL must not contain a query or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function normalizeResponsesPath(raw: string | undefined, baseUrl: string): string {
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) {
      throw new Error("Responses path must start with '/' and contain no query or fragment.");
    }
    return trimmed.replace(/\/{2,}/g, "/");
  }
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  return basePath.endsWith("/v1") ? "/responses" : "/v1/responses";
}

export function normalizeUpstreamProxyUrl(raw: string): string {
  let proxy: URL;
  try {
    proxy = new URL(raw.trim());
  } catch {
    throw new Error("Upstream proxy URL is not valid.");
  }
  if (proxy.protocol !== "http:") throw new Error("Upstream proxy must use HTTP CONNECT.");
  if (proxy.username || proxy.password) throw new Error("Upstream proxy URL must not contain credentials.");
  if (!['127.0.0.1', 'localhost', '::1'].includes(proxy.hostname)) {
    throw new Error("Upstream proxy must be a loopback address.");
  }
  const port = Number(proxy.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Upstream proxy URL must include a valid port.");
  }
  if ((proxy.pathname && proxy.pathname !== "/") || proxy.search || proxy.hash) {
    throw new Error("Upstream proxy URL must not contain a path, query, or fragment.");
  }
  return proxy.origin;
}

export function createRouterConfig(options: {
  baseUrl: string;
  responsesPath?: string;
  fallbackModel?: string;
  listenPort?: number;
  upstreamProxyUrl?: string;
}): RouterConfig {
  const fallbackBaseUrl = normalizeBaseUrl(options.baseUrl);
  const listenPort = options.listenPort ?? DEFAULT_PORT;
  if (!Number.isInteger(listenPort) || listenPort < 1024 || listenPort > 65535) {
    throw new Error("Listen port must be an integer between 1024 and 65535.");
  }
  const fallbackModel = options.fallbackModel?.trim();
  return {
    version: CONFIG_VERSION,
    fallbackBaseUrl,
    fallbackResponsesPath: normalizeResponsesPath(options.responsesPath, fallbackBaseUrl),
    ...(fallbackModel ? { fallbackModel } : {}),
    listenHost: DEFAULT_HOST,
    listenPort,
    officialBaseUrl: OFFICIAL_CHATGPT_BASE_URL,
    latchMinutes: DEFAULT_LATCH_MINUTES,
    ...(options.upstreamProxyUrl
      ? { upstreamProxyUrl: normalizeUpstreamProxyUrl(options.upstreamProxyUrl) }
      : {}),
  };
}

export async function writeRouterConfig(paths: AppPaths, config: RouterConfig): Promise<void> {
  await atomicWriteFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export async function readRouterConfig(paths: AppPaths): Promise<RouterConfig> {
  if (!(await pathExists(paths.configFile))) {
    throw new Error("Router is not configured. Run 'codex-fallback config set' first.");
  }
  const parsed = JSON.parse(await readFile(paths.configFile, "utf8")) as Partial<RouterConfig>;
  if (parsed.version !== CONFIG_VERSION) throw new Error("Unsupported router configuration version.");
  if (
    typeof parsed.fallbackBaseUrl !== "string" ||
    typeof parsed.fallbackResponsesPath !== "string" ||
    parsed.listenHost !== DEFAULT_HOST ||
    typeof parsed.listenPort !== "number" ||
    typeof parsed.officialBaseUrl !== "string" ||
    typeof parsed.latchMinutes !== "number"
  ) {
    throw new Error("Router configuration is incomplete or invalid.");
  }
  normalizeBaseUrl(parsed.fallbackBaseUrl);
  normalizeResponsesPath(parsed.fallbackResponsesPath, parsed.fallbackBaseUrl);
  if (parsed.upstreamProxyUrl !== undefined) normalizeUpstreamProxyUrl(parsed.upstreamProxyUrl);
  return parsed as RouterConfig;
}

export function fallbackResponsesUrl(config: RouterConfig): URL {
  const base = new URL(config.fallbackBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const responsePath = config.fallbackResponsesPath;
  if (basePath.endsWith("/v1") && responsePath === "/responses") {
    base.pathname = `${basePath}/responses`;
  } else {
    base.pathname = `${basePath}${responsePath}`.replace(/\/{2,}/g, "/");
  }
  return base;
}
