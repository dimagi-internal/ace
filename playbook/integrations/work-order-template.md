# Work-Order Template — Bootstrap

The `pdd-to-work-order` skill renders Work Orders by copying a Google Doc template and replacing `{{...}}` tokens. The template is per-deployment Drive state, not committed to the repo. This page documents how to provision it.

## One-time bootstrap

```bash
# Reads ACE_DRIVE_ROOT_FOLDER_ID from the plugin-data .env automatically.
# Pass ACE_TEMPLATES_FOLDER_ID=<folder id> if you want a different parent.
npx tsx scripts/bootstrap-work-order-template.ts
```

The script:
1. Reads `templates/work-order-template.md` (canonical content).
2. Uploads it to Drive as a Google Doc named "ACE Work Order Template".
3. Prints the resulting file_id to stdout.

Record the file_id in 1Password at `AI-Agents/ACE - Drive Templates/work_order_template_id`, then re-run `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` (or `/ace:setup --force-env`).

If `ACE - Drive Templates` doesn't exist yet, create it as a `Secure Note` item in the `AI-Agents` vault. The same item holds `training_deck_template_id` (and any future Drive template IDs ACE skills copy from). Keep OCS-specific IDs (e.g. `golden_template_id`) in `ACE - Open Chat Studio` — `ACE - Drive Templates` is the home for Drive file-id references that aren't tied to a specific product.

## Refresh

To replace an existing template with the latest `templates/work-order-template.md`:

```bash
ACE_TEMPLATES_FOLDER_ID=<folder id> WORK_ORDER_BOOTSTRAP_FORCE=1 \
  npx tsx scripts/bootstrap-work-order-template.ts
```

The old template is trashed (recoverable for 30 days in Drive) and a new one is created. Record the new file_id in 1Password.

## Mirror-vs-live drift

`templates/work-order-template.md` is a **mirror**, not the renderer's input. `pdd-to-work-order` calls `docs_copy_template(templateDocId=$WORK_ORDER_TEMPLATE_ID, …)` — it reads the Drive document and never opens the repo file. Nothing made the two agree until ace#2126, and the gap is silent in both directions:

| Direction | What happens | Why nothing caught it |
|---|---|---|
| **MIRROR_ONLY** — token in the repo, absent from the live gdoc | The producer emits a replacement; `replaceAllText` matches zero occurrences; the API returns 200 | There is **no leftover `{{token}}`** in the output. The ace#819 token-coverage scan looks for surviving markers and finds none, `pdd-to-work-order-qa` returned 14/14, and the computed value simply evaporates. It reads as fixed at every checkpoint. |
| **LIVE_ONLY** — token in the live gdoc, absent from the repo | No producer fills it, so a literal `{{token}}` ships into a contract | Caught late, by the ace#819 scan on the rendered doc |

ace#2126 is the MIRROR_ONLY case, measured: the fix added `{{partner_first_reference}}` to the repo mirror and to `SKILL.md`, the live gdoc never got it, and two runs shipped a Work Order that obliged "the partner" ~30 times without ever defining who that is.

**Check it:**

```bash
npx tsx scripts/probe-work-order-template-drift.ts        # exit 0 in sync, 2 on drift
# from a dev checkout, point loadPluginEnv at the installed .env:
CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/ace-ace npx tsx scripts/probe-work-order-template-drift.ts
```

`/ace:doctor` runs the same probe as `work_order_template_drift` (WARN on drift), alongside the SA-accessibility probes. `test/skills/work-order-template-token-contract.test.ts` pins the three REPO files against each other in CI; this probe is the live half, which CI cannot run.

**Fixing drift: edit the live gdoc, do NOT re-bootstrap.** `WORK_ORDER_BOOTSTRAP_FORCE=1` trashes the current template and mints a **new file id**, which (a) requires a 1Password + `.env` update everywhere and (b) discards the `docs_batch_update` style retrofit described in `skills/pdd-to-work-order/references/style-guide.md`. Apply the minimal `docs_batch_update` instead, then re-run the probe to confirm it reports `OK`.

**A zero-match replacement is now visible.** `docs_copy_template` and `slides_copy_template` return `replacementOccurrences` (per-key counts), `unmatchedReplacements`, and a `warning` when any key matched nothing (`lib/replacement-coverage.ts`). Note the API omits `occurrencesChanged` rather than sending `0`, so absence — not a zero — is the signal.

## Template structure

The template has six real Google Docs tables (preserved through markdown→gdoc upload) PLUS five bulleted regions delimited by `<<<BULLETS_*_START>>>` / `<<<BULLETS_*_END>>>` anchor pairs.

**Tables:**

1. **Header** — 4 rows × 2 cols (WO Number / Date / Title / Period of Performance).
2. **Timeline** — 9 rows × 3 cols (header + 8 weeks). Cols: Week / Dates / Activities.
3. **Payment Schedule** — 3 rows × 6 cols (header + 2 milestones). Cols: # / Milestone / % of Cap / Amount (USD) / Trigger / Expected Timing.
4. **RACI** — 12 rows × 3 cols (header + 11 responsibility rows). Cols: Responsibility / Dimagi / Partner.
5. **Data Handling** — 9 rows × 2 cols (header + 8 standard fields).
6. **Signatures** — 2 rows × 2 cols, side-by-side Subcontractor + Dimagi blocks. Dimagi cell is hardcoded (Lucina Tse, COO, Cambridge MA).

**Bulleted regions** (each is a START anchor + body token + END anchor; the skill calls `docs_finalize_bullets` after `docs_copy_template` to apply real bullet styling and remove the anchors):

- `BULLETS_SCOPE_WILL` — §2 "the partner will" bullets
- `BULLETS_SCOPE_WILL_NOT` — §2 "the partner will not" bullets
- `BULLETS_VERIFIED_UNIT` — §4.2 verified-unit criteria
- `BULLETS_REPORTING` — §4.3 weekly + end-of-pilot reporting
- `BULLETS_PERMISSIONS` — §8.1 required permissions

Each varying cell or bullet contains one `{{snake_case}}` token. Body-token replacement values for bulleted regions take `\n`-separated content (one bullet per line).

## Token contract

| Token | Source |
|---|---|
| `{{wo_number}}` | `wo-number` decision (placeholder if open) |
| `{{opp_title}}` | PDD H1 |
| `{{wo_date}}` | today (ISO) |
| `{{wo_period_of_performance}}` | `wo-period-of-performance` decision |
| `{{partner_first_reference}}` | § 1's first-reference definition of the partner — `<Partner name> (henceforth, referred to as "partner")`, or `[Partner Name] (henceforth, referred to as "partner")` when no LLO has been selected (ace#2126) |
| `{{background_body}}` | PDD Problem Statement + Intervention Design |
| `{{scope_intro}}` | One-sentence framing of the work (archetype-branched) |
| `{{scope_will_body}}` ★ | Newline-separated "the partner will" bullet items |
| `{{scope_will_not_body}}` ★ | Newline-separated "the partner will not" bullet items |
| `{{geographic_coverage_body}}` | PDD Target Population |
| `{{primary_deliverable_body}}` | PDD Success Metrics |
| `{{verified_unit_body}}` ★ | Newline-separated verified-unit criteria (one bullet per line) |
| `{{verified_unit_closing}}` | Closing paragraph after the verified-unit bullets |
| `{{reporting_body}}` ★ | Newline-separated reporting deliverables |
| `{{week_N_dates}}`, `{{week_N_activities}}` (N=1..8) | PDD Timeline per-week rows |
| `{{wo_total_not_to_exceed_usd}}` | `wo-total-not-to-exceed-usd` decision |
| `{{wo_mobilization_advance_pct}}`, `{{wo_mobilization_amount}}`, `{{wo_mobilization_trigger}}`, `{{wo_mobilization_timing}}` | Payment milestone 1 (from `wo-payment-schedule-split` + `wo-mobilization-advance-pct`) |
| `{{wo_reconciliation_pct}}`, `{{wo_reconciliation_amount}}`, `{{wo_reconciliation_trigger}}`, `{{wo_reconciliation_timing}}` | Payment milestone 2 |
| `{{payment_unit_closing}}` | § 6.2's closing sentence, **archetype-branched** (per-visit / per-session / named payable stage). Was hardcoded until ace#1004 — see `skills/pdd-to-work-order/SKILL.md § Process` step 5 for the per-archetype wording. |
| `{{raci_N_responsibility}}`, `{{raci_N_dimagi}}`, `{{raci_N_partner}}` (N=1..11) | Archetype-derived RACI |
| `{{permissions_body}}` ★ | Newline-separated required permissions (one bullet per line) |
| `{{ethics_body}}` | Ethics paragraph (prose; template defaults + PDD scope) |
| `{{data_project_overview}}`, `{{data_subjects}}`, `{{data_personal_info}}`, `{{data_purpose}}`, `{{data_security}}`, `{{data_partner_measures}}`, `{{data_storage_location}}`, `{{data_protection}}` | Per-field cells (templated defaults + PDD's data-subject treatment) |
| `{{partner_signatory_name}}`, `{{partner_signatory_title}}`, `{{partner_address}}` | Signature block left cell |
| `{{pdd_link}}` | `phases.design.products.pdd.file_id` Drive URL |
| `{{annexure_b_placeholder}}` | "To be provided" if no opp-specific annexure |

★ Bulleted-region body tokens — value is a `\n`-separated list of bullet items; the skill must call `docs_finalize_bullets(documentId)` after `docs_copy_template` to apply real bullet styling and remove the `<<<BULLETS_*_START>>>` / `<<<BULLETS_*_END>>>` anchor paragraphs from the rendered doc.

Editing the template adds or removes tokens — make sure the skill's `## Process` step 5 lists every token the template uses, and keep table cells single-token (no multi-line into one cell — use a multi-row table or a bulleted region instead).
