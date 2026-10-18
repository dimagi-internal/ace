---
name: solicitation-seed-responses
description: >
  Seed a private labs solicitation with synthetic responses and the ACE winner. Optional step; needs a solicitation id.
---

# Seed synthetic solicitation responses

Fills a **private** labs solicitation with `count` responses so the review-and-award flow has
something real to rank: `count - 1` fictional respondents with deliberately different profiles,
plus one response from the ACE-owned winner org (`llo_org`). It is the optional `seed_responses`
step of `/ace:run` (spec `docs/superpowers/specs/2026-10-18-optional-labs-e2e-steps.md` § D) and
is **off unless the run asked for it**. It never contacts anyone: every response is entered on the
firm's behalf by the call's owner, and every submitter address is ACE's own mailbox.

`solicitation-create` publishes the call and `solicitation-review` scores and awards it. This
skill only adds responses. Platform facts:
[`connect-labs.md` § Solicitations, responses, reviews, awards](../../playbook/integrations/connect-labs.md).

## Inputs

| Parameter | Used for | Resolver |
|---|---|---|
| `solicitation_id` | the call to seed (integer) | explicit arg; default: run_state `phases.solicitation-management.products.solicitation.solicitation_id` |
| `labs_program_id` | context for the org registration in step 3 | explicit arg; default: run_state `phases.solicitation-management.products.solicitation.labs_program_id` |
| `count` | responses to create, winner included | explicit arg; default: run_state `optional_steps.seed_responses.count` (5) |
| `llo_org` | the winner's Connect org slug | explicit arg; default: the preflight `connect_orgs.llo_org` (`lib/connect-orgs.ts`, key `ACE_CONNECT_LLO_ORG`) |
| `deny_list` | parties that must never appear in LLO-facing text | explicit arg; default: the opp's `inputs/confidentiality.yaml` `llo_facing_deny_list:` plus any "do not reference/mention <party>" instruction in the opp's operator brief or the PDD (step 2) |
| `grounding` | what the personas may claim | explicit arg; default: the run's PDD (`1-design/idea-to-pdd.md`) and the solicitation itself |

`questions[]` and `evaluation_criteria[]` are always read live with `get_solicitation`, never
taken from a file. The skill runs with no `run_state.yaml` when the ids are passed explicitly.

## Products

- `8-solicitation-management/solicitation-seed-responses_roster.md`: one row per respondent
  with its key, org name, the profile it was built to exercise, its flags, its labs
  `response_id`, and which one is the winner. It also lists the deny list in force and where each
  term came from.
- Inside a run, `phases.solicitation-management.products.solicitation.seeded_responses[]`:
  `{response_id, org_name, synthetic: true, intended_profile}` per respondent (spec § H),
  written with `update_yaml_file` `merge: 'deep'` from a local file of the WHOLE list. Arrays
  are replaced wholesale, so never patch one element.

## Process

1. **Confirm the call is private and readable.** Call `get_solicitation(solicitation_id)`. It must
   read `is_public: false`. If it is listed, **halt**: fabricated responses must never sit on a
   listed call (spec § A2), and this skill does not unlist calls (`solicitation-edit` does, with
   approval). Keep `questions[]` (ids and `required`) and `evaluation_criteria[]` from the
   result.
2. **Resolve the deny list.** Read `inputs/confidentiality.yaml` if it exists and parse
   `llo_facing_deny_list` with `normalizeDenyList` (`lib/synthetic-responses.ts`). Then read the
   opp's operator brief and the PDD for instructions not to name a party in LLO-facing text
   ("do not reference X", "never mention X to LLOs"). Add each party found, including its usual
   spellings (joined, spaced, acronym), and record the source line. The union is the deny list.
   Nothing opp-specific is written into this skill: the list is the opp's data.
3. **Bind the winner.** Find `llo_org` in `labs_context(search: <llo_org>)` to get its Connect
   integer id and display name. Register it as a labs org bound by that id:
   `supply_chain_org_upsert({program_id: <labs_program_id>, data: {slug: <llo_org>, name: <display name>, connect_organization_id: <id>, connect_organization_slug: <llo_org>}})`.
   This is the same idempotent call `solicitation-create` Step 5a makes for the PM org. If
   `llo_org` is unset, halt with the preflight's `llo_org_status: warn` remediation.
4. **Gather real names to avoid.** Collect the org names a fictional respondent must not match:
   - every org in `labs_context()` and `supply_chain_org_list(program_id)`;
   - the LLO Directory's Organizations tab: resolve the sheet id and tab with
     `scripts/llo-directory.ts contract`, then read its name column with `sheets_read`;
   - every real organisation the PDD and the opp's `inputs/` name (partners, implementers,
     government agencies).
5. **Compose the personas.** Build `count - 1` fictional respondents plus the winner. Give each
   a different profile on the call's criteria (geography fit, scale, prior delivery, budget
   realism) so the review has something to rank. With `count >= 5`, include at least one
   strong, one weak, one with a deliberately missing required answer (flag `missing_answer`)
   and one over budget (flag `over_budget`). Each answers every question in its own voice,
   grounded only in what the PDD and the call ask for. Invent no populations, pilots or
   partnerships the sources don't contain (CLAUDE.md § No inferred backstory). Fictional org
   names end with ` [Synthetic]`. The winner is `llo_org` itself, with
   `winner: {llo_entity_id: <llo_org>, connect_org_id: <Connect id>}`, and it answers every
   required question. Its answers should earn it first place on the merits; if the review later
   ranks it elsewhere, the roster's profiles are wrong, and that is a finding. Spread
   `submission_date` across the call's open window.
6. **Validate and build.** Run `buildCreateResponsePayloads` (`lib/synthetic-responses.ts`) with
   the personas, `questions`, `count`, ACE's mailbox (`config/agent.json` `email`), the real
   names and the deny list. It refuses the whole plan on any missing suffix, real-name
   collision, deny-list hit, unanswered required question, unbound winner or count mismatch.
   Fix the personas and re-run; never write a partial plan. It also builds each
   `submitted_by_email` as `<mailbox>+synthetic-<n>`, and gives the winner `llo_entity_id` plus
   `org_id` = its Connect id as a string. That is the identifier `award_response.org_id` takes
   (spec § K1, pinned live). A response created without it reads back `org_id: ""`.
7. **Skip what already exists.** Call `list_responses(solicitation_id)` and split the payloads
   with `partitionAgainstExisting`. Labs lets the call's owner file two responses for one org,
   so a re-run would duplicate without this check. It is a cost-skip: the `-qa` re-reads what
   is on labs.
8. **Write.** Call `create_response` once per remaining payload, exactly as built (always send
   `org_name`, or labs fills it from the submitter's name). Branch on each call's result; record
   every returned `id`.
9. **Record.** Write the roster (§ Products) and, inside a run, the `seeded_responses` list.
10. **Run `solicitation-seed-responses-qa`** and report its verdict with the roster link.

## MCP Tools Used

- connect-labs: `get_solicitation`, `list_responses`, `create_response`, `labs_context`,
  `supply_chain_org_upsert`, `supply_chain_org_list`
- ace-gdrive: `drive_read_file`, `drive_create_file`, `sheets_read`, `update_yaml_file`
- Bash: `scripts/llo-directory.ts contract` (sheet id and tab only); `lib/synthetic-responses.ts`
  via `npx tsx`

## Existing objects

- **Responses cannot be deleted through the MCP.** A bad seed stays on the call. Close the call
  (`solicitation-edit`) or have `sweep-labs` report it. That is why step 6 validates everything
  before step 8 writes anything.
- **Labs does not enforce one response per org for the call's owner**, nor required answers on
  an owner-entered response (both observed live, 2026-10-18). Step 6 enforces answers and step 7
  prevents duplicates.
- **The org registration is labs-wide.** Organisations are the same body wherever they appear,
  so re-running step 3 updates the one row rather than creating another.

## Mode Behavior

- **Auto:** runs steps 1–10.
- **Review:** shows the persona roster after step 6 and waits before step 8.

## Dry-Run Behavior

When `--dry-run` is active, run steps 1–7 and write the roster with `response_id: (dry-run)`. Do
not call `create_response` or `supply_chain_org_upsert`.

## Terminology

The seeded answers are LLO-facing text on a call, so the platform is "Connect" in every answer.
Rule and carve-outs: [`skills/_terminology.md`](../_terminology.md). Shared Phase 8 conventions:
[`skills/_solicitation-template.md`](../_solicitation-template.md).

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-10-18 | Initial skill (optional labs E2E PR4). § K1 pinned live on throwaway private call 1000003: `award_response.org_id` is the winner's Connect integer id as a string, and `create_response` persists it when sent. | ACE team |
