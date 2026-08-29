---
name: connect-opp-setup
description: >
  Create and fully configure a Connect Opportunity — opp shell, verification
  flags, payment units, ACE test-user pre-invite for emulator testing.
disable-model-invocation: false
---

# Connect Opportunity Setup

Create and fully configure a Connect managed opportunity in `ai-demo-space`
(or whichever PM-side org owns the parent program).

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | archetype + Evidence Model (Layer A → verification flags) |
| Phase 4 | `4-connect/connect-program-setup.md` | program UUID (opp is scoped to it) |
| Phase 8 | current run's `phases.solicitation-management.products.selected_llo.org_slug` | awarded LLO (must have ACCEPTED ProgramApplication; see § Pre-flight) |
| Phase 3 | `3-commcare/app-deploy_summary.md` | `hq_server`, `learn_app`/`deliver_app` IDs, HQ project space slug |

## Phase folder anchor

The connect-setup agent passes a `phaseFolderId` (the `4-connect` folder ID,
anchored to the run folder per `agents/orchestrator-reference.md § Per-Phase
Folder Lifecycle`). **Every `drive_create_file` write in this skill MUST set
`parentFolderId = phaseFolderId`** — `drive_create_file`'s `parentFolderId` is
required and must be a folder ID, never a path string. Writing by path-string
alone makes the artifact land outside `4-connect` and fail
`verify_phase_artifacts(phase='connect')` (jjackson/ace#635).

## Products

- `4-connect/connect-opp-setup.md` (written with `parentFolderId = phaseFolderId`) — opp UUID, verification flags, payment units, ACE test-user invite URL, connect_int_id (ConnectProd integer id, from the create response)
- `run_state.yaml.phases.connect-setup.products.connect` — single atomic block with `program` (copied from `opp.yaml.connect.program` for run self-containment), `opportunity`, `ace_test_user` sub-keys. Read by `synthetic-data-generate` (`opportunity.connect_int_id`), Phase 6 mobile recipes, and other skills within the same run. Per-run only — no other run reads it.

## Process

1. **Read inputs from GDrive** (paths in `## Inputs` above).

2. **Read the PDD's `archetype:` and `## Evidence Model` section.**
   These are the inputs for steps 4–5. The Evidence Model's Layer A column
   is the spec for verification flags; Layer B/C inform soft-flag metadata.
   **If the PDD has no Evidence Model section, stop and return an error** —
   the PDD is incomplete and `idea-to-pdd` should re-run with the
   stress-test rubric.

3. **Pre-flight (LLO program-application must be ACCEPTED).** The new
   `POST /api/programs/<id>/opportunities/` endpoint validates that the
   target LLO org has an `ACCEPTED` `ProgramApplication` for the program.
   For ACE-driven dogfood runs, the orchestrator handles this in Phase 9
   (`llo-onboarding` → optionally `connect_accept_program_application`)
   *before* this skill runs. For real-LLO runs, the LLO accepts manually
   and this skill simply waits. If the application is still INVITED/APPLIED
   when this skill calls `create_opportunity`, the API rejects with
   `Organization must have an accepted application for this program.`

   **3a. Self-managed opp pre-flight (added per #106 finding 10).**
   "Self-managed" means the `target_organization_slug` equals the
   program's `organization_slug` (the LLO is the same org running the
   program — typical for ACE dogfood opps in `ai-demo-space`). For
   this pattern, no human-mediated invite-and-accept happens upstream,
   so the application doesn't yet exist when this skill runs. Detect
   and resolve:

   1. Branch on `target_organization_slug` — **three cases**
      (dimagi-internal/ace#1251):
      - **Omitted** → self-managed. Omitting does NOT waive the
        accepted-application requirement; it relocates it to the PM org
        (the REST backend sends `organization_slug` as the holding org,
        and the create rejects with `Organization must have an accepted
        application for this program`). Treat exactly like same-org:
        run steps 2–4.
      - **Equal to `organization_slug`** → self-managed; run steps 2–4.
      - **Different, non-empty** → LLO-distinct path — Phase 9 already
        handled the round-trip; skip this sub-step.

      (Pre-#1251 this step read "if they differ, skip" — which on
      `('ai-demo-space', undefined)` reads as *differ → skip*, exactly
      backwards: the omitted case is the one that needs the round-trip
      most, and it is the documented-correct choice for a no-LLO PDD.)
   2. Self-managed case: run the round-trip below **unconditionally** —
      attempt the transition and treat the conflict as the skip
      (CLAUDE.md § Conventions). Do NOT try to read the application
      state first: no list-program-applications atom exists, and in
      seeded `/ace:iterate` runs Phase 8/9 are `skipped` so
      `connect-setup/llo-invite_invitations.md` doesn't exist either.
      If `connect_send_llo_invite` / `connect_accept_program_application`
      reports the application already exists or is already accepted,
      **that IS the skip signal** — log it and continue. Branch on the
      call result, never on a read-back flag.

      **The skip response carries no id — do not go looking for one.**
      Connect's rejection body is `{error: 'validation_error', fields:
      {organization: ['Organization already has an application for this
      program.']}}` and names no `application_id` anywhere (observed on
      `hh-poverty-targeting/20260828-0702`, ace#1800). That is fine: the
      create derives the application server-side from
      `(target_organization_slug, program_id)`, so nothing downstream
      needs the id on this path. Note also that this error does NOT
      distinguish `INVITED`/`APPLIED` from `ACCEPTED` — if the existing
      application is merely pending, `connect_create_opportunity` is what
      fails, loudly, with `Organization must have an accepted application
      for this program.` Let that be the check; do not infer acceptance
      from the skip alone.
   3. The round-trip:

      ```
      mcp__plugin_ace_ace-connect__connect_send_llo_invite({
        organization_slug,                      // PM-side org running the program
        program_id,
        organization: organization_slug,        // the org being invited — SAME org here
      })
      mcp__plugin_ace_ace-connect__connect_accept_program_application({
        organization_slug,
        program_id,                             // REQUIRED — the accept is program-scoped
        application_id: <returned>,             // ProgramApplication UUID from the invite response
      })
      ```

      **Do not paraphrase these signatures — the parameter names above are
      the atoms' real ones, per `docs/atom-schemas.md`.** Every name in
      this block was wrong until ace#1800: `connect_send_llo_invite` takes
      `organization` (not `target_organization_slug`), and
      `connect_accept_program_application` takes
      `organization_slug` / `program_id` / `application_id` (not
      `target_organization_slug` / `program_application_id`, and it had
      dropped `program_id`, which is required). The wrong block was
      invisible because it only executes on the FIRST Phase 4 run of a
      program in a fresh PM org — every later run short-circuits on
      "Organization already has an application for this program" and never
      reaches the accept call.

      Capture `application_id` from the invite response;
      `create_opportunity` may want it as a conditionally-required
      input depending on Connect's contract evolution. (The original
      `POST /api/programs/<id>/opportunities/` derives it server-side
      from `target_organization_slug` + `program_id`, but newer
      versions may require it explicitly — passing it doesn't hurt.)

   4. Log the round-trip result to `comms-log/observations.md` so the
      operator can audit the silent state mutation. This is the only
      Phase 4 step that mutates Connect state outside the opp
      itself.

4. **Create the opportunity** via `connect_create_opportunity`.

   **⚠️ Single-active-opp invariant (per-program, per-application).**
   Connect enforces "one active managed opportunity per accepted
   `ProgramApplication`." Creating a new managed opp on a program where
   a prior opp is currently `active=true` (under the same accepted
   application) will *deactivate* the prior opp as a side effect of
   the accept-application step in 3a. This was a silent surprise in
   the leep-paint-collection run (see #106 finding 11) — the prior
   `LEEP Paint Surveillance — India v1` opp flipped from active to
   inactive without warning when this skill recreated the opp.

   Before calling `create_opportunity`, list active opps for this
   program and surface a `[WARN]` line in the gate brief if any
   exist:

   ```
   mcp__plugin_ace_ace-connect__connect_list_opportunities({
     organization_slug,
     hydrate: true,            // REQUIRED — see below
   })
   ```

   **`hydrate: true` is not optional, and do NOT pass `program_id`
   (ace#1022).** The opportunity LIST page carries only id / name / short
   description. Until #1022 this atom hardcoded `active: false` on every
   row, so this WARN could **never fire** — the silent-deactivation
   surprise it exists to catch was undetectable by it. It also accepted
   `program_id` and silently ignored it, returning the whole org (live: 20
   opportunities from four other programs for a program that had zero).
   Now `program_id` is refused loudly, and `active` is **absent** unless
   you hydrate — a missing value you must handle, rather than a fabricated
   one you cannot tell from a real one. `hydrate: true` fetches each row
   through `get_opportunity`, which parses the real toggle off the edit
   form. Filter to this program yourself from the hydrated rows.

   For each opp where `active=true`, write to the gate brief:
   `[WARN] Creating opp "<new-name>" will deactivate prior active
   opp "<old-name>" (id=<old-uuid>) — same program, same accepted
   application. Confirm intent or close prior opps first.`

   The auto-mode default is to proceed (matches current Phase 9
   gate-brief auto-approval). Review-mode pauses for explicit operator
   confirmation. An idempotent-resume path that detects an existing
   matching opp and asks before recreating is tracked as future work.

   **Endpoint:** the new endpoint is
   `POST /api/programs/<program_id>/opportunities/` and takes the
   full opp config in one shot — including dates, total_budget, and
   structured `learn_app` / `deliver_app` payloads. The server resolves
   HQ creds, registers HQApiKey records as needed, fetches app names
   from CommCareHQ synchronously, and syncs learn modules + deliver
   units in the same transaction. Args:

   - `organization_slug`: PM-side org (e.g. `ai-demo-space`)
   - `program_id`: from step 1 (program.md)
   - `name`: **construct as `"<run_id> · <PDD display name>"`** — the
     `run_id` from run_state (format `YYYYMMDD-HHMM`) as a FRONT prefix,
     separated by ` · ` (space-middot-space, U+00B7), then the PDD
     display name. Example: `"20260601-0739 · Malaria RDT Performance
     Sampling"`. **The run-id MUST lead.** Why front-prefix: the ACE
     test user accumulates dozens of near-identical opp invites across
     dogfood runs, and the run-id is the only token that disambiguates
     THIS run's opp from all the others. As a front prefix it lands on
     the tile's FIRST line — short and never clipped by the tile's
     name-wrap — so Phase 6's mobile claim/resume recipes can anchor
     their tile match on it (`text: ".*${OPP_RUN_ID}.*"`) and find this
     run's opp deterministically. The old run-id-SUFFIX form
     (`"<display> — <slug> (run <run-id>)"`) put the discriminator at
     the END of a long name that wraps to 2-3 lines on the tile — the
     most-clipped position — which is exactly the wrong place for the
     matcher. (Applies to ACE-driven dogfood runs — same `is_test: true`
     framing as below.) **Code-enforced** since jjackson/ace#755: the
     `connect_create_opportunity` atom rejects an `is_test: true` name
     without the run-id front prefix (`INVALID_OPP_NAME_PREFIX`,
     `mcp/connect/opportunity-name.ts`) before any network call.
   - `short_description`: **≤50 chars** (server-enforced; the Connect
     opportunity edit form rejects longer values with a generic
     `Ensure this field has no more than 50 characters` error).
     Truncate the PDD's intervention summary to a one-line headline
     and stash the long-form intent in `description`. Mobile-app-facing.
   - `description`: **default to ≤250 chars** — a single-paragraph
     headline. The Connect server has an undocumented length threshold
     where HTTP 500s start firing intermittently around ~700 chars;
     trimming to ~250 cleared the path on leep-paint-collection (see
     #106 finding 7). Stash the full PDD intervention prose in the
     opp's Drive summary doc and link to it from the headline. When
     the server-side length cap is widened safely, drop this guidance.
   - `target_organization_slug`: LLO org slug (must be ACCEPTED — see step 3)
   - `start_date` / `end_date`: opportunity dates (YYYY-MM-DD; must fit
     inside the program window)
   - `total_budget`: an integer in the opp currency's whole unit (Connect
     stores `total_budget`, `amount`, `org_amount`, `max_total` as integers
     in the SAME unit — `PositiveBigIntegerField` / `PositiveIntegerField` in
     `commcare_connect/opportunity/models.py`; no cents). Two bounds, both
     mandatory:
     - **Upper bound (ceiling):** must fit inside
       `program.budget − Σ(other managed opps)`.
     - **Lower bound (floor — funds ≥1 FLW):** must be
       `≥ min_budget_for_one_user × FUND_USERS`, where
       `min_budget_for_one_user = Σ over the opp's planned payment units of
       (max_total × (amount + org_amount))` and `FUND_USERS` is a small smoke
       headroom (**default 3**) so a few claims are possible. This mirrors
       Connect's managed-opp capacity formula
       `number_of_users = total_budget / Σ(max_total × (amount + org_amount))`
       (`Opportunity.number_of_users`, models.py): a `total_budget` below
       `min_budget_for_one_user` yields `number_of_users < 1`, which
       under-allocates `create_claim_limits` and leaves the FLW unable to
       claim a full visit allotment.
     - ACE computes `min_budget_for_one_user` from the **planned** payment
       units — known from the PDD's deliver design BEFORE create — and sizes
       `total_budget` to `≥ min_budget_for_one_user × FUND_USERS` clamped by
       the ceiling. The PDD's program budget is a HINT/ceiling, NOT the opp
       budget: if the PDD budget is too small to fund even one user at the
       planned payment units, **the opp-budget floor WINS** and the program
       budget must be raised to accommodate (see `connect-program-setup`
       headroom, jjackson/ace#588). Archetype-agnostic — applies to every opp.
   - `is_test`: **set explicitly to `true`** for every ACE-driven run. The
     server defaults to `true` if omitted, but sending it explicitly makes
     the value visible in the create-response and auditable in the
     verify-after-create check below. ACE is in dogfood mode — every opp
     it stands up is for engineering exercise, NOT a production rollout —
     so the test flag must be on. The eventual production-grade opp (post-
     dogfood) will flip this to `false`; that flip will be a deliberate
     operator decision, not a defaulted-off slip.
   - `learn_app`: `{ hq_server_url, api_key, cc_domain, cc_app_id, description, passing_score }`
     - `hq_server_url`: full URL (e.g. `https://www.commcarehq.org`)
     - `api_key`: the **raw 40-char HQ API key** for the project space
       (read from `~/.claude/plugins/data/ace-ace/.env` → `ACE_HQ_API_KEY`).
       Server creates the `HQApiKey` record if it doesn't exist.
     - `cc_domain`: HQ project space slug
     - `cc_app_id`: bare 32-char HQ app id
     - `description`: required (Connect form marks it `*`); pulled from PDD
       § Training Plan
     - `passing_score`: 0–100. **Read it from
       `run_state.yaml.phases.idea-to-design.products.pdd.program_parameters.learn_passing_score`
       — that is the typed handoff and it is authoritative.** Fall back to the
       PDD's § Program Parameters table, then to 80 ONLY when the PDD decides
       nothing; when you fall back, say so explicitly in the step log and in
       `comms-log/observations.md`, because a defaulted gate is a program
       decision ACE made on the operator's behalf.

       **This value cannot be set anywhere else.** Nova's `connect.assessment`
       exposes only `{id, user_score}` — there is no `passing_score` slot — so
       this call is the ONLY place the Learn gate is established. It is a
       required field on the atom, so it cannot be omitted, only set wrong.
       Getting it wrong is silent: the app still builds, the worker still sees
       a result screen, and only the gate is different from the one the program
       specified. On `bednet-check-2-visit/20260813-2313` the PDD specified a
       source-stated 6-of-6 gate (100); with percentage scoring over six items
       5-of-6 is 83.3, so defaulting to 80 would have passed a worker who got
       one wrong, against an explicit program decision that they must not.
   - `deliver_app`: `{ hq_server_url, api_key, cc_domain, cc_app_id }`
     — `cc_app_id` MUST differ from `learn_app.cc_app_id` (server-validated)
   - `auto_activate`: **pass `false` explicitly** (it is also the atom
     default since #584). This skill's ordering is create (Step 4) →
     create payment unit(s) (Step 6) → activate (Step 6.5). Activation
     requires at least one PaymentUnit; `auto_activate: true` would try to
     activate at create time before any PU exists, which Connect rejects
     ("At least one payment unit must exist before activating") AND rolls
     back the entire create — leaving no `opportunity_id` and an orphan
     inactive opp. Create the draft here, then activate in Step 6.5.

   The response includes `opportunity_id` (UUID), the resolved app names,
   and arrays of `learn_modules` / `deliver_units` already synced from HQ.
   Capture `opportunity_id` for downstream steps. **Don't** call
   `connect_list_deliver_units` after this — the create response already
   carries the full list under `deliver_app.deliver_units`.

   **App-wire fields are write-once at create.** Connect's `/edit` form
   does NOT expose `learn_app` / `deliver_app` — they're only set at create.
   `connect_update_opportunity` only covers `name` / `short_description` /
   `description` / `end_date` / `is_test`. **If Phase 3 re-uploads an app
   after this skill ran, the existing opp is wired to a stale (now-abandoned)
   HQ id** — the recovery is **manual deletion in the Connect web UI**
   (Connect's `delete_opportunity()` helper exists in
   `commcare_connect/opportunity/deletion.py` but no Django view exposes
   it yet; see `skills/sweep-connect/SKILL.md § Implementation notes`)
   followed by `connect_create_opportunity` against the canonical HQ ids,
   then update the current run's
   `phases.solicitation-management.products.solicitation.connect_opportunity_id`
   to the new UUID. **This recovery is low-cost.** A labs solicitation
   already published for this opp is unaffected: solicitations are
   scoped to the labs `program_id`, not to any specific Connect
   opportunity UUID (`connect_opportunity_id` is ACE-side bookkeeping
   recording ACE's intended target, not a labs-side foreign key — see
   `skills/solicitation-create/SKILL.md`). The public solicitation
   URL, deadline, and pending applications all continue uninterrupted.
   CCC-301 will eventually retire this dance by exposing
   `update_opportunity({learn_app, deliver_app})`.

   **Verify-after-create (mandatory).** Immediately after the create
   response returns, call `connect_get_opportunity({organization_slug,
   opportunity_id})` and compare what was sent against what the server
   stored.

   **⚠️ Only some of those fields are READABLE at this point
   (dimagi-internal/ace#1647).** A never-activated opportunity renders
   only the edit-form half of `connect_get_opportunity`'s hydration; the
   dashboard half returns nothing until the opp has been through
   `/activate/` (Step 6.5). A Write→Read→Compare that cannot read is
   worse than no check — it reports confidence it does not have — so the
   list below is split, and the unreadable half is **deferred to Step
   6.6**, not asserted here.

   *Verified live on `bednet-check-2-visit/20260825-1310` Phase 4: the
   same opp read twice through the same atom, ~2 min apart either side of
   activation. Pre-activation the payload carried `name`,
   `short_description`, `description`, `end_date`, `is_test`, `active`,
   `currency`, `country` and nothing else; post-activation it also
   carried `total_budget`, `start_date`, `program_name`, `learn_app` and
   `deliver_app`. Upstream half tracked as #1637.*

   **Verify HERE (readable pre-activation):**
   - `name`, `short_description`, `description` — string match
   - `end_date` — `YYYY-MM-DD` match (the `turmeric-20260503` run hit a
     write-vs-read drift where `end_date=2026-08-09` was accepted by
     create but `connect_get_opportunity` returned `""`; this read-back
     is the canary)
   - `is_test` — boolean match

   **DEFER to Step 6.6 (unreadable pre-activation — do NOT assert here):**
   - `start_date` — `YYYY-MM-DD` match
   - `total_budget` — numeric match
   - `learn_app.cc_app_id` and `deliver_app.cc_app_id` — bare 32-char match

   **An absent field is `unreadable-at-this-point`, never a match.** If
   any DEFERRED field unexpectedly IS present in this read, compare it —
   a present value is real. But never record a comparison you did not
   perform: write `unreadable-at-this-point (deferred to Step 6.6)`
   against each one you skipped, in `comms-log/observations.md` and in
   whatever verification summary this step reports. Silently counting an
   absent field as a pass is the exact defect #1647 fixed; the sibling
   class is ace#1449 below, where a field the read surface does not
   render came back `undefined` and read as "unreadable" rather than
   "mismatch".

   Also check:
   - `passing_score` — numeric match. **Read it with
     `connect_get_learn_passing_score({organization_slug, program_id,
     opportunity_id})`, NOT from `connect_get_opportunity`** (ace#1449).
     `connect_get_opportunity` hydrates from `/a/<org>/opportunity/<id>/edit`
     plus the read-only detail page, and `learn_app_passing_score` is rendered
     on **neither** — it lives only on the program-scoped init-edit form. So
     this comparison silently had nothing to compare against: the field came
     back `undefined`, which reads as "unreadable", not as "mismatch". There is
     no REST alternative — commcare-connect's automation API (PR #1135) ships
     no opportunity GET endpoint at all.

     Two return values that are NOT the same thing:
     - `passing_score: null` — the input rendered EMPTY, i.e. the gate is
       **unset**. Do not coerce that to `0`; `0` means "every worker passes",
       the most permissive possible gate, and is the opposite of unconfigured.
     - the atom THROWS — the field is absent from the form altogether, meaning
       the form shape changed. Treat as `[BLOCKER]`; do not substitute a
       default, or you will report a gate value ACE invented as one Connect
       stored.

     **Severity depends on whether the PDD decided the value**, because the two
     cases mean different things:
     - The PDD stated a gate (`program_parameters.learn_passing_score` is
       set) and the read-back differs → **`[BLOCKER]`**. The gate the
       program specified is not the gate that is live, this call is the
       only place it can be set, and nothing downstream re-checks it. Do
       not proceed; log both values to `comms-log/observations.md`.
     - ACE defaulted the value (the PDD decided nothing) and the server
       returned its own → `[INFO]`; document the diff and proceed.

     The pre-2026-08-14 rule made this `[INFO]` unconditionally, on the
     reasoning that "Connect's server has its own default". That is true
     and irrelevant when the PDD stated a gate: a server default silently
     overriding an explicit program decision is precisely the drift this
     read-back exists to catch.

     **On a mismatch, name ROW REUSE as the first suspect — not server
     drift** (dimagi-internal/ace#1350). Connect keys `CommCareApp` on
     `(cc_app_id, cc_domain, organization, hq_server)`, **not** on the
     opportunity, and the create path calls
     `_build_commcare_app(update_existing=False)`. So when a `CommCareApp`
     row already exists for this `cc_app_id`, `get_or_create`'s `defaults`
     are IGNORED and the `passing_score` you just posted is **silently
     discarded** — the opportunity inherits whatever an earlier one set.
     The POST looks perfectly healthy; only this read-back sees it.

     That is the likeliest cause of "posted 100, read back 80", and it
     looks nothing like a server default, so say so in the `[BLOCKER]`:

     > `passing_score` mismatch on `<opp>`: sent `<X>`, server returned
     > `<Y>`. Most likely cause is CommCareApp ROW REUSE — Connect keys
     > that row on `(cc_app_id, cc_domain, organization, hq_server)`, not
     > on the opportunity, and the create path ignores `defaults` for an
     > existing row. Repair with `connect_set_learn_passing_score` — and
     > note it will move the gate for EVERY opportunity in this org wired
     > to the same HQ Learn app, so check `previous_passing_score` in its
     > response before accepting the change.

     ACE normally avoids this because every `/ace:run` builds a fresh Nova
     Learn app, so every create posts a new `cc_app_id` and always takes
     the `created=True` branch. That invariant breaks on a forked run, a
     hand-wired opp, or a Phase 4 re-mint against the same release —
     exactly the cases where a mid-run operator is least expecting it.

     **Do not eyeball the severity — call
     `classifyPassingScoreReadback` from `lib/passing-score-readback.ts`**
     with `{posted, readBack, pddDecided}`. It also names the CAUSE, which
     the `[BLOCKER]` alone did not, and returns the repair (ace#1350):

     > A mismatch here is almost certainly **not** server drift. Connect's
     > create path runs
     > `CommCareApp.objects.get_or_create(cc_app_id, cc_domain, organization,
     > hq_server, defaults=...)` with `update_existing=False`, and the row is
     > keyed on the **app**, not the opportunity. If a row for this
     > `cc_app_id` already exists in this org, `get_or_create` ignores
     > `defaults` and **the posted `passing_score` is silently discarded** —
     > the opportunity inherits whatever an earlier one set.

     On the `blocker` verdict, apply the returned repair —
     `connect_set_learn_passing_score(posted)` — then re-read. **Surface its
     `caution` in the gate brief:** the score lives on the shared
     `CommCareApp` row, so the repair moves the gate for **every**
     opportunity in the org wired to this HQ Learn app. Record the
     `previous_passing_score` the atom returns.

     ACE has escaped this only by an unstated invariant — every `/ace:run`
     builds a fresh Nova Learn app, so every create posts a new `cc_app_id`
     and takes the `created=True` branch. It breaks the moment anything
     reuses an HQ Learn app: a forked run, a hand-wired opp, a Phase 4
     re-mint against the same release, or an opp created against a prior
     run's app to save a build.

   **Action on mismatch:**
   - `end_date` (or any DEFERRED field that did read, and disagreed) →
     `[BLOCKER]` in the gate brief; log the diff to
     `comms-log/observations.md` with both values; do NOT proceed to
     Step 5. The opp is in an unknown state — operator must inspect via
     the Connect web UI before continuing. (The deferred fields get the
     same `[BLOCKER]` treatment at Step 6.6, where they are readable.)
   - Description / is_test disagreement → `[INFO]` log to observations;
     proceed.
   - `passing_score` disagreement → severity per the rule above:
     `[BLOCKER]` when the PDD stated the gate, `[INFO]` when ACE defaulted.

   This step costs one extra HTML-driven `connect_get_opportunity` call
   (~2s) and catches a class of bugs the producing skill's response
   alone cannot — server-side serialization gaps, schema drift, or
   silent overrides. The 0.11.7 ocs-chatbot-qa rework adopted the same
   "verify after every external write" discipline; this is the Connect
   side of that rule (see `agents/ace-orchestrator.md § External
   Mutations — Verify After Create`).

5. **Configure verification flags** via `connect_set_verification_flags`,
   mapping the PDD's Evidence Model Layer A to the surfaces Connect
   *actually has*. *(This atom still goes through the legacy HTML form —
   the verification config page isn't part of PR #1135's automation API.)*

   **Read this before writing anything: five of the eight documented
   flags no longer exist on Connect's form (dimagi-internal/ace#1013).**
   `duplicate`, `gps`, `gps_radius_meters`, `catchment_areas` and
   `deliver_unit_checks[].check_attachments` are still *accepted* by the
   atom for back-compat, but the corresponding inputs are ABSENT from the
   page — Django drops them and the atom **still returns `ok: true`**.
   Setting them does not enforce anything; it only writes an artifact that
   claims enforcement which does not exist. **Do not send them.** Record
   the affected Layer A rules as `[PLATFORM]` gaps in the phase summary
   and name where they are enforced instead (usually the CCZ).

   What works today:

   - `form_field_rules` — **the only surface on which a PDD Layer A
     predicate can be enforced server-side.** One entry per
     `(question_path, question_value, deliver_unit_id)` the predicate
     requires. Additive and idempotent.
     - **`question_path` is a JSONPath into the HQ form-JSON doc, NOT an
       XForm XPath.** Connect evaluates it as
       `jsonpath_ng.ext.parse(f"$.{question_path}")` against the whole
       forwarded document, in which HQ nests the instance under `form` —
       so the CCZ's `/data/meeting_basics/meeting_conducted` is written
       here as **`form.meeting_basics.meeting_conducted`**. An XPath makes
       that parse raise, the receiver 500s on the HQ→Connect forward, and
       **every payable visit is lost while the device still shows "1 form
       sent to server!"** (observed on `spark-facilitator/20260813-2126`,
       dimagi-internal/ace#1301 — HQ motech log recorded a 500 for the
       deliver form while every non-payable form on the same app got 200).
       The atom normalises `/data/a/b` → `form.a.b` for you, but write it
       correctly so the artifact reads truthfully.
     - **Read the group/question names out of the RELEASED CCZ, never
       from the PDD's prose.** The PDD quotes the partner's original app;
       Nova rebuilds the form and routinely flattens or renames groups, so
       the PDD path can name a node that does not exist — and a rule
       matching no node enforces nothing while reporting success. Download
       the released CCZ (`commcare_download_ccz` with `write_to_path`),
       read the payable form's `<bind nodeset=...>` list and its
       `<select1>` `<value>` options, and translate each nodeset to
       `form.<...>`. (Live example: PDD said
       `/data/community_meeting/meeting_type`; the released CCZ bound it
       at `/data/meeting_type`, so the rule is `form.meeting_type`.)
     - `question_value` is the **stored** option value, never the display
       label.
     - `deliver_unit_id` is the DU `server_id` — same value
       `required_deliver_units` takes, not the per-opp display index.
     - `name` is capped at **25 chars**; a longer name silently fails the
       WHOLE formset.
     - **Verify via `form_field_rules_saved` in the response** — the count
       Connect actually persisted. It is the only evidence the write
       landed; compare it against the number of rules you sent. But note
       what it does NOT prove: ace#1301 shipped two rules that persisted
       fine and then crashed Connect's receiver on every payable visit,
       because "Connect stored the string" and "Connect can evaluate the
       string" are different claims. The end-to-end proof is Phase 6's
       `connect_get_deliver_progress` showing `delivered >= 1`.
   - `form_submission_start` / `form_submission_end`: HH:MM:SS — set
     only if the PDD has time-of-day plausibility constraints.
   - `deliver_unit_checks[].duration_minutes` — MINUTES, matching the
     form's own help text. Set only if the PDD states a minimum delivery
     duration. (The old `duration_seconds` spelling is now REFUSED with a
     typed error rather than silently writing a 60x-too-long floor —
     ace#1013.)
   - **Any other flag is refused, not dropped.** `gps`, `duplicate`,
     `catchment_areas`, `gps_radius_meters` and `check_attachments` have no
     input on the live form, so a truthy value now raises
     `unsupported_verification_flag` BEFORE the POST. That is deliberate:
     the atom used to accept them, Django dropped them, and it returned
     `ok: true` — which is how six opportunities across 2026-06-06..07-28
     reported "verification flags configured" with nothing persisted. If
     the PDD needs one of these predicates, express it as a
     `form_field_rules` rule or cite the CCZ-side enforcement; do not
     re-send the dead flag.

   Layer A rules that none of these can carry (photo-present, date sanity,
   cross-field consistency, dedup) are normally already enforced *in the
   CCZ* — cite that in the summary rather than leaving the rule looking
   dropped.

6. **Configure payment units** via `connect_create_payment_units` (plural,
   atomic batch — the new automation API takes a list). Build one entry
   per unit in the PDD's payment plan; the entire request is rejected if
   any unit is invalid.

   **ALWAYS pass `total_budget`** (the same whole-unit integer you set on
   the opportunity in Step 4) as a top-level arg to
   `connect_create_payment_units` / `connect_create_payment_unit`. The MCP
   uses it to enforce the funds-≥1-FLW guard **in code** — it computes
   `number_of_users = total_budget / Σ(max_total × (amount + org_amount))`
   over the integers in the request and **rejects with `opportunity_underfunded`
   BEFORE creating any PU** when `< 1` (jjackson/ace#729). This is the
   authoritative guard; it cannot be fooled by a dollars-vs-cents mix the way
   the old hand-computed check could. If you get `opportunity_underfunded`,
   the opp is genuinely unclaimable — raise `total_budget` (and the program
   budget), lower `max_total`, or fix the `amount` unit; do NOT retry
   unchanged. Per-unit fields:
   - `name`: descriptive (e.g. `"Per verified visit"`)
   - `description`: payment criteria
   - `amount`: per-unit FLW pay from PDD. **MUST be a non-negative
     integer in WHOLE currency units** (e.g. whole USD), NOT cents.
     Connect stores `amount`, `org_amount`, and `total_budget` as plain
     integers in the SAME whole-currency unit — verified against
     commcare-connect `opportunity/models.py`: `PaymentUnit.amount` and
     `org_amount` are `PositiveIntegerField`, `Opportunity.total_budget`
     is `PositiveBigIntegerField`; no cents, no decimals. The serializer
     rejects floats. If the PDD specifies a fractional rate (e.g.
     `$1.50`), **round to the nearest whole unit** (`$1.50` → `2`) and
     log an `[INFO]` to `comms-log/observations.md` noting the rounding.
     - **NEVER pass cents.** `$1.50` → `150` is a 100× overpay: Connect
       reads `150` as **$150 per visit**, which (a) renders the wrong
       number on the FLW Download gate ("Earn up to N USD for visit")
       and (b) inflates `Σ(max_total × (amount + org_amount))` 100×, so
       the budget guard below demands a 100×-too-large `total_budget`
       and `number_of_users = total_budget / Σ(...)` collapses below 1
       → the FLW physically cannot claim the opp (no `OpportunityClaim`
       is created). Caught live on `bednet-spot-check/20260605-2303`: a
       `$1.00` intent passed as `100` showed "Earn up to 100 USD for
       visit" and made a `$100` program budget fund 0.008 users.
     - Never silently truncate (`$1.50` → `1`) — that's where the
       prior `turmeric-20260503` run produced a malformed PU.
     - **Sub-\$1 rates round UP to the \$1 minimum, never to cents.** A
       PDD smoke rate like `$0.50` is NOT representable in whole USD —
       use `1` (the minimum payable whole unit) and log an `[INFO]`. Do
       NOT reach for cents (`50`) to preserve the half-dollar: Connect
       reads `50` as **$50/visit**, which is the exact mix that shipped
       an unclaimable opp on `bednet-spot-check/20260606-2013`
       (`amount=50, total_budget=50` → `number_of_users=0.05`). If the
       PDD genuinely needs sub-dollar economics, that's a PDD/program
       issue to raise, not a cents workaround.
   - `org_amount`: per-unit LLO pay — **REQUIRED for managed opps**.
     Same WHOLE-currency-unit integer constraint as `amount` (NOT cents).
     (Note: commcare-connect commit
     `4c430de3` loosened this validation on 2026-04-29 to accept `0` —
     before that fix, falsy values were rejected with
     `org_amount is required for managed opportunities.`)
   - `max_total`: total visits per user across the opportunity (≥1)
   - `max_daily`: visits per user per day (≥1)
   - `start_date` / `end_date`: optional; default to opportunity dates
   - `required_deliver_units`: which DU ids MUST be completed for this
     payment to trigger. **Pass `du.server_id`, not `du.id`.** As of
     0.13.126 `connect_list_deliver_units` populates `server_id` (the
     server-side primary key Connect's DB uses) on each returned DU by
     reading the create-payment-unit form's checkbox values; this is
     the field the create endpoint accepts. `du.id` is the per-opp
     display index (1, 2, 3…) and is rejected by the server as
     "Invalid Data". The MCP backend has a name-mapping fallback that
     accepts `du.id` and maps it for you, but passing `server_id`
     directly is the documented happy path. **Every payment unit MUST
     carry at least one `required_deliver_units` id — this is a hard
     pre-create gate, not a nicety.** Before calling
     `connect_create_payment_units`, assert each unit's
     `required_deliver_units` is non-empty (wire the just-synced DU
     `server_id`(s) from Step 4's `connect_list_deliver_units` onto the
     unit — for a single-DU app that's the one DU's `server_id`). An
     empty `required_deliver_units`: (a) fails the opp's
     `is_setup_complete`; (b) blocks Phase 8 `connect_send_flw_invite`
     and Phase 6 mobile screenshot capture (the FLW can't claim the
     opp); and (c) makes Phase 7 synthetic accrual mint
     `completed_works: 0` / `completed_module: 0` regardless of how many
     visits are generated — the engine attributes completed work to a
     unit's required DUs, so with none there is nothing to attribute
     (jjackson/ace#843, confirmed live on
     `hh-poverty-targeting/20260702-1456`: a PU existed but
     `required_deliver_units: []` → 498 visits, 0 completed works).
     Closes jjackson/ace#106 finding 5 + jjackson/ace#843.
   - `optional_deliver_units`: which DUs are bonus/optional. **No DU id
     may appear in `required` and `optional` of the same unit, AND no DU
     may appear in two payment units in the same request** — the server
     rejects the whole batch.

   Use `connect_create_payment_unit` (singular) only when adding a single
   PU after the fact; under the hood it sends a 1-item list to the same
   endpoint and shares the same validation rules.

   **Verify-after-create (mandatory) — the CREATE RESPONSE is the
   authoritative round-trip source.** `connect_create_payment_units`
   returns Connect's own post-persist serialization of each stored PU.
   That object — not a follow-up list call — is what you assert against
   the request payload. Per unit, check:
   - `name`, `amount`, `org_amount`, `max_total`, `max_daily` — exact
     match against the request payload.
   - `required_deliver_units` — **must be non-empty** AND array length
     matches request AND contains the same DU ids (order may differ). A
     genuinely empty `required_deliver_units` **in the create response**
     is a `[BLOCKER]` even if the rest of the unit matches (it zeroes
     Phase 7 accrual — see the create-time gate above, jjackson/ace#843).
   - `optional_deliver_units` — same.

   **Do NOT gate on `connect_list_payment_units` for these fields.** That
   atom's HTML-scraped read path cannot see them: `required_deliver_units`
   and `optional_deliver_units` come back `[]`, and `description` comes
   back `""`, **unconditionally** — the listing renders DU display names
   in an Alpine.js template with no server ids (pinned by
   `test/mcp/connect/unit/html-scrape.test.ts` "still cannot parse
   deliver-unit server IDs from the listing"). So an empty
   `required_deliver_units` from the list call is a constant of the read
   path, carrying zero information about stored state — halting on it
   halts every healthy run. Observed live on
   `spark-facilitator/20260813-2126`: the create response carried
   `required_deliver_units: [6617]` while the list call on the same PU
   returned `[]`, and the opp activated normally (Connect only permits
   activation when a valid PaymentUnit exists). Same divergence on
   `bednet-spot-check/20260728-2222`. Tracked as dimagi-internal/ace#1026
   (consolidated into the #1022 read-back umbrella); until the atom either
   parses the DU column or omits what it cannot read,
   `connect_list_payment_units` is corroboration on **`payment_unit_uuid`
   and `name` only**.

   **`id` is NOT on that list — it is a per-opp display index, not the
   server PK (dimagi-internal/ace#1642).** The listing's first column is
   the row's `#`, so the same PU that `connect_create_payment_units`
   returned as `id: 2495` reads back as `id: 1` seconds later (observed
   on `bednet-check-2-visit/20260825-1310`, opp
   `7cea3952-8375-43ca-979f-53db29302409`). Passing the list's `id`
   anywhere a server id is required reproduces the `du.id` vs
   `du.server_id` "Invalid Data" rejection this step already warns about
   for deliver units. **The durable identifier is
   `payment_unit_uuid`** — it matches the create response's
   `payment_unit_id` exactly and is the only field safe to key on.

   The check's intent stands — an unwired payment unit is exactly the
   #843 class and must still be caught. It is caught at the create
   response (and, end-to-end, by Phase 6's
   `connect_get_deliver_progress` showing `delivered >= 1`). What
   changed is only which source is authoritative.

   **Action on any mismatch in the create response:** halt with a
   `[BLOCKER]` in the gate
   brief specifying the exact field divergence (sent vs. stored). Log
   the full sent payload AND the full server response to
   `comms-log/observations.md`. Do NOT proceed to Step 7 — a malformed
   PU cascades through `is_setup_complete` and silently breaks every
   downstream skill (Phase 8 invites, Phase 6 screenshots). Operator
   recovery is delete + recreate via the Connect web UI; a
   connect-delete-payment-unit atom (*not yet built*) would let the
   skill self-heal.

   This guard is the producer-side complement to the
   `connect-program-setup-eval` rubric. The eval correctly graded a
   malformed PU as `payment_unit_fit: 5.0` (warn) on the
   `turmeric-20260503-0835` run, but by then Phase 4 had already
   handed off to Phase 5 with corrupted state. Catching the
   malformation at the source converts a multi-phase cascade into a
   single-skill halt.

   **Budget-funds-≥1-FLW guard — now enforced in MCP code (jjackson/ace#729).**
   You do NOT hand-compute this guard. When you pass `total_budget` to
   `connect_create_payment_units` (Step 6), the connect MCP computes
   `number_of_users = total_budget / Σ(max_total × (amount + org_amount))`
   over the request integers and **rejects with `opportunity_underfunded`
   BEFORE creating any PU** when `< 1`. This supersedes the hand-computed
   prose check that shipped in #722 — that check failed live on
   `bednet-spot-check/20260606-2013` because the agent evaluated it in
   dollars (`$0.50`) while storing cents (`50`), so `number_of_users` read
   as 5 in-head but 0.05 in Connect. Code over the sent integers can't make
   that mistake. **This is the silent root behind the Phase-6 Deliver
   "Unable to claim" / no-`OpportunityClaim` class.**

   On `opportunity_underfunded`: the create did NOT happen (no orphan PU).
   Write a `[BLOCKER]` to `comms-log/observations.md`, set
   `phases.connect-setup.status: error` in the current run's
   `run_state.yaml`, and **HALT** — do NOT activate or hand off to Phase 6.
   Remediate by raising `total_budget` (and the program budget — see the
   Step 4 floor + `connect-program-setup`), lowering `max_total`, or fixing
   the `amount` unit; then re-run. Do NOT retry unchanged. The error payload
   carries `total_budget`, `min_budget_for_one_user`, `number_of_users`, and
   a per-PU `breakdown` for the remediation message. The Step 4 `total_budget`
   floor sizes it right going in; this code guard is the structural backstop
   that makes an underfunded opp impossible to ship regardless of agent
   unit-reasoning.

6.5. **Activate the opportunity in Connect** (REQUIRED for ACE-driven runs;
   prerequisite for Step 7's test-user invite).

   ACE's dogfood pipeline activates the opp here, in Phase 4, so the ACE
   test user can be invited synchronously and Phase 6
   `app-screenshot-capture` can drive the AVD against a real opp.
   Real-LLO go-live remains a separate, human-gated event in Phase 9
   `llo-launch` — that skill becomes idempotent on already-active opps
   from this step (skip-and-log).

   Why this isn't a Phase 8→9 boundary violation: the opp lives in
   `connect-ace-prod` (Dimagi-controlled HQ project space) and is
   `is_test=true`. The ACE test user (`${ACE_E2E_PHONE}`) is also ACE-
   controlled. No real LLO sees this state until Phase 9's awardee
   email, which is still gated behind the unconditional Phase 8→9 pause.

   - **Always attempt the activate transition — do NOT pre-check the
     `active` flag to decide whether to call it.** Call
     `connect_activate_opportunity({organization_slug, opportunity_id})`
     unconditionally. The atom hits `POST /api/opportunities/<id>/activate/`,
     which validates that the opp hasn't ended and at least one
     PaymentUnit exists (Step 6 satisfies the latter). Returns
     `{ id, opportunity_id, name, active: true }` on success.

     **Why unconditional (jjackson/ace#624):** the managed-opp create
     endpoint returns `active: true` as a create-side flag, but that is
     NOT the `/activate/` state transition `invite_users/` (Step 7)
     requires. `connect_get_opportunity` reports `active=true` while the
     opp is still un-transitioned, so the old "skip if already active"
     pre-check skipped the only call that actually enables invites — and
     Step 7 then failed. Calling `/activate/` on such an opp **succeeds**
     (it is not yet active by the endpoint's definition); it rejects only
     an opp that already went through this same transition. So always
     call it and branch on the result, never on the read-back flag.
   - **Treat the "already active" validation error as the idempotent
     skip signal** (NOT a hard error). If the activate call rejects
     specifically because the opp already completed the `/activate/`
     transition (e.g. a Phase-4 re-run on the same opp), catch that one
     error, log `[INFO]` to `comms-log/observations.md`, and proceed to
     Step 7:

     ```
     <ISO> connect-opp-setup: opp <id> already activated; treating activate rejection as idempotent.
     ```
   - **Verify activation via Step 7's invite succeeding — NOT via the
     scraped `active` flag.** Do not call `connect_get_opportunity` to
     confirm `active=true` here: that read-back flag is the same
     create-side signal that returns `true` on an un-transitioned opp
     (see above), so it can't distinguish a real `/activate/` from a
     no-op. The authoritative confirmation is the downstream
     `connect_send_flw_invite` in Step 7 — `invite_users/` hard-rejects a
     non-active opp ("Opportunity must be active to invite users"), so a
     successful invite is the only proof the transition actually landed.
     If Step 7's invite rejects with that error, the activate didn't take
     — halt there with `[BLOCKER]`.
   - **On hard error from the activate call**, halt with `[BLOCKER]` and
     surface the server error verbatim in the gate brief. The most
     common cause is "no PaymentUnit" — Step 6's verify-after-create
     check should already have failed loudly; if we got here without
     one, the verify-after-create has a gap to file against.

6.6. **Deferred verify-after-create — re-read the dashboard fields now
   that they are readable (dimagi-internal/ace#1647).**

   Step 4's Write→Read→Compare could not see `start_date`,
   `total_budget`, `learn_app.cc_app_id` or `deliver_app.cc_app_id`: a
   never-activated opportunity renders only the edit-form half of
   `connect_get_opportunity`. Activation (Step 6.5) makes the dashboard
   half readable, so the deferred comparisons run **here**, against the
   same payload Step 4 sent.

   - Call `connect_get_opportunity({organization_slug, opportunity_id})`
     once more.
   - Compare against the Step 4 request payload:
     - `start_date` — `YYYY-MM-DD` match
     - `total_budget` — numeric match
     - `learn_app.cc_app_id` — bare 32-char match
     - `deliver_app.cc_app_id` — bare 32-char match
   - **On any disagreement → `[BLOCKER]`** in the gate brief; log both
     values to `comms-log/observations.md`; do NOT proceed to Step 7.
     A wrong `cc_app_id` means the opportunity is wired to the wrong
     CommCare app, which cascades silently through Phase 6's device walk
     and Phase 7's accrual.
   - **If a field is STILL absent after activation, that is a
     `[BLOCKER]` too — not a pass.** The read surface changed shape;
     say so verbatim rather than substituting a default or treating the
     absence as agreement. Never record a comparison you did not
     perform.

   Do not confuse this with Step 6.5's own verification: activation is
   still confirmed by Step 7's invite succeeding, never by the scraped
   `active` flag (see above). This step re-reads *stored configuration
   values*, which is a different question from *did the state transition
   land*.

7. **Pre-invite the ACE test user (REQUIRED for PersonalID registration).**

   This step is structurally load-bearing for ACE's emulator-driven mobile
   testing — not just a convenience. Two reasons ACE must invite
   `${ACE_E2E_PHONE}` to every Connect opportunity it creates:

   **(a) Claim flow:** Phase 6 `app-screenshot-capture` drives Connect mobile
   through the claim-opp flow as this user; without the invite, the opp
   won't appear in the test user's opportunity list and the screenshot
   recipe stalls.

   **(b) PersonalID registration gate (the critical reason):** Connect-id's
   `/users/start_configuration` endpoint runs an `@app_integrity` decorator
   that synchronously calls `check_number_for_existing_invites(phone)` over
   HTTP to connect.dimagi.com. **For phone numbers with NO existing invite
   anywhere in Connect, this lookup hangs long enough to trip gunicorn's
   worker timeout, which kills the worker via `sys.exit(1)`.** The client
   receives an empty/malformed response and force-stops (CommCare NPE on
   `getSessionFailureSubcode()`). See Sentry `CONNECT-ID-3F`.

   `POST /api/opportunities/<id>/invite_users/` validates that the opp is
   **active** and not ended. Step 6.5 above just satisfied the active
   precondition synchronously, so the invite fires here directly — no
   deferral.

   Args:
   ```
   connect_send_flw_invite({
     organization_slug: <PM-side org>,
     opportunity_id: <UUID from step 4>,
     phone_numbers: [process.env.ACE_E2E_PHONE]
   })
   ```
   The atom returns `{ status: 'queued', invited_count: N }` because the
   server invokes `add_connect_users.delay(...)` async. The `UserInvite`
   row + SMS go out within a few seconds. Treat `queued` as success **for
   sending the invite** — but see the queued ≠ accepted caveat below.

   **`queued` is NOT proof the invite landed — read it back (ace#824/#855).**
   `invited_count: N` only confirms Connect enqueued the `UserInvite`. The
   resulting `OpportunityAccess` may have **no linked ConnectID user**, and
   Connect's mobile API filters opportunities by `opportunityaccess__user`:

   ```
   Opportunity.objects.filter(opportunityaccess__user=request.user, archived=False)
   ```

   An access with a null user matches nothing, so the opportunity is invisible
   to the device **forever** — and per the ConnectID change in `2bd03c4` it does
   NOT self-heal. Proven live 2026-07-25: a fresh invite returning
   `{status:'queued', invited_count:1}` never appeared on device through either
   an in-app sync or a swipe-refresh, while five previously-linked
   opportunities rendered fine.

   **So read it back with `connect_list_flw_invites`** (ships since ace#855;
   read-only, one authenticated GET):

   ```
   connect_list_flw_invites({
     organization_slug: <PM-side org>,
     opportunity_id: <UUID from step 4>,
     phone: '${ACE_E2E_PHONE}'
   })
   ```

   Branch on whether a row EXISTS — **not** on `claimed`:

   - **`match !== null`** → the invite is recorded. `status: 'pending'` with
     `name: null` is the NORMAL pre-claim state (acceptance happens on-device
     when Phase 6's `connect-claim-opp` claims the tile), so pending is a
     pass here. Record `invited_at` and proceed.
   - **`match === null`** (no row at all for that phone) → **WARN loudly**:
     the send reported success but Connect has no invite. That is the #824
     silent failure; name it in the phase summary rather than letting Phase 6
     discover it on AVD wall-clock.

   Do NOT gate on `match.claimed` — it reports whether the worker has already
   CLAIMED the opp, so requiring it would fail every legitimate fresh run.
   The atom throws `WorkersTableSchemaError` if Connect reshapes the workers
   table, so a parsing failure is loud rather than a false verdict.

   The claim-recipe centering bug (jjackson/ace#800 — `centerElement: true` on
   the OPP_RUN_ID title-scroll) is still the thing to rule out when a tile IS
   present and asserted-visible but won't claim; that is a recipe failure, not
   an invite-propagation one.

   Hold the invite metadata in memory for Step 10's consolidated write:

   **Collect the READ-BACK result, not just the send** — these are the exact
   field names `lib/phase-products-schema.ts` declares and
   `REQUIRED_PRODUCT_KEYS` checks at the phase boundary. Using any other
   spelling (the pre-#1286 template said `invited_phone` / `invited_at`)
   writes fields the schema does not declare: they survive only because the
   object is `.passthrough()`, so they validate clean at write time and
   contribute nothing at the boundary, and Phase 4 then fails
   `verify_phase_products` on every run and repairs by hand.

   ```
   ace_test_user = {
     phone: ${ACE_E2E_PHONE},           # or this run's minted phone — see 7b
     invite_row_present: <bool>,        # match !== null from connect_list_flw_invites — REQUIRED at the boundary
     connect_user_id: <string | null>,  # populates on CLAIM; null on a pending row is NORMAL
     status: <accepted | pending | unknown>,
     checked_at: <ISO timestamp>,       # when the read-back ran (NOT the send time)
   }
   ```

   `invite_row_present: false` is a LEGAL, contract-satisfying value — it
   records a verified-absent row, which is what Step 7's `[BLOCKER]` acts on.
   What the boundary rejects is the key being ABSENT, i.e. the read-back never
   ran. Capture `connect_user_id` and `status` for real rather than defaulting
   them — Phase 6 wants both — but do NOT read `connect_user_id` as a fault
   indicator here.

   **`connect_user_id: null` on a pending row is the NORMAL pre-claim state,
   NOT the ace#824 signature (ace#1663).** On this read path the id is not a
   view of the `OpportunityAccess.user` FK at all: `parseWorkersTable`
   (`lib/connect-flw-invites.ts`) extracts it from the **Name cell**, which
   Connect renders as a bare `-` until the worker claims the opportunity —
   so `cellText` yields null and the id stays null on *every* pending row,
   whatever the underlying link is. It populates on CLAIM, exactly like
   `name`, and null therefore carries no information about #824 at Phase 4.
   Reading it as a fault would raise a `[BLOCKER]` on every healthy run,
   since Phase 4 invites and Phase 6 claims. Verified live on
   `hh-poverty-targeting/20260824-1404`: the same atom and the same phone
   returned `connect_user_id: null` on a fresh pending invite and
   `"1277adbd0ceea89e367d"` on a CLAIMED opp of the same program.

   At Phase 4 the only #824 discriminator on this path is **row existence**
   (`invite_row_present`), which Step 7 already gates on. The linked-vs-
   unlinked distinction does not become observable until after a claim —
   Phase 6's claim attempt is what surfaces it.

   All Connect-opp-setup state is emitted in one atomic write at
   end-of-skill (Step 10). A crash between Step 7 and Step 10 loses
   the in-memory metadata; recovery is `/ace:step connect-opp-setup`
   re-run — the invite atom itself is idempotent (already-invited
   phone numbers return without error from the queued add-users
   task).

   The historical `ace_test_user_invite_pending_until_active` flag is no
   longer written. Step 6.5 activates synchronously, so the deferred-to-
   `llo-launch` branch is dead code. `llo-launch` (Phase 9) only sends
   the real-LLO invite; it does not re-fire the ACE test-user invite.

7b. **Per-run demo test user — OFF BY DEFAULT (ace#1289). Skip this entire
   sub-step unless the switch is on.**

   **Read the switch first, and read it exactly once:**
   `perRunTestUserEnabled()` from `lib/per-run-test-user.ts` — the env var is
   `ACE_PER_RUN_TEST_USER`, and it is `false` for unset / empty / `false` /
   `0` / `off` / any typo (it fails CLOSED). **If it is off, Step 7 above is
   the whole story: invite `${ACE_E2E_PHONE}`, read it back, and move on.
   Nothing below runs.**

   **What changes when it is on.** Instead of the fixed `${ACE_E2E_PHONE}`,
   this run mints its OWN demo number:

   ```
   const testUser = derivePerRunTestUser(run_state.yaml.run_id)   // lib/per-run-test-user.ts
   // → { phone: '+7426…', phoneLocal, countryCode: '+7', name: 'ACE Test <run_id>' }
   ```

   Deterministic from the run id, so a re-entered or resumed run registers the
   SAME user rather than orphaning the first one. Send the Step 7 invite to
   `testUser.phone` in place of `${ACE_E2E_PHONE}` — everything else about the
   call is identical.

   **The read-back branch INVERTS, and this is the part to get right.**
   Registration requires a pre-existing invite (connect-id `decorators.py`), but
   Connect creates the invite → `OpportunityAccess` link only at invite time and
   only if the ConnectID user ALREADY EXISTS (`opportunity/tasks.py`). A phone
   nobody has registered yet therefore produces **no row, or a row with
   `connect_user_id: null`** — and under a per-run phone that is the EXPECTED
   state, not the ace#824 silent failure. Do NOT `[BLOCKER]` on it.

   Classify with `classifyPerRunPreRegistrationGate(match)` and log its
   `reason` verbatim. The real gate lives downstream in Phase 6, after the
   device registers and the invite is re-sent — see
   `skills/app-screenshot-capture § Step 4`. The verified ordering is
   **invite → register → re-invite** (ace#855, live-verified on
   `hh-poverty-targeting/20260702-1456`); the old self-heal that used to paper
   over the missing link, `resend_connect_invite`, is dead code with zero
   callers.

   **Write two extra fields** into the Step 10 `ace_test_user` block — both are
   REQUIRED at the phase boundary once `per_run` is true
   (`PER_RUN_TEST_USER_REQUIRED_KEYS` in `lib/phase-products-schema.ts`):

   ```
   phone: <testUser.phone>   # the MINTED number, not ${ACE_E2E_PHONE} — Phase 6
                             # has no fallback and cannot proceed without it
   per_run: true             # the contract discriminator; it is what moves the
                             # blocking gate from Phase 4 to post-registration
   ```

   **Do not flip the switch on to "try it".** The precondition is: *the 7 camera
   ids in `connect-register-from-otp.yaml` are calibrated against a live 2.63.2
   `mobile_capture_ui_dump`, and one fresh-signup registration has completed on
   2.63.2*. Until then, per-run phones route every run through an uncalibrated
   photo-capture surface whose `runFlow.when visible:` guard fails SILENTLY.

7.5. **Learn-app CCHQ pre-flight (Phase 6 prerequisite, idempotent).**

   Call `connect_preflight_learn_app_user` against CCHQ before the
   Phase 6 mobile recipe triggers `start_learn_app` from the Android
   client. Defense-in-depth probe for the auth / domain / user-conflict
   failure modes — surfaces them as a structured `{ok, action, reason}`
   outcome before Phase 6 boots the AVD.

   The probe is read-only — it hits `GET /a/<domain>/api/v0.5/user/`
   with the same `ACE_HQ_API_KEY` Phase 6 will eventually use.

   Args:
   ```
   connect_preflight_learn_app_user({
     hq_domain: <opp.connect.program.learn_app.cc_domain>,
     connect_username: <ACE test-user ConnectID username> | omitted,
     api_key: "${ACE_HQ_API_KEY}",
     hq_username: "${ACE_HQ_USERNAME}",
   })
   ```

   Branch:
   - `ok: true, action: 'would_create' | 'would_reuse_existing' | 'skipped'`
     → log `[OK]` to `comms-log/observations.md` and proceed to Step 8.
   - `ok: false` → halt with `[BLOCKER]` and surface `reason` verbatim.
     The remediation text is embedded in `reason` (rotate the HQ API
     key, fix the domain, reconcile the conflicting CCHQ user record,
     etc.). DO NOT continue to Step 8 — Phase 6 would 500 with no
     diagnostic.

   If the run is being executed without the ConnectID username in
   hand (the common case — ACE doesn't always know the FLW's
   ConnectID at opp-create time), omit `connect_username`. The probe
   then validates only API-key auth + domain reachability, which
   already catches the most common failure modes (rotated key,
   archived domain, CCHQ outage) at near-zero cost.

8. **Write config summary** via `drive_create_file` with
   `parentFolderId = phaseFolderId` (the `4-connect` folder; surfaced at
   `ACE/<opp-name>/runs/<run-id>/4-connect/connect-opp-setup.md`):
   - Opportunity ID (UUID) and URL
     (`<CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/`)
   - All configuration details (dates, total_budget, target LLO org)
   - Verification flags (final values, including which were inherited
     from defaults vs. set explicitly)
   - Deliver units (from create response) and Payment units (from step 6)
   - Whether the FLW pre-invite landed or is deferred until activation
   - **ConnectProd int_id** (`connect_int_id`, from the Step 4 create
     response; see step 9)

9. **Capture the ConnectProd integer opportunity ID** (Phase 7 prerequisite).

   Phase 7's `synthetic-data-generate` addresses opportunities by their
   **ConnectProd integer id** (the labs/synthetic surfaces and the
   `/a/<org>/opportunity/<int>/` URLs key off it) — a different
   identifier from the UUID. ConnectProd exposes BOTH on the same
   Opportunity row: it predates UUIDs and still returns the legacy
   integer `id` alongside the `opportunity_id` UUID. It is **not** a
   labs-minted value (labs only mints its own id for a purely-synthetic
   opp with no Connect opp behind it).

   **The integer is already in the Step 4 create response.**
   `connect_create_opportunity` returns `int_id` (ConnectProd's integer
   `id`) next to `id` (the UUID) — it is a required field of
   `ManagedOpportunityResponse`. Capture `int_id` from that response as
   `connect_int_id`. No Labs call, no UUID→int mapping, no
   subagent-reachability concern — the value ACE needs is in the response
   it already received at create time. (`connect_activate_opportunity`
   returns it too, so a re-read is the fallback.)

   If `int_id` is somehow absent from the create response (it should not
   be — the field is required upstream), log `[WARN]` to
   `comms-log/observations.md` and continue with `connect_int_id: null`;
   the Phase 7 operator can pass `--opp-int-id` manually.

   **Historical note (jjackson/ace#686 follow-up):** earlier versions did
   a `mcp__connect-labs__labs_context()` lookup here, on the mistaken
   belief — from a 2026-05-06 observation of the UUID-only
   `connect_list_opportunities` *scrape* path — that "the integer lives
   only in the labs DB." That was wrong: the create/activate REST
   responses carry it. The Labs lookup ALSO failed silently whenever
   Phase 4 ran as a subagent (the connect-labs MCP atoms aren't bound in
   subagent sessions), which is exactly how `connect_int_id` was left
   `null` on malaria-rdt/20260602-1409.

10. **Write the consolidated Connect outputs block** to
    `run_state.yaml.phases.connect-setup.products.connect` as one
    atomic patch. Read the program reference from
    `opp.yaml.connect.program` (or from
    `runs/<run-id>/4-connect/connect-program-setup.md`) and copy it
    into the run's `products.connect.program` so the run state is
    self-contained:

    ```yaml
    phases:
      connect-setup:
        products:
          connect:
            domain: <ACE_HQ_DOMAIN, e.g. connect-ace-prod>   # REQUIRED handoff key — phase-products contract + ace-web summary read it; omitting it fails verify_phase_products at the Phase 4 boundary fence (jjackson/ace#734)
            organization_slug: <Connect org slug, e.g. ai-demo-space>
            program:
              id: <UUID copied from opp.yaml.connect.program.id>
              url: <CONNECT_BASE_URL>/a/<org>/program/<uuid>/
            opportunity:
              id: <UUID>                       # from Step 4 create response
              name: <verbatim display name>    # from Step 4 create response — the exact tile text Connect renders (em-dash, NOT slug-reassembled). Phase 6 reads this as its OPP_NAME envVar; never recompose.
              url: <CONNECT_BASE_URL>/a/<org>/opportunity/<uuid>/
              connect_int_id: <integer | null>    # ConnectProd integer id = create-response int_id (Step 9)
            ace_test_user:                     # field names per lib/phase-products-schema.ts
              phone: ${ACE_E2E_PHONE}          # from Step 7
              invite_row_present: <bool>       # REQUIRED — the Step 7 read-back result
              connect_user_id: <string | null> # populates on CLAIM; null on a pending row is NORMAL, not #824
              status: <accepted | pending | unknown>
              checked_at: <ISO timestamp>      # when the read-back ran
              # ONLY when Step 7b ran (ACE_PER_RUN_TEST_USER on — default OFF, so
              # normally OMIT this line entirely). Setting it flips the boundary
              # contract to PER_RUN_TEST_USER_REQUIRED_KEYS, which additionally
              # requires `phone` (the minted number) — see lib/phase-products-schema.ts.
              per_run: true
    ```

    Apply via `mcp__plugin_ace_ace-gdrive__update_yaml_file` with
    `merge: 'deep'` on the current run's `run_state.yaml`. This is a
    *partial* patch of the `connect-setup` phase child (just
    `products.connect`), so `two-level` would replace the entire
    `connect-setup` block wholesale — dropping `connect-setup`'s own
    `status`, `steps`, etc. when the orchestrator already set them (the
    #572/#587 lost-update footgun). `deep` recursively merges
    `products.connect` while preserving every sibling at every depth.
    This skill is still the sole writer of `products.connect`.

    **Pass `validateAs: { kind: 'phase-products', phase: 'connect-setup' }`
    on this `update_yaml_file` call.** The server validates the
    `products.connect` block against the single-source contract
    (`lib/phase-products-schema.ts` — the same shape ace-web's summary
    page reads) BEFORE the Drive write, and rejects with
    `INVALID_PHASE_PRODUCTS` if the block drifted — e.g. writing the
    opportunity at `products.opportunity` instead of nesting it under
    `products.connect.opportunity` (the malaria-rdt/20260604-1604 blank-
    summary drift, jjackson/ace#705). No Drive write happens on rejection;
    fix the nesting and retry.

    Phase 8's `synthetic-data-generate` reads
    `phases.connect-setup.products.connect.opportunity.connect_int_id` from
    the current run's `run_state.yaml` as the default for its
    `--opp-int-id` flag. When `connect_int_id` is null, the skill
    surfaces a `[WARN]` and asks the operator to pass `--opp-int-id`
    explicitly OR re-run `connect-opp-setup` to re-read `int_id` from the
    Connect create/activate response.

    **Do not write `opp.yaml.connect.opportunity` or
    `opp.yaml.connect.ace_test_user`.** Connect opportunities are
    created fresh per run (not reused across runs) and live only in
    this run's `products.connect`. `opp.yaml.connect.program` is the
    *only* durable Connect reference — written by
    `connect-program-setup`, never mutated here.

## Archetypes

The PDD's `archetype:` field shapes verification + payment unit setup:

### `atomic-visit`
- **Verification:** one `form_field_rules` entry per clause of the PDD's
  payment predicate, keyed to the released CCZ's paths and stored values.
  GPS-fence / duplicate / catchment / photo-attachment enforcement is
  **not available** (ace#1013 — see Step 5); a required photo is normally
  enforced in the form itself (`required="true()"` +
  `appearance="acquire"`), so record it as CCZ-enforced rather than
  missing.
- **Payment:** typically one main payment unit per verified visit,
  optional bonus tier when Layer B passes (e.g. AI photo-quality check).
- **Soft flags** (Layer B/C from PDD): logged in
  `opportunity.md` but no Connect toggle; surfaced via
  `flw-data-review` skill in Phase 6.

### `longitudinal-visits`
- **Verification:** as `atomic-visit` — one `form_field_rules` entry per
  clause of the payment predicate — **plus** the longitudinal clause of
  the PDD's Layer A. Where a longitudinal fact is written onto the form
  by a case preload, it is a normal form-field rule and needs nothing
  special; where the predicate depends on case state that never reaches
  the submitted form, it cannot be a form-field rule. Record that
  explicitly in `opportunity.md § caveats` rather than dropping it
  silently — a dropped longitudinal clause is exactly how this archetype
  degrades back into `atomic-visit` (ace#1462).
- **Payment:** **one** payment unit for the whole arc — not one per
  phase. The sequence is expressed in `entity_id`, not in the number of
  payment units. (Contrast `multi-stage`, which really does take one PU
  per stage.)
- **`entity_id` is the load-bearing field for this archetype.** It must
  carry entity + sequence position, per the PDD's
  `payment-unit-entity-id` decision — e.g.
  `concat(<case_id>, '-', <activity_code>)`. Two failure modes to check
  before writing it: the case id **alone** pays each entity once, ever;
  a `concat(username, today())`-style key silently reverts to
  cross-sectional dedup and makes repeat activities payable.
- **Soft flags** (Layer B/C): progression and sequence-integrity checks
  have no Connect toggle; log them in `opportunity.md` and leave them to
  `flw-data-review` in Phase 6.

### `focus-group`
- **Verification:** same `form_field_rules`-only surface as above (venue
  GPS was never meaningful here, and is unavailable regardless). Enforce
  the attestation form's consent / session-held clauses as field rules;
  the required audio attachment is CCZ-enforced.
- **Payment:** one payment unit per **completed group session** — set
  `max_total` to the PDD's planned session count. Do NOT model per-
  participant payment; the unit is the session.

### `multi-stage`
- Configure verification + payment for **Stage 1 only**. Subsequent
  stages get their own opportunities (or their own payment-unit calls
  on the same opportunity, depending on the PDD's stage-overlap pattern).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file` (always with `parentFolderId = phaseFolderId` — the `4-connect` folder ID, never a path string), `update_yaml_file`
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_create_opportunity` — REST `POST /api/programs/<id>/opportunities/`
  - `connect_get_opportunity` — verify after create (HTML-driven read,
    Step 4 verify-after-create, and again at Step 6.6 for the four
    dashboard fields that are unreadable until activation — ace#1647)
  - `connect_set_verification_flags` — still HTML-driven (no REST yet)
  - `connect_create_payment_units` — REST `POST /api/opportunities/<id>/payment_units/` (atomic list)
  - `connect_list_payment_units` — verify after create (Step 6
    verify-after-create — this is the canary that catches PU
    malformation before it cascades to Phase 8 invites)
  - `connect_send_flw_invite` — REST `POST /api/opportunities/<id>/invite_users/`

## Mode Behavior
- **Auto:** Create + configure end-to-end, proceed
- **Review:** Present configuration spec for approval before calling
  `connect_create_opportunity` (the highest-stakes step — opp creation
  is harder to roll back than verification-flag adjustments)

## Dry-Run Behavior
When `--dry-run` is active:
- Write the full opportunity configuration spec (all fields that would
  be POSTed, plus the per-deliver-unit verification + payment-unit
  matrix) to `comms-log/dry-run-connect-opp-setup.md`
- Do not call any `connect_*` mutation atom
- State tracks as `dry-run-success`

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 4

| ID | Question | Map to surface |
|---|---|---|
| `verification-flags` | Which verification flags (gps, photo, location toggle, duration thresholds) does the opportunity require? | PDD `Verification Mechanism`; downstream Phase 6/8 verification |
| `payment-unit-shape` | Per-visit fixed amount, tiered, milestone-gated, etc.? | Connect payment-unit creation; PDD `Payment Rate` |
| `opportunity-end-date` | When does the opportunity close? | PDD `Timeline` numeric; gates Phase 9 monitoring cadence |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: "4-connect"` and
`skill: "connect-opp-setup"`. Append via the `decisions_append_rows` MCP
atom (ace-decisions server) — do not hand-construct YAML and do not
write decisions.yaml via `update_yaml_file`. The atom validates each row
against `lib/decisions-schema.ts` v5 at the call boundary; misspelled
keys (`decision`, `rationale`, `default`, `options_considered`, `notes`)
are rejected before they touch Drive, and so is any row missing
`evidence_basis` (`stated` | `inferred` | `conflicting` — mandatory on
every new row; `conflict_signals` required when `conflicting`). Contract:
`skills/idea-to-pdd/SKILL.md § The evidence_basis contract`. (ace#1485)

Tool call:

```
decisions_append_rows({
  runFolderId: <run-folder file_id>,
  opportunity: <opp-slug>,
  run_id: <run-id>,
  rows: [
    {
      id: "cs-verification-flags",
      phase: "4-connect",
      skill: "connect-opp-setup",
      question: "which verification flags does this opportunity require",
      "ai-default": "duplicate=true, gps=false, catchment_areas=false",
      options: [
        "duplicate=true, gps=false, catchment_areas=false",
        "duplicate=true, gps=true, catchment_areas=false",
        "duplicate=true, gps=true, catchment_areas=true"
      ],
      source: "PDD §6/§8 verification mechanism",
      status: "ai-default",
      evidence_basis: "stated",
      value_set_by: "ace",
      reasoning: "Smoke opp — no GPS or photo capture in scope; duplicate guard only."
    },
    ...
  ]
})
```

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Add `## Decisions Log` section: 3 anchor rows (verification-flags, payment-unit-shape, opportunity-end-date) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-10 | Move opp activation + ACE test-user invite from Phase 9 into Phase 4 (new Step 6.5 + rewritten Step 7). Closes the chicken-and-egg gap where Phase 6 `app-screenshot-capture` produced placeholder screenshots because the test user wasn't on the new opp yet — the opp couldn't be activated until Phase 9, but the test user couldn't be invited until activation. Phase 9 `llo-launch` now hits its idempotent skip-if-active path on every ACE-driven run; it still sends the real-LLO invite to the awarded LLO. Also: tighten Step 4 `is_test` from "defaults true server-side" to "set explicitly to true" — ACE is in dogfood mode and every opp it creates must be test-flagged so prod analytics, payment exports, and partner dashboards exclude these runs. | ACE team |
| 2026-06-01 | **Step 6.5: always attempt `/activate/`; treat only the "already active" error as the skip signal (jjackson/ace#624).** The managed-opp create endpoint returns a create-side `active: true` flag that is NOT the `/activate/` state transition `invite_users/` requires — so the old "read `active`, skip if true" pre-check skipped the only call that enables invites, and Step 7 failed. Calling `/activate/` on such an opp succeeds; it rejects only an opp that already completed the transition. Removed the pre-check; now call unconditionally and branch on the result, not the read-back flag. | ACE team |
| 2026-06-01 | **Step 6.5: verify activation via Step 7's invite, not the scraped `active` flag (closes jjackson/ace#617, and its #634 duplicate).** Dropped the post-activate `connect_get_opportunity` read-back check — that flag returns `true` on un-transitioned opps and can't distinguish a real `/activate/` from a no-op (the same create-side flag that motivated #624). The authoritative confirmation is `connect_send_flw_invite` in Step 7 succeeding: `invite_users/` hard-rejects a non-active opp, so a successful invite is the only proof the transition landed. | ACE team |
| 2026-08-12 | **Step 5 rewritten around what Connect's verification form actually has (dimagi-internal/ace#1013).** The step prescribed `gps` / `duplicate` / `catchment_areas` / `location` / `check_attachments`, all five of which were removed from the form — the atom accepts them, Django drops them, and it still returns `ok: true`, so a compliant agent produced an artifact claiming enforcement that never existed. Step 5 now leads with `form_field_rules` (the only server-side Layer A surface), requires reading `question_path` / `question_value` from the RELEASED CCZ rather than the PDD's prose (Nova flattens groups — a rule on a non-existent node enforces nothing and reports success), documents the 25-char `name` cap and the `duration_seconds`-is-really-minutes trap, and requires verifying via `form_field_rules_saved`. Archetype verification lines updated to match. Found live on spark-facilitator/20260810-0737. | ACE team |
| 2026-08-14 | **Step 5: `question_path` is a JSONPath into the HQ form-JSON doc, not an XForm XPath (dimagi-internal/ace#1301, `blocks-e2e`).** The step (and the atom's own schema) told agents to write `/data/<group>/<question>`. Connect evaluates the field as `jsonpath_ng.ext.parse(f"$.{question_path}")` against the whole forwarded document, so an XPath raises `JsonPathParserError` inside `clean_form_submission` — uncaught on the deliver path — and HQ's forward of every PAYABLE visit returns **HTTP 500**. The device is unaffected (CommCare shows "1 form sent to server!" because HQ *did* accept the submission), so the run looks green while Connect has no visit and the opportunity cannot pay. Observed live on `spark-facilitator/20260813-2126`: motech log 500 for the deliver form, 200 for every registration form on the same app; rewriting the rows to `form.meeting_basics.*` and requeueing the same payload moved Connect from `delivered: 0` to `delivered: 1 / approved: 1`. Correct spelling is `form.<group>.<question>`; `lib/connect-question-path.ts` now normalises `/data/a/b` → `form.a.b` on both incoming and replayed rows so a poisoned opportunity self-repairs. Also: `form_field_rules_saved` is no longer treated as sufficient evidence — it proves storage, not evaluability. | ACE team |
| 2026-08-14 | **Step 6 verify-after-create re-pointed at the CREATE RESPONSE (dimagi-internal/ace#1026, umbrella #1022).** The step mandated a `[BLOCKER]` when `connect_list_payment_units` returned an empty `required_deliver_units` — but that atom's HTML-scraped read path returns `[]` (and `description: ""`) unconditionally, so the halt condition was a constant of the read path, not a fact about stored state, and a compliant agent would halt every healthy run. Observed on `spark-facilitator/20260813-2126`: create response `required_deliver_units: [6617]`, list call `[]`, opp activated normally. The #843 check's intent is preserved — it now asserts against the create response (Connect's own post-persist serialization), with `connect_list_payment_units` demoted to corroboration on `id` / `payment_unit_uuid` / `name`. | ACE team |
| 2026-08-25 | **Step 4's verify-after-create no longer asserts four fields it cannot read; new Step 6.6 verifies them post-activation (dimagi-internal/ace#1647).** A never-activated opportunity renders only the edit-form half of `connect_get_opportunity`, so `start_date`, `total_budget`, `learn_app.cc_app_id` and `deliver_app.cc_app_id` were all absent at the moment Step 4 ran — four mandated comparisons passing vacuously on every run while the log read as verified. Same shape as ace#1449 (`passing_score` compared against a field the surface does not render). Step 4 now splits readable-here (`name`, `short_description`, `description`, `end_date`, `is_test`) from deferred, and requires an absent field to be recorded `unreadable-at-this-point` rather than counted as a match; Step 6.6 re-reads after `/activate/` and `[BLOCKER]`s on disagreement OR on continued absence. Verified live on `bednet-check-2-visit/20260825-1310` Phase 4 (same opp, same atom, either side of activation). Upstream half stays on #1637. | ACE team |
| 2026-08-25 | **Step 6: `id` dropped from the `connect_list_payment_units` corroboration allowlist (dimagi-internal/ace#1642).** The listing's first column is the row `#`, so the PU that `connect_create_payment_units` returned as `id: 2495` reads back as `id: 1` — a per-opp display index, not the server PK, and passing it where a server id is required reproduces the `du.id` vs `du.server_id` rejection. Corroboration is now `payment_unit_uuid` / `name` only, with `payment_unit_uuid` named as the durable identifier. Atom description in `mcp/connect-server.ts` corrected to match. Observed on `bednet-check-2-visit/20260825-1310` Phase 4. | ACE team |
| 2026-05-10 | State consolidation PR a: retire `connect-state.yaml`; emit a single `run_state.yaml.phases.connect-setup.products.connect` block at end of Step 10. Step 7 holds invite metadata in memory rather than writing immediately. (Initial implementation dual-wrote to `opp.yaml.connect`; corrected on 2026-05-11 — runs are now independent. `opp.yaml.connect.program` is durable cross-run state written by `connect-program-setup`; `opp.yaml.connect.opportunity` / `ace_test_user` are no longer written here.) See `docs/superpowers/specs/2026-05-10-state-consolidation.md`. | ACE team |

<!-- connect_int_id is read directly from the connect_create_opportunity response (ConnectProd integer id); the old post-create labs_context lookup was removed in the jjackson/ace#686 follow-up (the int was always in the create response). -->
