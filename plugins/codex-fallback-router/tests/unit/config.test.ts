import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  backupConfig,
  editModelProviderBaseUrl,
  editRootConfig,
  inspectModelProviderConfig,
  inspectRootConfig,
  inspectRootModel,
  inspectRootModelProvider,
  restoreModelProviderBaseUrl,
  restoreRootConfig,
} from "../../src/codex-config.js";
import {
  createRouterConfig,
  fallbackResponsesUrl,
  normalizeBaseUrl,
  normalizeResponsesPath,
  normalizeRoutingMode,
  normalizeUpstreamProxyUrl,
  readRouterConfig,
  updateRoutingMode,
  writeRouterConfig,
} from "../../src/config.js";
import { readApiKey, storeApiKey, validateApiKey } from "../../src/dpapi.js";
import type { AppPaths } from "../../src/paths.js";

function testPaths(root: string): AppPaths {
  return {
    runtimeDir: root,
    secretFile: join(root, "secret.dpapi"),
    configFile: join(root, "config.json"),
    stateFile: join(root, "state.json"),
    pidFile: join(root, "pid.json"),
    logFile: join(root, "router.log"),
    backupDir: join(root, "backups"),
    runtimeCli: join(root, "bin", "cli.mjs"),
    runtimeNode: join(root, "bin", "codex.exe"),
    commandShim: join(root, "bin", "codex-fallback.cmd"),
    codexConfigFile: join(root, "config.toml"),
  };
}

test("normalizes fallback roots and Responses API paths", () => {
  assert.equal(normalizeBaseUrl(" https://example.test/// "), "https://example.test");
  assert.equal(normalizeBaseUrl("https://example.test/gateway/v1/"), "https://example.test/gateway/v1");
  assert.equal(normalizeResponsesPath(undefined, "https://example.test"), "/v1/responses");
  assert.equal(normalizeResponsesPath(undefined, "https://example.test/v1"), "/responses");
  assert.equal(normalizeResponsesPath("//custom//responses", "https://example.test"), "/custom/responses");

  assert.throws(() => normalizeBaseUrl("http://example.test"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@example.test"), /credentials/);
  assert.throws(() => normalizeResponsesPath("responses", "https://example.test"), /start with/);
});

test("accepts only credential-free loopback HTTP CONNECT proxies", () => {
  assert.equal(normalizeUpstreamProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(normalizeUpstreamProxyUrl("http://localhost:7890/"), "http://localhost:7890");
  assert.throws(() => normalizeUpstreamProxyUrl("https://127.0.0.1:7890"), /HTTP CONNECT/);
  assert.throws(() => normalizeUpstreamProxyUrl("http://proxy.example:7890"), /loopback/);
  assert.throws(() => normalizeUpstreamProxyUrl("http://user:pass@127.0.0.1:7890"), /credentials/);
});

test("defaults legacy configuration to auto and validates routing modes", async (t) => {
  assert.equal(normalizeRoutingMode(undefined), "auto");
  assert.equal(normalizeRoutingMode("fallback"), "fallback");
  assert.equal(normalizeRoutingMode("primary"), "primary");
  assert.throws(() => normalizeRoutingMode("invalid"), /auto, fallback, primary/);

  const root = await mkdtemp(join(tmpdir(), "codex-fallback-mode-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const legacy = createRouterConfig({ baseUrl: "https://example.test" });
  const { routingMode: _routingMode, ...legacyWithoutMode } = legacy;
  await writeFile(paths.configFile, `${JSON.stringify(legacyWithoutMode)}\n`, "utf8");
  assert.equal((await readRouterConfig(paths)).routingMode, "auto");

  await writeFile(paths.configFile, `${JSON.stringify({ ...legacyWithoutMode, routingMode: "bad" })}\n`, "utf8");
  await assert.rejects(readRouterConfig(paths), /auto, fallback, primary/);
});

test("updates routing mode atomically and leaves it unchanged when a check fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-fallback-mode-update-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  await writeRouterConfig(paths, createRouterConfig({ baseUrl: "https://example.test" }));

  await updateRoutingMode(paths, "fallback");
  assert.equal((await readRouterConfig(paths)).routingMode, "fallback");
  await assert.rejects(
    updateRoutingMode(paths, "primary", async () => {
      throw new Error("provider check failed");
    }),
    /provider check failed/,
  );
  assert.equal((await readRouterConfig(paths)).routingMode, "fallback");
});

test("preserves the requested model unless an override is explicit", () => {
  const transparent = createRouterConfig({ baseUrl: "https://example.test" });
  assert.equal(transparent.fallbackModel, undefined);
  assert.equal(transparent.routingMode, "auto");
  assert.equal(fallbackResponsesUrl(transparent).href, "https://example.test/v1/responses");

  const mapped = createRouterConfig({
    baseUrl: "https://example.test/service/v1",
    fallbackModel: "fallback-model",
  });
  assert.equal(mapped.fallbackModel, "fallback-model");
  assert.equal(fallbackResponsesUrl(mapped).href, "https://example.test/service/v1/responses");
});

test("edits and restores only root Codex configuration keys", () => {
  const original = `model = "gpt-5"\n\n[features]\nplugins = true\n`;
  const edit = editRootConfig(original, {
    chatgptBaseUrl: "http://127.0.0.1:45831/backend-api/codex",
    disableResponseStorage: true,
  });
  assert.deepEqual(edit.original, {});
  assert.deepEqual(inspectRootConfig(edit.editedText), {
    chatgptBaseUrl: "http://127.0.0.1:45831/backend-api/codex",
    disableResponseStorage: true,
  });
  assert.match(edit.editedText, /\[features\]\nplugins = true/);
  assert.equal(restoreRootConfig(edit.editedText, edit.original), original);
});

test("reads only the root model used by Codex", () => {
  assert.equal(inspectRootModel(`model = "current-model"\n[profile.test]\nmodel = "other"\n`), "current-model");
  assert.equal(inspectRootModel(`[profile.test]\nmodel = "profile-only"\n`), undefined);
});

test("routes and restores the active Responses model provider base URL", () => {
  const original = `model_provider = "openai_http"\n\n[model_providers.openai_http]\nname = "OpenAI HTTP"\nwire_api = "responses"\nrequires_openai_auth = true\n\n[features]\nplugins = true\n`;
  assert.equal(inspectRootModelProvider(original), "openai_http");
  assert.deepEqual(inspectModelProviderConfig(original, "openai_http"), {
    wireApi: "responses",
    requiresOpenAiAuth: true,
  });

  const edit = editModelProviderBaseUrl(
    original,
    "openai_http",
    "http://127.0.0.1:45831/backend-api/codex",
  );
  assert.equal(edit.originalBaseUrl, undefined);
  assert.equal(
    inspectModelProviderConfig(edit.editedText, "openai_http").baseUrl,
    "http://127.0.0.1:45831/backend-api/codex",
  );
  assert.equal(restoreModelProviderBaseUrl(edit.editedText, "openai_http", undefined), original);
});

test("restores an existing provider base URL without changing other provider fields", () => {
  const original = `[model_providers.openai_http]\nbase_url = "https://existing.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`;
  const edit = editModelProviderBaseUrl(
    original,
    "openai_http",
    "http://127.0.0.1:45831/backend-api/codex",
  );
  assert.equal(edit.originalBaseUrl, "https://existing.example/v1");
  assert.equal(
    restoreModelProviderBaseUrl(edit.editedText, "openai_http", edit.originalBaseUrl),
    original,
  );
});

test("backs up Codex configuration without changing it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-fallback-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const configFile = join(root, "config.toml");
  const contents = "disable_response_storage = true\n";
  await writeFile(configFile, contents, "utf8");
  const backup = await backupConfig(configFile, join(root, "backups"));
  assert.equal(await readFile(backup, "utf8"), contents);
  assert.equal(await readFile(configFile, "utf8"), contents);
});

test("DPAPI protects and restores the API key for the current Windows user", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-fallback-dpapi-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const secret = ["test", "credential", crypto.randomUUID().replaceAll("-", "")].join("-");
  const paths = testPaths(root);

  await storeApiKey(paths, secret);
  assert.equal(await readApiKey(paths), secret);
  assert.doesNotMatch(await readFile(paths.secretFile, "utf8"), new RegExp(secret));
  assert.throws(() => validateApiKey("short"), /short/);
});
