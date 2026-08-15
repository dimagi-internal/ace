---
name: training-llo-guide
description: >
  Generate the LLO-facing operations document for overseeing FLW
  deployment. Owns one artifact: training-llo-guide.md.
disable-model-invocation: false
---

# Training LLO Guide

Produce the LLO Manager Guide — operations-flavored, day-to-day-focused,
written for an LLO admin who manages a roster of FLWs. Audience: someone
running the field operation who needs to know morning check-ins, quality
watch, daily caps, escalation triggers, and Connect/payment mechanics.

## When to run

Phase 6 (`qa-and-training`), after `app-screenshot-capture`. Independent
of `training-flw-guide`, `training-faq`, etc. — re-running this skill
rebuilds only `training-llo-guide.md`.

## Inputs (read from Drive)

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `ACE/<opp>/runs/<run-id>/1-design/idea-to-pdd.md` | opp framing, archetype, target FLW persona, escalation triggers |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-learn-app_summary.md` | LLO context on what FLWs are learning |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/pdd-to-deliver-app_summary.md` | LLO context on per-visit data shape |
| Phase 3 | `ACE/<opp>/runs/<run-id>/3-commcare/app-deploy_summary.md` | HQ domain quoted in the "where the data lives" section |
| Phase 4 (`run_state.yaml`) | `connect.opportunity` + `connect.payment_units` + `connect.verification_flags` | payment per visit, max-per-day, verification rules |
| Phase 5 | `ACE/<opp>/runs/<run-id>/5-ocs/ocs-setup_widget-handoff.md` (`widget_url`) | "where to ask questions" link |
| Phase 1 | `ACE/<opp>/runs/<run-id>/2-scenarios/pdd-to-app-journeys.md` | seed the "Pre-deployment UAT" section from per-journey pass criteria |
| Phase 6 Step 1 (`app-screenshot-capture`) | `ACE/<opp>/runs/<run-id>/6-qa-and-training/app-screenshot-capture_manifest.yaml` | optional — embed key screenshots in the "what FLWs see" section |

## Output

Single file: `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-llo-guide.md`.

## Format

Markdown document, structured sections. Audience: an experienced LLO
admin — assume knowledge of how Connect works generally; explain only
opp-specific mechanics. Sections (in order):

```markdown
# LLO Manager Guide — <Opportunity Name>

For LLO operators overseeing FLW deployment of this opportunity.

## What your FLWs are doing
<2-3 sentence paragraph from PDD intervention summary, framed as
"your FLWs are doing X to produce Y outcome">

## Day-to-day responsibilities
- **Morning check-in:** <opp-specific pre-flight items, e.g., MTN
  cards intact, phones charged, etc.>
- **Quality watch:** <what to look for in the first N submissions; pull
  from PDD's Evidence Model § Layer-A>
- **Daily cap enforcement:** <X per FLW per day, Y per <unit>; pulled
  from connect.payment_units max counts>
- **Escalations:** <opp-specific escalation triggers from PDD §
  Escalation, mapped to who handles each>

## Payment mechanics
- FLWs are paid <amount> per <unit>, up to <max> per day, capped at
  <total> total. (from `connect.payment_units`)
- Verification rules (from `connect.verification_flags`):
  <human-readable list — GPS fence radius, photo-required, duplicate
  detection window, etc.>

## Pre-deployment UAT (do this before inviting FLWs)
<derive a checklist from each journey's pass criteria in
`pdd-to-app-journeys.md` — one tickable line per criterion>

## Where the data lives
- HQ domain: <ACE_HQ_DOMAIN from 3-commcare/app-deploy_summary.md>
- Connect opportunity URL: <opportunity URL from connect-setup/opportunity.md>
- Submission audit: <how LLO can review FLW submissions from Connect>

## Where to get help
- The OCS support widget at <widget_url> answers questions about
  this opportunity in particular
- For Connect platform issues: <support contact>
- ACE program team: <ACE_GMAIL_ACCOUNT>
```

## Format rules

- **Operations-tone, not training-tone.** This is for someone running
  the field — assume experienced. The FLW-facing detail belongs in
  `training-flw-guide.md`.
- **Quote real numbers from `run_state.yaml`.** Payment amounts, max
  counts, GPS fence values come from the actual Connect config — don't
  paraphrase or round.
- **Derive the Pre-deployment UAT checklist from per-journey
  `pass_criteria` in `pdd-to-app-journeys.md`.** Every journey's
  pass-criterion line becomes a tickable item. Don't paraphrase —
  paste the criterion verbatim with a leading `- [ ]`.
- **Cite screenshots by their exact capture filename, and expect them to be
  SHOWN.** A citation is either a `` `journey-deliver-01-meeting-basics.png` ``
  filename (from `app-screenshot-capture_manifest.yaml`) or a Drive link
  `[Deliver home](https://drive.google.com/file/d/<fileId>/view)`. Step 7b
  turns every such citation into an actual embedded picture, so a citation
  must name a frame the run really captured — a name the manifest does not
  carry is reported as unresolved and stays as bare text. This artifact is
  `illustrated: true` in `lib/artifact-manifest.ts`: the guide published on
  `spark-facilitator/20260813-2126` cited nine frames in prose and rendered
  zero of them, and its content eval passed anyway (ace#1418). See
  `skills/_training-template.md § Illustrated guides — render, THEN embed`.

## Process

1. **Read inputs.** Drive paths in the table above.

2. **Read connect state for hard numbers.** Open `run_state.yaml` and pull
   `connect.opportunity.{name, max_visits_per_day, claim_limit_total}`,
   `connect.payment_units[].{unit_name, amount, max_visits_per_day,
   max_total_visits}`, `connect.verification_flags`. These are the
   non-negotiable values that get quoted verbatim in the guide.

3. **Determine archetype.** From PDD frontmatter. For `focus-group`,
   "Quality watch" reframes around session conduct (consent flow,
   debrief notes); for `multi-stage`, add a "Cohort cadence" section
   between Day-to-day and Payment mechanics.

4. **Draft the guide** following the structure above.

5. **Derive UAT checklist from journey pass criteria.** Read
   `ACE/<opp>/runs/<run-id>/2-scenarios/pdd-to-app-journeys.md` and convert each journey's
   `pass_criteria` lines into checkbox items under the
   Pre-deployment UAT section. The LLO ticks through every journey
   before go-live.

6. **Self-check before write.** Verify:
   - Every payment-unit number quoted matches `run_state.yaml` exactly
   - Every escalation trigger from PDD § Escalation is referenced
   - The UAT checklist section has at least 5 line items (real
     checklists do)
   - Word count 500-1200 — operations docs should be scannable

7. **Write** to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-llo-guide.md`
   **as a NATIVE Google Doc via `drive_create_doc_from_markdown`** — NOT
   `drive_create_file`, which uploads the body as `text/plain` so every `##`,
   `**`, `|` and `---` stays a literal character on the page. This document is
   read by a human (the LLO coordinator running the deployment), and a partner opening it should see headings,
   bold and tables, not markdown source. The renderer round-trips: a properly
   formatted doc exports back to clean markdown via
   `drive_read_file(exportAs: 'text/markdown')`, so nothing machine-readable is
   lost — whereas a `text/plain` upload exports ESCAPED (`\---`, `run\_id`).
   Same find-or-create semantics: a same-name file under the parent is
   overwritten IN PLACE, so the fileId — and any sharing already applied to it —
   survives. (dimagi-internal/ace#1338; sibling of the PDD fix, ace#1061.)

7b. **Embed the screenshots into the rendered doc.** Step 7 publishes prose
   and citations; this is what puts the pictures on the page. Required —
   `training-llo-guide.md` is `illustrated: true`.

   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   npx --prefix "$ACE_ROOT" tsx "$ACE_ROOT/scripts/embed-doc-screenshots.ts" <docId from step 7> \
     --screenshots <drive_folders.screenshots from app-screenshot-capture_manifest.yaml>
   ```

   It anchors only on citations the prose already carries, so nothing is
   reworded and no placement is invented. It re-reads the published document
   and reports the image count an ANONYMOUS reader sees; a non-zero exit means
   the pictures are not there. **Do not record this step as done on the
   strength of the batchUpdate returning 200.** Also read its `NOTE` line: a
   filename citation that matched no captured frame means the guide is citing
   a screenshot this run never took — fix the citation, don't ignore it. Full
   contract: `skills/_training-template.md § Illustrated guides — render, THEN
   embed` (dimagi-internal/ace#1418).

8. **Self-evaluate (LLM-as-Judge).** Four criteria:
   - **Hard-number fidelity:** every payment / cap / GPS-fence number
     matches `run_state.yaml`
   - **Coverage:** every Layer-A verification rule + every PDD
     escalation trigger referenced
   - **Audience fit:** operations-tone, not FLW-walkthrough-tone
   - **UAT completeness:** every journey in `pdd-to-app-journeys.md`
     is represented by at least one checklist item, and each item's
     wording matches the journey's `pass_criteria` (no editorial
     dropping)
   - **Screenshot grounding:** every screenshot citation resolves to a
     real captured frame, and the PUBLISHED document carries a non-zero
     image count — quote the number step 7b reported, not the number of
     citations in the markdown. A citation is not a picture.

   Verdict to `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-llo-guide_verdict.yaml`.

9. **Hand off.** Print Drive URL + verdict summary.

## MCP Tools Used

- `ace-gdrive`: `drive_read_file`, `drive_create_doc_from_markdown` (the guide —
  human-facing prose, must render), `docs_batch_update` (step 7b — the
  `insertInlineImage` requests that put the screenshots on the page; driven by
  `scripts/embed-doc-screenshots.ts`), `drive_create_file` (the verdict YAML —
  machine-parsed, must stay literal text), `drive_list_folder`

## Mode Behavior

- **Auto:** Run end-to-end. Write guide, write verdict.
- **Review:** Pause after step 6, present the drafted guide.
- **Dry-run:** Steps 1-6, skip `drive_create_doc_from_markdown` and step 7b
  (or run the embed script with `--dry-run` against a prior doc). Verdict with
  `dry_run: true`.

## Products

- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-llo-guide.md`
- `ACE/<opp>/runs/<run-id>/6-qa-and-training/training-llo-guide_verdict.yaml`
- `run_state.yaml.phases.qa-and-training.products.training.docs.llo_guide` — `{file_id, title: "LLO manager guide", web_view_link}` typed handoff. Multi-writer block: apply via read-modify-write following the canonical pattern in `skills/synthetic-data-generate/SKILL.md § Step 6` so sibling sub-keys (`docs.flw_guide`, `docs.quick_reference`, …, `deck`) are preserved. See `agents/qa-and-training.md § Products` for the full per-skill slot table.

## Why a separate skill

Same rationale as `training-flw-guide`: independent iteration, eval,
rerun. The LLO guide and FLW guide have very different audiences and
benefit from different prompts and self-eval criteria.

This is the **third of the per-artifact training skills**, after
`training-deck-generate` (0.10.79) and `training-flw-guide` (0.10.83).

## Screenshot citations (shared contract)

Follow `skills/_training-template.md § Screenshot citations — canonical frames
only` (dimagi-internal/ace#1304): select captures via `canonicalCaptures` from
`lib/capture-manifest.ts`, and run `findDuplicateCitations` over the steps this
artifact cites before writing. A `duplicate_of` capture is byte-identical to
its canonical step — the same moment, never a second one.

**Checking that every `file_id` resolves does not cover this.** That is
existence; this is distinctness. Two producers asserted the former, self-scored
`image_hygiene` near 10, and still captioned alias frames as distinct states.
The self-eval criterion must assert duplicate handling explicitly.

## Change Log

- v1 (0.10.84): Initial skill. Owns `training-llo-guide.md` only.
- 2026-08-14: Added Step 7b — embed the screenshots into the rendered doc via `scripts/embed-doc-screenshots.ts` (Docs API `insertInlineImage`), plus a format rule making filename citations first-class and a `screenshot grounding` self-eval criterion keyed to the PUBLISHED image count. The guide cited nine frames in prose and rendered none. Artifact flagged `illustrated: true`; enforced by `test/lib/illustrated-artifacts.test.ts` (ace#1418).
