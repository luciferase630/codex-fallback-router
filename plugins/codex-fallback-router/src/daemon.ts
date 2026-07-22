import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

import { VERSION } from "./constants.js";
import { normalizeRoutingMode, readRouterConfig, type RoutingMode } from "./config.js";
import { readApiKey } from "./dpapi.js";
import { safeNetworkCode } from "./errors.js";
import { atomicWriteFile, pathExists } from "./file-utils.js";
import { SafeLogger } from "./logger.js";
import { getAppPaths, type AppPaths } from "./paths.js";
import { createRouterServer } from "./proxy.js";

interface PidState {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

async function readMatchingPidState(paths: AppPaths, health: HealthStatus): Promise<PidState | undefined> {
  try {
    const state = JSON.parse(await readFile(paths.pidFile, "utf8")) as Partial<PidState>;
    if (state.pid !== health.pid || typeof state.port !== "number") return undefined;
    return state as PidState;
  } catch {
    return undefined;
  }
}

async function waitForManagedHealth(paths: AppPaths, deadline: number): Promise<HealthStatus | undefined> {
  while (Date.now() < deadline) {
    const health = await getHealth(paths);
    if (health && (await readMatchingPidState(paths, health))) return health;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export interface HealthStatus {
  ok: true;
  pid: number;
  version: string;
  mode: "primary" | "fallback";
  routingMode: RoutingMode;
  fallbackUntil?: string;
}

export async function getHealth(paths: AppPaths = getAppPaths()): Promise<HealthStatus | undefined> {
  let config;
  try {
    config = await readRouterConfig(paths);
  } catch {
    return undefined;
  }
  try {
    const response = await fetch(
      `http://${config.listenHost}:${config.listenPort}/_codex-fallback/health`,
      { signal: AbortSignal.timeout(1_500), cache: "no-store" },
    );
    if (!response.ok) return undefined;
    const parsed = (await response.json()) as Partial<HealthStatus>;
    if (
      parsed.ok !== true ||
      typeof parsed.pid !== "number" ||
      (parsed.mode !== "primary" && parsed.mode !== "fallback")
    ) return undefined;
    return { ...(parsed as HealthStatus), routingMode: normalizeRoutingMode(parsed.routingMode) };
  } catch {
    return undefined;
  }
}

export async function runDaemon(paths: AppPaths = getAppPaths()): Promise<void> {
  const config = await readRouterConfig(paths);
  const apiKey = await readApiKey(paths);
  const logger = new SafeLogger(paths.logFile);
  await logger.initialize();
  // A local loopback router must never die silently: log unexpected failures
  // with a sanitized detail code and keep serving. Startup errors still
  // surface normally because these handlers are registered before listen.
  process.on("uncaughtException", (error) => {
    void logger.write({
      event: "daemon_uncaught",
      detail: `uncaughtException ${safeNetworkCode(error)}`,
    });
  });
  process.on("unhandledRejection", (reason) => {
    void logger.write({
      event: "daemon_uncaught",
      detail: `unhandledRejection ${safeNetworkCode(reason)}`,
    });
  });
  const runtime = await createRouterServer({
    config,
    apiKey,
    logger,
    getRoutingMode: async () => (await readRouterConfig(paths)).routingMode,
    health: (routingMode, activeProvider) => ({
      ok: true,
      pid: process.pid,
      version: VERSION,
      mode: activeProvider,
      routingMode,
      ...(routingMode === "auto" && runtime.latch.until
        ? { fallbackUntil: new Date(runtime.latch.until).toISOString() }
        : {}),
    }),
  });
  await new Promise<void>((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(config.listenPort, config.listenHost, () => resolve());
  });
  const pidState: PidState = {
    pid: process.pid,
    port: config.listenPort,
    startedAt: new Date().toISOString(),
    version: VERSION,
  };
  await atomicWriteFile(paths.pidFile, `${JSON.stringify(pidState, null, 2)}\n`);
  await logger.write({ event: "daemon_started" });

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
  await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
  await rm(paths.pidFile, { force: true });
  await logger.write({ event: "daemon_stopped" });
}

export async function startDaemon(options: {
  quiet: boolean;
  paths?: AppPaths;
  cliPath?: string;
}): Promise<HealthStatus> {
  const paths = options.paths ?? getAppPaths();
  const existing = await getHealth(paths);
  if (existing) {
    const managed = await waitForManagedHealth(paths, Date.now() + 2_000);
    if (managed) return managed;
    throw new Error("Router is healthy but its PID file is missing or inconsistent.");
  }
  await readRouterConfig(paths);
  await readApiKey(paths);
  const preferredCli = (await pathExists(paths.runtimeCli)) ? paths.runtimeCli : options.cliPath ?? process.argv[1];
  if (!preferredCli) throw new Error("Cannot locate the CLI bundle for daemon startup.");
  const daemonExecutable = (await pathExists(paths.runtimeNode)) ? paths.runtimeNode : process.execPath;
  const child = spawn(daemonExecutable, [preferredCli, "daemon"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  const health = await waitForManagedHealth(paths, deadline);
  if (health) return health;
  throw new Error("Router daemon did not become healthy within 8 seconds.");
}

export async function stopDaemon(paths: AppPaths = getAppPaths()): Promise<boolean> {
  let health = await getHealth(paths);
  if (!health) {
    await rm(paths.pidFile, { force: true });
    return false;
  }
  let state = await readMatchingPidState(paths, health);
  if (!state) {
    health = (await waitForManagedHealth(paths, Date.now() + 2_000)) ?? health;
    state = await readMatchingPidState(paths, health);
  }
  if (!state) throw new Error("Router is healthy but its PID file is missing or inconsistent.");
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!(await getHealth(paths))) {
      await rm(paths.pidFile, { force: true });
      return true;
    }
  }
  throw new Error("Router daemon did not stop within 5 seconds.");
}
