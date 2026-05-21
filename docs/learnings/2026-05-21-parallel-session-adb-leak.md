# Parallel ACE sessions leak adb daemons + qemu emulators

**Surfaced 2026-05-20–21** during the malaria-itn-app run 20260517-1829
Phase 6 re-verification cycle. Multiple consecutive
`mobile_ensure_avd_running` failures with `dadb java.net.SocketException:
Broken pipe` after `register_test_user part A/B` traced not to recipe
content, not to Maestro v2 incompat (PR #358 / #362), not to AVD/adb
infrastructure on a single workstation — but to **steady-state
process leaks across parallel `/ace:run` sessions on the same host**.

## The leak loop

1. Operator runs `/ace:run` in session A. The mobile MCP allocates
   `ANDROID_ADB_SERVER_PORT=5037` and `ACE_MOBILE_EMULATOR_PORT=5554`
   via `mcp/mobile/port-allocator.ts` (probe-and-pick from defaults).
2. The MCP spawns `adb -L tcp:5037 fork-server server` and
   `qemu-system-aarch64 -port 5554`. Both processes daemonize via
   double-fork; their effective parent becomes `init` (PID 1). **The
   MCP subprocess loses lineage to them immediately.**
3. Session A's `/ace:run` finishes (or is killed, or crashes). The MCP
   subprocess exits. The adb daemon + qemu keep running.
4. Operator opens session B in parallel. Its MCP probes 5037 → taken
   → walks to 5038. Spawns a SECOND `adb fork-server` on 5038. Same
   for the emulator: 5554 taken → 5556. New qemu on 5556.
5. Repeat 5×. After a day of dogfooding the workstation has:
   - 5–7 stale `adb fork-server` daemons on 5037..5043
   - 3–5 stale qemu emulators (the user re-runs Phase 6 frequently)
   - Each adb daemon `adb devices` reply lists a subset of the
     emulators it can see
6. New session C launches an emulator on 5558. The emulator's
   internal `adbd` is reachable from ALL host-side adb daemons
   (they share the loopback advertisement protocol). Multiple
   daemons race for exclusive ownership of the emulator's adbd
   gRPC channel. The losing daemons' open sockets to that adbd get
   reset, producing the `dadb AdbWriter.writeOpen` / `writeClose`
   `java.net.SocketException: Broken pipe` failure class.

The empirical evidence on 2026-05-20:

```
=== adb daemons ===
adb 8257  127.0.0.1:5038
adb 23636 127.0.0.1:5039
adb 41902 127.0.0.1:5040
adb 57037 127.0.0.1:5043
adb 59008 127.0.0.1:5041
adb 66511 127.0.0.1:5037
adb 68645 127.0.0.1:5042
```

Seven adb daemons on a workstation with a single live ACE session.
Every cleanup attempt (`pkill -9 adb fork-server`) was undone within
seconds by a sibling Claude Code session's `mobile_ensure_avd_running`
re-spawning a new daemon. The interference was unrecoverable from
inside any single session — the cleanup needs to coordinate across
sessions.

## The fix: per-session lock files + reaper

`mcp/mobile/session-lock.ts` introduces a small lock-file protocol:

- Each MCP session writes `~/.ace/sessions/<mcp-pid>.lock.json` at port
  allocation time with `{mcp_pid, started_at, adb_port, emulator_port,
  avd_name}`.
- Every subsequent `resolveAdbServerPort` / `resolveEmulatorPair` call
  sweeps `~/.ace/sessions/` first. For each lock whose `mcp_pid` is
  dead (`process.kill(pid, 0)` returns ESRCH), the sweep looks up live
  PIDs on the lock's adb_port + emulator_port via `lsof -iTCP:<port>
  -sTCP:LISTEN -t`, SIGKILLs them, and removes the lock.
- Self-cleanup: the MCP server registers SIGINT/SIGTERM/SIGHUP handlers
  that remove its own lock before exiting. The reaper is the safety net
  for hard-kill paths the signals don't cover.
- `bin/ace-mobile-reap` exposes the same library to operators:
  - no args / default — sweep stale only
  - `--all` — nuke ALL locks regardless of liveness (hard reset)
  - `--list` — read-only report

### Why port-based reap, not stored adb_pid

Capturing the adb-daemon's PID at spawn time is brittle: adb
double-forks and reparents to init within ~10ms of `adb start-server`,
and our subprocess (`child_process.spawn`) only sees the intermediate
fork's PID, not the daemon's real PID. We'd have to do a post-spawn
`lsof` lookup anyway. Skipping the PID capture and ALWAYS using
port-based lookup at reap time is simpler and equally correct: at the
moment we want to kill something, we know its port; lsof tells us
what's there; we kill that.

### Why SIGKILL not SIGTERM-then-SIGKILL

The reaper's targets are leaked adb daemons and qemu emulators —
they don't have meaningful cleanup to do. SIGTERM-then-wait would
slow the reaper from O(ms) to O(seconds) per target with no
benefit. The MCP server itself takes the SIGTERM path for its own
lock cleanup; that's the only place graceful matters.

### Why not just one shared adb daemon per host?

Tempting — `ANDROID_ADB_SERVER_PORT=5037` pinned everywhere, every
session targets emulators by serial. But that re-introduces a different
class of bug: if one session does `adb kill-server` (or the daemon
crashes), every parallel session loses its emulator visibility at once.
The per-session daemon model is more resilient; the reaper just needs
to clean up after sessions that don't.

## Limitations

1. **PID reuse.** If the kernel recycles a dead MCP's PID before the
   reaper runs, a brand-new (unrelated) process inheriting the same PID
   would appear "alive" to `process.kill(N, 0)` and the lock would
   never be reaped. Mitigations:
   - 64-bit PIDs on modern Linux push the reuse window to weeks. macOS
     still has 32-bit PIDs but in practice reuse takes hours.
   - The reaper runs at every port allocation, so the leak is bounded
     by "one session's port pair" until the unlucky PID dies. Not
     ideal, but acceptable.
   - A future hardening could store a `started_at` ISO + use `ps
     -o lstart` to disambiguate "is this the same process I started or
     a recycled PID?" — deferred.
2. **Cross-user locks.** `~/.ace/sessions/` is per-user (Mac home dir),
   so a second OS user's parallel ACE sessions are invisible to this
   reaper. Multi-user macOS hosts should follow the
   `ANDROID_ADB_SERVER_PORT` + `ACE_MOBILE_EMULATOR_PORT` pinning per
   `/ace:mobile-bootstrap`'s "Multi-user macOS hosts" section to avoid
   port collisions in the first place.
3. **Self-cleanup is best-effort.** The signal handlers can be missed
   (process.exit() from code, uncaught exception that doesn't surface
   a signal). Those cases fall back to the next session's reaper —
   which is the whole point of the design.

## Operator-facing commands

```bash
ace-mobile-reap         # default — reap stale sessions
ace-mobile-reap --list  # read-only inspection
ace-mobile-reap --all   # nuke everything (use when host is in a known-bad state)
```

## Where this lands in /ace:doctor

A follow-up will add a `WARN orphan_daemons` line to `bin/ace-doctor`'s
`[Mobile]` block when stale locks or unclaimed adb daemons are present
on the host. Tracked as a separate concern — this PR ships the
mechanism; doctor surfacing the leak visibly is a small follow-on.

## What this does NOT fix

- The Maestro v2.5.1 `dadb Broken pipe` failure class at the protocol
  level. The fix prevents the *competing-daemons* root cause; if some
  other dadb-level issue surfaces in the future (e.g. an emulator-side
  adbd bug), this reaper won't catch it.
- Recipe-level fragility (the J0 btn_start tap-loss class addressed in
  PR #362). Those are orthogonal.
