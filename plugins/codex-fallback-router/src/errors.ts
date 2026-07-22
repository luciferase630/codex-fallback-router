export function safeNetworkCode(error: unknown): string {
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
