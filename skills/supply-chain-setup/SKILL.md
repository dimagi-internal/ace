---
name: supply-chain-setup
description: >
  Set up a labs programme's supply chain: who runs it, the team, commodities, items, stores and
  suppliers. Needs a program id.
---

# Supply-chain setup

Prepares a labs programme so procurement can happen in it. It settles who runs the programme's
supply chain, puts ace@ on that org's team, and builds the registry: commodities, trade items,
supply points (a central store, a regional store, one point per field worker) and suppliers.
`supply-chain-procure` (tenders → contract), `supply-chain-fulfil` (shipments → payments) and
`supply-chain-operate` (stock, per week) build on what this writes.

Platform reference: [`playbook/integrations/connect-labs-supply-chain.md`](../../playbook/integrations/connect-labs-supply-chain.md).
In `/ace:run` this is the optional `supply_chain` step (spec
`docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § F2); it runs only in Phase 9
simulated mode.

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `program_id` | the labs programme (= the Connect program's integer id) | explicit arg; default: run_state `phases.connect-setup.products.connect.program.connect_int_id`, else `opp.yaml.connect.program.connect_int_id` |
| `pm_org` | the Connect org that manages the program | explicit arg; default: run_state `products.connect.pm_org_slug`, else `connect_orgs.pm_org` (`lib/connect-orgs.ts`) |
| `llo_org` | the ACE-owned winner org, on the `ace_winner` path only | explicit arg; default: run_state `phases.solicitation-management.products.selected_llo.org_slug` when `synthetic_winner: true`, else `connect_orgs.llo_org` |
| `ace_winner` | whether the winner runs procurement | explicit arg; default: `isOptionalStepEnabled(run_state, 'ace_winner')` (`lib/optional-steps.ts`) |
| `commodity_needs` | what the programme distributes, with quantities | explicit arg (a list of `{commodity, unit, quantity, basis}`); default: derived in Step 2 from the PDD (run_state `phases.idea-to-design.products.pdd`) |
| `flw_usernames` | the field workers who will hold stock | explicit arg; default: the synthetic FLWs of run_state `phases.execution-management.products.simulation.synthetic_opportunity_id` (`synthetic_local_records_count` / the generation manifest); outside simulation, the opportunity's workers |
| `scope` | the `source.ref` scope | the run id inside `/ace:run`; outside one, `programScope(program_id)` (`lib/supply-chain-ref.ts`) |
| `simulated` | label every write as simulated and backdate it | `true` when Phase 9 `mode: simulated`; explicit arg otherwise |
| `sim_week0_start` | the Monday every setup write is dated in | run_state `products.simulation.calendar.weeks[0].start` (`lib/sim-calendar.ts`, PR10); explicit arg otherwise |

No `run_state.yaml` is needed when every parameter is passed. Run-state write-back (Step 9) happens
only when a run is bound.

## Products

- `9-execution-manager/supply-chain-setup_manifest.yaml`: what this run means to create, written in
  Step 3 **before any write** (runner choice, orgs, commodities, items, supply points, suppliers,
  quantities with their PDD citation). Outside a run, the same file in the program project folder.
- `9-execution-manager/supply-chain-setup_record.md`: the ids labs returned, the runner and
  standing as read back, and the labs page links for the programme.
- run_state `phases.execution-management.products.supply_chain` (inside a run): `program_id`,
  `runner {org_id, role, buyer_of_record, fallback_reason?}`, `labs_org_ids {pm, llo}`,
  `commodities`, `items`, `supply_points {central, regional, flw}`, `suppliers`. This skill is the
  block's first writer; later supply-chain skills add their own keys under it.

## Process

1. **Settle the runner** (spec § F1). Read
   `supply_chain_programme_runner_get({program_id})`. Then decide with `planRunner`
   (`lib/supply-chain-runner.ts`):
   - **Who:** on the `ace_winner` path, the winner's labs org (`llo_org`) runs the supply chain,
     because the owner's intent is that the winner procures. Otherwise the PM org runs it.
   - **No runner yet → declare one.** Register both orgs first (Step 4's upserts; run them now if
     they have not run), then call
     `supply_chain_programme_runner_set({program_id, org_id, note: "ACE <scope>: <role> runs procurement", source})`
     for each candidate in order:
     - accepted → stop;
     - refused, and `classifyRunnerRefusal(message)` is `not_eligible` → try the next candidate
       (the PM org). Record `fallback_reason` with the refusal text;
     - refused as `support_only` → **halt** with
       `[BLOCKER] program <id> has no running organisation and labs lets only platform support declare one. Needed: supply_chain_programme_runner_set({program_id: <id>, org_id: <labs org id>}) by labs platform support, or the self-serve declaration change in connect-labs (dispatched 2026-10-18).`
       This was the live state on 2026-10-18 (`programme_runner_get(program_id=353)` →
       `{org_id: null, your_standing: "partner"}`; the setter's own description reads "Platform
       support only"). Never work around it;
     - refused for any other reason → halt, quoting the message.
   - **A runner already exists → never move it.** Records already attributed to it cannot be
     deleted (§ F6). Proceed under it if ACE's standing is `programme` or `operator`; otherwise halt
     with the `planRunner` blocker text.
   - **Verify.** Re-read `programme_runner_get`. `your_standing` must be `programme` (or
     `operator`). Anything else halts. The contract buyer of record follows from the runner:
     `buyerOfRecord(role)` gives `programme_org` when the winner runs it and `partner_org` when the
     PM org does.
2. **Derive the commodity plan** (when `commodity_needs` was not passed). Read the PDD's
   distribution and payment sections. Each physical good a field worker hands out becomes one
   commodity, with the quantity the PDD states and the sentence it came from. Never invent a
   quantity: a need with no PDD number goes in the plan as `quantity: null, basis: "not stated"`,
   and `supply-chain-procure` will refuse to tender it.
   - **Categories.** `commodity_upsert.category` has a closed, health-shaped list. Map to the
     nearest honest one and say so in the plan: a durable device → `equipment`; a single-use kit →
     `consumable`. A missing category is an upstream ask to connect-labs, not a blocker.
   - **Stock class.** On `item_upsert`, a device is `stock_class: durable`; a kit used once is
     `consumable`.
   - *Example (Connect FI):* a basic feature handset (`equipment`, durable), given only to enrolled
     adults without a working phone, and a SIM starter kit (`consumable`). The PDD's enrolment
     targets cap the quantities.
3. **Write the plan** (Products, first file). Every later step writes what the plan says, and the
   QA reads the plan back against labs.
4. **Register the orgs.** `labs_context()` gives each Connect org's integer id; never guess it
   from a slug. For `pm_org`, and for `llo_org` on the winner path:
   `supply_chain_org_upsert({data: {slug, name, connect_organization_id, connect_organization_slug}, source})`.
   Binding by `connect_organization_id` is what makes ace@'s Connect membership count as
   membership of the labs org. Record each returned labs org id. The upsert is keyed by slug, so a
   re-run is a no-op (same call `solicitation-create` Step 5a makes). **Get the row right before
   Step 1 declares it:** once an org runs a programme its LabsOrg row is support-edit-only
   (connect-labs #2605), so a wrong name or Connect binding cannot be corrected afterwards.
5. **Team.** Skip this step when the runner is Dimagi (labs org slug `dimagi`): Dimagi's members
   are everyone with a Dimagi address, so ace@ is already one, and `programme_team_list` refuses
   with "Dimagi's team is everyone with a Dimagi address; it is not kept as a list" (live, program
   10602, 2026-10-18). For any other runner, read
   `supply_chain_programme_team_list({program_id})`. If ace@ (`config/agent.json` `email`) is not
   an `admin`, call `supply_chain_programme_team_add({program_id, email, role: "admin", source})`.
   The call needs platform support or an existing admin of the runner; on a runner ACE just
   declared, ace@ is the declarer, and a refusal here halts with the refusal quoted.
6. **Commodities and items.** Read `supply_chain_commodity_list` and `supply_chain_item_list`
   first (the registries are programme-scoped). Then `supply_chain_commodity_upsert({program_id, data, source})`
   per commodity and `supply_chain_item_upsert({program_id, data, source})` per trade item, keyed
   by slug / sku. Give `base_per_pack` as the (simulated) manufacturer states it. A GTIN is
   optional; if you give one it must pass its GS1 check digit, so never make one up.
7. **Supply points.** `supply_chain_supply_point_upsert({program_id, data, source})`, with
   `source: "we_recorded"` in `data`:
   - one `central_store`, `managed_by_org_id` = the runner's labs org id;
   - one `regional_store`, `parent_supply_point_id` = the central store;
   - one `user_held` point per field worker, `connect_username` = that worker,
     `parent_supply_point_id` = the regional store.
   Set `min_months_of_stock` / `max_months_of_stock` as decimal strings (`money()` in
   `lib/supply-chain-ref.ts`) when the PDD gives a resupply band; otherwise leave them unset.
8. **Suppliers.** Read `supply_chain_supplier_list` first to avoid duplicates. Then
   `supply_chain_supplier_create({program_id, data: {name, type, country, status: "identified"}, source})`
   for each supplier in the plan. On the simulated track every supplier is invented, so every name
   goes through `syntheticName()` and must not be a real company's name. A supplier is a company
   shared across programmes; a real name would attach ACE's invented quotes to it everywhere.
9. **Record.** Write the registry file (Products, second file), then, inside a run, the
   `products.supply_chain` block with `update_yaml_file` and `merge: 'deep'`.
10. **Hand to QA.** Dispatch `supply-chain-setup-qa`. Do not mark the step done on the write
    responses alone.

**Every write** carries `source = buildSource({scope, skill: "supply-chain-setup", step, key, sender: "ACE", sentOn, simulated, today})`
from `lib/supply-chain-ref.ts`. The ref is deterministic, so a re-run replays instead of writing
twice. On the simulated track `sentOn` is `simulatedDate(sim_week0_start, 0)`.

## MCP Tools Used

- connect-labs: `labs_context`, `supply_chain_programme_runner_get`, `supply_chain_programme_runner_set`,
  `supply_chain_org_upsert`, `supply_chain_org_list`, `supply_chain_programme_team_list`,
  `supply_chain_programme_team_add`, `supply_chain_commodity_list`, `supply_chain_commodity_upsert`,
  `supply_chain_item_list`, `supply_chain_item_upsert`, `supply_chain_supply_point_list`,
  `supply_chain_supply_point_upsert`, `supply_chain_supplier_list`, `supply_chain_supplier_create`
- ace-gdrive: `drive_create_file` (plan + registry), `update_yaml_file` (run write-back only)

## Existing objects

- **The runner is never moved** once declared (Step 1). Every tender, award, contract and payment
  is attributed to it and none of them can be deleted.
- **Organisations and suppliers are labs-wide**, not per programme. Upserting an org or creating a
  supplier changes a row other programmes may also use. Bind real orgs only to the Connect org
  they are; name invented suppliers with the `[Synthetic]` marker.
- **The commodity, item and supply-point registries are programme-scoped**, and upserts are keyed
  by slug / sku. Re-running on a programme that already has them updates in place.
- **Never run this against a programme ACE does not own.** The records it starts cannot be
  removed (spec § F6).

## Mode Behavior

- **Auto:** runs Steps 1-10. Every halt in Step 1 is final for the run.
- **Review:** shows the Step 3 plan and waits before Step 4.

## Dry-Run Behavior

When `--dry-run` is active, run Step 1's read (not the setter), Steps 2-3, and the read-first
`*_list` calls. Write the plan. Make no `supply_chain_*` write.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial version (optional-track PR6): runner gate with self-serve declaration and winner-runs-procurement, registry build, deterministic source refs | ACE |
