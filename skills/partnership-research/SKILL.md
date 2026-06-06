---
name: partnership-research
description: >
  Research a non-Connect prospect org for a partnership video: deep web
  research (what they do, scale, model, geography, the expansion thesis)
  plus a Connect/Dimagi capability-fit memo. Verified + cited.
disable-model-invocation: true
---

# Partnership Research

Research a non-Connect prospect organization in preparation for the partnership video pipeline. Produces two verified, cited artifacts: a deep web research report (org profile, scale, model, geography, expansion thesis) and a Connect/Dimagi capability-fit memo grounding what Connect specifically unlocks for this org type in the target geography. This skill runs in the research phase and is dispatched by the level-0 partnership-video procedure doc.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Operator (Phase 1 profile) | `ACE/partnerships/<slug>/prospect.yaml` | Prospect identity: name, slug, current program, target geography, contact, sector |
| Operator (optional) | `--prospect-folder <drive-id>` folder contents | High-signal operator context: call notes, their deck, MoU drafts |

## Products

- `ACE/partnerships/<slug>/research/deep-research.md` — cited org profile from deep web research
- `ACE/partnerships/<slug>/research/connect-fit.md` — Connect/Dimagi capability-fit memo
- `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` — Phase Write-Back: `phases.research.*`

## Process

1. **Read `prospect.yaml` to establish the research scope.**

   Read `ACE/partnerships/<slug>/prospect.yaml` via `drive_read_file`. Extract:
   - `name` — prospect organization's display name
   - `current_program` — what they do today
   - `target_geography` — the expansion thesis geography
   - `sector` — health / MNCH / agriculture / etc.
   - `contact` — who we are in discussions with

   If `prospect.yaml` is missing or unreadable, **halt with an actionable error**: "Partnership research requires `ACE/partnerships/<slug>/prospect.yaml`. Run the profile phase first or create the file manually with required fields."

   If a `--prospect-folder` Drive folder ID was supplied by the operator, also read its contents via `drive_list_folder` then `drive_read_file` on each listed file. Treat these as highest-signal context. Do NOT halt if the folder is empty or inaccessible — log a warning and proceed from `prospect.yaml` alone.

2. **Ensure the research folder exists.**

   Resolve `ACE/partnerships/<slug>/research/` via `resolve_opp_path` to get the partnership root, then `drive_create_folder` with `{name: 'research', parentFolderId: <partnership-root-id>, findOrCreate: true}`. Retain the returned folder ID for writes in steps 3 and 4.

3. **Deep web research: invoke the `deep-research` skill.**

   Using the prospect identity and target geography, compose a refined research query:

   > "What does [org name] do, at what scale, in which geographies, using what delivery model? What is their expansion thesis for [target geography]? What is their evidence of impact and their published funding/programmatic commitments?"

   Weave in any high-signal context from the operator's `--prospect-folder` to sharpen the query. Invoke the `deep-research` skill — the orchestrator runs at level 0, so deep-research's internal Agent dispatches are legal.

   The output must include:
   - Org overview: what they do, for whom, geographic footprint
   - Scale: delivery numbers, FLW/worker count, beneficiary reach
   - Delivery model: how work is organized and verified
   - Expansion thesis: documented or inferred interest in the target geography
   - Evidence of impact: published citations, evaluations, donor reports
   - Citations section with ≥3 sourced URLs

   Write the cited report to `research/deep-research.md` via `drive_create_doc_from_markdown` (parent = research folder from step 2). Record the returned Drive `file_id`.

   **Guardrail:** Every factual claim must trace to a cited source. Unverifiable claims must be flagged explicitly: "Unverified — could not locate a source for this claim." Do NOT invent statistics, program histories, or partnership relationships. If a fact cannot be sourced, omit it or flag it.

4. **Build the Connect/Dimagi capability-fit memo.**

   Cross-reference Connect/Dimagi capabilities against the research output and real ACE PDDs, program library artifacts, and Dimagi case studies that are accessible in Drive under `ACE/`. The goal is a grounded answer to: *"What does Connect specifically unlock for this org type in the target geography that they cannot easily do today?"*

   Capability validation rules (design §8 "close the loop"):
   - Every stated Connect capability must be validated against real artifacts (PDDs, atom schemas, program outputs in Drive), not asserted from memory.
   - Browse or read relevant PDD examples via `drive_list_folder` on `ACE/` to find analogous programs for the org's sector and geography.
   - Cross-reference against documented Connect features (Learn→Deliver→Verify→Pay loop, payment-for-verified-delivery, rapid program stand-up, funder-grade reporting, mobile-first FLW tools) anchored to specific real programs.

   Structure the memo:
   - **What they do today (gap):** What the org currently relies on, and what limitations exist.
   - **What Connect unlocks:** Per-capability bullets, each citing a real analogous ACE program or documented Connect feature as evidence. Minimum 3 concrete capabilities.
   - **Expansion fit:** Specifically why Connect is well-suited for the target geography (infrastructure, payment, verification needs).
   - **Risk factors:** What would need to be true for Connect to be the right fit (scale, LLO availability, connectivity).

   Write to `research/connect-fit.md` via `drive_create_doc_from_markdown` (parent = research folder from step 2). Record the returned Drive `file_id`.

5. **Write the Phase Write-Back to `run_state.yaml`.**

   Write `phases.research.*` to `ACE/partnerships/<slug>/runs/<run-id>/run_state.yaml` via `update_yaml_file` with `merge: 'two-level'`:

   ```yaml
   phases:
     research:
       status: complete
       verdict: pass
       completed_at: <ISO timestamp>
       summary_artifact: research/deep-research.md
       steps:
         prospect_read: done
         deep_research: done
         connect_fit: done
         write_back: done
       products:
         deep_research_file_id: <file_id from step 3>
         connect_fit_file_id: <file_id from step 4>
   ```

   If either research file was not written (e.g., `deep-research` errored), set `verdict: fail` and `status: incomplete`, surface the failure reason, and halt before writing `complete`.

## MCP Tools Used

- Google Drive: `drive_read_file`, `drive_list_folder`, `drive_create_folder`, `drive_create_doc_from_markdown`, `resolve_opp_path`, `update_yaml_file`
- Skills (via Skill tool, dispatched from level-0 orchestrator): `deep-research`

Note: `deep-research` is a skill dispatched via the `Skill` tool — it is not an MCP atom. The level-0 orchestrator is what calls it, making the Agent fan-out legal per ACE topology rules.

## Mode Behavior

- **Auto:** Run all steps, write both research artifacts and the phase write-back, proceed. Flag any unverifiable claims inline in the artifact.
- **Review:** Same as Auto. No human pause point — the downstream `partnership-research-eval` surfaces quality concerns for human review after the artifacts are written.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-06-06 | Initial version. First skill in the partnership-video pipeline. | ACE team |
