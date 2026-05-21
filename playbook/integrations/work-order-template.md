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

- `BULLETS_SCOPE_WILL` — §2 "the Partner will" bullets
- `BULLETS_SCOPE_WILL_NOT` — §2 "the Partner will not" bullets
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
| `{{background_body}}` | PDD Problem Statement + Intervention Design |
| `{{scope_intro}}` | One-sentence framing of the work (archetype-branched) |
| `{{scope_will_body}}` ★ | Newline-separated "the Partner will" bullet items |
| `{{scope_will_not_body}}` ★ | Newline-separated "the Partner will not" bullet items |
| `{{geographic_coverage_body}}` | PDD Target Population |
| `{{primary_deliverable_body}}` | PDD Success Metrics |
| `{{verified_unit_body}}` ★ | Newline-separated verified-unit criteria (one bullet per line) |
| `{{verified_unit_closing}}` | Closing paragraph after the verified-unit bullets |
| `{{reporting_body}}` ★ | Newline-separated reporting deliverables |
| `{{week_N_dates}}`, `{{week_N_activities}}` (N=1..8) | PDD Timeline per-week rows |
| `{{wo_total_not_to_exceed_usd}}` | `wo-total-not-to-exceed-usd` decision |
| `{{wo_mobilization_advance_pct}}`, `{{wo_mobilization_amount}}`, `{{wo_mobilization_trigger}}`, `{{wo_mobilization_timing}}` | Payment milestone 1 (from `wo-payment-schedule-split` + `wo-mobilization-advance-pct`) |
| `{{wo_reconciliation_pct}}`, `{{wo_reconciliation_amount}}`, `{{wo_reconciliation_trigger}}`, `{{wo_reconciliation_timing}}` | Payment milestone 2 |
| `{{raci_N_responsibility}}`, `{{raci_N_dimagi}}`, `{{raci_N_partner}}` (N=1..11) | Archetype-derived RACI |
| `{{permissions_body}}` ★ | Newline-separated required permissions (one bullet per line) |
| `{{ethics_body}}` | Ethics paragraph (prose; template defaults + PDD scope) |
| `{{data_project_overview}}`, `{{data_subjects}}`, `{{data_personal_info}}`, `{{data_purpose}}`, `{{data_security}}`, `{{data_partner_measures}}`, `{{data_storage_location}}`, `{{data_protection}}` | Per-field cells (templated defaults + PDD's data-subject treatment) |
| `{{partner_signatory_name}}`, `{{partner_signatory_title}}`, `{{partner_address}}` | Signature block left cell |
| `{{pdd_link}}` | `phases.design.products.pdd.file_id` Drive URL |
| `{{annexure_b_placeholder}}` | "To be provided" if no opp-specific annexure |

★ Bulleted-region body tokens — value is a `\n`-separated list of bullet items; the skill must call `docs_finalize_bullets(documentId)` after `docs_copy_template` to apply real bullet styling and remove the `<<<BULLETS_*_START>>>` / `<<<BULLETS_*_END>>>` anchor paragraphs from the rendered doc.

Editing the template adds or removes tokens — make sure the skill's `## Process` step 5 lists every token the template uses, and keep table cells single-token (no multi-line into one cell — use a multi-row table or a bulleted region instead).
