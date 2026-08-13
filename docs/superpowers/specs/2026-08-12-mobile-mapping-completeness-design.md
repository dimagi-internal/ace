# Mobile mapping completeness — cheap detection, deliberate expense, self-heal

**Date:** 2026-08-12
**Status:** Design approved, plan pending
**Owner:** Jonathan Jackson

## Problem

ACE runs stopped completing when app shapes got more complex (Spark, Sophie —
multi-module Deliver apps with case-select, repeats, date questions,
register-then-followup). Two distinct failures compound.

### 1. The device layer is mapped for one app shape

Genuinely unmapped surfaces, each `blocks-e2e`: repeat/roster junctures
(#1007), date widgets (#1081), two-leg Deliver home re-entry (#1191),
case-*search* (#972 — case-*select* was live-calibrated 2026-08-01, that half
is done). Real capability gaps, not false positives.

### 2. When a walk hits one, we invent a cause instead of reading the evidence

Of 24 device/recipe issues filed since failure forensics landed (`af17d583`,
2026-06-02), **4 cite a ui-dump and 20 do not.** The cost is not hypothetical:

- **#811** — "`action_sync` is destructive, swipe-to-refresh is the fix." Live
  A/B'd; **both arms failed**. Its sibling attribution (#824) was also wrong,
  reverted 2026-08-12 (`3001679c`, `535cb39b`) including a fabricated
  regression window. Two invented causes, one symptom, ~6 weeks, one dead PR.
- **#893** — `viewJobCard` "present in Deliver, absent in Learn" sat in the
  selector map's own `purpose` string for months. False. #893's own proposed
  replacement was also false. Both settled in one pass by diffing two PNGs
  **already sitting in a run folder**.
- **#1191** (2026-08-11) proposes keying on `viewJobCard`. About to repeat
  #893.

`agents/qa-and-training.md:199-226` already carries the right rule — capture
the dump first, *"do not attribute it to a recipe fault; both attributions have
been made confidently and wrongly on this symptom."* Ignored 20 times of 24.
`skills/app-screenshot-capture/SKILL.md` documents reading `*-FAILURE.xml` in
eight places. **Prose is not the missing piece.**

## The correction that shapes this design

An earlier draft proposed capturing a full dump corpus on *every* session, so
any surface could be mapped after the fact. Measurement killed that: dump
windows would go from 14 to 68 across the palette — ~54 extra `maestro test`
invocations, ~3-4.5 minutes on a ~10-minute Phase 6, a 30-45% tax on every run
forever.

It is also **unnecessary for detection**, because the one dump that matters is
already free. `MobileClient.captureFailureForensics` fires on every
`status === 'fail'` *and* on thrown failures, capturing a ui-dump + screenshot
*"NOW, before anything else moves the device"* — i.e. the element tree of the
exact screen the walk could not handle. That has shipped since 2026-06-02.

So the principle: **be cheap by default, and expensive only once we have
detected that we need to be.** Cost is spent deliberately, on the one run that
needs it, not amortized across every run that doesn't.

## Goals

1. Detect "we have no map for this surface" from artifacts we **already
   capture**, at zero added run cost.
2. When detection says the free evidence is not enough, spend real device time
   deliberately and once — instrumented, scoped to the failing leg.
3. Self-heal from that evidence: calibrate, **prove on-device**, ship, then
   report where to fork and restart.

## Non-goals

- Full-corpus capture as the default. Explicitly rejected above.
- Predicting unmapped surfaces from the CCZ before the walk. Deferred.
- Making `selector-map-calibrate` autonomous. Rejected — see Tier 3.
- Auto-forking. ACE reports the fork point; the human runs it.

## Design — a cost ladder

Each tier runs only if the tier below it was insufficient. Tiers 0 and 1 are
free; tier 2 is the only expensive step and it cannot start without a tier-1
detection.

### Tier 0 — free, already shipped: the failure dump

No change. `captureFailureForensics` already leaves
`<recipe-id>-FAILURE.{xml,png}` at the offending screen on every failure. The
mp4 (shipped since) records the path taken to get there.

**Nothing to build.** This tier is listed because the rest of the design is
built on it, and because the measured 20-of-24 gap is a consumption failure
sitting on top of evidence that already exists.

### Tier 1 — free: classify the failure dump

`lib/atlas-drift.ts`, `scripts/probe-atlas-drift.ts`,
`agents/qa-and-training.md`.

On any recipe failure, run the existing drift probe over `*-FAILURE.xml` plus
whatever step dumps the session did produce, and classify against the active
selector map:

- **drift** — a known surface whose ids moved (existing behavior)
- **unmapped-surface** — the failure screen matches *nothing* in the map: we
  have never built this app shape
- **matcher-miss** — the elements the recipe wanted **are** on screen; the
  matcher was wrong

That third class is the one that matters most and is cheapest to get wrong by
hand: `unmapped-surface` and `matcher-miss` have **opposite fixes**, and
guessing between them is precisely what #811 and #893 each did. It is a pure
function over an artifact already on disk — no device, no added run time.

Output `atlas-report.yaml` into the run folder **and surface it in the phase
verdict**. On-disk-only reproduces the exact failure this design exists to fix:
the FAILURE dumps sat on disk for two months and were read four times.

### Tier 2 — expensive, and only on a tier-1 `unmapped-surface`

`mcp/mobile/recipe-splitter.ts`, `MaestroBackend`.

Full-boundary dump capture becomes an **opt-in mode**, default off: a
`captureAllBoundaries` option that opens a dump window at each **top-level
`runFlow` boundary** (before entering, after leaving) in addition to today's
top-level `takeScreenshot` windows.

Invoked only when tier 1 reports `unmapped-surface` **and** one screen is not
enough to author the fix — a surface spanning several screens (a repeat
juncture, a two-leg re-entry). Then ACE re-walks *that leg only*, instrumented,
on the device it already has booted, and harvests the whole surface in one
deliberate pass.

**Never split inside a `runFlow.commands` block.** The `when:` guard and its
commands stay in one chunk; splitting across `maestro test` invocations would
lose the guard. The boundary is the more diagnostic moment anyway — a dump
taken as the branch is evaluated is what separates `unmapped-surface` from
`matcher-miss`.

**Nested `runFlow`s get no windows of their own**, and are bracketed by their
parent's pre/post dumps. Deliberate: splitting inside a guarded block is
unsafe. Real limit worth stating — `connect-claim-opp` has 5 nested blocks (the
#629 wedge detector and the #863 Deliver-home classifier among them) and
`deliver-form-walk` has 5. For those, tier 2 narrows the question to "which
branch inside this block fired" rather than answering it. Hoisting them to top
level is an authoring follow-on, not a splitter change.

Window counts when the mode is **on** (the point of the table is what tier 2
costs when we choose to pay it). Only `connect-claim-opp.yaml` and
`deliver-launch.yaml` are measured — asserted directly by
`test/mcp/mobile/recipe-splitter.test.ts` against the shipped splitter, not
re-derived by hand. That distinction matters: naive "2 windows per `runFlow`"
arithmetic was tried twice for these two recipes (13/13, then a corrected
11/10) and both were wrong — the actual behavior only came out of running the
splitter (adjacent top-level `runFlow`s collapse to one shared window at their
seam, and each recipe's very first top-level step is itself a `runFlow`
preceded only by comments, so its would-be leading `-pre` window is
suppressed as an empty-flow chunk). **10** and **9** are what actually ships.
The remaining rows were never run through the splitter or covered by a test
fixture — they're pre-implementation estimates using the same arithmetic that
was twice wrong for the two measured recipes, so treat them as directional
only, not verified counts.

| recipe | default | tier-2 (`captureAllBoundaries`) | measured? |
|---|---|---|---|
| `connect-claim-opp.yaml` | 3 | **10** | yes — test-asserted |
| `deliver-launch.yaml` | 1 | **9** | yes — test-asserted |
| `deliver-form-walk.yaml` | 3 | ~15 (unverified estimate) | no |
| `connect-resume-opp.yaml` | 3 | ~13 (unverified estimate) | no |
| `form-submit.yaml` | 2 | ~8 (unverified estimate) | no |
| `deliver-case-select.yaml` | 2 | ~4 (unverified estimate) | no |
| `learn-launch.yaml` | 2 | ~2 (unverified estimate) | no |

Scoped to one leg rather than the whole palette, this is seconds to tens of
seconds — paid once, on a run that has already failed and is going to be
re-walked regardless.

### Tier 3 — self-heal: `selector-map-heal`

New skill. **`selector-map-calibrate` keeps `disable-model-invocation: true`** —
it cold-boots and wipes the emulator for a full cross-APK recalibration, a far
larger blast radius than this problem needs.

Input: the tier-1 classification + the tier-0/tier-2 dumps.
Output: new selector rows and, where needed, a palette step — proven and
shipped.

Procedure: propose rows from the live dump → apply → **re-run the blocked leg
on-device** → on green, open a PR and arm auto-merge → on red, stop and file
with the dump attached.

Three guards, each load-bearing:

1. **Additive only.** May add rows; may never mutate a row carrying a
   `Live-verified` note. Enforced by a static test.
2. **Green or nothing.** The on-device re-run must pass within a bounded
   attempt count, or the skill stops and files. It never ships an unproven row
   — that is the class this design ends.
3. **Never cold-boot over a human's emulator.** Inherits
   `selector-map-calibrate`'s existing caution.

**Auto-merge on green is deliberate** (decided 2026-08-12). ACE's rule is that
selector and recipe changes are validated on a live device before merge; here
the green re-run *is* that validation, performed immediately before the merge.
This is the one path where self-heal and the live-validation rule agree rather
than conflict — which is exactly why the loop closes here and nowhere else.

### Tier 4 — resume: report the fork point

`skills/fork-run` (existing) plus a reporting step. After a successful heal,
compute the upstream `(run_id, phase, skill)` boundary the new map unblocks and
print the literal `/ace:fork-run` invocation. ACE does not fork itself: forking
copies artifacts into a new run, and that is the operator's call.

## Testing

- **Tier 1 classification** — pure-helper tests in `lib/atlas-drift.ts` over
  fixture dumps: moved ids on a known surface → `drift`; a screen matching
  nothing → `unmapped-surface`; wanted elements present but unmatched →
  `matcher-miss`; a fully-mapped screen → none. The three-way split is the
  contract; get it wrong and tier 3 heals the wrong thing.
- **Tier 2 splitter** — unit tests over fixtures from `connect-claim-opp.yaml`
  and `deliver-launch.yaml`: with the mode **off**, window counts are unchanged
  at 3 and 1 (this is the regression guard on the default path); with it on,
  10 and 9 (see the measured-window table above); no chunk boundary ever falls
  inside a `runFlow.commands` block; nested `runFlow`s produce no windows;
  boundary-dump names are deterministic, collision-free, and never start with
  a `-` (a leading hyphen turns `<screenshotName>.xml` into something every
  shell tool reads as a flag).
- **Tier 3 guards** — a static test that the heal path cannot emit a diff
  mutating a `Live-verified` row.
- **Tier 3 correctness** — the on-device green re-run is the test. There is no
  offline substitute, and asserting one would recreate the
  guess-instead-of-look failure.

## Sequencing — four staged PRs, each merged before the next

1. **Detect** (tier 1) — three-way classification, `atlas-report.yaml`, phase
   verdict surfacing. Ships value alone: it makes every existing failure
   legible without touching the run path.
2. **Instrument** (tier 2) — opt-in `captureAllBoundaries` + scoped re-walk.
3. **Heal** (tier 3) — `selector-map-heal` with its three guards.
4. **Resume** (tier 4) — fork-point reporting.

Detect leads, not capture — it is free, it stands alone, and it tells us
whether tier 2 is needed as often as we think.

## Risks

- **Tier 1 misclassifies.** `unmapped-surface` and `matcher-miss` have opposite
  fixes, so a wrong call sends tier 3 to heal the wrong thing. Mitigated by the
  fixture tests and by tier 3's green-or-nothing guard, which fails loudly
  rather than shipping.
- **`unmapped-surface` is noisy at first.** Any screen the map never covered,
  including benign ones, classifies as unmapped. Expect to tune against the
  first real corpus before wiring it to anything that halts.
- **Tier 2 chunk boundaries perturb device state.** The existing splitter
  proves splitting is safe at `takeScreenshot`; `runFlow` boundaries are the
  same seam. Validate on a real dispatch, not only in unit tests.
- **Heal ships a bad row that happens to go green.** A row can be wrong and
  still pass one leg — this is exactly how `viewJobCard` survived. Mitigated by
  additive-only plus recording the source dump in the row's `purpose` string,
  so the next reader checks provenance instead of trusting the note.
- **Nested branches stay pixel-only** even at tier 2. Stated above; hoisting is
  the follow-on.

## Deferred: CCZ-derived juncture expectation

Parse `suite.xml` for datum screens, repeats, and question types to predict
required junctures, then flag ones with no palette step. The only approach that
catches a surface **never reached** because the walk halted upstream — which
this design's empirical detection structurally cannot. Deferred, not dropped:
larger build, duplicates knowledge the device already has, and best designed
against a real corpus. `commcare_validate_ccz` already parses the CCZ and
`commcare-cli validate` already prints the datum screen (`|Select: Case`, cited
in #1191), so the input exists.

## Issues this closes or informs

- Ends the wrong-cause class behind #811, #893, #863 (all now closed).
- Feeds the mapping of #1007, #1081, #1191, and #972's case-search half.
- #1191 must additionally stop keying on `viewJobCard`.
- Housekeeping found in passing: `mcp/mobile/selectors/connect-2.63.2.yaml:483`
  still says a validated Deliver anchor "still needs a live dump," thirteen
  lines above `deliver-home-daily-visits`, which shipped as exactly that.
