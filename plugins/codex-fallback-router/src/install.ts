import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  MARKETPLACE_NAME,
  TESTED_CODEX_DESKTOP_VERSION,
} from "./constants.js";
import {
  backupConfig,
  contentHash,
  editRootConfig,
  inspectRootConfig,
  readCodexConfig,
  restoreRootConfig,
  writeCodexConfig,
  type RootConfigValues,
} from "./codex-config.js";
import { readRouterConfig } from "./config.js";
import { readApiKey } from "./dpapi.js";
import { startDaemon } from "./daemon.js";
import { atomicWriteFile, ensureParent, pathExists } from "./file-utils.js";
import { detectCodexDesktopVersion, runCodex } from "./platform.js";
import { installLocalPlugin, uninstallLocalPlugin } from "./plugin-lifecycle.js";
import { getAppPaths, locateSourceTree, type AppPaths } from "./paths.js";

export interface InstallState {
  version: 1;
  installedAt: string;
  codexDesktopVersion: string;
  backupFile: string;
  original: RootConfigValues;
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

async function installRuntimeCli(sourceCli: string, paths: AppPaths): Promise<void> {
  await ensureParent(paths.runtimeCli);
  await copyFile(sourceCli, paths.runtimeCli);
  await ensureParent(paths.commandShim);
  const shim = `@echo off\r\nnode "${paths.runtimeCli}" %*\r\n`;
  await writeFile(paths.commandShim, shim, "utf8");
}

export async function installRouter(options: {
  allowUntestedVersion: boolean;
  sourceCli?: string;
  paths?: AppPaths;
}): Promise<{ version: string; restartRequired: boolean }> {
  const paths = options.paths ?? getAppPaths();
  const sourceCli = options.sourceCli ?? process.argv[1];
  if (!sourceCli) throw new Error("Cannot locate the built CLI. Run 'npm run build' first.");
  await readRouterConfig(paths);
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
  const original = previousState?.original ?? inspectRootConfig(initialText);
  const backupFile = previousState?.backupFile ?? (await backupConfig(paths.codexConfigFile, paths.backupDir));
  try {
    await registerMarketplace(sourceTree.repoRoot);
    await installLocalPlugin(sourceTree.marketplaceFile);
  } catch (error) {
    await copyFile(backupFile, paths.codexConfigFile);
    throw new Error(`Plugin installation failed; Codex config was restored. ${(error as Error).message}`);
  }
  await installRuntimeCli(sourceCli, paths);

  const routerConfig = await readRouterConfig(paths);
  const localBase = `http://${routerConfig.listenHost}:${routerConfig.listenPort}/backend-api/codex`;
  const currentText = await readCodexConfig(paths.codexConfigFile);
  const { editedText } = editRootConfig(currentText, {
    chatgptBaseUrl: localBase,
    disableResponseStorage: true,
  });
  await writeCodexConfig(paths.codexConfigFile, editedText);
  const state: InstallState = {
    version: 1,
    installedAt: previousState?.installedAt ?? new Date().toISOString(),
    codexDesktopVersion: detectedVersion,
    backupFile,
    original,
    installedConfigHash: contentHash(editedText),
    marketplaceRoot: sourceTree.repoRoot,
  };
  await atomicWriteFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  try {
    await startDaemon({ quiet: true, paths, cliPath: paths.runtimeCli });
  } catch (error) {
    await copyFile(backupFile, paths.codexConfigFile);
    await rm(paths.stateFile, { force: true });
    throw new Error(`Router could not be started; Codex config was restored. ${(error as Error).message}`);
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
      await writeCodexConfig(paths.codexConfigFile, restoreRootConfig(currentText, state.original));
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
  if (!options.keepSecret) await rm(paths.secretFile, { force: true });
  return { restored };
}
