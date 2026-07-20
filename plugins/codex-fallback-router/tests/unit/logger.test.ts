import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { redactLogDetail, SafeLogger } from "../../src/logger.js";

test("redacts credentials even if a caller accidentally supplies them as detail", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-fallback-log-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const logFile = join(root, "router.log");
  const gatewayKey = ["gx", "-", "a".repeat(32)].join("");
  const openAiKey = ["sk", "-", "b".repeat(32)].join("");
  const detail = `Authorization: Bearer ${gatewayKey}; api_key=${openAiKey}`;
  const logger = new SafeLogger(logFile);
  await logger.initialize();
  await logger.write({ event: "synthetic", detail });
  const logged = await readFile(logFile, "utf8");
  assert.doesNotMatch(logged, new RegExp(gatewayKey));
  assert.doesNotMatch(logged, new RegExp(openAiKey));
  assert.match(logged, /REDACTED/);
  assert.equal(redactLogDetail("safe detail"), "safe detail");
});
