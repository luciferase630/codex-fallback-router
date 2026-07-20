# Recovery guide

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

## Rotate or remove the credential

Put the replacement key on the clipboard and run `config set` again. The running daemon is restarted transactionally. To remove the local encrypted credential, run `codex-fallback uninstall` without `--keep-secret`.

If a real credential ever appeared in a file, terminal transcript, issue, CI log, or Git object, revoke it at the provider before attempting cleanup.
