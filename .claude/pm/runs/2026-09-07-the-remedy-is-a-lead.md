# 2026-09-07 — The filed remedy is a lead, not an instruction

## Lens

The 2026-09-05 log named the tax on shipping corrections. This session paid that
tax down — 74 issues closed, 59 PRs, `0.13.1162 → 0.13.1295` — and in doing so
found the layer underneath it.

**Every filing carries two claims: a premise and a remedy. Rule 1 has always
governed the premise. Nothing governed the remedy.** Measured over three days,
the remedies failed in four distinct shapes:

| shape | case | what adopting it would have done |
|---|---|---|
| **wrong** | ace#2004 | hoisting the auto-merge arm above the ancestry guard would have armed and merged **a stranger's PR** from the wrong worktree |
| **under-scoped** | ace#2027 | edited both rubric branches, duplicating the provider check into each |
| **no-op** | ace#1768 | the probe already called the atom it was told to start calling |
| **stale** | ace#1766 | fixed in `f423ce12` the day *after* the issue was filed |

Shipped as ace#1900 / PR #2039: the fixer must re-read the cited `file:line`
against current `origin/main` **and execute the remedy before adopting it**,
recorded as `Remedy: as-filed | re-derived | refuted`. Its own author observed
that the contract makes filing *cheaper*, not dearer — the cost lands on the
fixer, who already has the file open, and ace#1900 was itself filed marked
`UNTESTED SKETCH`, which is now the documented normal case.

**It paid for itself within the hour** and roughly ten times after: `#1743`'s
`pool: sequential` would have serialised the whole suite against a mechanism
vitest does not have (`if (task.isolate) throw new Error("Isolated tasks should
not share runners")`); `#1894`'s per-alias `pipeline_get` had a blind spot —
`pipeline_get` takes no `program_id`, so program-owned dashboards were
unprobeable, while `workflow_get` already reported the answer at zero extra
cost; `#1619`'s proposed ratchet would have **deleted duplicate-household
detection** on a false premise.

## The corollary, which is sharper

**Reproducing the reported numbers is not evidence you understood the defect.**

- **ace#1807** — the filed rule *passes the cross-check*: 53 on the repro app,
  and the rule wrong. Only two REFUTED-SHAPE controls separated them.
  *"A repro-only suite would have shipped it."*
- **ace#1809** — the shipped `SETVALUE_RE` pinned attribute order `ref,value,event`
  and reproduced the gate's headline exactly (35 violations / 36 visible / 42
  preloads) while missing 2 of 11 `<setvalue>` nodes. Both orderings occur **in
  one released CCZ**: HQ writes ref-first, Nova's field defaults event-first.
  On a `[BLOCKER]` the miss mode is a silent PASS.

## Do it

Fifty-nine PRs. The dominant class, stated once: **a check that runs, returns a
plausible answer, and is structurally incapable of noticing the problem.**

- `ocs-chatbot-eval` gained a **fifth** deterministic clamp. Without the three
  that existed, the first real `/ace:qa-deep` scored **9.01, zero Fails, gate
  PASS**; with them, **8.50, two Fails, gate FAIL**. All four flagged entries
  passed on dimension math alone.
- `auditComposedPrompt` — a preventer with **no runtime caller**; only its own
  test referenced it.
- `ACE_SELECTOR_MAP` — read in three places, set in **none**, so
  `markerProvesFor(marker, undefined)` returned `true` unconditionally.
- `avd_name` — in the lock schema, printed by the reaper, **never written**.
- `gate-brief` — filename sweep complete; **15 files still named it as a prose
  destination**, live directives routing concerns to a deleted artifact. The
  existing preventer was green *because its allowlist held the offending file*.
- `frameworkComponentIds` — consumed, never produced.
- `connect_get_opportunity` — the fetch followed a 302 and parsed the
  payment-unit wizard: **a correct verdict about the wrong document.**
- `run-surface-audit` — an SPA sign-in wall scores `OK 200`; status line, final
  URL *and* raw body all read open, because the redirect is client-side.
- `plan-avd-pool` vs `doctor-avd-pool` — the doctor's own `fix:` line is
  `--pool 2`, and `--pool 2` reports `nothing to do`. **A closed loop.**
- `sweepStaleEmulatorState` — spares a peer's emulator, then kills it two lines
  later via an `lsof` rescue that consults no lock.

## Backlog

- **ace#2090** (`blocks-e2e`) — the second concurrent emulator dies mid-dispatch
  4/4 even when the orphan-kill correctly spares the peer. Mechanism not
  isolated; a falsifier was filed rather than a guess. Blocks **ace#1821**.
- **ace#1914 / ace#1776** — VERSION contention. Now *recoverable* (claim-aware
  bumping, a second uniqueness assertion, `land-pr.sh` arming on CLEAN) but not
  *prevented*: three sessions independently diagnosed ace#1619 within minutes
  and PR #2082 was wasted work. Only a merge queue or a claim mechanism closes
  it, and both are repo-admin settings.
- **ace#1888** — the fork copy lives in `ace-web`; ACE's half (making the gap
  loud) shipped.
- **ace#1839 / ace#2018** — product calls: un-authed LLM spend on a public chat
  link, and whether inline citation markup should be suppressed at the producer
  when it is also the grading evidence.

## Closed

74 since 2026-09-05, including every `blocks-e2e` open at the start plus
**ace#174**, the oldest issue in the repo.

## Meta-observations

- **The migration was incomplete in eight places and its own preventer could not
  see any of them.** `DEFAULT_APK_VERSION` moved to 2.64.0; six prose surfaces
  kept `2.63.2`, including a test asserting `.toContain('2.63.2')` — the guard
  pinning the stale value. `lib/apk-pin-sites.ts`, built to make this
  impossible, reports **0 hits**: a version literal inside prose is invisible to
  `SUSPECT_RE`. Meanwhile the machine's `.env` pinned 2.63.2 while the template
  said 2.64.0, so a live MCP resolved the wrong selector map and would have
  installed the wrong APK. **The code fix landed and the environment undid it.**
- **A live run corrects what no unit test can.** `#1896`'s first draft read
  **0 threads** silently, because `gog gmail search` returns `{threads}`, not
  `{messages}`. `#2091`'s premise was found by running the pre-fix script and
  reading its own `INFO plugin_root=` line.
- **Device evidence is not optional and not substitutable.** The two-AVD night
  produced four defects — #2089, #2090, #2091, #2092 — that no amount of code
  reading had surfaced in a week of looking at the same files.
- **The controls are where the work is.** A mutation that *survives* is the
  useful one: ace#2092's `isFile()` mutant survived because the first-draft trap
  asserted only "still exists" and its symlink trap left mtime at `now`. Both
  were rewritten into real controls.
- **Say when a fix is decoration.** ace#1954 moved the overall score
  8.7597 → 8.7577 and the PR said so, arguing the arithmetic half earns its keep
  as routing and visibility rather than score movement.
