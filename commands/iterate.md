---
description: Drive an autonomous iteration loop on phases 3+4+6 until the rolling pass rate converges
argument-hint: <opp> [--new-golden] [--report] [--target 3,6] [--golden <run-id>] [--runner web|local] [--window N] [--pass-target 0.8] [--resume]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

# /ace:iterate

Client-side control loop. Launches first-class seeded runs via
**fork-then-resume** (fork the golden into a new run shaped `{3,4,6: pending,
5/7/8+: skipped}`, then a plain `/ace:run <opp>/<new-run-id>` resume) on a
runner, **observes** each run's `run_state.yaml` + Claude session, judges
clean/dirty, and on dirty runs an autonomous fix→ship→refresh cycle. Stops when
the **rolling pass rate over the last N runs** clears the target. (Run shape is
structural in `run_state.yaml`, not a `--seed-from` / `--only` flag —
jjackson/ace#672.)

**This is ACE's only end-to-end outcome metric.** Everything else the project
measures — issues filed, PRs merged, per-skill verdicts — is activity or
internal consistency. This is the one number that answers "can ACE complete an
opportunity, and is that getting better?" Run it, and report the number.

The loop logic lives entirely here — the server-side run is loop-blind. See
`agents/iterate-loop.md` (authoritative) and
`docs/superpowers/specs/2026-06-01-ace-iterate-loop-design.md` (original design;
its frozen-version streak is superseded).

## The routine

```
/ace:iterate <opp> --new-golden     # 1. mint + validate + lock a fixture (runs no iterations)
/ace:iterate <opp>                  # 2. run the loop
/ace:iterate <opp> --report         # 3. read the number, anytime, spawns nothing
/ace:sweep drive,connect,ocs,hq,opp-runs   # 4. tear down the per-iteration artifacts
```

## Arguments
- `<opp>` — opportunity slug (e.g. `bednet-spot-check`).
- `--new-golden` — mint a fresh golden prefix, validate it against **today's**
  rubrics, archive any existing state, and write a clean `iterate-state.yaml`.
  Runs **zero** iterations; it sets up the campaign and stops. **This is also
  the reset** — there is no `--reset` flag, because iterations seeded from one
  golden aren't comparable to iterations seeded from another, so replacing the
  fixture has to archive the history. See `agents/iterate-loop.md § A golden is
  a snapshot that decays`.
- `--report` — print the health block and exit. Read-only: no fork, no run, no
  autofix. Use it to check a campaign mid-flight without perturbing it.
- `--target <ordinals>` — phases to iterate on (default `3,6`; `4` always
  rides along as a dependency, so the executed allowlist is `3,4,6`).
- `--golden <run-id>` — golden upstream prefix run. If omitted, see
  `agents/iterate-loop.md § Golden prefix resolution`.
- `--runner web|local` — where runs execute (default `web`; the observable
  runner). `local` runs the same first-class operation in a fresh local
  process.
- `--window N` — rolling window size (default `10`). Health is read over the
  last N iterations.
- `--pass-target <0..1>` — pass rate required to converge (default `0.8`).
- `--resume` — continue from `ACE/<opp>/iterate-state.yaml`.

`--until-clean N` is **retired**. It set a consecutive-clean streak counted
against a frozen plugin version, and because ACE merges ~9 VERSION bumps/day the
condition was unreachable — the loop never once reported success. If passed,
treat it as `--window N` and say so. See `agents/iterate-loop.md § The metric`.

## Process

Execute `agents/iterate-loop.md` inline at top level. This `/ace:iterate`
invocation IS the level-0 session, so `Agent` is available for the fix+ship
dispatch the loop performs on a dirty run (per `CLAUDE.md § Agent topology`,
anything that calls `Agent` must run at level 0).

Print the health one-liner (`computeIterateHealth(...).summary`) every pass, and
include the full health block in the final report — on success, on halt, and on
an unfilled window alike.
