---
name: connect-program-setup-eval
description: >
  Grade Connect Program + Opportunity configuration against the PDD —
  reuse-vs-create, verification rules, delivery units, payment units.
disable-model-invocation: true
---

# Connect Program Setup Eval

The Connect-side configuration of an ACE opportunity is the
artifact that ties everything together: the PDD's intervention design
becomes a Program; the Learn/Deliver apps become Opportunity-linked
Connectify modules; the verification rules in the PDD's Evidence Model
become Connect's Layer A delivery-proof rules. This skill grades whether
that translation was faithful.

But faithful-to-the-PDD is not the same as fit-to-deploy. Most
dimensions here triangulate PDD ↔ Connect-config (fidelity to the AI
authoring chain). Per
`skills/_eval-template.md § The out-of-chain fitness requirement`, the
**`deployability`** dimension (0.22) is the out-of-chain fitness axis:
payment-rate affordability against a *real regional day-rate benchmark*
(not a PDD-declared one) and whether the verification thresholds are
runtime-survivable for real FLWs — with a hard-gate so a faithful-but-
undeployable program can't clear `pass`. The `program_fit_decision`
dimension is also graded out-of-chain: the rubric re-derives reuse-vs-
create *independently* rather than reading the skill's own self-reported
rationale.

Sibling rubric to `pdd-to-deliver-app-eval`, `pdd-to-learn-app-eval`,
and `idea-to-pdd-eval`. See `skills/_eval-template.md` for shared
contracts, `skills/eval-calibration/SKILL.md` for calibration
methodology, and `docs/eval-calibration-learnings.md` for patterns
and anti-patterns from the first calibrated rubrics.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | source PDD; Evidence Model + verification spec drive expectation |
| Phase 4 | `4-connect/connect-program-setup.md` and `4-connect/connect-opp-setup.md` | program + opportunity config under judgment |
| Phase 3 | `3-commcare/app-deploy_summary.md` | HQ app IDs for cross-check on Connectify wiring |

## Products

- `4-connect/connect-program-setup-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).
   Additional sources read on demand:
   - Connect setup summary: `ACE/<opp-name>/runs/<run-id>/4-connect/connect-setup_summary.md`
     (or `connect-setup/program.md` + `connect-setup/opportunity.md`).
   - Deployment summary: `ACE/<opp-name>/runs/<run-id>/3-commcare/app-deploy_summary.md` (for
     verifying the linked HQ apps match what Connect actually points
     at).

2. **Detect degraded mode.** If the connect-setup artifacts contain
   `connect_program_id: TBD-MANUAL` or `connect_opportunity_id:
   TBD-MANUAL` — i.e., Phase 4 ran in degraded mode because the
   ace-connect MCP `create_*` tools weren't yet implemented — emit a
   `verdict: incomplete` immediately with `[INFO] degraded-mode
   artifacts; not gradable as Connect-real`. **Do not score zero or
   warn for degraded mode** — it's a structural gap in the
   environment, not a quality defect in the work. The rubric is
   explicitly designed to surface degraded mode as `incomplete` rather
   than blame the operator. Once the ace-connect MCP creation tools
   land (CCC-301; ace-connect 0.8.0/0.8.1 fulfill this), real
   verdicts become possible.

3. **Extract the PDD's Connect-relevant spec.** Build a structured
   expectation:
   - Program domain (food-safety, market-survey, vaccine-hesitancy, etc.)
   - Opportunity archetype (`atomic-visit` / `focus-group` / `multi-stage`)
   - Delivery type (data-collection, focus-group-facilitation, etc.)
   - Verification rules from Evidence Model § Layer A (GPS accuracy,
     photo presence, consent gate, market-hours window).
   - Delivery units (named slots in the Deliver app, typically the
     Connectify Deliver Unit name).
   - Payment units (per-delivery, per-day, per-piece — derive from
     Operational caps section).
   - Entity ID composite (typically declared in the Deliver app
     summary, but Connect must read the same composite for cross-
     opp duplicate detection).
   - Active window duration (Timeline section).

4. **Extract the built Connect config** from the connect-setup artifacts
   (and via `mcp__plugin_ace_ace-connect__connect_get_program` /
   `connect_get_opportunity` if the IDs are real, not TBD).

5. **Grade across 6 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Deployability (out-of-chain fitness)** | 22% | The out-of-chain anchor. Does NOT grade against the PDD — grades whether the program/opp as configured would actually work for real FLWs in the real region. **(a) Payment-rate affordability.** Estimate per-FLW daily earning (per-delivery rate × realistic max-daily-visits) and compare to a *real-world regional day-rate benchmark* for that geography and worker class (gig/CHW field rates for the country/region named in the PDD — use general domain knowledge of local market floors, NOT a PDD-declared figure). Below a plausible local market floor (a rate no real FLW would accept) = **hard-gate fail (≤3)** — the program won't recruit. Implausibly high (>3× a plausible day-rate, signalling a units/currency error) = 2-point deduction. **(b) Threshold runtime-survivability.** Would the verification thresholds wrongly reject legitimate deliveries or pass fraudulent ones in field conditions? A GPS radius too tight for real GPS jitter / tree cover / indoor markets (e.g. ≤10 m hard reject) bounces legitimate FLWs → 3-point deduction; one so loose it can't distinguish the site from a neighbour (e.g. >2 km) passes fraud → 3-point deduction; a photo/consent gate with no low-bandwidth fallback → 2-point deduction. Flatly unworkable for the named field context = **hard-gate fail (≤3)**. Anchors: deployable-as-configured = **9.0**; one soft survivability concern = **6.5**; rate below floor OR a threshold class unworkable = **≤3**. Exempt from any deferral carve-out — grade what a *deployable* program should contain even where the PDD was silent (PDD silence on a benchmark is a finding, not a free pass). |
   | **Program-fit decision** | 12% | Did Phase 4 reuse an existing Program when a clean fit existed, or create a new one when no fit existed? **Re-derive this independently — do NOT read the skill's own `connect-setup-summary.md` rationale section as the answer.** Reconstruct the correct decision from first principles: the PDD's program domain (food-safety, market-survey, vaccine-hesitancy, etc.) + the set of Programs already on the Connect org (via `connect_list_programs` when live) + the reuse criteria (same domain, same delivery type, same verification family). Then compare the skill's *action* (which Program it actually used, per the live `connect_get_program` / opp link) against your independent derivation. Reuse-when-fit and create-when-no-fit both = 10. Create-when-fit (missed reuse opportunity) = 6. Reuse-when-no-fit (forced fit, wrong domain) = 4. The summary's stated rationale is read ONLY as a `[DRIFT]` cross-check — if the skill's self-reported rationale disagrees with its own action, that's a `[DRIFT]` note, not the basis of the score. |
   | **Verification-rule fidelity** | 22% | The PDD's Evidence Model § Layer A specifies hard verification rules (GPS ≤Xm, photo present, consent=yes, market-hours window). Connect's verification flags must enforce the same rules — or, where Connect can't enforce a specific rule, the gap must be documented in the gate brief, not silently dropped. Missing a Layer A rule from Connect = 2-point deduction per rule. Adding a rule Connect enforces but the PDD doesn't require = 0.5-point deduction (over-enforcement is also a defect). |
   | **Delivery-unit wiring** | 16% | The Connect Opportunity must link to the same Deliver Unit name the Deliver app declares (Connectify-tagged form name). Mismatch is a 4-point deduction (Connect can't credit FLW visits). The Entity ID composite formula must match what the Deliver app computes for cross-opp duplicate detection. Mismatch in formula structure (e.g. PDD says `market_name + GPS hash`, Connect reads `market_name + landmark`) is a 3-point deduction. |
   | **Payment-unit fit** | 14% | Payment structure must match the PDD's intent: per-delivery for atomic-visit, per-session for focus-group, per-stage for multi-stage. Mismatch is a 3-point deduction. (Rate *affordability* against a real-world benchmark is graded in **Deployability**, not here — this dimension is structural-fit only.) |
   | **Active-window + status** | 14% | Active-window duration matches PDD Timeline section ±10%. Status at end of Phase 4 must be `active` **with `is_test=true`** — `connect-opp-setup` Step 6.5 activates synchronously by design so Phase 6 `app-screenshot-capture` has a real signed-in test user, and the `is_test` flag excludes the opp from prod LLO-facing analytics / payment exports / partner dashboards, so this is NOT premature go-live (real-LLO go-live is Phase 9 `llo-launch`, idempotent on an already-active opp). The fail cases (≤3) are: a `draft`/never-activated opp at end of Phase 4 (Phase 6 then can't capture screenshots), OR activation **without** `is_test=true` (a real opp leaking into prod analytics before apps are tested and the bot is gated). |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Deployability hard-gate.** If `deployability` ≤ 3 (rate below the
     plausible local market floor, or a verification threshold class
     flatly unworkable for the named field context), the suite verdict
     is `fail` regardless of how faithfully the config matches the PDD.
     A faithful-but-undeployable program cannot clear `pass`. Emit a
     `[BLOCKER]`.
   - **Inflation guard (mirrors OCS / deliver-app / learn-app rubrics):**
     if the rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries,
     overall is capped at **8.5**. `[PLATFORM]` and `[DRIFT]` entries
     are tracked separately (see § Severity tiers below) and do NOT
     count toward this guard — penalizing a Phase-4 skill for a
     Connect platform limit conflates "thing the operator can fix"
     with "thing they cannot."
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3, live state verified.
   - `partial` — overall ≥ 7.0, no dimension ≤ 3, **artifact looks
     correct on paper but live MCP probes failed at grading time**
     (network, auth, transient Connect 5xx). Set `live_state_verified:
     false`. Caps overall at **8.5** to mark not-fully-verified.
     Different from `incomplete` (which is reserved for structural
     gaps in the artifact itself, e.g. degraded-mode `TBD-MANUAL`
     IDs). `partial` says "score is from artifact text alone — re-run
     when MCP is reachable."
   - `warn` — overall ≥ 5.0 < 7.0, or any inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3.
   - `incomplete` — degraded-mode `TBD-MANUAL` artifacts, missing
     PDD or connect-setup-summary, or any other structural gap that
     makes grading impossible.

   **Severity tiers** for `auto_surfaced` entries:
   - `[BLOCKER]` — must-fix before merge. Counts as a hard defect.
   - `[WARN]` — should-fix; counts toward inflation guard.
   - `[DRIFT]` — `connect-setup-summary.md` claims disagree with
     `connect_get_*` live read. Diagnostic-only; the rubric records
     the discrepancy but does NOT deduct (the *score* dimension that
     consumes either source already deducts if either side is wrong;
     deducting a second time for the disagreement double-counts).
   - `[PLATFORM]` — defect originates in Connect itself, not the
     skill's output. Examples: a Connect form field that doesn't
     accept the spec'd value, an HTMX endpoint that returns no
     citation markup, an unsupported verification rule. Does NOT
     count toward inflation guard.
   - `[INFO]` — observational, no action required.

6. **Write the verdict YAML** to
   `4-connect/connect-program-setup-eval_verdict.yaml` using the shape
   from `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     deployability:               { weight: 0.22 }   # out-of-chain fitness; hard-gate at ≤3
     program_fit_decision:        { weight: 0.12 }   # independently re-derived, not read from skill rationale
     verification_rule_fidelity:  { weight: 0.22 }
     delivery_unit_wiring:        { weight: 0.16 }
     payment_unit_fit:            { weight: 0.14 }
     active_window_status:        { weight: 0.14 }
   # weights sum to 1.00
   ```

   Always set `live_state_verified` based on whether `connect_get_*`
   probes succeeded — false forces verdict ≤ partial.

7. **Auto-surfaced concerns** (per `_eval-template.md § Auto-surfaced
   severity rules`, plus skill-specific surfaces):
   - `[BLOCKER]` when `deployability` ≤ 3 — payment rate below the
     plausible local market floor, or a verification threshold class
     flatly unworkable for the named field context.
   - `[WARN]` for a soft deployability concern (rate thin but above
     floor; a threshold survivability concern that degrades but doesn't
     break field use).
   - `[WARN]` for each PDD Layer A rule missing from Connect verification
     where Connect *could* enforce it.
   - `[WARN]` for Delivery Unit name or Entity ID composite mismatch.
   - `[PLATFORM]` for Layer A rules Connect cannot enforce today
     (e.g. district-specific market-hours window). These document the
     gap without penalizing the skill.
   - `[DRIFT]` for each `connect-setup-summary.md` ↔ `connect_get_*`
     discrepancy. One entry per field. Also `[DRIFT]` when the skill's
     self-reported program-fit rationale disagrees with its own action
     (the score comes from the independent re-derivation, not the
     rationale text).
   - `[INFO]` for each over-enforced rule (Connect enforces, PDD doesn't require).
   - `[INFO]` when the PDD declares no regional day-rate — note that
     `deployability` graded affordability against an external benchmark
     instead (PDD silence is a finding, not a skip).

   **Live-state-drift check (new in 0.10.7):** when `live_state_verified
   = true`, after grading the dimensions from `connect-setup-summary.md`,
   compare each summary claim against the live `connect_get_program` /
   `connect_get_opportunity` / `connect_list_payment_units` /
   `connect_list_deliver_units` response. Emit a `[DRIFT]` entry per
   discrepancy. Drift is diagnostic, not deductive — the dimension
   score already reflects whichever source is wrong; counting it twice
   double-penalizes. The drift log is the audit trail that lets
   downstream investigation know which side to trust.

8. **Defect-vs-cause discipline.** When writing `auto_surfaced` and
   `per_item.note` text:
   - **State the observation confidently.** "X was created with all
     fields filled but `connect_get_program` returns empty fields" is
     a fact you saw.
   - **Phrase causes tentatively** — "consistent with", "one possible
     cause is", "the symptom matches a serialization or read-path
     gap." Never assert "this is a serialization gap" unless you
     traced it. LLM-as-Judge tends to pattern-match to the most
     familiar root cause; that's frequently wrong.
   - When the message includes both, separate them:
     `Observed: <fact>. Likely cause (unverified): <hypothesis>.`
   - Verified causes (where the rubric ran a probe, e.g. a follow-up
     `connect_get_program` after a delay to rule out lag) may be
     stated confidently — note "verified by <probe>".

   This rule was added 0.10.6 after `connect-program-setup-eval` on
   `turmeric-market-survey-2026-04-28` correctly flagged a real bug
   (Program edit form fields missing post-create) but mis-attributed
   it to a write-side serialization gap — the actual cause was a
   read-side hydration bug in `getProgram`. The eval was right about
   the defect, wrong about the layer.

## LLM-as-Judge Rubric

Calibration target on a non-degraded smoke-run Connect setup:

- **Detection rate:** ≥ 80% of catalogued Connect-setup issues from
  `eval-calibration/known-issues.md § Connect setup` (ground truth
  TBD — depends on real run, expect ~3–5 catalogued issues).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 across Sonnet/Opus/Haiku for strong
  calibration.

This rubric ships at **provisional** until a real non-degraded
Connect run produces ground truth. Until then, it correctly emits
`incomplete` on degraded artifacts and provides the framework for
future grading.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades per-delivery payment, GPS-and-photo verification rules, single-Deliver-Unit wiring. |
| `focus-group` | Grades per-session payment, attendance + per-domain-summary verification rules, FGD-form Delivery-Unit wiring. Adds a "facilitator-stipend vs participant-incentive" sub-check under payment_unit_fit. |
| `multi-stage` | Grades per-stage payment structure with stage-gate-aware verification rules. The Stage Gate from the PDD must show up in Connect as a status transition rule. |

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- ace-connect MCP (when `connect_program_id` and `connect_opportunity_id`
  are real, not TBD): `connect_get_program`, `connect_get_opportunity`,
  `connect_list_payment_units`, `connect_list_deliver_units`,
  `connect_list_programs` (the last enumerates existing org Programs so
  `program_fit_decision` can be re-derived independently of the skill's
  own rationale). These
  let the rubric verify the live Connect state against the
  `connect-setup-summary.md` claims, catching skill-output-vs-actual
  drift. Skip these calls in degraded mode.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

Per `skills/_eval-template.md § Dry-Run Behavior (stock)`, plus skip
the live `connect_get_*` MCP calls (read-only but treated as offline-
unsafe under `--dry-run`).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: program_fit_decision (0.15), verification_rule_fidelity (0.25 — most load-bearing for Layer A faithfulness), delivery_unit_wiring (0.20), payment_unit_fit (0.20), active_window_status (0.20). Inflation guard at 8.5. Explicit `incomplete` verdict for degraded-mode artifacts (the Phase 4 mode that ran on smoke-20260428-1242 before ace-connect MCP shipped) — degraded mode is environment, not quality, and shouldn't deduct. Ships at provisional calibration until a non-degraded run produces ground truth. | ACE team (eval system buildout — 0.9.8) |
| 2026-04-29 | Defect-vs-cause discipline added (step 8). Driven by the `turmeric-market-survey-2026-04-28` run mis-attributing a real read-side hydration bug to a write-side serialization gap. The rubric correctly flagged the symptom; the rubric did not constrain causal attribution. Now requires confident observation + tentative cause, with `Observed: ... Likely cause (unverified): ...` formatting when both are present. | ACE team (0.10.6) |
| 2026-05-29 | Add out-of-chain fitness dimension per `docs/superpowers/specs/2026-05-29-eval-fitness-gap.md`. New `deployability` (0.22) grades payment-rate affordability against a *real regional day-rate benchmark* (not a PDD-declared one) and verification-threshold runtime-survivability for real FLWs — hard-gate (≤3 → suite `fail`) so a faithful-but-undeployable program can't clear `pass`. `program_fit_decision` is now graded by **independently re-deriving** reuse-vs-create (PDD domain + `connect_list_programs` + reuse criteria) rather than reading the skill's self-reported rationale; the rationale is now only a `[DRIFT]` cross-check. Reweighted to fit `deployability`: program_fit_decision 0.15→0.12, verification_rule_fidelity 0.25→0.22, delivery_unit_wiring 0.20→0.16, payment_unit_fit 0.20→0.14, active_window_status 0.20→0.14. Weights sum to 1.00. Retired the `[INFO-SKIPPED]` "never deduct" payment-rate sanity sub-check (no deduction power) — affordability now has teeth inside `deployability`. | ACE team |
| 2026-04-29 | Five-item rubric polish from the turmeric run's first non-degraded grading. (1) Added `partial` verdict tier for runtime-blocked-but-not-degraded mode (artifact correct, live MCP probes unreachable). Caps at 8.5; `live_state_verified: false`. (2) `[PLATFORM]` severity tier for defects that originate in Connect itself rather than skill output; does NOT count toward the inflation guard. Removes a class of false-deduction where the skill is penalized for a Connect schema limit. (3) `[DRIFT]` severity tier for `connect-setup-summary` ↔ live-state discrepancies; diagnostic-only, never deductive (the dimension consuming either source already deducts if either is wrong; counting drift again double-penalizes). New live-state-drift check runs after dimensional grading. (4) Payment threshold-sanity sub-check now explicitly conditional: if PDD declares no regional day-rate, emit `[INFO-SKIPPED]` and skip — do NOT count as defect. Documents the coverage gap without penalizing. (5) `live_state_verified` boolean added to verdict schema; forces verdict ≤ `partial` when false. | ACE team (0.10.7) |
