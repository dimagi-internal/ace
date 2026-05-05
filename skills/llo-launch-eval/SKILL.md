---
name: llo-launch-eval
description: >
  Judge a Phase 5 `llo-launch` activation against the PDD's launch
  preconditions. Cross-skill LLM-as-Judge eval — checks UAT sign-off
  completeness, Connect activation correctness, app-publish status,
  go-live notification fidelity, and pre-launch gate-discipline. The
  most load-bearing Phase 5 rubric because go-live is the production
  gate. Writes a verdict YAML in the shared QA/eval shape.
---

# LLO Launch Eval

`llo-launch` is the Phase 5 skill that activates a CRISPR-Connect
opportunity for live FLW use. It's the production gate: any defect that
slips past it ships to real LLOs and FLWs in the field. This rubric
grades whether the activation was faithful to the PDD's launch
preconditions, with the same explicit-deduction discipline as the
other 4 strongly-calibrated rubrics in the eval framework.

This is the most load-bearing of the operate-category rubrics. See
`skills/eval-calibration/SKILL.md` for the methodology and
`docs/eval-calibration-learnings.md` for patterns observed building
the first 4 strongly-calibrated rubrics.

## Process

1. **Read inputs from GDrive:**
   - PDD: `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`
   - `llo-launch.md` or `launch-summary.md` — the activation record
   - `uat-results.md` (or `gate-briefs/llo-uat.md`) — UAT sign-offs
     the launch should have verified
   - `deployment-summary.md` — app-publish status the launch verified
   - `run_state.yaml` — gate states (`gates.llo-launch`, `gates.llo-invite`)

2. **Detect "phase not run" mode.** If `run_state.yaml` shows
   `phases.execution-management.llo-launch` not `done` or the launch
   artifact is missing, emit `verdict: incomplete` immediately with
   `[INFO] Phase 5 llo-launch not run; not gradable yet`.

3. **Grade across 5 dimensions.** Each dimension is 0–10. Overall
   score is the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **UAT sign-off completeness** | 25% | Every UAT participant from `llo-uat`'s sign-off list must have signed off (or have a documented blocker). Missing sign-offs = 3-point deduction per missing LLO. **Hard block:** a launch that fired with ≥1 LLO who explicitly did NOT sign off (vs simply pending) is a fail (≤3) — the producing skill missed a real veto. |
   | **Connect activation correctness** | 25% | Connect Opportunity status must transition from `draft` to `active`. Verification rules and payment units configured by Phase 3 must still match the PDD spec at activation time (no silent drift between Phase 3 and Phase 5). Missing activation transition = fail (≤3). Drift between Phase 3 and Phase 5 config = 2-point deduction per drift. |
   | **App-publish status** | 20% | Both Learn and Deliver apps must be published (not draft) on the configured HQ project space. App-publish status is read from `deployment-summary.md` and confirmed via Nova MCP at launch. Either app still in draft = fail (≤3). |
   | **Go-live notification fidelity** | 15% | The go-live notification email to LLOs must include: app links, calibration-gate threshold reminder (10/12 for atomic-visit calibrated rubrics), safety-plan summary if applicable, support-channel contact (`ace@dimagi-ai.com`). Missing required content = 1-point deduction per gap. **Factual error rule (mirrors OCS rubric 0.9.4):** wrong contact email, wrong threshold, wrong app link = 1-point Correctness deduction per occurrence with hard ceiling 7 on the affected email. |
   | **Pre-launch gate discipline** | 15% | All upstream gates must be `approved` before activation: `idea-to-pdd`, `app-deploy`, `ocs-chatbot-eval-deep`, `llo-invite`. Activating with any upstream gate still `pending` or `rejected` is a 4-point deduction (gate bypass). Activating with `gates.llo-launch` itself still `pending` (the producing skill skipped its own gate brief) is also a 4-point deduction. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`, regardless of
     overall mean. (Production gate; failure modes here ship to
     real LLOs.)
   - **Inflation guard (mirrors prior rubrics):** if the rubric
     surfaces ≥2 `[WARN]`-tier `auto_surfaced` entries, overall is
     capped at **8.5**.
   - **Pre-cap and post-cap reporting** per `eval-calibration` § 0.9.4
     guidance.

4. **Write the verdict YAML** to
   `ACE/<opp-name>/runs/<run-id>/7-execution-manager/llo-launch-eval_verdict.yaml`. The filename uses the
   **producer** skill name (`llo-launch`), NOT this skill's name —
   see `agents/ace-orchestrator.md § Per-Step Eval Hook` for the
   naming rule:

   ```yaml
   skill: llo-launch-eval
   target: <connect_opportunity_id>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: launch-summary.md

   overall_score: 8.5
   overall_score_pre_cap: 8.5
   verdict: pass | warn | fail | incomplete

   dimensions:
     uat_signoff_completeness:    { score: 9.0, weight: 0.25 }
     connect_activation_correctness: { score: 9.5, weight: 0.25 }
     app_publish_status:          { score: 10.0, weight: 0.20 }
     go_live_notification_fidelity: { score: 8.0, weight: 0.15 }
     pre_launch_gate_discipline:  { score: 9.5, weight: 0.15 }

   per_item:
     - ref: "Connect activation: draft → active"
       score: 9.5
       verdict: pass
       note: "Activation timestamp recorded in run_state.yaml; verification rules unchanged from Phase 3."
     # ... per check

   auto_surfaced:
     - severity: WARN
       message: "Go-live email sent before LLO 4 signed off (1 missing UAT sign-off — documented blocker, but launched anyway)."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

5. **Auto-surfaced concerns:**
   - `[BLOCKER]` for any dimension scoring ≤ 3.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` for activation with any LLO explicit reject (not pending).
   - `[BLOCKER]` for activation with any upstream gate not approved.
   - `[WARN]` per missing UAT sign-off (pending, not rejected).
   - `[WARN]` per Phase 3→Phase 5 verification-rule drift.
   - `[INFO]` per nice-to-have notification content missing.

## LLM-as-Judge Rubric

Calibration target on a real launch:

- **Detection rate:** ≥ 80% of catalogued launch issues from
  `eval-calibration/known-issues.md § LLO launch`.
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

This rubric ships at **provisional** until a real launch produces
ground truth. Until then, it correctly emits `incomplete` on opps
where Phase 5 hasn't reached llo-launch.

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Grades activation with calibration-gate threshold reminder. |
| `focus-group` | Adds a "facilitator-stipend payment-flow" sub-check (FGD opps pay differently from atomic-visit). |
| `multi-stage` | Grades stage-by-stage activation. Adds a "stage-gate-rule activation" sub-check (each stage transition must be configured at launch). |

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`,
  `drive_list_folder`
- ace-connect MCP: `connect_get_opportunity` (verify activation
  status against the connect_opportunity_id from connect-setup-summary).
- Nova MCP: `get_app` (verify HQ app publish status).

## Mode Behavior

- **Auto:** Grade, write verdict + report.
- **Review:** Pause after grading.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally — read-only.
- Skip live Connect/Nova MCP verification (use `deployment-summary.md`
  as the single source).
- Write verdict + report.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-28 | Initial version. 5 dimensions: uat_signoff_completeness (0.25), connect_activation_correctness (0.25), app_publish_status (0.20), go_live_notification_fidelity (0.15), pre_launch_gate_discipline (0.15). Inflation guard at 8.5. Explicit `incomplete` verdict when Phase 5 llo-launch hasn't run. Most load-bearing Phase 5 rubric. | ACE team (eval system buildout — 0.9.9) |
