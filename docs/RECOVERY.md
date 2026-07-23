# Recovery guide

## Codex shows "stream disconnected" / "error sending request" and the router is down

Check whether the daemon is even alive:

```powershell
codex-fallback status
```

If it reports `Router is not running`, nothing is listening on the local port and every Codex request will fail with "error sending request". Bring it back:

```powershell
codex-fallback start
```

No Codex restart is needed; the next message works immediately. Since v0.2.3 the daemon absorbs unexpected per-connection errors instead of crashing, and records `daemon_uncaught` events (with a sanitized detail code) in `%LOCALAPPDATA%\codex-fallback-router\router.log` — check that log first if the daemon ever dies again. A stale `router.pid.json` without a running process means the previous daemon exited uncleanly; `start` reconciles it.

Since v0.2.4 a logon watchdog (HKCU Run key, no administrator rights) starts the router at every Windows logon and re-checks it every 60 seconds, so reboots and later daemon deaths heal on their own even when Codex does not fire its SessionStart hook. Manage it with:

```powershell
codex-fallback autostart status
codex-fallback autostart on
codex-fallback autostart off
```

## Codex cannot connect after installation

Open PowerShell outside Codex and try:

```powershell
codex-fallback status
codex-fallback start
```

If the router cannot start, restore direct official routing:

```powershell
codex-fallback uninstall
```

Restart Codex Desktop after uninstalling.

## The command shim is unavailable

Run the reviewed bundle from the source checkout:

```powershell
Set-Location <checkout>\plugins\codex-fallback-router
node .\dist\cli.mjs uninstall
```

If the checkout is unavailable, inspect `%LOCALAPPDATA%\codex-fallback-router\backups` and copy the newest verified `config.toml.*.bak` over `%USERPROFILE%\.codex\config.toml` only after preserving the current file separately. Then restart Codex Desktop.

Manual backup restoration can overwrite unrelated configuration changes made after installation. The normal `uninstall` command is safer because it detects whether the installed file changed and otherwise restores only `chatgpt_base_url` and `disable_response_storage`.

## Port conflict

The default port is `45831`. Installation refuses to leave Codex pointed at the router if another process owns that port. Stop the conflicting process or choose an unprivileged port during configuration:

```powershell
Get-Clipboard | codex-fallback config set --base-url https://fallback.example.com --api-key-stdin --port 45832
codex-fallback install
```

## Fallback provider failure

Run:

```powershell
codex-fallback smoke-test
```

The command reports only a sanitized HTTP status or network code. It intentionally does not print the provider response body. Common outcomes:

- HTTP 401/403: replace or authorize the provider key.
- HTTP 404: confirm the Responses path and use `--responses-path` if necessary.
- HTTP 429: inspect provider quota independently.
- `ECONNRESET`, timeout, or DNS code: the provider/network is unavailable before an API response.
- HTTP success but incompatible schema: the endpoint is not a compatible Responses API.

## Intermittent fallback disconnects ("stream disconnected before completion")

Since v0.2.1 the router automatically retries fallback requests that fail at the transport layer (TLS reset, CONNECT failure) before any response headers arrive — up to `fallbackRetries` attempts (default 3, backoff 2s/5s/10s since v0.2.2). Retries never happen once bytes have streamed to Codex, so a reply can never be duplicated. A slow provider is waited on patiently (up to 120s for the first response byte); retries only fire after a hard transport failure, never while a response is still being awaited.

To check both sides before deciding where to route:

```powershell
codex-fallback check
```

It reports the daemon state, a real fallback smoke test, and an unauthenticated official-backend probe, then prints the exact switch-back command. Switching modes never requires a Codex restart — it applies from the next message.

If Codex still shows repeated disconnects:

1. Inspect `%LOCALAPPDATA%\codex-fallback-router\router.log`. Each `upstream_retry`/`upstream_error` event now carries a sanitized `detail` network code (e.g. `ECONNRESET`).
2. Run `codex-fallback smoke-test` several times. Intermittent failures (some passes, some `ECONNRESET`) mean the provider's TLS ingress or the chosen proxy exit is unstable — switch proxy node, or remove `upstreamProxyUrl` from `%LOCALAPPDATA%\codex-fallback-router\config.json` to test a direct connection.
3. Persistent `ECONNRESET` on every attempt is a provider-side outage; contact the provider. Switch back with `codex-fallback mode primary` (or `auto`) in the meantime.

## Rotate or remove the credential

Put the replacement key on the clipboard and run `config set` again. The running daemon is restarted transactionally. To remove the local encrypted credential, run `codex-fallback uninstall` without `--keep-secret`.

If a real credential ever appeared in a file, terminal transcript, issue, CI log, or Git object, revoke it at the provider before attempting cleanup.
