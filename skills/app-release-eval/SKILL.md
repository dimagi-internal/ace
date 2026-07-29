---
name: app-release-eval
description: >
  Verify every Learn + Deliver build was actually released so Connect
  can read deliver units. Provisional rubric pending 3+ real releases.
disable-model-invocation: false
---

# App Release Eval

`app-release` makes versioned + released builds for the Learn and Deliver
apps Nova uploaded as drafts. Connect's `Sync Deliver Units` reads only
*released* builds, so an unreleased app silently breaks the next phase
with an empty deliver-units list. This rubric grades whether the
release step delivered everything downstream needs.

Single-artifact eval. Sees `_eval-template.md` for shared contracts.
Authored 0.10.29 in response to turmeric run_time_followups item 2
(CCZ-marker regex bug in app-release).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 3 | `3-commcare/app-deploy_summary.md` | the artifact `app-release` updates with `releases:` block |
| Phase 3 | `3-commcare/app-release_summary.md` | **the artifact `app-release` owns** — released `build_id` + version per app; the sole source for `build_id_traceability` |
| Phase 3 | `?latest=release` CCZ projection | deliver-unit list as Connect's Sync Deliver Units will see it (see `deliver_units_enumerable`) |
| Phase 4 (optional, later passes only) | `4-connect/connect-opp-setup.md` | live Connect confirmation of deliver-unit enumeration, when Phase 4 has already run |

**Do NOT grade against `run_state.yaml` (dimagi-internal/ace#1010).**
`app-release` explicitly disclaims that write — the **orchestrator** owns
it, at the Phase 3 boundary fence, which runs *after* the per-step evals.
So at the moment this eval fires, `run_state.yaml` is guaranteed not to
carry `hq_build_id` or a `phases.commcare-setup.steps.app-release` entry.
Grading it there scored a **perfect** release 6/10 on
`build_id_traceability` every single time — a fixed 0.8-point downward
bias, enough to move a `pass` toward `warn` on a build with any other
real finding. Grade the producer against its own contract, like every
other per-step eval does.

## Products

- `3-commcare/app-release-eval_verdict.yaml` — verdict YAML per `_eval-template.md § Verdict YAML contract`

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Detect missing artifacts.** If `3-commcare/app-deploy_summary.md` is missing
   or has no `releases:` block, emit `verdict: incomplete` immediately
   with `[INFO] app-release output missing — skill did not run or did
   not complete writing its artifact`. Do not score zero.

3. **Grade across 4 dimensions.** Each dimension is 0–10. Overall is
   the weighted mean.

   | Dimension | Weight | Criteria |
   |---|---|---|
   | **Both apps released** | 35% | Both Learn and Deliver have `is_released: true` and a `latest_released_version` ≥ 1 in the deployment-summary `releases:` block. Either app missing release = ≤3 (fail). One app released, the other still draft = ≤6 (warn). |
   | **CCZ-marker integrity** | 25% | CCZ verification (Step 6 of app-release) confirms each released build has the canonical Connect markers (`connect.learn_module` / `connect.deliver_unit` / `connect.assessment`). Missing markers = ≤4 deduction per missing class. (Note: this is the dimension that catches turmeric run_time_followups item 2 — the CCZ regex bug that uses `<learn:` prefix instead of the actual `xmlns` attribute. A regex bug that mis-reports a perfectly-marked app as missing markers should surface as a [PLATFORM] entry on the CCZ-checker side, not a deduction here.) |
   | **Build-id traceability** | 20% | Graded **against `3-commcare/app-release_summary.md`** — the artifact `app-release` is contractually required to write (ace#1010). Per app, it must carry a released `build_id` and a version number, and those must agree with the `releases:` block `app-release` appended to `app-deploy_summary.md`. Missing `build_id` for an app = 4-point deduction; the two artifacts disagreeing = 4-point deduction (that IS a real traceability defect). **Never deduct for `run_state.yaml` not carrying `hq_build_id` or an `app-release` step entry** — see the Inputs note: the orchestrator writes those minutes later, and grading them here is pure rubric noise. If a `run_state.yaml` written by a *previous* boundary-fence pass happens to be readable (e.g. on an `/ace:eval --all` re-grade), a disagreement with the summary is worth a `[DRIFT]` entry, not a deduction. |
   | **Connect deliver-units enumerable** | 20% | Does the released Deliver build actually expose deliver units for Connect to find? Score from whichever evidence exists, in this order: **(1) `?latest=release` CCZ projection (first-class, always available).** Download the released Deliver CCZ via the `?latest=release` projection — the literal artifact Connect's Sync Deliver Units consumes — and enumerate the forms carrying a `<learn:deliver>` marker. At least one unit per Deliver-app form = full marks on this path; zero units = 4-point deduction. **(2) Live Connect probe (upgrade to full marks).** When Phase 4 HAS already run, additionally confirm via `4-connect/connect-opp-setup.md`'s `Sync Deliver Units enumerated:` line or a `connect_list_deliver_units` probe. **Do NOT return `unverifiable` / `partial` just because Phase 4 hasn't run** (ace#1010): this eval fires inside Phase 3, so both of the previously-named paths were structurally unavailable at invocation time and the dimension carried no information. The CCZ projection answers the real question — "will Connect find a unit?" — without Phase 4. |

   **Deduction rules:**
   - Any single dimension ≤3 → suite verdict `fail`.
   - **Inflation guard:** if ≥2 `[WARN]` `auto_surfaced` entries, overall capped at 8.5.
   - `[PLATFORM]` and `[DRIFT]` do NOT count toward the inflation guard.

   **Verdict tiers:**
   - `pass` — overall ≥ 7.0, no dimension ≤ 3, both apps released, CCZ clean.
   - `warn` — overall ≥ 5.0 < 7.0, or any inflation cap binds.
   - `fail` — overall < 5.0 OR any dimension ≤ 3.
   - `partial` — overall ≥ 7.0 but live MCP probes for Connect-side
     verification failed at grading time. **Phase 4 simply not having
     run yet is NOT a `partial`** — the `?latest=release` CCZ projection
     is a first-class scoring path (ace#1010).
   - `incomplete` — 3-commcare/app-deploy_summary.md missing or no `releases:` block.

   **Severity tiers** (mirror connect-program-setup-eval):
   - `[BLOCKER]` — must-fix before Phase 4 can proceed (e.g., one app unreleased).
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
     ALSO read the build's actual XML (via the `build_id` in
     `3-commcare/app-release_summary.md` + the CCHQ build endpoint — NOT
     via `run_state.yaml`, which is not written yet; ace#1010) and verify
     whether markers are really missing. If markers are present in the XML but the CCZ check
     mis-reports them, surface as `[WARN] CCZ regex false-positive in
     app-release Step 6 — Observed: app-release reported 'no
     <learn:...> tag found' but xmlns inspection shows
     xmlns:vellum='http://commcarehq.org/xforms/vellum'. Likely cause
     (unverified): regex matches a literal '<learn:' prefix that
     CCHQ no longer emits.` Drop the CCZ-integrity dimension to ≤6
     ONLY if the markers are actually missing in the XML.

5. **Write the verdict YAML** to
   `3-commcare/app-release-eval_verdict.yaml` using the shape from
   `skills/_eval-template.md § Verdict YAML contract`. Dimensions:

   ```yaml
   dimensions:
     both_apps_released:        { weight: 0.35 }
     ccz_marker_integrity:      { weight: 0.25 }
     build_id_traceability:     { weight: 0.20 }
     deliver_units_enumerable:  { weight: 0.20 }
   ```

## Auto-surfaced concerns

Per `_eval-template.md § Auto-surfaced severity rules`, plus skill-
specific surfaces:
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

See `skills/_eval-template.md § MCP Tools Used (stock)` for the Drive
block. Plus:
- ace-connect MCP: `commcare_download_ccz` on the `?latest=release`
  projection — the first-class `deliver_units_enumerable` path.
- ace-connect MCP (only when Phase 4 has already run):
  `connect_list_deliver_units` to upgrade `deliver_units_enumerable` to
  full marks with a live Connect confirmation.
- CCHQ HTTP probe (no MCP yet): `GET /a/<domain>/apps/view/<app_id>/`
  to verify `is_released` against the `build_id` in
  `3-commcare/app-release_summary.md`.

## Known traps when grading a release

- **`last_released` reads `None` on a genuinely released build.** The
  ajax release path does not stamp that field, while `is_released` reads
  `True`. Do not use `last_released` as a release-recency signal or as
  evidence of a failed release.
- **`app-release-eval` and `app-release` share the same CCZ marker
  parser**, so a defect in that parser is invisible to both — there is no
  independent cross-check. When `ccz_marker_integrity` looks wrong,
  re-read the build XML directly (Step 4) rather than trusting either
  side's parse.
- **`eval-calibration/known-issues.md § App release` is still TBD**, so
  the ≥80% detection target below is currently *unmeasurable*. Treat the
  `fail` and `warn` tiers as asserted rather than validated, and add each
  graded release to the catalogue as it lands.

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

## Dry-Run Behavior

Per `skills/_eval-template.md § Dry-Run Behavior (stock)`, plus: skip
live CCHQ + Connect probes (read-only inputs OK; live probes treated
as effectful).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-04-29 | Initial version. 4 dimensions: both_apps_released (0.35), ccz_marker_integrity (0.25), build_id_traceability (0.20), deliver_units_enumerable (0.20). Provisional calibration. Authored to absorb turmeric run_time_followups item 2 (CCZ regex false-positive in app-release Step 6) — the eval has an explicit step 4 to distinguish "regex bug" from "real missing markers." | ACE team (0.10.29) |
| 2026-07-28 | **Two rubric dimensions re-pointed at gradable evidence (ace#1010).** (1) `build_id_traceability` graded `run_state.yaml`, which `app-release` explicitly does NOT write — the orchestrator does, at the Phase 3 boundary fence, AFTER the per-step evals run. A perfect release scored 6/10 on it every time: a fixed 0.8-point downward bias on every Phase 3 release eval. Now graded against `3-commcare/app-release_summary.md`, the artifact the skill actually owns, cross-checked against the `releases:` block. (2) `deliver_units_enumerable` was structurally un-verifiable at invocation — both its named paths needed Phase 4, and this eval runs inside Phase 3. The `?latest=release` CCZ projection (the literal artifact Sync Deliver Units consumes) is promoted to the first-class scoring path, with the live Connect probe as the upgrade to full marks; Phase 4 not having run is explicitly no longer a `partial`. Also recorded three grading traps: `last_released: None` on a released build, the shared marker parser with no independent cross-check, and the TBD known-issues catalogue that leaves the detection target unmeasurable. | ACE team |
