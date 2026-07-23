import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { pathExists } from "./file-utils.js";
import { getAppPaths, type AppPaths } from "./paths.js";

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const RUN_VALUE_NAME = "CodexFallbackRouter";

/**
 * Logon watchdog without elevation: an HKCU Run entry starts a hidden
 * watcher at every Windows logon; the watcher runs `watchdog`, which starts
 * the daemon when missing and re-checks it periodically. This covers both
 * reboots (Codex SessionStart hooks only fire for new sessions) and any
 * later daemon death, and it never requires administrator rights.
 * The watcher runs inside the user session, so the DPAPI CurrentUser
 * credential stays decryptable.
 */
export function buildWatchdogVbs(options: { nodePath: string; cliPath: string }): string {
  // VBScript escapes embedded quotes by doubling them; Windows paths cannot
  // contain a literal quote, so no further escaping is required.
  const command = `""${options.nodePath}"" ""${options.cliPath}"" watchdog`;
  return `' Starts the Codex fallback router watchdog without a console window.\r\nCreateObject("Wscript.Shell").Run "${command}", 0, False\r\n`;
}

function runReg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("reg.exe", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`reg ${args.join(" ")} failed (${code}): ${(stderr || stdout).trim()}`));
    });
  });
}

export function watchdogVbsPath(paths: AppPaths): string {
  return join(paths.runtimeDir, "watchdog.vbs");
}

export function buildRunEntry(vbsPath: string): string {
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  return `"${join(systemRoot, "System32", "wscript.exe")}" "${vbsPath}"`;
}

export async function installAutostart(paths: AppPaths = getAppPaths()): Promise<void> {
  if (!(await pathExists(paths.runtimeCli))) {
    throw new Error("The installed CLI is missing; run 'codex-fallback install' first.");
  }
  const nodePath = (await pathExists(paths.runtimeNode)) ? paths.runtimeNode : process.execPath;
  const vbsPath = watchdogVbsPath(paths);
  // UTF-16LE keeps non-ASCII install paths (e.g. CJK user names) valid for VBScript.
  await writeFile(vbsPath, `\ufeff${buildWatchdogVbs({ nodePath, cliPath: paths.runtimeCli })}`, "utf16le");
  await runReg(["add", RUN_KEY, "/v", RUN_VALUE_NAME, "/t", "REG_SZ", "/d", buildRunEntry(vbsPath), "/f"]);
}

export async function uninstallAutostart(): Promise<void> {
  try {
    await runReg(["delete", RUN_KEY, "/v", RUN_VALUE_NAME, "/f"]);
  } catch (error) {
    if (/unable to find|not found|找不到/i.test(String(error))) return;
    throw error;
  }
}

export async function autostartInstalled(): Promise<boolean> {
  try {
    await runReg(["query", RUN_KEY, "/v", RUN_VALUE_NAME]);
    return true;
  } catch {
    return false;
  }
}
