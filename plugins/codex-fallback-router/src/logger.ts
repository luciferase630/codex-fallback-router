import { appendFile, stat, truncate } from "node:fs/promises";

import { ensureParent } from "./file-utils.js";

export interface RouterLogEvent {
  event: string;
  requestId?: string;
  provider?: "primary" | "fallback";
  status?: number;
  durationMs?: number;
  detail?: string;
}

export class SafeLogger {
  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    await ensureParent(this.path);
    try {
      const info = await stat(this.path);
      if (info.size > 5 * 1024 * 1024) await truncate(this.path, 0);
    } catch {
      // The log file is created on first append.
    }
  }

  async write(event: RouterLogEvent): Promise<void> {
    const safe = {
      timestamp: new Date().toISOString(),
      event: event.event,
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.provider ? { provider: event.provider } : {}),
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.detail ? { detail: event.detail.slice(0, 160) } : {}),
    };
    await appendFile(this.path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

