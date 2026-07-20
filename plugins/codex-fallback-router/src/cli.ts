import { readFile } from "node:fs/promises";

import { CLI_NAME, VERSION } from "./constants.js";
import {
  createRouterConfig,
  normalizeRoutingMode,
  readRouterConfig,
  updateRoutingMode,
  writeRouterConfig,
  type RoutingMode,
} from "./config.js";
import { readApiKey, storeApiKey } from "./dpapi.js";
import { getHealth, runDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { installRouter, uninstallRouter } from "./install.js";
import { assertNodeVersion } from "./platform.js";
import { getAppPaths } from "./paths.js";
import { atomicWriteFile } from "./file-utils.js";
import { runConfiguredSmokeTest } from "./smoke-test.js";

interface ParsedArgs {
  command: string;
  subcommand?: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals > 2) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return {
    command: positional[0] ?? "help",
    ...(positional[1] ? { subcommand: positional[1] } : {}),
    flags,
  };
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function printHelp(): void {
  console.log(`${CLI_NAME} ${VERSION}

Usage:
  ${CLI_NAME} config set --base-url <https-url> (--api-key-stdin | --reuse-api-key) [--responses-path <path>] [--fallback-model <id>] [--upstream-proxy <url>]
  ${CLI_NAME} mode auto
  ${CLI_NAME} mode fallback [--check]
  ${CLI_NAME} mode primary
  ${CLI_NAME} install [--allow-untested-version]
  ${CLI_NAME} start [--quiet]
  ${CLI_NAME} stop
  ${CLI_NAME} status
  ${CLI_NAME} smoke-test [--model <id>]
  ${CLI_NAME} uninstall [--keep-secret]
`);
}

async function existingRoutingMode(): Promise<RoutingMode> {
  try {
    return (await readRouterConfig(getAppPaths())).routingMode;
  } catch {
    return "auto";
  }
}

async function handleConfigSet(args: ParsedArgs): Promise<void> {
  const baseUrl = stringFlag(args, "base-url");
  if (!baseUrl) throw new Error("--base-url is required.");
  const keyFromStdin = booleanFlag(args, "api-key-stdin");
  const reuseApiKey = booleanFlag(args, "reuse-api-key");
  if (keyFromStdin === reuseApiKey) {
    throw new Error("Use exactly one of --api-key-stdin or --reuse-api-key.");
  }
  const portRaw = stringFlag(args, "port");
  const responsesPath = stringFlag(args, "responses-path");
  const fallbackModel = stringFlag(args, "fallback-model");
  const upstreamProxyUrl = stringFlag(args, "upstream-proxy");
  const paths = getAppPaths();
  const config = createRouterConfig({
    baseUrl,
    ...(responsesPath ? { responsesPath } : {}),
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(portRaw ? { listenPort: Number.parseInt(portRaw, 10) } : {}),
    routingMode: await existingRoutingMode(),
    ...(upstreamProxyUrl ? { upstreamProxyUrl } : {}),
  });
  if (reuseApiKey) await readApiKey(paths);
  const secret = keyFromStdin ? await readStdin() : undefined;
  const wasRunning = await getHealth(paths);
  const previousConfig = wasRunning ? await readFile(paths.configFile) : undefined;
  const previousSecret = wasRunning ? await readFile(paths.secretFile) : undefined;
  if (wasRunning) await stopDaemon(paths);
  try {
    if (secret !== undefined) await storeApiKey(paths, secret);
    await writeRouterConfig(paths, config);
    if (wasRunning) await startDaemon({ quiet: true, paths });
  } catch (error) {
    if (wasRunning && previousConfig && previousSecret) {
      try {
        await atomicWriteFile(paths.configFile, previousConfig);
        await atomicWriteFile(paths.secretFile, previousSecret);
        await startDaemon({ quiet: true, paths });
      } catch {
        // Preserve the original configuration error as the actionable failure.
      }
    }
    throw error;
  }
  console.log(`Configuration saved for ${new URL(config.fallbackBaseUrl).origin}; API key stored with DPAPI.`);
}

async function handleMode(args: ParsedArgs): Promise<void> {
  if (!args.subcommand) throw new Error("Routing mode is required: auto, fallback, or primary.");
  const routingMode = normalizeRoutingMode(args.subcommand);
  const shouldCheck = booleanFlag(args, "check");
  if (shouldCheck && routingMode !== "fallback") {
    throw new Error("--check is only supported with 'mode fallback'.");
  }
  const paths = getAppPaths();
  await updateRoutingMode(
    paths,
    routingMode,
    shouldCheck ? async () => runConfiguredSmokeTest({ paths }) : undefined,
  );
  console.log(
    routingMode === "fallback"
      ? `Routing mode set to fallback${shouldCheck ? " after a successful provider check" : ""}. ChatGPT account services remain connected.`
      : `Routing mode set to ${routingMode}.`,
  );
}

async function main(): Promise<void> {
  assertNodeVersion();
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "--version" || args.command === "version") {
    console.log(VERSION);
    return;
  }
  if (args.command === "help" || args.command === "--help") {
    printHelp();
    return;
  }
  if (args.command === "config" && args.subcommand === "set") {
    await handleConfigSet(args);
    return;
  }
  if (args.command === "mode") {
    await handleMode(args);
    return;
  }
  if (args.command === "install") {
    const result = await installRouter({ allowUntestedVersion: booleanFlag(args, "allow-untested-version") });
    console.log(`Installed for Codex Desktop ${result.version}. Restart Codex Desktop once.`);
    return;
  }
  if (args.command === "uninstall") {
    await stopDaemon();
    const result = await uninstallRouter({ keepSecret: booleanFlag(args, "keep-secret") });
    console.log(result.restored ? "Codex configuration restored." : "No installed configuration was found.");
    return;
  }
  if (args.command === "start") {
    const health = await startDaemon({ quiet: booleanFlag(args, "quiet") });
    if (!booleanFlag(args, "quiet")) console.log(`Router is running (PID ${health.pid}, mode ${health.mode}).`);
    return;
  }
  if (args.command === "stop") {
    const stopped = await stopDaemon();
    console.log(stopped ? "Router stopped." : "Router was not running.");
    return;
  }
  if (args.command === "status") {
    const health = await getHealth();
    if (!health) throw new Error("Router is not running.");
    console.log(JSON.stringify(health, null, 2));
    return;
  }
  if (args.command === "daemon") {
    await runDaemon();
    return;
  }
  if (args.command === "smoke-test") {
    const model = stringFlag(args, "model");
    const result = await runConfiguredSmokeTest({
      ...(model ? { model } : {}),
    });
    console.log(
      `Fallback smoke test passed (HTTP ${result.status}, model ${result.model}, endpoint ${result.endpoint}).`,
    );
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
