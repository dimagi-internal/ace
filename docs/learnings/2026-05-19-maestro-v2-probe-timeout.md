# Maestro v2.x probe1 timeout — false-positive "unhealthy" verdicts on a working driver

**Surfaced 2026-05-19** during root-cause analysis of malaria-itn-app run
`20260517-1829` Phase 6 `app-screenshot-capture` failures. The brief
hypothesized a Maestro v1 → v2 wire-protocol break; the trace proves it
was a timeout calibration drift on the cheap first probe.

## The empirical findings

1. **Maestro CLI v2.3.0's driver-APK layout is unchanged from v1.39.x.**
   `unzip -l ~/.maestro/lib/maestro-client.jar` on a v2.3.0 install shows
   `maestro-app.apk` (11.7 MB) and `maestro-server.apk` (884 KB) at the
   jar root — same names, same package IDs `dev.mobile.maestro` +
   `dev.mobile.maestro.test`. `MaestroBackend.resolveDriverApks` works
   unchanged on both major versions.
2. **The `--host`/`--port` flag contract is preserved.** `maestro
   --host=localhost --port=<adb_port> hierarchy` against a warm AVD with
   the driver running returns exit 0 with a full hierarchy JSON dump on
   v2.3.0, identical to v1.39.
3. **Maestro v2.x's JVM cold-start is ~3-5× slower than v1.39.x.**
   First-invocation `maestro hierarchy` against a healthy emulator takes
   ~10-12s steady-state on v2.3.0 / Java 17. The previous probe1 budget
   was 8s (`client.ts:720`), calibrated against v1.39's faster startup.
4. **The recipe step-key palette (`ALLOWED_STEP_KEYS`) is wire-compatible
   with v2.x.** v2 added `setOrientation` / `setPermissions` /
   `setClipboard` / `assertScreenshot` (not used here) and removed
   `deterministicOrder` + `maestro upload` (not used here). Our static
   recipes parse identically against v2.3.0.

## The actual trace from the malaria-itn-app session log

```
Error: Maestro driver on AVD emulator-5556 is unhealthy after recovery:
  probe1: shell timeout: maestro --host=localhost --port=5557 hierarchy;
  install: package-list-before:app=true,test=true,already-installed;
  repair: force-stop,uninstall,pm-uninstall-user-0,pm-ready,
          apks-resolved,installed:app,installed:test,
          apk-install-results:app=ok,test=ok,
          package-list-after:app=true,test=true,
          verified,instrumentation-kicked;
  probe2: maestro hierarchy exit 1: UNAVAILABLE: io exception
```

Decoded:

- **probe1 SHELL timeout** — the host-side 8s shell budget elapsed before
  `maestro hierarchy` returned anything. The driver was healthy and
  installed (`package-list-before:app=true,test=true,already-installed`);
  the gRPC server was likely fine; the 8s budget was just below v2's
  cold-start floor.
- **Stage 2 repair ran cleanly** — force-stop, uninstall, re-install all
  succeeded. But repair's destructive side effect is the actual cause of
  what follows.
- **probe2 UNAVAILABLE** — the post-uninstall reinstall hit the
  well-documented install-race class (PRs #339/341/342, cold-boot
  widening): the `am instrument` kick step doesn't reliably bind the
  on-device gRPC server inside probe2's 90s budget on a freshly
  reinstalled driver.

So probe1's premature timeout *triggered* a destructive recovery cycle
on a perfectly working driver, and the destructive cycle then exposed
the pre-existing install-race class on the reinstall.

## The fix

`mcp/mobile/client.ts:720` — probe1 budget `8_000` → `20_000`. 20s is
comfortably above v2.3.0's ~12s cold-start ceiling while still tearing
down quickly when the driver is *actually* wedged. v1.39 callers pay no
visible cost (probe1 still returns in ~2s on healthy v1 drivers; the
budget is an upper bound, not a wall-clock).

## What did NOT change

- Driver APK extraction logic — v1 / v2 share the same jar layout.
- `--host`/`--port` flag invocation — same contract on both.
- `repairDriver` flow — the install-race class it papered over remains
  the same class on v2.
- `ALLOWED_STEP_KEYS` — palette compatible with both.
- The cloud AMI's bundled Maestro version — see § AMI rebake below.

## Standardization on v2.x

The decision: rather than supporting v1 and v2 indefinitely, ACE
standardizes on Maestro v2.x as of this PR. The code remains
wire-compatible with both (the probe1 widening is forward-compatible);
the change is a doctor advisory and an operator-facing default.

- **`bin/ace-doctor`** adds a `WARN maestro_version` line when the
  installed `maestro --version` starts with `1.`, pointing the operator
  at the `curl -Ls 'https://get.maestro.mobile.dev' | bash` upgrade
  command. WARN-level (not BLOCKER) so operators using the cloud
  backend with a v1-bundled AMI aren't blocked by their local install
  state.
- **Cloud AMI rebake — pending.** The packer config that builds the
  AMI is not in `jjackson/ace` or `jjackson/ace-web`; it may live under
  the `acedimagi` Mac login or on AWS. Tracked as the next task in this
  arc — the AMI's bundled Maestro CLI (currently ~1.36 per the
  `app-test-cases/SKILL.md:262` comment) should be bumped to the same
  v2.x line that the local install runs once we locate it. Until then
  the cloud backend keeps working — same wire-protocol, same recipe
  semantics — just with a v1.x CLI under the hood.

## What we ruled OUT and why

The brief framed this as "Maestro v2 broke the gRPC driver probe" and
asked for a multi-file refactor (driver APK extraction, gRPC probe path,
repair flow, doctor floor at v2.x as a *hard* gate, recipe re-authoring
for v2 syntax). Direct evidence ruled all of those out:

| Ruled out | Evidence |
|---|---|
| Driver APK layout changed in v2 | `unzip -l` on v2.3.0 jar shows the v1.39 layout intact |
| `--host`/`--port` flags broken in v2 | Live call against running AVD returns exit 0 with full hierarchy JSON |
| gRPC contract changed | Stack trace is `io.grpc.StatusRuntimeException: UNAVAILABLE: io exception` — same class as the install-race class in PRs #339/341/342 |
| Recipe syntax broken in v2 | `ALLOWED_STEP_KEYS` audited against v2.0–v2.3 CHANGELOG; no removals affect our palette |
| Doctor should *fail* on v1.x | Cloud AMI still bundles v1.36; failing locally blocks cloud-backend operators for no benefit |

## Why this matters

The brief was a well-structured spec for a refactor that the code didn't
need. Phase 1 of systematic debugging caught it: read the actual error
trace before agreeing with the diagnosis. The trace told us
"probe1: shell timeout" (host-side, not protocol-side) and
"package-list-before:app=true,test=true,already-installed" (driver
healthy). Those two strings invalidated 90% of the brief in ~20
minutes of evidence-gathering and saved a multi-day refactor that
wouldn't have fixed anything.
