---
description: Drive an autonomous iteration loop on phases 3+4+6 until N clean runs in a row
argument-hint: <opp> [--target 3,6] [--golden <run-id>] [--runner web|local] [--until-clean N] [--resume]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:iterate

Client-side control loop. Launches first-class seeded runs
(`/ace:run <opp> --seed-from <golden> --only 3,4,6`) on a runner, **observes**
each run's `run_state.yaml` + Claude session, judges clean/dirty, owns the
streak, and on dirty runs an autonomous fix→ship→refresh cycle. Stops at N
clean runs in a row on one unchanged plugin version.

The loop logic lives entirely here — the server-side run is loop-blind. See
`docs/superpowers/specs/2026-06-01-ace-iterate-loop-design.md`.

## Arguments
- `<opp>` — opportunity slug (e.g. `bednet-spot-check`).
- `--target <ordinals>` — phases to iterate on (default `3,6`; `4` always
  rides along as a dependency, so the executed allowlist is `3,4,6`).
- `--golden <run-id>` — golden upstream prefix run. If omitted, see
  `agents/iterate-loop.md § Golden prefix resolution`.
- `--runner web|local` — where runs execute (default `web`; the observable
  runner). `local` runs the same first-class operation in a fresh local
  process.
- `--until-clean N` — required consecutive clean streak (default `5`).
- `--resume` — continue from `ACE/<opp>/iterate-state.yaml`.

## Process

Execute `agents/iterate-loop.md` inline at top level. This `/ace:iterate`
invocation IS the level-0 session, so `Agent` is available for the fix+ship
dispatch the loop performs on a dirty run (per `CLAUDE.md § Agent topology`,
anything that calls `Agent` must run at level 0).
