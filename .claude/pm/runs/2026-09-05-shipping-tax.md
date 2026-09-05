# 2026-09-05 — The tax on shipping corrections

## Lens

This session began as a `/ace:run` of `hh-poverty-targeting` and ended somewhere
else. The run itself completed; what the run *surfaced* was that nine of the ten
fixes it generated were the same shape — **the pipeline reliably produces
artifacts and does not reliably notice when they are wrong.** Every internal
check passed on artifacts that were wrong: API 200s, artifacts present,
`classify_phase_writeback` ok, `validate_run_state` clean.

Then the lens moved one level up, and the move is the finding worth keeping.
Two days of jjackson's issue filings landed while this session was away, and
**every one was labelled `harness`** — not a single product defect among them.
The tracker was saying what the run had said, about a different layer: the
outputs are in decent shape; **the machinery that ships corrections to them is
where the cost is.**

The evidence that decided it was live rather than argued. PR #1926 was sitting
`CONFLICTING/DIRTY`, both checks red, auto-merge never armed, for two days —
stuck on precisely the failure ace#1914 had measured (`check-version FAILURE`).
This session had hit the same collision on PR #1922 and rebased around it
without drawing the conclusion. **A tax you route around every time is invisible
until someone counts it.**

Corollary: **a `harness` label is not a lower tier than `blocks-e2e`, it is a
different axis.** `blocks-e2e` says one run cannot finish. `harness` says every
future fix costs more. The second compounds.

## Do it

Seven PRs, `0.13.1147 → 0.13.1157`, two clusters dispatched in parallel.

**Version race** — #1934, #1937, #1938, #1940.

| Issue | Outcome |
|---|---|
| #1852 | CLOSED. `--rebase-first` amended origin/main's own tip when the branch had zero unmerged commits. Reproduced in a throwaway fixture: a rewritten copy still titled *"Merge pull request #1849…"*, still authored by *"Someone Else"*, **exit 0, success line printed.** Now guarded on `git merge-base --is-ancestor`. |
| #1914 | Re-measured on a fresh 60-run window: still 20% red, 11 of 12 failures VERSION collisions, **zero real test failures**. New fact the issue lacked — **9 of 11 were `ALREADY on origin/main`**, twice a literal duplicate pair. Bump is now claim-aware. LEFT OPEN. |
| #1776 | Premise held and was **worse than filed**: three duplicate pairs in the last 40 merges, not one. Load-bearing new fact — in every pair both PRs were open simultaneously (#1899 created 8s after #1898), so the distinguishing fact *was* available at check time and nothing looked at it. LEFT OPEN. |

**Test isolation** — #1939, #1941, #1943.

`resolveBackend()` keyed its state file on `process.ppid`, which inside a vitest
worker **is the vitest main process, identical in every worker**. One real file
in `$HOME`, read/written/deleted by every worker. #1883 and #1797 were therefore
one defect, and the consolidation was proven rather than judged:

```
12 worker_pid=19255  file=~/.ace/mobile-backend.19244  client.test.ts
 4 worker_pid=19783  file=~/.ace/mobile-backend.19244  backend-toggle.test.ts
```

#1797's `delete` cannot itself produce `cloud` — it drops a module-scope pin
that was *masking* the shared file. Trigger and source; neither fires alone.

Controls, measured rather than asserted: 4 of 12 runs red → 0 of 12; 10 timeouts
across 6 runs → 0 across 8; 8 of 8 red → 0 of 8. A fourth defect of the same
family (#1942, `client.test.ts` diffing the **global** `os.tmpdir()`) was found,
filed, fixed and closed inside the same pass.

## Backlog

- **Phase 7 second surface** — scene 4's claim is a *negative* about the Deliver
  form, which an aggregate supervisor dashboard structurally cannot exhibit.
  Both open redesign findings converge on it; its gate resolved by
  `unattended_default`, so nobody decided. Blocks the next Phase 7 run.
- **ace#1914 residual** — claim-awareness stops duplicate *allocation*, but
  `check-version-unique` demands *monotonicity*, so out-of-order merges still go
  `BEHIND`. The two eliminating options (uniqueness-not-monotonicity, letting
  `main`'s VERSION step backwards; or a CI-side bump) are repo-owner calls.
- **ace#1776 residual** — a PR opening *after* the check runs green is invisible.
  Only `strict_up_to_date=true` or a merge queue closes it; both are repo-admin
  settings with throughput cost.
- **`session-lock-e2e` SIGTERM cleanup** — under two concurrent suites, still
  ~1 in 8 at **30000ms**. A 6× overshoot is a slow shutdown path, not a
  near-miss; raising the ceiling again would hide it.
- **#1926 and #1709** both stalled (2 and 9 days). #1926 is stuck on the very
  collision class now fixed — it may simply clear on a rebase.

## Closed

#1852, #1883, #1797, #1912, #1942 (COMPLETED). Earlier in the arc: #1843, #1823,
#1829, #1811, #1814, canopy#587, canopy#569 (unresolved merge-conflict markers
that had silently dropped a real gate from `ddd-arc-eval`'s instructions since
canopy#426).

## Skipped

- **A fresh `/ace:run`.** `hh-poverty-targeting` has a live solicitation to
  2026-09-12 and a complete run; a new one would publish a fourth solicitation
  to test fixes that were still landing.
- **`/ace:qa-deep`.** Right gate before go-live, wrong moment — a flaky suite is
  exactly what makes a ~90-judge run untrustworthy. Worth running now that the
  isolation fixes have landed.

## Meta-observations

- **Two agents dispatched into one worktree collided.** That was a dispatch
  error, not an agent error. The second found the shared tree missing 10 files
  from recent `main`; committing there would have deleted them **from `main`**.
  Both backed out and restored byte-for-byte. Parallel agents get
  `isolation: "worktree"`.
- **Both fix agents hit the version collision while shipping the version
  collision fix.** Recorded in #1937's body as live evidence for its own issue.
- **A self-heal that refutes its issue is a success.** Also its cheapest premise
  check: attempting the fix is what discovers the defect isn't there.
- **The control is the finding.** canopy#587's duplicate-frames gate was green
  *because of* the adjacency restriction — 6 pairs compared, all adjacent pairs
  >27.8% apart, while scenes 3 and 5 were byte-identical two apart. Widening to
  all 21 pairs turned pass into fail. Two of that agent's reported numbers
  contradicted the issue *I* had filed, and it said so rather than agreeing.
- **#1912 needed two concurrent full suites to reproduce** — a single suite was
  0 for 16, and 36 CPU burners 0 for 4. Single-suite load is not enough, which is
  presumably why it read as unreproducible before.
- **Fixing a detector by disabling the detector.** canopy#587 deliberately kept
  `ok: True` on a motionless scroll, because `ddd-arc-eval` refuses to judge a
  take containing a failed action — flipping it would have silently disabled the
  only lens that has ever caught the bug, on every run using the supported
  defensive-`scroll_to` idiom. The signal went on a new `warning` field instead.
