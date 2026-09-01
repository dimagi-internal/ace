---
name: connect-program-setup
description: >
  Create or reuse a Connect Program for the opportunity, archetype-matched
  to the PDD. Captures program_id for downstream skills.
disable-model-invocation: false
---

# Connect Program Setup

Create or select a Connect program for this opportunity.

## Inputs

| Source | Artifact | Used for |
|---|---|---|
| Phase 1 | `1-design/idea-to-pdd.md` | archetype-aware program naming + domain match |
| Connect MCP | `connect_list_programs({organization_slug})` | reuse-vs-create decision |

## Phase folder anchor

The connect-setup agent passes a `phaseFolderId` (the `4-connect` folder ID,
anchored to the run folder per `agents/orchestrator-reference.md § Per-Phase
Folder Lifecycle`). **Every `drive_create_file` write in this skill MUST set
`parentFolderId = phaseFolderId`** — `drive_create_file`'s `parentFolderId` is
required and must be a folder ID, never a path string. Writing by path-string
alone makes the artifact land outside `4-connect` and fail
`verify_phase_artifacts(phase='connect')` (jjackson/ace#635).

## Products

- `4-connect/connect-program-setup.md` (written with `parentFolderId = phaseFolderId`) — program-id, decision rationale (reuse / create), admin program URL
- `opp.yaml.connect.program.{id, url, connect_int_id}` — written on first create (and refreshed on reuse with verified live values). `connect_int_id` is ConnectProd's integer program id (from the create response's `int_id`), used by Phase 8 solicitation surfaces. This is the single durable cross-run reference for the Connect program; every subsequent run of this opp reads it to skip program-create.

## Process

1. **Read the PDD** from `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md`, including the
   `archetype:` field. Program shape is mostly archetype-agnostic, but
   program NAME and DESCRIPTION should signal archetype so future opps
   under the same program can be grouped coherently. See
   `## Archetypes` below.

2. **Check for existing programs** that match this opportunity's domain/scope.
   Call `connect_list_programs({organization_slug})` **with NO `name`
   filter** and consider the full org list (dimagi-internal/ace#1252).
   A name-substring scan is structurally blind to a same-domain,
   same-archetype program under different words — live case: a
   `name: 'Bednet'` query returned 12 programs and could never return
   `Malaria ITN Exploration Multi-Stage Study`, the one same-domain
   multi-stage candidate in the org. Program names are generated
   per-archetype by this very skill, so two runs of the same real
   intervention that describe their domain differently will never find
   each other by name, by construction — and the silent miss creates
   exactly the duplicate program the reuse rule exists to prevent.

   Match candidates on **delivery type + archetype** (both structured,
   both known at this point); use the name only for ranking/display.
   Unfiltered rows carry `null` for delivery_type/budget/currency/
   country/dates — hydrate the shortlisted candidates via
   `connect_get_program` before judging fit on those.

   **Descriptions on unfiltered rows are CAPPED (ace#1799).** In a mature
   org the full prose is most of the payload and overflows the tool-result
   cap outright — measured on `ai-demo-space` 2026-09-01, 42 rows serialize
   to 57,425 chars of which 43,239 (75.3%) are `description`, and the call
   returned no usable data at all. A capped row is flagged
   `description_truncated: true` and a `description_projection` block
   reports the count. The domain signal you shortlist on is in the opening
   sentences; when you need the whole thing, read it from
   `connect_get_program` (which Step 3a does anyway). `write_to_path:
   "/abs/path.json"` writes every full row to disk and returns a handle
   instead — use it if you want to grep the whole org. (The `name` filter
   remains available as a case-insensitive substring match whose rows
   come back fully hydrated, jjackson/ace#1089 — fine for a targeted
   lookup, never for the reuse scan.)
   Prefer archetype-matched programs when reusing — running
   an FGD opp under a program whose other opps are all atomic-visit
   creates a mixed-method reporting headache downstream.

   **Record the candidate set in the artifact:** `connect-program-setup.md`
   § Reuse-vs-create decision must state how many programs were
   considered (the full org count) and on what axis they were matched,
   so "no reusable program existed" is falsifiable by a reader. A count
   that silently reflects a name-filtered subset is the #1252 defect.

3. **Decide: reuse or create**
   - If an existing program fits AND shares the archetype, note the
     program ID; run step 3a, then skip step 4.
   - If an existing program matches the domain but not the archetype,
     flag the mismatch in the gate brief / program notes; default to
     creating a new one unless the admin explicitly opts in.
   - If no match: proceed to step 4.

3a. **Reconcile reused program content against THIS run's PDD
   (jjackson/ace#1078).** Only the program's *identity* is durable
   (UUID, org, delivery type, currency, country, name — see
   `agents/orchestrator-reference.md § Fork Points`). Its *content*
   (description, budget, dates) was authored from the PDD of whichever
   run created it, and a later run's PDD can contradict it — the live,
   LLO-facing program once advertised an enforced 500m GPS payment gate
   the current PDD deliberately made non-enforcing. On every reuse:

   1. `connect_get_program({ organization_slug, program_id })` → live
      refreshable fields.
   2. Compare against this run's PDD-derived values with
      `reconcileProgramWithPdd` (`lib/program-reconcile.ts` — pure
      helper; run it via `npx tsx -e` or replicate its semantics
      exactly: description/dates compare whitespace-normalized; budget
      diverges only when the live ceiling is *below* the PDD budget,
      since Step 4a deliberately raises it above for headroom).
   3. If `inSync`: note "program content verified against this run's
      PDD" in the program notes and continue.
   4. If diverging AND updating is safe (the normal case at Phase 4 —
      this run has not published a solicitation yet): apply the
      helper's `updateArgs` via `connect_update_program({
      organization_slug, program_id, ...updateArgs })` (it accepts
      exactly `name/description/budget/start_date/end_date`; never
      send delivery_type/currency/country — durable). Log each
      refreshed field (old → new) in the program notes.
   5. If updating is unsafe (a live solicitation or external artifact
      already references the current text, or review mode withheld
      approval): emit the helper's `[WARN]` lines verbatim into the
      program notes and the run summary — one per diverging field —
      so the divergence lands somewhere visible instead of nowhere.

4. **Create the program** via `connect_create_program`:
   - `organization_slug`: `ai-demo-space` (or whichever PM-side org the
     opportunity is configured for; must be a program-manager org)
   - `name`: archetype-signaling name (e.g. `"Vaccine Hesitancy Pilot
     (FGD) — Q2 2026"`)
   - `description`: PDD's intervention summary
   - `delivery_type`: slug (preferred — e.g. `"nutrition"`) or int FK
     from `connect_list_delivery_types`. The new automation API accepts
     the slug directly; the old form-driven backend required the int.
   - `budget`: total program budget from the PDD
   - `currency`: 3-letter ISO (e.g. `USD`)
   - `country`: human country name as Connect renders it
     (e.g. `"United States of America"`, not `"USA"`)
   - `start_date` / `end_date`: PDD timeline (YYYY-MM-DD)

4a. **Ensure program budget headroom (runs on both the reuse and create
   paths; the raise is monotonic — it never shrinks a ceiling)
   (jjackson/ace#588).** Connect's program-budget validation on
   `connect_create_opportunity` ("Budget exceeds the program budget") sums
   the `total_budget` of **all** managed opps on the program — including
   the inactive opps left by every prior `/ace:run` — against the fixed
   program ceiling. There is no budget reclamation when a per-run opp goes
   inactive, and per-run opp accumulation is expected by design (see
   CLAUDE.md). So the ceiling monotonically fills until Phase 4 can no
   longer create *any* opp (observed on malaria-rdt 20260531-0739: even a
   2000 opp rejected against a 25000 ceiling with ~14 prior opps).

   Because this is the durable, reused program (the reuse path skips
   create, so its budget never grows on its own), size the headroom here:

   1. `connect_get_program({ organization_slug, program_id })` →
      `program.budget`.
   2. **Compute Σ(`total_budget`) over this program's opps** —
      obtainable again as of ace#1550, having been unobtainable on every
      prior run. Call

      ```
      connect_list_opportunities({
        organization_slug,
        summarize_by_program: program.name,
        duplicate_program_name: <true iff the Step 2 program list shows
                                 two or more programs by this name>,
      })
      ```

      which implies `hydrate`, does the whole classification server-side,
      and returns `{listing, summary}` with **no rows** — `sigma_total_budget`,
      `sigma_known`, `sigma_unknown_reasons[]`, `matched_rows`,
      `matched_opportunity_ids`, `excluded_outside_program`,
      `unreadable_rows`, `rows_missing_total_budget` and
      `dashboard_read_counts`. Read `summary.sigma_known` and branch; the
      four UNKNOWN conditions documented below are evaluated for you, and
      `sigma_unknown_reasons` names the ones that fired, verbatim, for the
      program notes.

      **Do NOT ask for the rows and sum them yourself (ace#1799).** The
      hydrated org-wide array measured 81,175 chars on `ai-demo-space`
      2026-09-01 — over the tool-result cap, so it returns nothing usable
      and the step degrades to the conservative Σ-unknown branch or to an
      improvised out-of-band parse of the overflow file. Both fields exist
      on the HYDRATED row only: `connect_get_opportunity` reads them off
      the opportunity dashboard (the edit form carries neither, and the
      unhydrated list page carries nothing but id/name/short_description).
      If you genuinely need to inspect rows, pass `write_to_path:
      "/abs/path.json"` and grep the file — never pull them into context.

      This Σ is the same set Connect itself sums —
      `Opportunity.objects.filter(program=program).aggregate(Sum(
      "total_budget"))` in `program/api/serializers.py`, the check that
      raises "Budget exceeds the program budget" — so an exact Σ predicts
      the create-time rejection exactly.

      **Never pass `program_id` to the atom.** The list page has no
      program column, so the atom used to silently ignore the filter and
      return the whole org; it is now refused loudly rather than dropped
      (ace#1022). Match on `program_name` instead — no opportunity read
      surface carries the program UUID.

      **Cost, stated plainly:** hydration fetches two pages per row across
      the whole org (concurrently, not serially) — the most expensive read
      in Phase 4. It buys the difference between a check and a guess: with
      Σ the raise is idempotent, without it the program ceiling inflates
      by `EXPECTED_OPP_BUDGET × 10` on *every* run of *every* opp, forever,
      on the live LLO-facing program Step 3a reconciles against the PDD.

      **First, split the rows on `dashboard_read` (ace#1637).** Every
      hydrated row carries it. `total_budget` and `program_name` are read
      off the opportunity DASHBOARD, and each degrades to `undefined`
      when its card is absent — so until this marker existed, "in no
      program / states no budget" and "we could not read the page" were
      the same bytes. On `bednet-check-2-visit/20260825-1310`, **16 of 81
      hydrated `ai-demo-space` rows** came back with the list-page key
      set only (no `program_name`, no `total_budget`, no `start_date`, no
      app ids), two of them prior runs of the very program being sized.

      - `dashboard_read: 'ok'` — the page rendered and its infocards
        parsed. A missing `program_name` on such a row is a FACT: the opp
        is in no program, so **exclude it from Σ and do not let it make Σ
        unknown**. A missing `total_budget` on such a row is likewise a
        stated zero-or-absent budget, not a read failure.
      - anything else (`no_cards`, `not_a_dashboard`, `not_fetched`) —
        the dashboard-sourced fields are UNREAD. Such a row can be
        neither assigned to nor excluded from the program. Count them as
        `unreadable_rows` and carry that count into the branch below;
        **never treat an unread field as an absent one.**

      Report the split verbatim in the program notes — `Σ over <k> rows;
      <n> excluded (no program, dashboard_read ok); <u> unreadable`.
      Upstream residual, unfixed and NOT ours to guess at: Connect
      returns nothing for those `<u>` rows and `active` is correlated but
      demonstrably not causal (5 inactive rows DO carry the fields), so
      the cause is still open — ace#1637 makes the distinction visible,
      it does not explain it.

      **Σ is UNKNOWN — not partial — in four cases. Check each before
      trusting it:**
      - the listing itself was incomplete: the atom returns a `listing`
        block alongside `opportunities`, and **`listing.complete !== true`
        means rows exist that you did not see** — Σ over the rows you got
        is not a smaller-but-valid total, it is a number about a different
        set. Report `listing.truncated_reason` verbatim. (Connect
        paginates this view at 20 rows and said nothing about it until
        dimagi-internal/ace#1590; the walk is exhaustive now, so this
        should only fire above 5,000 opportunities in one org.);
      - a kept row carries no `total_budget` (the dashboard's "Max Budget"
        card did not parse — this is how the field silently disappears if
        Connect restyles the page);
      - a row with `dashboard_read` other than `'ok'` — its
        `program_name` and `total_budget` were not read, so it can be
        neither assigned to nor excluded from this program. **A row with
        `dashboard_read: 'ok'` and no `program_name` does NOT make Σ
        unknown** — it is definitively outside this program and is simply
        excluded (ace#1637);
      - more than one program in the org shares `program.name` (check the
        Step 2 `connect_list_programs` result) — the scoping is by NAME,
        so a duplicate name makes it ambiguous.
   3. **Raise the ceiling.**
      - **Σ known:** raise only when `program.budget − Σ <
        EXPECTED_OPP_BUDGET × 3` (keep room for at least a few more runs),
        via `connect_update_program({ organization_slug, program_id,
        budget: Σ + EXPECTED_OPP_BUDGET × 10 })` — a generous buffer so
        this step rarely re-fires, and a no-op when headroom is already
        ample. `EXPECTED_OPP_BUDGET` = the PDD's per-opp budget (default
        the program's own per-opp figure).
      - **Σ unknown:** raise to a computed TARGET, and only if the
        ceiling is actually below it. **Never `program.budget + …`**
        (ace#1637): a raise expressed relative to the current ceiling is
        not idempotent, so it compounds on every run of every opp on the
        shared program, forever, purely because a read failed. That is
        exactly what happened on `bednet-check-2-visit/20260825-1310`,
        which lifted `Bednet Check Multi-Stage Study — 2026` from 19,400
        to 64,400 against a KNOWN consumption of 4,062.

        Compute the worst case from what you actually know:

        ```
        target = knownΣ                                  # rows summed with dashboard_read: 'ok'
               + unreadable_rows × EXPECTED_OPP_BUDGET   # assume each unread row consumes a full opp
               + EXPECTED_OPP_BUDGET × 3                 # the same headroom the Σ-known branch keeps
        ```

        Raise only when `program.budget < target`, and then to `target`
        exactly. This is monotonic (it never shrinks a ceiling), it is
        idempotent (a second run with the same rows computes the same
        target and no-ops), and it bounds the ceiling by the number of
        opps that could plausibly exist rather than by how many times
        this step has run. If `listing.complete !== true` — the one case
        where you do not know how many rows exist at all — fall back to
        `program.budget + EXPECTED_OPP_BUDGET × 10` and say so, because
        there is genuinely no bound to compute.

      Log the before/after budget in the program notes (Step 5) **and
      which branch fired** — `Σ = <n> over <k> opps` or `Σ unknown
      (<reason>)`. Never write a computed Σ you did not actually compute:
      an unreported fallback is indistinguishable from a working check,
      which is precisely why ace#1550 went unnoticed for as long as it did.

      **Single-opp floor:** `EXPECTED_OPP_BUDGET` must itself be at least
      `min_budget_for_one_user × FUND_USERS` (= `Σ(max_total × (amount +
      org_amount))` over the planned payment units × ~3, the same floor
      `connect-opp-setup` Step 4 enforces). If the PDD's per-opp budget is
      below that floor, use the floor — the program ceiling must be able to
      fund at least one opp that funds ≥1 FLW at its payment-unit max, or
      Phase 4 will halt on the budget-funds-≥1-FLW guard.

   This makes the by-design per-run accumulation safe without a
   reclamation mechanism (none exists yet — a payment-unit-delete /
   opp-budget-zeroing capability is tracked upstream, see
   jjackson/ace#573). When Connect's budget check is changed to count
   only *active* managed opps (the real fix, jjackson/ace#588), this
   headroom step can be relaxed.

5. **Write program details** via `drive_create_file` with
   `parentFolderId = phaseFolderId` (the `4-connect` folder; surfaced at
   `ACE/<opp-name>/runs/<run-id>/4-connect/connect-program-setup.md`):
   - Program ID (UUID)
   - Program name
   - Archetype declared at program creation (if new)
   - Whether reused or newly created; note any archetype mismatch if reused
   - Configuration details (delivery_type name + id, budget, currency,
     country, dates)

6. **Persist program reference to `opp.yaml`** via
   `mcp__plugin_ace_ace-gdrive__update_yaml_file` with the default
   `shallow` merge — `connect:` is a top-level scalar key:

   ```yaml
   connect:
     program:
       id: <UUID from step 3 reuse or step 4 create>
       url: <CONNECT_BASE_URL>/a/<org>/program/<uuid>/
       connect_int_id: <integer | omit>   # ConnectProd integer program id, from the create response's `int_id` when present. NOT a labs-minted id. Lets solicitation-create skip a Labs round-trip. Omit if the create response didn't carry it (older Connect builds) — solicitation-create resolves it as a fallback.
   ```

   Capture `connect_int_id` from the `connect_create_program` response
   (`int_id`) on the create path. On the reuse path, leave any existing
   `connect_int_id` in `opp.yaml` as-is (don't clear it); if it's absent
   and `connect_get_program` returns an `int_id`, write it.

   `opp.yaml` is the **only** cross-run identity surface for the
   Connect program — every subsequent run of this opp reads this
   block to skip program-create (Step 3 reuse path). The Connect
   *opportunity*, OCS chatbot, solicitation, etc. are per-run and
   live in the producing run's `run_state.yaml.phases.*.products.*`;
   only `program` is durable here.

   Skip this write on the reuse path **only** if the existing
   `opp.yaml.connect.program.id` value already matches what we just
   verified live — no-op writes are fine but unnecessary. On any
   value mismatch, overwrite (the live value wins; opp.yaml gets
   corrected).

## MCP Tools Used
- Google Drive: `drive_read_file`, `drive_create_file` (always with `parentFolderId = phaseFolderId` — the `4-connect` folder ID, never a path string), `update_yaml_file` (write `opp.yaml.connect.program` block, `merge: 'shallow'`)
- Connect (`ace-connect` MCP, 0.10.47+):
  - `connect_list_programs` — discovery (`name` = case-insensitive substring; filtered rows hydrated with FULL descriptions). Unfiltered rows carry capped descriptions flagged `description_truncated` (ace#1799); `full_descriptions: true` or `write_to_path` opt out
  - `connect_list_delivery_types` — resolve human name → slug/int FK if needed
  - `connect_create_program` — create (REST `POST /api/programs/`)
  - `connect_get_program` — verify after create; read live fields for reconcile (Step 3a) and `budget` for the headroom check (Step 4a)
  - `connect_list_opportunities` — prefer `summarize_by_program`, which implies hydrate and returns the Σ classification instead of the rows (ace#1799); `write_to_path` writes the rows to disk. With `hydrate: true`, the ONLY source of the headroom Σ's two inputs (`total_budget`, `program_name` — both dashboard-read per row, ace#1550); the unhydrated list page carries neither (Step 4a). Returns a `listing` completeness block; `listing.complete !== true` makes Σ UNKNOWN (ace#1590)
  - `connect_update_program` — refresh stale description/dates on reuse (Step 3a); raise the program budget ceiling, idempotently when Σ is known and on the conservative assumption when it is not (Step 4a)

## Mode Behavior
- **Auto:** Create program (or reuse), proceed
- **Review:** Present program choice for approval before calling
  `connect_create_program`

## Dry-Run Behavior
When `--dry-run` is active:
- Write the program configuration (name, description, settings) to
  `comms-log/dry-run-connect-program-setup.md`
- Do not call `connect_create_program`
- State tracks as `dry-run-success`

## Archetypes

Program-level naming + description should hint the archetype for
downstream coherence:
- `atomic-visit`: prefer names like `"<Domain> Survey — <Year>"` or
  `"<Domain> Field Deployment"`. Description leads with FLW deployment.
- `focus-group`: prefer names like `"<Domain> FGD Pilot"` or
  `"<Domain> Qualitative Research"`. Description leads with discussion-
  group method.
- `multi-stage`: prefer names like `"<Domain> Multi-Stage Study"`.
  Description names each stage's protocol.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-26 | **Step 4a can tell an ABSENT field from an UNREAD one, and the Σ-unknown raise is idempotent (ace#1637 — same class as #1550/#1590, third mechanism).** `connect_get_opportunity` now returns `dashboard_read` (`ok` / `no_cards` / `not_a_dashboard` / `not_fetched`, from `classifyDashboardRead` in `mcp/connect/backends/html-scrape.ts`). `total_budget` / `program_name` / `start_date` come only off the opportunity dashboard and each degrades to `undefined` when its card is absent, so "in no program" and "could not read the page" were the same bytes; 16 of 81 hydrated `ai-demo-space` rows on `bednet-check-2-visit/20260825-1310` were the second kind, two of them prior runs of the program being sized. A row with `dashboard_read: 'ok'` and no `program_name` is now EXCLUDED rather than making Σ unknown; only a genuinely unread row does. And the Σ-unknown branch no longer raises relative to the current ceiling — `program.budget + EXPECTED_OPP_BUDGET × 10` is not idempotent, so it compounded every run and took that program from 19,400 to 64,400 against a known consumption of 4,062. It now computes `knownΣ + unreadable_rows × EXPECTED_OPP_BUDGET + EXPECTED_OPP_BUDGET × 3` and raises only if the ceiling is below it. The relative raise survives only where no bound is computable (`listing.complete !== true`). Upstream residual left open and stated: why those 16 rows render no cards is still unknown — `active` is correlated but not causal. *Enforced:* `test/mcp/connect/unit/dashboard-read-honesty.test.ts`. | ACE team |
| 2026-04-28 | Replace HITL workaround with `connect_*_program` atoms (ace-connect 0.8.1) | ACE team |
| 2026-04-30 | Switch `connect_create_program` to `POST /api/programs/` (commcare-connect PR #1135). `delivery_type` now accepts the slug; `country` is the human country name. (0.10.47) | ACE team |
| 2026-07-30 | Step 3a: reconcile reused program content (description/budget/dates) against the current run's PDD via `lib/program-reconcile.ts` — update or `[WARN]` per diverging field (jjackson/ace#1078). Note substring-match + hydration semantics of `connect_list_programs` (jjackson/ace#1089). | ACE team |
| 2026-08-21 | Step 4a: invert the branches — Σ(`total_budget`) is unobtainable on every Connect read surface, so the conservative raise is now the documented PRIMARY path and the `connect_list_opportunities({hydrate: true})` call is dropped (20 sequential edit-page fetches for zero fields). Computed-Σ kept as the restore-if path (dimagi-internal/ace#1550). | ACE team |
| 2026-08-23 | Step 4a: a fourth UNKNOWN condition — `connect_list_opportunities` walked only Connect's first page (20 rows) with no signal more existed, so Σ could be computed over a fifth of the program and read as complete. The atom now paginates to exhaustion and returns a `listing` completeness block; Σ is UNKNOWN when `listing.complete !== true` (dimagi-internal/ace#1590). | ACE team |
| 2026-08-21 | Step 4a: Σ is executable again — `connect_get_opportunity` now reads `total_budget` + `program_name` off the opportunity dashboard, so a hydrated list can be scoped to this program and summed (supersedes the row above, same day). Names the three UNKNOWN cases and requires the branch taken to be reported in the program notes (dimagi-internal/ace#1550). | ACE team |
| 2026-09-01 | Steps 2 + 4a: both MANDATED org-wide list calls overflowed the tool-result cap in `ai-demo-space` and returned no usable data (measured 2026-09-01: programs 42 rows/57,425 chars, 75.3% description prose; opportunities hydrated 71 rows/81,175 chars). Step 4a now calls `connect_list_opportunities({summarize_by_program})`, which does the whole Σ classification server-side and returns a few hundred characters instead of the rows; Step 2's unfiltered rows come back with capped descriptions. `write_to_path` on both atoms is the escape hatch (dimagi-internal/ace#1799). | ACE team |
