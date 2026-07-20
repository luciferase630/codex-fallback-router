import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  MARKETPLACE_NAME,
  TESTED_CODEX_DESKTOP_VERSION,
} from "./constants.js";
import {
  backupConfig,
  contentHash,
  editModelProviderBaseUrl,
  editRootConfig,
  inspectModelProviderConfig,
  inspectRootConfig,
  inspectRootModelProvider,
  readCodexConfig,
  restoreRootConfig,
  restoreModelProviderBaseUrl,
  writeCodexConfig,
  type RootConfigValues,
} from "./codex-config.js";
import { readRouterConfig } from "./config.js";
import { readApiKey } from "./dpapi.js";
import { getHealth, startDaemon, stopDaemon } from "./daemon.js";
import { atomicWriteFile, ensureParent, pathExists } from "./file-utils.js";
import { detectCodexDesktopVersion, runCodex } from "./platform.js";
import { installLocalPlugin, uninstallLocalPlugin } from "./plugin-lifecycle.js";
import { getAppPaths, locateSourceTree, type AppPaths } from "./paths.js";

export interface InstallState {
  version: 1 | 2;
  installedAt: string;
  codexDesktopVersion: string;
  backupFile: string;
  original: RootConfigValues;
  providerId?: string;
  originalProviderBaseUrl?: string;
  installedConfigHash: string;
  marketplaceRoot: string;
}

async function readInstallState(paths: AppPaths): Promise<InstallState | undefined> {
  if (!(await pathExists(paths.stateFile))) return undefined;
  return JSON.parse(await readFile(paths.stateFile, "utf8")) as InstallState;
}

async function registerMarketplace(repoRoot: string): Promise<void> {
  const result = await runCodex(
    ["-c", 'service_tier="fast"', "plugin", "marketplace", "add", repoRoot],
    { allowFailure: true },
  );
  if (result.code !== 0 && !/already|exists|configured/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to register the local marketplace: ${result.stderr.trim()}`);
  }
}

async function installRuntimeCli(
  sourceCli: string,
  paths: AppPaths,
  useCodexNamedRuntime: boolean,
): Promise<void> {
  await ensureParent(paths.runtimeCli);
  await copyFile(sourceCli, paths.runtimeCli);
  if (useCodexNamedRuntime) {
    await copyFile(process.execPath, paths.runtimeNode);
  } else {
    await rm(paths.runtimeNode, { force: true });
  }
  await ensureParent(paths.commandShim);
  const runtimeCommand = useCodexNamedRuntime
    ? `"%LOCALAPPDATA%\\codex-fallback-router\\bin\\codex.exe"`
    : "node";
  const runtimeCli = `"%LOCALAPPDATA%\\codex-fallback-router\\bin\\cli.mjs"`;
  const shim = `@echo off\r\n${runtimeCommand} ${runtimeCli} %*\r\n`;
  await writeFile(paths.commandShim, shim, "ascii");
}

export async function installRouter(options: {
  allowUntestedVersion: boolean;
  sourceCli?: string;
  paths?: AppPaths;
}): Promise<{ version: string; restartRequired: boolean }> {
  const paths = options.paths ?? getAppPaths();
  const sourceCli = options.sourceCli ?? process.argv[1];
  if (!sourceCli) throw new Error("Cannot locate the built CLI. Run 'npm run build' first.");
  const initialRouterConfig = await readRouterConfig(paths);
  await readApiKey(paths);

  const detectedVersion = await detectCodexDesktopVersion();
  if (!detectedVersion) throw new Error("Codex Desktop installation was not detected.");
  if (detectedVersion !== TESTED_CODEX_DESKTOP_VERSION && !options.allowUntestedVersion) {
    throw new Error(
      `Codex Desktop ${detectedVersion} is untested; expected ${TESTED_CODEX_DESKTOP_VERSION}. ` +
        "Re-run with --allow-untested-version only after reviewing compatibility.",
    );
  }

  const sourceTree = locateSourceTree(sourceCli);
  if (!(await pathExists(sourceTree.marketplaceFile))) {
    throw new Error("Local marketplace manifest was not found next to the plugin source.");
  }
  const initialText = await readCodexConfig(paths.codexConfigFile);
  const previousState = await readInstallState(paths);
  const providerId = inspectRootModelProvider(initialText);
  if (!providerId) throw new Error("Codex root model_provider is missing; model traffic cannot be routed safely.");
  const providerConfig = inspectModelProviderConfig(initialText, providerId);
  if (providerConfig.wireApi !== "responses" || providerConfig.requiresOpenAiAuth !== true) {
    throw new Error(
      `Active model provider '${providerId}' is not a ChatGPT-authenticated Responses provider.`,
    );
  }
  const original = previousState?.original ?? inspectRootConfig(initialText);
  const backupFile = previousState?.backupFile ?? (await backupConfig(paths.codexConfigFile, paths.backupDir));
  const wasRunning = Boolean(await getHealth(paths));
  let pluginInstalled = false;
  let daemonStarted = false;
  try {
    await registerMarketplace(sourceTree.repoRoot);
    await installLocalPlugin(sourceTree.marketplaceFile);
    pluginInstalled = true;
    await installRuntimeCli(sourceCli, paths, Boolean(initialRouterConfig.upstreamProxyUrl));
    await startDaemon({ quiet: true, paths, cliPath: paths.runtimeCli });
    daemonStarted = !wasRunning;

    const routerConfig = await readRouterConfig(paths);
    const localBase = `http://${routerConfig.listenHost}:${routerConfig.listenPort}/backend-api/codex`;
    const currentText = await readCodexConfig(paths.codexConfigFile);
    const rootEdit = editRootConfig(currentText, {
      chatgptBaseUrl: localBase,
      disableResponseStorage: true,
    });
    const providerEdit = editModelProviderBaseUrl(rootEdit.editedText, providerId, localBase);
    const editedText = providerEdit.editedText;
    await writeCodexConfig(paths.codexConfigFile, editedText);
    const state: InstallState = {
      version: 2,
      installedAt: previousState?.installedAt ?? new Date().toISOString(),
      codexDesktopVersion: detectedVersion,
      backupFile,
      original,
      providerId,
      ...(providerEdit.originalBaseUrl !== undefined
        ? { originalProviderBaseUrl: providerEdit.originalBaseUrl }
        : {}),
      installedConfigHash: contentHash(editedText),
      marketplaceRoot: sourceTree.repoRoot,
    };
    await atomicWriteFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    if (daemonStarted) {
      try {
        await stopDaemon(paths);
      } catch {
        // Continue restoring Codex even if the just-started daemon does not stop cleanly.
      }
    }
    await writeCodexConfig(paths.codexConfigFile, initialText);
    if (previousState) {
      await atomicWriteFile(paths.stateFile, `${JSON.stringify(previousState, null, 2)}\n`);
    } else {
      await rm(paths.stateFile, { force: true });
      await rm(paths.commandShim, { force: true });
      await rm(paths.runtimeCli, { force: true });
      await rm(paths.runtimeNode, { force: true });
      if (pluginInstalled) {
        try {
          await uninstallLocalPlugin();
        } catch {
          // Best-effort removal continues with the marketplace registration.
        }
      }
      await runCodex(
        ["-c", 'service_tier="fast"', "plugin", "marketplace", "remove", MARKETPLACE_NAME],
        { allowFailure: true },
      );
    }
    throw new Error(`Installation failed and was rolled back. ${(error as Error).message}`);
  }
  return { version: detectedVersion, restartRequired: true };
}

export async function uninstallRouter(options: {
  keepSecret: boolean;
  paths?: AppPaths;
}): Promise<{ restored: boolean }> {
  const paths = options.paths ?? getAppPaths();
  const state = await readInstallState(paths);
  let restored = false;
  if (state && (await pathExists(paths.codexConfigFile))) {
    const currentText = await readCodexConfig(paths.codexConfigFile);
    if (contentHash(currentText) === state.installedConfigHash && (await pathExists(state.backupFile))) {
      await copyFile(state.backupFile, paths.codexConfigFile);
    } else {
      let restoredText = restoreRootConfig(currentText, state.original);
      if (state.providerId) {
        restoredText = restoreModelProviderBaseUrl(
          restoredText,
          state.providerId,
          state.originalProviderBaseUrl,
        );
      }
      await writeCodexConfig(paths.codexConfigFile, restoredText);
    }
    restored = true;
  }
  if (state) {
    try {
      await uninstallLocalPlugin();
    } catch {
      // Continue restoring local configuration even if plugin cache cleanup fails.
    }
    await runCodex(
      ["-c", 'service_tier="fast"', "plugin", "marketplace", "remove", MARKETPLACE_NAME],
      { allowFailure: true },
    );
  }
  await rm(paths.stateFile, { force: true });
  await rm(paths.pidFile, { force: true });
  await rm(paths.commandShim, { force: true });
  await rm(paths.runtimeNode, { force: true });
  if (!options.keepSecret) await rm(paths.secretFile, { force: true });
  return { restored };
}
