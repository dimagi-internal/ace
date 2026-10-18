# Connect Labs supply chain: platform reference

How labs' `supply_chain_*` surface behaves, organised by resource: programme, registry,
sourcing, contract, logistics, finance, stock, checks, partner access. It is general platform
reference for any programme, built by ACE or not. The ACE procedures that drive it are the
supply-chain skills (`skills/supply-chain-setup`, and `-procure`, `-fulfil`, `-operate` as
they land).

Every fact here comes from the live tool descriptions, loaded on 2026-10-18 with
`ToolSearch "select:mcp__connect_labs__supply_chain_<atom>"`, or from the connect-labs source
where named. Labs is served upstream, so its schemas are **not** in `docs/atom-schemas.md`.
Load the live schema before relying on a field; when it disagrees with this page, the schema
wins. Fix this page in the same change.

## Rules every write follows

- **`program_id` scopes everything**: tenders, quotes, awards, and also the commodity, item
  and supplier registries. It is "required in practice": a read without it refuses rather than
  guess a scope. `organization_id` is carried as context only and does **not** select a
  registry. Its own description warns that the old advice to pass it made `commodity_list` and
  `supplier_list` come back empty.
- **The top-level `source` block is the evidence**: `{ref, sender?, sent_on?, excerpt?}`.
  - The same `ref` with the same payload **replays the first result**, so a deterministic ref
    makes a re-run idempotent with no read-first.
  - The same `ref` with a different payload is a second, separate write. One email quoting two
    products is two writes that share a ref.
  - ACE builds refs only with `buildSource` / `buildSourceRef` (`lib/supply-chain-ref.ts`):
    `ace:<run-or-program-scope>:<skill>:<step>:<stable-key>`. Never put a timestamp in the key,
    or a resume writes everything twice.
  - `sent_on` is the day the evidence itself is dated, not the day it was recorded. Labs shows
    both.
- **`data.source` is a different field: who told you.** Its enum is `we_recorded`,
  `partner_reported`, `supplier_reported`, `forwarder_reported`, `commcare_form`,
  `connect_visit` or `document`, and contracts, receipts, invoices, payments, supply points,
  stock counts, distributions and movements require it. Do not confuse it with the evidence
  block.
- **Money is a decimal string**, e.g. `"12.50"`, never a JSON number ("money is Decimal, never
  float"). Use `money()` / `moneyFromMinor()` from `lib/supply-chain-ref.ts`.
- **Record what the counterparty stated; never compute it.** `quote_record`: "Do NOT compute
  anything: leave `freight_basis` and `duties_basis` `not_specified`, and `pack_spec_source`
  `not_stated`, where the supplier was silent". The comparison then reports that honestly (see
  Sourcing).
- **Event dates are inputs**, so they can be backdated: `received_on`, `decided_on`,
  `signed_on`, `dispatched_on`, `expected_on`, `issued_on`, `paid_on`, `confirmed_on`,
  `counted_on`, `distributed_on`, `occurred_on`, `disputed_on`. A simulation runs on a
  backdated calendar this way (spec 2026-10-18 § G); there is no clock to move. Whether a date
  may predate the programme's own creation is an open residual (spec § K5).

## Programme: who runs it

One organisation **runs** each programme's supply chain: its people tender, award, order, pay
and receive, and it is "us" on the programme's pages. `supply_chain_programme_runner_get`
returns `{org_id, org_name, your_standing}`, and `org_id: null` means nobody has declared one.

| Standing | Who | Can |
|---|---|---|
| `programme` | a member of the running org | everything |
| `operator` | platform support (the Django staff bit, never an email domain) | acts for the running org; the write log keeps who it was |
| `partner` | anyone else who holds the programme | read, and write only through an update link |

- **Membership** is a grant, never visibility (connect-labs `supply_chain/runner/__init__.py`):
  - **Dimagi** (labs org slug `dimagi`) counts every `@dimagi.com`, `@dimagi-ai.com` and
    `@dimagi-associate.com` address as a member. ace@ is therefore `programme` wherever Dimagi
    runs.
  - **A labs org bound to a Connect org** (`connect_organization_id`) counts that Connect org's
    members.
  - **A labs-only org's slug never counts**, because anyone able to register a synthetic opp can
    name one.
- **Declaring.** Until 2026-10-18 `supply_chain_programme_runner_set` was "Platform support
  only", and ACE read `programme_runner_get(program_id=353)` → `{org_id: null, your_standing: "partner"}`.
  connect-labs PR #2605 (merged 2026-10-18; check it is deployed before relying on it) made it
  self-serve:
  - **On an undeclared programme**, a member of the programme's **Connect managing org** may
    declare: that managing org, Dimagi, an org delivering an opportunity in the programme, or an
    org **awarded a call** for the programme (the winning LLO).
  - **Changing an existing runner** is for the runner's own members/admins, or support.
  - **Once an org runs a programme its LabsOrg row becomes support-edit-only.** Get its
    `supply_chain_org_upsert` (name, `connect_organization_id`, `connect_organization_slug`)
    right BEFORE declaring it.
  - **Members of a declared runner hold the programme**, so an awarded LLO's people can open it.
  - Every supply write (registry upserts, the tender lifecycle, quotes, awards, contracts,
    shipments, receipts, invoices, payments, update links) goes through one programme-standing
    check.
  The sequence is `supply_chain_org_upsert({data: {slug, name, connect_organization_id, connect_organization_slug}})`
  → `supply_chain_programme_runner_set({program_id, org_id: <labs id>})` → expect
  `your_standing: "programme"`. `supply-chain-setup` Step 1 classifies any refusal
  (`classifyRunnerRefusal`, `lib/supply-chain-runner.ts`) and still halts on the old
  support-only text, which is what an undeployed labs returns.
- **Declaring revokes every live update link issued to the declared org** in that programme
  (`revoke_links_to_runner`). The setter also refuses a non-Dimagi runner on a labs-only
  programme that is open to every email domain, because that org's quotes and prices would
  become readable by everyone. Set the programme's allowed domains first
  (`synthetic_set_allowed_domains`).
- **Never move an existing runner.** Every record is attributed to it, and none of them can be
  deleted (§ What cannot be undone).
- **The team.** `supply_chain_programme_team_list` / `_add` / `_remove`. "Platform support, or
  an existing admin of that organisation, only"; since connect-labs #2605, also the Connect
  members of a Connect-known runner. The person must have signed in to labs once;
  the last admin cannot be removed. **A Dimagi-run programme has no team list:**
  `programme_team_list` refuses with "Dimagi's team is everyone with a Dimagi address; it is not
  kept as a list" (live, program 10602, 2026-10-18).

## Registry

| Record | Atoms | Scope | Facts |
|---|---|---|---|
| Organisation | `supply_chain_org_upsert` / `_list` / `_merge` | **labs-wide**: the same body wherever it appears | Keyed by slug. Bind with `connect_organization_id` so its Connect members are its labs members. Merging is refused across different Connect orgs; staff, or an admin of both orgs, may merge. |
| Commodity (the type) | `supply_chain_commodity_upsert` / `_list` | programme | Keyed by slug. `category` is a closed, health-shaped enum (`therapeutic_food` … `equipment`, `consumable`); map a non-health good to the nearest honest value and say so. `course_definition` unlocks per-course costing. |
| Trade item (a branded product) | `supply_chain_item_upsert` / `_list` / `_get` | programme | Keyed by sku. Give `base_per_pack` and `base_unit_grams` "as the manufacturer states them". A GTIN is checked against its GS1 digit and a bad one is refused. `stock_class` is `consumable` or `durable`. |
| Supply point | `supply_chain_supply_point_upsert` / `_list` / `_get` | programme | Keyed by slug. `kind` is one of `central_store`, `regional_store`, `facility`, `user_held`, `supplier_site`, `in_transit` or `customs`. A `user_held` point must name the worker (`connect_username`). `parent_supply_point_id` builds the network. `min_` / `max_months_of_stock` are decimal strings. |
| Supplier | `supply_chain_supplier_create` / `_update` / `_get` / `_list` / `_mark_reviewed` | the **company** is shared across programmes; `status` and `notes` are this programme's | Read `_list` first; adding a company already supplying the programme returns it. Company facts edited through `_update` change it everywhere, and a company Connect names cannot be renamed. Status runs `identified` → `contacted` → `responsive` → `quoting` → `awarded` (or `declined` / `unusable`). |

## Sourcing: tender → quotes → award

1. **`supply_chain_tender_create`** makes a draft. It needs `lines` (`commodity_slug`,
   `quantity`, `quantity_unit`) and either `delivery_points` or `pickup_accepted: true` before it
   can open. `visibility` is `public` or `private`.
2. **`supply_chain_tender_invite_org`** adds a supplier org to a restricted tender. Only orgs
   registered as suppliers can be invited.
3. **`supply_chain_tender_open`** is refused unless a delivery place or collection is named
   ("suppliers will not quote without knowing where the goods go").
4. **`supply_chain_quote_record`** records the quote as stated, with its `quantity_basis`.
   - Give `received_on` as the day the supplier's email was sent, and `supplier_reference` when
     there is one.
   - **It is refused when the supplier already has a live quote** for that product on that
     tender by the same delivery option ("a forwarded copy is not a second offer"). A genuine
     second offer names the one it sits beside in `distinct_from_quote_ids`.
   - **A revised offer is `supply_chain_quote_correct`**, which needs a reason and supersedes the
     quote; the original stays readable.
   - **`supply_chain_quote_void`** removes a duplicate or mis-entry from comparisons (it stays
     readable).
5. **`supply_chain_tender_compare`** works per commodity. It reports `rankable: false` with
   `blocked_by` naming the suppliers whose quotes are unconfirmed: "the honest answer to 'who is
   cheapest' is often 'not yet, ask these questions'". Resolve it with a `quote_correct` that
   cites the supplier's clarification as its evidence.
6. **`supply_chain_award_create`** needs a `rationale` and **freezes the comparison** as it stood
   at the decision, along with what was still open (days to deadline, silent suppliers, replies
   owed). An award before the deadline is allowed. Once every line of a draft or open tender has
   an award, the tender becomes `awarded`.
7. **`supply_chain_tender_close`** closes it to further quotes.

Reads: `supply_chain_tender_get` / `_list`, `supply_chain_quote_list` (includes voided and
superseded versions) and `supply_chain_award_list` (each award with its frozen snapshot).

## Contract (purchase order)

An award is a decision; a contract is a commitment. They are separate "because the organisation
that decides is often not the one that buys".

- **`supply_chain_contract_create`** requires `commodity_slug`, `supplier_id`, `buyer_of_record`,
  `buyer_org_id` and `source`. `buyer_of_record` (`programme_org`, `partner_org` or `agency`)
  "has no default: import duty and VAT depend on who imports". ACE derives it from the runner
  (`buyerOfRecord`, `lib/supply-chain-runner.ts`).
- `consideration` is `priced` (the default, and the only kind that takes a `unit_price`),
  `in_kind`, or `bundled`. `payment_terms` is `on_delivery` or `advance`. Link the decision with
  `award_id` / `tender_id`.
- **`duty_relief_claimed`** only alongside a `duty_exemption` document
  (`supply_chain_document_attach`).
- **`supply_chain_contract_landed_cost`** gives the all-in cost under the stated buyer. A relief
  with no exemption document comes back unconfirmed, not zero; `compare_buyers` costs it under
  all three.
- **`supply_chain_contract_match`** is the three-way match: ordered, received and invoiced, and
  `payable_now`, which is the value of what actually **arrived**. It is computed and never
  stored.
- **`supply_chain_contract_holds`** lists what the order is waiting on us for.
- Reads: `supply_chain_contract_get` / `_list`.

## Logistics

- **`supply_chain_shipment_record`** records a supplier's dispatch, with batch and expiry per
  line. **It posts nothing to stock**: goods in transit are real, but they are not cover.
- **`supply_chain_receipt_record`** is the goods received note, and **the event that creates
  stock**. Each accepted line posts a movement; a rejected quantity stays on the line and never
  enters the ledger.
- **`supply_chain_consignment_dispatch` / `_receive`** move stock between our own places (use
  `shipment_record` for goods from a supplier). The sender's stock drops at dispatch, and the
  destination counts it only at receipt. Received short, the difference is written off as a loss
  naming the consignment.
- Reads: `supply_chain_shipment_list`, `supply_chain_receipt_list`,
  `supply_chain_consignment_list`.

## Finance

- **`supply_chain_invoice_record`**: give `quantity_billed`, because an invoice for more than
  arrived "is the single most common discrepancy, and the only thing that catches it" is the
  three-way match. Give `unit_price` and `freight_amount` as billed, so a bill above the contract
  is flagged. Name advances it acknowledges in `acknowledges_payment_ids`.
- **`supply_chain_invoice_dispute`** marks the invoice `queried` and keeps the reason. **Nothing
  is sent to the supplier.**
- **`supply_chain_payment_record`** pays against an `invoice_id`, or against a `contract_id` as
  an advance before any invoice exists. An invoice's status follows from what has been paid; it
  is never asserted.
- **`supply_chain_payment_confirm`** records that the payee confirmed receipt. Until then, a
  payment older than a fortnight shows in `checks_list` as `payment_unconfirmed`.
- Reads: `supply_chain_invoice_list`, `supply_chain_payment_list`.

## Stock and distribution

| Question | Atom | Note |
|---|---|---|
| What is at this point? | `supply_chain_stock_on_hand` | Gives both the ledger balance and the last count; "the disagreement is the finding". `as_of` reads a past day. |
| On hand vs in transit vs committed vs available | `supply_chain_stock_position` | "In-transit stock is real but it is NOT cover." |
| When does each place run dry? | `supply_chain_stock_forecast` | Week by week, every assumption under `basis`. `as_of` reads a past day. |
| How much to send? | `supply_chain_resupply_plan` | AMC, months of stock, reorder point. A window under 7 days is refused as unconfirmed. |
| What each worker holds | `supply_chain_worker_stock` | One row per worker, never ranked. `as_of` reads a past day. |
| Where an item went | `supply_chain_stock_flow` | Arrivals → stores → workers → dispensed, week by week. |
| The network for one item | `supply_chain_network_tree` | Subtree figures per store. |

Writes:
- **`supply_chain_distribution_record`**: a resupply run out to workers, one line per worker.
- **`supply_chain_stock_count_record`**: `self_reported`, `physical_count`, or `override` (which
  posts the difference as an adjustment and needs a reason). **A zero is a real observation: it
  is a stockout.**
- **`supply_chain_movement_record`**: a single ledger posting (transfer, loss, expiry write-off).
  Use the receipt and distribution atoms for those events instead.

## Checks and summaries

- **`supply_chain_checks_list`**: every finding is `missing` (a fact nobody supplied),
  `conflict` (two records disagree) or `threshold` (a derived figure past a bound), each with an
  `audience`. "Deliberately unranked and unworded." Run it after every stage; a supply-chain
  `-qa` verdict reads it. The live reply (program 10602, 2026-10-18) carries the whole kind
  vocabulary with each kind's category under `kinds`, plus `by_kind` / `by_category` counts, and
  writes the description's "internal" audience as `ours`. The conflict kinds:
  - `award_not_contracted`
  - `invoice_over_billed`, `invoice_above_contract`
  - `stock_variance`, `stock_negative`
  - `shipment_quantity_unaccounted`
- **`supply_chain_chain_summary`**: stage counts (source, order, deliver). These are states, not
  gaps. Quantities appear only with `commodity_slug`.

## Partner access

**`supply_chain_update_link_issue`** gives one organisation with no labs login a signed,
expiring, revocable URL.
- It can confirm orders and payments, record dispatches and receipts, and record counts and
  releases, for exactly the listed contracts and supply points, or for everything involving that
  org with `coverage: "organisation"`.
- Actions stay role-appropriate: only the order's supplier can confirm or dispatch it.
- **The raw token is in that response only.** `supply_chain_update_link_list` never shows it.
- `supply_chain_update_link_revoke` is immediate and cannot be re-enabled; what was recorded
  through the link stays.

Evidence files: `supply_chain_document_attach`, either `content_base64` (12 MB cap) or
`external_url`, never both.

## What cannot be undone

Labs has **no delete** for tenders, quotes, awards, contracts, shipments, receipts, invoices or
payments. What exists:

| Removal | Atom | Effect |
|---|---|---|
| Void a quote | `supply_chain_quote_void` | stays readable, drops out of comparisons |
| Revoke an update link | `supply_chain_update_link_revoke` | stops at once; records stay |
| Delete an outreach (invitation) recorded in error | `supply_chain_outreach_delete` | removes the row, reason logged |
| Merge two org rows that are one org | `supply_chain_org_merge` | references move, old slug kept as alias |

So **the isolation is the programme itself.** Run a simulation only in a programme ACE owns, and
label every invented name and excerpt "simulated" (`syntheticName`, `buildSource({simulated: true})`).
`sweep-labs` can list these records for audit; it cannot delete them.

## Change Log

| Date | Change |
|---|---|
| 2026-10-18 | Initial reference, from the live schemas (optional-track PR6) |
| 2026-10-18 | Runner declaration is self-serve per connect-labs #2605 (who may declare, LabsOrg frozen once it runs, members hold the programme); a live award to a non-cheapest quote with a stated reason (program 10605 award 95) is the procure control (optional-track PR7) |
