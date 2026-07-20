import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..", "..");
const secretPatterns = [
  { name: "gateway key", pattern: /gx-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI-style key", pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  {
    name: "assigned API key",
    pattern: /api[_-]?key\s*[:=]\s*["'][^"'\r\n]{16,}["']/gi,
  },
];

function findSecrets(text, label) {
  const findings = [];
  for (const { name, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${label}: ${name}`);
  }
  return findings;
}

function stagedText() {
  try {
    return execFileSync(
      "git",
      ["diff", "--cached", "--no-ext-diff", "--unified=0", "--", "."],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    if (error?.status === 1 && typeof error.stdout === "string") return error.stdout;
    throw error;
  }
}

function walk(directory) {
  const results = [];
  for (const entry of readdirSync(directory)) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) results.push(...walk(path));
    else if (stat.size <= 8 * 1024 * 1024) results.push(path);
  }
  return results;
}

const mode = process.argv[2] ?? "--all";
const findings = [];
if (mode === "--self-test") {
  const syntheticGatewayKey = ["gx", "-", "a".repeat(32)].join("");
  const syntheticOpenAiKey = ["sk", "-", "b".repeat(32)].join("");
  if (findSecrets(syntheticGatewayKey, "self-test").length !== 1) {
    throw new Error("Gateway-key detector self-test failed.");
  }
  if (findSecrets(syntheticOpenAiKey, "self-test").length !== 1) {
    throw new Error("OpenAI-style detector self-test failed.");
  }
  if (findSecrets("safe placeholder text", "self-test").length !== 0) {
    throw new Error("Secret scanner produced a false positive for safe text.");
  }
  console.log("Secret scanner self-test passed.");
  process.exit(0);
} else if (mode === "--staged") {
  findings.push(...findSecrets(stagedText(), "staged diff"));
} else if (mode === "--all") {
  for (const path of walk(repoRoot)) {
    try {
      findings.push(...findSecrets(readFileSync(path, "utf8"), path));
    } catch {
      // Ignore binary or transient files that cannot be decoded.
    }
  }
  try {
    const history = execFileSync("git", ["log", "--all", "-p", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    findings.push(...findSecrets(history, "git history"));
  } catch {
    // A new repository has no history yet.
  }
} else {
  throw new Error(`Unknown scan mode: ${mode}`);
}

if (findings.length > 0) {
  console.error("Potential secrets detected:");
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed (${mode}).`);
