---
name: partnership-video-build-eval
description: >
  LLM-as-judge quality eval for the partnership-video-build artifact. Grades
  spec validity, grounding, render success, and brand safety. Writes a
  verdict YAML. Gated by partnership-video-build inline QA.
disable-model-invocation: true
---

# Partnership Video Build Eval

Independent LLM-as-Judge quality evaluation of the `video_spec.yaml` and `package.yaml` artifacts produced by `partnership-video-build`. Grades across four dimensions: whether the server accepted the spec as structurally valid, whether every claim in the posted spec is grounded in cited research (the heaviest dimension — narration reaching a prospect must be traceable), whether the video actually rendered successfully, and whether the output respects the brand safety rules that govern prospect-facing artifacts (Dimagi chrome + prospect name/logo, no impersonation). Writes a verdict YAML that `opp-eval` aggregates. Gated by `partnership-video-build` inline QA — if QA failed, this skill emits `verdict: incomplete` without grading.

See `skills/_eval-template.md` for shared contracts (verdict YAML shape, severity rules, inflation guard, stock blocks). See `skills/eval-calibration/SKILL.md` for the calibration methodology.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-video-build` | `ACE/partnerships/<slug>/runs/<run-id>/video_spec.yaml` | Primary artifact under judgment — the as-POSTed spec |
| `partnership-video-build` | `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` | Render outcome + output URLs |
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Ground truth for the grounding dimension — citations the spec claims are present |
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Selected angle + beat text ground truth (compare against spec's `by_beat`) |
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Prospect name, logo ref — ground truth for brand safety dimension |
| `partnership-video-build` inline QA | `phases.video-build.verdict` in `run_state.yaml` | QA gate — if verdict is `fail` or `incomplete`, skip eval |

## Products

- `8-video-build/partnership-video-build-eval_verdict.yaml` — verdict YAML per `skills/_eval-template.md § Verdict YAML contract`

## Process

1. **Check the QA gate.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Inspect `phases.video-build.verdict`. If the verdict is `fail` or `incomplete`, write `verdict: incomplete` immediately and halt:

   ```yaml
   skill: partnership-video-build-eval
   target: <prospect-slug>
   ran_at: <ISO timestamp>
   capture_path: video_spec.yaml
   overall_score: 0
   verdict: incomplete
   dimensions: {}
   auto_surfaced:
     - severity: INFO-SKIPPED
       message: "Skipped — partnership-video-build inline QA returned verdict: <qa-verdict>. Fix QA failures first."
   ```

2. **Read the artifacts.**

   Read from Drive via `drive_read_file`:
   - `ACE/partnerships/<slug>/runs/<run-id>/video_spec.yaml`
   - `ACE/partnerships/<slug>/runs/<run-id>/package.yaml`
   - `ACE/partnerships/<slug>/research/deep-research.md`
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml`
   - `ACE/partnerships/<slug>/prospect.yaml`
   - `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` (for `phases.video-build.products.*` — render status, `appears_failed`)

3. **Apply the LLM-as-Judge rubric** (see `## LLM-as-Judge Rubric` below). Grade each of the four dimensions 0–10. Compute the weighted overall score.

4. **Apply the `grounding` and `brand_safety` hard floors.**

   Before computing the verdict:

   - **`grounding` floor:** If any claim in the posted spec's narration beats, problem stat, or impact stats cannot be traced to a citation in `deep-research.md`, OR if any surviving `[TBD]` token appears in a narration beat (`by_beat` string across any variant): floor `grounding` at ≤ 3.0, set suite `verdict: fail`, surface a `BLOCKER` per uncited/unresolved item. A single fabricated or uncited claim reaching a prospect is the worst possible failure (design §8 "No inferred backstory", CLAUDE.md cardinal rule).

   - **`brand_safety` floor:** If the spec includes any third-party logo asset reference that is neither the prospect's own publicly-available logo (as declared in `prospect.yaml`) nor the Dimagi logo/chrome, OR if any text in the spec makes an implicit claim about the prospect that the prospect has not made publicly: floor `brand_safety` at ≤ 3.0, set suite `verdict: fail`, surface a `BLOCKER`.

5. **Write the verdict YAML** to `8-video-build/partnership-video-build-eval_verdict.yaml`.

   Resolve or create `runs/<run-id>/8-video-build/` via `drive_create_folder` with `findOrCreate: true`. Write via `drive_create_file` (NOT `drive_create_doc_from_markdown` — this is a machine-parsed YAML file).

   Dimensions must sum to 1.0:

   ```yaml
   dimensions:
     spec_validity:   { score: <0-10>, weight: 0.20 }
     grounding:       { score: <0-10>, weight: 0.45 }
     render_success:  { score: <0-10>, weight: 0.20 }
     brand_safety:    { score: <0-10>, weight: 0.15 }
   ```

6. **Surface auto-concerns** per `skills/_eval-template.md § Auto-surfaced severity rules`. Skill-specific surfaces:
   - `[BLOCKER]` if `grounding` scores ≤ 3.0 — uncited claims in a prospect-facing narration are a hard stop.
   - `[BLOCKER]` if `brand_safety` scores ≤ 3.0 — impersonation or unauthorized branding risk.
   - `[BLOCKER]` if any dimension scores ≤ 3.0.
   - `[BLOCKER]` if overall score is below 7.0.
   - `[BLOCKER]` for each surviving `[TBD]` token in any narration beat — the spec must not reach a prospect with unresolved placeholder text.
   - `[BLOCKER]` for each fabricated or uncited statistic detected in the problem/impact blocks.
   - `[WARN]` if `render_success` scores 4.0–6.9 — the render appears to have failed or is unverifiable; the video may not be watchable.
   - `[WARN]` if `spec_validity` scores 4.0–6.9 — the spec was accepted but contained structural warnings or the server returned a degraded response.
   - `[WARN]` if `grounding` scores 7.0–7.9 — some beats are thinly grounded; review before sending to the prospect.
   - `[WARN]` if the prospect's `logo_asset` is `null` or `[TBD]` in the spec — the video will render without prospect branding, which is acceptable (unbranded mode) but should be operator-confirmed.
   - `[INFO]` if `active_angle` in the spec differs from `selected_angle` in `run_state.yaml` — possible write-back mismatch; review.

## LLM-as-Judge Rubric

Grade `video_spec.yaml` + `package.yaml` against `deep-research.md`, `angles.yaml`, and `prospect.yaml`. Every dimension is a quality/fitness judgment — structural presence was already checked by inline QA.

The out-of-chain fitness requirement (per `skills/_eval-template.md § The out-of-chain fitness requirement`): `grounding` grades against **independently verifiable research citations** in `deep-research.md` (out-of-chain anchor — the research was compiled from live sources, not from this pipeline's AI authoring chain), testing whether every claim in the narration and stat blocks could survive a prospect's fact-check. `brand_safety` grades against the **prospect's own public identity** as declared in `prospect.yaml` and what is publicly visible about the prospect organization — a second out-of-chain anchor whose purpose is to catch unauthorized representations before the video is sent. These two dimensions are the primary fitness axes that escape the AI authoring chain.

### Dimension: `spec_validity` (weight 0.20)

Was the spec structurally valid from the server's perspective, and does it correctly represent the narrative intent?

This dimension grades **server acceptance + structural correctness** of the as-POSTed spec. The server is the authoritative validator (it runs Zod schema checks); a 2xx response is a strong signal. But the eval also grades whether the spec is internally consistent — the right active angle selected, three variants present, beats populated, prospect block present if branding was requested.

**Anchors:**
- 9.0–10.0: Server returned 2xx with `ok: true` and no validation warnings. Spec contains all three variants with populated `by_beat` maps, `active_angle` matches `selected_angle`, prospect block is populated (or intentionally absent for unbranded mode), product beats are populated, stat blocks are filled.
- 7.0–8.9: Server accepted the spec (2xx) but the spec has minor structural gaps — e.g. one beat is empty in a non-active variant, or the prospect block is missing a field that was available in `prospect.yaml`.
- 5.0–6.9: Server accepted the spec (2xx) but notable structural issues exist — a variant has an empty `by_beat` map, or `active_angle` does not match the intended selected angle. The spec would render but not as intended.
- 3.0–4.9: Server accepted the spec but with a degraded or error-containing response body, OR the spec has a critical structural flaw visible in the YAML (e.g. a `[TBD]` surviving in a non-narration field, missing product beats).
- 0.0–2.9: Server returned a non-2xx error (POST failed), or the spec could not be POSTed at all.

**Hard deduction (POST failure):** If the POST to ace-web returned non-2xx → `spec_validity` = 0, auto-surface `BLOCKER`.

### Dimension: `grounding` (weight 0.45)

Does every claim in the posted spec trace back to a verifiable citation in `deep-research.md`? This is the heaviest dimension because the spec's narration beats and stat blocks are what will reach the prospect — a fabricated or uncited claim in a partnership video is the worst possible failure.

This dimension grades against `deep-research.md` as the out-of-chain anchor. Every stat in the problem block, impact block, and narration beats must be traceable to a specific cited sentence in the research report. The grounding check applies to ALL three variants (not just the active one), because a prospect or Dimagi reviewer might switch variants.

**Anchors:**
- 9.0–10.0: Every stat and factual claim in the problem block, impact blocks, and all three narration variants is traceable to a specific citation in `deep-research.md`. No `[TBD]` tokens survive. The narration text in all variants stays within ±20% of the cited facts — no inflation.
- 7.0–8.9: Nearly all claims are grounded; ≤2 beats across all variants have a claim that is directionally accurate but slightly inflated (e.g. "over 50%" when the source says "47%"). No fabrications. No surviving `[TBD]` in narration beats.
- 5.0–6.9: Several claims are thinly grounded — they appear plausible given the research but cannot be traced to a specific cited sentence. OR 1–2 `[TBD]` tokens survive in the spec (outside narration). Risk of a well-researched prospect catching an inaccuracy.
- 3.0–4.9: Systematic grounding gaps — multiple stats or claims in narration beats cannot be traced to the research. OR any `[TBD]` token survives in a narration beat. The spec is not safe to send to a prospect without human review.
- 0.0–2.9: Claims are fabricated, cannot be traced to `deep-research.md`, or `[TBD]` tokens appear in the active variant's narration beats. **Auto-surfaced as BLOCKER — do not send.**

**Hard deduction (surviving `[TBD]` in narration):** Any `[TBD]` token in any `by_beat` string in any variant → `grounding` ≤ 3.0 regardless of other content. Auto-surface as BLOCKER.

**Hard deduction (fabricated stat):** Any stat in the problem/impact blocks that does not appear in (or cannot be derived from) `deep-research.md` → `grounding` ≤ 3.0. Auto-surface as BLOCKER with the specific stat named.

**Hard deduction (citation inflation):** Any beat where the narration text asserts a figure > 20% above the cited source value: deduct 1.0 per inflation instance, capped at 3.0 total.

### Dimension: `render_success` (weight 0.20)

Did the video actually render successfully? This dimension grades the **observable render outcome** — `busy: false` received before timeout, `appears_failed` is false, and the output media URL in `package.yaml` is non-null and reachable.

This is the primary out-of-chain fitness dimension for the render pipeline: the render is a real operation that the ace-web server either completed or failed, independent of what the skill claims in its write-back.

**Anchors:**
- 9.0–10.0: `package.yaml` shows `render_status: completed`, `appears_failed: false`, `media_url` is non-null. The render_state from `run_state.yaml.phases.video-build.products.render_failed` is false.
- 7.0–8.9: Render completed (`busy: false`), but there was a non-fatal warning (e.g. `triggered: false` on the build trigger — the render was queued through a secondary path) or the render time was very long (> 4 minutes).
- 5.0–6.9: Render status is ambiguous — the poll timed out before `busy: false` was returned, but `appears_failed` is also not present. The render may have completed after the poll window closed.
- 3.0–4.9: The render poll returned `appears_failed: true` at some point, or `package.yaml.render_status` is `failed` or `timeout`.
- 0.0–2.9: The build trigger returned non-2xx, or `package.yaml` is missing or has no `media_url`, indicating the render was never started or the output was never recorded.

**Hard deduction (confirmed failure):** `appears_failed: true` in any poll response → `render_success` ≤ 3.0. Auto-surface as BLOCKER.

### Dimension: `brand_safety` (weight 0.15)

Does the spec respect the brand safety rules that govern prospect-facing partnership artifacts (design §9)?

The rules are:
1. **Prospect identity only.** The spec may reference the prospect's name and their publicly-available logo. Nothing else from the prospect's brand.
2. **Dimagi chrome only.** No third-party logos other than the prospect's own. No impersonation of the prospect's visual identity at scale.
3. **Human review gate.** The entire package is flagged for human review before any external send — this eval is part of that gate. `brand_safety` failing blocks the artifact from proceeding to the publish step.
4. **Public-only claims.** No claims about the prospect that the prospect has not made publicly (design §9 "no impersonation / legal risk").

**Anchors:**
- 9.0–10.0: The spec uses the prospect's name and logo ref (as declared in `prospect.yaml`) and no other third-party branding. Every claim about the prospect in the narration text is directly supported by publicly available information captured in `deep-research.md`. Dimagi chrome is the frame.
- 7.0–8.9: The spec is mostly safe; one minor issue exists — e.g. the `prospect.logo_asset` field is null (no prospect logo in the video, which is acceptable for unbranded mode, but the operator should confirm intent), or one narration beat makes a slightly forward-looking claim about the prospect that is plausible but not publicly stated.
- 5.0–6.9: The spec contains claims about the prospect that go beyond what `deep-research.md` documents as publicly available — e.g. internal program metrics not in the public domain, a partnership history that was not publicly announced, or a claim about the prospect's future plans.
- 3.0–4.9: The spec references a third-party logo that is not the prospect's own, or makes claims about the prospect that are clearly private or unverified.
- 0.0–2.9: The spec impersonates the prospect's brand (uses their visual identity in a misleading way), contains private information about the prospect, or makes false claims about the prospect's program that the prospect has not made.

**Hard deduction (third-party logo):** Any `logo_asset` in the spec that references an asset other than the prospect's own logo (as declared in `prospect.yaml`) or Dimagi's own branding → `brand_safety` ≤ 3.0. Auto-surface as BLOCKER.

**Hard deduction (false public claim):** Any claim in the spec about the prospect's scale, impact, or partnerships that cannot be verified from `deep-research.md` and represents a fact the prospect has not made public → `brand_safety` ≤ 3.0. Auto-surface as BLOCKER.

### Deduction rules

- Any single dimension ≤ 3.0 → suite verdict `fail`, regardless of overall mean.
- `grounding` ≤ 3.0 → suite verdict `fail` + `BLOCKER` auto-surfaced (prospect-facing fabrication risk).
- `brand_safety` ≤ 3.0 → suite verdict `fail` + `BLOCKER` auto-surfaced (impersonation/legal risk).
- Overall score below 7.0 → suite verdict `fail` + `BLOCKER`.
- Overall score 7.0–7.9 → suite verdict `warn`.
- Overall score ≥ 8.0 → suite verdict `pass`.

### Calibration targets

- **Detection rate:** ≥ 80% of catalogued video-build issues from `eval-calibration/known-issues.md § partnership-video-build` (once populated after the first two real runs).
- **Inter-run variance:** ≤ 0.5 across 3 same-model runs.
- **Dimension coverage:** the rubric must distinguish (a) a spec with fabricated stats and no citations from (b) a spec where every beat is grounded with a traceable citation. `grounding` is the primary fitness dimension enforcing this — a fully-grounded spec and a fabricated-stat spec must land on opposite sides of the 7.0 threshold. Additionally, `brand_safety` must catch a spec that references a third-party logo not belonging to the prospect.
- **Agreement with inline self-check:** The inline QA in `partnership-video-build` runs binary structural checks (spec_posted, render_completed, package_has_urls, no_tbd_in_narration, active_angle_valid); this eval grades quality. A QA-passing artifact is structurally correct; `grounding` + `brand_safety` are what separate conformant-but-fabricated from prospect-safe.

## MCP Tools Used

See `skills/_eval-template.md § MCP Tools Used (stock)`.

- Google Drive: `drive_read_file`, `drive_create_folder`, `drive_create_file`

## Mode Behavior

See `skills/_eval-template.md § Mode Behavior (stock)`.

- **Auto:** Grade, write verdict + auto-surfaced concerns, return overall score and disposition.
- **Review:** Pause after grading to let a human eyeball the verdict before the operator review gate proceeds to the publish step.

## Dry-Run Behavior

See `skills/_eval-template.md § Dry-Run Behavior (stock)`.

When `--dry-run` is active:
- Read inputs normally (read-only operations are safe in dry-run).
- Write the verdict YAML to Drive normally (human-facing artifact; safe to write in dry-run).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|---|---|---|
| 2026-06-06 | Initial version. Four dimensions: spec_validity (0.20), grounding (0.45), render_success (0.20), brand_safety (0.15). Hard BLOCKER floors on grounding ≤ 3 (prospect-facing fabrication) and brand_safety ≤ 3 (impersonation risk). Gated by partnership-video-build inline QA. Phase folder: 8-video-build/. | ACE team |
