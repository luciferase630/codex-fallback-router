import assert from "node:assert/strict";
import test from "node:test";

import { buildRunEntry, buildWatchdogVbs } from "../../src/autostart.js";
import { runWatchdog } from "../../src/daemon.js";

test("watchdog VBS launches the CLI watchdog command without a window", () => {
  const vbs = buildWatchdogVbs({
    nodePath: "C:\\Users\\tester\\AppData\\Local\\codex-fallback-router\\bin\\codex.exe",
    cliPath: "C:\\Users\\tester\\AppData\\Local\\codex-fallback-router\\bin\\cli.mjs",
  });
  assert.match(vbs, /Wscript\.Shell/);
  assert.match(vbs, /, 0, False/);
  assert.match(vbs, /""C:\\Users\\tester\\AppData\\Local\\codex-fallback-router\\bin\\codex\.exe""/);
  assert.match(vbs, /""C:\\Users\\tester\\AppData\\Local\\codex-fallback-router\\bin\\cli\.mjs"" watchdog/);
});

test("watchdog VBS keeps non-ASCII paths literal (file is stored UTF-16)", () => {
  const vbs = buildWatchdogVbs({
    nodePath: "C:\\Users\\方镐翔\\codex.exe",
    cliPath: "C:\\Users\\方镐翔\\cli.mjs",
  });
  assert.match(vbs, /方镐翔/);
});

test("run entry points at wscript with the quoted VBS path", () => {
  const entry = buildRunEntry("C:\\Users\\tester\\watchdog.vbs");
  assert.match(entry, /^".*System32\\wscript\.exe" "C:\\Users\\tester\\watchdog\.vbs"$/);
});

test("watchdog restarts the daemon only while it is unhealthy", async () => {
  let starts = 0;
  let checks = 0;
  await runWatchdog({
    intervalMs: 1,
    iterations: 3,
    isHealthy: async () => {
      checks += 1;
      return checks >= 3;
    },
    start: async () => {
      starts += 1;
    },
  });
  assert.equal(checks, 3);
  assert.equal(starts, 2);
});

test("watchdog survives a failing health probe", async () => {
  let starts = 0;
  let probes = 0;
  await runWatchdog({
    intervalMs: 1,
    iterations: 2,
    isHealthy: async () => {
      probes += 1;
      if (probes === 1) throw new Error("probe exploded");
      return false;
    },
    start: async () => {
      starts += 1;
    },
  });
  assert.equal(probes, 2);
  assert.equal(starts, 1);
});
