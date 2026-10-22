---
name: supply-chain-procure
description: >
  Run a labs programme's tender through quotes, award and contract. Needs a program id with supply-chain setup done.
---

# Supply-chain procure

Takes a programme whose registry `supply-chain-setup` built and buys what the plan says it needs:
one tender, quotes recorded as the suppliers stated them, labs' comparison, one award per line with
a rationale, the tender closed, and one contract per award. `supply-chain-fulfil` then moves the
goods and the money.

Platform reference: [`playbook/integrations/connect-labs-supply-chain.md`](../../playbook/integrations/connect-labs-supply-chain.md)
§ Sourcing and § Contract. In `/ace:run` this is part of the optional `supply_chain` step (spec
`docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § F3), and runs only in Phase 9
simulated mode, in week 0 of the backdated calendar.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme | explicit arg; default: run_state `phases.execution-management.products.supply_chain.program_id` |
| `setup_plan` | commodities, quantities with their PDD citation, items, the central store, suppliers, runner | explicit arg (a file id or path); default: `9-execution-manager/supply-chain-setup_manifest.yaml` |
| `runner` | who buys: `{org_id, role, buyer_of_record}` | explicit arg; default: run_state `products.supply_chain.runner` (written by setup Step 1) |
| `quote_spread` | the invented offers to record, on the simulated track | explicit arg; default: built in Step 2 |
| `scope` | the `source.ref` scope | the run id inside `/ace:run`; outside one, `programScope(program_id)` (`lib/supply-chain-ref.ts`) |
| `simulated` | label every write as simulated and backdate it | `true` when Phase 9 `mode: simulated`; explicit arg otherwise |
| `sim_week0_start` | the Monday procurement is dated in | run_state `products.simulation.calendar.weeks[0].start` (`lib/sim-calendar.ts`, PR10); explicit arg otherwise |

No `run_state.yaml` is needed when every parameter is passed. Run-state write-back (Step 10)
happens only when a run is bound.

**Pipeline-only in one respect:** on the simulated track the quotes are invented (Step 2). Outside
a simulation this skill records quotes that real suppliers sent, as they stated them, and Step 2
does not apply.

## Products

- `9-execution-manager/supply-chain-procure_plan.yaml`: the tender lines, the invited suppliers and
  the quote spread, written **before any write**.
- `9-execution-manager/supply-chain-procure_record.md`: tender, quote, award and contract ids, each
  award's rationale, the comparison as labs froze it, and the labs page links.
- run_state `phases.execution-management.products.supply_chain` (inside a run): adds `tender_id`,
  `quote_ids`, `award_ids`, `contract_ids` under the block setup created.

## Process

1. **Precondition.** Read `supply_chain_programme_runner_get({program_id})`. `your_standing` must
   be `programme` (or `operator`). Anything else halts: tenders, awards and contracts are
   programme-only writes, and `supply-chain-setup` Step 1 is where standing is settled. Read
   `supply_chain_commodity_list`, `supply_chain_item_list`, `supply_chain_supply_point_list` and
   `supply_chain_supplier_list` and confirm every planned slug, sku, store and supplier is there.
   A missing one sends you back to setup, not forward.
2. **The quote spread** (simulated track only). For each commodity line, 3 or 4 offers from the
   setup plan's `[Synthetic]` suppliers, varied on what real offers vary on: price, lead time, MOQ,
   incoterm, and whether freight and duties are stated. At least one offer leaves freight or duties
   unstated, so the comparison has to report it (spec § F3 step 4). Prices must be plausible for the
   commodity and the country; the eval grades this. Write the spread into the plan.
   **Quantities come from the setup plan's PDD-cited needs only.** A line whose need is
   `quantity: null` is refused here, never filled in.
3. **Write the plan** (Products, first file).
4. **Tender.** `supply_chain_tender_create({program_id, data, source})` with `status: draft`,
   `visibility: private`, `lines` (`commodity_slug`, `quantity`, `quantity_unit`),
   `delivery_points` = the central store's place, `incoterm_requested`, `response_deadline`, and a
   one-paragraph `brief` stating the programme and the need. Then
   `supply_chain_tender_invite_org({program_id, tender_id, org_id})` per planned supplier org (only
   orgs registered as suppliers can be invited), then `supply_chain_tender_open`. It is refused
   without a delivery place.
5. **Quotes, as stated.** `supply_chain_quote_record({program_id, data, source})` per offer:
   - `received_on` = the day the (simulated) supplier email is dated, inside week 0;
   - every term the supplier stated, and **nothing computed**: where an offer is silent on freight
     or duties, `freight_basis` / `duties_basis` stay `not_specified`; where the pack spec is not
     stated, `pack_spec_source: not_stated`;
   - a quote naming a known trade item takes `item_id` with `pack_spec_source: trade_item_confirmed`;
   - **every quote not in USD takes `fx_rate_to_usd`.** It is an internal fact, not the
     supplier's: take it from the PDD budget's exchange rate and cite that in the `source`
     excerpt. Without it `supply_chain_tender_compare` ranks nothing: every column is
     `rankable: false`, `priced_count: 0`, each row blocked with "Quote is in UGX and no exchange
     rate was recorded" (live, labs programme 361 tender 363, ace#3262). If the PDD states no rate,
     halt and ask; never invent one;
   - **a "price plus freight" offer is one of two shapes.** Either one delivered price (`incoterm:
     DAP` with freight included in the unit price), or a non-delivered incoterm plus a tender
     freight estimate (`supply_chain_tender_set_import_estimates`). `incoterm: DAP` with
     `freight_basis: excluded` and a `freight_amount` is refused as unrankable: "its Incoterm DAP
     means freight included; adding it would charge for it twice" (ace#3262).
   It is refused when that supplier already has a live quote for the product on this tender by the
   same delivery option. A real second offer names its sibling in `distinct_from_quote_ids`. A
   revision is `supply_chain_quote_correct` with a reason, never a second record.
   After each quote, `supply_chain_supplier_update({supplier_id, data: {status: "quoting"}})`.
6. **Compare.** `supply_chain_tender_compare({program_id, tender_id, commodity_slug})` per line.
   If any column is `rankable: false`, `blocked_by` names the suppliers whose quotes are
   unconfirmed. Resolve each with `supply_chain_quote_correct` citing the supplier's (simulated)
   clarification as its `source`, then compare again. Never award on a comparison that is not
   rankable.
7. **Award.** `supply_chain_award_create({program_id, tender_id, quote_id, rationale, decided_on, decided_by, source})`
   per line, with `decided_on` inside week 0 and `decided_by: "ACE (simulated)"` on the simulated
   track. The rationale cites the comparison: the rank on its `ranked_by` column, and, when the
   chosen quote is not the cheapest, the reason in one sentence (the live example on labs program
   10605: "Only kit that reads the 2 mg/L dispenser dose", where the cheaper kit failed the item
   specification). Labs freezes the comparison into the award. Then
   `supply_chain_supplier_update({status: "awarded"})` for the winner.
8. **Close.** `supply_chain_tender_close`. Once every line has an award the tender already reads
   `awarded`; closing it stops further quotes.
9. **Contract.** `supply_chain_contract_create({program_id, data, source})` per award:
   `award_id`, `tender_id`, `commodity_slug`, `supplier_id`, `item_id`, `quantity` and
   `quantity_unit` from the tender line, `unit_price` and `unit_price_unit` exactly as the awarded
   quote stated them, `currency`, `incoterm`, `delivery_supply_point_id` = the central store,
   `promised_lead_time_days` = the quote's lead time, `consideration: priced`, `payment_terms`
   (`advance` for one contract on the simulated track, so `supply-chain-fulfil` exercises the
   advance path; `on_delivery` otherwise), `signed_on` inside week 0, `source: we_recorded`, and
   - `buyer_of_record` = `runner.buyer_of_record` (`buyerOfRecord(role)`,
     `lib/supply-chain-runner.ts`: `programme_org` when the winner runs the programme,
     `partner_org` when the PM org does, or when Dimagi runs a labs-only synthetic programme,
     role `other`);
   - `buyer_org_id` = the buying org's labs id (the runner's on the winner path; the winner's when
     the PM org or Dimagi runs it and buys for the winner, which is the simulated track since
     ace#3265).
   Read `supply_chain_contract_landed_cost({contract_id})` back into the record; a duty relief
   claimed with no exemption document comes back unconfirmed, so do not claim one.
10. **Record.** Write the record file, then, inside a run, the ids into `products.supply_chain`
    with `update_yaml_file` and `merge: 'deep'`. `award_ids` and `contract_ids` are arrays: resend
    the whole list (deep merge replaces arrays).
11. **Hand to QA**, then the eval. Dispatch `supply-chain-procure-qa`, then
    `supply-chain-procure-eval`. Do not mark the step done on the write responses alone.

**Every write** carries `source = buildSource({scope, skill: "supply-chain-procure", step, key, sender, sentOn, simulated, today})`
from `lib/supply-chain-ref.ts`, with `sender` the (synthetic) supplier for a quote and `"ACE"` for
the programme's own writes. The key is the record's natural key (`<commodity>:<supplier-slug>` for a
quote, `<commodity>` for an award or contract), so a re-run replays instead of writing twice.

## MCP Tools Used

- connect-labs: `supply_chain_programme_runner_get`, `supply_chain_commodity_list`,
  `supply_chain_item_list`, `supply_chain_supply_point_list`, `supply_chain_supplier_list`,
  `supply_chain_supplier_update`, `supply_chain_tender_create`, `supply_chain_tender_invite_org`,
  `supply_chain_tender_open`, `supply_chain_quote_record`, `supply_chain_quote_correct`,
  `supply_chain_tender_compare`, `supply_chain_award_create`, `supply_chain_tender_close`,
  `supply_chain_contract_create`, `supply_chain_contract_landed_cost`, `supply_chain_tender_get`
- ace-gdrive: `drive_create_file` (plan + record), `update_yaml_file` (run write-back only)

## Existing objects

- **Nothing here can be deleted** (spec § F6): not the tender, a quote, an award or a contract. A
  wrong quote is voided (`supply_chain_quote_void`, it stays readable) or corrected
  (`supply_chain_quote_correct`); a wrong contract is updated (`supply_chain_contract_update`),
  never re-created. Read the plan twice before Step 4.
- **An award freezes the comparison as it stood**, including what was still open. Awarding early
  is allowed and permanent.
- **Suppliers are companies shared across programmes.** `supplier_update` status and notes are this
  programme's own, but company facts change everywhere. Never put an invented quote against a real
  company's name.
- **Never run against a programme ACE does not own** (§ F6).

## Mode Behavior

- **Auto:** Steps 1-11.
- **Review:** shows the Step 3 plan (lines, spread, intended award) and waits before Step 4.

## Dry-Run Behavior

When `--dry-run` is active, run Step 1's reads and Steps 2-3. Write the plan. Make no
`supply_chain_*` write.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-20 | Step 5 records `fx_rate_to_usd` (from the PDD budget rate) on every non-USD quote, without which `tender_compare` ranks nothing, and names the two shapes labs accepts for "price plus freight" (DAP + freight excluded is refused as double-charging) (ace#3262) | ACE |
| 2026-10-18 | Initial version (optional-track PR7): tender → quotes as stated → compare → award with rationale → close → contract under the runner's buyer of record | ACE |
