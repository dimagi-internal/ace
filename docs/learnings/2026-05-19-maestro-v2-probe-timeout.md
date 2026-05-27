# Maestro v2 cold-start ≠ broken protocol

**Date:** 2026-05-19
**Status:** Resolved. probe1 timeout widened in `63563ed`. Cloud AMI rebake still pending.

## Durable facts

- **Maestro v2.x JVM cold-start is ~3–5× slower than v1.39.x** — first-invocation `maestro hierarchy` against a healthy emulator takes ~10–12s steady-state on v2.3.0 / Java 17.
- **The driver-APK layout, gRPC contract, and `--host`/`--port` flag contract are unchanged from v1.39.** Recipes parse identically.
- **probe1 budget is 20s** (`mcp/mobile/client.ts:720`). Comfortably above v2's cold-start ceiling while still tearing down quickly when a driver is actually wedged.
- **ACE standardizes on Maestro v2.x.** `bin/ace-doctor` WARNs (not BLOCKERs) on a v1.x local install, pointing at `curl -Ls 'https://get.maestro.mobile.dev' | bash`.

## Durable lesson — read the trace before agreeing with the diagnosis

The brief for this work hypothesized a Maestro v1→v2 wire-protocol break and proposed a multi-file refactor (driver APK extraction, gRPC probe path, repair flow, recipe re-authoring). Phase 1 of systematic debugging — reading the actual error trace — invalidated 90% of the brief in ~20 minutes.

Two strings from the trace did the work:

- `"probe1: shell timeout: maestro --host=localhost --port=5557 hierarchy"` — host-side timeout, not protocol-side
- `"package-list-before:app=true,test=true,already-installed"` — driver healthy before destructive recovery ran

probe1's premature timeout *triggered* a destructive recovery cycle on a perfectly working driver. The destructive cycle then exposed a pre-existing install-race class (PRs #339/341/342) on the reinstall — making the symptom look like a protocol break.

The pattern: when a brief proposes a large refactor based on an inferred root cause, read the trace yourself before agreeing. Two minutes of evidence-gathering can invalidate days of refactor work.

## Open item — Cloud AMI Maestro rebake

The AMI's bundled Maestro CLI is on the v1.x line (per `app-test-cases/SKILL.md:262` comment historical reference; verify current state before relying on this number). Cloud-backend operators are wire-compatible — same gRPC contract — so this is a cosmetic mismatch, not a blocker. The rebake just brings local + cloud onto the same major version. The packer config that builds the AMI is not in `jjackson/ace` or `jjackson/ace-web`; tracking the location of that config is the blocker.
