import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_NAME } from "./constants.js";

export interface AppPaths {
  runtimeDir: string;
  configFile: string;
  secretFile: string;
  stateFile: string;
  pidFile: string;
  logFile: string;
  backupDir: string;
  runtimeCli: string;
  commandShim: string;
  codexConfigFile: string;
}

export function getAppPaths(environment = process.env): AppPaths {
  const userHome = environment.USERPROFILE || homedir();
  const localAppData = environment.LOCALAPPDATA || join(userHome, "AppData", "Local");
  const runtimeDir = join(localAppData, APP_NAME);
  const localBin = join(userHome, ".local", "bin");
  const codexHome = environment.CODEX_HOME || join(userHome, ".codex");

  return {
    runtimeDir,
    configFile: join(runtimeDir, "config.json"),
    secretFile: join(runtimeDir, "secret.dpapi"),
    stateFile: join(runtimeDir, "install-state.json"),
    pidFile: join(runtimeDir, "router.pid.json"),
    logFile: join(runtimeDir, "router.log"),
    backupDir: join(runtimeDir, "backups"),
    runtimeCli: join(runtimeDir, "bin", "cli.mjs"),
    commandShim: join(localBin, "codex-fallback.cmd"),
    codexConfigFile: join(codexHome, "config.toml"),
  };
}

export function locateSourceTree(cliPath = process.argv[1]): {
  pluginRoot: string;
  repoRoot: string;
  marketplaceFile: string;
} {
  if (!cliPath) throw new Error("Cannot locate the running CLI file.");
  const normalizedCli = resolve(cliPath);
  const pluginRoot = resolve(dirname(normalizedCli), "..");
  const repoRoot = resolve(pluginRoot, "..", "..");
  return {
    pluginRoot,
    repoRoot,
    marketplaceFile: join(repoRoot, ".agents", "plugins", "marketplace.json"),
  };
}

export function moduleDirectory(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

