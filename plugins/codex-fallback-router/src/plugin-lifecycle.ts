import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { PLUGIN_ID, PLUGIN_NAME } from "./constants.js";
import { spawnCodex } from "./platform.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class AppServerClient {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #pending = new Map<number, PendingRequest>();

  constructor() {
    this.child = spawnCodex([
      "-c",
      'service_tier="fast"',
      "app-server",
      "--listen",
      "stdio://",
    ]);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8_000);
    });
    this.child.on("error", (error) => this.#rejectAll(error));
    this.child.on("exit", (code) => {
      if (this.#pending.size > 0) {
        this.#rejectAll(new Error(`Codex app-server exited (${code ?? "unknown"}): ${this.#stderr.trim()}`));
      }
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`App-server request failed: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "codex-fallback-router-installer", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1_500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function installLocalPlugin(marketplaceFile: string): Promise<void> {
  const client = new AppServerClient();
  try {
    await client.initialize();
    await client.request("plugin/install", {
      pluginName: PLUGIN_NAME,
      marketplacePath: marketplaceFile,
    });
  } finally {
    await client.close();
  }
}

export async function uninstallLocalPlugin(): Promise<void> {
  const client = new AppServerClient();
  try {
    await client.initialize();
    await client.request("plugin/uninstall", { pluginId: PLUGIN_ID });
  } finally {
    await client.close();
  }
}

