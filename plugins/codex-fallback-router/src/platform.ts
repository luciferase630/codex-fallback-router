import { spawn } from "node:child_process";

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(`${command} failed (${result.code}): ${result.stderr.trim()}`));
    });
    child.stdin.end(options.input ?? "", "utf8");
  });
}

export async function detectCodexDesktopVersion(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  const script =
    "(Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version)";
  const result = await runProcess(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { allowFailure: true },
  );
  const version = result.stdout.trim();
  return version || undefined;
}

export async function runCodex(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (process.platform === "win32") {
    return runProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "codex", ...args], options);
  }
  return runProcess("codex", args, options);
}

export function assertNodeVersion(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 22) throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
}
