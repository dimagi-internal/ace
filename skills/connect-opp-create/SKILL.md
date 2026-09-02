---
name: connect-opp-create
description: >
  Create or clone a Connect opportunity from a single spec YAML, standalone.
  No PDD, no run_state, no Drive, no other ACE phase. Mints fresh HQ app
  copies for the clone path so payment units and the Learn gate behave.
disable-model-invocation: true
---

# Connect Opp Create

Stand up one fully-configured Connect opportunity from a spec file. This is
Phase 4's atom sequence with the ACE-run scaffolding removed.

**Relationship to Phase 4.** `connect-opp-setup` (Phase 4) derives the same
~15 values from a PDD, a Phase-3 deploy summary and a `run_state.yaml`, then
writes verdicts and phase-products back to Drive. This skill takes those values
directly and writes one local YAML. The Connect-side ordering is identical and
deliberately so â€” create â†’ payment units â†’ activate â†’ invite is a real
dependency chain, not a style. When a rule below cites a Phase-4 lesson, it is
the same lesson, not a re-derivation.

**When to use Phase 4 instead:** you want a PDD-driven opportunity inside a full
`/ace:run`, with evals and Drive artifacts. **When to use this:** you have the
app ids and the payment plan already, or you want another opportunity shaped
like an existing one.

## Slash command

```
/ace:connect-opp-create <spec.yaml>
/ace:connect-opp-create --clone <connect-opp-url-or-uuid> [--out <spec.yaml>]
/ace:connect-opp-create <spec.yaml> --dry-run
```

`--clone` **hydrates a spec and stops.** It never creates anything: it reads
the source opportunity, writes a spec with the mutable fields filled in and the
app ids left BLANK, and hands it back for editing. Creating is always a second,
explicit invocation against a spec file. That split is the point â€” see Â§ Clone.

## Inputs

One YAML file. `templates/connect-opp-spec.yaml` is the annotated template.

```yaml
# --- Identity -------------------------------------------------------------
organization_slug: ai-demo-space          # PM-side org that runs the program
program_id: <program UUID>                # existing program; see § Program
name: "Bednet Spot-Check — Kano"          # see § name for the is_test rule
short_description: "Bednet spot-check visits in Kano"   # ≤50 chars, HARD
description: "Field workers verify bednet presence..."  # ≤250 recommended
target_organization_slug:                 # omit for self-managed; see § LLO
is_test: false

# --- Window ---------------------------------------------------------------
start_date: "2026-09-15"                  # must fit inside the program window
end_date: "2026-12-15"

# --- Apps (bare 32-char HQ app ids, ALREADY built and released) -----------
learn_app:
  cc_domain: connect-ace-prod
  cc_app_id: <32 hex>
  description: "Bednet spot-check training"   # required by Connect's form
  hq_server_url: https://www.commcarehq.org
deliver_app:
  cc_domain: connect-ace-prod
  cc_app_id: <32 hex>                     # MUST differ from learn_app
  hq_server_url: https://www.commcarehq.org

passing_score: 80                         # 0-100; see § The Learn gate

# --- Money (whole currency units — NEVER cents) ---------------------------
total_budget: 900
fund_users: 3                             # smoke headroom; default 3
payment_units:
  - name: "Per verified visit"            # ≤25 chars if also used as a rule name
    description: "One completed household visit"
    amount: 2
    org_amount: 0
    max_total: 100
    max_daily: 5

# --- Optional -------------------------------------------------------------
verification_flags:                       # see § Verification flags
  form_field_rules: []
invite_phone_numbers: []                  # FLW pre-invites, E.164
clone_from:                               # written by --clone; see § Clone
  opportunity_id: <source UUID>
  source_learn_app_id: <32 hex>
  source_deliver_app_id: <32 hex>
```

`api_key` is deliberately **not** a spec field. Pass `${ACE_HQ_API_KEY}` in the
`learn_app` / `deliver_app` payloads; the MCP substitutes it from
`$CLAUDE_PLUGIN_DATA/.env`. Never inline a key in a spec file.

## Products

- `<spec-dir>/<opp-slug>-created.yaml` â€” opportunity UUID + `int_id`, URL,
  payment-unit ids, app ids, invite results, and the exact create payload
- Console summary with the Connect deep link

No Drive writes, no `run_state.yaml`, no eval verdict. If you want this
opportunity to appear in an ACE run's state, copy the block into that run's
`phases.connect-setup.products.connect` yourself.

## Process

### Step 0: Load and validate the spec

Read the YAML, then run the validator **before any network call**:

```bash
npx tsx -e "
import {validateConnectOppSpec, formatSpecIssues, hasBlockingIssue} from './lib/connect-opp-spec.js';
import {readFileSync} from 'node:fs'; import {parse} from 'yaml';
const spec = parse(readFileSync(process.argv[1], 'utf8'));
const issues = validateConnectOppSpec(spec);
console.log(formatSpecIssues(issues));
process.exit(hasBlockingIssue(issues) ? 1 : 0);
" <spec.yaml>
```

Halt on any `[ERROR]`. Report `[WARN]`s and continue.

The validator covers the shape: the 50-char cap, whole-unit integers, the
funds-â‰¥1-FLW floor, the `is_test` name prefix, and the clone app-reuse traps.
It does **not** know the program budget ceiling, whether the target org's
`ProgramApplication` is ACCEPTED, or whether the HQ apps are released. Those
are live facts and the real call is their authority.

### Step 1: Resolve the program

`program_id` is required â€” this skill does not create programs. To get one:

- Existing: `connect_list_programs({organization_slug, name: "<substring>"})`
  (filtered rows come back fully hydrated). Confirm with `connect_get_program`.
- New: create it with `connect_create_program`, or run the
  `connect-program-setup` skill, which additionally reconciles content and
  sizes the budget ceiling.

Then read the ceiling and check this opp fits:

```
connect_get_program({ organization_slug, program_id })
connect_list_opportunities({ organization_slug, summarize_by_program: <program.name> })
```

`summarize_by_program` returns `{listing, summary}` with the Î£ computed
server-side and **no rows** â€” ask for the rows and the org-wide hydrated array
overflows the tool-result cap and you get nothing usable (measured on
`ai-demo-space` 2026-09-01: 71 rows, 81,175 chars â€” ace#1799). Use
`write_to_path` if you genuinely need to inspect them.

If `program.budget âˆ’ summary.sigma_total_budget < total_budget`, raise the
ceiling with `connect_update_program({organization_slug, program_id, budget})`.
Read `connect-program-setup Â§ Step 4a` before doing so: it explains why the
raise must be computed as an absolute target rather than `program.budget + N`
(a relative raise compounds on every run and took one program from 19,400 to
64,400 against a known consumption of 4,062 â€” ace#1637).

### Step 2: Program application pre-flight

Connect validates that the opportunity's holding org has an **ACCEPTED**
`ProgramApplication` for the program. Three cases on
`target_organization_slug`:

| Spec value | Meaning | Action |
|---|---|---|
| omitted | self-managed â€” the requirement relocates to the PM org, it is not waived | run the round-trip |
| equals `organization_slug` | self-managed | run the round-trip |
| different, non-empty | a distinct LLO | the LLO accepts out-of-band; skip |

The round-trip, run **unconditionally** â€” attempt the transition and treat the
conflict as the skip (CLAUDE.md Â§ Conventions). There is no
list-program-applications atom, so a read-first branch has nothing to read:

```
connect_send_llo_invite({ organization_slug, program_id, organization: <the org being invited> })
connect_accept_program_application({ organization_slug, program_id, application_id: <from the invite response> })
```

If the invite reports the application already exists, that IS the skip signal â€”
log it and continue. The skip body carries no `application_id` and does not need
to: the create derives the application server-side from
`(target_organization_slug, program_id)`. Note the skip does not distinguish
INVITED from ACCEPTED; a merely-pending application surfaces at Step 4 as
`Organization must have an accepted application for this program.` (ace#1800).

### Step 3: Mint fresh app ids (clone path, or any reuse)

**Skip only if `learn_app.cc_app_id` and `deliver_app.cc_app_id` are already
apps no other opportunity uses.** Otherwise, for each of Learn and Deliver:

```
commcare_linked_app_copy({
  upstream_domain: <source domain>,
  upstream_app_id: <source app id>,
  downstream_domain: <target domain>,
  name: "<unique name in the target domain>",
  linked: <true for master→child; false for a same-domain copy>,
})
commcare_make_build({ domain: <target domain>, app_id: <new id> })
commcare_release_build({ domain: <target domain>, app_id: <new id>, build_id: <build id> })
```

Two modes, both real:

- **master → child**, `linked: true` — a live linked app eligible for future
  pulls from the master. Needs a linked-domain pair (`commcare_link_domains`)
  and Pro Edition (LITE_RELEASE_MANAGEMENT). This is the Connect Interviews
  cohort pattern.
- **same domain, `linked: false`** — HQ's plain "Copy Application". The
  supported, non-destructive way to mint a fresh `cc_app_id`. Prefer it over
  delete → re-upload: it destroys nothing, and being a document copy it
  preserves `appearance="acquire"` and per-module `display_style`, the two
  settings a Nova re-upload wipes (ace#1643).

Two traps on the copy atom, both from its own live validation (2026-09-01,
`connect-ace-prod`): `name` must be **unique in the target domain**, because
the new id is recovered by re-listing and matching on name; and that re-list
regularly exceeds 30s on a busy domain â€” **a timeout does not mean the POST
failed**, so re-list before retrying or you create a duplicate and break
name-based recovery.

Write the new ids back into the spec before Step 4.

### Step 4: Create the opportunity

```
connect_create_opportunity({
  organization_slug, program_id, name, short_description, description,
  target_organization_slug,          // omit for self-managed
  start_date, end_date, total_budget, passing_score,
  is_test,
  auto_activate: false,              // MANDATORY — see below
  learn_app:   { hq_server_url, api_key: "${ACE_HQ_API_KEY}", cc_domain, cc_app_id, description },
  deliver_app: { hq_server_url, api_key: "${ACE_HQ_API_KEY}", cc_domain, cc_app_id },
})
```

`auto_activate: false` is not a preference. Activation requires at least one
PaymentUnit and none exists yet at create time; `true` therefore fails AND
rolls the whole create back, leaving no `opportunity_id` and an orphan inactive
opp (ace#584).

Capture from the response: `id` (UUID), `int_id` (ConnectProd's integer id â€”
labs and `/a/<org>/opportunity/<int>/` URLs key off it), the resolved app names,
and `deliver_app.deliver_units`. **Don't** call `connect_list_deliver_units`
afterward â€” the create response already carries the list.

**App wiring is write-once.** `connect_update_opportunity` covers only
`name` / `short_description` / `description` / `end_date` / `is_test`; there is
no way to re-point a live opportunity at a different app. Getting Step 3 wrong
means deleting the opportunity in the Connect web UI and starting over.

Then read back what the server stored:

```
connect_get_opportunity({ organization_slug, opportunity_id })
```

A never-activated opportunity renders only the **edit-form half** of that read.
Compare `name`, `short_description`, `description`, `end_date`, `is_test` HERE.
`start_date`, `total_budget` and both `cc_app_id`s come off the dashboard,
which is empty until activation â€” **defer them to Step 7**, and record them as
`unreadable-at-this-point`, never as a match. An absent field is unknown, not
agreement (ace#1647).

### Step 5: Payment units

```
connect_create_payment_units({
  organization_slug, opportunity_id,
  total_budget,                      // the SAME integer sent at Step 4
  payment_units: [ { name, description, amount, org_amount, max_total, max_daily } ],
})
```

Atomic batch â€” one invalid unit rejects the whole request. Always pass
`total_budget`: the MCP recomputes
`number_of_users = total_budget / Σ(max_total × (amount + org_amount))` over
the integers actually being sent and refuses an underfunded opportunity before
creating any unit (ace#729). Step 0 checks the same thing, but Step 0 checks
the spec and this checks the wire.

Verify from the **create response**, not from `connect_list_payment_units`:
that scraped listing returns `amount` undefined, swaps `max_total` / `max_daily`
on some pages, always returns `description: ''`, and its `id` is a per-opp
display index rather than the server PK (ace#1642). Only `payment_unit_uuid`
and `name` are dependable there.

### Step 6: Verification flags (optional)

Skip entirely unless the spec sets `verification_flags`. Only three surfaces
still exist on Connect's form: `form_field_rules`, the
`form_submission_start` / `form_submission_end` window, and per-deliver-unit
`duration_minutes`. `gps`, `duplicate`, `catchment_areas`, `gps_radius_meters`
and `check_attachments` have no input on the page; the atom now raises
`unsupported_verification_flag` before posting rather than returning `ok: true`
for a control that was never set (ace#1013).

For `form_field_rules`: `question_path` is a **JSONPath into the HQ form-JSON
doc**, not an XForm XPath â€” `/data/group/q` is written `form.group.q`. Read the
node names out of the released CCZ (`commcare_download_ccz` with
`write_to_path`), never from prose; `name` is capped at 25 chars and a longer
one silently fails the whole formset; check `form_field_rules_saved` in the
response for the count Connect actually persisted (ace#1301).

### Step 7: Activate, then finish the read-back

```
connect_activate_opportunity({ organization_slug, opportunity_id })
```

Call it **unconditionally**. The create response's `active: true` is a
create-side flag, not the `/activate/` state transition that `invite_users/`
requires, so a pre-check on it skips the only call that enables invites
(ace#624). An "already active" rejection is the idempotent skip â€” log and
continue. A hard error is a blocker; the usual cause is a missing payment unit.

Now re-read and compare the deferred fields, which the dashboard renders once
the opportunity is active: `start_date`, `total_budget`,
`learn_app.cc_app_id`, `deliver_app.cc_app_id`. A disagreement â€” or a field
STILL absent â€” is a blocker, not a pass.

Also confirm the Learn gate, which lives on a **different surface**:

```
connect_get_learn_passing_score({ organization_slug, program_id, opportunity_id })
```

`connect_get_opportunity` does not render it, so reading it there returns
`undefined`, which looks like "unreadable" rather than "mismatch" (ace#1449).
`null` means the gate is **unset** â€” do not coerce that to `0`, which means
every worker passes.

On a mismatch, suspect **row reuse before server drift**: Connect keys
`CommCareApp` on `(cc_app_id, cc_domain, organization, hq_server)` and the
create path runs `get_or_create` with `update_existing=False`, so a pre-existing
row makes the posted `passing_score` silently discarded (ace#1350). Classify with
`classifyPassingScoreReadback` from `lib/passing-score-readback.ts`, and if you
apply `connect_set_learn_passing_score`, note that it moves the gate for EVERY
opportunity in the org wired to that Learn app â€” record `previous_passing_score`
from its response.

Step 3's fresh app ids are what normally keep you out of this. It is the
standing hazard of the clone path, which is why the validator blocks it.

### Step 8: Invites (optional)

```
connect_send_flw_invite({ organization_slug, opportunity_id, phone_numbers: [...] })
```

`invite_users/` hard-rejects a non-active opportunity, so a successful invite is
also the only real proof that Step 7's transition landed â€” the scraped `active`
flag cannot distinguish a real activation from a no-op (ace#624). If you have no
one to invite, verify activation another way rather than skipping the question.

Include `${ACE_E2E_PHONE}` if this opportunity will be driven on the emulator.

### Step 9: Write the local record

Write `<opp-slug>-created.yaml` next to the spec:

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
  learn:   { cc_domain: <slug>, cc_app_id: <32 hex>, minted_by: <copy | preexisting> }
  deliver: { cc_domain: <slug>, cc_app_id: <32 hex>, minted_by: <copy | preexisting> }
payment_units: [ { payment_unit_uuid: <uuid>, name: <name>, amount: <int>, max_total: <int> } ]
passing_score: { posted: <int>, read_back: <int> }
invites: [ { phone: <e164>, result: <queued | error> } ]
clone_from: <source uuid | null>
readback:
  step4: { name: match, short_description: match, ... }
  step7: { start_date: match, total_budget: match, learn_app: match, deliver_app: match }
```

Report the deep link and every `[WARN]` raised along the way.

## Clone

`--clone <url-or-uuid>` hydrates a spec from an existing opportunity and
**stops**. It does not create.

```
connect_get_opportunity({ organization_slug, opportunity_id })   # source
connect_list_payment_units({ organization_slug, opportunity_id })
```

What comes back reliably: `name`, `short_description`, `description`,
`end_date`, `is_test`, `currency`, `country`, and â€” only if the source is
active â€” `total_budget`, `start_date`, `program_name`, `learn_app`,
`deliver_app`. From payment units, only `payment_unit_uuid` and `name`.

So the hydrated spec is **incomplete by construction**, and the flow says so
rather than papering over it:

| Field | Source | Spec gets |
|---|---|---|
| name, descriptions, dates, budget | `connect_get_opportunity` | filled, marked `# from source` |
| `program_id` | not on any read surface â€” reads carry `program_name` only | **blank**, with the program name as a comment to resolve |
| payment unit `amount` / `max_total` / `max_daily` | not readable (ace#1642) | **blank**, names only |
| `passing_score` | `connect_get_learn_passing_score` on the source | filled |
| verification flags | **no read atom exists** â€” only `set` | **blank**, with a `# NOT RECOVERABLE` comment |
| `learn_app.cc_app_id` / `deliver_app.cc_app_id` | source ids recorded under `clone_from` | **blank** â€” you mint fresh ones at Step 3 |

The app ids are left blank on purpose, and the validator blocks a spec that
fills them back in with the source's:

- Reusing the **Deliver** app means the new opportunity cannot create a payment
  unit at all â€” Connect keys `DeliverUnit` on the released app rather than on
  the opportunity, there is no delete atom, and an opportunity with no payment
  unit can never activate (ace#573).
- Reusing the **Learn** app means the posted `passing_score` is discarded and
  the new opportunity silently inherits the source's gate (ace#1350).

Both are invisible until late, and neither is recoverable in place.

That is also why hydrate and create are two commands: the useful half of a
clone is the prose and the shape, and the half you must re-mint is the wiring.
A single-shot `--clone-and-create` would have to guess at the blanks.

## The Learn gate

`passing_score` can be set **only** at create. Nova's `connect.assessment`
exposes `{id, user_score}` and no `passing_score` slot, so this call is the one
place the gate is established. It is a required field on the atom, so it cannot
be omitted â€” only set wrong, and wrong is silent: the app builds, the worker
sees a result screen, and only the gate differs from the one intended. Decide it
in the spec rather than defaulting it.

## Program

This skill takes an existing `program_id` and does not create programs. Programs
carry durable identity (org, delivery type, currency, country) that outlives any
one opportunity; minting one per opportunity is how an org ends up with 42 of
them. Use `connect-program-setup` (or `connect_create_program` directly) once,
then point many specs at it.

## Mode Behavior

- **Default:** validate, report the plan, create.
- **`--dry-run`:** run Step 0 and Steps 1-2's reads, print the exact Step 4
  create payload and the Step 5 batch, call no mutation atom.

## MCP Tools Used

- Connect: `connect_list_programs`, `connect_get_program`,
  `connect_update_program`, `connect_list_opportunities`,
  `connect_send_llo_invite`, `connect_accept_program_application`,
  `connect_create_opportunity`, `connect_get_opportunity`,
  `connect_create_payment_units`, `connect_list_payment_units`,
  `connect_set_verification_flags`, `connect_activate_opportunity`,
  `connect_get_learn_passing_score`, `connect_set_learn_passing_score`,
  `connect_send_flw_invite`
- CommCare HQ: `commcare_linked_app_copy`, `commcare_link_domains`,
  `commcare_make_build`, `commcare_release_build`, `commcare_list_apps`,
  `commcare_download_ccz`

## Verifying the result

`/ace:interview-opp-verify --opp <uuid> --org <slug>` walks a read-only
checklist against a live opportunity and grades each rule
pass / fail / unverifiable. It is written for Connect Interviews, so its
per-domain and OCS sections will grade `unverifiable` here â€” the per_cohort
opportunity rules still apply.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-01 | Initial. Phase 4's atom sequence, spec-driven and decoupled from PDD / run_state / Drive. Clone path built on `commcare_linked_app_copy` (live-validated 2026-09-01), with the source-app-reuse traps (ace#573, ace#1350) blocked in `lib/connect-opp-spec.ts` rather than described in prose. | ACE team |
