---
name: partnership-publish
description: >
  Assemble and publish the partnership package (video + deck + narrative + research
  appendix) to canopy-web. Requires explicit operator approval before any external send.
disable-model-invocation: true
---

# Partnership Publish

Assembles the final prospect-facing partnership package — hero video, pitch deck, picked narrative summary, and a cited research appendix — presents it to the operator for explicit approval, then publishes it to canopy-web via the `canopy:walkthrough-share` skill (dispatched by the level-0 orchestrator), producing a navigable shareable URL. This skill is the handoff gate between internal production and external delivery.

**Brand-safety rule:** The package contains the prospect's name and publicly-available logo alongside Dimagi chrome. It MUST be reviewed and approved by a human operator before any external send. This skill never auto-sends and never auto-publishes without the operator gate defined in Step 4.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| `partnership-video-build` | `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` | `video.program_url`, `video.media_url` (video editable + render URLs) |
| `partnership-deck-build` | `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` | `deck.slides_url` (Google Slides deck URL) |
| `partnership-angles` | `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` | Full angle entry for `selected_angle` — logline, beats, narrative summary |
| `run_state.yaml` | `phases.angles.products.selected_angle` | Which angle was picked |
| Phase 1 profile | `ACE/partnerships/<slug>/prospect.yaml` | Prospect name and slug for package title and brand-safety header |
| `partnership-research` | `ACE/partnerships/<slug>/research/deep-research.md` | Cited research for the appendix |
| `partnership-research` | `ACE/partnerships/<slug>/research/connect-fit.md` | Connect-fit claims for the appendix |
| Env | `CANOPY_WEB_PAT` or `~/.claude/canopy/workbench-token` | canopy-web auth (required by `canopy:walkthrough-share`) |

## Products

- `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` — updated with `canopy_web.package_url`, `canopy_web.share_url`, `canopy_web.published_at` (read-augment-write via `drive_create_file`, preserving existing `video.*` and `deck.*` keys)
- `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` — Phase Write-Back: `phases.publish.*`

## Process

1. **Resolve inputs and check preconditions.**

   Read `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `drive_read_file`. Confirm upstream phases passed:
   - `phases.video-build.verdict` must be `pass` (not `fail` or `incomplete`). If not, halt: "partnership-publish requires a passing partnership-video-build. Check `phases.video-build.verdict`."
   - `phases.deck-build.verdict` must be `pass`. If not, halt: "partnership-publish requires a passing partnership-deck-build. Check `phases.deck-build.verdict`."

   Read `phases.angles.products.selected_angle` — the active angle id. If absent, halt: "phases.angles.products.selected_angle not set — run partnership-angles with a picked angle before publish."

2. **Read the run artifacts.**

   Read via `drive_read_file`:
   - `ACE/partnerships/<slug>/runs/<run-id>/package.yaml` → capture `video.program_url`, `video.media_url`, `deck.slides_url`. If any of these three keys is null or absent, halt and name the missing key — upstream produced an incomplete package.
   - `ACE/partnerships/<slug>/runs/<run-id>/angles.yaml` → extract the angle entry whose `angle_id` matches `selected_angle`; capture `logline`, `beats` (all seven beat texts), and `primary_capability`.
   - `ACE/partnerships/<slug>/prospect.yaml` → capture `name` (prospect display name) and `slug`.
   - `ACE/partnerships/<slug>/research/deep-research.md` → extract the full text for the research appendix.
   - `ACE/partnerships/<slug>/research/connect-fit.md` → extract the full text for the research appendix.

3. **Assemble the package summary.**

   Compose a structured `package_summary.md` in memory (not persisted to Drive — it feeds the approval gate and the canopy-web upload description). The summary contains:

   - **Header:** `Partnership Package — <prospect name>` + run id + angle selected + `generated_at` ISO timestamp.
   - **Brand-safety notice:** "This package contains <prospect name>'s publicly-available name and logo alongside Dimagi chrome. Do not send externally without operator approval."
   - **Narrative summary:** angle `logline` + a paragraph-form walkthrough of the seven beats (hook → impact) derived from the angle's `beats` text. Do NOT add facts not present in `angles.yaml` or the research docs.
   - **Package contents:**
     - Hero video: `video.program_url` (editable), `video.media_url` (render)
     - Pitch deck: `deck.slides_url`
   - **Research appendix:** the cited content from `deep-research.md` and `connect-fit.md`, reproduced verbatim (preserve all citations). Prefix each section clearly: `## Research: <prospect name>` and `## Connect Fit: <prospect name>`.

   **Grounding discipline (non-negotiable):** every claim in the narrative summary must trace to the angle beats or the research docs. Do not add new statistics, claims, or context not present in the source artifacts. If a beat is incomplete or marked `[TBD]`, reproduce it as-is with the `[TBD]` marker rather than synthesizing a fill.

4. **HUMAN-IN-THE-LOOP external-release gate (design §9 — hard gate, no bypass).**

   This artifact is prospect-facing. The orchestrator MUST pause here and present the assembled package to the operator before any external publish action. The skill does not auto-proceed.

   Present to the operator:
   - The full `package_summary.md` composed in Step 3.
   - The three URLs ready to publish: `video.program_url`, `video.media_url`, `deck.slides_url`.
   - The explicit brand-safety checklist (operator must confirm each item):
     1. Prospect name and logo are accurate (not confused with another prospect).
     2. All statistics in the narrative summary are cited and sourced from the research docs.
     3. No fabricated partnership history, invented program milestones, or unverified geography claims.
     4. Dimagi chrome is present (the package is not inadvertently unbranded).
     5. The package is approved for external distribution to `<prospect name>`.

   Ask the operator: **"Approve and publish to canopy-web? (yes / no / edit)"**
   - If `no`: write `phases.publish.status: blocked` to `run_state.yaml` via `update_yaml_file` `merge: 'deep'` and halt with: "Publish blocked by operator. Re-run after addressing concerns."
   - If `edit`: halt with: "Edit requested. Revise the upstream artifact(s) and re-run partnership-publish." Do not attempt to patch artifacts inline — upstream skills own their outputs.
   - If `yes` (explicit approval): record the approval timestamp and proceed to Step 5.

5. **Publish via `canopy:walkthrough-share`.**

   The level-0 orchestrator dispatches `canopy:walkthrough-share` (a canopy skill invoked as an Agent/Skill call from the orchestrator — NOT an MCP atom). The upload arguments are:

   - **Artifact path:** the render media file (`video.media_url` — the `.mp4` at the ace-web media endpoint). The MP4 is the primary upload artifact for `canopy:walkthrough-share`.
   - **`--title`:** `"<prospect name> — Connect Partnership Pitch"` (max 200 chars; truncate if needed).
   - **`--description`:** the angle logline from `angles.yaml`.
   - **`--project`:** `"ace-partnerships"` (canopy-web project slug; must exist — if rejected, surface the error to the operator rather than silently dropping).
   - **`--public`:** yes — publish with a shareable link-token URL so the prospect can be sent the share URL without a canopy-web login.
   - **`--companion-url`:** `deck.slides_url` (the Google Slides deck; companion label: `"View the pitch deck"`).
   - **`--narrative-url`:** `video.program_url` (the ace-web editable program; companion label: `"Edit the video"`).

   Capture the two URLs printed by the script:
   - `View:` → `canopy_package_url` (the `/w/<uuid>` viewer page, private)
   - `Share:` → `canopy_share_url` (the `/w/<uuid>?t=<token>` link, public)

   **Note on the canopy-web package shape (open question from design §11):** Phase 1 uses `walkthrough-share` with an MP4 upload because it is the available mechanism for publishing a shareable video+companion-link package to canopy-web. A future "partnership package type" (ddd-upload-style, with structured prospect metadata, deck, and research appendix as first-class fields) is the long-term target — that is the open question from design §11. When it ships, this step should be updated to use the new package type.

   On any non-zero exit from `canopy:walkthrough-share`:
   - If the error is `missing PAT` or HTTP 401: halt with: "canopy-web auth failed — mint a token via `/canopy:canopy-web-pat-mint` and retry."
   - If the error is HTTP 413: halt with: "Upload rejected — video exceeds canopy-web size limit (75 MB default). Reduce the render resolution in ace-web and re-run partnership-video-build."
   - For any other error: surface the raw error message to the operator and halt.

6. **Merge `canopy_web` block into `package.yaml` (read-augment-write).**

   Read the existing `package.yaml` from the run folder via `drive_read_file`. Merge in the canopy block:

   ```yaml
   canopy_web:
     package_url: <canopy_package_url>
     share_url: <canopy_share_url>
     published_at: <ISO timestamp>
     approved_by: operator
     approval_recorded_at: <approval ISO timestamp from Step 4>
   ```

   Write the merged YAML back via `drive_create_file` (find-or-update by name `package.yaml` in the run folder, `parentFolderId` = the run folder ID). Preserve all existing keys (`video.*`, `deck.*`). Do NOT use `drive_create_doc_from_markdown` — that creates a Google Doc that mangles YAML on read-back.

7. **Inline QA (binary — run before writing the phase write-back).**

   Verify all of the following. Record which checks pass and which fail — the write-back is ALWAYS written regardless of outcome:

   - **`upstream_verdicts_pass`**: `phases.video-build.verdict` and `phases.deck-build.verdict` are both `pass` in `run_state.yaml`.
   - **`hitl_approved`**: Step 4 approval was recorded (operator said `yes`; `approval_recorded_at` is set).
   - **`canopy_share_url_present`**: `package.yaml` contains a non-null `canopy_web.share_url`.
   - **`companion_urls_set`**: both `video.program_url` and `deck.slides_url` were passed as companion links to `canopy:walkthrough-share`.
   - **`no_tbd_in_summary`**: no `[TBD]` tokens appear in the narrative summary section of the assembled `package_summary.md` (grounding rule enforcement on the prospect-facing surface).

8. **Write the Phase Write-Back to `run_state.yaml`** (always — both pass and fail paths).

   Write `phases.publish.*` to `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `update_yaml_file` with `merge: 'deep'` (a partial nested patch of `phases.<phase>` requires `deep` — `two-level` silently drops sibling keys; see CLAUDE.md § Gotchas):

   **QA pass path** (`verdict: pass`):
   ```yaml
   phases:
     publish:
       status: done
       verdict: pass
       completed_at: <ISO timestamp>
       summary_artifact: package.yaml
       steps:
         preconditions_checked: done
         artifacts_read: done
         package_summary_assembled: done
         hitl_gate: approved
         canopy_published: done
         package_merged: done
         inline_qa: done
         write_back: done
       products:
         canopy_package_url: <canopy_package_url>
         canopy_share_url: <canopy_share_url>
         published_at: <ISO timestamp>
         approval_recorded_at: <ISO timestamp>
         package_file_id: <Drive file_id of package.yaml>
   ```

   **QA fail path** (`verdict: fail`): write the write-back first, then halt with the failed check names surfaced.
   ```yaml
   phases:
     publish:
       status: incomplete
       verdict: fail
       completed_at: <ISO timestamp>
       summary_artifact: package.yaml
       steps:
         preconditions_checked: done
         artifacts_read: done
         package_summary_assembled: done
         hitl_gate: <approved|blocked|edit>
         canopy_published: <done|fail>
         package_merged: <done|fail>
         inline_qa: fail
         write_back: done
       products:
         canopy_package_url: <url or null>
         canopy_share_url: <url or null>
         published_at: <ISO timestamp or null>
         approval_recorded_at: <ISO timestamp or null>
         package_file_id: <file_id or null>
       qa_failures:
         - <failed-check-id>
   ```

   After writing the write-back on the fail path, halt with an actionable operator error naming the failed checks.

## MCP Tools Used

- `ace-gdrive`:
  - `drive_read_file` (read run_state.yaml, package.yaml, angles.yaml, prospect.yaml, deep-research.md, connect-fit.md)
  - `drive_create_file` (write updated package.yaml — NOT `drive_create_doc_from_markdown`)
  - `update_yaml_file` (phase write-back to run_state.yaml with `merge: 'deep'`)

Note: `canopy:walkthrough-share` is a **canopy skill** (dispatched by the level-0 orchestrator as an Agent/Skill call) — NOT an MCP atom. It is invoked by the orchestrator after Step 4 approval, not directly by this skill. The separation is required by ACE topology: anything that calls `Agent` must run at level 0.

## Mode Behavior

- **Auto:** Runs Steps 1–3 (assemble), pauses at Step 4 (HITL gate — mandatory regardless of mode), then on approval runs Steps 5–8. The HITL gate cannot be bypassed by `--auto` — brand safety requires explicit human approval before any external publish.
- **Review:** Identical to Auto. The gate is already present; no additional review layer needed.

## Dry-Run Behavior

When `--dry-run` is active:
- Read inputs normally (Steps 1–2).
- Assemble `package_summary.md` normally (Step 3).
- Present the package summary and brand-safety checklist to the operator for review (Step 4 — the gate still runs, so the operator can inspect the assembled package before committing to a live publish).
- Skip the `canopy:walkthrough-share` upload (Step 5 — no external publish).
- Write `package.yaml` with `canopy_web.share_url: null`, `canopy_web.published_at: dry-run`.
- State tracks as `dry-run-success`.

## Failure Modes

- **`UpstreamVerdictFail`** — `phases.video-build.verdict` or `phases.deck-build.verdict` is not `pass`. Recovery: re-run the failing upstream skill until it passes, then re-run this skill.
- **`MissingPackageUrl`** — `video.program_url`, `video.media_url`, or `deck.slides_url` is null in `package.yaml`. Recovery: the upstream produce-phase skill (`partnership-video-build` or `partnership-deck-build`) did not complete its inline QA. Re-run it.
- **`HitlBlocked`** — operator declined approval at Step 4. Recovery: address the operator's concerns and re-run.
- **`CanopyAuthFailed`** — canopy-web PAT missing or expired. Recovery: run `/canopy:canopy-web-pat-mint`.
- **`CanopyUploadTooLarge`** — video MP4 exceeds 75 MB. Recovery: reduce render resolution in ace-web and re-run `partnership-video-build`.
- **`TbdInSummary`** — `[TBD]` tokens appear in the prospect-facing narrative summary, indicating ungrounded content leaked through from upstream. Recovery: fix the offending beat in `angles.yaml` (re-run `partnership-angles`) and re-run the full produce phase.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. Assemble package (video + deck + narrative summary + research appendix), HITL external-release gate (hard, non-bypassable), publish via canopy:walkthrough-share (level-0 Agent/Skill dispatch), merge canopy_web block into package.yaml (read-augment-write), inline QA: upstream_verdicts_pass, hitl_approved, canopy_share_url_present, companion_urls_set, no_tbd_in_summary. merge: deep write-back. | ACE team |
