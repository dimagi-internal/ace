---
name: pdd-to-work-order
description: >
  Draft a contractual Work Order from the approved PDD and the run's
  decisions.yaml. Generic by default — partner identity is a placeholder
  unless an LLO was supplied. Renders to a clean Google Doc. Parallel to
  Phase 8 solicitation, not a replacement.
disable-model-invocation: true
---

# PDD to Work Order

Take the approved PDD and decisions.yaml and produce a contractual Work Order draft, rendered as a clean Google Doc suitable for human review and signature.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 producer | `1-design/idea-to-pdd.md` | scope, deliverables, timeline, target population, success metrics, evidence model |
| Phase 1 producer | `decisions.yaml` | load-bearing values (rate, FLW count, working language, candidate LLO, etc.) — read as-is |
| Run-root | `inputs-manifest.yaml` | optional reference for partner identity if it was supplied as input |
| Operator (optional) | `--llo <slug>` flag | overrides partner-name placeholder |
| Skill-local reference | `references/writing-style.md` | **Required reading before synthesizing any prose token.** Dimagi voice, modal verbs, partner-naming convention, bold-use rules, soft commercial language, canonical terminology (LLO/FLW/POC/verified visit), sentence-level templates, what to avoid. |
| Skill-local reference | `references/style-guide.md` | Visual spec for the rendered Google Doc — consult when updating `templates/work-order-template.md` or the published WORK_ORDER_TEMPLATE_ID gdoc, not per-run. |

## Products

- `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` — the work-order Google Doc (re-runs create `pdd-to-work-order-2.gdoc`, `pdd-to-work-order-3.gdoc`, etc.)
- `run_state.yaml.phases.idea-to-design.products.work_order` — `{title, file_id}` typed handoff. This skill is the sole writer.
- Appended `wo-*` rows in `ACE/<opp-name>/runs/<run-id>/decisions.yaml` (merge-only — never overwrites existing rows).

## Process

1. **Read inputs in parallel.** Issue one `drive_read_file` block for the PDD, decisions.yaml, and inputs-manifest. Then read the skill-local `references/writing-style.md` once — it governs every prose token you synthesize below. Trust context across subsequent steps (do not re-read).

2. **Determine archetype** from the PDD's frontmatter (`archetype: atomic-visit | focus-group | multi-stage`). The archetype branches the Scope of Work, Verification, Roles RACI, and Payment per-unit sections.

3. **Resolve contractual fields.** For each work-order field, apply the inference order:

   - (a) If an existing `decisions.yaml` row from an earlier skill covers it (e.g., `payment-rate`, `flw-count`, `working-language`, `budget-plausibility`), use that value as-is. Never duplicate or rename.
   - (b) If inferable from PDD body (Timeline → period of performance; Success Metrics + Budget → NTE; etc.), use the inference and emit a new `wo-*` row capturing it.
   - (c) If genuinely unknowable (partner name absent, WO# unknown, MSA date unknown), insert a bracketed placeholder like `[Partner Name]` in the gdoc and emit a `wo-*` row with `status: open` + `notes` telling the human what to fill in.

   Common `wo-*` rows to emit when load-bearing:

   | ID | Question | Map to surface |
   |---|---|---|
   | `wo-number` | Sequence number for this WO under the MSA | Header (placeholder if unknown) |
   | `wo-period-of-performance` | Start + end dates | Header + Timeline section |
   | `wo-total-not-to-exceed-usd` | Total NTE budget cap | Payment Terms section |
   | `wo-payment-schedule-split` | Milestone payment percentages (e.g., 40/60) | Payment Schedule sub-table |
   | `wo-mobilization-advance-pct` | Mobilization advance % of cap | Payment Schedule row 1 |
   | `wo-reporting-cadence` | Frequency of progress reports (default: weekly) | Reporting sub-section |
   | `wo-ethics-scope` | Operational-only vs patient-level | Ethics section |
   | `wo-data-storage-region` | Server region for data storage (default: US) | Data Handling section |

4. **Append `wo-*` rows to `decisions.yaml`** via the `decisions_append_rows` MCP atom (ace-decisions server). Do not hand-construct YAML and do not use `update_yaml_file` for this file — the dedicated atom validates each row against `lib/decisions-schema.ts` v3 at the call boundary and is idempotent on re-runs.

   Tool call:

   ```
   decisions_append_rows({
     runFolderId: <run-folder file_id>,
     opportunity: <opp-slug>,
     run_id: <run-id>,
     rows: [
       {
         id: "wo-period-of-performance",
         phase: "1-design",
         skill: "pdd-to-work-order",
         question: "what dates bound the work",
         "ai-default": "2026-05-22 to 2026-07-31",
         options: ["2026-05-22 to 2026-07-31"],
         source: "pdd-timeline",
         status: "ai-default"
       },
       ...
     ]
   })
   ```

   Field shape: `phase: "1-design"` (ordinal-prefixed, not `idea-to-design`), `skill: "pdd-to-work-order"`, and `status: "ai-default"` on every row this skill writes. `decision`, `rationale`, `default`, `options_considered`, and `notes` are NOT valid keys — the schema is `id` / `phase` / `skill` / `question` / `ai-default` / `options` / `source` / `status`, with optional `reasoning`. The atom rejects any row that doesn't match.

   When a load-bearing field is genuinely unknowable (partner name absent, WO# unknown), insert a bracketed placeholder like `[Partner Name]` in the gdoc and pass the placeholder as `ai-default` (e.g. `"ai-default": "[Partner Name]"`) plus a `reasoning` line telling the human what to fill in. `status` is still `"ai-default"` — `"open"` is not a valid v3 status.

   Canonical worked fixture with `wo-*` rows: `test/skills/pdd-to-work-order-qa/fixtures/good-decisions.yaml`.

5. **Render the work-order template to a Google Doc.**
   - `docs_copy_template(templateDocId=<WORK_ORDER_TEMPLATE_ID from env>, parentFolderId=<run-folder file_id>, title="pdd-to-work-order", replacements={...})`. Pass all token replacements directly to `docs_copy_template` — it runs a single `replaceAllText` batch under the hood, no separate `docs_batch_update` needed. If the run already has a `pdd-to-work-order.gdoc`, title the new one `pdd-to-work-order-2`, etc.
   - **After the copy returns, call `docs_finalize_bullets(documentId=<new-doc-id>)`** — this applies real Google Docs bullet styling to the paragraphs enclosed in the template's `<<<BULLETS_*_START>>>` / `<<<BULLETS_*_END>>>` anchor pairs, deletes the anchors, and cleans up empty bulleted paragraphs left over from blank-line spacing. Required step; without it the bulleted sections (§2 scope, §4.2 verified-unit criteria, §4.3 reporting, §8.1 permissions) render as plain paragraphs.
   - Body tokens for bulleted regions (`{{scope_body}}`, `{{verified_unit_body}}`, `{{reporting_body}}`, `{{permissions_body}}`) take a `\n`-separated string with one bullet item per line. `replaceAllText` honors `\n` as paragraph breaks; `docs_finalize_bullets` then bullet-styles each resulting paragraph.
   - Tokens use `{{...}}` snake_case:
   The template has SIX real Google Docs tables (header, timeline, payment schedule, RACI, data handling, signatures). Each cell that varies per work-order contains ONE `{{snake_case}}` token. The skill replaces tokens via `replaceAllText` — one cell-sized value per token. Token groups:

   **Prose-token synthesis — apply `references/writing-style.md` to every body token.** The most load-bearing rules: active voice; `will`/`may`/`must` (never `shall`); "(henceforth, referred to as 'partner')" on first reference then `the partner` throughout; no marketing language; spell out acronyms on first use (`Insecticide-Treated Net (ITN)`, `Knowledge, Attitudes, Practices (KAP)`, `Locally-Led organization (LLO)`, etc.). See the reference doc for sentence-level templates worth reusing verbatim (e.g., the NTE-cap pattern, the verified-deliverable definition, the timeline-risk-flag clause).

   **Bold rendering is a known pipeline gap.** The template uses `replaceAllText` (plain-text substitution) — there is no markdown-bold → Google-Docs-bold finalizer. **Do NOT emit `**asterisks**` in prose tokens** — they render as literal asterisks in the Google Doc. Strip all markdown bold from prose tokens. (The writing-style guide's bold rules apply once a docs-finalize-bold post-processor ships — *not yet built*; tracking as a backlog item.)

   **Header + narrative (prose tokens):**
     - `{{wo_number}}`, `{{opp_title}}`, `{{wo_date}}` (today, ISO), `{{wo_period_of_performance}}`
     - `{{background_body}}` (synthesized from PDD's Problem Statement + Intervention Design + any named downstream consumer)
     - `{{scope_intro}}` (one-sentence framing of the work, archetype-branched)
     - `{{geographic_coverage_body}}` (from PDD Target Population; `[Geographic Coverage — Partner to propose]` if not specified)
     - `{{primary_deliverable_body}}` (from PDD Success Metrics)
     - `{{verified_unit_closing}}` (the "Verification will be performed via..." closing paragraph after the verified-unit bullets)
     - `{{wo_total_not_to_exceed_usd}}` — bare number
     - `{{ethics_body}}` — prose
     - `{{pdd_link}}` (Drive URL of the PDD from `phases.idea-to-design.products.pdd.file_id`)
     - `{{annexure_b_placeholder}}` ("To be provided" if no opp-specific annexure)

   **Bulleted-region tokens (newline-separated; finalize via `docs_finalize_bullets`):**
     - `{{scope_body}}` — what the Partner will and will not do, as a single bullet block (one bullet per line). Recommended structure: 1-2 sentence intro paragraph (no leading dash), then a blank line, then "**Will Do:**" header line, then bullets for in-scope items, then a blank line, then "**Will Not Do:**" header, then bullets for out-of-scope items. The live `WORK_ORDER_TEMPLATE_ID` template has ONE `{{scope_body}}` token — not separate `{{scope_will_body}}` / `{{scope_will_not_body}}` tokens. (Splitting into the two-token form is preferable for clarity; tracked as future work — see bednet-spot-check Phase 1 finding.)
     - `{{verified_unit_body}}` — criteria a unit must meet to be "verified" (one bullet per line)
     - `{{reporting_body}}` — required reporting deliverables (one bullet per line)
     - `{{permissions_body}}` — required permissions (one bullet per line)

   **Timeline table (9 rows × 3 cols, header + 8 weeks):**
     - `{{week_N_dates}}`, `{{week_N_activities}}` for N=1..8 (from PDD Timeline)

   **Payment Schedule table (3 rows × 6 cols, header + 2 milestones):**
     - Milestone 1: `{{wo_mobilization_advance_pct}}`, `{{wo_mobilization_amount}}`, `{{wo_mobilization_trigger}}`, `{{wo_mobilization_timing}}`
     - Milestone 2: `{{wo_reconciliation_pct}}`, `{{wo_reconciliation_amount}}`, `{{wo_reconciliation_trigger}}`, `{{wo_reconciliation_timing}}`
     - **PCT tokens are bare numbers (no `%` suffix).** The live template's percent cells already have `%` pre-suffixed (e.g. cell text reads `{{wo_mobilization_advance_pct}}%`), so emitting `"40%"` produces `"40%%"`. Pass `"40"` (or `"40.0"` if you need decimals) — the template adds the `%` glyph. Same rule for `{{wo_reconciliation_pct}}`. (Surfaced in bednet-spot-check Phase 1 finding.)

   **RACI table (12 rows × 3 cols, header + 11 responsibility rows):**
     - `{{raci_N_responsibility}}`, `{{raci_N_dimagi}}`, `{{raci_N_partner}}` for N=1..11. Archetype-branched (atomic-visit, focus-group, multi-stage produce different RACI rows). Use `—` or `✓` or `Lead`/`Supports`/`Reviews`/`Produces` for the responsibility-owner columns. If the archetype needs fewer than 11 rows, fill trailing rows with empty strings.

   **Data Handling table (9 rows × 2 cols, header + 8 fields):**
     - `{{data_project_overview}}`, `{{data_subjects}}`, `{{data_personal_info}}`, `{{data_purpose}}`, `{{data_security}}`, `{{data_partner_measures}}`, `{{data_storage_location}}`, `{{data_protection}}`

   **Signatures table (2 rows × 2 cols, header + signer blocks):**
     - `{{partner_signatory_name}}`, `{{partner_signatory_title}}`, `{{partner_address}}` (left cell — Subcontractor)
     - Dimagi cell is hardcoded in the template (Lucina Tse, COO, Cambridge MA address) — no tokens for the right cell.

6. **Write `run_state.yaml.phases.idea-to-design.products.work_order`** via `update_yaml_file` with `merge: 'two-level'`:

   ```yaml
   phases:
     design:
       products:
         work_order:
           title: "Work Order — <opp-title>"
           file_id: <gdoc-id>
   ```

7. **Invoke `decisions-render`** so the human-readable `decisions.gdoc` refreshes with the new `wo-*` rows.

## Archetypes

### `atomic-visit` (default)
- Scope: per-visit data capture with photo + GPS standardization.
- Verification: photo + GPS Layer A on the deliver-app form.
- Payment unit: per visit (rate from existing `payment-rate` decision).
- Roles: Dimagi configures app + verification audit; Partner recruits FLWs, runs field ops, transports samples (if applicable).

### `focus-group`
- Scope: per-session facilitation with attestation form submission and gdoc write-up.
- Verification: attestation submission Layer A + gdoc receipt Layer B; coordinator-graded practice-session-pass gates payment.
- Payment unit: per session (facilitator + notetaker rate from existing `per-session-rate` decision); facilitator training stipend on practice-session-pass.
- Roles: Dimagi configures OCS chatbot + attestation form + gdoc template; Partner recruits facilitators + notetakers, runs sessions, completes gdoc.

### `multi-stage`
- Scope: per-stage sub-section, each with its own archetype-shaped scope.
- Verification: per-stage criteria reflecting the stage's archetype.
- Payment: may mix per-visit and per-session units; stage-gate criteria from PDD.
- Roles: per-stage RACI.

## MCP Tools Used
- Google Drive: `drive_read_file`, `update_yaml_file`
- Google Docs: `docs_copy_template`, `docs_finalize_bullets`

## Mode Behavior

- **Default (auto):** infer all fields, draft the gdoc, append `wo-*` rows, write `products.work_order`, proceed.
- **Review:** after the gdoc is written, pause and surface the gdoc URL for human approval before proceeding to the next phase.

## Dry-Run Behavior

When `--dry-run` is active:
- Write the work-order gdoc as normal (Drive writes are reversible).
- State tracks as `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-21 | Add `references/writing-style.md` + `references/style-guide.md`, adapted from `sarvesh-tewari/ace-skills-stewari`; wire writing-style.md into step 1 + prose-token synthesis | ACE team |
| 2026-05-21 | Drop bold-span rule from prose-token synthesis preamble + add explicit "do not emit markdown bold" warning (template uses plain-text replaceAllText; no bold finalizer yet). Track docs-finalize-bold post-processor as backlog. | ACE team |
