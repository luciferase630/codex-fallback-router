import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { DPAPI_ENTROPY } from "./constants.js";
import { atomicWriteFile, pathExists } from "./file-utils.js";
import type { AppPaths } from "./paths.js";

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')
$cipher = [Convert]::FromBase64String($encoded.Trim())
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`;

async function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`DPAPI helper failed: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
    child.stdin.end(input, "utf8");
  });
}

export function validateApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 20) throw new Error("API key is empty or unexpectedly short.");
  if (/\s/.test(key)) throw new Error("API key must not contain whitespace.");
  return key;
}

export async function storeApiKey(paths: AppPaths, raw: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("DPAPI storage is supported only on Windows.");
  const key = validateApiKey(raw);
  const protectedValue = await runPowerShell(PROTECT_SCRIPT, key);
  await atomicWriteFile(paths.secretFile, `${protectedValue.trim()}\n`);
}

export async function readApiKey(paths: AppPaths): Promise<string> {
  if (!(await pathExists(paths.secretFile))) {
    throw new Error("Encrypted API key is missing. Run 'codex-fallback config set' first.");
  }
  const protectedValue = await readFile(paths.secretFile, "utf8");
  return validateApiKey(await runPowerShell(UNPROTECT_SCRIPT, protectedValue));
}

