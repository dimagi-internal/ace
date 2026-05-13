---
name: ocs-widget-handoff-eval
description: >
  Grade the OCS widget-handoff staging artifact for HITL paste-in —
  widget URL, embed key, opportunity-binding instructions.
disable-model-invocation: true
---

# OCS Widget Handoff Eval

The OCS widget is staged at the end of Phase 5 (`ocs-setup`) for the LLO
to paste into Connect's opportunity-config UI in Phase 9 (`llo-onboarding`).
Until CCC-301 ships an `update_opportunity` API for widget-config, this
hop is HITL. This rubric grades the staging artifact (`ocs-setup/widget-handoff.md`)
to make sure the operator has everything they need: a real widget URL, a
real embed key, and the right opportunity-binding instructions.

See `skills/_eval-template.md` for shared contracts. Authored 0.10.29 to
absorb turmeric run_time_followups item 10 (HITL widget paste-in until
CCC-301).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 5 | `5-ocs/ocs-setup_widget-handoff.md` | staging artifact under judgment |
| Phase 5 | `5-ocs/ocs-agent-setup.md` | cross-check `embed_key`, `experiment_id`, `public_id` |
| Per-run | `runs/<run-id>/run_state.yaml` | `connect_opportunity.url` |

## Products

- `5-ocs/ocs-widget-handoff-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect missing artifacts.** If `widget-handoff.md` is missing,
   emit `verdict: incomplete` with `[INFO] widget-handoff.md not
   found — Phase 5 ocs-setup did not write the staging artifact, or
   the LLO already pasted in and the artifact was archived`.

3. **Grade across 4 dimensions.**

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Widget URL resolves** | 25% | The widget URL in widget-handoff.md must (a) include the bot's `public_id`, (b) include a non-empty `embed_key`, (c) actually return a 200 from the OCS widget endpoint when fetched. URL-shape-correct but unreachable = ≤6 (server-side issue, [PLATFORM]). URL-shape-broken = ≤3. |
   | **Connect opp link** | 20% | widget-handoff.md must reference the Connect opportunity URL the LLO needs to paste INTO. Mismatch with run_state.yaml's `connect_opportunity.url` = 4-point deduction. Missing = ≤4. |
   | **Operator instructions clarity** | 30% | The handoff must tell a non-technical LLO (a) where to paste (Connect opp config tab, specific field name), (b) what to paste (the widget URL or just the embed_key, depending on Connect's UI), and (c) how to verify (chat-test prompt). Each missing element = 2-point deduction. |
   | **Credential hygiene** | 25% | embed_key is opp-specific, NOT a global API key. Surface a [WARN] if the handoff includes any global secret (OCS_TEAM_SLUG, OCS_GOLDEN_TEMPLATE_ID, etc.) — those should never appear in an LLO-facing artifact. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - Inflation guard: ≥2 `[WARN]` → cap at 8.5.
   - `[PLATFORM]` and `[DRIFT]` do NOT count.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3, widget URL fetched 200.
   - `partial` — overall ≥ 7.0 but the widget HTTP probe failed at
     grading time. Cap 8.5; `live_state_verified: false`.
   - `warn` — overall ≥ 5.0 < 7.0 OR inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3 OR a global secret
     leaked into the handoff (auto-fail; security guard).
   - `incomplete` — widget-handoff.md missing.

4. **Severity tiers:**
   - `[BLOCKER]` for any dimension ≤ 3, missing Connect opp link, or
     credential leak (a global secret in an LLO-facing doc).
   - `[BLOCKER]` if overall < 7.0.
   - `[WARN]` per missing operator-instruction element.
   - `[PLATFORM]` for the OCS widget endpoint returning 5xx during
     the probe (handoff structurally correct; live verification
     unavailable).
   - `[PLATFORM]` for Connect's lack of `update_opportunity` widget-config
     API (the entire reason this hop is HITL today). One canonical
     entry per verdict; ties to CCC-301.
   - `[DRIFT]` per widget-handoff claim ↔ live ocs_get_chatbot or
     run_state.yaml disagreement.
   - `[INFO]` for "widget URL fetched OK; LLO can paste."
   - `[INFO-SKIPPED]` for the live HTTP probe when offline-mode is requested.

5. **Write the verdict YAML** to
   `ACE/<opp-name>/runs/<run-id>/5-ocs/ocs-widget-handoff-eval_verdict.yaml`. The filename uses
   the **producer** skill name (`ocs-agent-setup` — the skill that
   produces `ocs-setup/widget-handoff.md` as one of its outputs), NOT
   this skill's name — see `agents/ace-orchestrator.md § Per-Step
   Eval Hook` for the naming rule. Body conforms to
   `lib/verdict-schema.ts`.

   ```yaml
   skill: ocs-widget-handoff-eval
   target: <opp-name>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: ocs-setup/widget-handoff.md

   overall_score: 8.7
   overall_score_pre_cap: 8.7
   verdict: pass
   live_state_verified: true

   dimensions:
     widget_url_resolves:           { score: 9.0,  weight: 0.25 }
     connect_opp_link:              { score: 9.5,  weight: 0.20 }
     operator_instructions_clarity: { score: 8.0,  weight: 0.30 }
     credential_hygiene:            { score: 9.5,  weight: 0.25 }

   per_item:
     - ref: "Widget URL"
       score: 9.0
       verdict: pass
       note: "Includes public_id 1fcddd08-...; embed_key wDwe70vquTL...; HTTP probe returned 200."
     - ref: "Connect opp link"
       score: 9.5
       verdict: pass
       note: "Matches run_state.yaml connect_opportunity.url for 249ad8fe-...; 'paste into Configuration → Chatbot Widget' instruction present."

   auto_surfaced:
     - severity: PLATFORM
       message: "Widget paste-in is HITL until CCC-301 (Connect's update_opportunity API for widget-config). LLO must manually paste; rubric grades staging not paste-in."
     - severity: INFO
       message: "embed_key is opp-specific (OCS bot-level), not a global secret. Safe to surface in LLO-facing doc."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

## LLM-as-Judge Rubric

**Provisional** until 3 real handoffs produce ground truth.

Calibration target:
- **Detection rate:** ≥ 80% of catalogued widget-handoff issues from
  `eval-calibration/known-issues.md § Widget handoff` (TBD).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

The 3 calibration runs should include:
1. A clean handoff (canonical pass).
2. A handoff missing the Connect opp link (drives BLOCKER).
3. A handoff with a leaked global secret (drives auto-fail).

## Archetypes

Archetype-agnostic. Widget handoff shape is identical for atomic-visit /
focus-group / multi-stage opps.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`
- ace-ocs MCP: `ocs_get_chatbot_embed_info` to cross-check embed_key
  and widget URL shape against the live bot.
- HTTP probe (no MCP): GET widget URL with a HEAD request to verify
  the endpoint returns 200 + sensible content-type.

## Mode Behavior

- **Auto:** Grade, write verdict.
- **Review:** Pause after grading.

## Dry-Run Behavior

- Read inputs normally.
- Skip the widget HTTP probe and Connect opp-link probe.
- Write verdict.
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-29 | Initial version. 4 dimensions: widget_url_resolves (0.25), connect_opp_link (0.20), operator_instructions_clarity (0.30 — heaviest because LLOs are non-technical), credential_hygiene (0.25 — security guard with auto-fail on global-secret leak). Provisional calibration. Absorbs turmeric run_time_followups item 10 (HITL widget paste-in until CCC-301). | ACE team (0.10.29) |
