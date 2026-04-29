---
name: app-screenshot-capture
description: >
  Drive the CommCare Android app (which integrates Connect/ConnectID as of
  2.62.0) through scripted Maestro flows on a local AVD and capture one PNG
  per recipe step into Drive. First step of Phase 5 (training-prep). Produces
  ACE/<opp>/screenshots/ + manifest.yaml.
---

# App Screenshot Capture

Run scripted Maestro flows against a local AVD, capture PNGs at every step, and upload them to Drive.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/pdd.md` | archetype branching only |
| Phase 2 | `ACE/<opp>/app-summaries/learn-app-summary.md` | recipe generation |
| Phase 2 | `ACE/<opp>/app-summaries/deliver-app-summary.md` | recipe generation |
| Phase 2 | `ACE/<opp>/deployment-summary.md` | HQ domain for `${HQ_DOMAIN}` env var |
| Phase 3 | `ACE/<opp>/connect-state.yaml` | `opportunity_name` + `ace_test_user_invite_url` |

## Process

1. **Read upstream artifacts** from Drive. If any are missing, exit with a structured error pointing at the upstream phase.

2. **Generate per-module recipes**:
   - Call `MobileClient.generateRecipesFromAppSummary` for Learn (`'learn'`) and Deliver (`'deliver'`).
   - Output: `ACE/<opp>/mobile-recipes/{learn,deliver}/module-N.yaml` + `manifest.yaml`.

3. **Boot AVD + ensure apps installed** via `mobile_ensure_avd_running` and `mobile_install_apk` (no-op if cached).

4. **Run static recipes**:
   - `connect-login.yaml` with `${ACE_E2E_PHONE_LOCAL}`, `${ACE_E2E_PIN}`.
   - `connect-claim-opp.yaml` with `${OPP_NAME}` from `connect-state.yaml`.

5. **Run generated recipes**, in order:
   - For each `module-N.yaml` under `mobile-recipes/learn/`, then `mobile-recipes/deliver/`.
   - Each `mobile_run_recipe` returns a list of screenshots; upload each to `ACE/<opp>/screenshots/<recipe-stem>/<step-name>.png`.

6. **Write `ACE/<opp>/screenshots/manifest.yaml`** listing every recipe, every step name, every Drive path, every step label (the `takeScreenshot:` argument).

7. **Self-evaluate (LLM-as-Judge):**
   - Did every recipe complete (status: pass)?
   - Are screenshots of expected count produced (≥ 1 per `takeScreenshot` step)?
   - Are all screenshots non-zero bytes?

8. **Write verdict** to `verdicts/app-screenshot-capture.yaml` with status pass/fail and per-recipe breakdown so `opp-eval` can aggregate.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_file`, `drive_list_folder`.
- `ace-mobile`: `mobile_ensure_avd_running`, `mobile_install_apk`, `mobile_run_recipe`. (`generate_recipes_from_app_summary` is invoked programmatically inside the skill, not as an MCP tool.)

## Mode Behavior

- **Auto:** Run end-to-end, write artifacts, proceed.
- **Review:** Pause after generating recipes for human inspection of `mobile-recipes/`; resume on approval.

## Dry-Run Behavior

- Generate recipes and write to Drive normally.
- Skip AVD boot and `mobile_run_recipe` calls.
- Write empty manifest with `dry_run: true` flag.
- State tracks as `dry-run-success`.

## LLM-as-Judge Rubric

| Dimension | Pass criteria |
|---|---|
| Coverage | every Learn module + every Deliver form has a generated recipe |
| Execution | every recipe status: pass |
| Artifact quality | every screenshot is a valid PNG with non-zero bytes |
| Manifest integrity | manifest.yaml lists every screenshot path actually present in Drive |

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-04-28 | Initial version (mobile-emulation work) | ACE team |
