# Architecture and threat model

## Components

- **Codex plugin manifest** declares the local plugin and its `SessionStart` hook.
- **CLI bundle** provides configuration, lifecycle, health, smoke-test, installation, and recovery commands.
- **Loopback router** listens on a fixed `127.0.0.1` port and proxies Codex backend requests.
- **Routing-mode selector, quota classifier, and latch** decide whether each new Responses request uses primary, fallback, or automatic quota behavior.
- **Context validator** allows only portable Responses API input and forces `store: false`.
- **DPAPI store** encrypts the fallback key for the current Windows user outside the repository.
- **Installer** backs up and edits Codex root configuration transactionally.

## Request destinations

| Request or state | Official backend | Fallback provider |
|---|---:|---:|
| Non-model endpoint | Always | Never |
| Manual `primary` Responses request | Always | Never |
| Manual `fallback` Responses request with portable input | Never | Once |
| Responses request, primary success | Yes | Never |
| Generic 429, 401/403 auth, 5xx, network error | Yes | Never |
| Primary has emitted non-quota SSE event | Yes | Never |
| Strong quota error before output | Yes | Once |
| Active quota latch with portable input | No probe | Once per user request |
| Server-scoped or missing input | Primary decision already made | Blocked before transmission |

## Failover sequence

1. Codex sends the complete request to the local router.
2. The router samples the persistent routing mode once and buffers a Responses request in memory, capped at 128 MiB.
3. Manual fallback skips the official model endpoint; manual primary streams the official response without quota failover; auto continues with the quota classifier below.
4. The official request uses the original ChatGPT headers and target.
5. A non-success response is buffered up to 2 MiB only for quota classification. An ordinary error is returned unchanged.
6. For an SSE success response, the router buffers only the first event or safety boundary. A quota error can trigger fallback only at this boundary.
7. The fallback body validator rejects server-scoped history and missing portable context, preserves all other request fields, keeps or explicitly maps the model, and sets `store: false`.
8. Fallback headers are rebuilt without official Authorization, cookies, browser origins, ChatGPT headers, or OpenAI-scoped headers.
9. A successful fallback response is streamed to Codex. A failure is reduced to a sanitized local error and is never retried automatically.

## Trust boundaries

The local process and the current Windows user profile are trusted. Other local users, untrusted processes running as the same user, the network, and the fallback provider are outside the trust boundary.

Loopback binding prevents remote network clients from connecting directly, but it does not isolate the router from another process running under the same Windows user. The health endpoint deliberately contains only process/version/latch metadata.

DPAPI protects the credential at rest from other Windows accounts. It does not protect against malware already executing as the same user.

## History semantics

The portable `input` array is the only cross-provider history mechanism. `previous_response_id` and provider-side `conversation` references point to state held by one provider and therefore cannot be resolved by another. The router blocks these request shapes rather than producing a misleading partial continuation.

## Availability behavior

The installer starts and health-checks the daemon before changing Codex routing. A startup failure restores the exact pre-install configuration and cleans newly created plugin/runtime artifacts. Routing mode is stored in the non-secret router configuration, defaults legacy installs to `auto`, and is read for every new Responses request so switching does not restart the daemon. Once installed, the daemon is a dependency for Codex backend access; the `SessionStart` hook attempts to start it automatically.
