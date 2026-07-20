# Security Policy

## Supported versions

Only the latest commit on the default branch is supported during the experimental `0.x` phase. The current compatibility gate accepts Codex Desktop `26.715.7063.0` by default.

## Reporting a vulnerability

Do not open a public issue for credential exposure, authentication-header leakage, unsafe routing, local privilege problems, or a failover that sends context under the wrong conditions. Use the repository host's private security-advisory channel and include:

- affected commit and Codex Desktop version;
- a minimal reproduction with synthetic credentials;
- expected and observed provider destinations;
- whether any request body or credential may have been disclosed.

Never include a real ChatGPT token, cookie, provider credential, or conversation body in a report.

## Security boundaries

The router is designed around these invariants:

- listen only on `127.0.0.1`;
- send non-model routes only to the fixed official ChatGPT base URL;
- send a Responses request to fallback only after a strong quota-exhaustion decision, an active quota latch, or an explicit persistent manual fallback selection;
- keep all non-model routes on the official backend in every routing mode so manual fallback does not replace the ChatGPT login session;
- never fail over after the primary stream has begun returning non-quota events;
- block failover for server-scoped history references;
- remove ChatGPT/OpenAI credentials and scoped headers before fallback;
- never log request bodies, cookies, tokens, or fallback credentials;
- keep the fallback credential in DPAPI `CurrentUser` storage outside Git;
- restore Codex configuration if installation cannot complete safely.

Changes that weaken any invariant require an explicit threat-model update and regression tests.

## Credential handling

Credentials must enter the CLI through standard input. Command-line key flags, environment-file examples containing live-looking values, plaintext test fixtures, and committed encrypted credential files are not accepted.

The repository hook scans staged diffs, and CI scans the worktree and complete Git patch history for common gateway and API-key formats. These checks reduce risk but do not replace credential rotation after suspected exposure.

## Third-party provider trust

The fallback provider receives current task context only when failover occurs. Operators are responsible for provider authorization, privacy terms, retention behavior, security controls, and model/tool compatibility. The project cannot enforce a remote provider's handling of `store: false`.
