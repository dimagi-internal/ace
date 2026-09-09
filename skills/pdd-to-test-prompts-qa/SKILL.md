---
name: pdd-to-test-prompts-qa
description: >
  Structural QA on pdd-to-test-prompts.md — header + total count match,
  ≥8 prompts each with required fields, all 7 adversarial categories,
  ≥20% adversarial share, plus training-gap / product-feedback / escalation
  prompts. Binary pass/fail; gates pdd-to-test-prompts-eval.
disable-model-invocation: false
---

# PDD-to-Test-Prompts QA

Structural correctness checks on the `pdd-to-test-prompts.md` artifact written by `pdd-to-test-prompts`. Binary verdict. Eight static checks, runs <100ms via importable `checks.ts`.

The companion `pdd-to-test-prompts-eval` grades quality (specificity of expected answers, realism of adversarial prompts, etc.). See `skills/_qa-template.md` for the shared QA contract.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `2-scenarios/pdd-to-test-prompts.md` | the test prompts file under structural check |

## Products

- `2-scenarios/pdd-to-test-prompts-qa_result.yaml` — QA result per `lib/qa-types.ts` schema

## Checks

| # | id | type | description | auto-fix on fail |
|---|---|---|---|---|
| 1 | `header_with_total_count` | static | Title heading exists + `Total prompts: N` line matches actual prompt count | update header to match actual count or add/remove prompts |
| 2 | `prompt_count_in_range` | static | ≥8 and ≤80 prompts | add or consolidate prompts to fit |
| 3 | `each_prompt_has_required_fields` | static | Every prompt has Category, Question, Expected answer summary, Expected tags, Expected escalation | add the missing fields to named prompts |
| 4 | `adversarial_coverage` | static | All 7 adversarial categories (should-refuse, out-of-scope, hallucination-probe, leading-question, negative-frame, safety-critical, ambiguous-intent) each have ≥1 prompt | add prompts in the missing categories |
| 5 | `adversarial_share_minimum` | static | ≥20% of all prompts are adversarial | add adversarial prompts to reach the 20% threshold |
| 6 | `training_gap_prompt_present` | static | ≥1 prompt declares Expected tags: [training-gap] | add a prompt that should be tagged training-gap |
| 7 | `product_feedback_prompt_present` | static | ≥1 prompt declares Expected tags: [product-feedback] | add a prompt that should be tagged product-feedback |
| 8 | `escalation_prompt_present` | static | ≥1 prompt has non-trivial Expected escalation | add a prompt that should trigger bot escalation |

The static check functions live at `skills/pdd-to-test-prompts-qa/checks.ts` as importable TS. Same dispatch pattern as `idea-to-pdd-qa` (PR #149).

## Process

1. **Read the test-prompts artifact** from Drive:
   `drive_read_file(file_id=<pdd-to-test-prompts.md drive id>, exportAs: 'text/plain')`.

   **`exportAs: 'text/plain'` is REQUIRED here, not optional** — it is also the
   atom's default, so the requirement is "do not reach for the other one."
   Every anchor in `checks.ts` is markdown SYNTAX: `listPrompts` matches
   `^##\s+Prompt\s+N`, the title check matches `^#\s+Test Prompts`, and all
   five required-field checks match `**<Field>:**`.

   The producer (`pdd-to-test-prompts` § Process step 4) writes this artifact
   with `drive_create_file`, which lands a Google Doc but uploads the body as
   `text/plain; charset=utf-8` — so Drive never runs the markdown→styles
   conversion and the `#` / `**` markers stay LITERAL characters in the doc.
   A `text/markdown` export therefore has to ESCAPE them to preserve them:
   `## Prompt 4` comes back as `\#\# Prompt 4` and `**Category:**` as
   `\*\*Category:\*\*`, and every check's anchor is gone.

   Measured on the real artifact for `bednet-check-2-visit/20260907-1126`
   (fileId `1l0satmkozVVDH0A0vcjw3u6bjFQsgZs3G5OXcDb4X8E`, revision 7, 58
   prompts, structurally correct): `text/plain` scores **8/8**, `text/markdown`
   scores **2/8** — 0 prompts found, six hard failures, and the two remaining
   "passes" vacuous (an empty prompt list has no missing fields and no
   adversarial share to fall short of). Because the document is CORRECT, the
   auto-fix loop in step 5 cannot converge: it hands the producer hints like
   *add a `# OCS Test Prompts` heading* on a doc that has one, burns the
   bounded retries, and lands `incomplete` — taking `pdd-to-test-prompts-eval`
   with it (dimagi-internal/ace#2169).

   **This is the OPPOSITE of what `idea-to-pdd-qa` requires** (`text/markdown`,
   ace#1617), and the same as what `pdd-to-work-order-qa` requires
   (`text/plain`, ace#1609). The requirement is per-skill and follows from two
   facts, both readable: **how the producer WROTE the doc**
   (`drive_create_doc_from_markdown` → real heading/bold styles, so a plain
   export drops the markers entirely; `drive_create_file` → literal markdown
   characters, so a markdown export escapes them) and **what that skill's
   checks match**. Always read the target skill's step 1 rather than reusing
   the last one you ran.

   `checks.ts` also normalises markdown-export escaping defensively (via
   `normalizeDriveExport` in `lib/drive-export.ts`, shared with both siblings),
   so passing the wrong format no longer produces spurious failures. That is a
   safety net, not a licence — pass `text/plain` and keep the checks matching
   what they were written against.

2. **Save to a local temp path**.
3. **Run all checks** via the generic CLI runner:
   ```bash
   ACE_ROOT="${CLAUDE_PLUGIN_ROOT:-$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/plugins/installed_plugins.json'))); print(d['plugins']['ace@ace'][0]['installPath'])")}"
   node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-run.ts" --skill pdd-to-test-prompts-qa --artifact "$TMP" --target "<opp-name>/<run-id>" --capture-path "2-scenarios/pdd-to-test-prompts.md" --include-passed
   ```

   **`--target` and `--capture-path` are REQUIRED.** `qa-run.ts` exits with
   `missing required --target` and runs zero checks if either is omitted — the
   trailing `...` that used to stand in for them here was not runnable
   (dimagi-internal/ace#1775). `--include-passed` is optional but recommended:
   the passed[] list is what the QA result YAML reports on a clean run.
4. **Write the QA result** to Drive at `2-scenarios/pdd-to-test-prompts-qa_result.yaml`.
5. **Return the verdict** — pass | fail | incomplete. On fail, orchestrator attempts auto-fix and re-runs; halts after bounded retries.

## MCP Tools Used

- Google Drive: `drive_read_file` — **always with `exportAs: 'text/plain'`** for the test-prompts artifact (see § Process step 1; the same as `pdd-to-work-order-qa`, the inverse of `idea-to-pdd-qa`, which requires `text/markdown`), `drive_create_file`
- Bash: `node "$ACE_ROOT/node_modules/tsx/dist/cli.mjs" "$ACE_ROOT/scripts/qa-run.ts" ...`

## Mode Behavior

- **Auto:** Run checks, write QA result, return verdict.
- **Review:** Same as Auto.

## Dry-Run Behavior

When `--dry-run`: reads happen normally; QA result IS written (internal artifact).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Initial skill. Phase 1 PR #3 of the QA/Eval split migration (greenfield). 8 static checks. Companion `pdd-to-test-prompts-eval` ships in the same PR. | ACE team (0.13.90) |
| 2026-09-07 | **Step 1 now mandates `exportAs: 'text/plain'`, and `checks.ts` normalises markdown-export escaping (ace#2169).** Third instance of the class ace#1609 / ace#1617 already fixed by name in the two sibling QA skills; this one was never given a per-skill mandate. Measured on `bednet-check-2-visit/20260907-1126`: 8/8 on the plain export, 2/8 on the markdown export of the same correct 58-prompt suite (0 prompts found; the two passes vacuous). *Enforced:* `test/skills/qa-export-format.test.ts` (ratchet — a `*-qa` skill whose `checks.ts` anchors on markdown syntax must name an `exportAs`). | ACE team |
