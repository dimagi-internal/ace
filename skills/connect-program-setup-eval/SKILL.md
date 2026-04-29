---
name: connect-program-setup-eval
description: >
  Judge a Connect Program/Opportunity configuration against the PDD that
  drove it. Cross-artifact LLM-as-Judge eval — checks program-fit
  decision (reuse vs create), opportunity verification rules, delivery
  units, payment units, and entity-id wiring against PDD spec. Writes a
  verdict YAML in the shared QA/eval shape so opp-eval can aggregate it.
  Covers the `connect` category for opp-eval (4th category, lifts
  coverage tier from adequate → full).
---

# Connect Program Setup Eval

The Connect-side configuration of a CRISPR-Connect opportunity is the
artifact that ties everything together: the PDD's intervention design
becomes a Program; the Learn/Deliver apps become Opportunity-linked
Connectify modules; the verification rules in the PDD's Evidence Model
become Connect's Layer A delivery-proof rules. This skill grades whether
that translation was faithful.

This is a **cross-artifact eval** in the same family as
`pdd-to-deliver-app-eval`, `pdd-to-learn-app-eval`, and
`idea-to-pdd-eval`. See `skills/eval-calibration/SKILL.md` for the
calibration methodology, and `docs/eval-calibration-learnings.md` for
patterns and anti-patterns observed building the first 4 strongly-
calibrated rubrics.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/pdd.md`
   - Connect setup summary: `ACE/<opp-name>/connect-setup-summary.md`
     (or `connect-setup/program.md` + `connect-setup/opportunity.md`).
   - Deployment summary: `ACE/<opp-name>/deployment-summary.md` (for
     verifying the linked HQ apps match what Connect actually points
     at).

2. **Detect degraded mode.** If the connect-setup artifacts contain
   `connect_program_id: TBD-MANUAL` or `connect_opportunity_id:
   TBD-MANUAL` — i.e., Phase 3 ran in degraded mode because the
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

5. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Program-fit decision** | 15% | Did Phase 3 reuse an existing Program when a clean fit existed, or create a new one when no fit existed? Reuse-when-fit and create-when-no-fit both = 10. Create-when-fit (missed reuse opportunity) = 6. Reuse-when-no-fit (forced fit, wrong domain) = 4. Decision quality is read from the `connect-setup-summary.md` rationale section. |
   | **Verification-rule fidelity** | 25% | The PDD's Evidence Model § Layer A specifies hard verification rules (GPS ≤Xm, photo present, consent=yes, market-hours window). Connect's verification flags must enforce the same rules — or, where Connect can't enforce a specific rule, the gap must be documented in the gate brief, not silently dropped. Missing a Layer A rule from Connect = 2-point deduction per rule. Adding a rule Connect enforces but the PDD doesn't require = 0.5-point deduction (over-enforcement is also a defect). |
   | **Delivery-unit wiring** | 20% | The Connect Opportunity must link to the same Deliver Unit name the Deliver app declares (Connectify-tagged form name). Mismatch is a 4-point deduction (Connect can't credit FLW visits). The Entity ID composite formula must match what the Deliver app computes for cross-opp duplicate detection. Mismatch in formula structure (e.g. PDD says `market_name + GPS hash`, Connect reads `market_name + landmark`) is a 3-point deduction. |
   | **Payment-unit fit** | 20% | Payment structure must match the PDD's intent: per-delivery for atomic-visit, per-session for focus-group, per-stage for multi-stage. Mismatch is a 3-point deduction. **Threshold sanity:** for atomic-visit with operational caps (≤N visits/FLW/day, ≤M visits/site/day), the per-delivery rate × max-daily-visits should be a sane day-rate for the LLO's region — flag (but don't deduct) if rate × max is outside 30–80% of the LLO's expected day-rate (often unstated in the PDD; this is informational). |
   | **Active-window + status** | 20% | Active-window duration matches PDD Timeline section ±10%. Status at end of Phase 3 must be `draft` (Phase 5 `llo-launch` activates) — premature activation is a fail (≤3) since it would let LLOs deliver before the apps are tested and the bot is gated. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean.
   - **Inflation guard (mirrors OCS / deliver-app / learn-app rubrics):**
     if the rubric surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries,
     overall is capped at **8.5**.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

6. **Write the verdict YAML** to
   `ACE/<opp-name>/verdicts/connect-program-setup-eval.yaml`:

   ```yaml
   skill: connect-program-setup-eval
   target: <connect_opportunity_id>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: connect-setup-summary.md

   overall_score: 8.4
   overall_score_pre_cap: 8.4
   verdict: pass | warn | fail | incomplete

   dimensions:
     program_fit_decision:        { score: 10.0, weight: 0.15 }
     verification_rule_fidelity:  { score: 8.0, weight: 0.25 }
     delivery_unit_wiring:        { score: 9.0, weight: 0.20 }
     payment_unit_fit:            { score: 8.0, weight: 0.20 }
     active_window_status:        { score: 9.0, weight: 0.20 }

   per_item:
     - ref: "Program creation: Food Safety Market Survey"
       score: 10.0
       verdict: pass
       note: "Created new program — no existing program shared both food-safety domain AND atomic-visit archetype shape per Phase 3's labs_context survey of 58 programs."
     # ... per check

   auto_surfaced:
     - severity: WARN
       message: "Layer A market-hours window (LLO-configured per district) not yet enforced in Connect verification rules — left to Phase 5 UAT to populate."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

7. **Auto-surfaced concerns:**
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall is below 7.0.
   - `[WARN]` for each PDD Layer A rule missing from Connect verification.
   - `[WARN]` for Delivery Unit name or Entity ID composite mismatch.
   - `[INFO]` for each over-enforced rule (Connect enforces, PDD doesn't require).
   - `[INFO]` for unscored/unspeccable payment-rate sanity check.

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

- Google Drive: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`
- ace-connect MCP (when `connect_program_id` and `connect_opportunity_id`
  are real, not TBD): `connect_get_program`, `connect_get_opportunity`,
  `connect_list_payment_units`, `connect_list_deliver_units`. These
  let the rubric verify the live Connect state against the
  `connect-setup-summary.md` claims, catching skill-output-vs-actual
  drift. Skip these calls in degraded mode.

## Mode Behavior

- **Auto:** Grade, write verdict + report, return overall and
  disposition.
- **Review:** Pause after grading.

## Dry-Run Behavior

When `--dry-run` is active:
- Read PDD and connect-setup artifacts normally — read-only.
- Skip the live `connect_get_*` MCP calls (they're read-only too,
  but `--dry-run` keeps the exercise fully offline).
- Write verdict + report (human-facing artifacts).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: program_fit_decision (0.15), verification_rule_fidelity (0.25 — most load-bearing for Layer A faithfulness), delivery_unit_wiring (0.20), payment_unit_fit (0.20), active_window_status (0.20). Inflation guard at 8.5. Explicit `incomplete` verdict for degraded-mode artifacts (the Phase 3 mode that ran on smoke-20260428-1242 before ace-connect MCP shipped) — degraded mode is environment, not quality, and shouldn't deduct. Ships at provisional calibration until a non-degraded run produces ground truth. | ACE team (eval system buildout — 0.9.8) |
