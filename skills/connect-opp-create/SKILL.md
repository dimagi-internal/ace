---
name: connect-opp-create
description: >
  Create or clone a Connect opportunity from one spec YAML, standalone - no
  PDD, run_state or Drive. Mints fresh HQ app copies on the clone path.
disable-model-invocation: true
---

# Connect Opp Create

Stand up one fully-configured Connect opportunity from a spec file.

**Relationship to Phase 4.** `connect-opp-setup` (Phase 4) derives the same
values from a PDD, a Phase-3 deploy summary and a `run_state.yaml`, then writes
verdicts and phase-products back to Drive. This skill takes those values
directly and writes one local YAML. The dependency chain in the middle -
create, then payment units, then activate, then invite - is the same because
Connect enforces it, not as a matter of style.

**`connect-opp-setup` remains the reference for every Connect-side gotcha in
this flow.** Where a step below cites an issue, the full account lives in that
skill's corresponding step; this file states the rule and the consequence and
points there rather than re-deriving it. If you are changing behaviour, change
it in both or neither.

**When to use Phase 4 instead:** a PDD-driven opportunity inside a full
`/ace:run`, with evals and Drive artifacts. **When to use this:** you already
have the app ids and the payment plan, or you want another opportunity shaped
like an existing one.

## Slash command

```
/ace:connect-opp-create <spec.yaml>
/ace:connect-opp-create <spec.yaml> --dry-run
/ace:connect-opp-create --clone <connect-opp-url-or-uuid> [--out <spec.yaml>]
```

`--clone` **hydrates a spec and stops.** It never creates anything. Creating is
always a second, explicit invocation against a spec file - see § Clone.

## Inputs

One YAML file. **`templates/connect-opp-spec.yaml` is the format** - copy it
and read its comments; they carry every field-level constraint and are the
single copy of them. Required keys, in brief:

| Key | Notes |
|---|---|
| `organization_slug`, `program_id` | PM-side org; an EXISTING program UUID (§ Program) |
| `name` | `is_test: true` requires a `YYYYMMDD-HHMM · ` run-id front prefix (§ The is_test name rule) |
| `short_description` | hard 50-char cap |
| `description` | no DB-enforced length |
| `start_date`, `end_date` | YYYY-MM-DD, inside the program window |
| `learn_app`, `deliver_app` | `{cc_domain, cc_app_id, hq_server_url}` + `description` on Learn; ids must differ |
| `passing_score` | 0-100; § The Learn gate |
| `total_budget`, `payment_units[]` | whole currency units; each unit needs `required_deliver_units` |

Optional: `target_organization_slug` (§ Who holds the opportunity),
`is_test`, `fund_users`, `invite_phone_numbers`, `verification_flags`,
`clone_from`.

`api_key` is deliberately **not** a spec field. Pass `${ACE_HQ_API_KEY}` in the
app payloads; the MCP substitutes it from `$CLAUDE_PLUGIN_DATA/.env` under its
own name allowlist, so the value never reaches the model. The validator blocks
a literal in any secret-shaped field rather than leaving this to prose - an
inlined key would otherwise *work*, because `resolveEnvSubstitution` returns
early on a string with no `$` in it and forwards it verbatim.

## Products

- `<spec-dir>/<opp-int-id>-created.yaml` - keyed on the ConnectProd integer id
  from the create response, so repeat invocations neither collide nor scatter.
  Holds the opportunity UUID + `int_id`, URL, payment-unit ids, app ids, invite
  read-back, and the create payload **with every secret-shaped field elided**
  (write `api_key: "[elided]"`, never the resolved value).
- Console summary with the Connect deep link.

No Drive writes, no `run_state.yaml`, no eval verdict. To surface this
opportunity in an ACE run, copy the block into that run's
`phases.connect-setup.products.connect` yourself.

## Process

1. **Validate the spec. Nothing is created until this exits 0.**

   ```bash
   npx tsx "${CLAUDE_PLUGIN_ROOT:-.}/scripts/validate-connect-opp-spec.ts" "<spec.yaml>"
   ```

   Exit 0 = proceed. Exit 1 = blocking issues, halt. Exit 2 = the file could
   not be read or parsed, halt. Quote the path: it is operator-supplied and
   this skill has `Bash` available.

   **Do not inline this as `npx tsx -e`.** That is what it was, and it failed
   OPEN - `tsx -e` has no module path, so the import could not resolve and the
   multi-line form exited 0 having printed nothing. Step 1 says "halt on any
   error", so silence read as "no issues" in front of the one irreversible
   step in the flow.

   The validator covers the spec's shape: the 50-char cap, whole-unit
   integers, non-numeric money (a quoted `"900"` is a string, and string
   arithmetic silently corrupts the budget check), the funds-≥1-FLW floor,
   non-empty `required_deliver_units`, the `is_test` name prefix, E.164
   invites, the `hq_server_url` allowlist, inlined secrets, and the clone
   app-reuse traps. It does **not** know the program budget ceiling, whether
   the target org's `ProgramApplication` is ACCEPTED, whether the HQ apps are
   released, or which apps other opportunities already use. Those are live
   facts and the real call is their authority.

2. **Resolve the program and check the budget fits.**

   `program_id` is required - this skill does not create programs (§ Program).
   To find one: `connect_list_programs({organization_slug, name: "<substring>"})`
   returns fully-hydrated rows for a filtered query.

   ```
   connect_get_program({ organization_slug, program_id })
   connect_list_opportunities({ organization_slug, summarize_by_program: <program.name> })
   ```

   `summarize_by_program` computes the Σ server-side and returns **no rows**:
   the org-wide hydrated array overflows the tool-result cap and yields nothing
   usable (ace#1799). Use `write_to_path` if you must inspect rows.

   If `program.budget − summary.sigma_total_budget < total_budget`, raise the
   ceiling with `connect_update_program`. Read
   `connect-program-setup § Step 4a` first - it explains why the raise must be
   an absolute target rather than `program.budget + N`, and how to read
   `sigma_unknown_reasons`.

   **Also check what apps this program's opportunities already use.** The
   validator cannot see this and it is the live half of the clone trap in
   Step 4: if the hydrated rows show your `deliver_app.cc_app_id` already wired
   to another opportunity on this program, Step 6 will not be able to create a
   payment unit. Scope the hydrated listing to this program and compare both
   `cc_app_id`s before continuing.

3. **Program-application pre-flight.**

   Connect validates that the org holding the opportunity has an **ACCEPTED**
   `ProgramApplication`. Three cases on `target_organization_slug`:

   | Spec value | Meaning | Action |
   |---|---|---|
   | omitted | self-managed - the requirement relocates to the PM org, it is not waived | run the round-trip |
   | equals `organization_slug` | self-managed | run the round-trip |
   | different, non-empty | a distinct LLO | that LLO accepts out-of-band; skip |

   Run the round-trip **unconditionally** - attempt the transition and treat
   the conflict as the skip. There is no list-program-applications atom, so a
   read-first branch has nothing to read:

   ```
   connect_send_llo_invite({ organization_slug, program_id, organization: <org being invited> })
   connect_accept_program_application({ organization_slug, program_id, application_id: <from the invite response> })
   ```

   "Already has an application" IS the skip signal - log and continue. The skip
   body carries no `application_id` and does not need one; the create derives
   the application server-side. It also does not distinguish INVITED from
   ACCEPTED, so let Step 4 be that check rather than inferring acceptance here
   (ace#1800; full account in `connect-opp-setup § Step 3a`).

4. **Mint fresh HQ app copies, unless both apps are already exclusively this
   opportunity's.**

   Step 2 told you whether they are. If either is in use, or you are cloning:

   ```
   commcare_linked_app_copy({
     upstream_domain, upstream_app_id, downstream_domain,
     name: "<unique name in the target domain>",
     linked: <true for master->child; false for a same-domain copy>,
   })
   commcare_make_build({ domain: <target domain>, app_id: <new id> })
   commcare_release_build({ domain: <target domain>, app_id: <new id>, build_id: <build id> })
   ```

   Two modes, both real:

   - **master → child, `linked: true`** - a live linked app eligible for future
     pulls from the master. Needs a linked-domain pair
     (`commcare_link_domains`) and Pro Edition. The Connect Interviews cohort
     pattern.
   - **same domain, `linked: false`** - HQ's plain "Copy Application". The
     supported, non-destructive way to mint a fresh `cc_app_id`. Prefer it over
     delete-and-re-upload: it destroys nothing, and being a document copy it
     preserves `appearance="acquire"` and per-module `display_style`, the two
     settings a Nova re-upload wipes (ace#1643).

   Two traps, from the atom's own live validation (2026-09-01,
   `connect-ace-prod`): `name` must be **unique in the target domain**, because
   the new id is recovered by re-listing and matching on name; and that re-list
   regularly exceeds 30s on a busy domain - **a timeout does not mean the POST
   failed**, so re-list before retrying or you create a duplicate and break
   name-based recovery.

   Write the new ids into the spec and re-run Step 1 before continuing.

5. **Create the opportunity.**

   ```
   connect_create_opportunity({
     organization_slug, program_id, name, short_description, description,
     target_organization_slug,          // omit for self-managed
     start_date, end_date, total_budget,
     is_test,
     auto_activate: false,              // mandatory - see below
     learn_app: {
       hq_server_url, api_key: "${ACE_HQ_API_KEY}", cc_domain, cc_app_id,
       description,
       passing_score,                   // NESTED here, not top-level
     },
     deliver_app: { hq_server_url, api_key: "${ACE_HQ_API_KEY}", cc_domain, cc_app_id },
   })
   ```

   **`passing_score` belongs inside `learn_app`.** The atom declares it on
   `learn_app` (`HqAppZ.extend`), and the spec's top-level `passing_score` is
   an editing convenience this step moves into place. Sending it at the top
   level drops it and fails the required nested field. (`docs/atom-schemas.md`
   renders it as a top-level row - that is a known flattening bug in the
   generator's nested-object handling, not the contract.)

   `auto_activate: false` is not a preference. Activation requires at least one
   PaymentUnit and none exists yet; `true` fails AND rolls the whole create
   back, leaving no `opportunity_id` and an orphan inactive opp (ace#584).

   Capture from the response: `id` (UUID), `int_id` (ConnectProd's integer id,
   which labs and `/a/<org>/opportunity/<int>/` URLs key off), the resolved app
   names, and `deliver_app.deliver_units` - **each unit's `server_id` is what
   Step 6 needs.** Don't call `connect_list_deliver_units`; the create response
   already carries the list.

   **App wiring is write-once.** `connect_update_opportunity` covers only
   `name` / `short_description` / `description` / `end_date` / `is_test`. A
   wrong app id here means deleting the opportunity in the Connect web UI and
   starting over.

   Then read back what the server stored:

   ```
   connect_get_opportunity({ organization_slug, opportunity_id })
   ```

   A never-activated opportunity renders only the **edit-form half** of that
   read. Compare `name`, `short_description`, `description`, `end_date`,
   `is_test` here. `start_date`, `total_budget` and both `cc_app_id`s come off
   the dashboard, which is empty until activation - **defer them to Step 8**
   and record them as `unreadable-at-this-point`, never as a match. An absent
   field is unknown, not agreement (ace#1647).

6. **Create the payment units.**

   ```
   connect_create_payment_units({
     organization_slug, opportunity_id,
     total_budget,                      // the SAME integer sent at Step 5
     payment_units: [ {
       name, description, amount, org_amount, max_total, max_daily,
       required_deliver_units,          // server_ids from Step 5's response
       optional_deliver_units,
     } ],
   })
   ```

   **Every unit MUST carry at least one `required_deliver_units` id - a hard
   pre-create gate, not a nicety.** Pass `du.server_id` from the Step 5 create
   response, never `du.id` (a per-opp display index the server rejects as
   "Invalid Data"). An empty list yields a payment unit that fails the
   opportunity's `is_setup_complete`, blocks `connect_send_flw_invite` and any
   device walk because the FLW cannot claim the opp, and makes synthetic
   accrual report `completed_works: 0` no matter how many visits exist - the
   engine attributes completed work to a unit's required DUs, and with none
   there is nothing to attribute (ace#843, confirmed live on
   `hh-poverty-targeting/20260702-1456`: 498 visits, 0 completed works). No DU
   may appear in both `required` and `optional` on one unit, and no DU may
   appear in two units in the same request - Connect rejects the whole batch.

   Atomic batch: one invalid unit rejects everything. Always pass
   `total_budget` - the MCP recomputes
   `number_of_users = total_budget / Σ(max_total × (amount + org_amount))` over
   the integers actually being sent and refuses an underfunded opportunity
   before creating any unit (ace#729). Step 1 checks the spec; this checks the
   wire.

   Verify from the **create response**, and assert `required_deliver_units` is
   non-empty in it. Do not verify from `connect_list_payment_units`: that
   scraped listing returns `amount` undefined, swaps `max_total` / `max_daily`
   on some pages, always returns `description: ''`, reports
   `required_deliver_units: []` regardless of actual config, and its `id` is a
   display index rather than the server PK (ace#1642, ace#1026).

7. **Verification flags (optional).**

   Skip unless the spec sets `verification_flags`. Only three surfaces still
   exist on Connect's form: `form_field_rules`, the
   `form_submission_start` / `form_submission_end` window, and per-deliver-unit
   `duration_minutes`. `gps`, `duplicate`, `catchment_areas`,
   `gps_radius_meters` and `check_attachments` have no input on the page; the
   atom raises `unsupported_verification_flag` before posting rather than
   returning `ok: true` for a control that was never set (ace#1013).

   Read the node names for `question_path` out of the **released CCZ**
   (`commcare_download_ccz` with `write_to_path`), never from prose - a rule
   matching no node enforces nothing while reporting success. Check
   `form_field_rules_saved` in the response for the count Connect persisted.
   Full account: `connect-opp-setup § Step 5` (ace#1301).

8. **Activate, then finish the read-back.**

   ```
   connect_activate_opportunity({ organization_slug, opportunity_id })
   ```

   Call it **unconditionally**. The create response's `active: true` is a
   create-side flag, not the `/activate/` transition that `invite_users/`
   requires, so a pre-check on it skips the only call that enables invites
   (ace#624). "Already active" is the idempotent skip - log and continue. A
   hard error is a blocker; the usual cause is a missing payment unit.

   Now re-read and compare the deferred fields, which the dashboard renders
   once the opportunity is active: `start_date`, `total_budget`,
   `learn_app.cc_app_id`, `deliver_app.cc_app_id`. A disagreement - or a field
   still absent - is a blocker, not a pass.

   Confirm the Learn gate, which lives on a **different surface**:

   ```
   connect_get_learn_passing_score({ organization_slug, program_id, opportunity_id })
   ```

   `connect_get_opportunity` does not render it, so reading it there returns
   `undefined`, which looks like "unreadable" rather than "mismatch"
   (ace#1449). `null` means the gate is **unset** - do not coerce that to `0`,
   which means every worker passes.

   On a mismatch, suspect **row reuse before server drift**: Connect keys
   `CommCareApp` on `(cc_app_id, cc_domain, organization, hq_server)` and the
   create path runs `get_or_create` with `update_existing=False`, so a
   pre-existing row makes the posted `passing_score` silently discarded
   (ace#1350). Classify with `classifyPassingScoreReadback` from
   `lib/passing-score-readback.ts`. If you apply
   `connect_set_learn_passing_score`, note it moves the gate for EVERY
   opportunity in the org wired to that Learn app - record
   `previous_passing_score` from its response. Step 4's fresh app ids are what
   normally keep you out of this.

9. **Invites (optional), with a read-back.**

   ```
   connect_send_flw_invite({ organization_slug, opportunity_id, phone_numbers: [...] })
   connect_list_flw_invites({ organization_slug, opportunity_id })
   ```

   **`{status: "queued"}` is NOT proof the invite landed** (ace#824, ace#855).
   Read the invite list back and record `invite_row_present` per number in the
   product YAML; a queued-but-absent row is the silent failure this read-back
   exists to catch.

   `invite_users/` hard-rejects a non-active opportunity, so a successful
   invite is also the only real proof Step 8's transition landed - the scraped
   `active` flag cannot distinguish a real activation from a no-op (ace#624).
   With no one to invite, verify activation another way rather than skipping
   the question.

   Include `${ACE_E2E_PHONE}` if this opportunity will be driven on an emulator.

10. **Write the local record.**

    Write `<opp-int-id>-created.yaml` next to the spec:

    ```yaml
    created_at: <ISO>
    organization_slug: <slug>
    program: { id: <uuid>, name: <name> }
    opportunity:
      id: <uuid>
      int_id: <integer>
      name: <verbatim name Connect stored>
      url: <CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/
      active: true
      is_test: <bool>
    apps:
      learn:   { cc_domain: <slug>, cc_app_id: <32 hex>, minted_by: <copy | preexisting>, api_key: "[elided]" }
      deliver: { cc_domain: <slug>, cc_app_id: <32 hex>, minted_by: <copy | preexisting>, api_key: "[elided]" }
    payment_units:
      - payment_unit_uuid: <uuid>
        name: <name>
        amount: <int>
        max_total: <int>
        required_deliver_units: [<server_id>]   # asserted non-empty in the create response
    passing_score: { posted: <int>, read_back: <int> }
    invites:
      - phone: <e164>
        queued: <bool>
        invite_row_present: <bool>              # from connect_list_flw_invites
    clone_from: <source uuid | null>
    readback:
      step5: { name: match, short_description: match, ... }
      step8: { start_date: match, total_budget: match, learn_app: match, deliver_app: match }
    ```

    Report the deep link and every warning raised along the way.

## Clone

`--clone <url-or-uuid>` hydrates a spec from an existing opportunity and
**stops**. It does not create.

```
connect_get_opportunity({ organization_slug, opportunity_id })   # source
connect_list_payment_units({ organization_slug, opportunity_id })
connect_get_learn_passing_score({ organization_slug, program_id, opportunity_id })
```

What comes back reliably: `name`, `short_description`, `description`,
`end_date`, `is_test`, `currency`, `country`, and - only if the source is
active - `total_budget`, `start_date`, `program_name`, `learn_app`,
`deliver_app`. From payment units, only `payment_unit_uuid` and `name`.

So the hydrated spec is **incomplete by construction**, and says so rather than
papering over it:

| Field | Source | Spec gets |
|---|---|---|
| name, descriptions, dates, budget | `connect_get_opportunity` | filled, marked `# from source` |
| `program_id` | not on any read surface - reads carry `program_name` only | **blank**, program name in a comment |
| payment unit `amount` / `max_total` / `max_daily` | not readable (ace#1642) | **blank**, names only |
| `required_deliver_units` | not readable, and the ids differ per opportunity anyway | **blank** - fill from Step 5's response |
| `passing_score` | `connect_get_learn_passing_score` | filled |
| verification flags | **no read atom exists** - only `set` | **blank**, `# NOT RECOVERABLE` |
| `learn_app.cc_app_id` / `deliver_app.cc_app_id` | source ids recorded under `clone_from` | **blank** - mint fresh at Step 4 |

The app ids are blank on purpose, and the validator blocks a spec that fills
them back in with the source's:

- Reusing the **Deliver** app means the new opportunity cannot create a payment
  unit at all - Connect keys `DeliverUnit` on the released app rather than on
  the opportunity, there is no delete atom, and an opportunity with no payment
  unit can never activate (ace#573).
- Reusing the **Learn** app means the posted `passing_score` is discarded and
  the new opportunity silently inherits the source's gate (ace#1350).

That guard runs off `clone_from`'s recorded source ids, which an operator can
delete - so it warns when they are missing, and **Step 2's live check against
the program's other opportunities is the one that covers a hand-written spec.**
Both are needed; neither alone is sufficient.

Hydrate and create are two commands because the useful half of a clone is the
prose and the shape, and the half you must re-mint is the wiring. A single-shot
clone would have to guess at the blanks.

## The is_test name rule

An `is_test: true` opportunity must be named `"<run_id> · <display name>"` -
`YYYYMMDD-HHMM`, then space, U+00B7 MIDDLE DOT, space. Phase 6's mobile recipes
anchor their opp-tile match on the run-id and it must lead so it lands on the
tile's first, never-clipped line. The MCP boundary rejects a bad name before
any network call (`INVALID_OPP_NAME_PREFIX`, ace#755). Real, human-facing
opportunities set `is_test: false` and use any name - which is this flow's
default, and a deliberate difference from Phase 4, where every opportunity is a
dogfood run.

## Who holds the opportunity

`target_organization_slug` names the org that holds the opportunity. Omitting
it does not mean "no org" - the REST backend sends the PM org as the holder, and
the accepted-application requirement moves there with it (ace#1251). Connect
also rejects an explicit null with "organization: This field is required"
(ace#700). Step 3 covers all three cases.

## The Learn gate

`passing_score` can be set **only** at create. Nova's `connect.assessment`
exposes `{id, user_score}` and no `passing_score` slot, so this call is the one
place the gate is established. It is a required field on the atom, so it cannot
be omitted - only set wrong, and wrong is silent: the app builds, the worker
sees a result screen, and only the gate differs from the one intended. Decide it
in the spec rather than defaulting it.

## Program

This skill takes an existing `program_id` and does not create programs.
Programs carry durable identity (org, delivery type, currency, country) that
outlives any one opportunity; minting one per opportunity is how an org ends up
with 42 of them. Use `connect-program-setup` (or `connect_create_program`) once,
then point many specs at it.

## Verifying the result

`/ace:interview-opp-verify --opp <uuid> --org <slug>` walks a read-only
checklist against a live opportunity and grades each rule
pass / fail / unverifiable. It is written for Connect Interviews, so its
per-domain and OCS sections grade `unverifiable` here; the per_cohort
opportunity rules still apply.

## MCP Tools Used

- Connect: `connect_list_programs`, `connect_get_program`,
  `connect_update_program`, `connect_list_opportunities`,
  `connect_send_llo_invite`, `connect_accept_program_application`,
  `connect_create_opportunity`, `connect_get_opportunity`,
  `connect_create_payment_units`, `connect_list_payment_units`,
  `connect_set_verification_flags`, `connect_activate_opportunity`,
  `connect_get_learn_passing_score`, `connect_set_learn_passing_score`,
  `connect_send_flw_invite`, `connect_list_flw_invites`
- CommCare HQ: `commcare_linked_app_copy`, `commcare_link_domains`,
  `commcare_make_build`, `commcare_release_build`, `commcare_list_apps`,
  `commcare_download_ccz`

## Mode Behavior

- **Auto / default:** validate, report the plan, create.
- **Review:** present the Step 5 create payload and the Step 6 batch for
  approval before calling either.

## Dry-Run Behavior

When `--dry-run` is active:

- Run Step 1 and the read-only calls in Steps 2-3.
- Print the exact Step 5 create payload and Step 6 batch, with `api_key`
  rendered as `${ACE_HQ_API_KEY}` rather than resolved.
- Call **no** mutation atom: no `connect_create_*`, no
  `connect_update_program`, no `connect_activate_opportunity`, no
  `connect_send_*_invite`, no `commcare_linked_app_copy` / `make_build` /
  `release_build`.
- Write the payloads to `<spec-dir>/dry-run-connect-opp-create.md` instead of a
  `-created.yaml`, and report `dry-run-success`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-01 | Initial. Phase 4's Connect-side sequence, spec-driven and decoupled from PDD / run_state / Drive. Clone path built on `commcare_linked_app_copy` (live-validated 2026-09-01), with the source-app-reuse traps (ace#573, ace#1350) blocked in `lib/connect-opp-spec.ts` and re-checked live at Step 2 rather than described in prose. | ACE team |
