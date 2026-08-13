# Mobile mapping completeness — capture, detect, self-heal, resume

**Date:** 2026-08-12
**Status:** Design approved, plan pending
**Owner:** Jonathan Jackson

## Problem

ACE runs stopped completing when the app shapes got more complex (Spark,
Sophie — multi-module Deliver apps with case-select, repeats, date questions,
register-then-followup). Two distinct failures compound.

### 1. The device layer is mapped for one app shape

Genuinely unmapped surfaces, each `blocks-e2e`: repeat/roster junctures
(#1007), date widgets (#1081), two-leg Deliver home re-entry (#1191),
case-*search* (#972 — case-*select* was live-calibrated 2026-08-01 and that
half is done). These are real capability gaps, not false positives.

### 2. When a walk hits one, we invent a cause instead of reading the evidence

Measured across the open backlog: of 24 device/recipe issues filed since
failure forensics landed (`af17d583`, 2026-06-02), **4 cite a ui-dump and 20
do not.** The cost is not hypothetical:

- **#811** — "`action_sync` is destructive, swipe-to-refresh is the fix." Live
  A/B'd; **both arms failed**. Its sibling attribution (#824, invite
  propagation) was also wrong and was reverted 2026-08-12 (`3001679c`,
  `535cb39b`) — including a fabricated 3-day regression window. Two invented
  causes, one symptom, ~6 weeks and a draft PR (#850, now closed).
- **#893** — `viewJobCard` "present in Deliver, absent in Learn" sat in the
  selector map's own `purpose` string for months. False. #893's own proposed
  replacement (toolbar suffix) was also false. Both were settled in one pass by
  diffing two PNGs **that already existed in a run folder**.
- **#1191** (filed 2026-08-11) proposes keying its home anchor on
  `viewJobCard`. About to repeat #893 exactly.

`agents/qa-and-training.md:199-226` already carries the correct rule — capture
the dump first, *"do not attribute it to a recipe fault; both attributions have
been made confidently and wrongly on this symptom."* It has been ignored 20
times of 24. `skills/app-screenshot-capture/SKILL.md` documents reading
`*-FAILURE.xml` in eight separate places. Prose is not working.

### Root cause: the element tree is missing exactly where ambiguity lives

`recipe-splitter.ts`'s `splitRecipeAtScreenshots` opens a dump window only at a
**top-level** `takeScreenshot`. A `takeScreenshot` nested inside
`runFlow.commands` — i.e. every *branch* screenshot — produces no dump. The
splitter's own comment says so. Measured:

| recipe | screenshots | dump windows | **blind** |
|---|---|---|---|
| `connect-claim-opp.yaml` | 11 | 3 | **8** |
| `deliver-launch.yaml` | 7 | 1 | **6** |
| `deliver-form-walk.yaml` | 5 | 3 | 2 |
| `deliver-case-select.yaml` | 3 | 2 | 1 |
| `connect-resume-opp.yaml` | 3 | 3 | 0 |
| `learn-launch.yaml` | 2 | 2 | 0 |
| `form-submit.yaml` | 2 | 2 | 0 |

17 of 31 screenshots on the Deliver path have no paired element tree — and the
blind ones are the branch screens, the "which screen am I on" decision points.
The two worst recipes are precisely the two that generated #811, #863, #796,
#893 and #869.

This is why the documentation didn't help: **for these recipes the dump the
docs tell you to read often does not exist.** The mp4 (shipped since) records
pixels, and a selector map needs resource-ids and bounds — video cannot supply
them. Maestro's own `--debug-output` carries commands and a log but no
per-command hierarchy, so there is no existing trove to harvest.

`scripts/probe-atlas-drift.ts` already converts a corpus of ui-dumps into
candidate new selector rows. **The consume half is built and starving**, and
nothing runs it.

## Goals

1. Every session leaves behind enough to map any surface it touched, **after
   the fact** — so a one-way or expensive-to-reach state never has to be
   re-reached to be mapped.
2. A run **detects** that it has no map for a surface, rather than failing
   `selector-not-found` and inviting a guess.
3. On detection, ACE **self-heals** — calibrates the new rows from the live
   dump, proves them on-device, ships them — then reports where to fork and
   restart.

## Non-goals

- Predicting unmapped surfaces from the CCZ before the walk. Deferred
  (see § Deferred: CCZ-derived juncture expectation).
- Making `selector-map-calibrate` autonomous. Explicitly rejected — see § 3.
- Auto-forking. ACE reports the fork point; the human runs it.
- Changing the mp4 recording. It stays as-is; it is complementary, not a
  substitute for element trees.

## Design

### 1. Capture — dump windows at every `runFlow` boundary

`mcp/mobile/recipe-splitter.ts`.

Open a dump window at each **top-level `runFlow` boundary** — immediately
before entering and immediately after leaving the block — in addition to
today's top-level `takeScreenshot` windows.

**Never split inside a `runFlow.commands` block.** The `when:` guard and its
commands must stay in one chunk; splitting across `maestro test` invocations
would lose the guard. Splitting at the boundary sidesteps that entirely, and
the boundary is the *more* diagnostic moment anyway: a dump taken as the branch
is evaluated is exactly what separates "the tile is absent" from "the tile is
present and the matcher missed it" — the two causes with opposite fixes that
#811 and #893 each guessed wrong.

Boundary dumps have no screenshot to pair with, so they get synthetic
deterministic names: `<recipe-id>-branch<N>-pre.xml` / `-post.xml`, with `N`
the zero-based index of the `runFlow` in top-level document order.

**Nested `runFlow`s get no windows of their own.** A `runFlow` inside another
`runFlow.commands` is bracketed by its parent's pre/post dumps, not captured
per-branch. This is a deliberate trade, not an oversight: splitting inside a
guarded block would lose the `when:` condition. It is also a real coverage
limit worth stating — `connect-claim-opp` has 5 nested blocks (the #629 wedge
detector and the #863 Deliver-home classifier among them) and
`deliver-form-walk` has 5. Those screens remain pixel-only; what you get is a
dump immediately before and after the parent block, which narrows the question
to "which branch inside this block fired" rather than answering it. If that
proves insufficient in practice, the follow-on is to hoist those branches to
top level — an authoring change, not a splitter change.

**Measured window counts** (not estimates — computed against the current
palette):

| recipe | now | top-level `runFlow` | nested | projected |
|---|---|---|---|---|
| `connect-claim-opp.yaml` | 3 | 5 | 5 | 13 |
| `deliver-launch.yaml` | 1 | 6 | 0 | 13 |
| `deliver-form-walk.yaml` | 3 | 6 | 5 | 15 |
| `connect-resume-opp.yaml` | 3 | 5 | 0 | 13 |
| `form-submit.yaml` | 2 | 3 | 0 | 8 |
| `deliver-case-select.yaml` | 2 | 1 | 0 | 4 |
| `learn-launch.yaml` | 2 | 0 | 0 | 2 |

**Cost is accepted, not avoided** (decided 2026-08-12), but the honest number
is larger than the estimate the decision was taken on: across the palette this
is roughly **14 → 68 windows, i.e. ~54 additional `maestro test` invocations
per full walk.** At 3-5s of startup apiece that is ~3-4.5 minutes added to a
Phase 6 that runs ~10 minutes — a 30-45% increase, not the "30-60s" originally
projected.

The decision stands, with a circuit breaker rather than a gate: PR 1 measures
real per-chunk overhead on a live dispatch and records it. If the measured
total lands within the estimate above, proceed. If it is materially worse,
**stop and re-open the narrow option** (windows only around `runFlow`s that
carry a `when:` guard, which is where the diagnostic value concentrates)
rather than absorbing the cost silently.

### 2. Detect — atlas drift at Phase 6 close-out

`scripts/probe-atlas-drift.ts`, `lib/atlas-drift.ts`,
`agents/qa-and-training.md`.

Run the drift probe over the session's dump corpus after the walk — **pass or
fail** — and write `atlas-report.yaml` into the run folder. Extend the existing
classification with one new class:

- **drift** — a known surface whose ids moved (existing behavior)
- **unmapped-surface** — a captured screen where *nothing* matches the active
  selector map

`unmapped-surface` is the detection signal for "we have never built this app
shape." It is empirical: derived from screens actually reached, not predicted.

The report must surface in the **phase verdict**, not only on disk. Landing it
on disk alone reproduces the failure this whole design exists to fix — the
FAILURE dumps were on disk for two months and were read four times.

### 3. Self-heal — `selector-map-heal`, narrow and self-proving

New skill `skills/selector-map-heal`. **`selector-map-calibrate` keeps
`disable-model-invocation: true`** — it cold-boots and wipes the emulator for a
full cross-APK recalibration, and making that autonomous is a far larger blast
radius than this problem needs.

Input: the dump corpus + the `unmapped-surface` candidates from § 2.
Output: new selector rows + a palette step, proven and shipped.

Procedure: propose rows from the live dump → apply → **re-run the blocked leg
on-device** → on green, open a PR and arm auto-merge → on red, stop and file.

Three guards, each load-bearing:

1. **Additive only.** It may add rows; it may never mutate a row carrying a
   `Live-verified` note. Enforced by a static test.
2. **Green or nothing.** The on-device re-run must pass, within a bounded
   attempt count, or the skill stops and files an issue with the dump attached.
   It never ships an unproven row — that is the class this design exists to
   end.
3. **Never cold-boot over a human's emulator.** Inherits
   `selector-map-calibrate`'s existing caution.

**Auto-merge on green is deliberate** (decided 2026-08-12). ACE's rule is that
recipe and selector changes are validated on a live device before merge. Here
the green re-run *is* that validation, performed immediately before the merge.
This is the one path where self-heal and the live-validation rule agree rather
than conflict, which is precisely why it is safe to close the loop here and not
elsewhere.

### 4. Resume — report the fork point

`skills/fork-run` (existing), plus a reporting step.

After a successful heal, compute the upstream `(run_id, phase, skill)` boundary
that the new map unblocks and print the literal `/ace:fork-run` invocation.
ACE does not fork itself: forking copies artifacts into a new run, and that is
the operator's call.

## Testing

- **Splitter** — unit tests over fixtures derived from `connect-claim-opp.yaml`
  and `deliver-launch.yaml`, asserting window counts rise 3→13 and 1→13 (see
  the measured table in § 1), that no chunk boundary ever falls inside a
  `runFlow.commands` block, that nested `runFlow`s produce no windows of their
  own, and that boundary-dump names are deterministic and collision-free.
- **Atlas classification** — pure-helper tests in `lib/atlas-drift.ts` with
  fixture dumps: a known surface with moved ids classifies `drift`; a screen
  matching nothing classifies `unmapped-surface`; a fully-mapped screen yields
  neither.
- **Heal guards** — a static test that the heal path cannot emit a diff
  mutating a `Live-verified` row.
- **Heal correctness** — the on-device green re-run is the test. There is no
  offline substitute, and asserting one would recreate the guess-instead-of-look
  failure.

## Sequencing — four staged PRs, each merged before the next

1. **Capture** — splitter change + tests + the measured per-chunk overhead
   recorded in the PR body.
2. **Detect** — `unmapped-surface` classification, `atlas-report.yaml`, phase
   verdict surfacing.
3. **Heal** — `selector-map-heal` with its three guards.
4. **Resume** — fork-point reporting.

Capture must land first; everything downstream eats its corpus.

## Risks

- **Chunk overhead.** Already known to be ~54 extra invocations per walk
  (§ 1). Accepted, with the circuit breaker stated there. The residual risk is
  that per-chunk startup is worse than 3-5s on a cold AVD, which only a live
  measurement settles.
- **Nested branches stay pixel-only.** § 1's deliberate limit. The #863
  classifier and the #629 wedge detector — two of the highest-value diagnostic
  moments in the palette — are nested, so this design improves their context
  without fully resolving them. Hoisting them to top level is the follow-on if
  bracketing proves too coarse.
- **Chunk boundaries perturb device state.** The existing splitter already
  proves splitting is safe at `takeScreenshot`; `runFlow` boundaries are the
  same kind of seam. PR 1 validates on a real dispatch, not only in unit tests.
- **`unmapped-surface` is noisy at first.** Any screen the map never covered —
  including benign ones — will classify as unmapped. Expect to tune the
  threshold against the first real corpus before wiring it to anything that
  halts.
- **Heal ships a bad row that happens to go green.** A row can be wrong and
  still pass one leg (this is exactly how `viewJobCard` survived). Mitigated by
  additive-only + the row's `purpose` string recording the dump it came from,
  so the next reader can check the provenance rather than trust the note.

## Deferred: CCZ-derived juncture expectation

Parsing `suite.xml` for datum screens, repeats, and question types to predict
required junctures, then flagging ones with no palette step. This is the only
approach that catches a surface **never reached** because the walk halted
upstream — which the empirical detection in § 2 structurally cannot. Deferred
rather than dropped: it is a larger build, it duplicates knowledge the device
already has, and it is best designed against a corpus that § 1 makes good.
Revisit once § 2 has run against real sessions. `commcare_validate_ccz` already
parses the CCZ and `commcare-cli validate` already prints the datum screen
(`|Select: Case`, cited in #1191), so the input exists.

## Issues this closes or informs

- Closes the wrong-cause class behind #811 (closed), #893 (closed), #863
  (closed).
- Feeds the mapping of #1007, #1081, #1191, #972's case-search half.
- #1191 must additionally be corrected to stop keying on `viewJobCard`.
- Housekeeping found in passing: `mcp/mobile/selectors/connect-2.63.2.yaml:483`
  still says a validated Deliver anchor "still needs a live dump," thirteen
  lines above `deliver-home-daily-visits`, which shipped as exactly that.
