# Contributing

Contributions are welcome for the Windows Codex Desktop target described in the README. By submitting a contribution, you agree that it is licensed under Apache-2.0.

## Setup

Requirements:

- Windows 11
- Node.js 22 or newer
- the tested Codex Desktop build for installation tests
- Git with `core.hooksPath` set to `.githooks`

```powershell
git config core.hooksPath .githooks
Set-Location .\plugins\codex-fallback-router
npm ci
npm test
```

Run the isolated installer test when touching configuration, daemon, plugin lifecycle, or filesystem code:

```powershell
npm run test:install
```

## Pull requests

- Keep the loopback-only, fail-closed routing policy.
- Add regression coverage for behavior changes.
- Use synthetic credentials assembled at runtime in tests so fixtures do not resemble live keys.
- Do not add telemetry, request-body logging, provider-response logging, or GUI dependencies.
- Do not add implicit model remapping.
- Document compatibility assumptions and recovery effects.
- Run `npm run secret-scan` against the complete local history before submitting.

Provider-specific exceptions should be opt-in and must not weaken credential stripping or send a request after an ambiguous primary error.

## Commit hygiene

Use focused, imperative commit messages. Before committing:

```powershell
npm test
npm run secret-scan
```

Do not rewrite published history to remove a leaked credential and assume the problem is solved. Revoke the credential first, then purge the object history and verify a fresh clone.
