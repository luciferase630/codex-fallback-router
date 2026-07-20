const STRONG_CODES = new Set([
  "usagelimitexceeded",
  "workspaceownercreditsdepleted",
  "workspacemembercreditsdepleted",
  "workspaceownerusagelimitreached",
  "workspacememberusagelimitreached",
  "insufficientquota",
]);

const MESSAGE_PATTERNS = [
  /usage limit (?:has been )?(?:reached|exceeded)/i,
  /weekly limit (?:has been )?(?:reached|exceeded)/i,
  /credits? (?:are |have been )?depleted/i,
  /no (?:more )?credits? remaining/i,
  /limit reached.*reset/i,
];

export interface QuotaDecision {
  isQuotaExhausted: boolean;
  resetAt?: number;
}

function collectValues(value: unknown, strings: string[], resetCandidates: unknown[]): void {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, strings, resetCandidates);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
    if (["resetsat", "resetat", "resettime", "resetstime"].includes(normalizedKey)) {
      resetCandidates.push(child);
    }
    collectValues(child, strings, resetCandidates);
  }
}

function parseResetAt(candidates: unknown[], now: number): number | undefined {
  for (const candidate of candidates) {
    let timestamp: number | undefined;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      timestamp = candidate > 10_000_000_000 ? candidate : candidate * 1000;
    } else if (typeof candidate === "string") {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && candidate.trim() !== "") {
        timestamp = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      } else {
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) timestamp = parsed;
      }
    }
    if (timestamp !== undefined && timestamp > now) return timestamp;
  }
  return undefined;
}

export function classifyQuotaResponse(
  statusCode: number,
  body: Buffer | string,
  now = Date.now(),
): QuotaDecision {
  if (statusCode !== 429 && statusCode !== 403) return { isQuotaExhausted: false };
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const strings: string[] = [];
  const resetCandidates: unknown[] = [];
  collectValues(parsed ?? text, strings, resetCandidates);
  const normalizedStrings = strings.map((value) => value.replace(/[_-]/g, "").toLowerCase());
  const hasStrongCode = normalizedStrings.some((value) => STRONG_CODES.has(value));
  const hasStrongMessage = strings.some((value) => MESSAGE_PATTERNS.some((pattern) => pattern.test(value)));
  if (!hasStrongCode && !hasStrongMessage) return { isQuotaExhausted: false };
  const resetAt = parseResetAt(resetCandidates, now);
  return {
    isQuotaExhausted: true,
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

export function classifyQuotaSseEvent(event: Buffer, now = Date.now()): QuotaDecision {
  const text = event.toString("utf8");
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  for (const data of dataLines) {
    const decision = classifyQuotaResponse(429, data, now);
    if (decision.isQuotaExhausted) return decision;
  }
  return { isQuotaExhausted: false };
}
