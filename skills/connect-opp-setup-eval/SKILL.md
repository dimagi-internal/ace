---
name: connect-opp-setup-eval
description: >
  Grade Connect Opportunity configuration against the PDD — verification
  flags, payment units, deliver-unit wiring, active window. Sibling of
  connect-program-setup-eval; this rubric judges the opp-side that
  follows program creation.
disable-model-invocation: true
---

# Connect Opp Setup Eval

`connect-opp-setup` is the Phase 4 skill that creates the Connect
Opportunity that hangs off the Program — verification flags, payment
units, deliver-unit links, active window. Where `connect-program-setup`
grades the program-side translation, this rubric grades the
opportunity-side. Together they cover the full Phase 4 Connect-side
build.

Five of the six dimensions triangulate PDD ↔ Connect-config ↔
Deliver-summary — that's **fidelity to the AI authoring chain**, not
**fitness of the opportunity to deploy**. Per
`skills/_eval-template.md § The out-of-chain fitness requirement`, a
rubric whose every dimension is satisfiable by a config that matches the
PDD but would wrongly reject legitimate FLW deliveries (or pay a rate no
real FLW would work for) does not meet the eval contract. The
**`deployability`** dimension (0.22) is the out-of-chain fitness axis: it
grades payment-rate affordability against a *real regional day-rate
benchmark* (not a PDD-declared one) and whether the verification
thresholds are runtime-survivable for real FLWs. It carries a hard-gate
so a faithful-but-undeployable opp cannot clear `pass`.

This is the per-opp half of the Phase 4 eval pair. See
`skills/connect-program-setup-eval/SKILL.md` for the program-side
sibling, `skills/_eval-template.md` for shared contracts, and
`skills/eval-calibration/SKILL.md` for calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; Evidence Model + Operational caps drive expectation |
| Phase 4 | `4-connect/connect-opp-setup.md` and `4-connect/connect-opp-setup_summary.md` | opp config under judgment |
| Phase 4 | `4-connect/connect-program-setup_summary.md` | parent Program ID + cross-check on consistency |
| Phase 3 | `3-commcare/app-deploy_summary.md` | HQ Deliver app ID + form/module names for cross-check on Deliver Unit wiring |

## Products

- `4-connect/connect-opp-setup-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`. Filename uses the **producer** skill name (`connect-opp-setup`).

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).
   Additional sources read on demand:
   - Connect opp summary: `runs/<run-id>/4-connect/connect-opp-setup_summary.md`
   - Deployment summary: `runs/<run-id>/3-commcare/app-deploy_summary.md`
     (verifies the linked HQ Deliver app + form names match what
     Connect actually points at).

2. **Detect degraded mode.** If the opp-setup artifacts contain
   `connect_opportunity_id: TBD-MANUAL` — i.e., Phase 4 ran in degraded
   mode because the ace-connect MCP `create_*` tools weren't available
   — emit `verdict: incomplete` immediately with `[INFO] degraded-mode
   artifacts; not gradable as Connect-real`. Do not score zero or warn
   for degraded mode (see sibling rubric for the precedent).

3. **Extract the PDD's opp-relevant spec.** Build a structured
   expectation:
   - Opportunity archetype (`atomic-visit` / `focus-group` / `multi-stage`).
   - Verification rules from Evidence Model § Layer A (GPS accuracy,
     photo presence, consent gate, market-hours window, duplicate
     detection composite).
   - Payment-unit count, type, and structure (per-delivery vs
     per-session vs per-stage; flat-rate vs piece-rate; derive from
     Operational caps + Compensation sections).
   - Deliver-unit (named slot in the Deliver app, typically the
     Connectify-tagged form name).
   - Active-window duration (Timeline section).

4. **Extract the built Connect opp config** from the opp-setup summary
   (and via `connect_get_opportunity` / `connect_list_payment_units` /
   `connect_list_deliver_units` if `connect_opportunity_id` is real,
   not TBD). Set `live_state_verified` based on whether those probes
   succeeded.

5. **Grade across 6 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Deployability (out-of-chain fitness)** | 0.22 | The out-of-chain anchor. This dimension does NOT grade against the PDD — it grades whether the opp as configured would actually work for real FLWs in the real region. Two sub-axes: **(a) Payment-rate affordability.** Estimate the per-FLW daily earning (per-unit rate × realistic max-daily-units a real FLW could complete) and compare it to a *real-world regional day-rate benchmark* for that geography and worker class (gig/CHW field rates for the country/region named in the PDD — use general domain knowledge of local market floors, NOT a PDD-declared figure). If the estimated daily earning is **below a plausible local market floor** (a rate no real FLW would accept), that is a **hard-gate fail (≤3)** — the opp will not recruit. If it's implausibly high (>3× a plausible day-rate, signalling a units/currency error), 2-point deduction. **(b) Threshold runtime-survivability.** Would the verification thresholds wrongly reject legitimate deliveries or pass fraudulent ones in field conditions? A GPS radius too tight for real GPS jitter / tree cover / indoor markets (e.g. ≤10 m hard reject) would bounce legitimate FLWs → 3-point deduction; a radius so loose it can't distinguish the site from a neighbouring one (e.g. >2 km) passes fraud → 3-point deduction. A photo/consent gate with no fallback for a failed upload on a low-bandwidth handset → 2-point deduction. Thresholds that are flatly unworkable for the named field context = **hard-gate fail (≤3)**. Anchors: deployable-as-configured (rate clears local floor, thresholds field-survivable) = **9.0**; one soft survivability concern = **6.5**; rate below floor OR a threshold class unworkable = **≤3**. This dimension is exempt from any deferral carve-out — grade what a *deployable* opp should contain even where the PDD was silent (PDD silence on a region benchmark is a finding, not a free pass). |
   | **Verification-flag fidelity** | 0.20 | The PDD's Evidence Model § Layer A specifies hard verification rules (GPS ≤Xm, photo present, consent=yes, market-hours window). Connect's verification flags must enforce the same rules at archetype-appropriate strictness — `atomic-visit` defaults to strict GPS + photo; `focus-group` relaxes GPS to room-level + adds attendance check; `multi-stage` adds stage-gate transitions. Missing a Layer A rule Connect could enforce = 2-point deduction per rule. Adding a rule Connect enforces but PDD doesn't require = 0.5-point deduction. Wrong strictness for the archetype (e.g., GPS strict on a focus-group) = 1.5-point deduction per misfit. |
   | **Payment-unit fit** | 0.16 | Payment-unit *count* must match what the PDD declares (one per-delivery PU for atomic-visit; one per-session for focus-group; one PU per stage for multi-stage). Payment *type* (visit/session/stage/piece) must match. Mismatch in count = 3-point deduction; mismatch in type = 3-point deduction. (Rate *affordability* against a real-world benchmark is graded in **Deployability**, not here — this dimension is structural-fit only.) |
   | **Deliver-unit wiring** | 0.16 | The Connect Opportunity must link to the same Deliver Unit name the Deliver app declares (Connectify-tagged form name) on the same HQ project space. Mismatch in deliver-unit name = 4-point deduction (Connect can't credit FLW visits). Wrong HQ app pointer = fail (≤3) — Connect would credit visits against the wrong app. Entity ID composite formula must match what the Deliver app computes (PDD spec ↔ Deliver-app summary ↔ Connect read should agree); divergence between any two = 3-point deduction. |
   | **Active-window + status** | 0.16 | Active-window duration matches PDD Timeline section ±10%. Status at end of Phase 4 must be `draft` — Phase 6 `llo-launch` activates. Premature activation is a fail (≤3) since it would let LLOs deliver before apps are tested and the bot is gated. Window shorter than the PDD declares (truncates the program's planned duration) is a 2-point deduction; longer than PDD declares (drift, but operationally safe) is a 0.5-point INFO deduction. |
   | **Archetype-config coherence** | 0.10 | The end-to-end opp config — verification flags + payment unit + deliver-unit + active window — must read coherently for the declared archetype, even when each individual dimension is inside tolerance. Examples: an `atomic-visit` opp with per-session payment + room-level GPS + facilitator-stipend = incoherent (those are focus-group defaults misapplied). Each cross-dimensional misfit = 2-point deduction. The grader uses anchors: full-archetype-coherent = **9.5**; one cross-dim misfit = **7.0**; multiple = **4.0**; all cross-dims wrong for archetype = **2.0**. |

   **Deduction rules:**
   - Any single dimension ≤ 3 → suite verdict `fail`, regardless of
     overall mean.
   - **Deployability hard-gate.** If `deployability` ≤ 3 (rate below the
     plausible local market floor, or a verification threshold class
     flatly unworkable for the named field context), the suite verdict
     is `fail` regardless of how faithfully the config matches the PDD.
     A faithful-but-undeployable opp cannot clear `pass`. Emit a
     `[BLOCKER]`.
   - **Inflation guard (mirrors sibling rubrics):** if the rubric
     surfaces ≥ 2 `[WARN]`-tier `auto_surfaced` entries, overall is
     capped at **8.5**. `[PLATFORM]`, `[DRIFT]`, `[INFO]`, and
     `[INFO-SKIPPED]` entries are tracked separately and do NOT count
     toward this guard.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3, `live_state_verified: true`.
   - `partial` — overall ≥ 7.0, no dimension ≤ 3, **artifact looks
     correct on paper but live MCP probes failed at grading time**
     (network, auth, transient Connect 5xx). Set `live_state_verified:
     false`. Caps overall at **8.5** to mark not-fully-verified.
   - `warn` — overall ≥ 5.0 < 7.0, or any inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3.
   - `incomplete` — degraded-mode `TBD-MANUAL` artifacts, missing PDD
     or opp-setup summary, or any other structural gap that makes
     grading impossible.

   **Severity tiers** for `auto_surfaced` entries (same set as the
   sibling rubric):
   - `[BLOCKER]` — must-fix before merge. Counts as a hard defect.
   - `[WARN]` — should-fix; counts toward inflation guard.
   - `[DRIFT]` — `connect-opp-setup_summary.md` claims disagree with
     `connect_get_opportunity` / `connect_list_*` live read.
     Diagnostic-only; does NOT deduct (the dimension consuming either
     source already deducts if either is wrong).
   - `[PLATFORM]` — defect originates in Connect itself, not the
     skill's output. Does NOT count toward inflation guard.
   - `[INFO]` — observational, no action required.

6. **Live-state-drift check.** When `live_state_verified = true`, after
   grading the dimensions from `connect-opp-setup_summary.md`, compare
   each summary claim against the live `connect_get_opportunity` /
   `connect_list_payment_units` / `connect_list_deliver_units` response.
   Emit a `[DRIFT]` entry per discrepancy. Drift is diagnostic, not
   deductive — the dimension score already reflects whichever source is
   wrong; counting it twice double-penalizes. The drift log is the
   audit trail downstream investigation reads.

7. **Write the verdict YAML** to
   `4-connect/connect-opp-setup-eval_verdict.yaml` using the shape from
   `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     deployability:                 { weight: 0.22 }   # out-of-chain fitness; hard-gate at ≤3
     verification_flag_fidelity:    { weight: 0.20 }
     payment_unit_fit:              { weight: 0.16 }
     deliver_unit_wiring:           { weight: 0.16 }
     active_window_status:          { weight: 0.16 }
     archetype_config_coherence:    { weight: 0.10 }
   # weights sum to 1.00
   ```

   Always set `live_state_verified` based on whether `connect_get_*` /
   `connect_list_*` probes succeeded — false forces verdict ≤ `partial`.

8. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` when `deployability` ≤ 3 — payment rate below the
     plausible local market floor, or a verification threshold class
     flatly unworkable for the named field context.
   - `[WARN]` for a soft deployability concern (rate thin but above
     floor; a threshold survivability concern that degrades but doesn't
     break field use).
   - `[WARN]` for each PDD Layer A rule missing from Connect verification
     flags where Connect *could* enforce it.
   - `[WARN]` for deliver-unit name or Entity ID composite mismatch.
   - `[WARN]` for payment-unit count or type mismatch.
   - `[PLATFORM]` for Layer A rules Connect cannot enforce today.
   - `[DRIFT]` for each `connect-opp-setup_summary.md` ↔ live-state
     discrepancy. One entry per field.
   - `[INFO]` for each over-enforced rule (Connect enforces, PDD doesn't
     require).
   - `[INFO]` when the PDD declares no regional day-rate — note that
     `deployability` graded affordability against an external benchmark
     instead (PDD silence is a finding, not a skip).

9. **Defect-vs-cause discipline.** Mirrors `connect-program-setup-eval`
   § 8: state observations confidently, phrase causes tentatively. Use
   `Observed: <fact>. Likely cause (unverified): <hypothesis>.` when
   both are present. Verified causes (e.g., a follow-up
   `connect_get_opportunity` after a delay rules out lag) may be stated
   confidently with `verified by <probe>`.

## LLM-as-Judge Rubric

Calibration target on a non-degraded smoke-run Connect opp-setup:

- **Detection rate:** ≥ 80% of catalogued Connect-opp-setup issues from
  `eval-calibration/known-issues.md § Connect opp setup` (ground truth
  TBD — depends on real run, expect ~3–5 catalogued issues).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

This rubric ships at **provisional** until a real non-degraded
opp-setup run produces ground truth. Until then, it correctly emits
`incomplete` on degraded artifacts.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades per-delivery payment, GPS-and-photo verification flags at strict defaults, single deliver-unit wiring. |
| `focus-group` | Grades per-session payment, room-level GPS + attendance-check verification flags, FGD-form deliver-unit wiring. Adds a "facilitator-stipend vs participant-incentive" sub-check under `payment_unit_fit`. |
| `multi-stage` | Grades per-stage payment structure with stage-gate-aware verification flags. The Stage Gate from the PDD must show up in Connect as a per-stage transition rule. Adds a stage-coverage sub-check under `archetype_config_coherence`. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:

- ace-connect MCP (when `connect_opportunity_id` is real, not TBD):
  `connect_get_opportunity`, `connect_list_payment_units`,
  `connect_list_deliver_units`. Skip these calls in degraded mode.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

Per `skills/_eval-template.md § Dry-Run Behavior (stock)`, plus skip
the live `connect_get_*` / `connect_list_*` MCP calls (read-only but
treated as offline-unsafe under `--dry-run`).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-09 | Initial version. 5 dimensions: verification_flag_fidelity (0.25), payment_unit_fit (0.20), deliver_unit_wiring (0.20), active_window_status (0.20), archetype_config_coherence (0.15). Sibling of `connect-program-setup-eval`; together they cover Phase 4. Inflation guard at 8.5; same severity tier set ([BLOCKER]/[WARN]/[DRIFT]/[PLATFORM]/[INFO]/[INFO-SKIPPED]). Explicit `incomplete` verdict for degraded-mode artifacts. Live-state-drift check via `connect_get_opportunity` + `connect_list_payment_units` + `connect_list_deliver_units`. Ships at provisional calibration until a non-degraded run produces ground truth. Closes the "not yet migrated" registry row for `connect-opp-setup`. | ACE team |
| 2026-05-29 | Add out-of-chain fitness dimension per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. New `deployability` (0.22) grades payment-rate affordability against a *real regional day-rate benchmark* (not a PDD-declared one) and verification-threshold runtime-survivability for real FLWs — with a hard-gate (≤3 → suite `fail`) so a faithful-but-undeployable opp can't clear `pass`. Conformance dims reweighted down: verification_flag_fidelity 0.25→0.20, payment_unit_fit 0.20→0.16, deliver_unit_wiring 0.20→0.16, active_window_status 0.20→0.16, archetype_config_coherence 0.15→0.10. Weights sum to 1.00. The old `[INFO-SKIPPED]` "never deduct" payment-rate sanity sub-check (which conferred no deduction power) is retired — affordability now has teeth inside `deployability`. | ACE team |
