---
name: pdd-to-work-order
description: >
  Draft a contractual Work Order from the approved PDD and the run's
  decisions.yaml. Generic by default — partner identity is a placeholder
  unless an LLO was supplied. Renders to a clean Google Doc. Parallel to
  Phase 8 solicitation, not a replacement.
disable-model-invocation: false
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

2. **Determine archetype** from the PDD's frontmatter (`archetype: atomic-visit | longitudinal-visits | focus-group | multi-stage`). The archetype branches the Scope of Work, Verification, Roles RACI, and Payment per-unit sections.

3. **Resolve contractual fields.** For each work-order field, apply the inference order:

   - (a) If an existing `decisions.yaml` row from an earlier skill covers it (e.g., `payment-rate`, `flw-count`, `working-language`, `budget-plausibility`), use that value as-is. Never duplicate or rename. **Resolve to the row that is NOT superseded** — a row carrying `superseded_by` is history, kept for the audit trail, and its value is wrong by construction. The log is append-only, so a mid-run correction cannot edit the original in place; it lands as a new row and the write boundary stamps `superseded_by` on the one it replaced. Use `resolveDecision(log, id)` from `lib/decisions-schema.ts` rather than a bare id lookup — a bare lookup on the canonical id is exactly what returns the stale value. On bednet-check-2-visit/20260814-2019, `payment-rate` held a per-visit band that a later row corrected to a per-day band (ace#1420); following this step literally would have put the wrong rate into the Phase 4 payment unit and a contractual document (ace#1421).
   - (b) If inferable from PDD body (Timeline → period of performance; Success Metrics + Budget → NTE; etc.), use the inference and emit a new `wo-*` row capturing it.
   - (c) If genuinely unknowable (partner name absent, WO# unknown, MSA date unknown), insert a bracketed placeholder like `[Partner Name]` in the gdoc and emit a `wo-*` row with `status: open` + `notes` telling the human what to fill in.

     **The bracket convention does not COMPOSE inside a cell whose checker parses the whole cell.** It brackets the unknown *cell*, not each unknown part of it. A field that reads as two things — Period of Performance is "start + end dates" — still gets ONE pair of brackets covering the entire value: `[Start and end dates set on contract execution]`, not `[Start date on contract execution] to [Start + 10 weeks]`. `pdd-to-work-order-qa § period_of_performance_complete` accepts a whole-cell single-bracket span (`/^\[[^\]]+\]$/`) and deterministically rejects two spans joined by "to" — an interior `]` fails the regex. A work order drafted before a partner is selected is the normal Phase 1 case, so this is the common path, not an edge (ace#1781; mirror of ace#1092, which fixed the same trap on the reader side).

   Common `wo-*` rows to emit when load-bearing:

   | ID | Question | Map to surface |
   |---|---|---|
   | `wo-number` | Sequence number for this WO under the MSA | Header (placeholder if unknown) |
   | `wo-period-of-performance` | Start + end dates, **as ONE cell value**: either `YYYY-MM-DD to YYYY-MM-DD` / `Mon DD, YYYY to Mon DD, YYYY`, or a SINGLE bracketed placeholder spanning the whole cell (e.g. `[Start and end dates set on contract execution]`) — never two bracketed spans joined by "to", which `pdd-to-work-order-qa § period_of_performance_complete` rejects | Header + Timeline section |
   | `wo-total-not-to-exceed-usd` | Total NTE budget cap | Payment Terms section |
   | `wo-payment-schedule-split` | Milestone payment percentages (e.g., 40/60) | Payment Schedule sub-table |
   | `wo-mobilization-advance-pct` | Mobilization advance % of cap | Payment Schedule row 1 |
   | `wo-reporting-cadence` | Frequency of progress reports (default: weekly) | Reporting sub-section |
   | `wo-ethics-scope` | What kind of data does the work touch? **Options:** `operational-no-personal-data` · `operational-with-personal-data` · `patient-level-clinical` | Ethics section |
   | `wo-data-storage-region` | Server region for data storage (default: `united-states`). A qualifier such as "provisional, pending confirmation" goes in `params.caveat`. **Options:** `united-states` · `european-union` · `in-country` | Data Handling section |

4. **Append `wo-*` rows to `decisions.yaml`** via the `decisions_append_rows` MCP atom (ace-decisions server). Do not hand-construct YAML and do not use `update_yaml_file` for this file — the dedicated atom validates each row against `lib/decisions-schema.ts` v5 at the call boundary and is idempotent on re-runs.

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
         status: "ai-default",
         evidence_basis: "stated",
         value_set_by: "external"
       },
       ...
     ]
   })
   ```

   Field shape: `phase: "1-design"` (ordinal-prefixed, not `idea-to-design`), `skill: "pdd-to-work-order"`, and `status: "ai-default"` on every row this skill writes. `decision`, `rationale`, `default`, `options_considered`, and `notes` are NOT valid keys — the schema is `id` / `phase` / `skill` / `question` / `ai-default` / `options` / `source` / `status` / **`evidence_basis`** / **`value_set_by`**, with optional `reasoning` (and `conflict_signals`, REQUIRED when `evidence_basis` is `conflicting`). The atom rejects any row that doesn't match.

   **`evidence_basis` is mandatory on every new row** (schema v5, `lib/decisions-schema.ts`): `stated` (the value is directly in a source), `inferred` (extrapolated beyond any source — say so in `reasoning`), or `conflicting` (resolves disagreeing sources; then `conflict_signals` must enumerate at least two competing readings). `DecisionRowStrictSchema` rejects a row without it at the MCP boundary before any Drive write, so a row missing it never lands. Full contract: `skills/idea-to-pdd/SKILL.md § The evidence_basis contract`. (This section documented the v3 shape until ace#1485 — its own worked example was rejected verbatim.)

   **`value_set_by` is mandatory on every new row** (schema v5): `ace` when the value is ACE's judgment to make from the source material, `external` when the real value gets fixed later by someone else — a rate negotiated in a solicitation response, dates set on contract execution, an FLW count fixed at deployment. Nearly every `wo-*` row is `external`: the work order states ACE's best estimate, and the contract sets the real number.

   `value_set_by` is **not** an escalation path and does not gate anything. ACE still picks a value, still writes it as `ai-default`, and the run still proceeds — exactly as before. The flag exists so a downstream phase does not cite a projection as a settled commitment, and so a later run re-deriving it differently reads as expected rather than as drift. Measured across 22 runs of two opps, `wo-period-of-performance`, `wo-total-not-to-exceed-usd` and `payment-rate` produced a different confident-looking answer on nearly every run, and the first hh-poverty run had originally recorded them correctly as *"Deferred to deployment (Annex B); negotiated via solicitation response"* — inside the `ai-default` string, where nothing could read it.

   When a load-bearing field is genuinely unknowable (partner name absent, WO# unknown), insert a bracketed placeholder like `[Partner Name]` in the gdoc and pass the placeholder as `ai-default` (e.g. `"ai-default": "[Partner Name]"`) plus a `reasoning` line telling the human what to fill in. `status` is still `"ai-default"` — `"open"` is not a valid status, and `value_set_by: "external"` is how you say "someone else sets this," not a status. A placeholder default is `evidence_basis: "inferred"` unless a source actually states it. **One pair of brackets per cell** — see step 3(c): a multi-part field like `wo-period-of-performance` gets a single span covering the whole value (`"[Start and end dates set on contract execution]"`), never per-part spans joined by "to".

   Canonical worked fixture with `wo-*` rows: `test/skills/pdd-to-work-order-qa/fixtures/good-decisions.yaml`.

5. **Render the work-order template to a Google Doc.**
   - **Resolve-or-create the `1-design/` phase subfolder first** — `drive_create_folder({name: '1-design', parentFolderId: <run-folder file_id>, findOrCreate: true})` — and pass its id (NOT the run-folder id) as `parentFolderId` below. Passing the run-folder id lands the work order flat at the run root, which fails the Phase boundary's `verify_phase_artifacts` (it walks `1-design/`; jjackson/ace#623).
   - `docs_copy_template(templateDocId=<WORK_ORDER_TEMPLATE_ID from env>, parentFolderId=<1-design folder id>, title="pdd-to-work-order.gdoc", replacements={...})`. Pass all token replacements directly to `docs_copy_template` — it runs a single `replaceAllText` batch under the hood, no separate `docs_batch_update` needed. If the run already has a `pdd-to-work-order.gdoc`, title the new one `pdd-to-work-order-2.gdoc`, etc.
   - **After the copy returns, call `docs_finalize_bullets(documentId=<new-doc-id>)` (required).** This atom applies real Google Docs bullet styling to paragraphs enclosed in `<<<BULLETS_<NAME>_START>>>` / `<<<BULLETS_<NAME>_END>>>` anchor pairs, deletes the anchors, and returns the count of pairs processed. **The live `WORK_ORDER_TEMPLATE_ID` template carries FIVE anchor pairs** (the two §2 scope blocks, §4.2 verified-unit criteria, §4.3 reporting, §8.1 permissions), so the expected result is `anchorsProcessed: 5` (a non-zero `emptyBulletsRemoved` is normal when some bullet lines go unused). A `processed: 0` result now means the anchors were destroyed (e.g. by a bad token replacement) — investigate before shipping the doc; it is no longer the expected no-op it was pre-anchor-landing (history: jjackson/ace#614; doc staleness caught as jjackson/ace#819).
   - Body tokens for bulleted regions (`{{scope_will_body}}`, `{{scope_will_not_body}}`, `{{verified_unit_body}}`, `{{reporting_body}}`, `{{permissions_body}}`) take a `\n`-separated string with one bullet item per line. `replaceAllText` honors `\n` as paragraph breaks; `docs_finalize_bullets` then bullet-styles each resulting paragraph inside the anchor pairs.
   - **Token-coverage check (class-level preventer, jjackson/ace#819).** After `docs_copy_template` + `docs_finalize_bullets`, read the rendered doc back (`drive_read_file` or `docs_get`) and scan for any surviving `{{` — a leftover token means the skill's replacement keys and the live template's tokens have drifted (exactly how `{{scope_will_body}}`/`{{scope_will_not_body}}` leaked into a contractual artifact when this doc still described a single `{{scope_body}}`). On a hit, fix via `docs_batch_update` replaceAllText and file the drift before proceeding.
   - **Do NOT write a `pdd-to-work-order.source.md`.** Sibling skills that publish markdown (`idea-to-pdd`, the five `training-*` producers) persist their composed markdown so `run-surface-audit`'s `DOC-FIDELITY-UNVERIFIED` has something real to diff (ace#1687 half 2, `sourcePersisted` in `lib/artifact-manifest.ts`). This skill is deliberately excluded and must stay that way: `docs_copy_template` is `drive.files.copy` plus a `replaceAllText` batch — Doc to Doc, with **no markdown importer anywhere on the path** — so the content-dropping regression that check guards cannot occur here, and there is no composed markdown to persist in the first place. Manufacturing one would hand the auditor a file this document was never produced from, i.e. a green comparison that means nothing. The drift that CAN happen here is a leftover template token, and the check directly above is its preventer. Pinned by `test/lib/source-persisted-artifacts.test.ts`.
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
     - `{{payment_unit_closing}}` — § 6.2's closing sentence. **The rate unit
       comes from the PDD's grain, NOT from the archetype.**

       **Read the PDD's § Program Parameters first** and take `entity_id_grain`
       (and `payment_rate_unit`, when present). Connect resolves payable units
       by `entity_id`, so the grain — not the archetype, not the shape of the
       field work — decides what a partner is being quoted a price *per*. Write
       the sentence in the grain's units:

       - Grain resolves ONE payable unit **per visit** → "Dimagi will pay only
         for verified units at the per-visit rate proposed in the partner's
         solicitation response." On `longitudinal-visits`, extend it so the
         repeat is unambiguous: "…for each verified visit in the follow-up
         sequence."
       - Grain is **day-scoped** (e.g. `entity_id_grain` = *worker username +
         encounter date*) → the payable unit is a worker-DAY, so quote a
         per-day rate: "…at the per-day rate proposed in the partner's
         solicitation response, for each verified follow-up day." Never a
         per-visit rate — several same-day visits by one worker collapse into
         ONE payable unit.
       - Grain resolves **per session** (typical of `focus-group`) → "…at the
         per-session rate proposed in the partner's solicitation response."
       - `multi-stage` → name the stage that is payable, per the PDD's
         payable-stage declaration, in that stage's own grain.

       **Pick ONE, and make § 6 internally consistent with it** — the caps and
       the not-to-exceed total must be stated in the same units as the rate.

       **Why this is grain-driven and not archetype-driven.** On
       bednet-check-2-visit/20260902-1555, `entity_id` was source-pinned to
       worker identity + encounter date, so the payable unit was a worker-day.
       `idea-to-pdd-qa § payment_unit_matches_entity_grain` (ace#1420) caught the
       per-visit quote in the PDD and the money was correctly re-derived per
       worker-day — and then this step, read literally as an archetype branch,
       put the per-visit sentence back into the **Work Order**, the document
       that actually gets signed. The rendered § 6.2 said both "at the per-visit
       rate" and "the payable unit under this Work Order is a worker-day, not an
       individual visit"; the overstatement was up to 6x. `pdd-to-work-order-qa`
       returned 9/9 with the contradiction present, because it had no
       counterpart to the PDD-side check.
       *Enforced:* `pdd-to-work-order-qa § payment_unit_matches_entity_grain`
       (ace#1946), which shares `lib/payment-grain.ts` with the PDD-side check.

       Until ace#1004 this sentence was hardcoded in the template as
       "…at the per-visit (or per-session, per archetype) rate…", and the
       parenthetical — an instruction to the renderer — rendered verbatim into a
       signed contract, telling a partner their payment unit depends on an
       "archetype" defined nowhere in the document. Because it was not a
       `{{token}}` and not a `<<marker>>`, `no_scaffolding_markers` passed it, the
       ace#819 token-coverage scan passed it, and QA returned 8/8 with the defect
       present (hh-poverty-targeting/20260728-0705). The rate itself is negotiated
       via the solicitation response and is NOT set here.
       *Enforced:* `pdd-to-work-order-qa § no_renderer_instructions`.
     - `{{wo_total_not_to_exceed_usd}}` — bare number
     - `{{ethics_body}}` — prose
     - `{{pdd_link}}` (Drive URL of the PDD from `phases.idea-to-design.products.pdd.file_id`)
     - `{{annexure_b_placeholder}}` ("To be provided" if no opp-specific annexure)

   **Bulleted-region tokens (newline-separated; bullet-styled via `docs_finalize_bullets` — the anchor pairs are live in the template, see Step 5):**
     - `{{scope_will_body}}` — the in-scope bullet lines ONLY, one item per line (no leading dashes, no intro paragraph, no "Will Do:" header — the template supplies the "For each engagement, the partner will:" lead-in above the token).
     - `{{scope_will_not_body}}` — the out-of-scope bullet lines ONLY, one item per line (the template supplies the "The partner will not:" lead-in).
     - There is NO single `{{scope_body}}` token in the live template. Passing one silently drops all scope content AND leaks the two real tokens verbatim into § 2 Scope of Work (a `no_scaffolding_markers`-class QA defect) — the exact failure from bednet-spot-check/20260701-1644 (jjackson/ace#819).
     - `{{verified_unit_body}}` — criteria a unit must meet to be "verified" (one bullet per line)
     - `{{reporting_body}}` — required reporting deliverables (one bullet per line)
     - `{{permissions_body}}` — required permissions (one bullet per line)

   **Timeline table (9 rows × 3 cols, header + 8 weeks):**
     - `{{week_N_dates}}`, `{{week_N_activities}}` for N=1..8 (from PDD Timeline)

   **Payment Schedule table (3 rows × 6 cols, header + 2 milestones):**
     - Milestone 1: `{{wo_mobilization_advance_pct}}`, `{{wo_mobilization_amount}}`, `{{wo_mobilization_trigger}}`, `{{wo_mobilization_timing}}`
     - Milestone 2: `{{wo_reconciliation_pct}}`, `{{wo_reconciliation_amount}}`, `{{wo_reconciliation_trigger}}`, `{{wo_reconciliation_timing}}`
     - **If `wo-total-not-to-exceed-usd` is a bracketed placeholder rather than a number, `{{payment_unit_closing}}` MUST state that nothing is payable yet.** Keep the percentage split — a 40/60 structure pending a cap is an ordinary pre-award shape, and `payment_schedule_sums_to_100` requires the percentages to stay readable. What is not ordinary is presenting a percentage of an undefined base as a commitment: § 6.1 reads `USD [TBD]` while § 6.2 reads "40% mobilization advance" with an amount cell of "[Amount derived from the agreed cap]". Add one sentence, e.g.:

       > These percentages are indicative of the agreed split only. No amount is payable under this schedule until the total not-to-exceed in § 6.1 is fixed at contract execution.

       *Enforced:* `pdd-to-work-order-qa § advance_contingent_when_cap_unresolved`. Measured on `poverty-graduation/20260905-0924`, where `commercial_realism` scored this strike 1 of 3 and called it sufficient on its own to make the draft unsignable (ace#2007). **This is the ONLY commercial-realism strike that is ACE's to fix.** The other two are not defects: the bracketed Period of Performance is the sanctioned pre-partner form (step 3(c) above), and the absent termination / liability / IP / data-ownership clauses are absent BY DESIGN — the work order is annexed to an MSA (`templates/work-order-template.md:147`), which is where they live. ace#1481 claimed otherwise and was closed NOT_PLANNED with the premise disproved; do not "fix" it by inventing clauses.
     - **PCT tokens are bare numbers (no `%` suffix).** The live template's percent cells already have `%` pre-suffixed (e.g. cell text reads `{{wo_mobilization_advance_pct}}%`), so emitting `"40%"` produces `"40%%"`. Pass `"40"` (or `"40.0"` if you need decimals) — the template adds the `%` glyph. Same rule for `{{wo_reconciliation_pct}}`. (Surfaced in bednet-spot-check Phase 1 finding.)

   **RACI table (12 rows × 3 cols, header + 11 responsibility rows):**
     - `{{raci_N_responsibility}}`, `{{raci_N_dimagi}}`, `{{raci_N_partner}}` for N=1..11. Archetype-branched (atomic-visit, focus-group, multi-stage produce different RACI rows). Use `—` or `✓` or `Lead`/`Supports`/`Reviews`/`Produces` for the responsibility-owner columns. If the archetype needs fewer than 11 rows, fill trailing rows with empty strings.

   **Data Handling table (9 rows × 2 cols, header + 8 fields):**
     - `{{data_project_overview}}`, `{{data_subjects}}`, `{{data_personal_info}}`, `{{data_purpose}}`, `{{data_security}}`, `{{data_partner_measures}}`, `{{data_storage_location}}`, `{{data_protection}}`

   **Signatures table (2 rows × 2 cols, header + signer blocks):**
     - `{{partner_signatory_name}}`, `{{partner_signatory_title}}`, `{{partner_address}}` (left cell — Subcontractor)
     - Dimagi cell is hardcoded in the template (Lucina Tse, COO, Cambridge MA address) — no tokens for the right cell.

5b. **Share it anyone-with-link, `commenter`, at creation (ace#1843).** On the
   `fileId` `docs_copy_template` returned, before step 6:

   ```
   drive_set_anyone_with_link(fileId: <workOrderDocId>, role: 'commenter')
   ```

   **`commenter`, not `reader`** — this is a CONTRACTUAL draft, the document a
   counterpart is most likely to mark up, and a Drive reader physically cannot
   leave a comment (`skills/feedback-ledger`'s `channel: gdoc-comments`
   assumes they can).

   **At creation, not as a cleanup step, and not left to
   `/ace:share-run-access`.** `docs_copy_template` creates UNSHARED and
   nothing downstream tests reachability — the doc exists, the token-coverage
   check above passes, `verify_phase_artifacts` finds it, and the recipient
   still gets *You need access*. Measured on three independent runs in three
   days (hh-poverty-targeting/20260828-0702, bednet-check-2-visit/20260828-0629,
   spark-facilitator/20260828-0703): this document and the PDD 401'd
   anonymously on all three, taking the run-summary page's entire `DESIGN`
   section with them, while every Phase 6 training document — whose producers
   already do this — was readable. The split tracks the producing skill.

   Worse than a dead link: ace-web MEASURES the `access` tag of each Drive
   link (`_read_design` → `LinkAccessReader.tag`), so a private Work Order
   renders as **ADMIN ONLY** — the partner reads deliberate withholding rather
   than an oversight.

   (Declared `recipientFacing` + `shareRole: 'commenter'` in
   `lib/artifact-manifest.ts`; enforced by
   `test/lib/recipient-facing-artifacts.test.ts`.)

6. **Write `run_state.yaml.phases.idea-to-design.products.work_order`** via `update_yaml_file` with `merge: 'deep'` (partial phase-child patch — `two-level` would replace the `design` block wholesale and clobber the sibling `products.pdd` written by `idea-to-pdd`, plus `status`/`steps`; #572/#587):

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
- Payment unit: per visit (rate from existing `payment-rate` decision) — **iff the PDD's `entity_id_grain` resolves one payable unit per visit.** The archetype describes the field work, not the payment grain; when the grain is coarser (e.g. worker + encounter date), quote the rate in the grain's units instead. See § Process step 5 `{{payment_unit_closing}}` (ace#1946).
- Roles: Dimagi configures app + verification audit; Partner recruits FLWs, runs field ops, transports samples (if applicable).

### `longitudinal-visits`
- Scope: per-visit data capture against a **followed entity over time** — the same visit-shaped unit as `atomic-visit`, but the Scope of Work must name what is being followed (the case / household / participant / cohort) and its cadence (phase, sequence, follow-up interval, or `visit 1..n`). A scope that reads identically to an atomic-visit one has lost the longitudinal half between the PDD and the contract — the ace#1462 failure, where the PDD prose was longitudinal-aware and the payment predicate was not.
- Verification: photo + GPS Layer A on the deliver-app form, as `atomic-visit`; PLUS the visit's position in the sequence must be recoverable from the submitted record, since that is what makes a repeat visit payable rather than a duplicate.
- Payment unit: per visit (rate from existing `payment-rate` decision) — **iff the PDD's `entity_id_grain` resolves one payable unit per visit.** Where it does, each qualifying visit in the sequence is separately payable — state this explicitly, because "per visit" against a followed entity otherwise reads as one payment per entity. Where the grain is day-scoped, several same-day follow-ups are ONE payable unit and the rate must be quoted per day (ace#1946).
- Roles: as `atomic-visit`, plus Partner owns the follow-up schedule and re-contact of enrolled entities.

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
- Google Drive: `drive_read_file`, `update_yaml_file`, `drive_set_anyone_with_link` (`role: 'commenter'` — § Process step 5b; ace#1843)
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
