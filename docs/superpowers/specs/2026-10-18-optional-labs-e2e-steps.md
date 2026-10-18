# Optional Labs end-to-end steps for `/ace:run` — design

**Status:** approved direction (owner, 2026-10-18); this spec turns it into a buildable contract.
**First user:** Connect Financial Inclusion (Connect FI), a new real program built by `/ace:run`.
**Plan:** `docs/superpowers/plans/2026-10-18-optional-labs-e2e-steps.md`.

## Owner decisions this spec implements

1. **The build path is `/ace:run`.** The new steps ride on a normal run. They are **optional and OFF by default**: a run that doesn't ask for them behaves exactly as today.
2. **Everything ACE creates for the simulation is non-public.** The solicitation is `is_public: false`. The fake responses, the winner and all supply-chain records sit behind that.
3. **ACE creates its own org to act as the winner.** No real LLO is awarded, emailed or onboarded.
4. **Public Google Forms are created for this run**, because that is how the team currently runs calls. The form is a separate optional step, never the run norm.
5. **The supply-chain work is new and gets its own skill family.**

## What the optional track does

```
Phase 8  solicitation-create  ──(visibility: private)──▶ labs solicitation (is_public:false)
         solicitation-google-form   [opt: google_form]   public Google Form mirroring the questions
         solicitation-seed-responses [opt: seed_responses] N synthetic responses via create_response
         solicitation-review        (existing; HITL; award to the ACE winner org)
Phase 9  (simulated mode only — the real-LLO guard stays)
         supply-chain-setup     [opt: supply_chain]   programme registry: commodities, items, supply points, suppliers
         supply-chain-procure   [opt: supply_chain]   tender → invite → open → quotes → compare → award → close → contract
         supply-chain-fulfil    [opt: supply_chain]   shipment → receipt → invoice → payment → confirm
         simulated-execution    [opt: simulate_weeks] 4 weekly cycles: synthetic visits + distribution + stock counts
                                                      + workflow_rebuild_history + a weekly review
           └─ supply-chain-operate (called per week)
```

## § A. How optional steps are declared and enabled

**A1. One declaration, persisted in the run.** `/ace:run` gains `--with <step>[,<step>…]`. The recognised names are: `private_solicitation`, `google_form`, `seed_responses`, `ace_winner`, `supply_chain` and `simulate_weeks[=N]`, plus the alias `labs_e2e`, which expands to all of them with `simulate_weeks=4`. Alternatively, `opp.yaml.optional_steps:` declares a standing per-opp default, which the operator writes and no skill mutates. At Pre-flight the orchestrator resolves the flags plus `opp.yaml` into **one top-level `run_state.yaml.optional_steps` block**, which is the only thing any downstream skill reads:

```yaml
optional_steps:
  resolved_at: 2026-10-18T14:02:00Z
  source: flag            # flag | opp.yaml | both
  private_solicitation: true
  google_form: true
  seed_responses: { count: 5 }
  ace_winner: true
  supply_chain: true
  simulate_weeks: 4
```

A resume reads the block and never re-resolves it. That keeps run independence intact: the steps are fixed at run start, and a later `opp.yaml` edit cannot change a run in flight. A missing block means every step is off. That is the default, and every existing run reads that way.

**A2. Implications are resolved, not left to skills.** The resolver is `lib/optional-steps.ts`, one pure function with tests:
- `seed_responses`, `ace_winner` and `supply_chain` each **force** `private_solicitation: true`. Fabricated responses must never sit on a listed call. This is a hard rule, not a default.
- `supply_chain` and `simulate_weeks` require `ace_winner`, because there is no real awardee to procure for.
- `google_form` does NOT imply `private_solicitation`: a private call can still have a public form.
- An unknown step name is a Pre-flight error.

**A3. Precedent.** This generalises the existing `--invite-candidates` opt-in (`skills/llo-invite`), which is OFF by default and threaded from the flag into the Phase 8 dispatch prompt. `--invite-candidates` stays as it is. It is **incompatible** with `seed_responses`: the resolver refuses both together, so real candidates are never invited to a call full of fabricated responses.

**A4. Manifest.** Every new artifact gets a `lib/artifact-manifest.ts` entry with `required: false`. The Phase boundary fence (`classify_phase_writeback`, `verify_phase_artifacts`) therefore never demands them on a run that didn't opt in. On a run that did opt in, each optional step's own `-qa` verdict is its gate. The phase summary lists each enabled step with its verdict and each disabled step as `skipped (not enabled)`.

## § B. Non-public solicitation (`private_solicitation`)

`solicitation-create` hardcodes `is_public: true` today (`skills/solicitation-create/SKILL.md:261`, `:856`). The change:

- Read `optional_steps.private_solicitation`. When it is true, publish with `is_public: false`.
- Prefix the description with the banner `> **[Demonstration — not a live call.]** Created by ACE to exercise the Labs workflow; responses are synthetic.`. This is the convention the Noora demo call (labs 1000001) used ad hoc; the change writes it down.
- The read-back (Step 7a, `:1075-1090`) already passes `program_id`, without which a private record reads as "not found". Keep it.
- **Every reader must also pass `program_id`.** That means `solicitation-monitor`, `solicitation-review`, `solicitation-seed-responses` and `sweep-labs`. The plan enumerates each call site.
- Record `visibility: private` in `products.solicitation`.

`solicitation-review`'s `award_response` call passes a retired `amount` argument. The live schema requires `response_id`, `reward_budget` and `org_id`, and **emails the awardee when labs email is on** (ace#3146). That is fixed in the same PR. The confirm prompt must then say an email may go out, and the award record must capture `awardee_notified`.

## § C. The ACE-owned winner org (`ace_winner`)

**What exists.** ACE already owns two Connect orgs, resolved only by `lib/connect-orgs.ts`: `pm_org` (`ace-pm-org`, labs id 386, which holds the build programs) and `nm_org` (`ace-nm-org`). No ACE atom creates a Connect organization (`grep -rn create_org mcp lib` returns no hits).

**Decision.** Add a third configured org, **`llo_org`**, read from the local-only `.env` key `ACE_CONNECT_LLO_ORG` and resolved by `lib/connect-orgs.ts` and nowhere else. It is the same rule as pm/nm, so `test/skills/no-hardcoded-connect-org.test.ts` covers it. It must be distinct from both `pm_org` and `nm_org`:
- **Not `nm_org`:** in Phase 4 the NM org holds the run's build/QA opportunity. Awarding the "partner" role to the same org would put a second opportunity under it, and every report that keys on the holding org would mix QA visits with simulated partner delivery.
- **Not `pm_org`:** labs refuses an award to a response from the call's own side (`award_response`: "never a response from their own side").

**Creating it.** This is a one-time step. The first version is an **operator step**: create the Connect org in the UI as ace@, then set `ACE_CONNECT_LLO_ORG`. `/ace:doctor --preflight` WARNs when `ace_winner` is requested but the key is unset. A later PR may add a `connect_create_organization` atom (HTTP-only, `page.request`). That PR must first probe Connect's org-create form live, as the "close the loop to the source of truth" rule requires. The atom is not on the critical path.

**Labs side.** `supply_chain_org_upsert({data: {slug, name, connect_organization_id, connect_organization_slug}})` registers `llo_org` as a labs org bound by Connect id. This is the same idempotent call `solicitation-create` Step 5a already makes for the PM org. The bound labs org is what:
- the winner's seeded response names, via `create_response.llo_entity_id = <labs slug>`;
- `award_response.org_id` names;
- `supply_chain_supplier_create` / `org_upsert` reference when the winner buys and receives.

**Must be verified live before shipping.** Which identifier `award_response.org_id` expects: the labs org slug, the labs id, or the Connect id. The schema says only "the organization ID of the winning respondent". The PR reads it from `get_response` on the seeded winner response and pins it in a test against the captured response. It must not guess.

**Phase 9 against it.** `llo-onboarding`'s real path (`connect_send_llo_invite`, then `connect_accept_program_application`, which must be accepted *by the invitee* per `assertAcceptingForSelf`) works for `llo_org` because ace@ is a member of it. **It still does not run in simulated mode.** The simulation records the award and procures against the labs org; it does not stand up a partner opportunity. Turning on real onboarding for `llo_org` is a later, separate decision, because it lifts the Phase 9 "not yet live" guard.

## § D. Synthetic responses (`seed_responses`)

New skill **`solicitation-seed-responses`** (+ `-qa`).

- **Inputs (parameters, per the new Inputs contract):**
  - `solicitation_id`, `labs_program_id`, `count` (default 5);
  - the solicitation's `questions[]` and `evaluation_criteria[]`, read live with `get_solicitation`;
  - the PDD, for grounding;
  - `llo_org` (the winner).
  - When run inside `/ace:run`, each is resolved from run_state; outside a run they are passed explicitly.
- **Composes `count - 1` fictional respondents plus the ACE winner.** Each respondent is a persona with a deliberately different profile on the call's criteria: geography fit, scale, prior Connect delivery, budget realism. Then:
  - Each persona answers every question in its own voice, grounded only in what the PDD and the call ask for (§ No inferred backstory).
  - The answers are spread so the review has something to rank: one strong, one weak, one with a missing required answer, one over budget.
- **Hard rules** (enforced by `lib/synthetic-responses.ts`, which validates the payload before any write):
  - Every fictional org name carries a `[Synthetic]` suffix.
  - No fictional name may match a real organization: it is checked case-insensitively against the LLO Directory and against `labs_context` org names. **Real partners such as Spark Microgrants, Trickle Up or KADSIPA must never be impersonated.**
  - `submitted_by_email` is ACE's own mailbox (`ace@dimagi-ai.com`) with a `+synthetic-<n>` tag, never a made-up third-party address.
  - **Partner-facing confidentiality carries over.** The opportunity's `inputs/` can name parties that must never appear in anything LLO-facing. For Connect FI that is the funder named in the source notes. The solicitation, the form and every seeded answer are LLO-facing text, so the skill reads those constraints from the operator brief and the PDD and refuses a payload that names such a party. `lib/synthetic-responses.ts` takes them as a deny list.
- **Writes:** `create_response({solicitation_id, org_name, responses, submitted_by_name, submitted_by_email, submission_date, status: 'submitted'})`. Its schema says this works on the caller's own call ("entered on the firm's behalf, any named organisation, deadline ignored"). The winner's response uses `llo_entity_id: <llo_org labs slug>` instead of `org_name`, so the response is bound to a real labs org and can be awarded. `submission_date` is spread across the open window.
- **Idempotency:** `create_response` has no `source.ref`. The skill checks `list_responses` first, matches on `org_name`/`llo_entity_id`, and skips a respondent that already exists. That is a cost-skip and is safe, because QA re-reads.
- **Artifact:** `8-solicitation-management/solicitation-seed-responses_roster.md`. It lists each persona, the profile it was built to exercise, its response id, and which one is the winner.
- **QA (`-qa`), static:**
  - the response count matches;
  - every required question is answered except in the deliberate "missing" case;
  - the winner response is bound to `llo_org`;
  - no name collides with a real org;
  - the solicitation is still `is_public: false`.
- **No eval.** `solicitation-review-eval` already grades the ranking that consumes these.

**Award stays a human decision.** `solicitation-review`'s HITL gate is unchanged. The operator approves the award at level 0, even though ACE built the winner. The review should rank the winner first on the merits; if it doesn't, the roster's intended profile is wrong, and that is a finding.

## § E. Public Google Form (`google_form`)

**What exists.** One read-only atom, `get_google_form_definition`, using the scope `forms.body.readonly` (`mcp/google-drive-server.ts:125`). The team's marketplace EOI rounds go out on Google Forms (`skills/eoi-criteria-proposal:10`). Labs ingests those into marketplace rounds through a path ACE does not drive (`marketplace_rounds_list`, `marketplace_round_responses`).

**New atoms** in `ace-gdrive`:
- **`forms_create_from_spec({parentFolderId, title, description, items[]})`.**
  - It creates the file with the **Drive API** (`files.create`, `mimeType: application/vnd.google-apps.form`, `parents: [parentFolderId]`, `supportsAllDrives`), then fills it with `forms.batchUpdate`.
  - Do not use `forms.create`: it lands in the service account's My Drive, which has no storage quota. That is the same class as the enforced `assertParentOnSharedDrive` gotcha.
  - Item kinds map from solicitation question types: `text` → short answer, `textarea` → paragraph, `number` → short answer with a number validation, `multiple_choice` → radio.
- **`forms_set_publish_settings({formId, isPublished: true, isAcceptingResponses})`.** Forms created through the API since 2025 are unpublished until this call is made.
- **`forms_list_responses({formId, since?})`.**
- **Scopes:** add `forms.body` and `forms.responses.readonly`. The Forms API must also be enabled on the service account's GCP project. That is an operator step, and `/ace:doctor` gets a probe that names it.

**New skill `solicitation-google-form`** (+ `-qa`):
1. Mirror the solicitation's questions into a form in `8-solicitation-management/`. Each item's description carries the question's `id`, which is the join key.
2. Prepend the demonstration banner whenever the solicitation is private.
3. Publish it so anyone with the link can respond, and set the Drive file to anyone-with-link reader.
4. Record `products.solicitation.google_form: {form_id, responder_url, edit_url}`.
5. On `--import` (and before review), call `forms_list_responses`, map each answer to its question id, and `create_response` each one into the labs solicitation. The respondent's own name and email from the form are entered as given. The form response id is recorded in the roster, so an import never runs twice.

**Why the form is public while the call is private.** The owner asked for public forms because that is the current practice. The form contains only the call's content (no PII, no pipeline data: the same rule `create_solicitation` states for `is_public`). The banner is mandatory, because a public form on a demonstration call will collect real submissions from anyone who finds the link. **A form is never created for a run that didn't ask for one**, and nothing downstream requires it.

## § F. Supply-chain skill family (`supply_chain`)

All of it is new. The Labs surface is large (≈90 `supply_chain_*` atoms) and well-specified, so the skills choreograph it; they do not reimplement it. The integration reference moves into a new **`playbook/integrations/connect-labs-supply-chain.md`**, the per-surface doc § Conventions asks for. It is general platform reference, organised by resource, not by phase.

### F0. Contracts every supply-chain skill follows

- **Explicit parameters, no run coupling.** Each skill takes `program_id` (the Connect program, which is the labs programme) plus its own ids. Inside `/ace:run` they come from `run_state.yaml.phases.execution-management.products.supply_chain.*`; outside a run they are passed directly. This follows the new Inputs contract from the audit (`skills/README.md` § Inputs → parameters + resolver). These skills are the first ones built to it.
- **`source.ref` is deterministic.** Every write carries `source: {ref, sender, sent_on}`. `lib/supply-chain-ref.ts` builds `ref = ace:<run-id>:<skill>:<step>:<stable-key>`. Labs replays the first result when the ref and payload repeat, so a re-run or resume is idempotent with no read-first. `sent_on` is the simulated date (§ G).
- **Never compute what the counterparty states.** `quote_record` says: "Do NOT compute anything". Leave `freight_basis` and `duties_basis` as `not_specified` and `pack_spec_source` as `not_stated` where the (simulated) supplier didn't say. Simulated quotes vary these on purpose, so `tender_compare` reports `rankable: false` with `blocked_by` at least once and the flow has to resolve it through `quote_correct`.
- **Money is a decimal string.** Every amount atom refuses JSON numbers.
- **Dates are backdated to the simulated calendar** (`received_on`, `decided_on`, `signed_on`, `dispatched_on`, `received_on`, `issued_on`, `paid_on`, `counted_on`, `distributed_on`).
- **Read back after every phase** with the matching `*_list`/`*_get`, and finish with `supply_chain_checks_list`. The `-qa` verdict is a function of that read-back, never of the write responses.

### F1. Preconditions (owner-blocking)

`supply_chain_programme_runner_get(program_id=353)` on an ACE program returned `{org_id: null, your_standing: "partner"}` (2026-10-18). As a *partner*, ACE can read and write only through update links. Tenders, awards, contracts and payments need standing **`programme`**. `supply_chain_programme_runner_set` is **platform-support only** ("no member of any organisation — including the one that runs it — may change it").

So **someone with labs platform support must declare `pm_org`'s labs org as the runner of the Connect FI program** before `supply-chain-setup` can write. `supply-chain-setup` reads `programme_runner_get` first. If `your_standing ≠ programme` it halts with a `[BLOCKER]` naming the program id, the labs org id to set, and the exact call. It never works around this.

### F2. `supply-chain-setup` (+ `-qa`)

This builds the programme's registry from the PDD's commodity needs.

- **Inputs:** `program_id`, the commodity plan, and `llo_org`. The commodity plan is derived from the PDD by the skill and written as an artifact before any write.
- **Steps:**
  1. Read `programme_runner_get` (the § F1 gate).
  2. `supply_chain_org_upsert` for `pm_org` and `llo_org`, bound by Connect id.
  3. `programme_team_add`: ace@ as admin.
  4. `commodity_upsert` per commodity.
  5. `item_upsert` per trade item.
  6. `supply_point_upsert`: a central store (managed by the winner), a regional store, and one `user_held` point per simulated FLW (`connect_username`).
  7. `supplier_create` for N fictional suppliers (`[Synthetic]`-suffixed, type distributor or manufacturer, `status: identified`). The same no-real-name rule as § D applies.
- **For Connect FI specifically:** the commodities are a basic feature handset and a SIM starter kit. The `commodity_upsert.category` enum is health-only (therapeutic_food … consumable), so handsets map to `equipment` and SIM kits to `consumable`. Quantities come from the PDD: a phone only for enrolled adults without one, with the proposal's ~1,500 + 1,000 adults as the ceiling. A non-health category is an upstream ask to connect-labs, not a blocker.
- **QA:**
  - every planned record reads back;
  - the user-held points name real synthetic usernames;
  - no supplier has a real name;
  - `checks_list` shows no `conflict` on the registry.

### F3. `supply-chain-procure` (+ `-qa`, + `-eval`)

1. `tender_create`: draft, `visibility: private`, with lines and `delivery_points` (the central store), a `response_deadline` and a brief.
2. `tender_invite_org` for each synthetic supplier.
3. `tender_open`.
4. `quote_record`: 3–4 quotes per line, varied on price, lead time, MOQ, incoterm and stated or unstated freight and duties.
5. `tender_compare` per commodity. If it is not rankable, resolve with `quote_correct`, citing a simulated supplier clarification as the `source`, and compare again.
6. `award_create` with a rationale that cites the frozen comparison, plus `decided_on` and `decided_by: "ACE (simulated)"`.
7. `tender_close`.
8. `contract_create`: `buyer_of_record: partner_org`, `buyer_org_id` = the `llo_org` labs id, `consideration: priced`, `payment_terms`, `promised_lead_time_days`, `source: we_recorded`.
9. Optional: `contract_landed_cost` / `contract_match` read-backs.

- **QA:**
  - the tender ends `awarded`, then `closed`;
  - each line has exactly one award;
  - the award's frozen comparison was rankable;
  - the contract's supplier, quantity and price equal the awarded quote's.
- **Eval (LLM judge):**
  - realism of the quote spread against the commodity;
  - whether the award rationale follows from the comparison;
  - whether quantities follow from the PDD.
  - It has the standard hard deductions: a quantity not traceable to the PDD, a rationale that contradicts the comparison, or an award to a non-cheapest quote with no stated reason.

### F4. `supply-chain-fulfil` (+ `-qa`)

1. `shipment_record` (supplier → central store, with batch and expiry).
2. `receipt_record`: the goods received note, which is the step that brings stock into existence. One week includes a partial rejection, to exercise the loss path.
3. `invoice_record` with `quantity_billed`. One invoice bills above the received quantity, so the three-way match flags it, and `invoice_dispute` resolves it.
4. `payment_record`: an advance against the contract, matched later through `acknowledges_payment_ids`, or a payment against the invoice.
5. `payment_confirm`.

- **QA:**
  - received stock equals accepted lines;
  - `invoice_list` shows the dispute resolved;
  - no `payment_unconfirmed` older than 14 simulated days in `checks_list`.

### F5. `supply-chain-operate` (+ `-qa`)

This is called once per simulated week by `simulated-execution`.

1. `consignment_dispatch` from central to regional store, then `consignment_receive`. One week includes a short receipt, which writes a loss.
2. `distribution_record` to each FLW's `user_held` point. Quantities follow that week's synthetic enrolments.
3. `stock_count_record`: FLW self-reports, with one week deliberately at zero, which is a stockout.
4. Read `stock_position`, `stock_forecast`, `resupply_plan`, `worker_stock` and `checks_list`, and save them to the week's artifact.

- **QA:**
  - stock flows balance (`stock_flow`);
  - every planned movement reads back;
  - the week's artifact lists every open check by audience.

### F6. What cannot be undone

Labs has **no delete for tenders, quotes, awards, contracts, shipments, receipts, invoices or payments**. The only removals are `quote_void`, `update_link_revoke` and `outreach_delete`. The isolation is therefore the program itself: everything is scoped to the run's own Connect program in ACE's PM org, and every name and `source.excerpt` says "simulated". `sweep-labs` lists them for audit and revokes update links; it does not try to delete them. This is a reason never to run the supply-chain track against a program ACE does not own.

## § G. Simulated 4-week execution (`simulate_weeks`)

**There is no clock to move.** Labs offers backdating (synthetic visit dates, the supply-chain `*_on` fields, `workflow_preview_as_of`) and weekly history rebuilds. So the simulation runs on a **backdated calendar**:

- `lib/sim-calendar.ts` (pure, tested) computes it from `run_started_at`:
  - `sim_start` = the Monday on or before `run_started_at − (N+1) weeks`;
  - week 0 runs from `sim_start` to `+6d` and holds procurement and fulfilment;
  - weeks 1..N are the delivery weeks;
  - all of it is in the past.
- **This is a known inconsistency, and it is documented:** the solicitation and award carry real wall-clock dates, which are later than the simulated procurement. The weekly review states this in its first line. The alternative, future-dated records, would make every as-of read meaningless.

**New skill `simulated-execution`** (+ `-qa`), plus the weekly review skill:
1. Generate the delivery data **once**, for the whole window. Use `synthetic-data-generate` with `timeline: {start_date: week1.start, end_date: weekN.end, weeks: N}` on a labs-synthetic opportunity cloned from the run's Phase 4 opportunity (`synthetic_clone_to_labs_only`), whose org is `llo_org`. This reuses Phase 7's machinery. It does not create a second real Connect opportunity.
2. For each week `w`: call `supply-chain-operate` with `as_of = week_w`. Week 0 has already run `procure` and `fulfil`.
3. Then call `workflow_rebuild_history({cadence: weekly, limit: N})` on the opportunity's semantic-snapshot workflow (the `demo-data-setup` C5 pattern), so the weekly review workflow has one completed run per week.
4. Write **`9-execution-management/simulated-week-<w>_review.md`** for each week, produced by `simulated-weekly-review` (+ `-eval`). It covers:
   - enrolment and completion against the PDD's targets (ID, SIM, phone, wallet funded);
   - supply position and the stockout;
   - open `checks_list` items by audience;
   - what an LLO and the program manager would each do next.
   It reads only labs data for that week, so `-eval` can check every number against `workflow_run_indicators` and `stock_position` for the same `as_of`.
5. Finish with `9-execution-management/simulated-execution_summary.md`, which links the four reviews, the labs workflow run pages and the supply-chain programme pages.

**Phase 9 placement.** `agents/execution-manager.md` halts before any step, because Phase 9 is the first real LLO contact. The guard gets **one carve-out**: when `optional_steps.simulate_weeks` or `supply_chain` is set, the agent runs **only** the simulated block above. No email is sent, no Connect invite, no `llo-onboarding`, no `connect_*` mutation. Real mode still halts with the existing message. The orchestrator dispatches Phase 9 only in that case, and its Phase 8→9 boundary text says so. `phases.execution-management.mode: simulated` is written to run_state, and `status: done` requires the simulated artifacts only.

## § H. run_state products

```yaml
phases:
  solicitation-management:
    products:
      solicitation:
        visibility: private          # new; absent = public (legacy)
        google_form: { form_id, responder_url, edit_url }   # only with google_form
        seeded_responses:            # only with seed_responses
          - { response_id, org_name, synthetic: true, intended_profile }
      selected_llo:
        source: solicitation
        org_slug: <llo_org>
        synthetic_winner: true       # new: the ACE-owned winner, never a real LLO
  execution-management:
    mode: simulated                  # new; only value the optional track writes
    products:
      supply_chain:
        program_id: <int>
        labs_org_ids: { pm: <int>, llo: <int> }
        commodities: [<slug>]
        supply_points: { central: <id>, regional: <id>, flw: {<username>: <id>} }
        suppliers: [<id>]
        tender_id: <int>
        award_ids: [<int>]
        contract_ids: [<int>]
        shipment_ids: [<int>]
        invoice_ids: [<int>]
        payment_ids: [<int>]
      simulation:
        calendar: { sim_start, weeks: [{w, start, end}] }
        synthetic_opportunity_id: <int>
        workflow_id: <int>
        weekly_reviews: [<drive file id>]
```

`lib/run-state-validator.ts` gains the `mode: simulated` shape. `selected_llo.synthetic_winner: true` makes every later consumer (opp-closeout, llo-feedback, timeline-monitor) skip external comms by construction.

## § I. Tenancy and cleanup

- **`config/tenancy-targets.json`:**
  - add `create_solicitation.org_slug → connect_pm_org`;
  - add `supply_chain_org_upsert.data.connect_organization_slug → [connect_pm_org, connect_holding_org, connect_llo_org]`.
  - The supply-chain writes' tenant is `program_id`, and ace-web's tenancy has no program field today. Add `connect_program_ids` to the tenancy record (ace-web change), then map `program_id` on the `supply_chain_*` write pattern and on `create_response`. Until ace-web ships it, the rule is declared with a note and is inert; the absent-field rule refuses, so it lands in warn mode first.
- **`skills/sweep-labs`:** list non-public solicitations and their seeded responses under each run (pass `program_id`), revoke update links, `quote_void` unawarded quotes, and **report** the undeletable supply-chain records (§ F6). It never tries to delete them.
- **Google Forms:** `sweep-drive` already sees the form under the run folder. Closing it (`isAcceptingResponses: false`) is a sweep action.

## § J. Out of scope

- Real LLO onboarding, UAT, launch or emails for the winner. Phase 9's real mode stays off.
- Participant cash deposits ($1–3 wallet top-ups). Those are Connect payments, not supply chain.
- Labs marketplace rounds. The form here is the run's own; it is not registered as a marketplace round.
- A `connect_create_organization` atom (§ C, a follow-up).

## § K. Residuals to verify live (each one is named in its PR)

1. Which identifier `award_response.org_id` takes (§ C).
2. Whether `create_response` on a *private* solicitation needs `program_id` or works on `solicitation_id` alone.
3. Whether `forms.batchUpdate` populates a form created through `drive.files.create` on a Shared Drive with no further step.
4. Whether `workflow_rebuild_history` covers weeks whose visits came from `synthetic_clone_to_labs_only`.
5. Whether supply-chain `*_on` dates may predate the programme's creation date (the § G calendar assumes they may).
