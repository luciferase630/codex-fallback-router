# Release checklist

1. Confirm the supported Codex Desktop version in `src/constants.ts` against an installed Windows build.
2. Review any Codex backend request-shape changes, especially Responses paths, quota errors, stream events, and history references.
3. From `plugins/codex-fallback-router`, run:

   ```powershell
   npm ci
   npm test
   npm run test:install
   npm run secret-scan
   ```

4. Run a real `codex-fallback smoke-test` against the intended provider and model. A mock server does not satisfy this gate.
5. Install on the supported Codex build, restart once, and verify normal official traffic through the loopback router.
6. Verify a controlled strong-quota simulation produces one fallback response and no duplicated partial output.
7. Inspect `git status`, the six milestone commits, all refs, and generated output. Confirm no `.dpapi`, local configuration, logs, backups, or plaintext credentials are tracked.
8. Clone the candidate commit into a new directory, rebuild there, and run the secret scan again.
9. Tag only a commit for which every check passes. Record a failed live provider smoke test as a release blocker, not a warning.

The repository intentionally excludes `dist`. Release consumers build the single bundled CLI from reviewed source with the lockfile. If a future release distributes a prebuilt bundle, attach provenance and verify the bundle separately with the same secret scan.
