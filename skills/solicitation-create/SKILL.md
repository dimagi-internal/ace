---
name: solicitation-create
description: >
  Translate the PDD into a solicitation payload, derive evaluation
  criteria, and publish via connect-labs MCP. Captures solicitation_id.
disable-model-invocation: true
---

# Solicitation Create

Phase 8 default-run skill. Builds and publishes the solicitation in one
shot — ACE always publishes, never drafts. The solicitation can be edited
post-publish via the labs UI without affecting responses.

See `skills/_solicitation-template.md` for the shared
`phases.solicitation-management.products.solicitation` contract and
connect-labs MCP atom inventory.

## Per-run solicitations are expected, not a bug

**Every `/ace:run` publishes a FRESH solicitation under the same
Connect program — by design.** This skill does NOT detect already-open
solicitations on the program and does NOT close-or-coordinate against
them. Two operational facts make multiple open solicitations correct:

1. **Solicitations are run-scoped audit trails.** Each run's
   solicitation captures *that run's* intent (PDD wording, criteria,
   indicative budget, archetype, deadline). Different runs ship
   different PDD revisions; merging them under one solicitation would
   lose the audit trail.
2. **Launch is operator-coordinated, not skill-coordinated.** The
   typical opp will only have **one** solicitation actually launched
   to candidate LLOs (the chosen release-candidate run's). The other
   open solicitations live in the labs portal until the operator picks
   one to drive Phase 9 from. Stale solicitations are
   operator-cleaned-up via `connect-labs delete_solicitation` or the
   labs UI when picking a release-candidate run.

If you (the agent reading this skill) notice multiple open
solicitations on the same Connect program and feel the urge to
"deduplicate" or "warn-and-prompt," resist. It's not a footgun; it's
how per-run independence is meant to look at the solicitation surface.
The same pattern applies to per-run Connect opportunities and OCS
chatbots — see `agents/ace-orchestrator.md § Modes` for the broader
"each run gets its own live entity; stale ones are operator-managed"
contract.

## Inputs

- `ACE/<opp-name>/runs/<run-id>/1-design/pdd-to-work-order.gdoc` —
  **primary content source.** The Phase 1 work order is the
  comprehensive, opinionated program brief: scope (will / will not),
  per-unit verification criteria, roles + RACI, reporting cadence,
  ethics scope, data-handling, payment schedule, timeline. This skill
  transforms the work order into a public-facing solicitation: same
  comprehensive explanation, less prescriptive (rates become ranges,
  exact weeks become windows), with the LLO-evaluation framing layered
  on top.
- `ACE/<opp-name>/runs/<run-id>/decisions.yaml` — run-level decisions
  log. Phase 1's `pdd-to-work-order` writes initial `wo-*` rows; later
  phases may add or amend decisions (e.g. operator overrides at gate
  reviews, Phase 4 budget reductions, archetype-specific clarifications).
  Read every row before composing — open/closed decisions that affect
  scope, payment band, geographic scope, or ethics must be reflected
  in the published solicitation.
- `ACE/<opp-name>/runs/<run-id>/1-design/idea-to-pdd.md` — the approved
  PDD. Source of truth for `archetype`, the problem-statement / why-this-
  matters narrative (often more vivid than the work-order's contractual
  framing), and the geographic scope. Used to write the solicitation's
  *opening* — the foundation-pitch context an LLO needs before the work-
  order-derived scope makes sense.
- `ACE/<opp-name>/opp.yaml` — `connect.program.id` (Connect UUID),
  opp display name, organization_slug, optional cached
  `connect.program.labs_int_id` (labs integer mirror of the Connect
  program).
- `ACE/<opp-name>/runs/<run-id>/4-connect/connect-program-setup.md` —
  the Connect program **name** (used to resolve the labs integer
  program_id via `labs_context`; see Step 5).
- `ACE/<opp-name>/runs/<run-id>/4-connect/connect-opp-setup.md` (optional but recommended) — the
  current run's Connect opportunity identifiers, payment unit, start/end
  dates as actually configured. When present these override PDD defaults
  (the work order's payment band may have been adjusted at Phase 4 if
  the program budget was capped — that adjusted band is the truth for
  this solicitation).

## Products

- `6-solicitation-management/solicitation-create_summary.md` — solicitation_id, public_url, deadline, audit trail
- `run_state.yaml.phases.solicitation-management.products.solicitation` block populated (id, public_url, deadline, status: open, labs_program_id, connect_program_id, connect_opportunity_id). Per-run only — each run of the opp publishes a fresh solicitation. Operator-cleaned-up when picking a release-candidate run.

## Process

> **Design principle: ACE owns composition; labs validates the schema.**
> The labs MCP's `create_solicitation` / `update_solicitation` tools
> validate the payload against labs's canonical solicitation schema
> (the same schema `solicitations/models.py`'s @property accessors
> read and the public-detail template renders) and reject drift with
> `INVALID_SCHEMA` + per-field error details under `error.details.fields`.
> Labs does NOT compose content — there is no `create_solicitation_from_brief`
> tool, no "standard 6 questions" server-side, no labs-side AI agent
> that this skill defers to. ACE owns the entire compose-the-content
> path: voice, archetype branching, scope-of-work transformation from
> the work order, question framings, evaluation `scoring_guide`s,
> decisions-log integration. The labs contract is structural enforcement,
> not content delegation.
>
> Operational consequence: when labs surfaces an `INVALID_SCHEMA` error
> on publish, read `error.details.fields` to find the offending field,
> fix the composition in this skill (or in the calling agent's prompt
> if the issue is content-shape vs schema), and retry. Do NOT work
> around schema errors by writing top-level fields outside the
> validated set — those fields silently drop at the labs persistence
> layer even when validation lets them through.
>
> Before each publish, re-read labs's canonical inputSchema via
> `tools/list` if the SKILL.md hasn't been refreshed against a recent
> labs deploy. The schema is the source of truth for the field shape;
> this SKILL.md mirrors it.

> **Design principle: per-unit payment is negotiated, not declared.** The
> labs solicitation `data` schema deliberately has no `per_unit_payment`
> structured field — and we should not push for one. Per-unit payment
> shape varies by archetype (per-visit / per-session / per-stage) and
> within each archetype the right rate is opp-and-LLO-specific.
> Solicitations express payment as a **range with rationale in
> `scope_of_work` prose** (e.g. "Per verified session: 80–120 USD-equivalent,
> facilitator + notetaker combined") and the **`questions` block asks
> the responding LLO to propose their actual rate + why** (q6 in the
> default template). The awarded LLO's proposed rate becomes the
> `connect.deliver_unit` payment_unit amount at Phase 4 setup time. Do
> not embed a fixed per-unit number as the load-bearing economic; the
> range + the question + the LLO's response are the load-bearing parts.

1. **Read all source materials.** Open in this order:

   - **Work order** (`1-design/pdd-to-work-order.gdoc`) via `docs_get`
     — this is the primary content source. Pull the full body, including
     all sub-sections: Scope of Work (will / will not), Verification of
     Verified Units, Roles + RACI, Reporting, Ethics, Data Handling,
     Payment Terms (with the payment schedule sub-table), Timeline.
   - **PDD** (`1-design/idea-to-pdd.md`) via `drive_read_file` — for
     `archetype`, the Problem Statement (the vivid "why malaria, why
     now, why this approach" narrative), the Intervention Design
     overview, the Target Population framing, and Geographic Scope.
   - **decisions.yaml** (`<run-folder>/decisions.yaml`) — every row.
     Pay special attention to:
     - `status: open` rows on payment / scope / language / ethics —
       these are explicit operator deferrals that should surface in
       the solicitation (typically by phrasing the relevant scope item
       as a band + asking the LLO to propose within it).
     - Rows tagged `phase: 4-connect` or later that AMEND a Phase 1
       decision (e.g. budget cap was reduced at Phase 4 — the work
       order's NTE is stale; reflect the Phase 4 reality).
   - **opp.yaml** for opp identity + program reference.
   - **Phase 4 outputs** (`4-connect/connect-program-setup.md`,
     `4-connect/connect-opp-setup.md`) for the labs program name +
     the run's Connect opportunity identifiers + actual payment unit
     configuration. The Phase 4 payment band overrides the work order's
     if they differ.

2. **Build the solicitation `data` payload using the labs canonical
   schema.** Labs's `solicitations/models.py` declares the field names
   the public-detail template renders. Drift kills the public page
   (silently — the API echoes back whatever you send). The canonical
   shape is:

   | data-object field | Type | Source / composition |
   |---|---|---|
   | `title` | string | Work order title, stripped of "Work Order —" prefix; e.g. "Connect ITN SBC Exploration — Barrier Diagnosis in Malaria-Endemic Households" |
   | `solicitation_type` | **lowercase** `"eoi"` or `"rfp"` | PDD `## Solicitation` → `Solicitation type` (default `eoi`). **Must be lowercase** — the labs template literal-compares `solicitation_type == 'eoi'`; `'EOI'` renders as a fallback badge. |
   | `description` | string (markdown) | **Comprehensive, 500-800 words.** Opens with the PDD's problem framing (why this matters, what the gap is), transitions into what this opportunity does and why this approach, closes with what the dataset/output enables downstream. Foundation-pitch tone, not procurement-form. **Not** a one-paragraph summary. |
   | `scope_of_work` | string (markdown) | **Comprehensive, 600-1000+ words of structured markdown.** Derived from the work-order body. See § Scope-of-work composition below for the exact section mapping + de-prescription rules. **Must be a single markdown string with `## ` sub-headings and `- ` bullets, NOT a JSON array** (the labs template runs it through a markdown filter; an array string-coerces to Python repr). |
   | `application_deadline` | string `YYYY-MM-DD` | `(now() + (response_window_days || 14)).strftime('%Y-%m-%d')`. **NOT** `response_window_days` (the int) — that's not a labs field. **NOT** `deadline` (legacy ACE name). Just the date string. |
   | `expected_start_date` | string `YYYY-MM-DD` | Phase 4 opp `start_date` if available, else PDD `## Timeline` → start. **NOT** `anticipated_start`. |
   | `expected_end_date` | string `YYYY-MM-DD` | Phase 4 opp `end_date` if available, else PDD `## Timeline` → end. **NOT** `anticipated_end`. |
   | `estimated_scale` | string | Human-readable summary of expected reach, e.g. "30–50 verified HH visits per LLO; 2–3 LLOs total (90–150 HH end-to-end)". Sourced from PDD `## Target Population` → `Expected reach`. **NOT** `sample_target`. |
   | `contact_email` | string | Operator-monitored address. **NOT** `ace@dimagi-ai.com` (that's the service-account bot). Use `${ACE_SOLICITATION_CONTACT_EMAIL}` env var; halt with `[BLOCKER]` if unset rather than defaulting to the bot inbox. |
   | `evaluation_criteria` | array of `{name, description, weight, scoring_guide, linked_questions}` | Composed locally — see Step 3. **NOT** `rubric`. **NOT** `[{dimension, criterion, weight}]`. Each criterion MUST have a populated `scoring_guide` and at least one `linked_questions` id. Weights sum to 100 (integers). |
   | `questions` | array of `{id, text, required, type, framing}` | Composed locally — see Step 4. **NOT** `response_questions`. Field is `text`, not `question`. **Every question MUST have a `framing` field** (1-2 sentence "why we're asking this" preface) — the public template hides empty framings, but the eval rubric and downstream solicitation-review consume the framing. `type` is one of `"textarea"` (default for open-ended), `"multiple_choice"`, `"number"`. |
   | `status` | string | `'active'` (publishes immediately; `'draft'` for dry-run mode). |
   | `is_public` | bool | `true` (so unsolicited orgs can find it on the public marketplace). |
   | `connect_opportunity_id` | int | Phase 4 opp internal id (not the UUID). Stored on the record for downstream solicitation-review linkage. |

   **Fields ACE used to write that are NOT in the labs canonical schema
   and MUST be removed from the payload:**

   - `overview` (use `description`)
   - `response_window_days` (compute `application_deadline` instead)
   - `anticipated_start` / `anticipated_end` (use `expected_*`)
   - `sample_target` (use `estimated_scale`)
   - `rubric` (use `evaluation_criteria`)
   - `response_questions` (use `questions`)
   - `pass_bar`, `eligibility_criteria`, `geographic_scope`,
     `per_hh_payment_band_usd` — these aren't rendered by the public-
     detail template. Roll their content into `description` /
     `scope_of_work` prose instead. **Adding new top-level fields to
     the payload that aren't in `solicitations/models.py`'s @property
     accessors silently does nothing** — they sit in the JSON blob
     unread.

   **`is_public: true` flips the server-side public ACL flag** (the
   field the `/solicitations/` marketplace query actually filters on).
   That means the title, description, scope_of_work, and questions
   become readable by any unauthenticated visitor. Before calling
   `create_solicitation`, scan the composed payload and confirm:

   - `description` contains no names, dates of birth, phone numbers,
     addresses, or health data
   - `scope_of_work` references the LLO target population in
     aggregate terms (e.g. "households in Kerala") rather than naming
     specific people, facilities, or identifiable program participants
   - `questions` ask for capability self-disclosure, not for PII

   If the PDD body itself contains PII that would propagate into the
   solicitation, halt and surface a `[BLOCKER]` naming the offending
   field — do NOT publish a redacted version silently, because the
   PDD is the operator's source of truth and they need to know it
   needs scrubbing.

   **Scope-of-work composition** — derive from the work order, NOT from
   PDD-section concatenation. The work order is the comprehensive,
   opinionated program brief; this skill transforms it into a public-
   facing scope. The transform is:

   1. **Pull the work-order sections directly.** Map work-order
      sub-sections to scope_of_work `## ` sub-headings in the markdown
      output:

      | Work-order section | Scope-of-work `##` heading |
      |---|---|
      | §2 Scope of Work (will) | `## What we're asking the LLO to do` |
      | §2 Scope of Work (will not) | `## What is NOT in scope` |
      | §3 Roles + RACI | `## Roles & responsibilities` |
      | §4.1 Verified Unit | `## What counts as a verified unit` |
      | §4.2 Verification criteria | `## Verification & quality bar` |
      | §4.3 Reporting cadence | `## Reporting cadence` |
      | §5 Payment Terms (+ schedule sub-table) | `## Payment structure` (de-prescribed — see below) |
      | §6 Timeline | `## Indicative timeline` |
      | §7 Ethics scope | `## Ethics & compliance` |
      | §8.1 Permissions / data handling | `## Data handling` |

   2. **De-prescribe contractual specifics** during the transform:
      - Exact dollar amounts → ranges with rationale. The work order
        says "USD $1,800 total NTE, $10/HH"; the solicitation says
        "Per verified HH visit: USD $8–15 band; LLO proposes the exact
        rate in their response with regional cost-of-living
        justification." The PDD's payment-band block (§ FLW Requirements
        → `Per-visit payment rate band`) is the canonical source for the
        range.
      - Exact start/end dates → month windows in the prose body
        (the structured `expected_start_date` / `expected_end_date`
        fields carry the exact dates separately). E.g. "Field weeks
        start in early June 2026; closeout end of July 2026."
      - Specific calendar weeks → relative windows. "Week 4 launch /
        Week 6 checkpoint" → "approximately 3 weeks after award
        (launch); approximately 5 weeks after award (mid-pilot
        checkpoint)."
      - Specific tooling versions or build IDs → omit entirely
        (the LLO doesn't pick those).
      - Operator-internal language (CCC ticket numbers, ACE skill
        names, run-id references) → omit entirely.

   3. **Preserve all explanatory framing.** The work-order's "why this
      verification rule," "why this reporting cadence," "why this
      ethics scope" prose is exactly what an LLO needs to understand
      what they're committing to. Do NOT compress it. If a paragraph
      explains the rationale for a constraint, the paragraph stays in
      the solicitation.

   4. **Surface open decisions.** For each `status: open` row in
      `decisions.yaml` that affects scope (payment, language, ethics
      surface, geographic scope, etc.), add a one-sentence note to the
      relevant `## ` sub-section noting the deferral and pointing to
      the matching question (e.g. "Working language(s) are
      LLO-proposed — see Q5 in the response template").

   **Length target:** 600-1000+ words. A scope-of-work shorter than 500
   words is a signal that the work-order content was over-compressed;
   re-expand before publishing.

   **Format invariant:** single markdown string, `## ` sub-headings
   between sections, `- ` bullets for enumerated items. Never an array
   of strings (the labs template will string-coerce the array to Python
   list repr and render `['item1', 'item2', ...]` literally — verified
   live on solicitation 3130, jjackson/ace bug surfaced 2026-05-21).

   **Description composition** — same comprehensive treatment, separate
   target:

   - Open with the problem framing from the PDD's `## Problem
     Statement`. Lead with the real-world stakes (malaria deaths, the
     access-vs-use gap, what the literature does NOT yet localize).
   - Bridge to what this opportunity does — the exploration framing,
     why exploration before intervention, what's intentionally NOT
     measured here (e.g. intervention effect — that's a later
     opportunity).
   - Close with what the dataset/output enables downstream (the named
     downstream consumer if one exists — e.g. GiveWell EOI barrier-
     diagnosis section — but written in plain terms an LLO can
     evaluate, not as procurement jargon).
   - Foundation-pitch tone, not procurement-form tone. The LLO is a
     potential partner deciding whether the program is one they want
     to be part of; the description has to sell that, not just list
     facts.
   - 500-800 words. A description shorter than 300 words is a signal
     the PDD framing was under-extracted; re-expand.

3. **Compose evaluation criteria locally.** Read the PDD's archetype,
   intervention summary, success criteria, and the work-order's
   verification + RACI sections. Draft a structured rubric inline using
   the same archetype-aware judgment that `solicitation-create-eval`
   would apply.

   **Required shape per criterion:**

   ```yaml
   - name: string                # short title, e.g. "Field operations realism"
     description: string         # 1-2 sentence explanation of what this measures
     weight: int                 # 5-30, integer; all criteria weights sum to 100
     scoring_guide: string       # what makes a 10/10 vs 5/10 vs 0/10 — concrete and falsifiable
     linked_questions: [string]  # one or more question `id`s from the questions block; each criterion links to ≥1 question
   ```

   **Every field is required.** Specifically, `scoring_guide` and
   `linked_questions` are NOT optional — the labs template renders both,
   and an empty `scoring_guide` makes the rubric uninterpretable to
   responding LLOs. **Weights must sum to 100** (integers — the labs
   template formats them as `<weight>%`). 5-8 criteria total; more than
   8 dilutes the signal, fewer than 4 misses dimensions.

   **`scoring_guide` shape — what a strong response looks like:**
   Each `scoring_guide` MUST describe (a) what a strong (8-10) answer
   looks like — concrete, falsifiable signals; (b) what a weak (3-5)
   answer looks like — common shortcuts or vague phrasing; (c) what
   counts as 0 — missing or refused. Example for a "Field operations
   realism" dimension:

   > **Strong (8-10):** week-by-week schedule names supervisor:FLW
   > ratio, mid-pilot checkpoint participation is explicit, photo-heavy
   > visit logistics (storage, upload bandwidth) addressed concretely
   > with named owners. **Mid (5-7):** schedule present but supervision
   > model thin; logistics gestured at. **Weak (1-4):** generic timeline,
   > no supervisor-ratio discussed, logistics unaddressed. **Zero:** no
   > schedule provided.

   - **`atomic-visit`** (4-axis starter): FLW deployment scale,
     geographic-fit, supervision model, data-quality track record.
   - **`focus-group`** (6-axis starter — research-stage opps need
     deeper rubric than CHW-deployment opps):
     1. **Qualitative-research experience** (weight ~0.20) — prior
        FGD or in-depth-interview engagements; ability to produce
        usable session-level qualitative content.
     2. **Facilitator skill & language fit** (weight ~0.20) — named
        facilitators with matching local-language fluency + 2+ years
        community-research experience.
     3. **Homogeneous-group recruitment** (weight ~0.15) — ability to
        recruit separate mother / father / grandmother groups in the
        same community without selection bias toward
        LLO-program-favored families.
     4. **Coordinator capacity for gdoc review** (weight ~0.15) —
        rolling-basis review of facilitator gdocs against the PDD's
        Output Specification.
     5. **Audio handling out-of-band** (weight ~0.10) — minimum-45-min
        audio capture, secure Drive-based storage, consent-decline
        fallback to notetaker-only.
     6. **Timeline + per-session payment economics** (weight ~0.20) —
        ability to field within window, comfortable with
        per-attestation-form-submission payment structure.
   - **`multi-stage`**: emphasize stage-gate discipline, archetype
     fluency across stages, transition-management. For each stage with
     its own archetype, fold in 2-3 axes from that archetype's starter.

   **Note (0.13.3):** the earlier 0.12.0 SKILL.md called
   `mcp__connect-labs__generate_criteria` here. That atom does not exist
   in the labs MCP today (the underlying `/api/generate-criteria/` HTTP
   endpoint exists but isn't surfaced as a tool). When labs does expose
   it, we can swap this local composition step for an MCP call without
   changing the rest of the skill.

   **Question composition** — every question MUST have a `framing` field
   (1-2 sentences explaining why we're asking) AND a `text` field (the
   actual prompt). The framing field is what surfaces the "what makes a
   strong response" intent to the LLO without making them guess.

   Required shape per question:

   ```yaml
   - id: string         # short kebab-case, e.g. "field-ops-realism"
     framing: string    # 1-2 sentences: why this question, what we're looking for
     text: string       # the actual prompt the LLO reads + responds to
     required: bool     # default true
     type: string       # "textarea" (default), "multiple_choice", "number"
   ```

   **Dedupe by intent.** The PDD's `## Solicitation` → `Response
   template` may list opp-specific questions that overlap with the
   default set. Combine them — never publish two questions that ask
   the same thing in different wording (e.g. don't ask about "language
   capacity" AND "language + translation effort" as separate questions
   — fold them into one prompt with framing that calls out both axes).

   **Length budget:** 7-9 questions total. Fewer than 6 leaves
   evaluation criteria un-linkable; more than 10 fatigues the LLO and
   produces shallower answers across the board.

   **Default 6-question response template, archetype-branched** (used
   as the starting set; merge in PDD overrides per the dedup rule
   above):

   For `atomic-visit` / `multi-stage`:
   1. Describe your prior experience deploying CHW programs in this archetype.
   2. How will you recruit and train FLWs for this scope?
   3. What is your timeline for fielding once awarded?
   4. What is your supervision model?
   5. Do you have local-language capacity matching the target geography?
   6. Provide a budget breakdown for the proposed scope.

   For `focus-group` (CHW-deployment vocabulary is wrong; swap to
   qualitative-research vocabulary):
   1. Describe your prior qualitative-research experience (FGDs,
      in-depth interviews) — topic, segment counts, working language,
      and what synthesis output you produced.
   2. How will you recruit homogeneous mother / father / grandmother
      groups without overweighting households with prior LLO program
      history?
   3. What is your timeline from award to first practice-session-pass
      certification, and from award to first live FGD?
   4. Describe your coordinator capacity to review facilitator gdocs
      against an Output Specification rubric on a rolling basis.
   5. What local-language fluency do your named facilitators have, and
      what audio-recording equipment do you have available?
   6. Provide a per-session budget breakdown (facilitator +
      notetaker + participant compensation + venue + coordinator
      review amortized).

4. **Write the draft for traceability.** Save the full payload + the
   AI-derived rubric to:

   ```
   ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md
   ```

   Include all fields from the payload as a structured YAML-frontmatter +
   prose body, so the `solicitation-create-eval` rubric can re-read it.

5. **Resolve the labs program_id (integer).** The labs MCP expects the
   labs **integer** program ID, *not* the Connect program UUID. Despite
   the schema's `program_id: string`, labs `int()`-parses it internally
   and rejects UUIDs with `ValueError: invalid literal for int()`.

   Resolve in this order:

   1. **Fast path:** if `opp.yaml.connect.program.labs_int_id` is set
      (cached at program-create time by `connect-program-setup`, or
      backfilled by a prior `solicitation-create` run), use it
      directly. This is the durable opp-level cache.
   2. **Lookup:** call `mcp__connect-labs__labs_context()`. Find the
      organization by `opp.yaml.organization_slug` (default
      `ai-demo-space`); within it, find the program whose `name` matches
      the Connect program name from
      `runs/<run-id>/4-connect/connect-program-setup.md` (the markdown
      summary written by `connect-program-setup`). Capture the
      program's integer `id`.
   3. **Cache:** write the result to
      `opp.yaml.connect.program.labs_int_id` via `update_yaml_file`
      (`merge: 'two-level'` — `connect:` is the top-level key with
      `program` as a sub-object). This is opp-level state (the
      program is reused across runs, so its labs int mirror is also
      opp-level). Also carry the value into this run's
      `phases.solicitation-management.products.solicitation.labs_program_id`
      via Step 9's consolidated write so the run state is
      self-contained.
   4. **Halt** with a `[BLOCKER]` if no name match — likely the Connect
      program exists but was never mirrored to labs (labs creates
      shadow programs on first opportunity sync). Surface the Connect
      program name and the list of labs programs the caller can see.

6. **Publish.** Call:

   ```
   mcp__connect-labs__create_solicitation(
     program_id: <resolved labs_program_id as string>,
     data: {
       title: ...,
       solicitation_type: 'eoi',                  # lowercase!
       description: ...,                          # markdown string, 500-800 words
       scope_of_work: ...,                        # markdown string, 600-1000+ words, NOT an array
       application_deadline: 'YYYY-MM-DD',        # date string, NOT response_window_days
       expected_start_date: 'YYYY-MM-DD',
       expected_end_date: 'YYYY-MM-DD',
       estimated_scale: 'human-readable string',
       contact_email: ...,                        # operator-monitored, not the bot
       evaluation_criteria: [
         {name, description, weight, scoring_guide, linked_questions: [qid, ...]},
         ...
       ],                                          # weights sum to 100
       questions: [
         {id, framing, text, required, type},
         ...
       ],                                          # 7-9 items, each with framing
       status: 'active',
       is_public: true,
       connect_opportunity_id: <int>,
     }
   )
   ```

   **Do NOT include** `overview`, `response_window_days`,
   `anticipated_start`, `anticipated_end`, `sample_target`, `rubric`,
   `response_questions`, `pass_bar`, `eligibility_criteria`,
   `geographic_scope`, `per_hh_payment_band_usd`, or `budget` — none
   of these are read by the labs public-detail template. After labs's
   2026-05-22 deploy, the MCP itself rejects unknown top-level fields
   with `INVALID_SCHEMA` + per-field error details under
   `error.details.fields` (JSON-path keyed, e.g.
   `evaluation_criteria[0].linked_questions`). Read the error and fix
   the composition; do NOT retry with the same payload, and do NOT
   work around schema rejections by stuffing extras into a free-form
   field. Step 7a's public-page verifier remains the structural
   double-check.

   The atom requires `data` (object) and at least one of `program_id` /
   `organization_id` (both strings). Application-level fields go inside
   `data` — flat top-level fields (e.g. just sending `title` next to
   `program_id`) get dropped by the labs adapter and the create returns
   without the values being persisted.

   Capture the returned `id` (the labs record id) into `solicitation_id`.
   The response also includes `experiment` (echo of the program_id) and
   the data object as written. Public URL pattern:
   `${LABS_BASE_URL}/solicitations/<id>/`. Manage URL pattern:
   `${LABS_BASE_URL}/solicitations/<id>/edit/`. **NO `/labs/` prefix** —
   `connect-labs/config/urls.py` mounts the solicitations app at
   `/solicitations/`, not `/labs/solicitations/`. The `/labs/` prefix is
   reserved for the authenticated Labs UI (overview, login, explorer).

   **Verify reachability before recording the URL.** After publish,
   issue a HEAD against the constructed public URL and confirm 200. A
   404 here means either the URL pattern doesn't match the current labs
   URLconf (regression on labs side) or the record's envelope `public`
   flag didn't flip (regression on MCP side — see PRs
   commcare-connect#162/164/165 for the canonical contract). Either way,
   surface as `[BLOCKER]` rather than writing a broken URL into
   `run_state.yaml`. This catches the class of bug where the MCP
   reports `is_public: true` but the public listing page renders empty
   (verified jjackson/ace e2e malaria-itn-app run 20260517-1829).

7a. **Verify the rendered public page.** After publish, fetch the
   public URL with `curl -s` and grep for structural signals that
   confirm each load-bearing section actually rendered:

   ```bash
   curl -s "${LABS_BASE_URL}/solicitations/<id>/" | tee /tmp/sol.html
   ```

   Required matches (all must be present):

   - `<h2[^>]*>.*Description` AND a non-empty markdown body following it
   - `Application Deadline` AND a parseable date in `Month D, YYYY` form (NOT "No deadline")
   - `Timeline` AND a non-empty `Mon YYYY — Mon YYYY` value (NOT "TBD — TBD")
   - `<h2[^>]*>.*Scope of Work` AND markdown bullets / sub-headings (NOT a `['...', '...']` Python repr)
   - `<h2[^>]*>.*Application Questions` AND `N questions` count text (where N matches len(questions))
   - `<h2[^>]*>.*Evaluation Criteria` AND `N criteria` count text (where N matches len(evaluation_criteria))

   **Any miss → `[BLOCKER]`** naming the missing section + the
   probable field-name drift (e.g. "Application Deadline reads `No
   deadline` — likely the payload sent `response_window_days` instead
   of `application_deadline`"). Do NOT proceed to write
   `published.md` against a half-rendered solicitation. The class
   this catches is the silent-echo failure mode where the labs API
   accepts the create cleanly but the public page is empty.

   This is the structural backstop for the field-name canonical-schema
   contract. Verified live on solicitation 3130 (jjackson/ace
   `malaria-itn-app/20260521-1400`) where all 6 sections were broken
   simultaneously because the entire payload schema had drifted.

7b. **Verify the round-trip.** Immediately after publish, call:

   ```
   mcp__connect-labs__get_solicitation(
     solicitation_id: <returned id>,
     program_id: <same labs_program_id used on create>,
   )
   ```

   This catches the silent-misconfig class where the create succeeds but
   the record is unreachable on subsequent reads. Without `program_id`,
   the labs `LabsRecord` API filters to `is_public=true` only — so a
   newly-created `is_public: false` solicitation (or any future change in
   default visibility) would round-trip as "not found." Always pass
   `program_id` on read so the prod-side membership check authorizes the
   private record. If the verification call returns no record or a
   different `id`, halt and surface the mismatch — do not proceed to
   write `published.md` or mutate `opp.yaml`.

8. **Write `published.md`.** Save:

   ```
   ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md
   ```

   Body: full payload as written, returned IDs/URLs, deadline in absolute
   ISO-8601 form, the AI-derived `evaluation_criteria` (so
   `solicitation-review` and `solicitation-monitor` have the rubric
   without re-fetching from labs).

9. **Write the consolidated solicitation outputs block** to the
   current run's `run_state.yaml.phases.solicitation-management.products.solicitation`
   via `update_yaml_file` + `merge: 'two-level'`:

   ```yaml
   phases:
     solicitation-management:
       products:
         solicitation:
           solicitation_id: <returned>
           labs_program_id: <integer resolved in step 5>
           public_url: <returned>
           manage_url: <returned>
           type: <EOI|RFP>
           published_at: <now ISO-8601>
           deadline: <computed ISO-8601>
           status: open
           awarded:
             response_id: null
             awarded_at: null
             awarded_org_slug: null
             awarded_org_name: null
             awarded_contact_email: null
             award_amount: null
   ```

   The two-level merge replaces `products:` wholesale under
   `solicitation-management`. This skill is the sole writer of
   `products.solicitation` within the run; `solicitation-review`
   updates the same block in place at award time (within the same
   run).

   `selected_llo` is stubbed by `solicitation-review` on award, not
   here. `selected_llo` lives at
   `phases.solicitation-management.products.selected_llo`.

   **No write to `opp.yaml.solicitation`.** Solicitations are per-run
   — every `/ace:run` publishes a fresh solicitation; stale ones from
   prior runs are operator-cleaned-up when picking a release-candidate
   run.

## Error handling

- **Labs MCP unreachable** (proxy returns transport error): halt with a
  doctor-style message pointing at `/ace:doctor`'s `[Connect Labs]`
  section.
- **`create_solicitation` returns 4xx**: preserve `draft.md`, halt,
  surface the error verbatim. Do not retry — most 4xx is a payload
  schema mismatch or the program_id is wrong.
- **`generate_criteria` returns degenerate output** (empty list, single
  criterion): write what was returned, mark `evaluation_criteria` as
  `needs-review` in `published.md`, still publish. Criteria are editable
  post-publish via labs UI without losing responses.
- **`opp.yaml.program_id` missing**: halt with "run Phase 4
  (`connect-setup`) first to register a Connect program." The Connect
  UUID is the upstream evidence that a labs-side program will exist;
  without it there is nothing to look up in `labs_context`.
- **`labs_context` returns no name match for the Connect program**:
  halt. Surface the Connect program name we tried to match plus the list
  of labs programs visible under the org. The remediation is usually
  one of: (a) labs's program shadow was created with a different
  display name (rename via the labs UI); (b) the Connect program was
  created in an org the caller can't see in labs_context (PAT scope
  mismatch); (c) the program was created so recently that labs hasn't
  synced yet — wait a minute and re-run. Do **not** publish a
  solicitation under a guessed labs_program_id.

## Output

- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_draft.md` (audit)
- `ACE/<opp-name>/runs/<run-id>/6-solicitation-management/solicitation-create_published.md` (live state)
- `run_state.yaml.phases.solicitation-management.products.solicitation.{solicitation_id, public_url, deadline, status: open, labs_program_id, ...}` populated (per-run only).
- `opp.yaml.connect.program.labs_int_id` cached on first resolution (durable opp-level — the labs program int matches the Connect program UUID; reused across runs).
- `selected_llo` is left untouched here (populated by `solicitation-review` on award at `products.selected_llo`).

## MCP Tools Used

- `connect-labs`: `labs_context` (resolve Connect program name → labs
  integer program_id, when not cached), `create_solicitation`,
  `get_solicitation` (round-trip verification — pass `program_id`)
- `ace-gdrive`: `drive_create_file`, `drive_read_file`,
  `drive_update_file`, `update_yaml_file` (write
  `phases.solicitation-management.products.solicitation` to
  `run_state.yaml`; cache `opp.yaml.connect.program.labs_int_id` on
  first resolution)

## Mode Behavior

- **Auto:** Publish in one pass.
- **Review:** Pause after Step 6, present `published.md` for human
  approval before mutating `run_state.yaml`. (The publish itself
  already happened — review-mode is about the local state mutation,
  not the external call. If review rejects, the human can call labs's
  `update_solicitation` to draft or close the solicitation.)
- **Dry-run:** Steps 1-4, skip steps 5-7. Verdict with `dry_run: true`.

## Decisions Log

This skill writes load-bearing defaults to the per-run
`ACE/<opp-name>/runs/<run-id>/decisions.yaml`. The bar criterion and
schema live in `skills/idea-to-pdd/SKILL.md § Decisions Log Convention`
(canonical authority). The list below catalogs decisions that commonly
qualify under the bar for this phase — a working template, not a
required set. The skill applies the bar criterion and emits whatever
rows meet it; the catalog is a teaching device that improves over time.

### Common load-bearing decisions for Phase 8

| ID | Question | Map to surface |
|---|---|---|
| `solicitation-type` | EOI vs RFP vs custom? | `solicitation-create-eval`; affects who applies and at what fidelity |
| `response-deadline` | Days from publish to deadline (default 14)? | `solicitation-create` schema; gates Phase 8→9 timing |
| `response-template-choice` | Stock template vs opp-custom response form? | `solicitation-create` content; downstream `solicitation-review` rubric input |

The orchestrator's Phase Write-Back Verifier (`agents/ace-orchestrator.md`
§ Phase Write-Back Contract § Decisions log clause) enforces the
contract; the renderer (`skills/decisions-render`) regenerates the gdoc
at end of every phase.

Each row this skill writes uses `phase: 8-solicitation-management` and
`skill: solicitation-create`.

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-08 | Add `## Decisions Log` section: 3 anchor rows (solicitation-type, response-deadline, response-template-choice) + bar-criterion reference. Pairs with decisions-log PR #4 (Phase 3-10 writes). | ACE team (decisions-log PR #4) |
| 2026-05-15 | Three archetype-branches added for `focus-group`: (1) scope_of_work concatenation in Step 2 — FGD PDD has no `## Learn App Specification` (uses `## Facilitation Protocol` instead); the scope opens with a "PER VERIFIED SESSION, THREE ARTIFACTS" block listing audio + gdoc + 5-field attestation form with explicit "NOT in the form" callout. (2) evaluation_criteria in Step 3 — focus-group goes from a 4-axis sketch to a 6-axis starter rubric (qualitative-research experience, facilitator skill + language, homogeneous-group recruitment, coordinator gdoc-review capacity, audio handling out-of-band, timeline + per-session payment economics). (3) default questions in Step 3 — swap CHW-deployment vocabulary for qualitative-research vocabulary on q1 + q5 + q6. Prompted by `malaria-itn-fgd/20260514-2352` Phase 8 observations. | ACE team |
| 2026-05-15 | Codify the **"per-unit payment is negotiated, not declared"** design principle at the top of `## Process`. Solicitations express payment as a range with rationale in `scope_of_work` prose; the `questions` block asks the responding LLO to propose their actual rate + why. Closes the loop on the "labs `per_unit_payment` schema gap" surfaced in Phase 8 — it's not a gap, it's an intentional design choice (per-unit shape varies by archetype; the rate is opp-and-LLO-specific and negotiated through the response). | ACE team |
| 2026-05-21 | **Work-order-as-primary-input + canonical-schema field names + comprehensive-content shape.** Three bundled rewrites prompted by solicitation 3130 on `malaria-itn-app/20260521-1400` where the public page rendered blank Description, "TBD" timeline, "No deadline," Python-list-repr Scope, and zero questions / zero rubric simultaneously. (1) Inputs now read Phase 1's work order (`1-design/pdd-to-work-order.gdoc`) as the primary content source + `decisions.yaml` for later run decisions, alongside the PDD (now used for problem-framing only, not for scope). (2) Field names migrated to the labs canonical schema (`description` not `overview`, `application_deadline` not `response_window_days`, `expected_start_date/_end_date` not `anticipated_*`, `estimated_scale` not `sample_target`, `questions[].text` not `response_questions[].question`, `evaluation_criteria[].name/.scoring_guide/.linked_questions` not `rubric[].dimension/.criterion`; `solicitation_type: 'eoi'` lowercase). Top-level fields not in `solicitations/models.py` (`pass_bar`, `eligibility_criteria`, `geographic_scope`, `per_hh_payment_band_usd`, `budget`) folded into `description`/`scope_of_work` prose. (3) Content shape demands comprehensive prose: `description` 500-800 words foundation-pitch tone; `scope_of_work` 600-1000+ words derived section-by-section from the work order with explicit de-prescription rules (exact dollars → ranges, exact weeks → windows); every question has a required `framing` field; every evaluation criterion has a required `scoring_guide` + `linked_questions`. (4) Added Step 7a — a curl-the-public-URL structural verifier that catches field-name drift at write time instead of at human-eye time. | ACE team |
| 2026-05-22 | **Architecture decision: ACE owns composition; labs validates.** PR #396 had floated a future labs-side `create_solicitation_from_brief` MCP tool that would compose content server-side via labs's `solicitation_agent`. Walked back — operator chose to keep composition in ACE so this skill retains full control over voice, archetype-branched scope, framing/scoring_guide quality, and decisions-log integration (all of which are ACE-context that labs would have to learn). Labs's tightened MCP (forthcoming deploy: `create_solicitation` + `update_solicitation` now validate the canonical schema and fail loudly with `INVALID_SCHEMA` + `error.details.fields` on drift) is the right server-side contribution: schema enforcement, not content generation. This skill is the long-term home for solicitation composition; Step 6's payload shape is bound to labs's `tools/list` inputSchema rather than to a future composer call. Removal of the prior "Removal criteria" line. | ACE team |
