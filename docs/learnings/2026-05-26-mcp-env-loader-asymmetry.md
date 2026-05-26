# 2026-05-26 — MCP env-loader asymmetry: gdrive was the only MCP not loading `.env`

## Symptom

Brand-new Claude Code session. First `/ace:run` call hits
`resolve_opp_path(slug='bednet-spot-check')` and gets back:

```
Error: ACE_DRIVE_ROOT_FOLDER_ID is not set and no aceRootFolderId was passed
```

…even though `bin/ace-doctor --preflight` (run seconds earlier in the
same session) had just confirmed the var is set in
`<plugin-data-dir>/.env`. Worked around live by passing
`aceRootFolderId` explicitly from the preflight output.

## Root cause

Of the six MCP server entrypoints in `mcp/`, three loaded `.env` at
boot and three did not:

| Server | dotenvConfig at boot? | Status |
|---|---|---|
| `mcp/connect-server.ts` | yes | ok |
| `mcp/ocs-server.ts` | yes | ok |
| `mcp/mobile-server.ts` | yes | ok |
| `mcp/google-drive-server.ts` | **no** | **bug** |
| `mcp/decisions-server.ts` | no | latent — no current ACE-env reads |
| `mcp/connect-labs-server.ts` | uses `parseEnvFile()` proxy-side | ok |

So gdrive atoms reading `process.env.ACE_*` saw `undefined` from the
very first call in every session. The bug had been masked because most
callers had been passing `aceRootFolderId` explicitly or chaining off
already-resolved folder IDs from prior atoms — `resolve_opp_path` was
the first atom in `/ace:run`'s pre-flight that *only* had the env var
to lean on.

Why didn't the existing tests catch it: tool-registration coverage was
exhaustive on the atom roster but said nothing about server-boot
behavior, so a server with zero env loaders would still pass every
test.

## Fix

1. Add the canonical `dotenvConfig({ path: <plugin-data-dir>/.env })`
   boot block to `mcp/google-drive-server.ts`, mirroring the
   `connect-server.ts` pattern.
2. Add the same block to `mcp/decisions-server.ts` for consistency
   (defensive — no current ACE-env reads there, but future ones would
   silently break the same way).
3. Add a class-level preventer test in
   `test/mcp/registration-coverage.test.ts` that asserts every
   `mcp/*-server.ts` calls either `dotenvConfig(` or `parseEnvFile(`
   before any atom handler runs. Now structurally impossible to
   regress.

## Class-level lesson

Per-server boot symmetry is its own invariant. When five MCPs do
something at boot and the sixth doesn't, the sixth is wrong by default
— not "stylistically inconsistent." Add the preventer when you fix
the instance.

The other class-level finding: don't trust an MCP atom's failure
message at face value when the symptom is "env var unset" but doctor
just reported it set. That's a 100% signal the MCP subprocess didn't
load env, not that the env file is missing.
