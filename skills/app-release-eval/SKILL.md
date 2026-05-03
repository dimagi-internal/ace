---
name: app-release-eval
description: >
  Judge a Phase 2 `app-release` run against its deployment-summary.md. Verifies
  every uploaded build was successfully released (Connect can read released
  builds only), CCZ-marker checks passed, and no draft-only apps remain.
  Provisional rubric — calibration TBD until 3+ real releases ship.
---

# App Release Eval

`app-release` makes versioned + released builds for the Learn and Deliver
apps Nova uploaded as drafts. Connect's `Sync Deliver Units` reads only
*released* builds, so an unreleased app silently breaks Phase 3 with an
empty deliver-units list. This rubric grades whether the release step
delivered everything Phase 3 needs.

This is a single-artifact eval (deployment-summary.md after app-release
runs). Authored 0.10.29 in response to turmeric run_time_followups item 2
(CCZ-marker regex bug in app-release).

## Process

1. **Read inputs from GDrive:**
   - `ACE/<opp-name>/deployment-summary.md` — the artifact app-release
     updates with `releases:` block.
   - `ACE/<opp-name>/run_state.yaml` — for cross-check on `hq_app_id` /
     `hq_build_id` per-app entries under `learn_app_summary` /
     `deliver_app_summary`.

2. **Detect missing artifacts.** If `deployment-summary.md` is missing
   or has no `releases:` block, emit `verdict: incomplete` immediately
   with `[INFO] app-release output missing — skill did not run or did
   not complete writing its artifact`. Do not score zero.

3. **Grade across 4 dimensions.** Each dimension is 0–10. Overall is
   the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Both apps released** | 35% | Both Learn and Deliver have `is_released: true` and a `latest_released_version` ≥ 1 in the deployment-summary `releases:` block. Either app missing release = ≤3 (fail). One app released, the other still draft = ≤6 (warn). |
   | **CCZ-marker integrity** | 25% | CCZ verification (Step 6 of app-release) confirms each released build has the canonical Connect markers (`connect.learn_module` / `connect.deliver_unit` / `connect.assessment`). Missing markers = ≤4 deduction per missing class. (Note: this is the dimension that catches turmeric run_time_followups item 2 — the CCZ regex bug that uses `<learn:` prefix instead of the actual `xmlns` attribute. A regex bug that mis-reports a perfectly-marked app as missing markers should surface as a [PLATFORM] entry on the CCZ-checker side, not a deduction here.) |
   | **Build-id traceability** | 20% | The `hq_build_id` recorded in run_state.yaml (post-release) matches the `_id` returned by the CCHQ `apps/save` step and the `latest_released_version` matches what `releases/release/<build_id>/` returned. Mismatch = 4-point deduction. |
   | **Connect deliver-units enumerable** | 20% | After release, Connect's `Sync Deliver Units` should successfully enumerate at least one deliver unit per Deliver-app form. Verified by checking `connect-setup-summary.md` (Phase 3) for the `Sync Deliver Units enumerated:` line; OR if Phase 3 hasn't run yet, by `connect_list_deliver_units` MCP probe against the opp. Empty enumeration = 4-point deduction (release didn't actually unblock Phase 3). |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - **Inflation guard:** if ≥2 `[WARN]` `auto_surfaced` entries, overall capped at 8.5.
   - `[PLATFORM]` and `[DRIFT]` do NOT count toward the inflation guard.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3, both apps released, CCZ clean.
   - `warn` — overall ≥ 5.0 < 7.0, or any inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3.
   - `partial` — overall ≥ 7.0 but live MCP probes for Connect-side
     verification failed at grading time.
   - `incomplete` — deployment-summary.md missing or no `releases:` block.

   **Severity tiers** (mirror connect-program-setup-eval):
   - `[BLOCKER]` — must-fix before Phase 3 can proceed (e.g., one app unreleased).
   - `[WARN]` — should-fix; counts toward inflation guard.
   - `[PLATFORM]` — defect originates in CCHQ or Nova, not the skill
     (e.g., the CCZ-marker regex bug uses `<learn:` instead of xmlns
     attribute matching — that's a skill bug, see below; but a CCHQ
     5xx during release IS PLATFORM).
   - `[DRIFT]` — deployment-summary claim disagrees with live `apps/view`
     read. Diagnostic only.
   - `[INFO]` — observational.
   - `[INFO-SKIPPED]` — sub-check intentionally skipped.

4. **Special case — turmeric run_time_followups item 2 (CCZ regex
   bug).** Apps released cleanly on turmeric; the CCZ-marker check
   in app-release Step 6 falsely flagged "missing markers" because
   its regex looks for `<learn:` prefix while the actual XML uses
   `xmlns` attributes. The bug is in app-release (the skill that
   does the check), not in the build itself.
   - When running this eval and the CCZ check reports missing markers,
     ALSO read the build's actual XML (via run_state.yaml's hq_build_id +
     the CCHQ build endpoint) and verify whether markers are really
     missing. If markers are present in the XML but the CCZ check
     mis-reports them, surface as `[WARN] CCZ regex false-positive in
     app-release Step 6 — Observed: app-release reported 'no
     <learn:...> tag found' but xmlns inspection shows
     xmlns:vellum='http://commcarehq.org/xforms/vellum'. Likely cause
     (unverified): regex matches a literal '<learn:' prefix that
     CCHQ no longer emits.` Drop the CCZ-integrity dimension to ≤6
     ONLY if the markers are actually missing in the XML.

5. **Write the verdict YAML** to
   `ACE/<opp-name>/verdicts/app-release.yaml`. The filename uses the
   **producer** skill name (`app-release`), NOT this skill's name —
   see `agents/ace-orchestrator.md § Per-Step Eval Hook` for the
   naming rule. Body conforms to `lib/verdict-schema.ts` (validated by
   `npm run validate:verdicts`).

   ```yaml
   skill: app-release-eval
   target: <opp-name>
   mode: deep
   ran_at: <ISO timestamp>
   capture_path: deployment-summary.md

   overall_score: 8.6
   overall_score_pre_cap: 8.6
   verdict: pass | warn | fail | incomplete | partial
   live_state_verified: true

   dimensions:
     both_apps_released:           { score: 10.0, weight: 0.35 }
     ccz_marker_integrity:         { score: 8.0,  weight: 0.25 }
     build_id_traceability:        { score: 9.0,  weight: 0.20 }
     deliver_units_enumerable:     { score: 9.5,  weight: 0.20 }

   per_item:
     - ref: "Learn app release"
       score: 10.0
       verdict: pass
       note: "hq_app_id 3377db1906...; hq_build_id 981e44b71...; latest_released_version 1; is_released true."
     - ref: "Deliver app release"
       score: 10.0
       verdict: pass
       note: "hq_app_id c1e89a25e9...; hq_build_id 1ae25d80a...; latest_released_version 1; is_released true."

   auto_surfaced:
     - severity: WARN
       message: "CCZ regex false-positive in app-release Step 6 — Observed: app-release reported 'no <learn:...> tag found' but xmlns inspection shows xmlns:vellum=...; markers present. Likely cause (unverified): regex matches a literal '<learn:' prefix that CCHQ no longer emits."

   gate:
     threshold: 7.5
     disposition: approve | reject | iterate
   ```

## Auto-surfaced concerns

- `[BLOCKER]` for any dimension ≤ 3 (e.g., one app unreleased blocks Phase 3).
- `[BLOCKER]` if overall < 7.0.
- `[WARN]` per dimension scoring 4.0–6.9.
- `[WARN]` per CCZ regex false-positive that mis-flagged a clean build.
- `[PLATFORM]` per CCHQ 5xx, Nova upload-shape change, or CCZ format
  change requiring app-release update.
- `[DRIFT]` per deployment-summary ↔ live `apps/view/<app_id>` discrepancy.
- `[INFO]` per `latest_released_version > 1` (re-release scenario,
  worth noting in opp-eval).

## LLM-as-Judge Rubric

**Provisional calibration** — ships at provisional until 3 real releases
produce ground truth. Calibration target on a clean release:

- **Detection rate:** ≥ 80% of catalogued release issues from
  `eval-calibration/known-issues.md § App release` (TBD).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Cross-model variance:** ≤ 1.0 for strong calibration.

The first 3 calibration runs should specifically include:
1. A clean dual-release (the canonical pass case).
2. A run where one app released but the other failed mid-release
   (drives the partial-release fail mode).
3. A run with a CCZ regex false-positive (drives the [WARN] tier).

## Archetypes

| Archetype | What this skill does |
|---|---|
| `atomic-visit` | Default. Two-app release (Learn + Deliver). |
| `focus-group` | Two-app release with FGD-form Deliver. Same shape. |
| `multi-stage` | One Learn + one Deliver per stage. Dimension scores aggregate per-stage. |

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_create_file`, `drive_list_folder`
- ace-connect MCP (when Phase 3 has run): `connect_list_deliver_units`
  to verify Connect can enumerate deliver units from the released build.
- CCHQ HTTP probe (no MCP yet): `GET /a/<domain>/apps/view/<app_id>/`
  to verify is_released against the build_id in run_state.yaml.

## Mode Behavior

- **Auto:** Grade, write verdict.
- **Review:** Pause after grading.

## Dry-Run Behavior

- Read deployment-summary normally.
- Skip live CCHQ + Connect probes.
- Write verdict (human-facing artifact).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-29 | Initial version. 4 dimensions: both_apps_released (0.35), ccz_marker_integrity (0.25), build_id_traceability (0.20), deliver_units_enumerable (0.20). Provisional calibration. Authored to absorb turmeric run_time_followups item 2 (CCZ regex false-positive in app-release Step 6) — the eval has an explicit step 4 to distinguish "regex bug" from "real missing markers." | ACE team (0.10.29) |
