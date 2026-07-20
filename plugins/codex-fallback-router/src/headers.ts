import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function primaryRequestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host") continue;
    if (value !== undefined) output[lower] = value;
  }
  return output;
}

export function fallbackRequestHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string,
  bodyLength: number,
): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "content-length" ||
      lower === "origin" ||
      lower === "referer" ||
      lower === "chatgpt-account-id" ||
      lower.startsWith("x-openai-") ||
      lower.startsWith("openai-")
    ) {
      continue;
    }
    if (value !== undefined) output[lower] = value;
  }
  output.authorization = `Bearer ${apiKey}`;
  output["content-length"] = bodyLength;
  output["content-type"] = headers["content-type"] ?? "application/json";
  output.accept = headers.accept ?? "text/event-stream";
  return output;
}

export function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
    if (value !== undefined) output[lower] = value;
  }
  return output;
}

