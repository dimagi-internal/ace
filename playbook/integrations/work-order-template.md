# Work-Order Template — Bootstrap

The `pdd-to-work-order` skill renders Work Orders by copying a Google Doc template and replacing `{{...}}` tokens. The template is per-deployment Drive state, not committed to the repo. This page documents how to provision it.

## One-time bootstrap

```bash
# Ensure ACE_TEMPLATES_FOLDER_ID is set (the Drive folder where ACE keeps its templates)
ACE_TEMPLATES_FOLDER_ID=<folder id> npx tsx scripts/bootstrap-work-order-template.ts
```

The script:
1. Reads `templates/work-order-template.md` (canonical content).
2. Uploads it to Drive as a Google Doc named "ACE Work Order Template".
3. Prints the resulting file_id to stdout.

Record the file_id in 1Password at `AI-Agents/ACE - Open Chat Studio/Config/work_order_template_id`, then re-run `op inject -i .env.tpl -o $CLAUDE_PLUGIN_DATA/.env --force` (or `/ace:setup --force-env`).

## Refresh

To replace an existing template with the latest `templates/work-order-template.md`:

```bash
ACE_TEMPLATES_FOLDER_ID=<folder id> WORK_ORDER_BOOTSTRAP_FORCE=1 \
  npx tsx scripts/bootstrap-work-order-template.ts
```

The old template is trashed (recoverable for 30 days in Drive) and a new one is created. Record the new file_id in 1Password.

## Token contract

The skill replaces these `{{...}}` tokens in the template:

| Token | Source |
|---|---|
| `{{wo_number}}` | `wo-number` decision (placeholder if open) |
| `{{opp_title}}` | PDD H1 |
| `{{wo_date}}` | today (ISO) |
| `{{wo_period_of_performance}}` | `wo-period-of-performance` decision |
| `{{background_body}}` | PDD Problem Statement + Intervention Design |
| `{{scope_body}}` | Archetype-branched |
| `{{geographic_coverage_body}}` | PDD Target Population |
| `{{primary_deliverable_body}}` | PDD Success Metrics + Evidence Model |
| `{{verified_unit_body}}` | PDD Evidence Model Layer A |
| `{{reporting_body}}` | `wo-reporting-cadence` |
| `{{timeline_table}}` | PDD Timeline |
| `{{wo_total_not_to_exceed_usd}}` | `wo-total-not-to-exceed-usd` decision |
| `{{payment_schedule_table}}` | `wo-payment-schedule-split` + `wo-mobilization-advance-pct` |
| `{{roles_raci_table}}` | Archetype-derived |
| `{{permissions_body}}`, `{{ethics_body}}` | Template defaults + PDD scope |
| `{{data_handling_table}}` | Template defaults + PDD data-subject treatment |
| `{{pdd_link}}` | `phases.design.products.pdd.file_id` URL |
| `{{annexure_b_placeholder}}` | "To be provided" if no opp-specific annexure |

Editing the template adds or removes tokens — make sure the skill's `## Process step 5` lists every token the template uses.
