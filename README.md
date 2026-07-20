# Codex Fallback Router

An experimental, no-GUI fallback router for Codex Desktop on Windows. It keeps Codex on the official ChatGPT backend during normal operation and retries a Responses API request through a configured provider only after a strong usage-limit signal is received before any visible response content.

中文简介：这是一个面向 Windows Codex Desktop 的本地备用路由插件。正常请求仍走 ChatGPT；只有确认 Plus 或工作区额度耗尽、且当前回复尚未输出可见内容时，才把同一条请求重试到用户配置的 Responses API。

> [!IMPORTANT]
> This project is not an OpenAI product. It changes a Codex backend routing setting and sends the active task context to a third-party provider during failover. Review the threat model and provider terms before installing it.

## Status

- Tested Codex Desktop version: `26.715.7063.0`
- Runtime: Windows, Node.js 22 or newer
- License: Apache-2.0
- Interface: command line only
- Transport: loopback listener on `127.0.0.1`
- Release gate: a real provider smoke test must pass; simulated tests are not a substitute

Versions other than the tested build are rejected unless the operator explicitly passes `--allow-untested-version` after reviewing compatibility.

## What it guarantees

- Normal Responses requests go to the official ChatGPT backend first.
- Non-model Codex backend routes always go only to the official backend.
- Failover occurs only for recognized Plus/workspace usage-exhaustion errors, not generic rate limits, authentication errors, network failures, or server errors.
- If the primary stream has already emitted a non-quota event, the router continues that stream and never creates a duplicate fallback reply.
- The original model name is preserved unless `--fallback-model` is explicitly configured.
- ChatGPT cookies, tokens, account headers, and OpenAI-scoped headers are removed before a fallback request; the fallback credential replaces Authorization.
- Request bodies, ChatGPT tokens, and fallback credentials are never written to the router log.
- Fallback requests set `store: false` and Codex is configured with `disable_response_storage = true`.

## Conversation continuity

The fallback API key does **not** gain access to ChatGPT account history. Continuity works only because Codex normally sends portable current-task context in the Responses API `input`, including previous messages, tool definitions, tool results, instructions, and compacted context.

The router validates this before failover. It refuses to send a request that depends on `previous_response_id`, a provider-side `conversation` object, missing portable input, or a missing model. This produces an error instead of silently losing history.

Provider compatibility still matters. The fallback provider must accept the same Responses API model name, input item types, tools, and encrypted/compacted context emitted by Codex.

## Install from source

Run these commands in PowerShell:

```powershell
git clone <repository-url> codex-fallback-router
Set-Location .\codex-fallback-router
git config core.hooksPath .githooks

Set-Location .\plugins\codex-fallback-router
npm ci
npm test
```

Put the provider key on the clipboard, then configure it without placing the key in shell history:

```powershell
Get-Clipboard | node .\dist\cli.mjs config set --base-url https://fallback.example.com --api-key-stdin
node .\dist\cli.mjs smoke-test
node .\dist\cli.mjs install
```

Restart Codex Desktop once after installation. The installer:

1. verifies the supported Codex version;
2. backs up `%USERPROFILE%\.codex\config.toml`;
3. registers and installs the local plugin;
4. starts the loopback daemon;
5. only then points `chatgpt_base_url` at the healthy local router.

Installation is transactional. A plugin error, bad configuration, port conflict, or daemon startup failure restores the prior Codex configuration and removes installation artifacts.

## Commands

After installation, the shim is placed in `%USERPROFILE%\.local\bin`, the same location normally used by the Codex CLI:

```text
codex-fallback config set --base-url <https-url> --api-key-stdin [--responses-path <path>] [--fallback-model <id>] [--port <port>]
codex-fallback install [--allow-untested-version]
codex-fallback start [--quiet]
codex-fallback stop
codex-fallback status
codex-fallback smoke-test [--model <id>]
codex-fallback uninstall [--keep-secret]
```

Safe one-line configuration:

```powershell
Get-Clipboard | codex-fallback config set --base-url https://fallback.example.com --api-key-stdin
```

The URL is treated as a root and normally resolves to `/v1/responses`. A base ending in `/v1` resolves to `/responses`. Use `--responses-path` only when the provider requires a different path.

`config set` restarts a running daemon and rolls back both configuration and encrypted credential if the new daemon cannot become healthy. Omitting `--fallback-model` preserves the model selected in the active Codex task.

## Failover policy

```text
Codex request
  -> local loopback router
     -> official ChatGPT backend
        -> success or ordinary error: return unchanged
        -> visible SSE output: continue official stream only
        -> confirmed usage exhaustion before output: activate fallback latch
           -> validate portable context
           -> strip official credentials and scoped references
           -> retry once at the fallback Responses API
```

If the official error includes a future reset time, the router uses fallback until that time. Otherwise it latches for 15 minutes, then probes the official service again.

## Privacy and security

The credential is encrypted with Windows DPAPI `CurrentUser` and stored outside the repository under `%LOCALAPPDATA%\codex-fallback-router`. It cannot be decrypted under a different Windows account. Non-secret configuration, state, backups, a PID file, and a metadata-only log live in the same directory.

During failover, the configured provider receives the active task input, instructions, tool schemas, tool results, and necessary request metadata. `store: false` is a request to the provider, not a substitute for reviewing that provider's privacy and retention policy.

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the threat model.

## Recovery and removal

Normal removal:

```powershell
codex-fallback uninstall
```

This stops the daemon, restores only the Codex root keys changed by the installer, removes the plugin registration and command shim, and deletes the encrypted key unless `--keep-secret` is used.

If the router is unavailable and Codex cannot connect, follow [docs/RECOVERY.md](docs/RECOVERY.md). Backups are retained under `%LOCALAPPDATA%\codex-fallback-router\backups`.

## Development

```powershell
Set-Location .\plugins\codex-fallback-router
npm ci
npm test
npm run test:install
npm run secret-scan
```

The build produces one bundled `dist/cli.mjs` file plus a source map. Generated artifacts are ignored and must be rebuilt from the reviewed source. CI runs on Windows with full Git history so the history-aware secret scanner can inspect every commit.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/RELEASING.md](docs/RELEASING.md).

## Limitations

- Codex Desktop internals can change without notice. Compatibility is deliberately fail-closed.
- The router is a local availability dependency while installed. If it stops, start it or uninstall to restore direct official routing.
- A failed fallback returns one sanitized error; it does not retry repeatedly or switch models automatically.
- The project cannot guarantee third-party uptime, model compatibility, account-history access, or future Codex compatibility.
- A real quota-exhaustion event is difficult to reproduce safely. Mock integration coverage and a direct provider smoke test validate different parts of the system; both are required.

## License

Apache License 2.0. See [LICENSE](LICENSE).
